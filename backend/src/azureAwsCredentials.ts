import { STSClient, AssumeRoleWithWebIdentityCommand } from '@aws-sdk/client-sts';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types';
import type { TokenCredential } from '@azure/identity';

/**
 * Builds an AWS credential provider that exchanges an Azure Entra ID token (minted by the Azure
 * App Service's managed identity) for temporary AWS credentials via STS
 * {@code AssumeRoleWithWebIdentity}.
 *
 * <h2>Why this exists</h2>
 * <p>The OneHook AWS backend authorizes the AI-context route with {@code AWS_IAM}, so the Azure UX
 * backend must present AWS SigV4 — but an Azure managed identity cannot natively mint AWS
 * credentials. This provider bridges the two clouds without any long-lived AWS access keys on the
 * App Service: the managed identity gets an Entra token for a dedicated audience, and an AWS IAM
 * role (whose OIDC trust is scoped to that audience + this exact managed identity) is assumed to
 * yield short-lived AWS credentials.</p>
 *
 * <h2>Caching / refresh</h2>
 * <p>The returned provider caches the assumed credentials and only re-exchanges when they are within
 * {@code refreshWindowMs} of expiry. The AWS SDK calls the provider per signing operation, so this
 * avoids an Entra + STS round-trip on every request while still refreshing before expiry. Any
 * failure propagates to the caller (the data client maps it to an "unavailable" match, never to a
 * silent unauthenticated call).</p>
 *
 * @param options.credential  the Azure token source (production: DefaultAzureCredential → managed identity)
 * @param options.audience    the Entra audience/scope the role's OIDC trust expects (e.g. api://<appId>)
 * @param options.roleArn     the AWS IAM role ARN to assume
 * @param options.region      STS region used for the exchange
 * @param options.roleSessionName optional session name recorded in CloudTrail
 * @param options.stsClient   injectable STS client (tests)
 * @param options.refreshWindowMs re-exchange when within this many ms of expiry (default 5 min)
 */
export function createAzureWebIdentityCredentialProvider(options: {
  credential: TokenCredential;
  audience: string;
  roleArn: string;
  region: string;
  roleSessionName?: string;
  stsClient?: STSClient;
  refreshWindowMs?: number;
}): AwsCredentialIdentityProvider {
  const {
    credential,
    audience,
    roleArn,
    region,
    roleSessionName = 'onehook-ux-aicontext',
    refreshWindowMs = 5 * 60_000,
  } = options;
  // The scope form `<audience>/.default` is what @azure/identity expects; the resulting token's
  // `aud` claim is the audience, which the AWS role's OIDC condition matches.
  const scope = audience.endsWith('/.default') ? audience : `${audience}/.default`;
  const sts = options.stsClient ?? new STSClient({ region });

  let cached: AwsCredentialIdentity | undefined;

  return async (): Promise<AwsCredentialIdentity> => {
    const now = Date.now();
    if (cached?.expiration && cached.expiration.getTime() - refreshWindowMs > now) {
      return cached;
    }

    const azureToken = await credential.getToken(scope);
    if (!azureToken?.token) {
      throw new Error('Azure managed identity returned no token for the AWS web-identity audience');
    }

    const result = await sts.send(new AssumeRoleWithWebIdentityCommand({
      RoleArn: roleArn,
      RoleSessionName: roleSessionName,
      WebIdentityToken: azureToken.token,
    }));

    const c = result.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
      throw new Error('STS AssumeRoleWithWebIdentity returned incomplete credentials');
    }

    cached = {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      ...(c.Expiration ? { expiration: c.Expiration } : {}),
    };
    return cached;
  };
}
