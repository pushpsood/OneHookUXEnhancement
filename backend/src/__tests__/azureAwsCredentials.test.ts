import test from 'node:test';
import assert from 'node:assert/strict';
import { createAzureWebIdentityCredentialProvider } from '../azureAwsCredentials';

// Minimal fake STS client capturing the AssumeRoleWithWebIdentity input and returning creds.
function fakeSts(onSend: (input: Record<string, unknown>) => unknown) {
  return {
    send: async (command: { input: Record<string, unknown> }) => onSend(command.input),
  } as unknown as import('@aws-sdk/client-sts').STSClient;
}

const futureExpiry = new Date(Date.now() + 3600_000);

test('exchanges the Azure token for AWS credentials via AssumeRoleWithWebIdentity', async () => {
  let seenToken: string | undefined;
  let seenRole: string | undefined;
  const provider = createAzureWebIdentityCredentialProvider({
    credential: { getToken: async () => ({ token: 'azure-mi-token', expiresOnTimestamp: Date.now() + 3600_000 }) },
    audience: 'api://8a078d5e',
    roleArn: 'arn:aws:iam::627367419734:role/OneHook-UX-AiContext-gamma',
    region: 'ap-south-1',
    stsClient: fakeSts((input) => {
      seenToken = input.WebIdentityToken as string;
      seenRole = input.RoleArn as string;
      return {
        Credentials: {
          AccessKeyId: 'ASIA_TEST',
          SecretAccessKey: 'secret',
          SessionToken: 'session',
          Expiration: futureExpiry,
        },
      };
    }),
  });

  const creds = await provider();
  assert.equal(seenToken, 'azure-mi-token');
  assert.equal(seenRole, 'arn:aws:iam::627367419734:role/OneHook-UX-AiContext-gamma');
  assert.equal(creds.accessKeyId, 'ASIA_TEST');
  assert.equal(creds.secretAccessKey, 'secret');
  assert.equal(creds.sessionToken, 'session');
  assert.equal(creds.expiration?.getTime(), futureExpiry.getTime());
});

test('requests the audience as an OAuth scope (/.default)', async () => {
  let seenScope: string | undefined;
  const provider = createAzureWebIdentityCredentialProvider({
    credential: {
      getToken: async (scope) => {
        seenScope = Array.isArray(scope) ? scope[0] : scope;
        return { token: 't', expiresOnTimestamp: Date.now() + 3600_000 };
      },
    },
    audience: 'api://8a078d5e',
    roleArn: 'arn:aws:iam::1:role/r',
    region: 'ap-south-1',
    stsClient: fakeSts(() => ({
      Credentials: { AccessKeyId: 'a', SecretAccessKey: 'b', SessionToken: 'c', Expiration: futureExpiry },
    })),
  });
  await provider();
  assert.equal(seenScope, 'api://8a078d5e/.default');
});

test('caches credentials until near expiry (no repeated STS calls)', async () => {
  let stsCalls = 0;
  const provider = createAzureWebIdentityCredentialProvider({
    credential: { getToken: async () => ({ token: 't', expiresOnTimestamp: Date.now() + 3600_000 }) },
    audience: 'api://x',
    roleArn: 'arn:aws:iam::1:role/r',
    region: 'ap-south-1',
    stsClient: fakeSts(() => {
      stsCalls += 1;
      return { Credentials: { AccessKeyId: 'a', SecretAccessKey: 'b', SessionToken: 'c', Expiration: futureExpiry } };
    }),
  });
  await provider();
  await provider();
  assert.equal(stsCalls, 1, 'second call should use the cached credentials');
});

test('throws (fails closed) when STS returns incomplete credentials', async () => {
  const provider = createAzureWebIdentityCredentialProvider({
    credential: { getToken: async () => ({ token: 't', expiresOnTimestamp: Date.now() + 3600_000 }) },
    audience: 'api://x',
    roleArn: 'arn:aws:iam::1:role/r',
    region: 'ap-south-1',
    stsClient: fakeSts(() => ({ Credentials: { AccessKeyId: 'a' } })),
  });
  await assert.rejects(() => provider(), /incomplete credentials/);
});

test('throws when the Azure identity yields no token', async () => {
  const provider = createAzureWebIdentityCredentialProvider({
    credential: { getToken: async () => null },
    audience: 'api://x',
    roleArn: 'arn:aws:iam::1:role/r',
    region: 'ap-south-1',
    stsClient: fakeSts(() => ({})),
  });
  await assert.rejects(() => provider(), /no token/);
});
