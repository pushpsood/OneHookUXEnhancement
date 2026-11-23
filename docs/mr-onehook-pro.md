# Mr OneHook Pro

Mr OneHook Pro is a subscription of its own, separate from the OneHook membership. This document covers
the plans, the Pro subscription and its edge cases, attachments, what OneHookBackend (State) must provide,
and what the apps must do. The code is in `backend/src/pro*.ts`, `backend/src/attachment*.ts` and
`backend/src/membershipDirectory.ts` with `backend/src/stateMembershipClient.ts`; the API is
`sdk/model/mr-onehook.smithy`.

## Plans

| Plan | Who | Messages | Saved sessions | New session at the cap | Attachments |
|---|---|---|---|---|---|
| Free | Must and Super members | 10 per UTC day | 1 | Replaces the existing one | Can be selected in the apps; sending needs Pro (`403 PRO_REQUIRED`) |
| Pro | A Pro subscription, or a membership tier in `MR_ONEHOOK_PRO_INCLUDED_TIERS` (Infinity) | Unlimited (20 requests/minute) | 3 | Deletes the least recently active one | Up to 3 per message, 5 MiB each, within a monthly processing allowance |

How a request gets its plan (`ProSubscriptionService.entitlement`):

1. The Cognito ID token is verified (signature, issuer, audience, expiry). If its tier is an included tier,
   the member is Pro. Nothing is looked up.
2. Otherwise the member's row in the `mronehookpro` table is read. ACTIVE (within the period) or GRACE is Pro.
3. A "Keep Pro" scheduled after a membership that ended early gives Pro until its start date
   (`source: COMPLIMENTARY`).
4. Anything else is Free. If the table cannot be read, the request fails with 503. It never falls back to
   Free, because that would cost a paying member messages and saved sessions.

Saved sessions: when a new session would go over the plan's cap, the least recently active sessions are
deleted right before the new one is saved, and the response lists them in `evictedSessionIds`. A failed
model call or a clarification (`needsMoreContext`) deletes nothing. Sessions the member deleted have already
freed their slot. After a downgrade, old sessions can still be continued; the next new session trims down
to the cap. `sessionOptions.replaceLeastRecent` is still accepted and ignored.

## The Pro subscription

Prices (`MR_ONEHOOK_PRO_PRICES`, paise): Rs 799 per month, Rs 5,999 per year.

| Status | Meaning |
|---|---|
| `PENDING` | The first charge is in flight. A retry with the same `Idempotency-Key`, or the renewal job, finishes it without charging twice |
| `ACTIVE` | Paid until `currentPeriodEnd`; renews then when `autoRenew` is on |
| `GRACE` | A renewal was declined: Pro continues, the charge is retried once a day, and Pro ends after 3 days |
| `SCHEDULED` | "Keep Pro" after the membership: the first charge is on `scheduledStartAt` |
| `ENDED` | See `endedReason`: `CANCELLED`, `PAYMENT_FAILED`, `PAYMENT_DECLINED`, `INCLUDED_IN_MEMBERSHIP`, `REFUNDED`, `CONTINUATION_WITHDRAWN` |

Money moves in two places only: a purchase, and the renewal job (`runDue`, every 5 minutes on every instance).
Every charge and refund first writes a ledger row (`ledger:charge:<subscription>:<period>:<attempt>`,
insert-if-absent). The provider idempotency key is derived from that row, so two instances, a crash or a
retry can never charge one period twice. Due rows are leased with an ETag, so only one instance works on a
row at a time.

### Rules for a membership that includes Pro

- **Buying Pro with such a membership:** refused with `409 PRO_INCLUDED_IN_MEMBERSHIP`. The provider is
  never called. For 24 hours after a handover the token may still show the old tier, so a purchase in that
  window asks State first.
- **A renewal, or the first charge of a kept plan:** State is asked first whether the membership covers Pro
  now. If it does, nothing is charged. If State cannot answer, the job waits 15 minutes and asks again; it
  never charges blindly. Pro continues for up to 6 hours past the period end while a renewal is waiting.
- **A refund:** the job checks with State that the member is still an active holder right before refunding.

### The membership starts (handover)

State keeps the membership upgrade pending and sends `MrOneHookProHandoverRequested`. Mr OneHook settles
the member's Pro subscription, confirms, and only then does State finalize the membership.

| Pro subscription | What the handover does |
|---|---|
| None, or ended | Nothing to settle; confirmed at once |
| Monthly, `ACTIVE` | Stops renewing. The month already paid is not refunded: the membership covers it regardless. At the period end the subscription ends if the member still holds the membership. If not, it resumes with the member's earlier auto-renew choice |
| Yearly, `ACTIVE` | Stops renewing. The Pro month in progress is kept. The remaining whole months (price x months / 12) are refunded at the end of that month, if the member still holds the membership then. If they don't, the refund is cancelled and the yearly plan continues |
| `GRACE` | Retries stop and the subscription ends. Nothing is refunded |
| `PENDING` | The event is retried later (redelivered), after the charge settles |
| A scheduled "Keep Pro" | Cancelled; nothing is charged |

The member is told about each of these through notices (`GET /api/member/mr-onehook-pro`, `notices`):
`PRO_PAUSED_FOR_MEMBERSHIP`, `PRO_REFUND_SCHEDULED` (amount and date), `PRO_REFUND_ISSUED`,
`PRO_REFUND_CANCELLED`, `PRO_RESUMED`, `PRO_ENDED`. Each notice is written once.

### The membership is cancelled: "Keep Mr OneHook Pro"

`PUT /api/member/mr-onehook-pro/continuation` (with an `Idempotency-Key`) while the membership is set to end.
The end date comes from State, never from the app. Nothing is charged now.

| Then | What happens |
|---|---|
| The membership ends on its date | First charge on that date (`PRO_CONTINUATION_STARTED`) |
| It ends earlier (cancellation, failed payment, admin, override expiry) | Pro stays free until the original date, then the first charge |
| It ends by refund or chargeback | No free period: Pro starts and is charged now |
| The member renews the membership before the date | The kept plan is cancelled; nothing is charged |
| The member withdraws it (`DELETE .../continuation`) before the date | Cancelled; nothing is charged. After the first charge: `409 CONTINUATION_ALREADY_STARTED` (turn auto-renew off instead) |
| A paused yearly plan resumes because the membership ended within its refund window | The kept plan is not needed and is cancelled: never two plans at once |

### Account deletion

The erasure worker deletes the Pro subscription, kept plan, notices and allowance rows, plus every attachment
blob. Ledger rows stay for accounting; they hold amounts and opaque ids only, no member id. Once the
subscription row is gone the job cannot find the member, so nothing renews.

## Payments

All charges go through `ProPaymentProvider` (`backend/src/proPayments.ts`). The interface follows StoreKit 2,
which iOS must use for in-app digital subscriptions: a purchase carries the provider's proof (the signed
transaction, bought with `appAccountToken` = the Cognito `sub`), and the provider returns a stable
transaction id. `capabilities` says whether the server may renew and refund. The App Store renews by
itself and only Apple can refund, so an App Store provider would record renewals from App Store Server
Notifications, and its yearly refunds need an operator: the job logs `pro.refund_manual_required` and never
marks those refunds issued.

Only `FakeProPaymentProvider` exists today. It moves no money and records every attempt. Test tokens:
`fake-ok`, `fake-decline` (the purchase is declined), `fake-decline-renewal` (renewals are declined) and
`fake-error` (the provider is down). Config refuses it in prod (`ONEHOOK_STAGE=prod`), and so does the
Terraform variable validation.

## Attachments

Upload `POST /api/member/product-connection-chat/attachments` with the raw file as the body, `Content-Type`,
and `X-Attachment-Name` (percent-encoded). The answer is `202 PROCESSING`. Poll
`GET .../attachments/:id`, which has its own limit of 60 per minute, until `READY`, then send the id in
`attachmentIds`. Checks run cheapest first, before the body is read: token, rate limit, plan. Then the
body (5 MiB cap, `413 ATTACHMENT_TOO_LARGE`), the type from the bytes (`415`), the match, and the
allowance.

| Kind | Detected by | Read with |
|---|---|---|
| Image: png, jpeg, gif, webp | magic bytes | gpt-4o vision: a full description plus every visible text |
| Image: heic | ISO BMFF brand | Document Intelligence (text only; the apps send JPEG where they can) |
| Document: pdf, docx, xlsx, pptx | `%PDF`, or a ZIP central directory (word/, xl/, ppt/) | Document Intelligence `prebuilt-read`, up to 50 pages |
| Text: txt, md, csv, tsv, vtt, srt, json | valid UTF-8 without NUL | decoded |
| Audio: mp3, m4a, wav, ogg, flac, webm | magic bytes | transcription deployment |
| Video: mp4, mov, webm | magic bytes / brand | the sound is transcribed; with `FFMPEG_PATH`, 6 keyframes are also described |

Refused: anything else, including executables under any name, ZIPs that are not Office files, archives
whose directory claims more than 200 MB or 5,000 entries, and raw AAC.

Extracted text goes into the prompt as untrusted data, at most 12,000 characters per file and 24,000 per
turn. A saved session keeps a reference and a 1,500-character excerpt of each upload, so later turns still
know what the file said. The bytes move to `attachments/saved/` and are deleted with the session, or when
its turn slides out of the window. Unsent uploads expire after a day.

**Files from a match chat.** The app decrypts a selected file on the device and uploads it with
`X-Attachment-Match-Id` and `X-Attachment-Sender` (`self` or `match`). The match is authorized. A file the
other person sent needs `messageHistoryAllowed`, and the turn must have `includeMessageHistory`. The file
can be used for one turn of that connection chat, then it is deleted. The saved session names it but keeps
neither an id nor any of its content. This keeps the rule that match content is never mirrored in Azure.

**The public homepage chat** never takes files: an `attachmentIds`/`attachments` field, or a
non-text message part, is a 400.

### Processing allowance

Chat stays unlimited, but reading files costs money, so each Pro member has a monthly allowance
(`ATTACHMENT_MONTHLY_BUDGET_MINOR`). The default is Rs 400 of Azure cost, for both a subscription and a
membership. That is below Rs 799 net of GST (Rs 677) and app store fees. Each upload first reserves its
worst-case cost (by kind and size), and the measured cost (tokens, pages, audio minutes, at
`ATTACHMENT_COST_RATES`) settles the reservation. This stops concurrent uploads from overshooting the
allowance. A burst limit also applies: 10 files per 10 minutes. Over either limit, the upload gets
`429 ATTACHMENT_PROCESSING_UNAVAILABLE` with `retryAt`, and chat carries on. Crossing 80% writes an
`ATTACHMENT_USAGE_WARNING` notice once a month. Typical costs: an image is about Rs 0.30, and a 5-minute
voice note about Rs 2.50.

## The OneHookBackend side

Built in OneHookBackend (State, the Matching stack and the API model), branch `feat/mr-onehook-pro`:

1. **The upgrade is held.** When a billing change (`SubscriptionChanged`, `POST /state/upgrade`) or an
   operator grant moves a member from a tier without Pro into one with it, State does not apply it.
   It writes a hold on the member's item (`pro_handover_*`) together with a `MrOneHookProHandoverRequested`
   outbox row, in one transaction. The tier, capacity and Cognito claim stay as they were, and
   `GET /state/{userId}` shows `pendingSubscriptionTier`. A newer change of the same kind refreshes the
   hold and keeps its activation id. A newer billing change that no longer leads into Pro drops the hold.
   Renewals within a Pro tier are never held. This is gated per stage by `MR_ONEHOOK_PRO_HANDOVER_ENABLED`
   (gamma only, `infra/config/mr-onehook.ts`). `MR_ONEHOOK_PRO_TIERS` is built from the generated
   membership catalog.
2. **The event** `MrOneHookProHandoverRequested` (source `onehook.state`) carries
   `{ userId, activationId, tier, requestedAt }`. It reaches the SQS queue
   `OneHook-Matching-<stage>-MrOneHookEntitlements`, which has a DLQ after 5 receives and an alarm. The
   stack output `MrOneHookEntitlementsQueueUrl` goes into `mr_onehook_entitlement_queue_url`. The hourly
   State sweep republishes a hold that has gone unconfirmed for 15 minutes. After an hour it emits
   `OneHook/State::MrOneHookProHandoverStuck`, and the `MrOneHookProHandoverStuck` alarm pages.
3. **IAM-only operations**, called through `stateMembershipClient.ts`:
   - `GET /state/internal/users/{targetUserId}/membership` returns `{ userId, tier, endsAt?, lastEnded?, pendingHandover? }`
     in epoch seconds. `endsAt` is the operator grant's expiry, or the paid period end when the
     subscription is cancelled at period end.
   - `POST /state/internal/users/{targetUserId}/mr-onehook-pro-handovers/{activationId}/confirmation`
     returns `APPLIED`, `ALREADY_APPLIED` or `NOT_PENDING`. It replays the held change (the billing
     apply with its original watermark, or the operator grant), then clears the hold.
4. **How tiers end.** `SubscriptionChanged` has new optional fields `currentPeriodEnd`,
   `cancelAtPeriodEnd` and `endReason`. Every drop in tier records `lastEnded` with a reason: the
   producer's `EXPIRED`, `CANCELLED`, `PAYMENT_FAILED`, `REFUNDED` or `CHARGEBACK`; `OVERRIDE_EXPIRED` or
   `OVERRIDE_CLEARED` for operator grants; `DOWNGRADED` otherwise.
5. **The role** `OneHook-MrOneHook-<stage>-Role` may invoke the two routes and consume the queue, and
   nothing more.

Still outside these repos: the Payments producer of `SubscriptionChanged`. It must send `currentPeriodEnd`,
`cancelAtPeriodEnd` and `endReason`. Until it exists, gamma tests drive the handover with operator grants
(`PUT /state/admin/users/{id}/tier-override`, whose expiry is `endsAt`) or hand-published
`SubscriptionChanged` events.

## What the apps must do

- Show the plan from `GET /api/member/mr-onehook-pro` (`plan`, `source`, `limits`, `canPurchase`, `offers`,
  `notices`). Show `evictedSessionIds` instead of the old 409 "choose a session" dialog.
- Free: let members select files, and turn "Ask Mr OneHook" into "Get Mr OneHook Pro". Pro: upload, poll,
  send. Show `429 ATTACHMENT_PROCESSING_UNAVAILABLE` as "Files can't be processed right now because of heavy
  usage. You can keep chatting." Convert HEIC to JPEG before uploading where possible.
- In the cancel flow of a membership that includes Pro, offer "Keep Mr OneHook Pro after <endsAt>" with the
  first charge date, and show "Activating your membership" while State waits for the handover.
- Membership members see "Included with Infinity" and no buy button.
- iOS buys through StoreKit 2 with `appAccountToken` = the Cognito `sub`, once the App Store provider exists.

## Testing

- `npm test` (backend) covers the money rules on a hand-moved clock (`proSubscription.test.ts`); file
  types, the allowance, extraction, storage and the match-chat flow (`attachments.test.ts`); the handover
  worker; plan-based sessions; and the contract test, in which every declared response of every operation
  is produced and checked against the model.
- `npm run test:e2e` runs the whole journey through the HTTP app on Azurite, which gives real conditional
  blob writes, Table ETags and cross-partition queries. A Super member on Free buys Pro, double taps
  charge once, three sessions with LRU eviction, files are read, kept with the session and deleted with it,
  the membership handover stops renewals, "Keep Pro" with an early end gets a free period and then one
  yearly charge, a membership member gets the overuse refusal, the homepage chat refuses files, and account
  erasure runs. CI runs both before every deploy.
