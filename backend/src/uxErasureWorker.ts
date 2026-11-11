import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

/**
 * Mr OneHook account deletion (design §8.6).
 *
 * Profile publishes `UserDeleted` (source `club.onehook.profile`) on the OneHook AWS event bus; an
 * EventBridge rule delivers it to the SQS queue `OneHook-UxErasure-<stage>` (DLQ after 5 receives,
 * visibility timeout 5 minutes, DLQ alarm). This worker long-polls that queue with the federated role
 * `OneHook-MrOneHook-<stage>-Role` (Azure managed identity → STS web identity; the role may only
 * ReceiveMessage, DeleteMessage, ChangeMessageVisibility and GetQueueAttributes on it) and, for each
 * message, deletes the member's Mr OneHook data in Azure: every `aisessions` blob and every quota-ledger
 * row. Only then is the message deleted.
 *
 * - A failure leaves the message: it becomes visible again after the visibility timeout, is retried, and
 *   after 5 receives SQS moves it to the DLQ, which pages.
 * - A malformed message (not JSON, or a UserDeleted without a usable `detail.userId`) erases nothing and
 *   is never deleted, so it reaches the DLQ and a person looks at it instead of a deletion being dropped.
 *   Retrying cannot fix it, so its visibility is set to 0: it is redelivered at once and reaches the DLQ
 *   within seconds instead of after 5 visibility timeouts. If that call fails the message is just left
 *   and gets there on the normal schedule.
 * - A well-formed event that is not a UserDeleted from Profile is not ours: it is acknowledged (deleted)
 *   without touching any data.
 * - Erasure is idempotent, so a redelivery or a redrive from the DLQ is harmless.
 * - Logs carry the SQS message id, receive count, counts and error types only: never a member id, a
 *   message body or a blob name.
 */

export interface QueueMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
  /** SQS ApproximateReceiveCount (1 on the first delivery). */
  receiveCount: number;
}

export interface ErasureQueue {
  /** Long-polls for up to `maxMessages` messages; resolves empty on timeout. Rejects when aborted. */
  receive(maxMessages: number, signal: AbortSignal): Promise<QueueMessage[]>;
  delete(receiptHandle: string): Promise<void>;
  /** Makes the message visible again right away (visibility timeout 0), without deleting it. */
  release(receiptHandle: string): Promise<void>;
}

export interface ErasureResult {
  sessionBlobs: number;
  ledgerRows: number;
}

export interface UserDataEraser {
  eraseUser(userId: string): Promise<ErasureResult>;
}

export interface ErasureLogger {
  info(event: Record<string, unknown>): void;
  warn(event: Record<string, unknown>): void;
  error(event: Record<string, unknown>): void;
}

export type ParsedErasureMessage =
  | { kind: 'erase'; userId: string }
  | { kind: 'not-ours' }
  | { kind: 'malformed'; reason: string };

export type MessageOutcome = 'erased' | 'not-ours' | 'malformed' | 'failed';

export const USER_DELETED_SOURCE = 'club.onehook.profile';
export const USER_DELETED_DETAIL_TYPE = 'UserDeleted';
/** The queue's redrive policy (OneHookBackend matching-stack.ts): the 5th failed receive goes to the DLQ. */
export const DEFAULT_MAX_RECEIVE_COUNT = 5;

const QUEUE_URL_PATTERN = /^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com\/(\d{12})\/([A-Za-z0-9_-]{1,80})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/** Reads the EventBridge event JSON that the rule puts in the message body. */
export function parseUserDeletedMessage(body: string): ParsedErasureMessage {
  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    return { kind: 'malformed', reason: 'NOT_JSON' };
  }
  if (!isRecord(event)) return { kind: 'malformed', reason: 'NOT_AN_EVENT' };
  if (typeof event.source !== 'string' || typeof event['detail-type'] !== 'string') {
    return { kind: 'malformed', reason: 'NOT_AN_EVENT' };
  }
  if (event.source !== USER_DELETED_SOURCE || event['detail-type'] !== USER_DELETED_DETAIL_TYPE) {
    return { kind: 'not-ours' };
  }
  const userId = isRecord(event.detail) ? event.detail.userId : undefined;
  // Same bound as a verified token subject (auth.ts): the ids Mr OneHook stores data under.
  // eslint-disable-next-line no-control-regex
  if (typeof userId !== 'string' || userId.length < 1 || userId.length > 256 || /[\s\u0000-\u001f\u007f]/.test(userId)) {
    return { kind: 'malformed', reason: 'INVALID_USER_ID' };
  }
  return { kind: 'erase', userId };
}

/** Composes the two Azure stores. Both always run; if either fails the whole erasure fails (and retries). */
export function createUserDataEraser(
  sessions: { eraseUser(userId: string): Promise<number> },
  ledger?: { eraseUser(userId: string): Promise<number> },
): UserDataEraser {
  return {
    async eraseUser(userId: string): Promise<ErasureResult> {
      const [sessionResult, ledgerResult] = await Promise.allSettled([
        sessions.eraseUser(userId),
        ledger ? ledger.eraseUser(userId) : Promise.resolve(0),
      ]);
      if (sessionResult.status === 'rejected') throw sessionResult.reason;
      if (ledgerResult.status === 'rejected') throw ledgerResult.reason;
      return { sessionBlobs: sessionResult.value, ledgerRows: ledgerResult.value };
    },
  };
}

/** SQS adapter (AWS SDK v3, JSON protocol, SigV4 with the federated credentials given to the client). */
export class SqsErasureQueue implements ErasureQueue {
  constructor(
    private readonly client: Pick<SQSClient, 'send'>,
    private readonly queueUrl: string,
    private readonly waitTimeSeconds = 20,
  ) {}

  async receive(maxMessages: number, signal: AbortSignal): Promise<QueueMessage[]> {
    const output = await this.client.send(new ReceiveMessageCommand({
      QueueUrl: this.queueUrl,
      MaxNumberOfMessages: Math.min(Math.max(maxMessages, 1), 10),
      WaitTimeSeconds: this.waitTimeSeconds,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }), { abortSignal: signal });
    const messages: QueueMessage[] = [];
    for (const message of output.Messages ?? []) {
      if (!message.ReceiptHandle) continue;
      const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
      messages.push({
        messageId: message.MessageId ?? 'unknown',
        receiptHandle: message.ReceiptHandle,
        body: message.Body ?? '',
        receiveCount: Number.isSafeInteger(receiveCount) && receiveCount > 0 ? receiveCount : 1,
      });
    }
    return messages;
  }

  async delete(receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle }));
  }

  async release(receiptHandle: string): Promise<void> {
    await this.client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: 0,
    }));
  }
}

export interface UxErasureWorkerOptions {
  queue: ErasureQueue;
  eraser: UserDataEraser;
  /** Messages processed at once (one receive batch). 1-10. */
  concurrency?: number;
  maxReceiveCount?: number;
  logger?: ErasureLogger;
  /** Backoff after a failed receive: doubles from `initialBackoffMs` up to `maxBackoffMs`. */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

const consoleLogger: ErasureLogger = {
  info: (event) => console.info(JSON.stringify(event)),
  warn: (event) => console.warn(JSON.stringify(event)),
  error: (event) => console.error(JSON.stringify(event)),
};

export class UxErasureWorker {
  private readonly queue: ErasureQueue;
  private readonly eraser: UserDataEraser;
  private readonly concurrency: number;
  private readonly maxReceiveCount: number;
  private readonly logger: ErasureLogger;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private stopping = false;
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;
  private wakeSleep: (() => void) | undefined;

  constructor(options: UxErasureWorkerOptions) {
    this.queue = options.queue;
    this.eraser = options.eraser;
    this.concurrency = Math.min(Math.max(options.concurrency ?? 4, 1), 10);
    this.maxReceiveCount = options.maxReceiveCount ?? DEFAULT_MAX_RECEIVE_COUNT;
    this.logger = options.logger ?? consoleLogger;
    this.initialBackoffMs = options.initialBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
  }

  /** Starts the background poll loop (idempotent). */
  start(): void {
    if (this.loop || this.stopping) return;
    this.logger.info({ event: 'ux_erasure.started', concurrency: this.concurrency });
    this.loop = this.run();
  }

  /**
   * Stops polling: aborts the pending long poll and waits for in-flight messages, up to `timeoutMs`.
   * Anything unfinished is simply redelivered later (erasure is idempotent).
   */
  async stop(timeoutMs = 30_000): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    this.wakeSleep?.();
    if (!this.loop) return;
    let timer: NodeJS.Timeout | undefined;
    const finished = await Promise.race([
      this.loop.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
    if (timer) clearTimeout(timer);
    this.logger.info({ event: 'ux_erasure.stopped', drained: finished });
  }

  /** One receive + process cycle. Returns the outcomes (exposed for tests). */
  async pollOnce(): Promise<MessageOutcome[]> {
    const messages = await this.queue.receive(this.concurrency, this.abort.signal);
    return Promise.all(messages.map((message) => this.handle(message)));
  }

  /** Handles one message. Never throws. */
  async handle(message: QueueMessage): Promise<MessageOutcome> {
    const base = { messageId: message.messageId, receiveCount: message.receiveCount };
    const parsed = parseUserDeletedMessage(message.body);
    if (parsed.kind === 'malformed') {
      this.logger.warn({
        event: 'ux_erasure.malformed', ...base, reason: parsed.reason,
        movesToDlq: message.receiveCount >= this.maxReceiveCount,
      });
      try {
        // Never deleted: redelivered at once so it reaches the DLQ in seconds, not 5 visibility timeouts.
        await this.queue.release(message.receiptHandle);
      } catch (error: unknown) {
        // Left as is: it reaches the DLQ after the normal visibility timeouts.
        this.logger.warn({ event: 'ux_erasure.release_failed', ...base, errorType: errorType(error) });
      }
      return 'malformed';
    }
    if (parsed.kind === 'not-ours') {
      return (await this.acknowledge(message, base)) ? 'not-ours' : 'failed';
    }
    const startedAt = Date.now();
    let result: ErasureResult;
    try {
      result = await this.eraser.eraseUser(parsed.userId);
    } catch (error: unknown) {
      const finalAttempt = message.receiveCount >= this.maxReceiveCount;
      const event = {
        event: finalAttempt ? 'ux_erasure.failed_final' : 'ux_erasure.failed',
        ...base, errorType: errorType(error), movesToDlq: finalAttempt,
      };
      if (finalAttempt) this.logger.error(event);
      else this.logger.warn(event);
      return 'failed';
    }
    if (!(await this.acknowledge(message, base))) return 'failed';
    this.logger.info({
      event: 'ux_erasure.erased', ...base, ...result, durationMs: Date.now() - startedAt,
    });
    return 'erased';
  }

  private async acknowledge(message: QueueMessage, base: Record<string, unknown>): Promise<boolean> {
    try {
      await this.queue.delete(message.receiptHandle);
      return true;
    } catch (error: unknown) {
      // The data is already gone; the redelivery erases nothing new and is acknowledged then.
      this.logger.warn({ event: 'ux_erasure.ack_failed', ...base, errorType: errorType(error) });
      return false;
    }
  }

  private async run(): Promise<void> {
    let backoffMs = 0;
    while (!this.stopping) {
      try {
        await this.pollOnce();
        backoffMs = 0;
      } catch (error: unknown) {
        if (this.stopping) break;
        backoffMs = backoffMs === 0 ? this.initialBackoffMs : Math.min(backoffMs * 2, this.maxBackoffMs);
        this.logger.error({ event: 'ux_erasure.receive_failed', errorType: errorType(error), backoffMs });
        await this.sleep(backoffMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.wakeSleep = undefined; resolve(); }, ms);
      this.wakeSleep = () => { clearTimeout(timer); this.wakeSleep = undefined; resolve(); };
    });
  }
}

export interface UxErasureConfig {
  /** True when a valid queue URL is configured. */
  configured: boolean;
  queueUrl: string;
  /** Region parsed from the queue URL. */
  region: string;
  concurrency: number;
  /** Why a set queue URL cannot be used (empty when fine or not configured). */
  problems: string[];
}

/** `UX_ERASURE_QUEUE_URL` (empty = worker off) and `UX_ERASURE_CONCURRENCY` (1-10, default 4). */
export function loadUxErasureConfig(env: NodeJS.ProcessEnv = process.env): UxErasureConfig {
  const queueUrl = env.UX_ERASURE_QUEUE_URL?.trim() ?? '';
  const parsedConcurrency = Number.parseInt(env.UX_ERASURE_CONCURRENCY ?? '', 10);
  const concurrency = Number.isInteger(parsedConcurrency) && parsedConcurrency >= 1 && parsedConcurrency <= 10
    ? parsedConcurrency
    : 4;
  if (!queueUrl) return { configured: false, queueUrl: '', region: '', concurrency, problems: [] };
  const match = QUEUE_URL_PATTERN.exec(queueUrl);
  if (!match) {
    return {
      configured: false, queueUrl: '', region: '', concurrency,
      problems: ['UX_ERASURE_QUEUE_URL is not https://sqs.<region>.amazonaws.com/<account>/<queue>'],
    };
  }
  return { configured: true, queueUrl, region: match[1]!, concurrency, problems: [] };
}
