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
 * column so the renewal job can find due rows without reading every document.
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
  /** Rows with one of `rowKeys` whose `nextActionAt` is at or before `nowIso`, across partitions. */
  due(rowKeys: string[], nowIso: string, limit: number): Promise<Array<{ partitionKey: string; rowKey: string }>>;
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

  async due(rowKeys: string[], nowIso: string, limit: number): Promise<Array<{ partitionKey: string; rowKey: string }>> {
    try {
      const keys = rowKeys.map((key) => odata`RowKey eq ${key}`).join(' or ');
      const filter = `(${keys}) and ${odata`nextActionAt le ${nowIso}`}`;
      const out: Array<{ partitionKey: string; rowKey: string }> = [];
      for await (const entity of this.table.listEntities<Entity>({ queryOptions: { filter, select: ['PartitionKey', 'RowKey'] } })) {
        if (typeof entity.partitionKey === 'string' && typeof entity.rowKey === 'string') {
          out.push({ partitionKey: entity.partitionKey, rowKey: entity.rowKey });
        }
        if (out.length >= limit) break;
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

  insert<T>(userId: string, rowKey: string, value: T, nextActionAt?: string): Promise<string> {
    return this.table.insert(proPartitionKey(userId), rowKey, JSON.stringify(value), nextActionAt);
  }

  replace<T>(userId: string, rowKey: string, value: T, etag: string, nextActionAt?: string): Promise<string> {
    return this.table.replace(proPartitionKey(userId), rowKey, JSON.stringify(value), etag, nextActionAt);
  }

  /** Insert when `etag` is undefined, else replace on it. */
  write<T>(userId: string, rowKey: string, value: T, etag: string | undefined, nextActionAt?: string): Promise<string> {
    return etag === undefined
      ? this.insert(userId, rowKey, value, nextActionAt)
      : this.replace(userId, rowKey, value, etag, nextActionAt);
  }

  delete(userId: string, rowKey: string): Promise<void> {
    return this.table.delete(proPartitionKey(userId), rowKey);
  }

  async list<T>(userId: string, prefix: string, parse: (value: unknown) => T): Promise<Array<Stored<T> & { rowKey: string }>> {
    const rows = await this.table.list(proPartitionKey(userId), prefix);
    return rows.map((row) => ({ rowKey: row.rowKey, value: parse(JSON.parse(row.data) as unknown), etag: row.etag }));
  }

  due(rowKeys: string[], now: Date, limit: number): Promise<Array<{ partitionKey: string; rowKey: string }>> {
    return this.table.due(rowKeys, now.toISOString(), limit);
  }
}
