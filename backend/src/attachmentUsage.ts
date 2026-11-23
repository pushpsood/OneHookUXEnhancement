import { RowChangedError, RowExistsError, type ProStore } from './proStore';

/**
 * The file-processing allowance of a Pro member: chat stays unlimited, but reading files costs money
 * (vision, document reading, transcription), so each member has a monthly budget in paise, kept below
 * what the plan earns, plus a burst limit (default 10 files per 10 minutes).
 *
 * One row per member and UTC month (`usage:<YYYY-MM>` in the Pro table). An upload first RESERVES an
 * estimate of its cost (the most it can cost for its kind and size); when processing ends the reservation
 * is SETTLED with the measured cost. Reservations make the budget hold under concurrent uploads: a file is
 * refused before any money is spent on it. All writes are ETag-conditional with retries.
 */
export interface UsageDoc {
  schemaVersion: 1;
  month: string;
  /** Milli-paise reserved by files still processing. */
  reservedMilli: number;
  /** Milli-paise measured for processed files. */
  spentMilli: number;
  files: number;
  /** Upload times (ms) inside the burst window. */
  recent: number[];
  /** The 80% warning was given this month. */
  warned: boolean;
}

export type UsageDecision =
  | { allowed: true; month: string; warning: boolean; crossedWarning: boolean }
  | { allowed: false; retryAt: string; reason: 'BURST' | 'BUDGET' };

export class AttachmentUsageUnavailableError extends Error {}

const WARNING_SHARE = 0.8;

export function usageMonth(now: Date): string {
  return now.toISOString().slice(0, 7);
}

export function nextMonthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

function parseUsage(value: unknown): UsageDoc {
  const r = value as Partial<UsageDoc> | null;
  if (!r || r.schemaVersion !== 1 || typeof r.month !== 'string'
    || !Number.isFinite(r.reservedMilli) || !Number.isFinite(r.spentMilli) || !Array.isArray(r.recent)) {
    throw new Error('Invalid usage row');
  }
  return {
    schemaVersion: 1, month: r.month, reservedMilli: Math.max(0, r.reservedMilli!), spentMilli: Math.max(0, r.spentMilli!),
    files: Number(r.files) || 0, recent: r.recent.filter((t): t is number => typeof t === 'number'), warned: r.warned === true,
  };
}

export class AttachmentUsageLedger {
  constructor(
    private readonly store: ProStore,
    private readonly limits: { burstFiles: number; burstWindowMs: number },
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Reserves `estimateMilli` for one upload, or refuses it (burst or monthly budget). */
  async reserve(userId: string, budgetMinor: number, estimateMilli: number): Promise<UsageDecision> {
    const now = this.now();
    const month = usageMonth(now);
    const budgetMilli = budgetMinor * 1000;
    return this.mutate<UsageDecision>(userId, month, (doc) => {
      const windowStart = now.getTime() - this.limits.burstWindowMs;
      const recent = doc.recent.filter((t) => t > windowStart);
      if (recent.length >= this.limits.burstFiles) {
        return { decision: { allowed: false, retryAt: new Date(Math.min(...recent) + this.limits.burstWindowMs).toISOString(), reason: 'BURST' } };
      }
      const committed = doc.spentMilli + doc.reservedMilli;
      if (committed + estimateMilli > budgetMilli) {
        return { decision: { allowed: false, retryAt: nextMonthStart(now), reason: 'BUDGET' } };
      }
      const after = committed + estimateMilli;
      const warning = after >= budgetMilli * WARNING_SHARE;
      const crossedWarning = warning && !doc.warned;
      return {
        decision: { allowed: true, month, warning, crossedWarning },
        next: {
          ...doc, reservedMilli: doc.reservedMilli + estimateMilli, files: doc.files + 1,
          recent: [...recent, now.getTime()], warned: doc.warned || warning,
        },
      };
    });
  }

  /** Replaces a reservation by the measured cost (which may be lower or, rarely, higher). Best effort. */
  async settle(userId: string, month: string, reservedMilli: number, actualMilli: number): Promise<void> {
    await this.mutate<undefined>(userId, month, (doc) => ({
      decision: undefined,
      next: {
        ...doc,
        reservedMilli: Math.max(0, doc.reservedMilli - reservedMilli),
        spentMilli: doc.spentMilli + Math.max(0, Math.round(actualMilli)),
      },
    }));
  }

  /** This month's share of the budget used (spent + reserved), 0-100. */
  async usedPercent(userId: string, budgetMinor: number): Promise<number> {
    const now = this.now();
    const row = await this.read(userId, usageMonth(now));
    if (!row) return 0;
    const used = row.value.spentMilli + row.value.reservedMilli;
    return Math.min(100, Math.floor((used / (budgetMinor * 1000)) * 100));
  }

  private async read(userId: string, month: string) {
    try {
      return await this.store.read(userId, `usage:${month}`, parseUsage);
    } catch (error) {
      throw new AttachmentUsageUnavailableError(error instanceof Error ? error.message : 'usage read failed');
    }
  }

  private async mutate<D>(
    userId: string,
    month: string,
    change: (doc: UsageDoc) => { decision: D; next?: UsageDoc },
  ): Promise<D> {
    const rowKey = `usage:${month}`;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const existing = await this.read(userId, month);
      const doc: UsageDoc = existing?.value
        ?? { schemaVersion: 1, month, reservedMilli: 0, spentMilli: 0, files: 0, recent: [], warned: false };
      const { decision, next } = change(doc);
      if (!next) return decision;
      try {
        await this.store.write(userId, rowKey, next, existing?.etag);
        return decision;
      } catch (error) {
        if (error instanceof RowChangedError || error instanceof RowExistsError) continue;
        throw new AttachmentUsageUnavailableError(error instanceof Error ? error.message : 'usage write failed');
      }
    }
    throw new AttachmentUsageUnavailableError('Too much contention on the usage row');
  }
}
