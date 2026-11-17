$version: "2.0"

// Mr OneHook: the chat assistant API that the OneHook web and mobile apps call directly.
//
// Owned by this repo (OneHookUXEnhancement): served by backend/ (Express on Azure App Service,
// chatbot.<stage>.onehook.club; routes in backend/src/app.ts and backend/src/contextRoutes.ts) and
// published as the npm package `onehook-mr-onehook-client` (sdk/). Member routes take the member's
// Cognito ID token as `Authorization: Bearer <token>`; `@auth([])` routes take none.
//
// Errors are NOT OneHook's backend `ErrorBody`: this backend answers `{"error": "<CODE or message>"}`
// (plus `requestId` on the chat route), so they use `MrOneHookErrorBody` below.
namespace club.onehook.mronehook

use aws.protocols#restJson1

@restJson1
@httpBearerAuth
service MrOneHookService {
    version: "2026-11-01",
    // Answered by the shared Express handlers on every route: 413 for a JSON body over 32 KB, 500 for an
    // unexpected failure.
    errors: [PayloadTooLargeError, InternalServerError],
    operations: [
        ProductConnectionChat,
        ListChatSessions,
        GetChatSession,
        DeleteChatSession,
        PublicProductChat,
        GetHealth
    ]
}

// ─────────────────────────────────────────────────────────────────────────────
// Member routes (Cognito ID token). 20 requests per minute per member, shared across them (429
// `RATE_LIMITED`). While the feature is off they all answer 404 `ENDPOINT_NOT_FOUND`; while it is on but
// not configured, 503 `CONTEXT_NOT_CONFIGURED`.
// ─────────────────────────────────────────────────────────────────────────────

/// One chat turn with Mr OneHook: a product question, or (with `matchId`) help with one connection.
///
/// Codes: 400 `INVALID_CONTEXTUAL_CHAT_REQUEST`; 401 `AUTH_REQUIRED`, `INVALID_ACCESS_TOKEN`; 402
/// `MESSAGE_LIMIT_REACHED` (free tier: 10 messages per UTC day); 403 `CHAT_SESSION_NOT_INCLUDED_IN_TIER`,
/// `MESSAGE_CONTEXT_NOT_ALLOWED`; 404 `MATCH_NOT_AVAILABLE`, `CHAT_SESSION_NOT_FOUND`,
/// `ENDPOINT_NOT_FOUND`; 409 `CHAT_SESSION_LIMIT_REACHED`; 429 `RATE_LIMITED`, `AI_RATE_LIMITED`; 503
/// `CONTEXT_NOT_CONFIGURED`, `CHAT_SESSION_STORAGE_NOT_CONFIGURED`, `CHAT_TEMPORARILY_UNAVAILABLE`,
/// `CONTEXT_TEMPORARILY_UNAVAILABLE`.
@http(method: "POST", uri: "/api/member/product-connection-chat")
operation ProductConnectionChat {
    input: ProductConnectionChatRequest,
    output: ProductConnectionChatResponse,
    errors: [
        BadRequestError,
        UnauthorizedError,
        MessageLimitReachedError,
        ForbiddenError,
        NotFoundError,
        ChatSessionLimitReachedError,
        TooManyRequestsError,
        ServiceUnavailableError
    ]
}

/// The member's saved chat sessions, newest first (expired ones are left out).
/// 503 `CHAT_SESSION_STORAGE_TEMPORARILY_UNAVAILABLE` when the store cannot be read.
@readonly
@http(method: "GET", uri: "/api/member/product-connection-chat/sessions")
operation ListChatSessions {
    output: ListChatSessionsResponse,
    errors: [UnauthorizedError, NotFoundError, TooManyRequestsError, ServiceUnavailableError]
}

/// One saved session with its messages (the tier's most recent ones). 404 `CHAT_SESSION_NOT_FOUND` for an
/// unknown id, another member's session, or a connection session whose match is no longer visible.
@readonly
@http(method: "GET", uri: "/api/member/product-connection-chat/sessions/{sessionId}")
operation GetChatSession {
    input: ChatSessionIdRequest,
    output: GetChatSessionResponse,
    errors: [UnauthorizedError, ForbiddenError, NotFoundError, TooManyRequestsError, ServiceUnavailableError]
}

/// Deletes a saved session. Idempotent: an unknown UUID is also 204.
@idempotent
@http(method: "DELETE", uri: "/api/member/product-connection-chat/sessions/{sessionId}", code: 204)
operation DeleteChatSession {
    input: ChatSessionIdRequest,
    output: DeleteChatSessionResponse,
    errors: [UnauthorizedError, NotFoundError, TooManyRequestsError, ServiceUnavailableError]
}

// ─────────────────────────────────────────────────────────────────────────────
// Public routes (no auth)
// ─────────────────────────────────────────────────────────────────────────────

/// The anonymous mascot chat on the public site. 10 requests per minute per client IP (429). A
/// non-empty `honeypot` is refused (403). Upstream model errors map to 400 (the model refused the
/// request), 429 (the model is rate limited) or 503 (any other model error); anything else is 500.
@auth([])
@http(method: "POST", uri: "/api/public/product-chat")
operation PublicProductChat {
    input: PublicProductChatRequest,
    output: PublicProductChatResponse,
    errors: [BadRequestError, ForbiddenError, TooManyRequestsError, ServiceUnavailableError]
}

/// Liveness probe (App Service health check).
@auth([])
@readonly
@http(method: "GET", uri: "/health")
operation GetHealth {
    output: HealthResponse
}

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

/// Mr OneHook's mood, which drives the mascot's face.
enum Mood {
    HAPPY = "Happy"
    NEUTRAL = "Neutral"
    THINKING = "Thinking"
    SAD = "Sad"
    EXCITED = "Excited"
}

structure ProductConnectionChatRequest {
    /// A UUID makes the turn idempotent: it becomes the `requestId`, and a repeated turn is stored once.
    /// Anything else is ignored and a new id is minted.
    @httpHeader("Idempotency-Key")
    idempotencyKey: String,

    /// 1 to `CONTEXT_MAX_INPUT_CHARACTERS` (default 4000) characters; trimmed, must not be blank.
    @required
    message: String,

    /// Present: a connection chat about this match (1 to 256 characters). Absent: a product chat.
    @length(min: 1, max: 256)
    matchId: String,

    contextOptions: ContextOptions,

    /// Message excerpts the app read from its own (end-to-end encrypted) history. Needs `matchId` and
    /// `includeMessageHistory`, and the match's policy must allow message history (403 otherwise).
    ephemeralMessageContext: EphemeralMessageContext,

    /// UUID of a `contextRequest` this turn answers.
    @length(max: 64)
    contextRequestId: String,

    sessionOptions: SessionOptions
}

structure ContextOptions {
    /// Default true.
    includeProfile: Boolean,
    /// Default true.
    includeMessageHistory: Boolean
}

structure EphemeralMessageContext {
    /// 1 to `EPHEMERAL_CONTEXT_MAX_MESSAGES` (default 30); total text at most
    /// `EPHEMERAL_CONTEXT_MAX_CHARACTERS` (default 12000).
    @required
    @length(min: 1)
    excerpts: EphemeralMessageExcerptList,
    historyTruncated: Boolean,
    userConfirmed: Boolean
}

list EphemeralMessageExcerptList {
    member: EphemeralMessageExcerpt
}

structure EphemeralMessageExcerpt {
    @required
    speaker: ExcerptSpeaker,
    /// ISO-8601, at most 5 minutes in the future.
    @required
    @length(min: 1, max: 64)
    sentAt: String,
    @required
    text: String
}

enum ExcerptSpeaker {
    SELF = "self"
    MATCH = "match"
}

/// Saving the conversation needs a paid tier (403 `CHAT_SESSION_NOT_INCLUDED_IN_TIER` otherwise).
structure SessionOptions {
    /// Start a saved session.
    persist: Boolean,
    /// Continue this saved session (UUID). Cannot be combined with `persist: false`.
    sessionId: String,
    /// At the tier's session cap, delete the least recently active session instead of answering 409.
    replaceLeastRecent: Boolean
}

structure ProductConnectionChatResponse {
    /// 1 to 8000 characters.
    @required
    reply: String,
    @required
    mood: Mood,
    /// Connection chats only: Mr OneHook needs more of the conversation; `contextRequest` says what.
    needsMoreContext: Boolean,
    contextRequest: ContextRequest,
    /// Free tier only: messages left today after this one.
    remainingMessages: Integer,
    /// Product chats only, when the member asked Mr OneHook to find someone.
    matchSuggestion: MatchSuggestionResult,
    @required
    contextUsed: ContextUsed,
    /// UUID of this turn.
    @required
    requestId: String,
    /// Present when the turn was saved.
    session: SavedSessionRef
}

structure ContextRequest {
    /// 1 to 8 terms, each 1 to 80 characters.
    @required
    @length(min: 1, max: 8)
    searchTerms: StringList,
    /// 1 to `CONTEXT_REQUEST_MAX_MESSAGES` (default 8).
    @required
    @range(min: 1)
    maxMessages: Integer,
    dateRange: ContextDateRange,
    /// The turn's `requestId`; send it back as `contextRequestId`.
    @required
    requestId: String
}

/// At least one bound; `from` is not after `to`.
structure ContextDateRange {
    /// ISO-8601.
    from: String,
    /// ISO-8601.
    to: String
}

list StringList {
    member: String
}

/// What happened to a "find me ..." request. The prompt Mr OneHook wrote is never returned.
structure MatchSuggestionResult {
    @required
    status: SuggestionStatus,
    /// Why Mr OneHook is suggesting these people (1 to 280 characters).
    @required
    @length(min: 1, max: 280)
    reasoning: String
}

enum SuggestionStatus {
    /// Matching stored it; candidates appear in discover as Mr. OneHook cards.
    RECORDED = "RECORDED"
    /// Asked suggestions need Super or above.
    PREMIUM_REQUIRED = "PREMIUM_REQUIRED"
    /// The member's matching is off (State says not ON, or Matching holds no row for them).
    MATCHING_OFF = "MATCHING_OFF"
    /// Not recorded: the status read, the signing or Matching failed, or matching is not configured.
    UNAVAILABLE = "UNAVAILABLE"
}

/// Which context went into the answer.
structure ContextUsed {
    @required
    profile: Boolean,
    @required
    match: Boolean,
    @required
    messageHistory: Boolean,
    @required
    messageCount: Integer,
    @required
    chatSession: Boolean,
    @required
    sessionMessageCount: Integer
}

structure SavedSessionRef {
    @required
    sessionId: String,
    /// ISO-8601.
    @required
    updatedAt: String,
    /// ISO-8601.
    @required
    expiresAt: String,
    @required
    messageCount: Integer
}

structure ListChatSessionsResponse {
    @required
    sessions: ChatSessionSummaryList
}

list ChatSessionSummaryList {
    member: ChatSessionSummary
}

structure ChatSessionSummary {
    @required
    sessionId: String,
    @required
    scope: ChatSessionScope,
    /// ISO-8601.
    @required
    createdAt: String,
    /// ISO-8601.
    @required
    updatedAt: String,
    /// ISO-8601.
    @required
    expiresAt: String,
    @required
    messageCount: Integer
}

enum ChatSessionScope {
    PRODUCT = "product"
    CONNECTION = "connection"
}

structure ChatSessionIdRequest {
    /// UUID.
    @required
    @httpLabel
    sessionId: String
}

structure GetChatSessionResponse {
    @required
    session: ChatSessionDetail
}

structure ChatSessionDetail {
    @required
    sessionId: String,
    /// Connection sessions only.
    matchId: String,
    /// ISO-8601.
    @required
    createdAt: String,
    /// ISO-8601.
    @required
    updatedAt: String,
    /// ISO-8601.
    @required
    expiresAt: String,
    @required
    messages: ChatSessionMessageList
}

list ChatSessionMessageList {
    member: ChatSessionMessage
}

structure ChatSessionMessage {
    @required
    role: ChatSessionRole,
    @required
    @length(min: 1, max: 16000)
    content: String,
    /// ISO-8601.
    @required
    createdAt: String
}

enum ChatSessionRole {
    USER = "user"
    ASSISTANT = "assistant"
}

@output
structure DeleteChatSessionResponse {}

structure PublicProductChatRequest {
    /// The conversation so far; the last message is the visitor's.
    @required
    messages: PublicChatMessageList,
    userDemographics: UserDemographics,
    /// Bot trap: must be absent or empty.
    honeypot: String
}

list PublicChatMessageList {
    member: PublicChatMessage
}

structure PublicChatMessage {
    @required
    role: PublicChatRole,
    @required
    content: String
}

enum PublicChatRole {
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
}

structure UserDemographics {
    gender: String,
    sexualPreference: String
}

structure PublicProductChatResponse {
    @required
    reply: String,
    @required
    mood: Mood
}

structure HealthResponse {
    /// Always `ok`.
    @required
    status: String,
    /// ISO-8601.
    @required
    timestamp: String
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/// Mr OneHook's error body. On member routes `error` is a stable UPPER_SNAKE_CASE code; on the public
/// route it is a human-readable message.
@mixin
structure MrOneHookErrorBody {
    @required
    error: String,
    /// The turn's id, on `ProductConnectionChat` errors.
    requestId: String
}

@error("client")
@httpError(400)
structure BadRequestError with [MrOneHookErrorBody] {}

@error("client")
@httpError(401)
structure UnauthorizedError with [MrOneHookErrorBody] {}

/// 402 `MESSAGE_LIMIT_REACHED`: the free tier's daily messages are spent.
@error("client")
@httpError(402)
structure MessageLimitReachedError with [MrOneHookErrorBody] {
    /// Always 0.
    @required
    remainingMessages: Integer
}

@error("client")
@httpError(403)
structure ForbiddenError with [MrOneHookErrorBody] {}

@error("client")
@httpError(404)
structure NotFoundError with [MrOneHookErrorBody] {}

/// 409 `CHAT_SESSION_LIMIT_REACHED`: a new saved session would exceed the tier's cap. Before the model
/// call it lists the sessions so the app can offer a choice; a race at save time carries neither field.
@error("client")
@httpError(409)
structure ChatSessionLimitReachedError with [MrOneHookErrorBody] {
    maxSessions: Integer,
    sessions: ChatSessionSummaryList
}

@error("client")
@httpError(429)
structure TooManyRequestsError with [MrOneHookErrorBody] {}

/// 413 `PAYLOAD_TOO_LARGE`: the JSON body is over 32 KB.
@error("client")
@httpError(413)
structure PayloadTooLargeError with [MrOneHookErrorBody] {}

@error("server")
@httpError(500)
structure InternalServerError with [MrOneHookErrorBody] {}

@error("server")
@httpError(503)
structure ServiceUnavailableError with [MrOneHookErrorBody] {}
