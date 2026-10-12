import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentityProvider } from '@smithy/types';
import type { RequestSigner } from './oneHookDataClient';

/**
 * Signs outbound data-API requests with AWS SigV4 for {@code execute-api}.
 *
 * <p>The OneHook AWS backend authorizes the AI-context projection route with
 * {@code AuthorizationType: AWS_IAM}, so the Azure UX backend must present a SigV4 signature, not an
 * OAuth bearer token. Credentials are resolved from the standard AWS Node provider chain
 * ({@code fromNodeProviderChain}): environment variables, shared config, or — in production — a
 * web-identity token file the host exchanges for a role (the recommended way to avoid long-lived
 * keys on the App Service). The IAM principal those credentials resolve to must be granted
 * {@code execute-api:Invoke} on the ai-context route.</p>
 *
 * <p>Signing is per-request and includes the body hash; this endpoint is a bodyless GET, so the
 * empty-payload hash is used. The signer adds {@code Authorization}, {@code X-Amz-Date}, and (for
 * temporary credentials) {@code X-Amz-Security-Token}. {@code X-OneHook-User-Id} is part of the
 * signed header set, so it cannot be tampered with in transit.</p>
 */
export class SigV4RequestSigner implements RequestSigner {
  private readonly signer: SignatureV4;

  constructor(
    region: string,
    service = 'execute-api',
    credentials: AwsCredentialIdentityProvider = fromNodeProviderChain(),
  ) {
    this.signer = new SignatureV4({
      service,
      region,
      credentials,
      sha256: Sha256,
    });
  }

  async sign(request: {
    method: string;
    url: URL;
    headers: Record<string, string>;
  }): Promise<Record<string, string>> {
    // API Gateway requires the Host header in the signed set; SignatureV4 derives it from hostname.
    const httpRequest = new HttpRequest({
      method: request.method,
      protocol: request.url.protocol,
      hostname: request.url.hostname,
      ...(request.url.port ? { port: Number(request.url.port) } : {}),
      path: request.url.pathname,
      query: Object.fromEntries(request.url.searchParams.entries()),
      headers: {
        ...request.headers,
        host: request.url.host,
      },
    });

    const signed = await this.signer.sign(httpRequest);
    // Return a plain header record for fetch(); strip any undefined values defensively.
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(signed.headers)) {
      if (typeof value === 'string') result[key] = value;
    }
    return result;
  }
}
