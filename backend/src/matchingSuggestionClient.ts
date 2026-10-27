/**
 * Records a OneHook suggestion in the OneHook Matching service (AWS) on the member's behalf.
 *
 * When a member asks Mr OneHook to find someone, the model returns a `matchSuggestion` (its analysis of
 * who the member is looking for, plus a short user-facing reasoning). This client sends it to
 * `POST {ONEHOOK_API_URL}/matching/suggestions`. Matching embeds the prompt and, from then on, mixes
 * people who fit it into the member's discover feed as "Mr. OneHook" cards carrying the reasoning.
 * Nothing about candidates comes back here.
 *
 * The call carries the member's own Cognito token (the same one this service just verified), so Matching
 * applies its normal per-member checks, including the Super+ tier gate. The prompt is never logged.
 */

export type SuggestionStatus = 'RECORDED' | 'PREMIUM_REQUIRED' | 'UNAVAILABLE';

export interface MatchSuggestion {
  prompt: string;
  reasoning: string;
}

export interface SuggestionRecorder {
  record(memberBearerToken: string, suggestion: MatchSuggestion): Promise<SuggestionStatus>;
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
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async record(memberBearerToken: string, suggestion: MatchSuggestion): Promise<SuggestionStatus> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/matching/suggestions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${memberBearerToken}`,
        },
        body: JSON.stringify(suggestion),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return 'UNAVAILABLE';
    }
    if (response.status === 200 || response.status === 201) return 'RECORDED';
    if (response.status === 403) {
      // PREMIUM_REQUIRED is the only 403 Matching returns for this route.
      return 'PREMIUM_REQUIRED';
    }
    return 'UNAVAILABLE';
  }
}

/** Used when ONEHOOK_API_URL is not configured: nothing is recorded. */
export const disabledSuggestionRecorder: SuggestionRecorder = {
  record: async () => 'UNAVAILABLE',
};
