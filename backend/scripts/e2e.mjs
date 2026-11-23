#!/usr/bin/env node
/**
 * End-to-end tests against real Azure Storage semantics: starts Azurite (the Azure Storage emulator,
 * in memory, on free local ports), runs dist/__tests__/e2e/*.test.js with its connection string, then
 * stops it. Nothing leaves the machine; no Azure account is needed. Run `npm run build` first
 * (`npm run test:e2e` does).
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(port, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`Azurite did not start on port ${port}`);
}

const [blobPort, queuePort, tablePort] = [await freePort(), await freePort(), await freePort()];
const azurite = spawn(join(root, 'node_modules/.bin/azurite'), [
  '--inMemoryPersistence', '--silent', '--skipApiVersionCheck', '--loose',
  '--blobHost', '127.0.0.1', '--blobPort', String(blobPort),
  '--queueHost', '127.0.0.1', '--queuePort', String(queuePort),
  '--tableHost', '127.0.0.1', '--tablePort', String(tablePort),
], { stdio: ['ignore', 'inherit', 'inherit'] });

let code = 1;
try {
  await Promise.all([waitFor(blobPort), waitFor(tablePort)]);
  // Azurite's well-known development account (public, documented; not a secret).
  const account = 'devstoreaccount1';
  const key = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
  const connection = [
    'DefaultEndpointsProtocol=http', `AccountName=${account}`, `AccountKey=${key}`,
    `BlobEndpoint=http://127.0.0.1:${blobPort}/${account}`, `TableEndpoint=http://127.0.0.1:${tablePort}/${account}`,
  ].join(';');
  const dir = join(root, 'dist/__tests__/e2e');
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.js')).map((f) => join(dir, f));
  const run = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    stdio: 'inherit',
    env: { ...process.env, AZURITE_CONNECTION_STRING: connection },
  });
  code = await new Promise((resolve) => run.on('exit', (c) => resolve(c ?? 1)));
} finally {
  azurite.kill('SIGTERM');
}
process.exit(code);
