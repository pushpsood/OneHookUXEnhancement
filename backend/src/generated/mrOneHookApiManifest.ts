// GENERATED FILE - DO NOT EDIT.
// Source of truth: OneHookUXEnhancement/sdk/model/*.smithy, published as onehook-mr-onehook-client.
// Regenerate: (OneHookUXEnhancement/sdk) npm run build && npm run manifest:sync.
// iOS / Android copies: pulled from onehook-mr-onehook-client (manifest/) by OneHookPlatform scripts/sync-api-specs.mjs.
/* eslint-disable */

export type ApiAuth = 'cognito' | 'none' | 'session';

export interface ApiOperation {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly service: string;
  readonly auth: ApiAuth;
}

/** Every HTTP operation of onehook-mr-onehook-client, sorted by service, path, method. */
export const API_OPERATIONS: readonly ApiOperation[] = [
  { operationId: "ProductConnectionChat", method: "POST", path: "/api/member/product-connection-chat", service: "mr-onehook", auth: "cognito" },
  { operationId: "ListChatSessions", method: "GET", path: "/api/member/product-connection-chat/sessions", service: "mr-onehook", auth: "cognito" },
  { operationId: "DeleteChatSession", method: "DELETE", path: "/api/member/product-connection-chat/sessions/{sessionId}", service: "mr-onehook", auth: "cognito" },
  { operationId: "GetChatSession", method: "GET", path: "/api/member/product-connection-chat/sessions/{sessionId}", service: "mr-onehook", auth: "cognito" },
  { operationId: "PublicProductChat", method: "POST", path: "/api/public/product-chat", service: "mr-onehook", auth: "none" },
  { operationId: "GetHealth", method: "GET", path: "/health", service: "mr-onehook", auth: "none" },
];
