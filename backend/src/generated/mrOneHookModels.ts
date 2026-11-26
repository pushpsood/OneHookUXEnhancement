// GENERATED FILE - DO NOT EDIT.
// Source of truth: OneHookUXEnhancement/sdk/model/*.smithy (Smithy MrOneHookService), via its OpenAPI.
// Regenerate: (OneHookUXEnhancement/sdk) npm run build && npm run manifest:sync
/* eslint-disable */

/** Every MrOneHookService operation. */
export const OPERATIONS = [
  { operationId: "CancelMrOneHookProContinuation", method: "DELETE", path: "/api/member/mr-onehook-pro/continuation" },
  { operationId: "ContinueMrOneHookProAfterMembership", method: "PUT", path: "/api/member/mr-onehook-pro/continuation" },
  { operationId: "DeleteChatSession", method: "DELETE", path: "/api/member/product-connection-chat/sessions/{sessionId}" },
  { operationId: "DismissMrOneHookProNotice", method: "DELETE", path: "/api/member/mr-onehook-pro/notices/{noticeId}" },
  { operationId: "GetChatAttachment", method: "GET", path: "/api/member/product-connection-chat/attachments/{attachmentId}" },
  { operationId: "GetChatAttachmentContent", method: "GET", path: "/api/member/product-connection-chat/attachments/{attachmentId}/content" },
  { operationId: "GetChatSession", method: "GET", path: "/api/member/product-connection-chat/sessions/{sessionId}" },
  { operationId: "GetHealth", method: "GET", path: "/health" },
  { operationId: "GetMrOneHookPro", method: "GET", path: "/api/member/mr-onehook-pro" },
  { operationId: "ListChatSessions", method: "GET", path: "/api/member/product-connection-chat/sessions" },
  { operationId: "ProductConnectionChat", method: "POST", path: "/api/member/product-connection-chat" },
  { operationId: "PublicProductChat", method: "POST", path: "/api/public/product-chat" },
  { operationId: "PurchaseMrOneHookPro", method: "POST", path: "/api/member/mr-onehook-pro/subscription" },
  { operationId: "UpdateMrOneHookProAutoRenew", method: "PUT", path: "/api/member/mr-onehook-pro/subscription/auto-renew" },
  { operationId: "UploadChatAttachment", method: "POST", path: "/api/member/product-connection-chat/attachments" },
] as const;

export type AttachmentFailureReason = "UNREADABLE" | "TOO_LONG" | "PROCESSING_UNAVAILABLE";

export type AttachmentKind = "image" | "document" | "text" | "audio" | "video";

export type AttachmentSource = "upload" | "match_chat";

export type AttachmentStatus = "PROCESSING" | "READY" | "FAILED";

export interface AttachmentUsage {
  /** 0 to 100: share of this month's file-processing allowance used. */
  usedPercent: number;
  /** True from 80%. */
  warning: boolean;
  /** ISO-8601: when the allowance resets (start of the next UTC month). */
  resetsAt: string;
}

/**
 * Mr OneHook's error body. On member routes `error` is a stable UPPER_SNAKE_CASE code; on the public
 * route it is a human-readable message.
 */
export interface BadRequestErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
}

export interface ChatAttachment {
  attachmentId: string;
  name: string;
  kind: AttachmentKind;
  /** The type read from the bytes (e.g. `image/png`). */
  mediaType: string;
  sizeBytes: number;
  status: AttachmentStatus;
  source: AttachmentSource;
  sender?: ExcerptSpeaker;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. Unsent files and match-chat files are deleted after a day. */
  expiresAt: string;
  failureReason?: AttachmentFailureReason;
}

/** A file sent with a saved turn. Files from a match chat have no `attachmentId`: they were not kept. */
export interface ChatAttachmentRef {
  attachmentId?: string;
  name: string;
  kind: AttachmentKind;
  sizeBytes?: number;
  source: AttachmentSource;
}

export interface ChatSessionDetail {
  sessionId: string;
  scope: ChatSessionScope;
  /** Connection sessions only. */
  matchId?: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. */
  updatedAt: string;
  /** ISO-8601. */
  expiresAt: string;
  /** Messages in `messages` (the tier's window of the stored conversation). */
  messageCount: number;
  messages: ChatSessionMessage[];
}

/**
 * 409 `CHAT_SESSION_LIMIT_REACHED`: a new saved session would exceed the tier's cap. Before the model
 * call it lists the sessions so the app can offer a choice; a race at save time carries neither field.
 */
export interface ChatSessionLimitReachedErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
  maxSessions?: number;
  sessions?: ChatSessionSummary[];
}

export interface ChatSessionMessage {
  role: ChatSessionRole;
  content: string;
  /** ISO-8601. */
  createdAt: string;
  mood?: Mood;
  /** Files sent with this (user) turn. */
  attachments?: ChatAttachmentRef[];
}

export type ChatSessionRole = "user" | "assistant";

export type ChatSessionScope = "product" | "connection";

export interface ChatSessionSummary {
  sessionId: string;
  scope: ChatSessionScope;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. */
  updatedAt: string;
  /** ISO-8601. */
  expiresAt: string;
  messageCount: number;
}

/** 409: the request conflicts with the member's current Pro state (`code` in `error`). */
export interface ConflictErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
}

/** At least one bound; `from` is not after `to`. */
export interface ContextDateRange {
  /** ISO-8601. */
  from?: string;
  /** ISO-8601. */
  to?: string;
}

export interface ContextOptions {
  /** Default true. */
  includeProfile?: boolean;
  /** Default true. */
  includeMessageHistory?: boolean;
}

export interface ContextRequest {
  /** 1 to 8 terms, each 1 to 80 characters. */
  searchTerms: string[];
  /** 1 to `CONTEXT_REQUEST_MAX_MESSAGES` (default 8). */
  maxMessages: number;
  dateRange?: ContextDateRange;
  /** The turn's `requestId`; send it back as `contextRequestId`. */
  requestId: string;
}

/** Which context went into the answer. */
export interface ContextUsed {
  profile: boolean;
  match: boolean;
  messageHistory: boolean;
  messageCount: number;
  chatSession: boolean;
  sessionMessageCount: number;
  /** Attachments read for this turn. */
  attachmentCount?: number;
}

export interface ContinueMrOneHookProAfterMembershipRequestContent {
  billingPeriod: ProBillingPeriod;
  /** As in `PurchaseMrOneHookPro`; charged on `scheduledStartAt`, not now. */
  paymentToken?: string;
}

export interface ContinueMrOneHookProAfterMembershipResponseContent {
  plan: MrOneHookPlan;
  source: MrOneHookProSource;
  subscription?: ProSubscription;
  /** True when `PurchaseMrOneHookPro` would be accepted. */
  canPurchase: boolean;
  offers: ProOffer[];
  limits: MrOneHookPlanLimits;
  attachmentUsage?: AttachmentUsage;
  /** Newest first, at most 20. */
  notices: ProNotice[];
}

export interface EphemeralMessageContext {
  /**
   * 1 to `EPHEMERAL_CONTEXT_MAX_MESSAGES` (default 30); total text at most
   * `EPHEMERAL_CONTEXT_MAX_CHARACTERS` (default 12000).
   */
  excerpts: EphemeralMessageExcerpt[];
  historyTruncated?: boolean;
  userConfirmed?: boolean;
}

export interface EphemeralMessageExcerpt {
  speaker: ExcerptSpeaker;
  /** ISO-8601, at most 5 minutes in the future. */
  sentAt: string;
  text: string;
}

export type ExcerptSpeaker = "self" | "match";

/**
 * Mr OneHook's error body. On member routes `error` is a stable UPPER_SNAKE_CASE code; on the public
 * route it is a human-readable message.
 */
export interface ForbiddenErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
}

export type GetChatAttachmentContentOutputPayload = string;

export interface GetChatAttachmentResponseContent {
  attachment: ChatAttachment;
}

export interface GetChatSessionResponseContent {
  session: ChatSessionDetail;
}

export interface GetHealthResponseContent {
  /** Always `ok`. */
  status: string;
  /** ISO-8601. */
  timestamp: string;
}

export interface GetMrOneHookProResponseContent {
  plan: MrOneHookPlan;
  source: MrOneHookProSource;
  subscription?: ProSubscription;
  /** True when `PurchaseMrOneHookPro` would be accepted. */
  canPurchase: boolean;
  offers: ProOffer[];
  limits: MrOneHookPlanLimits;
  attachmentUsage?: AttachmentUsage;
  /** Newest first, at most 20. */
  notices: ProNotice[];
}

/**
 * Mr OneHook's error body. On member routes `error` is a stable UPPER_SNAKE_CASE code; on the public
 * route it is a human-readable message.
 */
export interface InternalServerErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
}

export interface ListChatSessionsResponseContent {
  sessions: ChatSessionSummary[];
}

/** What happened to a "find me ..." request. The prompt Mr OneHook wrote is never returned. */
export interface MatchSuggestionResult {
  status: SuggestionStatus;
  /** Why Mr OneHook is suggesting these people (1 to 280 characters). */
  reasoning: string;
}

/** 402 `MESSAGE_LIMIT_REACHED`: the free tier's daily messages are spent. */
export interface MessageLimitReachedErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
  /** Always 0. */
  remainingMessages: number;
}

/** Mr OneHook's mood, which drives the mascot's face. */
export type Mood = "Happy" | "Neutral" | "Thinking" | "Sad" | "Excited";

export type MrOneHookPlan = "FREE" | "PRO";

export interface MrOneHookPlanLimits {
  /** Messages per UTC day; absent means unlimited. */
  dailyMessages?: number;
  maxSessions: number;
  attachmentsAllowed: boolean;
  maxAttachmentBytes: number;
  maxAttachmentsPerMessage: number;
}

/** Why the member is on Pro. */
export type MrOneHookProSource = "NONE" | "SUBSCRIPTION" | "MEMBERSHIP" | "COMPLIMENTARY";

/**
 * Mr OneHook's error body. On member routes `error` is a stable UPPER_SNAKE_CASE code; on the public
 * route it is a human-readable message.
 */
export interface NotFoundErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
}

/** 413 `PAYLOAD_TOO_LARGE`: the JSON body is over 32 KB. */
export interface PayloadTooLargeErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
}

/** 402 `PAYMENT_DECLINED`: the payment provider declined the charge. Nothing was bought. */
export interface PaymentDeclinedErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
}

export type ProBillingPeriod = "MONTHLY" | "YEARLY";

export type ProEndedReason = "CANCELLED" | "PAYMENT_FAILED" | "INCLUDED_IN_MEMBERSHIP" | "CONTINUATION_WITHDRAWN" | "REFUNDED" | "PAYMENT_DECLINED";

export interface ProNotice {
  noticeId: string;
  kind: ProNoticeKind;
  /** ISO-8601. */
  createdAt: string;
  /** Refunds and charges. */
  amountMinor?: number;
  currency?: string;
  /** ISO-8601: the date the notice is about (refund date, first charge, end of Pro). */
  at?: string;
}

export type ProNoticeKind = "PRO_PURCHASED" | "PRO_RENEWED" | "PRO_RENEWAL_FAILED" | "PRO_ENDED" | "PRO_PAUSED_FOR_MEMBERSHIP" | "PRO_REFUND_SCHEDULED" | "PRO_REFUND_ISSUED" | "PRO_REFUND_CANCELLED" | "PRO_RESUMED" | "PRO_CONTINUATION_SCHEDULED" | "PRO_CONTINUATION_CANCELLED" | "PRO_CONTINUATION_STARTED" | "ATTACHMENT_USAGE_WARNING";

export interface ProOffer {
  billingPeriod: ProBillingPeriod;
  priceMinor: number;
  currency: string;
}

export interface ProRefund {
  status: ProRefundStatus;
  amountMinor: number;
  currency: string;
  /** ISO-8601: the end of the Pro month in progress when the membership started. */
  dueAt: string;
  /** ISO-8601. */
  issuedAt?: string;
}

export type ProRefundStatus = "SCHEDULED" | "ISSUED" | "CANCELLED";

export interface ProSubscription {
  status: ProSubscriptionStatus;
  billingPeriod: ProBillingPeriod;
  autoRenew: boolean;
  /** Price per period in the currency's minor unit (paise). */
  priceMinor: number;
  /** ISO 4217, e.g. `INR`. */
  currency: string;
  /** True while the membership covers Pro: nothing renews. */
  pausedForMembership: boolean;
  /** ISO-8601. */
  currentPeriodStart?: string;
  /** ISO-8601. Pro lasts until then. */
  currentPeriodEnd?: string;
  /** ISO-8601. When the next charge is due (absent when nothing will be charged). */
  nextChargeAt?: string;
  /** ISO-8601. `SCHEDULED` only: the first charge. */
  scheduledStartAt?: string;
  refund?: ProRefund;
  endedReason?: ProEndedReason;
  /** ISO-8601. */
  createdAt: string;
}

export type ProSubscriptionStatus = "PENDING" | "SCHEDULED" | "ACTIVE" | "GRACE" | "ENDED";

export interface ProductConnectionChatRequestContent {
  /**
   * Up to `CONTEXT_MAX_INPUT_CHARACTERS` (default 4000) characters; trimmed. Must not be blank unless
   * `attachmentIds` is present: files sent without text become the turn "Please look at the attached
   * files." (saved and shown as the user's message).
   */
  message: string;
  /** Present: a connection chat about this match (1 to 256 characters). Absent: a product chat. */
  matchId?: string;
  contextOptions?: ContextOptions;
  ephemeralMessageContext?: EphemeralMessageContext;
  /** UUID of a `contextRequest` this turn answers. */
  contextRequestId?: string;
  sessionOptions?: SessionOptions;
  /** Up to 3 `READY` attachments (Mr OneHook Pro). Files from a match chat need the same `matchId`. */
  attachmentIds?: string[];
}

export interface ProductConnectionChatResponseContent {
  /** 1 to 8000 characters. */
  reply: string;
  mood: Mood;
  /** Connection chats only: Mr OneHook needs more of the conversation; `contextRequest` says what. */
  needsMoreContext?: boolean;
  contextRequest?: ContextRequest;
  /** Free tier only: messages left today after this one. */
  remainingMessages?: number;
  matchSuggestion?: MatchSuggestionResult;
  contextUsed: ContextUsed;
  /** UUID of this turn. */
  requestId: string;
  session?: SavedSessionRef;
  /** Saved sessions deleted to make room for this new one (least recently active first). */
  evictedSessionIds?: string[];
  plan?: MrOneHookPlan;
}

export interface PublicChatMessage {
  role: PublicChatRole;
  content: string;
}

export type PublicChatRole = "system" | "user" | "assistant";

export interface PublicProductChatRequestContent {
  /** The conversation so far; the last message is the visitor's. */
  messages: PublicChatMessage[];
  userDemographics?: UserDemographics;
  /** Bot trap: must be absent or empty. */
  honeypot?: string;
}

export interface PublicProductChatResponseContent {
  reply: string;
  mood: Mood;
}

export interface PurchaseMrOneHookProRequestContent {
  billingPeriod: ProBillingPeriod;
  /**
   * The payment provider's token for this purchase. The App Store provider takes the StoreKit 2 signed
   * transaction (bought with `appAccountToken` = the member's Cognito `sub`); the gamma test provider
   * takes `fake-ok`, `fake-decline` or `fake-decline-renewal`.
   */
  paymentToken?: string;
}

export interface PurchaseMrOneHookProResponseContent {
  plan: MrOneHookPlan;
  source: MrOneHookProSource;
  subscription?: ProSubscription;
  /** True when `PurchaseMrOneHookPro` would be accepted. */
  canPurchase: boolean;
  offers: ProOffer[];
  limits: MrOneHookPlanLimits;
  attachmentUsage?: AttachmentUsage;
  /** Newest first, at most 20. */
  notices: ProNotice[];
}

export interface SavedSessionRef {
  sessionId: string;
  /** ISO-8601. */
  updatedAt: string;
  /** ISO-8601. */
  expiresAt: string;
  messageCount: number;
}

/**
 * Mr OneHook's error body. On member routes `error` is a stable UPPER_SNAKE_CASE code; on the public
 * route it is a human-readable message.
 */
export interface ServiceUnavailableErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
}

/** Every signed-in member may save sessions; the plan sets how many (Free 1, Pro 3). */
export interface SessionOptions {
  /** Start a saved session. */
  persist?: boolean;
  /** Continue this saved session (UUID). Cannot be combined with `persist: false`. */
  sessionId?: string;
  /**
   * Deprecated and ignored: at the plan's cap the least recently active session is always replaced
   * (see `evictedSessionIds`).
   */
  replaceLeastRecent?: boolean;
}

export type SuggestionStatus = "RECORDED" | "PREMIUM_REQUIRED" | "MATCHING_OFF" | "UNAVAILABLE";

/**
 * Mr OneHook's error body. On member routes `error` is a stable UPPER_SNAKE_CASE code; on the public
 * route it is a human-readable message.
 */
export interface TooManyRequestsErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
  /** ISO-8601, `ATTACHMENT_PROCESSING_UNAVAILABLE` only: when files can be processed again. */
  retryAt?: string;
}

/**
 * Mr OneHook's error body. On member routes `error` is a stable UPPER_SNAKE_CASE code; on the public
 * route it is a human-readable message.
 */
export interface UnauthorizedErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
}

/** 415 `UNSUPPORTED_ATTACHMENT_TYPE`: the bytes are not a supported file type. */
export interface UnsupportedMediaTypeErrorResponseContent {
  error: string;
  /** The turn's id, on `ProductConnectionChat` errors. */
  requestId?: string;
}

export interface UpdateMrOneHookProAutoRenewRequestContent {
  autoRenew: boolean;
}

export interface UpdateMrOneHookProAutoRenewResponseContent {
  plan: MrOneHookPlan;
  source: MrOneHookProSource;
  subscription?: ProSubscription;
  /** True when `PurchaseMrOneHookPro` would be accepted. */
  canPurchase: boolean;
  offers: ProOffer[];
  limits: MrOneHookPlanLimits;
  attachmentUsage?: AttachmentUsage;
  /** Newest first, at most 20. */
  notices: ProNotice[];
}

/** The file, 1 byte to 5 MiB. */
export type UploadChatAttachmentInputPayload = string;

export interface UploadChatAttachmentResponseContent {
  attachment: ChatAttachment;
}

export interface UserDemographics {
  gender?: string;
  sexualPreference?: string;
}
