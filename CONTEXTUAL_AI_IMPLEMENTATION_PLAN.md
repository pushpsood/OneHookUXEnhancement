# Mr OneHook Product, Connection Context, and Session Plan

**Status:** Implemented across backend, Terraform, sibling iOS/Android clients, and the sibling web client; production activation remains pending
**Approved boundary:** Match-to-match messages remain end-to-end encrypted on user devices and are never mirrored by UX Enhancement. Mr OneHook AI sessions may be application-readable in private Azure Storage according to verified Cognito tier policy.

## 1. Objectives

- Keep anonymous product chat separate from authenticated member chat.
- Let authenticated members ask product questions without selecting a match.
- Add authorized profile/match context when `matchId` is supplied.
- Let the app decrypt and search its own match history locally.
- Send only bounded, optionally user-confirmed excerpts for one model request.
- Never persist or log app-supplied match excerpts in UX Enhancement.
- Ask the app for a bounded local retry when the first context is insufficient.
- Persist only user ↔ Mr OneHook AI turns when explicitly requested and allowed by the current Cognito tier.

## 2. Data boundaries

| Data class | Source of truth | UX persistence | Azure OpenAI use |
|---|---|---|---|
| Product context | `codecontext/CRUX.md` | Static private Blob | Included for public and member product questions |
| Identity and tier | Verified Cognito access token | Not stored as raw claims | Used for authorization and tier policy only |
| Match/profile policy | Authoritative OneHook data API | Not persisted by UX | Included only after fresh authorization and allowlisting |
| Match messages | End-to-end encrypted client store | **Never persisted by UX** | Client-selected excerpts used only in request memory |
| Mr OneHook AI turns | UX session service | Application-readable JSON in private `aisessions` Blob container | Bounded prior turns included on continuation |
| Quota metadata | UX session service | Hashed user/session references | Never sent to the model |

Azure Storage platform encryption still applies to all Blob data. “Application-readable” means AI session records have no additional application AES/Key Vault layer. Match messages never enter Blob Storage.

## 3. API surfaces

### Public product chat

`POST /api/public/product-chat`

- No authentication.
- Product questions only.
- Reads static product context.
- Cannot access match, profile, message, or AI-session data.

### Member product and connection chat

`POST /api/member/product-connection-chat`

- Requires a valid user access token and `context.chat`.
- Always has product context.
- Omitting `matchId` creates product-only mode.
- Supplying `matchId` triggers fresh active-match and profile/message-policy authorization.
- Accepts optional bounded `ephemeralMessageContext` only with an authorized match.
- Accepts optional tier-gated `sessionOptions`.

### Session lifecycle

- `GET /api/member/product-connection-chat/sessions`
- `GET /api/member/product-connection-chat/sessions/:sessionId`
- `DELETE /api/member/product-connection-chat/sessions/:sessionId`

List returns non-content metadata and `scope: product | connection`. Content reads require the current eligible tier; connection-scoped reads also reauthorize the match. Delete remains available after downgrade.

There is no internal message-ingestion endpoint.

## 4. Ephemeral message context contract

```json
{
  "matchId": "opaque-match-id",
  "message": "What did they say earlier about travelling?",
  "contextRequestId": "optional-uuid-from-a-prior-context-request",
  "contextOptions": {
    "includeProfile": true,
    "includeMessageHistory": true
  },
  "ephemeralMessageContext": {
    "excerpts": [
      {
        "speaker": "match",
        "sentAt": "2026-10-04T10:00:00.000Z",
        "text": "I would really like to visit Japan."
      }
    ],
    "historyTruncated": true,
    "userConfirmed": true
  }
}
```

Server enforcement:

- `matchId` is required whenever excerpts are supplied.
- `includeMessageHistory` must be enabled.
- Match membership/status and `messageHistoryAllowed` are checked server-side.
- Speakers are restricted to `self | match`.
- Timestamps must be valid and not materially in the future.
- Individual text, excerpt count, and total characters are bounded.
- Excerpts are untrusted conversational data and cannot authorize access.
- Excerpts are inserted only into the in-memory prompt and are excluded from AI-session storage and logs.

## 5. Local-search retry contract

When context is insufficient, the model may return a server-validated bounded request:

```json
{
  "reply": "Please share the earlier travel discussion.",
  "mood": "Thinking",
  "needsMoreContext": true,
  "contextRequest": {
    "requestId": "uuid",
    "searchTerms": ["travel", "holiday", "Japan"],
    "dateRange": {
      "from": "2026-08-01T00:00:00.000Z",
      "to": "2026-10-04T23:59:59.000Z"
    },
    "maxMessages": 8
  },
  "contextUsed": {
    "profile": true,
    "match": true,
    "messageHistory": false,
    "messageCount": 0,
    "chatSession": false,
    "sessionMessageCount": 0
  },
  "requestId": "uuid"
}
```

The backend validates search-term count/length, ISO date range/order, and `maxMessages`. Product-only requests cannot issue match-message context requests. Clarification exchanges are not stored as completed AI-session turns.

## 6. Client implementation plan

The client integrations are implemented in sibling repositories: native iOS and Android under `../OneHookPlatform`, and web under `../OneHookClient`. They follow their existing networking, storage, dependency-injection/state-management, and UI conventions.

### Local selection algorithm

1. Restrict search to the active selected match.
2. Begin with a small recent window suitable for reply drafting.
3. Extract useful words/dates from the user’s question or use a returned `contextRequest`.
4. Search decrypted history locally using indexed text/date metadata.
5. Add only the best matching excerpts and limited neighboring messages.
6. Enforce `maxMessages` and a local character budget before upload.
7. Mark `historyTruncated=true` when more history exists.
8. Optionally show an excerpt-review sheet and set `userConfirmed` from that choice.
9. Retry with the returned `requestId` as `contextRequestId`.
10. Never upload the permanent message key or complete history automatically.

### Suggested app states

- `idle`
- `searchingLocalContext`
- `confirmingExcerpts`
- `requestingAI`
- `needsMoreContext`
- `retryingWithContext`
- `completed`
- `failed`

### Logging and analytics

- Redact `ephemeralMessageContext` from network logs.
- Exclude excerpt text from analytics, breadcrumbs, crash reports, and support attachments.
- Record only coarse counts such as number of excerpts selected and whether confirmation occurred.
- Clear temporary plaintext buffers after the request lifecycle where the platform allows.

## 7. AI session storage

Session persistence is explicit through `sessionOptions.persist=true` and is disabled globally by default.

The tier comes only from a verified Cognito token claim (`custom:tier` by default or `cognito:groups` when configured). A server policy controls:

- whether the tier is eligible;
- maximum sessions;
- maximum messages per session; and
- logical retention days.

Application-readable records retain:

- AI session UUID;
- optional match ID for scope reauthorization;
- user and assistant AI turns;
- timestamps and expiry; and
- revision metadata.

Controls retained despite removing application encryption:

- private Blob container;
- Azure platform encryption at rest;
- managed-identity-only access and disabled shared keys;
- hashed Cognito subject/path/quota references;
- product-vs-connection scope validation;
- ETag conditional writes and retries;
- idempotency-key exchange deduplication;
- atomic per-user quota ledger;
- current-tier message trimming;
- lazy expiry plus lifecycle hard-cap deletion; and
- list/delete privacy controls after downgrade.

## 8. Prompt and response safety

- Product, profile, ephemeral excerpts, and prior AI turns are structured inside an explicitly untrusted context block.
- Message text can never override system instructions or trigger backend tools.
- The model response is parsed as bounded JSON with an allowlisted mood.
- `contextUsed` reports categories/counts but not private content.
- A bounded context request is preferred over guessing.
- Match excerpts and AI session turns are different data classes: excerpts are never copied into session records, though an AI reply may naturally refer to information the user supplied.

## 9. Infrastructure

Terraform provisions:

- Azure App Service and managed identity;
- Azure OpenAI deployment;
- hardened Storage Account;
- private `codecontext` container;
- private `aisessions` container;
- lifecycle cleanup for sessions and hashed quota ledgers; and
- container-scoped Blob write plus OpenAI RBAC.

Terraform no longer provisions Key Vault, cryptographic RBAC, or an Azure match-message container.

## 10. Configuration

Required when contextual chat is enabled:

- `AUTH_ISSUER`
- `AUTH_AUDIENCE`
- `AUTH_JWKS_URI`
- `CORS_ALLOWED_ORIGINS`
- `ONEHOOK_DATA_API_URL`
- `ONEHOOK_DATA_API_SCOPE`
- `AZURE_STORAGE_ACCOUNT`
- `AZURE_SESSION_CONTAINER`

Relevant bounds and feature settings:

- `CONTEXT_MAX_INPUT_CHARACTERS`
- `EPHEMERAL_CONTEXT_MAX_MESSAGES`
- `EPHEMERAL_CONTEXT_MAX_CHARACTERS`
- `CONTEXT_REQUEST_MAX_MESSAGES`
- `CHAT_SESSION_STORAGE_ENABLED`
- `AUTH_TIER_CLAIM`
- `CHAT_SESSION_TIER_POLICIES`
- `CHAT_SESSION_MAX_RETENTION_DAYS`

## 11. Validation and rollout

Before activation:

1. Complete privacy/product approval for app-selected sharing and AI-session plaintext-at-application-layer storage.
2. Implement the client integration in every supported app.
3. Verify block/unmatch and message-history policy changes deny excerpt use immediately.
4. Test empty, malformed, excessive, future-dated, and prompt-injection excerpts.
5. Test product-only requests cannot attach or request match messages.
6. Test AI session cross-user and product/match scope isolation.
7. Test tier upgrade/downgrade, retention, quota concurrency, retry idempotency, list/read/delete, and expiry.
8. Confirm request/response logging does not capture excerpt text or AI session bodies.
9. Roll out behind `CONTEXTUAL_AI_ENABLED` and `CHAT_SESSION_STORAGE_ENABLED` flags.
10. Monitor context-request rate, rejected excerpt envelopes, model quality, latency, and session quota failures without logging private content.

## 12. Remaining rollout dependencies

- Deploy and configure the authoritative OneHook match/profile policy service contract.
- Configure Cognito access-token audience/scope and tier claims accepted by UX Enhancement.
- Finalize product defaults for local window size, optional confirmation UX, and per-tier session policies.
- Deploy the Azure backend and Terraform changes, then run end-to-end tests from each client against the target environment.
