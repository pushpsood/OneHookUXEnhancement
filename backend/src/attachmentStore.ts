import type { ContainerClient } from '@azure/storage-blob';
import type {
  AttachmentFailureReason,
  AttachmentKind,
  AttachmentSource,
  AttachmentStatus,
  ChatAttachment,
  ExcerptSpeaker,
} from './generated/mrOneHookModels';
import { isUuid } from './contextTypes';
import { stableReference } from './plaintextChatSessionStore';

/**
 * Attachments in the private `aisessions` container, next to the sessions, under three prefixes:
 *
 *   attachments/pending/<hash(user)>/<hash(id)>.{json,bin}    uploaded, not yet sent (lifecycle: 1 day)
 *   attachments/ephemeral/<hash(user)>/<hash(id)>.{json,bin}  from a match chat: one turn only, then deleted
 *                                                            (lifecycle: 1 day)
 *   attachments/saved/<hash(user)>/<hash(id)>.{json,bin}      sent in a saved session; deleted with it
 *
 * `.bin` holds the bytes, `.json` the record (status, type, extracted text). Names are hashed like the
 * session blobs, so nothing about the member or the file is in a blob name. Record writes are
 * ETag-conditional. Match-chat files are never copied to `saved/`: their content is used for one model
 * request and discarded, like message excerpts.
 */
export type AttachmentPlace = 'pending' | 'ephemeral' | 'saved';

export interface AttachmentRecord {
  schemaVersion: 1;
  attachmentId: string;
  userRef: string;
  name: string;
  kind: AttachmentKind;
  mediaType: string;
  /** How the processor reads it (from detection). */
  reader: 'vision' | 'document' | 'text' | 'transcription' | 'video';
  extension: string;
  sizeBytes: number;
  source: AttachmentSource;
  sender?: ExcerptSpeaker;
  /** Match-chat files: the match they came from (the turn must be about the same match). */
  matchId?: string;
  status: AttachmentStatus;
  failureReason?: AttachmentFailureReason;
  place: AttachmentPlace;
  /** Saved files: the session they belong to. */
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  /** The allowance reservation made at upload, settled once when processing ends. */
  usage: { month: string; reservedMilli: number; settled: boolean; budgetMinor: number };
  costMilli?: number;
  extracted?: { text: string; truncated: boolean };
  /** Processing owner: another instance may take over after this. */
  leaseUntil?: string;
}

export interface StoredAttachment {
  record: AttachmentRecord;
  etag: string;
}

export class AttachmentAccessError extends Error {}

const PLACES: readonly AttachmentPlace[] = ['pending', 'ephemeral', 'saved'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown): AttachmentRecord {
  if (!isRecord(value) || value.schemaVersion !== 1
    || typeof value.attachmentId !== 'string' || typeof value.userRef !== 'string'
    || typeof value.name !== 'string' || typeof value.kind !== 'string' || typeof value.mediaType !== 'string'
    || typeof value.status !== 'string' || typeof value.place !== 'string' || !isRecord(value.usage)
    || !Number.isSafeInteger(value.sizeBytes)) {
    throw new Error('Invalid attachment record');
  }
  return value as unknown as AttachmentRecord;
}

function statusOf(error: unknown): number {
  return typeof error === 'object' && error !== null && 'statusCode' in error
    ? Number((error as { statusCode: unknown }).statusCode)
    : 0;
}

/** The API view of a record (`ChatAttachment`). */
export function toChatAttachment(record: AttachmentRecord): ChatAttachment {
  return {
    attachmentId: record.attachmentId,
    name: record.name,
    kind: record.kind,
    mediaType: record.mediaType,
    sizeBytes: record.sizeBytes,
    status: record.status,
    source: record.source,
    ...(record.sender ? { sender: record.sender } : {}),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(record.status === 'FAILED' && record.failureReason ? { failureReason: record.failureReason } : {}),
  };
}

export class AttachmentStore {
  constructor(private readonly container: ContainerClient, private readonly now: () => Date = () => new Date()) {}

  private base(place: AttachmentPlace, subject: string, attachmentId: string): string {
    if (!isUuid(attachmentId)) throw new AttachmentAccessError('Invalid attachment ID');
    return `attachments/${place}/${stableReference(subject)}/${stableReference(attachmentId.toLowerCase())}`;
  }

  /** Writes the bytes, then the record (insert-only). */
  async create(subject: string, record: AttachmentRecord, bytes: Uint8Array): Promise<StoredAttachment> {
    const base = this.base(record.place, subject, record.attachmentId);
    await this.container.getBlockBlobClient(`${base}.bin`).uploadData(bytes, {
      blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
      metadata: { schema: '1', kind: 'chat-attachment-content' },
      conditions: { ifNoneMatch: '*' },
    });
    const etag = await this.writeRecord(base, record, undefined);
    return { record, etag };
  }

  private async writeRecord(base: string, record: AttachmentRecord, etag: string | undefined): Promise<string> {
    const result = await this.container.getBlockBlobClient(`${base}.json`).uploadData(
      Buffer.from(JSON.stringify(record), 'utf8'),
      {
        blobHTTPHeaders: { blobContentType: 'application/json' },
        metadata: { schema: '1', kind: 'chat-attachment' },
        conditions: etag ? { ifMatch: etag } : { ifNoneMatch: '*' },
      },
    );
    return result.etag ?? '';
  }

  private async readAt(place: AttachmentPlace, subject: string, attachmentId: string): Promise<StoredAttachment | undefined> {
    const blob = this.container.getBlockBlobClient(`${this.base(place, subject, attachmentId)}.json`);
    let bytes: Buffer;
    let etag: string;
    try {
      const [content, properties] = await Promise.all([blob.downloadToBuffer(), blob.getProperties()]);
      bytes = content;
      etag = properties.etag ?? '';
    } catch (error) {
      if (statusOf(error) === 404) return undefined;
      throw error;
    }
    const record = parseRecord(JSON.parse(bytes.toString('utf8')) as unknown);
    if (record.userRef !== stableReference(subject) || record.attachmentId !== attachmentId.toLowerCase() || record.place !== place) {
      throw new AttachmentAccessError('Attachment binding mismatch');
    }
    return { record, etag };
  }

  /** The member's attachment wherever it is; expired ones read as absent (and are removed). */
  async get(subject: string, attachmentId: string): Promise<StoredAttachment | undefined> {
    for (const place of PLACES) {
      const found = await this.readAt(place, subject, attachmentId);
      if (!found) continue;
      if (Date.parse(found.record.expiresAt) <= this.now().getTime()) {
        await this.deleteAt(place, subject, attachmentId).catch(() => undefined);
        return undefined;
      }
      return found;
    }
    return undefined;
  }

  /** Replaces the record on its ETag. Throws a 412 storage error when it changed. */
  async update(subject: string, stored: StoredAttachment, next: AttachmentRecord): Promise<StoredAttachment> {
    const etag = await this.writeRecord(this.base(next.place, subject, next.attachmentId), next, stored.etag);
    return { record: next, etag };
  }

  async content(subject: string, record: AttachmentRecord): Promise<Buffer> {
    return this.container.getBlockBlobClient(`${this.base(record.place, subject, record.attachmentId)}.bin`).downloadToBuffer();
  }

  /** Moves a sent upload into `saved/` for its session (copy, then delete the pending blobs). */
  async save(subject: string, stored: StoredAttachment, sessionId: string, expiresAt: string): Promise<void> {
    const bytes = await this.content(subject, stored.record);
    const record: AttachmentRecord = {
      ...stored.record, place: 'saved', sessionId, expiresAt, updatedAt: this.now().toISOString(),
    };
    const base = this.base('saved', subject, record.attachmentId);
    await this.container.getBlockBlobClient(`${base}.bin`).uploadData(bytes, {
      blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
      metadata: { schema: '1', kind: 'chat-attachment-content' },
    });
    await this.container.getBlockBlobClient(`${base}.json`).uploadData(Buffer.from(JSON.stringify(record), 'utf8'), {
      blobHTTPHeaders: { blobContentType: 'application/json' },
      metadata: { schema: '1', kind: 'chat-attachment' },
    });
    await this.deleteAt(stored.record.place, subject, record.attachmentId);
  }

  private async deleteAt(place: AttachmentPlace, subject: string, attachmentId: string): Promise<void> {
    const base = this.base(place, subject, attachmentId);
    await this.container.getBlockBlobClient(`${base}.json`).deleteIfExists();
    await this.container.getBlockBlobClient(`${base}.bin`).deleteIfExists();
  }

  /** Deletes the attachment everywhere. Idempotent. */
  async delete(subject: string, attachmentId: string): Promise<void> {
    if (!isUuid(attachmentId)) return;
    for (const place of PLACES) await this.deleteAt(place, subject, attachmentId);
  }

  /** Account deletion: every attachment blob of the member, re-listing until empty. Returns the count. */
  async eraseUser(subject: string): Promise<number> {
    const userRef = stableReference(subject);
    let removed = 0;
    for (const place of PLACES) {
      const prefix = `attachments/${place}/${userRef}/`;
      for (let pass = 0; pass < 3; pass += 1) {
        const names: string[] = [];
        for await (const item of this.container.listBlobsFlat({ prefix })) names.push(item.name);
        if (names.length === 0) break;
        for (const name of names) {
          if ((await this.container.getBlockBlobClient(name).deleteIfExists()).succeeded) removed += 1;
        }
      }
      for await (const _item of this.container.listBlobsFlat({ prefix })) throw new Error('Attachment blobs reappeared during erasure');
    }
    return removed;
  }
}
