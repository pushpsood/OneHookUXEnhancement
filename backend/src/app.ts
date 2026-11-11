import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import type { AzureOpenAI } from 'openai';
import type { ContextualFeatureConfig } from './contextConfig';
import { createContextualRouter, type ContextualServices } from './contextRoutes';
import { parseContextualModelResponse } from './contextPrompt';

/**
 * The Express app that serves `MrOneHookService` (OneHookBackend mr-onehook.smithy): middleware, every
 * route, the 404 and error handlers. index.ts wires the real Azure/AWS dependencies and listens; the
 * contract tests build the same app with fakes.
 */
export interface AppOptions {
  corsAllowedOrigins: string[];
  contextualConfig: ContextualFeatureConfig;
  /** Absent: the member routes answer 404 (feature off) or 503 (on but not configured). */
  contextualServices?: ContextualServices;
  /** The anonymous mascot chat. */
  publicChat: {
    client: AzureOpenAI;
    deployment: string;
    productContextProvider: (query: string) => Promise<string>;
  };
}

interface RateLimitData {
  count: number;
  expiry: number;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatRequestBody {
  messages?: ChatMessage[];
  userDemographics?: {
    gender?: string;
    sexualPreference?: string;
  };
  honeypot?: string;
}

export function createApp(options: AppOptions): Express {
  const { corsAllowedOrigins, contextualConfig, contextualServices, publicChat } = options;
  const app = express();
  app.use(cors(corsAllowedOrigins.length > 0 ? { origin: corsAllowedOrigins } : undefined));
  app.use(express.json({ limit: '32kb' }));

  app.use(createContextualRouter(contextualConfig, contextualServices));

  // In-memory rate limiting for the public chat
  const rateLimitMap = new Map<string, RateLimitData>();

  // Cleanup old rate limit entries every minute to prevent memory leaks
  setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of rateLimitMap.entries()) {
      if (now > data.expiry) {
        rateLimitMap.delete(ip);
      }
    }
  }, 60000).unref();

  // Rate Limiter middleware (In-Memory)
  const rateLimiter = (req: Request, res: Response, next: NextFunction) => {
    const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown';
    const limit = 10; // max 10 requests
    const windowMs = 60 * 1000; // 60 seconds
    const now = Date.now();

    if (!rateLimitMap.has(ip)) {
      rateLimitMap.set(ip, { count: 1, expiry: now + windowMs });
    } else {
      const data = rateLimitMap.get(ip)!;
      if (now > data.expiry) {
        // Reset if window has passed
        rateLimitMap.set(ip, { count: 1, expiry: now + windowMs });
      } else {
        data.count += 1;
        if (data.count > limit) {
          res.status(429).json({ error: 'Too many requests, slow down.' });
          return;
        }
      }
    }
    next();
  };

  // Fake request detection (Basic honeypot/heuristic check)
  const botDetector = (req: Request, res: Response, next: NextFunction) => {
    if (req.body.honeypot && req.body.honeypot.length > 0) {
      res.status(403).json({ error: 'Bot detected.' });
      return;
    }
    next();
  };

  // Health check endpoint for Azure App Service probes
  app.get('/health', (req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.post('/api/public/product-chat', rateLimiter, botDetector, async (req: Request<{}, {}, ChatRequestBody>, res: Response) => {
    try {
      const { messages, userDemographics } = req.body;

      if (!messages || !Array.isArray(messages)) {
        res.status(400).json({ error: 'Invalid messages array.' });
        return;
      }

      const lastMessage = messages[messages.length - 1];
      const githubContext = await publicChat.productContextProvider(lastMessage ? lastMessage.content : "");

      const systemPrompt = `You are the OneHook Alien Mascot, a friendly, helpful, and slightly quirky assistant for OneHook.
You answer questions ONLY related to business understanding, onboarding, and the platform's value proposition.
If the user asks about low-level system details, coding implementations, or infrastructure, politely decline and steer them back to business topics.
You have access to this context from our GitHub repositories:
${githubContext}

User Demographics for Personalization:
${userDemographics ? `Gender: ${userDemographics.gender}, Preference: ${userDemographics.sexualPreference || 'Not provided'}` : 'None provided'}
Tailor your tone to be respectful, personalized, and engaging based on these demographics if applicable.

You must output a JSON object containing:
1. "reply": Your text response to the user.
2. "mood": The mood of the conversation to control your facial expression. Choose from: ["Happy", "Neutral", "Thinking", "Sad", "Excited"].

Ensure the output is strictly valid JSON.`;

      const apiMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...messages
      ];

      const result = await publicChat.client.chat.completions.create({
        messages: apiMessages,
        model: publicChat.deployment,
        response_format: { type: "json_object" }
      });

      const responseText = result.choices[0]?.message?.content;
      if (responseText) {
          const { reply, mood } = parseContextualModelResponse(responseText);
          res.json({ reply, mood });
      } else {
          throw new Error("No response content");
      }

    } catch (error: any) {
      console.error('Chatbot error', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
        status: typeof error?.status === 'number' ? error.status : undefined,
      });

      if (error.status) {
        if (error.status === 429) {
          res.status(429).json({ error: 'The AI is currently handling too many requests. Please try again in a moment.' });
          return;
        }
        if (error.status === 400) {
          res.status(400).json({ error: 'The request was rejected by the AI model. Please modify your message and try again.' });
          return;
        }
        // Any other model error (auth, not found, 5xx): the AI is unavailable to us right now. 503 is
        // the only status PublicProductChat declares for it (mr-onehook.smithy).
        res.status(503).json({ error: 'The AI service is temporarily unavailable.' });
        return;
      }

      res.status(500).json({ error: 'An internal error occurred while connecting to the AI.' });
    }
  });

  // 404 Handler for unknown API routes
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'Endpoint not found.' });
  });

  // Global Error Handler for uncaught exceptions and JSON parse errors
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    console.error('Unhandled request error', {
      errorType: err instanceof Error ? err.name : 'UnknownError',
    });

    // express.json() rejects a body over its 32 KB limit with type `entity.too.large`.
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request body is too large.' });
      return;
    }

    // Handle express.json() SyntaxError (malformed JSON body)
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'Invalid JSON payload format.' });
      return;
    }

    res.status(500).json({ error: 'An unexpected internal server error occurred.' });
  });

  return app;
}
