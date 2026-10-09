import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { AzureOpenAI } from 'openai';
import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import { loadContextualFeatureConfig } from './contextConfig';
import { createContextualRouter } from './contextRoutes';
import { PlaintextChatSessionStore } from './plaintextChatSessionStore';
import { OneHookDataClient } from './oneHookDataClient';
import { parseContextualModelResponse } from './contextPrompt';

const credential = new DefaultAzureCredential();

dotenv.config();

const app = express();
const corsAllowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(cors(corsAllowedOrigins.length > 0 ? { origin: corsAllowedOrigins } : undefined));
app.use(express.json({ limit: '32kb' }));

// In-memory data stores for Rate Limiting and Caching
interface RateLimitData {
  count: number;
  expiry: number;
}
const rateLimitMap = new Map<string, RateLimitData>();

let cachedGithubContext: string | null = null;
let cachedGithubContextTimestamp = 0;

// Cleanup old rate limit entries every minute to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimitMap.entries()) {
    if (now > data.expiry) {
      rateLimitMap.delete(ip);
    }
  }
}, 60000);

// OpenAI Setup
const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
const apiVersion = "2024-02-15-preview"; // adjust as needed
const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o";
if (!process.env.AZURE_OPENAI_DEPLOYMENT) {
  console.warn('[WARN] AZURE_OPENAI_DEPLOYMENT not set, defaulting to "gpt-4o"');
}

const scope = "https://cognitiveservices.azure.com/.default";
const azureADTokenProvider = getBearerTokenProvider(credential, scope);

const client = new AzureOpenAI({ 
  endpoint, 
  azureADTokenProvider, 
  apiVersion, 
  deployment 
});

// Blob Storage Setup
const storageAccountName = process.env.AZURE_STORAGE_ACCOUNT;
const containerName = process.env.AZURE_STORAGE_CONTAINER || 'codecontext';
let blobServiceClient: BlobServiceClient | undefined;
if (storageAccountName) {
  blobServiceClient = new BlobServiceClient(
    `https://${storageAccountName}.blob.core.windows.net`,
    credential
  );
}

// Authenticated product/connection context is isolated from anonymous chat and disabled by default.
const contextualConfig = loadContextualFeatureConfig();
if (contextualConfig.ready && blobServiceClient) {
  const sessionContainer = blobServiceClient.getContainerClient(contextualConfig.sessionContainerName);
  const sessionStore = new PlaintextChatSessionStore(sessionContainer);
  if (contextualConfig.sessionStorageEnabled && !contextualConfig.sessionStorageReady) {
    console.warn('[WARN] Chat session storage is enabled but unavailable:', contextualConfig.sessionMissing.join(', '));
  }
  const dataClient = new OneHookDataClient(
    contextualConfig.oneHookDataApiUrl,
    contextualConfig.oneHookDataApiScope,
    credential,
    contextualConfig.dataApiTimeoutMs,
  );
  app.use(createContextualRouter(contextualConfig, {
    client,
    deployment,
    dataClient,
    sessionStore,
    productContextProvider: fetchGitHubContext,
  }));
} else {
  if (contextualConfig.enabled) {
    console.warn('[WARN] Contextual AI is enabled but unavailable because required settings are missing:', contextualConfig.missing.join(', '));
  }
  app.use(createContextualRouter(contextualConfig));
}

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

// Helper function for streams
async function streamToString(readableStream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    readableStream.on("data", (data) => {
      chunks.push(data.toString());
    });
    readableStream.on("end", () => {
      resolve(chunks.join(""));
    });
    readableStream.on("error", reject);
  });
}

// Fetch context from Azure Blob Storage
async function fetchGitHubContext(query: string): Promise<string> {
  const cacheTtlMs = 10 * 60 * 1000; // 10 minutes
  const now = Date.now();

  if (cachedGithubContext && (now - cachedGithubContextTimestamp < cacheTtlMs)) {
    return cachedGithubContext;
  }
  
  try {
    if (!blobServiceClient) throw new Error("Blob Service not configured");
    
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient('CRUX.md');
    
    const downloadResponse = await blobClient.download(0);
    if (downloadResponse.readableStreamBody) {
        cachedGithubContext = await streamToString(downloadResponse.readableStreamBody);
        cachedGithubContextTimestamp = Date.now();
    } else {
        throw new Error("No readable stream body");
    }
  } catch (err: any) {
    console.error('Error fetching context from Blob Storage:', err.message);
    // Fallback if no context loaded yet
    if (!cachedGithubContext) {
      cachedGithubContext = `OneHook Platform Context: We provide seamless onboarding and lifecycle management for B2B applications.`;
    }
  }
  
  return cachedGithubContext!;
}

// Health check endpoint for Azure App Service probes
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

interface ChatMessage {
    role: "system" | "user" | "assistant";
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

app.post('/api/public/product-chat', rateLimiter, botDetector, async (req: Request<{}, {}, ChatRequestBody>, res: Response) => {
  try {
    const { messages, userDemographics } = req.body;

    if (!messages || !Array.isArray(messages)) {
      res.status(400).json({ error: 'Invalid messages array.' });
      return;
    }

    const lastMessage = messages[messages.length - 1];
    const githubContext = await fetchGitHubContext(lastMessage ? lastMessage.content : "");

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

    const result = await client.chat.completions.create({
      messages: apiMessages,
      model: deployment,
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
      res.status(error.status).json({ error: 'The AI service is temporarily unavailable.' });
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
  
  // Handle express.json() SyntaxError (malformed JSON body)
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'Invalid JSON payload format.' });
    return;
  }
  
  res.status(500).json({ error: 'An unexpected internal server error occurred.' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Chatbot Backend running on port ${PORT}`);
});
