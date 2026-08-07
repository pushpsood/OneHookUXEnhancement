"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const openai_1 = require("openai");
const identity_1 = require("@azure/identity");
const storage_blob_1 = require("@azure/storage-blob");
const credential = new identity_1.DefaultAzureCredential();
dotenv_1.default.config();
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
const rateLimitMap = new Map();
let cachedGithubContext = null;
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
const azureADTokenProvider = (0, identity_1.getBearerTokenProvider)(credential, scope);
const client = new openai_1.AzureOpenAI({
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
    blobServiceClient = new storage_blob_1.BlobServiceClient(`https://${storageAccountName}.blob.core.windows.net`, credential);
}
// Rate Limiter middleware (In-Memory)
const rateLimiter = (req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const limit = 10; // max 10 requests
    const windowMs = 60 * 1000; // 60 seconds
    const now = Date.now();
    if (!rateLimitMap.has(ip)) {
        rateLimitMap.set(ip, { count: 1, expiry: now + windowMs });
    }
    else {
        const data = rateLimitMap.get(ip);
        if (now > data.expiry) {
            // Reset if window has passed
            rateLimitMap.set(ip, { count: 1, expiry: now + windowMs });
        }
        else {
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
const botDetector = (req, res, next) => {
    if (req.body.honeypot && req.body.honeypot.length > 0) {
        res.status(403).json({ error: 'Bot detected.' });
        return;
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
    const cacheTtlMs = 10 * 60 * 1000; // 10 minutes
    const now = Date.now();
    if (cachedGithubContext && (now - cachedGithubContextTimestamp < cacheTtlMs)) {
        return cachedGithubContext;
    }
    try {
        if (!blobServiceClient)
            throw new Error("Blob Service not configured");
        const containerClient = blobServiceClient.getContainerClient(containerName);
        const blobClient = containerClient.getBlobClient('onehookclient-context.txt');
        const downloadResponse = await blobClient.download(0);
        if (downloadResponse.readableStreamBody) {
            cachedGithubContext = await streamToString(downloadResponse.readableStreamBody);
            cachedGithubContextTimestamp = Date.now();
        }
        else {
            throw new Error("No readable stream body");
        }
    }
    catch (err) {
        console.error('Error fetching context from Blob Storage:', err.message);
        // Fallback if no context loaded yet
        if (!cachedGithubContext) {
            cachedGithubContext = `OneHook Platform Context: We provide seamless onboarding and lifecycle management for B2B applications.`;
        }
    }
    return cachedGithubContext;
};
// Health check endpoint for Azure App Service probes
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.post('/api/chat', rateLimiter, botDetector, async (req, res) => {
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
        const apiMessages = [
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
            const jsonResponse = JSON.parse(responseText);
            res.json(jsonResponse);
        }
        else {
            throw new Error("No response content");
        }
    }
    catch (error) {
        console.error('Chatbot error:', error);
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
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found.' });
});
// Global Error Handler for uncaught exceptions and JSON parse errors
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
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
//# sourceMappingURL=index.js.map