import { createHash } from 'node:crypto';
import type { ContainerClient } from '@azure/storage-blob';
import type { ChatSessionPlanPolicy } from './contextConfig';

import type {
  AttachmentKind,
  AttachmentSource,
  ChatAttachmentRef,
  ChatSessionDetail,
  ChatSessionMessage as WireChatSessionMessage,
  ChatSessionSummary,
  Mood,
} from './generated/mrOneHookModels';

/** Every `Mood` of the model; a stored mood outside it is dropped when read. */
const MOODS: ReadonlySet<string> = new Set<Mood>(['Happy', 'Neutral', 'Thinking', 'Sad', 'Excited']);
const ATTACHMENT_KINDS: ReadonlySet<string> = new Set<AttachmentKind>(['image', 'document', 'text', 'audio', 'video']);
const ATTACHMENT_SOURCES: ReadonlySet<string> = new Set<AttachmentSource>(['upload', 'match_chat']);

function parseAttachmentRefs(value: unknown): StoredAttachmentRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 3) throw new Error('Invalid session attachments');
  return value.map((candidate): StoredAttachmentRef => {
    if (!isRecord(candidate)
      || typeof candidate.name !== 'string' || candidate.name.length < 1 || candidate.name.length > 255
      || typeof candidate.kind !== 'string' || !ATTACHMENT_KINDS.has(candidate.kind)
      || typeof candidate.source !== 'string' || !ATTACHMENT_SOURCES.has(candidate.source)
      || (candidate.attachmentId !== undefined && (typeof candidate.attachmentId !== 'string' || !isUuid(candidate.attachmentId)))
      || (candidate.sizeBytes !== undefined && !Number.isSafeInteger(candidate.sizeBytes))
      || (candidate.excerpt !== undefined && (typeof candidate.excerpt !== 'string' || candidate.excerpt.length > 4000))) {
      throw new Error('Invalid session attachment');
    }
    return {
      name: candidate.name,
      kind: candidate.kind as AttachmentKind,
      source: candidate.source as AttachmentSource,
      ...(typeof candidate.attachmentId === 'string' ? { attachmentId: candidate.attachmentId } : {}),
      ...(typeof candidate.sizeBytes === 'number' ? { sizeBytes: candidate.sizeBytes } : {}),
      ...(typeof candidate.excerpt === 'string' ? { excerpt: candidate.excerpt } : {}),
    };
  });
}

/** The ids of the member's own uploads kept with a session (deleted with it). */
export function sessionAttachmentIds(session: ChatSession): string[] {
  return session.messages.flatMap((m) => (m.attachments ?? []).flatMap((a) => (a.attachmentId ? [a.attachmentId] : [])));
}

// The stored session is the API's `ChatSessionDetail` plus storage-only fields; the summary is the
// API's `ChatSessionSummary` (mr-onehook.smithy).
export type { ChatSessionSummary };

/**
 * A file sent with a stored user turn: the API's `ChatAttachmentRef` plus, for the member's own uploads, a
 * short excerpt of its extracted content so later turns still know what it said. Match-chat files have
 * neither an id nor an excerpt: their content is never stored.
 */
export type StoredAttachmentRef = ChatAttachmentRef & { excerpt?: string };

/** A stored turn: the API's `ChatSessionMessage` plus the exchange it belongs to (idempotency). */
export type ChatSessionMessage = Omit<WireChatSessionMessage, 'attachments'> & {
  exchangeId: string;
  attachments?: StoredAttachmentRef[];
};

/**
 * A stored session: the API's `ChatSessionDetail` with stored turns. `scope` and `messageCount` are not
 * stored: the route derives them (from `matchId` and from the window of turns it returns).
 */
export type ChatSession = Omit<ChatSessionDetail, 'messages' | 'scope' | 'messageCount'> & { messages: ChatSessionMessage[] };

interface SessionRecord {
  schemaVersion: 1;
  userRef: string;
  sessionRef: string;
  scopeRef: string;
  revision: number;
  session: ChatSession;
}

interface ExistingSession {
  record: SessionRecord;
  etag?: string;
}

interface SessionQuotaIndex {
  schemaVersion: 1;
  userRef: string;
  sessions: Record<string, string>;
}

interface ExistingSessionQuotaIndex {
  value: SessionQuotaIndex;
  etag?: string;
}

export class ChatSessionAccessError extends Error {}
export class ChatSessionLimitError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function stableReference(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

export function sessionScopeReference(matchId?: string): string {
  return stableReference(matchId ? `match:${matchId}` : 'product');
}

function parseSession(value: unknown): ChatSession {
  if (!isRecord(value)
    || typeof value.sessionId !== 'string'
    || !isUuid(value.sessionId)
    || (value.matchId !== undefined
      && (typeof value.matchId !== 'string' || value.matchId.length < 1 || value.matchId.length > 256))
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || typeof value.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt))
    || !Number.isFinite(Date.parse(value.updatedAt))
    || !Number.isFinite(Date.parse(value.expiresAt))
    || !Array.isArray(value.messages)
    || value.messages.length > 200) {
    throw new Error('Invalid plaintext chat session');
  }
  const messages: ChatSessionMessage[] = value.messages.map((candidate) => {
    if (!isRecord(candidate)
      || (candidate.role !== 'user' && candidate.role !== 'assistant')
      || typeof candidate.content !== 'string'
      || candidate.content.length < 1
      || candidate.content.length > 16000
      || typeof candidate.createdAt !== 'string'
      || !Number.isFinite(Date.parse(candidate.createdAt))
      || typeof candidate.exchangeId !== 'string'
      || candidate.exchangeId.length < 1
      || candidate.exchangeId.length > 128) {
      throw new Error('Invalid plaintext session message');
    }
    const mood = candidate.role === 'assistant' && typeof candidate.mood === 'string' && MOODS.has(candidate.mood)
      ? { mood: candidate.mood as Mood }
      : {};
    const attachments = candidate.role === 'user' ? parseAttachmentRefs(candidate.attachments) : undefined;
    return {
      role: candidate.role,
      content: candidate.content,
      createdAt: new Date(candidate.createdAt).toISOString(),
      exchangeId: candidate.exchangeId,
      ...mood,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
  });
  return {
    sessionId: value.sessionId,
    ...(typeof value.matchId === 'string' ? { matchId: value.matchId } : {}),
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
    expiresAt: new Date(value.expiresAt).toISOString(),
    messages,
  };
}

function parseSessionRecord(value: unknown): SessionRecord {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.userRef !== 'string'
    || typeof value.sessionRef !== 'string'
    || typeof value.scopeRef !== 'string'
    || !Number.isSafeInteger(value.revision)) {
    throw new Error('Invalid plaintext session record');
  }
  return {
    schemaVersion: 1,
    userRef: value.userRef,
    sessionRef: value.sessionRef,
    scopeRef: value.scopeRef,
    revision: value.revision as number,
    session: parseSession(value.session),
  };
}

function parseSessionQuotaIndex(value: unknown): SessionQuotaIndex {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.userRef !== 'string'
    || !isRecord(value.sessions)) {
    throw new Error('Invalid session quota index');
  }
  const sessions: Record<string, string> = {};
  const entries = Object.entries(value.sessions);
  if (entries.length > 500) throw new Error('Session quota index limit exceeded');
  for (const [sessionRef, expiresAt] of entries) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionRef)
      || typeof expiresAt !== 'string'
      || !Number.isFinite(Date.parse(expiresAt))) {
      throw new Error('Invalid session quota entry');
    }
    sessions[sessionRef] = expiresAt;
  }
  return { schemaVersion: 1, userRef: value.userRef, sessions };
}

export interface ChatSessionStoreOptions {
  /** Called with the member's uploaded files of a session that is deleted or expires (best effort). */
  onSessionDeleted?: (subject: string, attachmentIds: string[]) => Promise<void>;
}

export class PlaintextChatSessionStore {
  constructor(private readonly container: ContainerClient, private readonly options: ChatSessionStoreOptions = {}) {}

  private async sessionDeleted(subject: string, session: ChatSession): Promise<void> {
    const ids = sessionAttachmentIds(session);
    if (ids.length === 0 || !this.options.onSessionDeleted) return;
    await this.options.onSessionDeleted(subject, ids).catch(() => undefined);
  }

  private sessionBlobName(subject: string, sessionId: string): string {
    if (!isUuid(sessionId)) throw new ChatSessionAccessError('Invalid session ID');
    return `sessions/${stableReference(subject)}/${stableReference(sessionId)}.json`;
  }

  private quotaBlobName(subject: string): string {
    return `session-quotas/${stableReference(subject)}.json`;
  }

  private async readQuotaIndex(subject: string): Promise<ExistingSessionQuotaIndex | undefined> {
    const blob = this.container.getBlockBlobClient(this.quotaBlobName(subject));
    if (!(await blob.exists())) return undefined;
    const [bytes, properties] = await Promise.all([blob.downloadToBuffer(), blob.getProperties()]);
    const value = parseSessionQuotaIndex(JSON.parse(bytes.toString('utf8')) as unknown);
    if (value.userRef !== stableReference(subject)) throw new ChatSessionAccessError('Quota user binding mismatch');
    return { value, ...(properties.etag ? { etag: properties.etag } : {}) };
  }

  private async mutateQuotaIndex(subject: string, mutate: (index: SessionQuotaIndex) => void): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const existing = await this.readQuotaIndex(subject);
      const userRef = stableReference(subject);
      const value: SessionQuotaIndex = existing
        ? { ...existing.value, sessions: { ...existing.value.sessions } }
        : { schemaVersion: 1, userRef, sessions: {} };
      for (const [sessionRef, expiresAt] of Object.entries(value.sessions)) {
        if (Date.parse(expiresAt) <= Date.now()) delete value.sessions[sessionRef];
      }
      mutate(value);
      try {
        await this.container.getBlockBlobClient(this.quotaBlobName(subject)).uploadData(
          Buffer.from(JSON.stringify(value), 'utf8'),
          {
            blobHTTPHeaders: { blobContentType: 'application/json' },
            metadata: { schema: '1', kind: 'chat-session-quota' },
            conditions: existing?.etag ? { ifMatch: existing.etag } : { ifNoneMatch: '*' },
          },
        );
        return;
      } catch (error: unknown) {
        const status = typeof error === 'object' && error !== null && 'statusCode' in error
          ? Number((error as { statusCode: unknown }).statusCode)
          : 0;
        if (status !== 412 || attempt === 4) throw error;
      }
    }
  }

  private async reserveSession(
    subject: string,
    sessionId: string,
    expiresAt: string,
    maxSessions: number,
  ): Promise<void> {
    const sessionRef = stableReference(sessionId);
    await this.mutateQuotaIndex(subject, (index) => {
      if (!Object.prototype.hasOwnProperty.call(index.sessions, sessionRef)
        && Object.keys(index.sessions).length >= maxSessions) {
        throw new ChatSessionLimitError('Tier session limit reached');
      }
      index.sessions[sessionRef] = expiresAt;
    });
  }

  private async releaseSession(subject: string, sessionId: string): Promise<void> {
    const sessionRef = stableReference(sessionId);
    await this.mutateQuotaIndex(subject, (index) => {
      delete index.sessions[sessionRef];
    });
  }

  private async readExisting(subject: string, sessionId: string): Promise<ExistingSession | undefined> {
    const blob = this.container.getBlockBlobClient(this.sessionBlobName(subject, sessionId));
    if (!(await blob.exists())) return undefined;
    const [bytes, properties] = await Promise.all([blob.downloadToBuffer(), blob.getProperties()]);
    const record = parseSessionRecord(JSON.parse(bytes.toString('utf8')) as unknown);
    if (record.userRef !== stableReference(subject)
      || record.sessionRef !== stableReference(sessionId)
      || record.session.sessionId !== sessionId
      || record.scopeRef !== sessionScopeReference(record.session.matchId)) {
      throw new ChatSessionAccessError('Session binding mismatch');
    }
    if (Date.parse(record.session.expiresAt) <= Date.now()) {
      await this.sessionDeleted(subject, record.session);
      await blob.deleteIfExists();
      return undefined;
    }
    return { record, ...(properties.etag ? { etag: properties.etag } : {}) };
  }

  private async listExisting(subject: string): Promise<ExistingSession[]> {
    const prefix = `sessions/${stableReference(subject)}/`;
    const sessions: ExistingSession[] = [];
    let scanned = 0;
    for await (const blobItem of this.container.listBlobsFlat({ prefix })) {
      scanned += 1;
      if (scanned > 500) throw new Error('Session scan limit exceeded');
      const blob = this.container.getBlockBlobClient(blobItem.name);
      const [bytes, properties] = await Promise.all([blob.downloadToBuffer(), blob.getProperties()]);
      const record = parseSessionRecord(JSON.parse(bytes.toString('utf8')) as unknown);
      if (record.userRef !== stableReference(subject)
        || record.sessionRef !== stableReference(record.session.sessionId)
        || record.scopeRef !== sessionScopeReference(record.session.matchId)) {
        throw new ChatSessionAccessError('Session binding mismatch');
      }
      if (Date.parse(record.session.expiresAt) <= Date.now()) {
        await this.sessionDeleted(subject, record.session);
        await blob.deleteIfExists().catch(() => undefined);
        continue;
      }
      sessions.push({ record, ...(properties.etag ? { etag: properties.etag } : {}) });
    }
    return sessions;
  }

  async list(subject: string): Promise<ChatSessionSummary[]> {
    return (await this.listExisting(subject))
      .map(({ record }) => ({
        sessionId: record.session.sessionId,
        scope: record.session.matchId ? 'connection' as const : 'product' as const,
        createdAt: record.session.createdAt,
        updatedAt: record.session.updatedAt,
        expiresAt: record.session.expiresAt,
        messageCount: record.session.messages.length,
      }))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  async get(subject: string, sessionId: string): Promise<ChatSession | undefined> {
    return (await this.readExisting(subject, sessionId))?.record.session;
  }

  /** Deletes the session, its uploaded files and its index entry. Idempotent. */
  async delete(subject: string, sessionId: string): Promise<void> {
    const existing = await this.readExisting(subject, sessionId).catch((error: unknown) => {
      if (error instanceof ChatSessionAccessError) throw error;
      return undefined;
    });
    if (existing) await this.sessionDeleted(subject, existing.record.session);
    await this.container.getBlockBlobClient(this.sessionBlobName(subject, sessionId)).deleteIfExists();
    await this.releaseSession(subject, sessionId);
  }

  /**
   * Account deletion: removes every blob this store keeps for the member, i.e. all session records under
   * `sessions/<hash(subject)>/` and the `session-quotas/<hash(subject)>.json` index. Blob names are
   * derived with the same {@link stableReference} hash as every other path, so nothing else is needed.
   * Idempotent; deleting what is already gone is a no-op. A session written while erasure runs (a token
   * still valid for a few minutes) is caught by re-listing until the prefix is empty. Throws on any
   * storage failure so the caller can retry. Returns the number of blobs removed.
   */
  async eraseUser(subject: string): Promise<number> {
    const userRef = stableReference(subject);
    const prefix = `sessions/${userRef}/`;
    let removed = 0;
    const list = async (): Promise<string[]> => {
      const names: string[] = [];
      for await (const blobItem of this.container.listBlobsFlat({ prefix })) names.push(blobItem.name);
      return names;
    };
    for (let pass = 0; pass < 3; pass += 1) {
      const names = await list();
      for (const name of names) {
        if ((await this.container.getBlockBlobClient(name).deleteIfExists()).succeeded) removed += 1;
      }
      if ((await this.container.getBlockBlobClient(this.quotaBlobName(subject)).deleteIfExists()).succeeded) {
        removed += 1;
      }
      if (names.length === 0) return removed;
    }
    if ((await list()).length > 0) throw new Error('Session blobs reappeared during erasure');
    return removed;
  }

  async appendExchange(input: {
    subject: string;
    matchId?: string;
    sessionId?: string;
    exchangeId: string;
    userMessage: string;
    assistantMessage: string;
    /** The mood of the assistant turn, stored with it so a reopened session shows it. */
    assistantMood?: Mood;
    /** Files sent with the user turn. */
    userAttachments?: StoredAttachmentRef[];
    policy: ChatSessionPlanPolicy;
  }): Promise<ChatSession> {
    const sessionId = input.sessionId ?? input.exchangeId;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let reservationUpdated = false;
      try {
        const existing = await this.readExisting(input.subject, sessionId);
        if (existing) {
          if (existing.record.session.matchId !== input.matchId) {
            throw new ChatSessionAccessError('Session belongs to another scope');
          }
          if (existing.record.session.messages.some((message) => message.exchangeId === input.exchangeId)) {
            return existing.record.session;
          }
        }

        const now = new Date().toISOString();
        const createdAt = existing?.record.session.createdAt ?? now;
        const expiresAt = new Date(Date.now() + input.policy.retentionDays * 86_400_000).toISOString();
        await this.reserveSession(input.subject, sessionId, expiresAt, input.policy.maxSessions);
        reservationUpdated = true;
        const effectiveMaxMessages = input.policy.maxMessages - (input.policy.maxMessages % 2);
        const messages: ChatSessionMessage[] = [
          ...(existing?.record.session.messages ?? []),
          {
            role: 'user' as const,
            content: input.userMessage,
            createdAt: now,
            exchangeId: input.exchangeId,
            ...(input.userAttachments && input.userAttachments.length > 0 ? { attachments: input.userAttachments } : {}),
          },
          {
            role: 'assistant' as const,
            content: input.assistantMessage,
            createdAt: now,
            exchangeId: input.exchangeId,
            ...(input.assistantMood ? { mood: input.assistantMood } : {}),
          },
        ];
        // Turns that fall out of the window take their uploaded files with them (after the write below).
        const dropped = messages.slice(0, Math.max(0, messages.length - effectiveMaxMessages));
        messages.splice(0, dropped.length);
        const session: ChatSession = {
          sessionId,
          ...(input.matchId ? { matchId: input.matchId } : {}),
          createdAt,
          updatedAt: now,
          expiresAt,
          messages,
        };
        const record: SessionRecord = {
          schemaVersion: 1,
          userRef: stableReference(input.subject),
          sessionRef: stableReference(sessionId),
          scopeRef: sessionScopeReference(input.matchId),
          revision: (existing?.record.revision ?? 0) + 1,
          session,
        };
        await this.container.getBlockBlobClient(this.sessionBlobName(input.subject, sessionId)).uploadData(
          Buffer.from(JSON.stringify(record), 'utf8'),
          {
            blobHTTPHeaders: { blobContentType: 'application/json' },
            metadata: { schema: '1', revision: String(record.revision), kind: 'chat-session-plaintext' },
            conditions: existing?.etag ? { ifMatch: existing.etag } : { ifNoneMatch: '*' },
          },
        );
        if (dropped.length > 0) await this.sessionDeleted(input.subject, { ...session, messages: dropped });
        return session;
      } catch (error: unknown) {
        const status = typeof error === 'object' && error !== null && 'statusCode' in error
          ? Number((error as { statusCode: unknown }).statusCode)
          : 0;
        if (status !== 412) {
          if (reservationUpdated) {
            const sessionExists = await this.container
              .getBlockBlobClient(this.sessionBlobName(input.subject, sessionId))
              .exists()
              .catch(() => true);
            if (!sessionExists) await this.releaseSession(input.subject, sessionId).catch(() => undefined);
          }
          throw error;
        }
        if (attempt === 2) throw error;
      }
    }
    throw new Error('Session concurrency retry exhausted');
  }
}
