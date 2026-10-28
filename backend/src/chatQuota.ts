import { createHash } from 'node:crypto';
import type { TableClient } from '@azure/data-tables';

/**
 * Per-member daily Mr OneHook message allowance for the free tier (Must): 10 messages per UTC day.
 * Paid tiers (Super and above) never touch the store.
 *
 * Backed by Azure Table Storage: one row per member (PartitionKey = sha256(userId), RowKey = "daily"),
 * holding the UTC day and the count, overwritten when the day changes. So rows never grow and need no
 * cleanup. Increments are optimistic: read, then a conditional write on the row's ETag (insert-if-absent
 * for a first message), retried on conflict, so two concurrent messages can never both take the last slot.
 *
 * The slot is taken BEFORE the model call and released if the model fails, so a failed answer never
 * costs a message. Any store failure surfaces as {@link QuotaUnavailableError}: the caller answers 503,
 * never unlimited messages.
 */
export const FREE_DAILY_MESSAGES = 10;

export type QuotaDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; remaining: 0 };

export interface ChatQuota {
  /** Takes one of today's messages for the member, if any are left. */
  consume(userId: string, now?: Date): Promise<QuotaDecision>;
  /** Gives back a message taken by {@link consume} (the model call failed). Best effort. */
  release(userId: string, now?: Date): Promise<void>;
}

export class QuotaUnavailableError extends Error {}

/** Minimal surface of TableClient used here, so tests can fake it without Azure. */
export type QuotaTable = Pick<TableClient, 'getEntity' | 'createEntity' | 'updateEntity'>;

interface Row {
  partitionKey: string;
  rowKey: string;
  day: string;
  count: number;
  etag?: string;
}

const ROW = 'daily';
const MAX_RETRIES = 5;

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function partitionFor(userId: string): string {
  return createHash('sha256').update(userId, 'utf8').digest('hex');
}

function statusOf(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'statusCode' in error
    ? Number((error as { statusCode: unknown }).statusCode)
    : undefined;
}

export class TableChatQuota implements ChatQuota {
  constructor(
    private readonly table: QuotaTable,
    private readonly limit = FREE_DAILY_MESSAGES,
  ) {}

  async consume(userId: string, now = new Date()): Promise<QuotaDecision> {
    const pk = partitionFor(userId);
    const day = utcDay(now);
    try {
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const row = await this.read(pk);
        const used = row && row.day === day ? row.count : 0;
        if (used >= this.limit) return { allowed: false, remaining: 0 };
        const next = { partitionKey: pk, rowKey: ROW, day, count: used + 1 };
        try {
          if (!row) await this.table.createEntity(next);
          else await this.table.updateEntity(next, 'Replace', { etag: row.etag! });
          return { allowed: true, remaining: this.limit - next.count };
        } catch (error) {
          const status = statusOf(error);
          if (status === 409 || status === 412) continue; // someone else wrote first: re-read
          throw error;
        }
      }
      throw new Error('Too much contention on the quota row');
    } catch (error) {
      throw new QuotaUnavailableError(error instanceof Error ? error.message : 'quota store failed');
    }
  }

  async release(userId: string, now = new Date()): Promise<void> {
    const pk = partitionFor(userId);
    const day = utcDay(now);
    try {
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const row = await this.read(pk);
        if (!row || row.day !== day || row.count <= 0) return;
        try {
          await this.table.updateEntity({ partitionKey: pk, rowKey: ROW, day, count: row.count - 1 }, 'Replace',
            { etag: row.etag! });
          return;
        } catch (error) {
          if (statusOf(error) === 412) continue;
          return;
        }
      }
    } catch {
      // Best effort: a failed release only costs the member one message.
    }
  }

  private async read(pk: string): Promise<Row | undefined> {
    try {
      const e = await this.table.getEntity<{ day: string; count: number }>(pk, ROW);
      return { partitionKey: pk, rowKey: ROW, day: String(e.day), count: Number(e.count) || 0, etag: e.etag };
    } catch (error) {
      if (statusOf(error) === 404) return undefined;
      throw error;
    }
  }
}

/** Used when no table is configured: free members get 503, never unlimited messages. */
export const unavailableChatQuota: ChatQuota = {
  consume: async () => {
    throw new QuotaUnavailableError('Chat quota store is not configured');
  },
  release: async () => {},
};
