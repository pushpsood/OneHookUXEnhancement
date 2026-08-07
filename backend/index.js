const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { Redis } = require('ioredis');
const { AzureOpenAI } = require('openai');
const { DefaultAzureCredential, getBearerTokenProvider } = require('@azure/identity');
const { BlobServiceClient } = require('@azure/storage-blob');

const credential = new DefaultAzureCredential();

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Redis setup for rate limiting and cache
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: 6380,
  password: process.env.REDIS_PASSWORD,
  tls: {}
});

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
let blobServiceClient;
if (storageAccountName) {
  blobServiceClient = new BlobServiceClient(
    `https://${storageAccountName}.blob.core.windows.net`,
    credential
  );
}

// Rate Limiter middleware
const rateLimiter = async (req, res, next) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const key = `ratelimit:${ip}`;
  const limit = 10; // max 10 requests
  const window = 60; // per 60 seconds

  const current = await redis.incr(key);
  if (current === 1) {
    await redis.expire(key, window);
  }
  if (current > limit) {
    return res.status(429).json({ error: 'Too many requests, slow down.' });
  }
  next();
};

// Fake request detection (Basic honeypot/heuristic check)
const botDetector = (req, res, next) => {
  if (req.body.honeypot && req.body.honeypot.length > 0) {
    return res.status(403).json({ error: 'Bot detected.' });
  }
  next();
};

// Helper function for streams
async function streamToString(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
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
const fetchGitHubContext = async (query) => {
  const cacheKey = `github-context`;
  let context = await redis.get(cacheKey);
  
  if (!context) {
    try {
      if (!blobServiceClient) throw new Error("Blob Service not configured");
      
      const containerClient = blobServiceClient.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient('onehookclient-context.txt');
      
      const downloadResponse = await blobClient.download(0);
      context = await streamToString(downloadResponse.readableStreamBody);
      
      // Cache for 10 minutes (600 seconds)
      await redis.setex(cacheKey, 600, context);
    } catch (err) {
      console.error('Error fetching context from Blob Storage:', err.message);
      // Fallback
      context = `OneHook Platform Context: We provide seamless onboarding and lifecycle management for B2B applications.`;
    }
  }
  return context;
};

// Health check endpoint for Azure App Service probes
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/chat', rateLimiter, botDetector, async (req, res) => {
  try {
    const { messages, userDemographics } = req.body;
    // userDemographics: { gender: 'man', sexualPreference: 'optional' }

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages array.' });
    }

    const githubContext = await fetchGitHubContext(messages[messages.length - 1].content);

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

    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages
    ];

    const result = await client.chat.completions.create({
      messages: apiMessages,
      model: deployment,
      response_format: { type: "json_object" }
    });

    const responseText = result.choices[0].message.content;
    const jsonResponse = JSON.parse(responseText);

    res.json(jsonResponse);

  } catch (error) {
    console.error('Chatbot error:', error);
    res.status(500).json({ error: 'An error occurred while processing your request.' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Chatbot Backend running on port ${PORT}`);
});
