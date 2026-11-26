import { RowChangedError, RowExistsError, ProStoreUnavailableError, type ProTable, type ProTableRow } from '../../proStore';

/** An in-memory {@link ProTable} with real ETag semantics (insert-if-absent, replace-on-ETag). */
export class MemoryProTable implements ProTable {
  readonly rows = new Map<string, { data: string; nextActionAt?: string; etag: string }>();
  private counter = 0;
  /** How many times the whole table was read (the due-index backfill). */
  fullScans = 0;
  /** Set to make every call fail like an unreachable table. */
  down = false;

  private key(pk: string, rk: string): string {
    return `${pk}\u0000${rk}`;
  }

  private check(): void {
    if (this.down) throw new ProStoreUnavailableError('table down');
  }

  async get(pk: string, rk: string): Promise<ProTableRow | undefined> {
    this.check();
    const row = this.rows.get(this.key(pk, rk));
    return row ? { ...row } : undefined;
  }

  async insert(pk: string, rk: string, data: string, nextActionAt?: string): Promise<string> {
    this.check();
    if (this.rows.has(this.key(pk, rk))) throw new RowExistsError(rk);
    const etag = `e${++this.counter}`;
    this.rows.set(this.key(pk, rk), { data, etag, ...(nextActionAt ? { nextActionAt } : {}) });
    return etag;
  }

  async replace(pk: string, rk: string, data: string, etag: string, nextActionAt?: string): Promise<string> {
    this.check();
    const row = this.rows.get(this.key(pk, rk));
    if (!row || row.etag !== etag) throw new RowChangedError(rk);
    const next = `e${++this.counter}`;
    this.rows.set(this.key(pk, rk), { data, etag: next, ...(nextActionAt ? { nextActionAt } : {}) });
    return next;
  }

  async delete(pk: string, rk: string): Promise<void> {
    this.check();
    this.rows.delete(this.key(pk, rk));
  }

  async list(pk: string, prefix: string) {
    this.check();
    const out: Array<ProTableRow & { rowKey: string }> = [];
    for (const [key, row] of this.rows) {
      const [p, r] = key.split('\u0000') as [string, string];
      if (p === pk && r.startsWith(prefix)) out.push({ ...row, rowKey: r });
    }
    return out;
  }

  async listRange(from: string, to: string, limit: number) {
    this.check();
    const out: Array<ProTableRow & { partitionKey: string; rowKey: string }> = [];
    // Sorted like Azure Tables (PartitionKey, then RowKey).
    for (const [key, row] of [...this.rows].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const [p, r] = key.split('\u0000') as [string, string];
      if (p >= from && p <= to) out.push({ ...row, partitionKey: p, rowKey: r });
      if (out.length >= limit) break;
    }
    return out;
  }

  async scanScheduled(rowKeys: string[]) {
    this.check();
    this.fullScans += 1;
    const out: Array<{ partitionKey: string; rowKey: string; nextActionAt: string }> = [];
    for (const [key, row] of this.rows) {
      const [p, r] = key.split('\u0000') as [string, string];
      if (rowKeys.includes(r) && row.nextActionAt) out.push({ partitionKey: p, rowKey: r, nextActionAt: row.nextActionAt });
    }
    return out;
  }

  /** The documents with this row-key prefix, parsed (assertions). */
  docs(prefix: string): unknown[] {
    return [...this.rows.entries()]
      .filter(([key]) => key.split('\u0000')[1]!.startsWith(prefix))
      .map(([, row]) => JSON.parse(row.data) as unknown);
  }
}

/** A clock tests move by hand. */
export function manualClock(start: string) {
  let t = Date.parse(start);
  return {
    now: () => new Date(t),
    set: (iso: string) => { t = Date.parse(iso); },
    advance: (ms: number) => { t += ms; },
  };
}
