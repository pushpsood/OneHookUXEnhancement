import dotenv from 'dotenv';
import { AzureOpenAI } from 'openai';
import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import { loadContextualFeatureConfig } from './contextConfig';
import type { ContextualServices } from './contextRoutes';
import { createApp } from './app';
import { PlaintextChatSessionStore } from './plaintextChatSessionStore';
import { OneHookDataClient, type RequestSigner } from './oneHookDataClient';
import { MatchingSuggestionClient } from './matchingSuggestionClient';
import { MatchingStatusClient } from './matchingStatusClient';
import { TableClient } from '@azure/data-tables';
import { TableChatQuota } from './chatQuota';
import { SigV4RequestSigner } from './sigv4Signer';
import { createAzureWebIdentityCredentialProvider } from './azureAwsCredentials';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { AwsCredentialIdentityProvider } from '@smithy/types';
import {
  SqsErasureQueue,
  UxErasureWorker,
  createUserDataEraser,
  loadUxErasureConfig,
} from './uxErasureWorker';
import { AzureProTable, ProStore } from './proStore';
import { ProSubscriptionService } from './proSubscriptionService';
import { FakeProPaymentProvider } from './proPayments';
import { unavailableMembershipDirectory } from './membershipDirectory';
import { StateMembershipClient } from './stateMembershipClient';
import { ProHandoverWorker, ProRenewalScheduler } from './proHandoverWorker';
import { AttachmentStore } from './attachmentStore';
import { AttachmentProcessingQueue, AttachmentProcessor, FfmpegFrameExtractor } from './attachmentProcessor';
import { AttachmentUsageLedger } from './attachmentUsage';
import { AzureDocumentReader, AzureTranscriber, AzureVisionReader } from './attachmentAi';

const credential = new DefaultAzureCredential();

dotenv.config();

const corsAllowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// In-memory cache for the product context
let cachedGithubContext: string | null = null;
let cachedGithubContextTimestamp = 0;

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

// AWS credentials for every OneHook AWS call (SigV4 routes and the erasure queue).
// Cross-cloud: exchange the Azure managed-identity token for OneHook-MrOneHook-<stage>-Role credentials via
// STS AssumeRoleWithWebIdentity. No long-lived AWS keys live on the App Service. Without a role ARN and
// audience, the ambient AWS provider chain (env/web-identity file/instance role) is used.
const awsCredentials: AwsCredentialIdentityProvider = contextualConfig.oneHookDataApiAwsRoleArn
  && contextualConfig.oneHookDataApiAwsWebIdentityAudience
  ? createAzureWebIdentityCredentialProvider({
      credential,
      audience: contextualConfig.oneHookDataApiAwsWebIdentityAudience,
      roleArn: contextualConfig.oneHookDataApiAwsRoleArn,
      region: contextualConfig.oneHookDataApiAwsRegion,
    })
  : fromNodeProviderChain();

// Free-tier daily message counters (the quota ledger), shared by the chat route and account erasure.
const chatQuota = contextualConfig.chatQuotaTableName && storageAccountName
  ? new TableChatQuota(new TableClient(
      `https://${storageAccountName}.table.core.windows.net`, contextualConfig.chatQuotaTableName, credential))
  : undefined;

// Mr OneHook Pro: subscriptions, ledger, notices and the attachment allowance (one Azure Table). Built
// whenever the table is configured, so existing subscriptions are honoured even while purchases are off.
const proStore = contextualConfig.pro.tableName && storageAccountName
  ? new ProStore(new AzureProTable(new TableClient(
      `https://${storageAccountName}.table.core.windows.net`, contextualConfig.pro.tableName, credential)))
  : undefined;
if (contextualConfig.pro.missing.length > 0) console.warn('[WARN] Mr OneHook Pro:', contextualConfig.pro.missing.join(', '));
// The fake provider moves no money (config refuses it in prod). No real provider is wired yet.
const paymentProvider = contextualConfig.pro.paymentProvider === 'fake' ? new FakeProPaymentProvider() : undefined;
// What Mr OneHook Pro reads from State (IAM-only, SigV4 with the federated role). Without a State URL every
// renewal, refund, kept-Pro and handover waits (fails closed) instead of guessing.
const membershipDirectory = contextualConfig.oneHookDataApiUrl
  ? new StateMembershipClient(
      contextualConfig.oneHookDataApiUrl,
      new SigV4RequestSigner(contextualConfig.oneHookDataApiAwsRegion, contextualConfig.oneHookDataApiAwsService, awsCredentials),
      contextualConfig.dataApiTimeoutMs,
    )
  : unavailableMembershipDirectory;
const proService = proStore
  ? new ProSubscriptionService({
      store: proStore,
      ...(paymentProvider ? { provider: paymentProvider } : {}),
      directory: membershipDirectory,
      includedTiers: contextualConfig.pro.includedTiers,
      prices: contextualConfig.pro.prices,
      currency: contextualConfig.pro.currency,
    })
  : undefined;

let contextualServices: ContextualServices | undefined;
if (contextualConfig.ready && blobServiceClient) {
  const sessionContainer = blobServiceClient.getContainerClient(contextualConfig.sessionContainerName);
  const attachmentStore = new AttachmentStore(sessionContainer);
  // A deleted or expired session takes the files sent in it along.
  const sessionStore = new PlaintextChatSessionStore(sessionContainer, {
    onSessionDeleted: async (subject, ids) => {
      for (const id of ids) await attachmentStore.delete(subject, id);
    },
  });
  if (contextualConfig.sessionStorageEnabled && !contextualConfig.sessionStorageReady) {
    console.warn('[WARN] Chat session storage is enabled but unavailable:', contextualConfig.sessionMissing.join(', '));
  }
  // The OneHook AWS routes are AWS_IAM only, so every call is SigV4-signed.
  const dataApiSigner: RequestSigner = new SigV4RequestSigner(
    contextualConfig.oneHookDataApiAwsRegion,
    contextualConfig.oneHookDataApiAwsService,
    awsCredentials,
  );
  const dataClient = OneHookDataClient.withSigner(
    contextualConfig.oneHookDataApiUrl,
    dataApiSigner,
    contextualConfig.dataApiTimeoutMs,
  );
  // Suggestions go to Matching's IAM-only route, so they need the SigV4 signer (federated AWS role).
  // Each one is recorded only after State confirms the member's matching is ON (same State API and signer
  // as the AI-context route).
  const suggestionsEnabled = Boolean(contextualConfig.oneHookMatchingApiUrl);
  if (!suggestionsEnabled) {
    console.warn('[WARN] OneHook suggestions are off (needs ONEHOOK_MATCHING_API_URL)');
  }
  // Free-tier daily message counters (Azure Table Storage, managed identity). Missing config means free
  // members get 503 (never unlimited); paid members are unaffected.
  if (!chatQuota) console.warn('[WARN] AZURE_CHAT_QUOTA_TABLE is not set; free members cannot chat');
  // Attachments: vision (the chat deployment, image input), transcription and Document Intelligence.
  let attachments: ContextualServices['attachments'];
  const attachmentConfig = contextualConfig.attachments;
  if (attachmentConfig.missing.length > 0) console.warn('[WARN] Chat attachments are off:', attachmentConfig.missing.join(', '));
  if (attachmentConfig.ready && proStore) {
    const visionClient = new AzureOpenAI({
      endpoint, azureADTokenProvider, deployment: attachmentConfig.visionDeployment,
      apiVersion: process.env.AZURE_OPENAI_VISION_API_VERSION?.trim() || '2024-10-21',
    });
    const transcriber = attachmentConfig.transcriptionDeployment && attachmentConfig.transcriptionEndpoint
      ? new AzureTranscriber(new AzureOpenAI({
          endpoint: attachmentConfig.transcriptionEndpoint, azureADTokenProvider, deployment: attachmentConfig.transcriptionDeployment,
          apiVersion: process.env.AZURE_OPENAI_TRANSCRIPTION_API_VERSION?.trim() || '2025-04-01-preview',
        }), attachmentConfig.transcriptionDeployment)
      : undefined;
    if (!transcriber) console.warn('[WARN] Audio and video attachments are off (needs AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT)');
    const documents = attachmentConfig.documentIntelligenceEndpoint
      ? new AzureDocumentReader(attachmentConfig.documentIntelligenceEndpoint, credential)
      : undefined;
    if (!documents) console.warn('[WARN] PDF and Office attachments are off (needs AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT)');
    const processor = new AttachmentProcessor({
      vision: new AzureVisionReader(visionClient, attachmentConfig.visionDeployment),
      ...(transcriber ? { transcriber } : {}),
      ...(documents ? { documents } : {}),
      ...(attachmentConfig.ffmpegPath ? { frames: new FfmpegFrameExtractor(attachmentConfig.ffmpegPath) } : {}),
    }, attachmentConfig.rates, attachmentConfig.maxDocumentPages);
    const usage = new AttachmentUsageLedger(proStore, attachmentConfig);
    attachments = { store: attachmentStore, processor, usage, queue: new AttachmentProcessingQueue(attachmentStore, processor, usage) };
  }
  contextualServices = {
    client,
    deployment,
    dataClient,
    ...(proService ? { pro: proService } : {}),
    ...(attachments ? { attachments } : {}),
    ...(chatQuota ? { chatQuota } : {}),
    ...(suggestionsEnabled
      ? {
          suggestionRecorder: new MatchingSuggestionClient(
            contextualConfig.oneHookMatchingApiUrl,
            dataApiSigner,
            contextualConfig.dataApiTimeoutMs,
            new MatchingStatusClient(contextualConfig.oneHookDataApiUrl, dataApiSigner, contextualConfig.dataApiTimeoutMs),
          ),
        }
      : {}),
    sessionStore,
    productContextProvider: fetchGitHubContext,
  };
} else if (contextualConfig.enabled) {
  console.warn('[WARN] Contextual AI is enabled but unavailable because required settings are missing:', contextualConfig.missing.join(', '));
}

// Every route (MrOneHookService), middleware and error handler; see app.ts.
const app = createApp({
  corsAllowedOrigins,
  contextualConfig,
  ...(contextualServices ? { contextualServices } : {}),
  publicChat: { client, deployment, productContextProvider: fetchGitHubContext },
});

// Mr OneHook account deletion: consume UserDeleted from OneHook-Matching-<stage>-UxErasure and delete the member's
// AI sessions and quota ledger (design §8.6). Independent of CONTEXTUAL_AI_ENABLED: data written while the
// feature was on must still be erased. Off when UX_ERASURE_QUEUE_URL is empty. Without the session
// container it stays off rather than acknowledge deletions it cannot carry out.
const erasureConfig = loadUxErasureConfig();
let erasureWorker: UxErasureWorker | undefined;
if (erasureConfig.problems.length > 0) {
  console.warn('[WARN] Account erasure worker is off:', erasureConfig.problems.join(', '));
} else if (erasureConfig.configured) {
  if (!blobServiceClient || !contextualConfig.sessionContainerName) {
    console.warn('[WARN] Account erasure worker is off: needs AZURE_STORAGE_ACCOUNT and AZURE_SESSION_CONTAINER');
  } else {
    if (!chatQuota) console.warn('[WARN] AZURE_CHAT_QUOTA_TABLE is not set; account erasure skips the quota ledger');
    erasureWorker = new UxErasureWorker({
      queue: new SqsErasureQueue(
        new SQSClient({ region: erasureConfig.region, credentials: awsCredentials }),
        erasureConfig.queueUrl,
      ),
      eraser: createUserDataEraser(
        new PlaintextChatSessionStore(blobServiceClient.getContainerClient(contextualConfig.sessionContainerName)),
        chatQuota,
        {
          attachments: new AttachmentStore(blobServiceClient.getContainerClient(contextualConfig.sessionContainerName)),
          ...(proService ? { pro: proService } : {}),
        },
      ),
      concurrency: erasureConfig.concurrency,
    });
    erasureWorker.start();
  }
}

// Mr OneHook Pro background work: the renewal/refund job (every instance; due rows are leased) and the
// membership's Pro handover events. Both need State (fail closed until its operations exist).
let renewalScheduler: ProRenewalScheduler | undefined;
let handoverWorker: ProHandoverWorker | undefined;
if (proService && contextualConfig.ready) {
  renewalScheduler = new ProRenewalScheduler(proService, contextualConfig.pro.renewalIntervalMs);
  renewalScheduler.start();
  const handoverQueue = loadUxErasureConfig({ UX_ERASURE_QUEUE_URL: contextualConfig.pro.entitlementQueueUrl });
  if (handoverQueue.problems.length > 0) {
    console.warn('[WARN] Mr OneHook Pro handover worker is off: MR_ONEHOOK_ENTITLEMENT_QUEUE_URL is not an SQS queue URL');
  } else if (handoverQueue.configured) {
    handoverWorker = new ProHandoverWorker(
      new SqsErasureQueue(new SQSClient({ region: handoverQueue.region, credentials: awsCredentials }), handoverQueue.queueUrl),
      proService,
    );
    handoverWorker.start();
  }
}

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

const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log(`Chatbot Backend running on port ${PORT}`);
});

// App Service sends SIGTERM on stop, restart and deploy: stop taking queue messages, let in-flight
// erasures finish (unfinished ones are redelivered), then stop the HTTP server.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`Received ${signal}; shutting down`);
  setTimeout(() => process.exit(0), 40_000).unref();
  await Promise.all([erasureWorker?.stop(30_000), handoverWorker?.stop(30_000), renewalScheduler?.stop()]);
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
