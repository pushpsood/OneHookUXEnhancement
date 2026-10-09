import { createHash } from 'node:crypto';
import type { ContainerClient } from '@azure/storage-blob';
import type { ChatSessionTierPolicy } from './contextConfig';

export interface ChatSessionMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  exchangeId: string;
}

export interface ChatSession {
  sessionId: string;
  matchId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  messages: ChatSessionMessage[];
}

export interface ChatSessionSummary {
  sessionId: string;
  scope: 'product' | 'connection';
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  messageCount: number;
}

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
    return {
      role: candidate.role,
      content: candidate.content,
      createdAt: new Date(candidate.createdAt).toISOString(),
      exchangeId: candidate.exchangeId,
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

export class PlaintextChatSessionStore {
  constructor(private readonly container: ContainerClient) {}

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

  async delete(subject: string, sessionId: string): Promise<void> {
    await this.container.getBlockBlobClient(this.sessionBlobName(subject, sessionId)).deleteIfExists();
    await this.releaseSession(subject, sessionId);
  }

  async appendExchange(input: {
    subject: string;
    matchId?: string;
    sessionId?: string;
    exchangeId: string;
    userMessage: string;
    assistantMessage: string;
    policy: ChatSessionTierPolicy;
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
        const messages = [
          ...(existing?.record.session.messages ?? []),
          { role: 'user' as const, content: input.userMessage, createdAt: now, exchangeId: input.exchangeId },
          { role: 'assistant' as const, content: input.assistantMessage, createdAt: now, exchangeId: input.exchangeId },
        ].slice(-effectiveMaxMessages);
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
