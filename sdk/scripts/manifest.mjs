/**
 * Route manifest of this package's Smithy services: one `{operationId, method, path, service, auth}`
 * entry per operation, sorted by service, path and method (byte-for-byte deterministic).
 *
 *   node scripts/manifest.mjs --sync         write this repo's committed copies (config.localCopies: the
 *                                            server's OpenAPI and manifest)
 *   node scripts/manifest.mjs --check-sync   fail if one of those copies is stale
 *
 * `auth`: "none" for `@auth([])`, "session" for the configured session trait, otherwise "cognito" (the
 * member's Cognito ID token as a Bearer token). Web clients import the TS manifest from the package
 * ("<package>/manifest"). The Swift / Kotlin manifests ship in the package (manifest/Manifest.swift and
 * manifest/Manifest.kt); OneHookPlatform pulls them from the version it pins (scripts/sync-api-specs.mjs
 * there). Nothing here writes into other repos.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderServerModels } from './server-models.mjs';

const sdkDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const NATIVE_FILES = ['Manifest.swift', 'Manifest.kt'];

export function loadModel(path) {
  if (!existsSync(path)) throw new Error(`Smithy model not found at ${path}. Run 'mvn -q exec:java' first.`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function operationsOf(model, serviceId) {
  const out = new Set();
  const walk = (id) => {
    const s = model.shapes[id];
    if (!s) throw new Error(`unknown shape ${id}`);
    for (const o of s.operations ?? []) out.add(o.target);
    for (const r of s.resources ?? []) walk(r.target);
  };
  walk(serviceId);
  return [...out].sort();
}

function authOf(shape, config) {
  const traits = shape.traits ?? {};
  const auth = traits['smithy.api#auth'];
  if (Array.isArray(auth) && auth.length === 0) return 'none';
  if (config.sessionTrait && config.sessionTrait in traits) return 'session';
  return 'cognito';
}

export function buildManifest(model, config) {
  const ops = [];
  for (const [serviceId, service] of Object.entries(config.smithyServices)) {
    if (!model.shapes[serviceId]) throw new Error(`service ${serviceId} is not in the model`);
    for (const id of operationsOf(model, serviceId)) {
      const http = model.shapes[id].traits?.['smithy.api#http'];
      if (!http) throw new Error(`${id} has no @http trait`);
      ops.push({
        operationId: id.split('#')[1],
        method: String(http.method).toUpperCase(),
        path: String(http.uri),
        service,
        auth: authOf(model.shapes[id], config),
      });
    }
  }
  const seen = new Set();
  for (const o of ops) {
    if (seen.has(o.operationId)) throw new Error(`duplicate operationId ${o.operationId}`);
    seen.add(o.operationId);
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return ops.sort((a, b) => cmp(a.service, b.service) || cmp(a.path, b.path) || cmp(a.method, b.method));
}

const q = (s) => JSON.stringify(s);

export function generateManifest(model, config) {
  const ops = buildManifest(model, config);
  const header = (c) =>
    [
      `${c} GENERATED FILE - DO NOT EDIT.`,
      `${c} Source of truth: ${config.repo}/sdk/model/*.smithy, published as ${config.packageName}.`,
      `${c} Regenerate: (${config.repo}/sdk) npm run build && npm run manifest:sync.`,
      `${c} iOS / Android copies: pulled from ${config.packageName} (manifest/) by OneHookPlatform scripts/sync-api-specs.mjs.`,
    ].join('\n');
  const swiftRows = ops.map(
    (o) => `        .init(operationId: ${q(o.operationId)}, method: ${q(o.method)}, path: ${q(o.path)}, service: ${q(o.service)}, auth: ${q(o.auth)}),`
  );
  const kotlinRows = ops.map(
    (o) => `        ApiManifest.Entry(operationId = ${q(o.operationId)}, method = ${q(o.method)}, path = ${q(o.path)}, service = ${q(o.service)}, auth = ${q(o.auth)}),`
  );
  const tsRows = ops.map(
    (o) => `  { operationId: ${q(o.operationId)}, method: ${q(o.method)}, path: ${q(o.path)}, service: ${q(o.service)}, auth: ${q(o.auth)} },`
  );
  return {
    'api-manifest.json': JSON.stringify({ operations: ops }, null, 2) + '\n',
    'api-manifest.ts': `${header('//')}
/* eslint-disable */

export type ApiAuth = 'cognito' | 'none' | 'session';

export interface ApiOperation {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly service: string;
  readonly auth: ApiAuth;
}

/** Every HTTP operation of ${config.packageName}, sorted by service, path, method. */
export const API_OPERATIONS: readonly ApiOperation[] = [
${tsRows.join('\n')}
];
`,
    'Manifest.swift': `${header('//')}

import Foundation

/// Every HTTP operation of ${config.packageName} (${config.repo}), in the shape of the backend's
/// \`ApiManifest.Entry\`. \`auth\` is "cognito", "none" or "session".
extension ApiManifest {
    static let ${config.nativeName}Operations: [Entry] = [
${swiftRows.join('\n')}
    ]
}
`,
    'Manifest.kt': `${header('//')}

@file:Suppress("unused")

package club.onehook.telemetry

/**
 * Every HTTP operation of ${config.packageName} (${config.repo}), in the shape of the backend's
 * [ApiManifest.Entry]. [ApiManifest.Entry.auth] is "cognito", "none" or "session".
 */
object ${config.nativeType}ApiManifest {
    val operations: List<ApiManifest.Entry> = listOf(
${kotlinRows.join('\n')}
    )
}
`,
  };
}

// ── Committed copies ──────────────────────────────────────────────────────────────────────────────

async function main(argv) {
  const config = (await import('../sdk.config.mjs')).default;
  const files = generateManifest(loadModel(join(sdkDir, 'build/smithy/source/model/model.json')), config);
  const source = join(sdkDir, 'build/smithy/source');
  const content = (from) => {
    if (from.startsWith('manifest/')) return files[from.slice('manifest/'.length)];
    if (from.startsWith('openapi/')) {
      const name = from.slice('openapi/'.length);
      const dir = readdirSync(source).find((d) => d.startsWith('openapi') && existsSync(join(source, d, name)));
      if (!dir) throw new Error(`no ${name} in the Smithy build`);
      return readFileSync(join(source, dir, name), 'utf8');
    }
    if (from.startsWith('server-models/')) {
      // `server-models/<Service>`: the server's model types, rendered from that service's OpenAPI.
      const serviceName = from.slice('server-models/'.length);
      const spec = JSON.parse(content(`openapi/${serviceName}.openapi.json`));
      return renderServerModels({
        serviceName,
        spec,
        header: [
          '// GENERATED FILE - DO NOT EDIT.',
          `// Source of truth: ${config.repo}/sdk/model/*.smithy (Smithy ${serviceName}), via its OpenAPI.`,
          `// Regenerate: (${config.repo}/sdk) npm run build && npm run manifest:sync`,
        ].join('\n'),
      });
    }
    throw new Error(`unknown copy source ${from}`);
  };
  const repoRoot = resolve(sdkDir, '..');
  const targets = (config.localCopies ?? []).map((c) => ({ text: content(c.from), dest: join(repoRoot, c.dest) }));
  const check = argv.includes('--check-sync');
  const stale = [];
  for (const t of targets) {
    const current = existsSync(t.dest) ? readFileSync(t.dest, 'utf8') : null;
    const text = t.text;
    if (check) {
      if (current !== text) stale.push(t.dest);
    } else {
      mkdirSync(dirname(t.dest), { recursive: true });
      writeFileSync(t.dest, text);
      console.log(`[manifest] synced ${t.dest}`);
    }
  }
  if (stale.length) {
    console.error(`[manifest] stale (run npm run manifest:sync):\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
  if (check) console.log('[manifest] copies are up to date');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
