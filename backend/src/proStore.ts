import { createHash } from 'node:crypto';
import { odata, type TableClient } from '@azure/data-tables';

/**
 * Storage for Mr OneHook Pro: one Azure Table (`mronehookpro`), one partition per member
 * (PartitionKey = hex sha256 of the Cognito subject, like the quota table), one JSON document per row:
 *
 *   subscription         the member's current (or last) Pro subscription
 *   continuation         a "Keep Mr OneHook Pro" scheduled after the membership ends
 *   handover             the last membership activation that included Pro (purchase guard)
 *   notice:<id>          what the member is told (refunds, renewals, ...)
 *   usage:<YYYY-MM>      file-processing allowance for the UTC month
 *   ledger:<...>         one row per charge or refund attempt (insert-if-absent = at most once)
 *   event:<id>           processed handover events
 *
 * Every write is conditional: insert-if-absent, or replace on the row's ETag. `nextActionAt` is a separate
 * column on the row, and the renewal job finds due rows through a small index next to the member partitions:
 *
 *   due:<YYYYMMDDHH> / <partitionKey>_<rowKey>   "this row has something to do in this UTC hour"
 *   meta / due-index                             the index holds every row (written once, after a backfill)
 *
 * An index entry is only a hint: the job reads the real row and acts only when its own `nextActionAt` is due.
 * Entries are written before the row, so a crash in between leaves an extra entry (removed later), never a
 * due row the job cannot find. Entries whose row moved, cleared or was deleted are removed as they are met.
 */
export interface ProTableRow {
  data: string;
  nextActionAt?: string;
  etag: string;
}

/** The table operations Pro uses; {@link AzureProTable} in production, an in-memory table in tests. */
export interface ProTable {
  get(partitionKey: string, rowKey: string): Promise<ProTableRow | undefined>;
  /** Throws {@link RowExistsError} when the row exists. Returns the new ETag. */
  insert(partitionKey: string, rowKey: string, data: string, nextActionAt?: string): Promise<string>;
  /** Throws {@link RowChangedError} when the ETag no longer matches. Returns the new ETag. */
  replace(partitionKey: string, rowKey: string, data: string, etag: string, nextActionAt?: string): Promise<string>;
  /** Idempotent. */
  delete(partitionKey: string, rowKey: string): Promise<void>;
  /** Rows of one partition whose RowKey starts with `prefix`. */
  list(partitionKey: string, prefix: string): Promise<Array<ProTableRow & { rowKey: string }>>;
  /** Rows whose PartitionKey is between `fromPartition` and `toPartition` (inclusive), at most `limit`. */
  listRange(fromPartition: string, toPartition: string, limit: number): Promise<Array<ProTableRow & { partitionKey: string; rowKey: string }>>;
  /**
   * Every row with one of `rowKeys` that has a `nextActionAt`, across all partitions. Reads the whole table:
   * used once, to fill the due index for rows written before it existed.
   */
  scanScheduled(rowKeys: string[]): Promise<Array<{ partitionKey: string; rowKey: string; nextActionAt: string }>>;
}

export class RowExistsError extends Error {}
export class RowChangedError extends Error {}
/** The Pro table could not be read or written. Callers answer 503; never "not Pro". */
export class ProStoreUnavailableError extends Error {}

export function proPartitionKey(userId: string): string {
  return createHash('sha256').update(userId, 'utf8').digest('hex');
}

function statusOf(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'statusCode' in error
    ? Number((error as { statusCode: unknown }).statusCode)
    : undefined;
}

type Entity = { partitionKey?: string; rowKey?: string; data?: unknown; nextActionAt?: unknown; etag?: string };

/** Azure Table Storage adapter (managed identity, Storage Table Data Contributor on the table). */
export class AzureProTable implements ProTable {
  constructor(private readonly table: Pick<TableClient, 'getEntity' | 'createEntity' | 'updateEntity' | 'deleteEntity' | 'listEntities'>) {}

  async get(partitionKey: string, rowKey: string): Promise<ProTableRow | undefined> {
    try {
      const entity = await this.table.getEntity<Entity>(partitionKey, rowKey);
      return toRow(entity);
    } catch (error) {
      if (statusOf(error) === 404) return undefined;
      throw new ProStoreUnavailableError(errorMessage(error));
    }
  }

  async insert(partitionKey: string, rowKey: string, data: string, nextActionAt?: string): Promise<string> {
    try {
      const result = await this.table.createEntity({ partitionKey, rowKey, data, ...(nextActionAt ? { nextActionAt } : {}) });
      return result.etag ?? '';
    } catch (error) {
      if (statusOf(error) === 409) throw new RowExistsError(rowKey);
      throw new ProStoreUnavailableError(errorMessage(error));
    }
  }

  async replace(partitionKey: string, rowKey: string, data: string, etag: string, nextActionAt?: string): Promise<string> {
    try {
      // Replace (not Merge): a cleared nextActionAt is removed from the entity.
      const result = await this.table.updateEntity(
        { partitionKey, rowKey, data, ...(nextActionAt ? { nextActionAt } : {}) },
        'Replace',
        { etag },
      );
      return result.etag ?? '';
    } catch (error) {
      const status = statusOf(error);
      if (status === 412 || status === 404) throw new RowChangedError(rowKey);
      throw new ProStoreUnavailableError(errorMessage(error));
    }
  }

  async delete(partitionKey: string, rowKey: string): Promise<void> {
    try {
      await this.table.deleteEntity(partitionKey, rowKey);
    } catch (error) {
      if (statusOf(error) === 404) return;
      throw new ProStoreUnavailableError(errorMessage(error));
    }
  }

  async list(partitionKey: string, prefix: string): Promise<Array<ProTableRow & { rowKey: string }>> {
    try {
      const rows: Array<ProTableRow & { rowKey: string }> = [];
      // Row keys use only [A-Za-z0-9:_-], so '~' (0x7e) sorts after every key with this prefix.
      const filter = odata`PartitionKey eq ${partitionKey} and RowKey ge ${prefix} and RowKey lt ${`${prefix}~`}`;
      for await (const entity of this.table.listEntities<Entity>({ queryOptions: { filter } })) {
        const row = toRow(entity);
        if (row && typeof entity.rowKey === 'string') rows.push({ ...row, rowKey: entity.rowKey });
        if (rows.length > 1000) throw new Error('Partition scan limit exceeded');
      }
      return rows;
    } catch (error) {
      throw new ProStoreUnavailableError(errorMessage(error));
    }
  }

  async listRange(fromPartition: string, toPartition: string, limit: number) {
    try {
      const filter = odata`PartitionKey ge ${fromPartition} and PartitionKey le ${toPartition}`;
      const out: Array<ProTableRow & { partitionKey: string; rowKey: string }> = [];
      for await (const entity of this.table.listEntities<Entity>({ queryOptions: { filter } })) {
        const row = toRow(entity);
        if (row && typeof entity.partitionKey === 'string' && typeof entity.rowKey === 'string') {
          out.push({ ...row, partitionKey: entity.partitionKey, rowKey: entity.rowKey });
        }
        if (out.length >= limit) break;
      }
      return out;
    } catch (error) {
      throw new ProStoreUnavailableError(errorMessage(error));
    }
  }

  async scanScheduled(rowKeys: string[]) {
    try {
      const keys = rowKeys.map((key) => odata`RowKey eq ${key}`).join(' or ');
      const filter = `(${keys}) and nextActionAt ge ''`;
      const out: Array<{ partitionKey: string; rowKey: string; nextActionAt: string }> = [];
      for await (const entity of this.table.listEntities<Entity>({ queryOptions: { filter, select: ['PartitionKey', 'RowKey', 'nextActionAt'] } })) {
        if (typeof entity.partitionKey === 'string' && typeof entity.rowKey === 'string' && typeof entity.nextActionAt === 'string') {
          out.push({ partitionKey: entity.partitionKey, rowKey: entity.rowKey, nextActionAt: entity.nextActionAt });
        }
      }
      return out;
    } catch (error) {
      throw new ProStoreUnavailableError(errorMessage(error));
    }
  }
}

function toRow(entity: Entity): ProTableRow | undefined {
  if (typeof entity.data !== 'string') return undefined;
  return {
    data: entity.data,
    ...(typeof entity.nextActionAt === 'string' ? { nextActionAt: entity.nextActionAt } : {}),
    etag: entity.etag ?? '',
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Pro table failure';
}

export interface Stored<T> {
  value: T;
  etag: string;
}

/**
 * Typed documents on a {@link ProTable}. A row that does not parse is an error (never silently "absent"),
 * so a corrupt subscription can never read as "not Pro" and be charged again.
 */
export class ProStore {
  private indexed = false;

  constructor(private readonly table: ProTable) {}

  async read<T>(userId: string, rowKey: string, parse: (value: unknown) => T): Promise<Stored<T> | undefined> {
    const row = await this.table.get(proPartitionKey(userId), rowKey);
    if (!row) return undefined;
    return { value: parse(JSON.parse(row.data) as unknown), etag: row.etag };
  }

  async readByPartition<T>(partitionKey: string, rowKey: string, parse: (value: unknown) => T): Promise<Stored<T> | undefined> {
    const row = await this.table.get(partitionKey, rowKey);
    if (!row) return undefined;
    return { value: parse(JSON.parse(row.data) as unknown), etag: row.etag };
  }

  async insert<T>(userId: string, rowKey: string, value: T, nextActionAt?: string): Promise<string> {
    const partitionKey = proPartitionKey(userId);
    if (nextActionAt) await this.index(partitionKey, rowKey, nextActionAt);
    return this.table.insert(partitionKey, rowKey, JSON.stringify(value), nextActionAt);
  }

  async replace<T>(userId: string, rowKey: string, value: T, etag: string, nextActionAt?: string): Promise<string> {
    const partitionKey = proPartitionKey(userId);
    if (nextActionAt) await this.index(partitionKey, rowKey, nextActionAt);
    return this.table.replace(partitionKey, rowKey, JSON.stringify(value), etag, nextActionAt);
  }

  /** Insert when `etag` is undefined, else replace on it. */
  write<T>(userId: string, rowKey: string, value: T, etag: string | undefined, nextActionAt?: string): Promise<string> {
    return etag === undefined
      ? this.insert(userId, rowKey, value, nextActionAt)
      : this.replace(userId, rowKey, value, etag, nextActionAt);
  }

  /** Deletes the row and its due-index entry (so nothing about it is left behind). */
  async delete(userId: string, rowKey: string): Promise<void> {
    const partitionKey = proPartitionKey(userId);
    const row = await this.table.get(partitionKey, rowKey);
    await this.table.delete(partitionKey, rowKey);
    if (row?.nextActionAt) await this.table.delete(dueBucket(row.nextActionAt), dueEntryKey(partitionKey, rowKey));
  }

  async list<T>(userId: string, prefix: string, parse: (value: unknown) => T): Promise<Array<Stored<T> & { rowKey: string }>> {
    const rows = await this.table.list(proPartitionKey(userId), prefix);
    return rows.map((row) => ({ rowKey: row.rowKey, value: parse(JSON.parse(row.data) as unknown), etag: row.etag }));
  }

  /**
   * Rows with one of `rowKeys` whose `nextActionAt` is at or before `now`, found through the due index
   * (only the index's past hours are read, never the members' partitions). Each candidate's real row is
   * read; stale index entries are removed on the way.
   */
  async due(rowKeys: string[], now: Date, limit: number): Promise<Array<{ partitionKey: string; rowKey: string }>> {
    await this.ensureIndexed();
    const nowIso = now.toISOString();
    const out: Array<{ partitionKey: string; rowKey: string }> = [];
    const seen = new Set<string>();
    // Stale entries are removed as they are met, so each run reads at most a bounded number of them.
    const entries = await this.table.listRange(DUE_PREFIX, dueBucket(nowIso), Math.max(limit * 5, 50));
    for (const entry of entries) {
      if (out.length >= limit) break;
      const split = entry.rowKey.indexOf('_');
      if (split < 1) continue;
      const partitionKey = entry.rowKey.slice(0, split);
      const rowKey = entry.rowKey.slice(split + 1);
      if (!rowKeys.includes(rowKey)) continue;
      const row = await this.table.get(partitionKey, rowKey);
      if (!row?.nextActionAt || dueBucket(row.nextActionAt) !== entry.partitionKey) {
        await this.table.delete(entry.partitionKey, entry.rowKey);
        continue;
      }
      const key = `${partitionKey}_${rowKey}`;
      if (row.nextActionAt <= nowIso && !seen.has(key)) {
        seen.add(key);
        out.push({ partitionKey, rowKey });
      }
    }
    return out;
  }

  private async index(partitionKey: string, rowKey: string, nextActionAt: string): Promise<void> {
    try {
      await this.table.insert(dueBucket(nextActionAt), dueEntryKey(partitionKey, rowKey), '{}');
    } catch (error) {
      if (!(error instanceof RowExistsError)) throw error;
    }
  }

  /** Rows written before the index existed are added once; afterwards every write keeps it complete. */
  private async ensureIndexed(): Promise<void> {
    if (this.indexed) return;
    if (!await this.table.get(META_PARTITION, DUE_INDEX_ROW)) {
      for (const row of await this.table.scanScheduled([...SCHEDULED_ROWS])) {
        await this.index(row.partitionKey, row.rowKey, row.nextActionAt);
      }
      try {
        await this.table.insert(META_PARTITION, DUE_INDEX_ROW, JSON.stringify({ version: 1 }));
      } catch (error) {
        if (!(error instanceof RowExistsError)) throw error;
      }
    }
    this.indexed = true;
  }
}

const DUE_PREFIX = 'due:';
const META_PARTITION = 'meta';
const DUE_INDEX_ROW = 'due-index';
/** The rows that carry a `nextActionAt` (the subscription and a scheduled "Keep Mr OneHook Pro"). */
const SCHEDULED_ROWS = ['subscription', 'continuation'] as const;

/** The index partition for a time: `due:YYYYMMDDHH` (UTC), so partitions sort in time order. */
export function dueBucket(iso: string): string {
  return `${DUE_PREFIX}${new Date(iso).toISOString().slice(0, 13).replace(/[-T]/g, '')}`;
}

function dueEntryKey(partitionKey: string, rowKey: string): string {
  return `${partitionKey}_${rowKey}`;
}
