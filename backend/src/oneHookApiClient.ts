import { OneHook } from 'onehook-api-client';
import { HttpRequest, HttpResponse } from '@smithy/protocol-http';
import type { RequestSigner } from './oneHookDataClient';

/**
 * The generated OneHook backend client (`onehook-api-client`, built from OneHookBackend's Smithy model) that
 * every call this service makes to the OneHook backend goes through. Nothing here builds a URL or a body:
 * the SDK serializes each operation from the model, and this module only adds the two things the SDK leaves
 * to the caller:
 *
 *  - SigV4. The internal routes are `AWS_IAM`, so the serialized request is signed with {@link RequestSigner}
 *    (in production {@link SigV4RequestSigner}, credentials from the Azure managed identity exchanged for the
 *    federated AWS role) as the last step before it is sent.
 *  - The transport. Requests are sent with `fetchImpl` (the global `fetch` by default) and abort after
 *    `timeoutMs`; tests inject a fake `fetchImpl`. One attempt only: the callers decide what a failure means.
 *
 * The contract test (`__tests__/apiContract.test.ts`) fails on any other outbound HTTP call, and on an SDK
 * operation this service calls that is not an `auth: iam` operation of the backend manifest.
 */
export interface OneHookApiOptions {
  /** The backend base URL (custom domain or execute-api URL including the stage). */
  baseUrl: string;
  signer: RequestSigner;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** Signing failed (e.g. no resolvable AWS credentials): nothing was sent. */
export class OneHookSigningError extends Error {}

/** The HTTP status of a failed SDK call, or undefined when no response arrived (signing, network). */
export function httpStatusOf(error: unknown): number | undefined {
  const status = (error as { $metadata?: { httpStatusCode?: unknown } } | undefined)?.$metadata?.httpStatusCode;
  return typeof status === 'number' ? status : undefined;
}

/** The machine `code` of a OneHook error body (`{error, code}`), if the failed call carried one. */
export function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Headers the SDK adds for AWS retry bookkeeping; the OneHook backend does not read them. */
const SDK_ONLY_HEADERS = /^(amz-sdk-invocation-id|amz-sdk-request|x-amz-user-agent)$/i;

function urlOf(request: HttpRequest): URL {
  const url = new URL(`${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ''}${request.path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    for (const v of Array.isArray(value) ? value : [value]) if (v !== null && v !== undefined) url.searchParams.append(key, v);
  }
  return url;
}

export function createOneHookApiClient({ baseUrl, signer, timeoutMs, fetchImpl = fetch }: OneHookApiOptions): OneHook {
  const client = new OneHook({
    endpoint: baseUrl,
    maxAttempts: 1,
    // The model declares `@sigv4` (signing name `onehook`), but API Gateway verifies `execute-api` signatures:
    // the SDK's own signer is removed below and `signer` signs instead. The SDK's auth resolver still needs a
    // region and a credentials provider to run, so both are placeholders that are never used.
    region: 'unused',
    credentials: async () => ({ accessKeyId: 'unused', secretAccessKey: 'unused' }),
    requestHandler: {
      async handle(request: HttpRequest) {
        const response = await fetchImpl(urlOf(request).toString(), {
          method: request.method,
          headers: request.headers,
          ...(request.body !== undefined && request.body !== null ? { body: request.body as string } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const headers: Record<string, string> = {};
        response.headers?.forEach?.((value, key) => {
          headers[key] = value;
        });
        return {
          response: new HttpResponse({
            statusCode: response.status,
            headers,
            body: new Uint8Array(await response.arrayBuffer()),
          }),
        };
      },
    },
  });
  client.middlewareStack.remove('httpSigningMiddleware');
  client.middlewareStack.add(
    (next) => async (args) => {
      const request = args.request;
      if (HttpRequest.isInstance(request)) {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(request.headers)) if (!SDK_ONLY_HEADERS.test(key)) headers[key] = value;
        try {
          request.headers = await signer.sign({
            method: request.method,
            url: urlOf(request),
            headers,
            ...(typeof request.body === 'string' ? { body: request.body } : {}),
          });
        } catch (error: unknown) {
          throw new OneHookSigningError(`Failed to sign request: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
      }
      return next(args);
    },
    { step: 'finalizeRequest', name: 'oneHookSigV4', priority: 'low' },
  );
  return client;
}
