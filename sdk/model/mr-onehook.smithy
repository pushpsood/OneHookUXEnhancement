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
        UploadChatAttachment,
        GetChatAttachment,
        GetChatAttachmentContent,
        GetMrOneHookPro,
        PurchaseMrOneHookPro,
        UpdateMrOneHookProAutoRenew,
        ContinueMrOneHookProAfterMembership,
        CancelMrOneHookProContinuation,
        DismissMrOneHookProNotice,
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
/// Codes: 400 `INVALID_CONTEXTUAL_CHAT_REQUEST`, `ATTACHMENT_NOT_USABLE` (an attachment failed processing
/// or belongs to another chat); 401 `AUTH_REQUIRED`, `INVALID_ACCESS_TOKEN`; 402 `MESSAGE_LIMIT_REACHED`
/// (Free plan: 10 messages per UTC day); 403 `CHAT_SESSION_NOT_INCLUDED_IN_TIER`,
/// `MESSAGE_CONTEXT_NOT_ALLOWED`, `PRO_REQUIRED` (attachments need Mr OneHook Pro); 404
/// `MATCH_NOT_AVAILABLE`, `CHAT_SESSION_NOT_FOUND`, `ATTACHMENT_NOT_FOUND`, `ENDPOINT_NOT_FOUND`; 409
/// `ATTACHMENT_NOT_READY` (still processing: poll `GetChatAttachment`), `CHAT_SESSION_LIMIT_REACHED` (a
/// concurrent request filled the plan's sessions; retry); 429 `RATE_LIMITED`, `AI_RATE_LIMITED`; 503
/// `CONTEXT_NOT_CONFIGURED`, `CHAT_SESSION_STORAGE_NOT_CONFIGURED`, `CHAT_TEMPORARILY_UNAVAILABLE`,
/// `CONTEXT_TEMPORARILY_UNAVAILABLE`.
///
/// Saved sessions: at the plan's cap (Free 1, Pro 3) a new session deletes the least recently active
/// one(s) first and lists them in `evictedSessionIds`.
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

/// Deletes a saved session and the files sent in it. Idempotent: an unknown UUID is also 204.
@idempotent
@http(method: "DELETE", uri: "/api/member/product-connection-chat/sessions/{sessionId}", code: 204)
operation DeleteChatSession {
    input: ChatSessionIdRequest,
    output: DeleteChatSessionResponse,
    errors: [UnauthorizedError, NotFoundError, TooManyRequestsError, ServiceUnavailableError]
}

/// Uploads one file for a later chat turn (Mr OneHook Pro only; never on the public chat). The body is the
/// raw file, at most 5 MiB (`413 ATTACHMENT_TOO_LARGE`). The type is read from the bytes, not the name or
/// `Content-Type`. Mr OneHook extracts everything from it in the background (images are described and their
/// text read, documents are read, audio and video are transcribed): poll `GetChatAttachment` until `READY`,
/// then send its id in `attachmentIds`.
///
/// A file from a match chat (decrypted on the device) sets `X-Attachment-Match-Id` and
/// `X-Attachment-Sender`; it is used for one turn of that connection chat, then deleted, and its contents are
/// never saved. A file the other person sent needs the match's `messageHistoryAllowed`.
///
/// Codes: 400 `INVALID_ATTACHMENT_REQUEST`; 403 `PRO_REQUIRED`, `MESSAGE_CONTEXT_NOT_ALLOWED`; 404
/// `MATCH_NOT_AVAILABLE`, `ENDPOINT_NOT_FOUND`; 413 `ATTACHMENT_TOO_LARGE`; 415
/// `UNSUPPORTED_ATTACHMENT_TYPE`; 429 `RATE_LIMITED`, `ATTACHMENT_PROCESSING_UNAVAILABLE` (too many files
/// recently or this month; chat still works; `retryAt` says when files work again); 503
/// `ATTACHMENTS_NOT_CONFIGURED`, `ATTACHMENTS_TEMPORARILY_UNAVAILABLE`, `CONTEXT_TEMPORARILY_UNAVAILABLE`.
@http(method: "POST", uri: "/api/member/product-connection-chat/attachments", code: 202)
operation UploadChatAttachment {
    input: UploadChatAttachmentRequest,
    output: ChatAttachmentResponse,
    errors: [
        BadRequestError,
        UnauthorizedError,
        ForbiddenError,
        NotFoundError,
        UnsupportedMediaTypeError,
        TooManyRequestsError,
        ServiceUnavailableError
    ]
}

/// One of the member's attachments and its processing status. 404 `ATTACHMENT_NOT_FOUND` for an unknown
/// id or another member's file. Polling does not count against the 20 requests per minute (60 per minute).
@readonly
@http(method: "GET", uri: "/api/member/product-connection-chat/attachments/{attachmentId}")
operation GetChatAttachment {
    input: ChatAttachmentIdRequest,
    output: ChatAttachmentResponse,
    errors: [UnauthorizedError, NotFoundError, TooManyRequestsError, ServiceUnavailableError]
}

/// The bytes of one of the member's uploaded files, to show it in a reopened session. Files from a match
/// chat are never kept, so they are 404. Served as an attachment download with `nosniff`.
@readonly
@http(method: "GET", uri: "/api/member/product-connection-chat/attachments/{attachmentId}/content")
operation GetChatAttachmentContent {
    input: ChatAttachmentIdRequest,
    output: GetChatAttachmentContentResponse,
    errors: [UnauthorizedError, NotFoundError, TooManyRequestsError, ServiceUnavailableError]
}

// ─────────────────────────────────────────────────────────────────────────────
// Mr OneHook Pro: a subscription of its own, separate from the OneHook membership. Members whose
// membership includes Pro (the top tier) get it without a subscription and cannot buy it. While Pro is
// off (`MR_ONEHOOK_PRO_ENABLED`) these answer 404 `ENDPOINT_NOT_FOUND`.
// ─────────────────────────────────────────────────────────────────────────────

/// The member's Mr OneHook plan, Pro subscription, prices, limits and notices (refunds, renewals, ...).
@readonly
@http(method: "GET", uri: "/api/member/mr-onehook-pro")
operation GetMrOneHookPro {
    output: MrOneHookProStatus,
    errors: [UnauthorizedError, NotFoundError, TooManyRequestsError, ServiceUnavailableError]
}

/// Buys Mr OneHook Pro. `Idempotency-Key` (UUID) is required: a retry with the same key returns the same
/// result and never charges twice.
///
/// Codes: 400 `INVALID_PRO_REQUEST`; 402 `PAYMENT_DECLINED`; 409 `PRO_INCLUDED_IN_MEMBERSHIP` (the
/// membership already includes Pro; nothing is charged), `PRO_ALREADY_ACTIVE`, `PRO_PURCHASE_IN_PROGRESS`;
/// 503 `PAYMENTS_NOT_CONFIGURED`, `PRO_TEMPORARILY_UNAVAILABLE`.
@http(method: "POST", uri: "/api/member/mr-onehook-pro/subscription")
operation PurchaseMrOneHookPro {
    input: PurchaseMrOneHookProRequest,
    output: MrOneHookProStatus,
    errors: [
        BadRequestError,
        UnauthorizedError,
        PaymentDeclinedError,
        NotFoundError,
        ConflictError,
        TooManyRequestsError,
        ServiceUnavailableError
    ]
}

/// Turns the Pro subscription's auto-renewal off (Pro continues to the end of the paid period) or back on.
/// Codes: 400 `INVALID_PRO_REQUEST`; 404 `PRO_SUBSCRIPTION_NOT_FOUND`; 409 `PRO_PAUSED_FOR_MEMBERSHIP`
/// (the membership covers Pro now; nothing renews); 503 `PRO_TEMPORARILY_UNAVAILABLE`.
@idempotent
@http(method: "PUT", uri: "/api/member/mr-onehook-pro/subscription/auto-renew")
operation UpdateMrOneHookProAutoRenew {
    input: UpdateMrOneHookProAutoRenewRequest,
    output: MrOneHookProStatus,
    errors: [BadRequestError, UnauthorizedError, NotFoundError, ConflictError, TooManyRequestsError, ServiceUnavailableError]
}

/// "Keep Mr OneHook Pro" while cancelling the membership that includes it: schedules a Pro subscription
/// whose first charge is on the day the membership's paid period ends. If the membership ends earlier
/// (other than a refund or chargeback), Pro stays free until that original day. Nothing is charged now.
/// `Idempotency-Key` (UUID) is required.
///
/// Codes: 400 `INVALID_PRO_REQUEST`; 409 `MEMBERSHIP_NOT_ENDING` (the membership does not include Pro or is
/// not set to end), `PRO_ALREADY_ACTIVE`; 503 `PAYMENTS_NOT_CONFIGURED`, `PRO_TEMPORARILY_UNAVAILABLE`
/// (the membership could not be checked).
@idempotent
@http(method: "PUT", uri: "/api/member/mr-onehook-pro/continuation")
operation ContinueMrOneHookProAfterMembership {
    input: ContinueMrOneHookProRequest,
    output: MrOneHookProStatus,
    errors: [BadRequestError, UnauthorizedError, NotFoundError, ConflictError, TooManyRequestsError, ServiceUnavailableError]
}

/// Withdraws "Keep Mr OneHook Pro" before it starts: nothing is charged. Idempotent (204 when there is none).
/// 409 `CONTINUATION_ALREADY_STARTED` once the first charge was made (turn auto-renew off instead).
@idempotent
@http(method: "DELETE", uri: "/api/member/mr-onehook-pro/continuation", code: 204)
operation CancelMrOneHookProContinuation {
    output: CancelMrOneHookProContinuationResponse,
    errors: [UnauthorizedError, NotFoundError, ConflictError, TooManyRequestsError, ServiceUnavailableError]
}

/// Dismisses one notice. Idempotent: an unknown id is also 204.
@idempotent
@http(method: "DELETE", uri: "/api/member/mr-onehook-pro/notices/{noticeId}", code: 204)
operation DismissMrOneHookProNotice {
    input: MrOneHookProNoticeIdRequest,
    output: DismissMrOneHookProNoticeResponse,
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

    sessionOptions: SessionOptions,

    /// Up to 3 `READY` attachments (Mr OneHook Pro). Files from a match chat need the same `matchId`.
    @length(min: 1, max: 3)
    attachmentIds: AttachmentIdList
}

list AttachmentIdList {
    member: String
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

/// Every signed-in member may save sessions; the plan sets how many (Free 1, Pro 3).
structure SessionOptions {
    /// Start a saved session.
    persist: Boolean,
    /// Continue this saved session (UUID). Cannot be combined with `persist: false`.
    sessionId: String,
    /// Deprecated and ignored: at the plan's cap the least recently active session is always replaced
    /// (see `evictedSessionIds`).
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
    session: SavedSessionRef,
    /// Saved sessions deleted to make room for this new one (least recently active first).
    evictedSessionIds: StringList,
    /// The member's Mr OneHook plan for this turn.
    plan: MrOneHookPlan
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
    sessionMessageCount: Integer,
    /// Attachments read for this turn.
    attachmentCount: Integer
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
    /// `connection` when the session is about a match (`matchId` is set), else `product`.
    @required
    scope: ChatSessionScope,
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
    /// Messages in `messages` (the tier's window of the stored conversation).
    @required
    messageCount: Integer,
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
    createdAt: String,
    /// The mood Mr OneHook answered with. Assistant turns only; absent on turns saved before it was stored.
    mood: Mood,
    /// Files sent with this (user) turn.
    attachments: ChatAttachmentRefList
}

list ChatAttachmentRefList {
    member: ChatAttachmentRef
}

/// A file sent with a saved turn. Files from a match chat have no `attachmentId`: they were not kept.
structure ChatAttachmentRef {
    attachmentId: String,
    @required
    name: String,
    @required
    kind: AttachmentKind,
    sizeBytes: Integer,
    @required
    source: AttachmentSource
}

enum ChatSessionRole {
    USER = "user"
    ASSISTANT = "assistant"
}

@output
structure DeleteChatSessionResponse {}

// ── Attachments ──────────────────────────────────────────────────────────────

structure UploadChatAttachmentRequest {
    /// What the app believes the file is; checked against the bytes.
    @required
    @httpHeader("Content-Type")
    contentType: String,
    /// The file name, percent-encoded UTF-8 (1 to 255 characters once decoded).
    @required
    @httpHeader("X-Attachment-Name")
    fileName: String,
    /// The match whose chat the file came from (a file decrypted from a match chat).
    @httpHeader("X-Attachment-Match-Id")
    matchId: String,
    /// Who sent the file in that match chat. Required with `matchId`.
    @httpHeader("X-Attachment-Sender")
    sender: ExcerptSpeaker,
    /// The file, 1 byte to 5 MiB.
    @required
    @httpPayload
    body: Blob
}

structure ChatAttachmentIdRequest {
    /// UUID.
    @required
    @httpLabel
    attachmentId: String
}

structure ChatAttachmentResponse {
    @required
    attachment: ChatAttachment
}

structure ChatAttachment {
    @required
    attachmentId: String,
    @required
    name: String,
    @required
    kind: AttachmentKind,
    /// The type read from the bytes (e.g. `image/png`).
    @required
    mediaType: String,
    @required
    sizeBytes: Integer,
    @required
    status: AttachmentStatus,
    @required
    source: AttachmentSource,
    /// Match-chat files only.
    sender: ExcerptSpeaker,
    /// ISO-8601.
    @required
    createdAt: String,
    /// ISO-8601. Unsent files and match-chat files are deleted after a day.
    @required
    expiresAt: String,
    /// `FAILED` only.
    failureReason: AttachmentFailureReason
}

enum AttachmentKind {
    IMAGE = "image"
    DOCUMENT = "document"
    TEXT = "text"
    AUDIO = "audio"
    VIDEO = "video"
}

enum AttachmentStatus {
    PROCESSING = "PROCESSING"
    READY = "READY"
    FAILED = "FAILED"
}

enum AttachmentSource {
    /// Uploaded by the member for this Mr OneHook chat.
    UPLOAD = "upload"
    /// Selected in a match chat and decrypted on the device.
    MATCH_CHAT = "match_chat"
}

enum AttachmentFailureReason {
    /// Nothing could be read from it (corrupt, encrypted, empty).
    UNREADABLE = "UNREADABLE"
    /// Too long to process (e.g. an audio file over the length limit).
    TOO_LONG = "TOO_LONG"
    /// Processing is not available right now (budget reached or the AI service failed).
    PROCESSING_UNAVAILABLE = "PROCESSING_UNAVAILABLE"
}

structure GetChatAttachmentContentResponse {
    @required
    @httpHeader("Content-Type")
    contentType: String,
    @required
    @httpHeader("Content-Disposition")
    contentDisposition: String,
    @required
    @httpPayload
    body: Blob
}

// ── Mr OneHook Pro ───────────────────────────────────────────────────────────

enum MrOneHookPlan {
    /// 10 messages per UTC day, 1 saved session, no attachments.
    FREE = "FREE"
    /// Unlimited messages, 3 saved sessions, attachments.
    PRO = "PRO"
}

/// Why the member is on Pro.
enum MrOneHookProSource {
    NONE = "NONE"
    /// A paid Mr OneHook Pro subscription.
    SUBSCRIPTION = "SUBSCRIPTION"
    /// The OneHook membership includes Pro (verified from the Cognito token).
    MEMBERSHIP = "MEMBERSHIP"
    /// The membership ended before the day a kept Pro subscription starts: Pro is free until then.
    COMPLIMENTARY = "COMPLIMENTARY"
}

enum ProBillingPeriod {
    MONTHLY = "MONTHLY"
    YEARLY = "YEARLY"
}

enum ProSubscriptionStatus {
    /// A purchase is being charged.
    PENDING = "PENDING"
    /// Kept after the membership: starts (first charge) on `scheduledStartAt`.
    SCHEDULED = "SCHEDULED"
    ACTIVE = "ACTIVE"
    /// A renewal charge failed; retried daily for 3 days, Pro continues meanwhile.
    GRACE = "GRACE"
    ENDED = "ENDED"
}

enum ProEndedReason {
    /// Auto-renew was off at the end of the period.
    CANCELLED = "CANCELLED"
    PAYMENT_FAILED = "PAYMENT_FAILED"
    /// The membership includes Pro now.
    INCLUDED_IN_MEMBERSHIP = "INCLUDED_IN_MEMBERSHIP"
    /// "Keep Mr OneHook Pro" was withdrawn, or the membership was renewed, before it started.
    CONTINUATION_WITHDRAWN = "CONTINUATION_WITHDRAWN"
    /// The unused months of a yearly plan were refunded.
    REFUNDED = "REFUNDED"
    /// The first payment was declined.
    PAYMENT_DECLINED = "PAYMENT_DECLINED"
}

enum ProRefundStatus {
    SCHEDULED = "SCHEDULED"
    ISSUED = "ISSUED"
    /// The membership ended within the window, so the yearly plan continues instead.
    CANCELLED = "CANCELLED"
}

enum ProNoticeKind {
    PRO_PURCHASED = "PRO_PURCHASED"
    PRO_RENEWED = "PRO_RENEWED"
    PRO_RENEWAL_FAILED = "PRO_RENEWAL_FAILED"
    PRO_ENDED = "PRO_ENDED"
    /// The membership now includes Pro; the subscription stops renewing (and a yearly refund is scheduled).
    PRO_PAUSED_FOR_MEMBERSHIP = "PRO_PAUSED_FOR_MEMBERSHIP"
    PRO_REFUND_SCHEDULED = "PRO_REFUND_SCHEDULED"
    PRO_REFUND_ISSUED = "PRO_REFUND_ISSUED"
    PRO_REFUND_CANCELLED = "PRO_REFUND_CANCELLED"
    PRO_RESUMED = "PRO_RESUMED"
    PRO_CONTINUATION_SCHEDULED = "PRO_CONTINUATION_SCHEDULED"
    PRO_CONTINUATION_CANCELLED = "PRO_CONTINUATION_CANCELLED"
    PRO_CONTINUATION_STARTED = "PRO_CONTINUATION_STARTED"
    ATTACHMENT_USAGE_WARNING = "ATTACHMENT_USAGE_WARNING"
}

structure MrOneHookProStatus {
    @required
    plan: MrOneHookPlan,
    @required
    source: MrOneHookProSource,
    /// The member's latest Pro subscription, if any.
    subscription: ProSubscription,
    /// True when `PurchaseMrOneHookPro` would be accepted.
    @required
    canPurchase: Boolean,
    @required
    offers: ProOfferList,
    @required
    limits: MrOneHookPlanLimits,
    /// Pro only: this month's file processing.
    attachmentUsage: AttachmentUsage,
    /// Newest first, at most 20.
    @required
    notices: ProNoticeList
}

structure ProSubscription {
    @required
    status: ProSubscriptionStatus,
    @required
    billingPeriod: ProBillingPeriod,
    @required
    autoRenew: Boolean,
    /// Price per period in the currency's minor unit (paise).
    @required
    priceMinor: Integer,
    /// ISO 4217, e.g. `INR`.
    @required
    currency: String,
    /// True while the membership covers Pro: nothing renews.
    @required
    pausedForMembership: Boolean,
    /// ISO-8601.
    currentPeriodStart: String,
    /// ISO-8601. Pro lasts until then.
    currentPeriodEnd: String,
    /// ISO-8601. When the next charge is due (absent when nothing will be charged).
    nextChargeAt: String,
    /// ISO-8601. `SCHEDULED` only: the first charge.
    scheduledStartAt: String,
    refund: ProRefund,
    endedReason: ProEndedReason,
    /// ISO-8601.
    @required
    createdAt: String
}

structure ProRefund {
    @required
    status: ProRefundStatus,
    @required
    amountMinor: Integer,
    @required
    currency: String,
    /// ISO-8601: the end of the Pro month in progress when the membership started.
    @required
    dueAt: String,
    /// ISO-8601.
    issuedAt: String
}

list ProOfferList {
    member: ProOffer
}

structure ProOffer {
    @required
    billingPeriod: ProBillingPeriod,
    @required
    priceMinor: Integer,
    @required
    currency: String
}

structure MrOneHookPlanLimits {
    /// Messages per UTC day; absent means unlimited.
    dailyMessages: Integer,
    @required
    maxSessions: Integer,
    @required
    attachmentsAllowed: Boolean,
    @required
    maxAttachmentBytes: Integer,
    @required
    maxAttachmentsPerMessage: Integer
}

structure AttachmentUsage {
    /// 0 to 100: share of this month's file-processing allowance used.
    @required
    @range(min: 0, max: 100)
    usedPercent: Integer,
    /// True from 80%.
    @required
    warning: Boolean,
    /// ISO-8601: when the allowance resets (start of the next UTC month).
    @required
    resetsAt: String
}

list ProNoticeList {
    member: ProNotice
}

structure ProNotice {
    @required
    noticeId: String,
    @required
    kind: ProNoticeKind,
    /// ISO-8601.
    @required
    createdAt: String,
    /// Refunds and charges.
    amountMinor: Integer,
    currency: String,
    /// ISO-8601: the date the notice is about (refund date, first charge, end of Pro).
    at: String
}

structure PurchaseMrOneHookProRequest {
    /// UUID; required.
    @required
    @httpHeader("Idempotency-Key")
    idempotencyKey: String,
    @required
    billingPeriod: ProBillingPeriod,
    /// The payment provider's token for this purchase. The App Store provider takes the StoreKit 2 signed
    /// transaction (bought with `appAccountToken` = the member's Cognito `sub`); the gamma test provider
    /// takes `fake-ok`, `fake-decline` or `fake-decline-renewal`.
    @length(min: 1, max: 16384)
    paymentToken: String
}

structure UpdateMrOneHookProAutoRenewRequest {
    @required
    autoRenew: Boolean
}

structure ContinueMrOneHookProRequest {
    /// UUID; required.
    @required
    @httpHeader("Idempotency-Key")
    idempotencyKey: String,
    @required
    billingPeriod: ProBillingPeriod,
    /// As in `PurchaseMrOneHookPro`; charged on `scheduledStartAt`, not now.
    @length(min: 1, max: 16384)
    paymentToken: String
}

@output
structure CancelMrOneHookProContinuationResponse {}

structure MrOneHookProNoticeIdRequest {
    @required
    @httpLabel
    noticeId: String
}

@output
structure DismissMrOneHookProNoticeResponse {}

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
structure TooManyRequestsError with [MrOneHookErrorBody] {
    /// ISO-8601, `ATTACHMENT_PROCESSING_UNAVAILABLE` only: when files can be processed again.
    retryAt: String
}

/// 402 `PAYMENT_DECLINED`: the payment provider declined the charge. Nothing was bought.
@error("client")
@httpError(402)
structure PaymentDeclinedError with [MrOneHookErrorBody] {}

/// 409: the request conflicts with the member's current Pro state (`code` in `error`).
@error("client")
@httpError(409)
structure ConflictError with [MrOneHookErrorBody] {}

/// 415 `UNSUPPORTED_ATTACHMENT_TYPE`: the bytes are not a supported file type.
@error("client")
@httpError(415)
structure UnsupportedMediaTypeError with [MrOneHookErrorBody] {}

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
