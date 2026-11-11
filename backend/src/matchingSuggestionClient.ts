import type { RequestSigner } from './oneHookDataClient';
import type { MatchingStatusReader } from './matchingStatusClient';

/**
 * Records a member's OneHook suggestion in the OneHook Matching service (AWS).
 *
 * When a member asks Mr OneHook to find someone, the model returns a `matchSuggestion` (its analysis of
 * who the member is looking for, plus a short user-facing reasoning). This client sends it to Matching's
 * IAM-only route `POST {ONEHOOK_MATCHING_API_URL}/matching/internal/suggestions`, with two proofs:
 *  - SigV4 with this service's federated AWS role (OneHook-MrOneHook-<stage>-Role): the caller is Mr OneHook;
 *  - the member's own Cognito ID token in `X-OneHook-Member-Token` (part of the signed headers): Matching
 *    verifies it and takes the member id and tier ONLY from it.
 * So this service can only record a suggestion for a member who is in a live session with it, never name
 * a member itself. The member's suggestion is replaced by a newer one; Matching enforces Super+.
 *
 * A suggestion is matching data about exactly one member, the one whose token it carries. Before sending
 * it, the client reads that member's matching mode from State and records only when it is ON (chat-only
 * profiles, design §8.6). OFF, ERASING and an unknown member are `MATCHING_OFF`; a failed status read is
 * `UNAVAILABLE` and nothing is sent (fail closed).
 * The prompt is never logged.
 */

export type SuggestionStatus = 'RECORDED' | 'PREMIUM_REQUIRED' | 'MATCHING_OFF' | 'UNAVAILABLE';

export interface MatchSuggestion {
  prompt: string;
  reasoning: string;
}

/** The member a suggestion is for, as verified from their own token. */
export interface SuggestionMember {
  /** Verified token subject (the OneHook user id); used for the matching-status check. */
  userId: string;
  /** The member's verified Cognito ID token (proof of their session); Matching derives the member from it. */
  idToken: string;
}

export interface SuggestionRecorder {
  record(member: SuggestionMember, suggestion: MatchSuggestion): Promise<SuggestionStatus>;
}

export const SUGGESTION_PROMPT_MIN = 3;
export const SUGGESTION_PROMPT_MAX = 1000;
export const SUGGESTION_REASONING_MAX = 280;

/** Bounds and cleans a model-produced suggestion; null when unusable. */
export function sanitizeMatchSuggestion(value: unknown): MatchSuggestion | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const clean = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string') return null;
    // eslint-disable-next-line no-control-regex
    const text = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return text.length > max ? text.slice(0, max).trim() : text;
  };
  const prompt = clean(record.prompt, SUGGESTION_PROMPT_MAX);
  const reasoning = clean(record.reasoning, SUGGESTION_REASONING_MAX);
  if (!prompt || prompt.length < SUGGESTION_PROMPT_MIN || !reasoning) return null;
  return { prompt, reasoning };
}

export class MatchingSuggestionClient implements SuggestionRecorder {
  constructor(
    private readonly baseUrl: string,
    private readonly signer: RequestSigner,
    private readonly timeoutMs: number,
    private readonly matchingStatus: MatchingStatusReader,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async record(member: SuggestionMember, suggestion: MatchSuggestion): Promise<SuggestionStatus> {
    if (!member.idToken || !member.userId) return 'UNAVAILABLE';
    try {
      const { status } = await this.matchingStatus.get(member.userId);
      if (status !== 'ON') return 'MATCHING_OFF';
    } catch {
      // Could not confirm matching is ON: record nothing.
      return 'UNAVAILABLE';
    }
    const url = new URL(`${this.baseUrl}/matching/internal/suggestions`);
    const body = JSON.stringify(suggestion);
    let response: Response;
    try {
      const headers = await this.signer.sign({
        method: 'POST',
        url,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-onehook-member-token': member.idToken,
        },
        body,
      });
      response = await this.fetchImpl(url.toString(), {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Signing (no AWS credentials) or network failure: nothing recorded.
      return 'UNAVAILABLE';
    }
    if (response.status === 200 || response.status === 201) return 'RECORDED';
    if (response.status === 403) {
      // 403 is PREMIUM_REQUIRED (tier gate), MATCHING_OFF (Matching holds no row for the member, e.g. an
      // opt-out raced the status read) or an IAM denial; only the first two carry a code. OneHook errors are
      // `{error: <human message>, code: <MACHINE_CODE>}`: the code is `code`, never `error`.
      const code = await response.json().then((b: unknown) => (b as { code?: unknown })?.code).catch(() => undefined);
      if (code === 'PREMIUM_REQUIRED') return 'PREMIUM_REQUIRED';
      if (code === 'MATCHING_OFF') return 'MATCHING_OFF';
      return 'UNAVAILABLE';
    }
    return 'UNAVAILABLE';
  }
}

/** Used when ONEHOOK_MATCHING_API_URL is not configured: nothing is recorded. */
export const disabledSuggestionRecorder: SuggestionRecorder = {
  record: async () => 'UNAVAILABLE',
};
