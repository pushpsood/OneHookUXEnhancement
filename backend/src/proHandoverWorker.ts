import { EventSources } from 'onehook-api-client/events';
import type { ErasureLogger, ErasureQueue, QueueMessage } from './uxErasureWorker';
import { MembershipUnavailableError } from './membershipDirectory';
import { ProRetryLaterError, type ProSubscriptionService } from './proSubscriptionService';

/**
 * The membership's Pro handover (OneHookBackend State -> Mr OneHook).
 *
 * When a member buys (or is granted) a membership tier that includes Mr OneHook Pro, State keeps the
 * upgrade pending and publishes `MrOneHookProHandoverRequested` (source `onehook.state`,
 * `detail: { userId, activationId }`). An EventBridge rule delivers it to the SQS queue
 * `OneHook-Matching-<stage>-MrOneHookEntitlements` (DLQ after 5 receives). This worker long-polls it with the
 * federated role, settles the member's Pro subscription (stop renewing, schedule a yearly refund, cancel a
 * kept-Pro plan), then confirms to State, which only then finalizes the membership.
 *
 * - Settling and confirming are idempotent, so a redelivery is harmless.
 * - A failure (State unreachable, a purchase mid-charge) leaves the message: it is retried after the
 *   visibility timeout and reaches the DLQ after 5 receives; the membership stays pending meanwhile.
 * - A malformed message is never acknowledged (made visible at once so it reaches the DLQ quickly).
 * - Logs carry the message id, receive count and outcome only: never a member id.
 */
export const HANDOVER_SOURCE = EventSources.STATE;
/** Not yet in the onehook-api-client event catalog; it moves there with the State change. */
export const HANDOVER_DETAIL_TYPE = 'MrOneHookProHandoverRequested';

export type ParsedHandover =
  | { kind: 'handover'; eventId: string; userId: string; activationId: string }
  | { kind: 'not-ours' }
  | { kind: 'malformed'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// eslint-disable-next-line no-control-regex
const SAFE_ID = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 256 && !/[\s\u0000-\u001f\u007f]/.test(value);

export function parseHandoverMessage(body: string): ParsedHandover {
  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    return { kind: 'malformed', reason: 'NOT_JSON' };
  }
  if (!isRecord(event) || typeof event.source !== 'string' || typeof event['detail-type'] !== 'string') {
    return { kind: 'malformed', reason: 'NOT_AN_EVENT' };
  }
  if (event.source !== HANDOVER_SOURCE || event['detail-type'] !== HANDOVER_DETAIL_TYPE) return { kind: 'not-ours' };
  const detail = isRecord(event.detail) ? event.detail : undefined;
  if (!SAFE_ID(event.id) || !SAFE_ID(detail?.userId) || !SAFE_ID(detail?.activationId)) {
    return { kind: 'malformed', reason: 'INVALID_DETAIL' };
  }
  return { kind: 'handover', eventId: event.id, userId: detail.userId, activationId: detail.activationId };
}

export type HandoverOutcome = 'settled' | 'duplicate' | 'not-ours' | 'malformed' | 'failed';

const consoleLogger: ErasureLogger = {
  info: (event) => console.info(JSON.stringify(event)),
  warn: (event) => console.warn(JSON.stringify(event)),
  error: (event) => console.error(JSON.stringify(event)),
};

export class ProHandoverWorker {
  private stopping = false;
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;
  private wakeSleep: (() => void) | undefined;

  constructor(
    private readonly queue: ErasureQueue,
    private readonly pro: ProSubscriptionService,
    private readonly logger: ErasureLogger = consoleLogger,
    private readonly maxReceiveCount = 5,
  ) {}

  start(): void {
    if (this.loop || this.stopping) return;
    this.logger.info({ event: 'pro_handover.started' });
    this.loop = this.run();
  }

  async stop(timeoutMs = 30_000): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    this.wakeSleep?.();
    if (!this.loop) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.loop, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
    if (timer) clearTimeout(timer);
  }

  async pollOnce(): Promise<HandoverOutcome[]> {
    const messages = await this.queue.receive(4, this.abort.signal);
    return Promise.all(messages.map((m) => this.handle(m)));
  }

  async handle(message: QueueMessage): Promise<HandoverOutcome> {
    const base = { messageId: message.messageId, receiveCount: message.receiveCount };
    const parsed = parseHandoverMessage(message.body);
    if (parsed.kind === 'malformed') {
      this.logger.warn({ event: 'pro_handover.malformed', ...base, reason: parsed.reason });
      await this.queue.release(message.receiptHandle).catch(() => undefined);
      return 'malformed';
    }
    if (parsed.kind === 'not-ours') {
      await this.queue.delete(message.receiptHandle).catch(() => undefined);
      return 'not-ours';
    }
    let outcome: 'settled' | 'duplicate';
    try {
      outcome = await this.pro.handleHandover(parsed.userId, parsed.activationId, parsed.eventId);
    } catch (error) {
      const finalAttempt = message.receiveCount >= this.maxReceiveCount;
      const event = {
        event: finalAttempt ? 'pro_handover.failed_final' : 'pro_handover.failed',
        ...base,
        errorType: error instanceof MembershipUnavailableError ? 'MembershipUnavailable'
          : error instanceof ProRetryLaterError ? 'RetryLater'
            : error instanceof Error ? error.name : 'UnknownError',
      };
      if (finalAttempt) this.logger.error(event);
      else this.logger.warn(event);
      return 'failed';
    }
    try {
      await this.queue.delete(message.receiptHandle);
    } catch {
      // Settled and confirmed already; the redelivery is a duplicate and is acknowledged then.
    }
    this.logger.info({ event: `pro_handover.${outcome}`, ...base });
    return outcome;
  }

  private async run(): Promise<void> {
    let backoffMs = 0;
    while (!this.stopping) {
      try {
        await this.pollOnce();
        backoffMs = 0;
      } catch (error) {
        if (this.stopping) break;
        backoffMs = backoffMs === 0 ? 1_000 : Math.min(backoffMs * 2, 60_000);
        this.logger.error({ event: 'pro_handover.receive_failed', errorType: error instanceof Error ? error.name : 'UnknownError', backoffMs });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, backoffMs);
          this.wakeSleep = () => { clearTimeout(timer); resolve(); };
        });
      }
    }
  }
}

/** Runs the Pro renewal job on an interval (each instance; due rows are leased, so they never collide). */
export class ProRenewalScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(private readonly pro: ProSubscriptionService, private readonly intervalMs: number) {}

  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.running) return;
      this.running = this.pro.runDue()
        .then((handled) => {
          if (handled > 0) console.info(JSON.stringify({ event: 'pro.job_ran', handled }));
        })
        .catch((error: unknown) => {
          console.error(JSON.stringify({ event: 'pro.job_failed', errorType: error instanceof Error ? error.name : 'UnknownError' }));
        })
        .finally(() => { this.running = undefined; });
    };
    // Spread instances apart so they do not all scan at once.
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref();
    setTimeout(tick, Math.floor(Math.random() * Math.min(this.intervalMs, 60_000))).unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
