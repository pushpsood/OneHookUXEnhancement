import type {
  AiContextMatch,
  AiContextPolicy,
  AiVisibleProfile,
  SubscriptionTier,
} from 'onehook-api-client';
import type {
  EphemeralMessageContext as WireEphemeralMessageContext,
  EphemeralMessageExcerpt,
  Mood,
} from './generated/mrOneHookModels';

// The API's own shapes are the generated MrOneHookService models (sdk/model/mr-onehook.smithy).
export type { EphemeralMessageExcerpt, Mood };

export interface AuthenticatedPrincipal {
  subject: string;
  /** The verified token's membership tier (missing/unknown = Must). Never from the client. */
  membership: SubscriptionTier;
  permissions: Set<string>;
}

/** A validated `ephemeralMessageContext`: the generated shape with its flags resolved (absent = false). */
export type EphemeralMessageContext = Required<WireEphemeralMessageContext>;

export interface ContextualChatInput {
  matchId?: string;
  message: string;
  includeProfile: boolean;
  includeMessageHistory: boolean;
  ephemeralMessageContext?: EphemeralMessageContext;
  contextRequestId?: string;
  persistSession: boolean;
  sessionId?: string;
  /** Attachment ids (UUIDs) to read for this turn, at most 3, without duplicates. */
  attachmentIds: string[];
}

/**
 * Profile fields that come from a member's MATCHING profile. State sends them only while BOTH members'
 * matching profiles are ACTIVE (chat-only profiles, design §8.6); otherwise a participant carries only
 * `displayName`. Every one of them is optional and is never filled in or guessed here.
 */
export const MATCHING_PROFILE_FIELDS = [
  'pronouns',
  'bio',
  'interests',
  'communicationPreferences',
  'relationshipGoals',
] as const;

export type MatchingProfileFields = Omit<AiVisibleProfile, 'displayName'>;

/**
 * What the AI may see about one participant: the chat-profile display name, plus optional matching
 * fields. The backend's `AiVisibleProfile` (onehook-api-client), as State returns it.
 */
export type { AiVisibleProfile };

/**
 * An authorized, active match as the prompt builder uses it: the backend's `AiContextMatch` with each
 * participant reduced to its visible profile and the context policy flattened in.
 */
export type AiVisibleMatchContext = Pick<AiContextMatch, 'matchId'> & AiContextPolicy & {
  status: 'active';
  requestingUser: AiVisibleProfile;
  matchedUser: AiVisibleProfile;
};

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

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** The user's turn when files are sent with no text. */
export const ATTACHMENTS_ONLY_MESSAGE = 'Please look at the attached files.';

export function parseContextualChatInput(
  value: unknown,
  maxCharacters: number,
  maxEphemeralMessages = 30,
  maxEphemeralCharacters = 12000,
  maxAttachments = 3,
): ContextualChatInput {
  if (!isRecord(value)) throw new Error('Invalid request body');
  const matchId = value.matchId === undefined ? undefined : requiredString(value, 'matchId', 256);
  // Required, but may be empty when files are attached (checked below, once attachmentIds is read).
  if (typeof value.message !== 'string' || value.message.length > maxCharacters) throw new Error('Invalid message');
  const typedMessage = value.message.trim();

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
  // Deprecated: at the plan's cap the least recently active session is always replaced. Still validated.
  if (sessionOptions.replaceLeastRecent !== undefined && typeof sessionOptions.replaceLeastRecent !== 'boolean') {
    throw new Error('Invalid replaceLeastRecent option');
  }
  let attachmentIds: string[] = [];
  if (value.attachmentIds !== undefined) {
    if (!Array.isArray(value.attachmentIds)
      || value.attachmentIds.length < 1
      || value.attachmentIds.length > maxAttachments
      || value.attachmentIds.some((id) => typeof id !== 'string' || !isUuid(id))) {
      throw new Error('Invalid attachmentIds');
    }
    attachmentIds = [...new Set((value.attachmentIds as string[]).map((id) => id.toLowerCase()))];
    if (attachmentIds.length !== value.attachmentIds.length) throw new Error('Duplicate attachmentIds');
  }
  // Files may be sent without text: the turn then asks Mr OneHook to look at them (saved and shown as such).
  if (typedMessage.length === 0 && attachmentIds.length === 0) throw new Error('Invalid message');
  const message = typedMessage || ATTACHMENTS_ONLY_MESSAGE;
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
    attachmentIds,
  };
}
