export type Mood = 'Happy' | 'Neutral' | 'Thinking' | 'Sad' | 'Excited';

export interface AuthenticatedPrincipal {
  subject: string;
  tier?: string;
  permissions: Set<string>;
}

export interface EphemeralMessageExcerpt {
  speaker: 'self' | 'match';
  sentAt: string;
  text: string;
}

export interface EphemeralMessageContext {
  excerpts: EphemeralMessageExcerpt[];
  historyTruncated: boolean;
  userConfirmed: boolean;
}

export interface ContextualChatInput {
  matchId?: string;
  message: string;
  includeProfile: boolean;
  includeMessageHistory: boolean;
  ephemeralMessageContext?: EphemeralMessageContext;
  contextRequestId?: string;
  persistSession: boolean;
  sessionId?: string;
}

export interface AiVisibleProfile {
  displayName?: string;
  pronouns?: string;
  bio?: string;
  interests?: string[];
  communicationPreferences?: string[];
  relationshipGoals?: string[];
}

export interface AiVisibleMatchContext {
  matchId: string;
  status: 'active';
  requestingUser: AiVisibleProfile;
  matchedUser: AiVisibleProfile;
  profileAllowed: boolean;
  messageHistoryAllowed: boolean;
  policyVersion: string;
}

export interface AdditionalContextRequest {
  searchTerms: string[];
  maxMessages: number;
  dateRange?: {
    from?: string;
    to?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string, maxLength = 256): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`Invalid ${key}`);
  }
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function parseContextualChatInput(
  value: unknown,
  maxCharacters: number,
  maxEphemeralMessages = 30,
  maxEphemeralCharacters = 12000,
): ContextualChatInput {
  if (!isRecord(value)) throw new Error('Invalid request body');
  const matchId = value.matchId === undefined ? undefined : requiredString(value, 'matchId', 256);
  const message = requiredString(value, 'message', maxCharacters).trim();
  if (message.length === 0) throw new Error('Invalid message');

  const options = isRecord(value.contextOptions) ? value.contextOptions : {};
  const includeProfile = options.includeProfile === undefined ? true : options.includeProfile === true;
  const includeMessageHistory = options.includeMessageHistory === undefined
    ? true
    : options.includeMessageHistory === true;

  let ephemeralMessageContext: EphemeralMessageContext | undefined;
  if (value.ephemeralMessageContext !== undefined) {
    if (!matchId || !includeMessageHistory || !isRecord(value.ephemeralMessageContext)) {
      throw new Error('Ephemeral message context requires an authorized match and message-history option');
    }
    const context = value.ephemeralMessageContext;
    if (!Array.isArray(context.excerpts)
      || context.excerpts.length < 1
      || context.excerpts.length > maxEphemeralMessages) {
      throw new Error('Invalid ephemeral excerpts');
    }
    if (context.historyTruncated !== undefined && typeof context.historyTruncated !== 'boolean') {
      throw new Error('Invalid historyTruncated');
    }
    if (context.userConfirmed !== undefined && typeof context.userConfirmed !== 'boolean') {
      throw new Error('Invalid userConfirmed');
    }
    let totalCharacters = 0;
    const excerpts = context.excerpts.map((candidate): EphemeralMessageExcerpt => {
      if (!isRecord(candidate) || (candidate.speaker !== 'self' && candidate.speaker !== 'match')) {
        throw new Error('Invalid excerpt speaker');
      }
      const sentAt = requiredString(candidate, 'sentAt', 64);
      const timestamp = Date.parse(sentAt);
      if (!Number.isFinite(timestamp) || timestamp > Date.now() + 300_000) {
        throw new Error('Invalid excerpt timestamp');
      }
      const text = requiredString(candidate, 'text', maxCharacters).trim();
      if (!text) throw new Error('Invalid excerpt text');
      totalCharacters += text.length;
      if (totalCharacters > maxEphemeralCharacters) throw new Error('Ephemeral context is too large');
      return { speaker: candidate.speaker, sentAt: new Date(timestamp).toISOString(), text };
    });
    ephemeralMessageContext = {
      excerpts,
      historyTruncated: context.historyTruncated === true,
      userConfirmed: context.userConfirmed === true,
    };
  }

  const contextRequestId = value.contextRequestId === undefined
    ? undefined
    : requiredString(value, 'contextRequestId', 64);
  if (contextRequestId && !isUuid(contextRequestId)) throw new Error('Invalid contextRequestId');

  const sessionOptions = isRecord(value.sessionOptions) ? value.sessionOptions : {};
  if (sessionOptions.persist !== undefined && typeof sessionOptions.persist !== 'boolean') {
    throw new Error('Invalid session persistence option');
  }
  if (sessionOptions.sessionId !== undefined
    && (typeof sessionOptions.sessionId !== 'string' || !isUuid(sessionOptions.sessionId))) {
    throw new Error('Invalid sessionId');
  }
  if (sessionOptions.sessionId !== undefined && sessionOptions.persist === false) {
    throw new Error('Cannot continue a session without persistence');
  }
  const persistSession = sessionOptions.persist === true || typeof sessionOptions.sessionId === 'string';

  return {
    ...(matchId ? { matchId } : {}),
    message,
    includeProfile,
    includeMessageHistory,
    ...(ephemeralMessageContext ? { ephemeralMessageContext } : {}),
    ...(contextRequestId ? { contextRequestId } : {}),
    persistSession,
    ...(typeof sessionOptions.sessionId === 'string' ? { sessionId: sessionOptions.sessionId } : {}),
  };
}
