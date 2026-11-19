#!/usr/bin/env node
/**
 * Decides the next version of an API package from what changed since the latest published version, so
 * consumers can take every minor and patch version automatically and only a major version needs a
 * developer (OneHookPlatform pins `^MAJOR.MINOR.PATCH` ranges and updates its lockfile on its own).
 *
 *   node api-compat.mjs next --package <name> --new <built package dir> [--min-major 2]
 *       prints the next version on stdout, the reasons on stderr
 *   node api-compat.mjs diff <old package dir> <new package dir>
 *       prints the level (major | minor | patch) and the reasons
 *
 * Major (breaking for a client built against the old version, including generated Swift / Kotlin
 * clients that would no longer compile or decode):
 *   - an operation or an OpenAPI document removed; an operation's method, path or success status changed;
 *   - a request parameter or body member added as required, removed, made required, or changed type;
 *   - a response member removed, made optional, or changed type;
 *   - an enum value removed (request or response);
 *   - a telemetry catalog element, screen or enum value removed; a membership tier removed.
 * Minor: anything added (operations, optional request members, response members, enum values, catalog
 * entries). Patch: everything else (descriptions, ...).
 *
 * `--min-major N`: the first version published with this check is N.0.0 when the latest is below N
 * (a clean line: every version inside N.x is checked non-breaking).
 *
 * The same file is used by OneHookBackend, OneHookUXEnhancement and OneHookAdminPortal; keep the copies
 * identical. Node 20+, no dependencies.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LEVELS = ['patch', 'minor', 'major'];

export function compare(oldDir, newDir) {
  const reasons = { major: [], minor: [], patch: [] };
  compareOpenApi(oldDir, newDir, reasons);
  compareTelemetry(oldDir, newDir, reasons);
  compareMembership(oldDir, newDir, reasons);
  const level = reasons.major.length ? 'major' : reasons.minor.length ? 'minor' : 'patch';
  return { level, reasons };
}

// ── OpenAPI ─────────────────────────────────────────────────────────────────────────────────────

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function openApiFiles(dir) {
  const d = join(dir, 'openapi');
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.openapi.json')).sort() : [];
}

function operations(doc) {
  const out = new Map();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      if (!op || typeof op !== 'object' || !op.operationId) continue;
      out.set(op.operationId, { method: method.toUpperCase(), path, op });
    }
  }
  return out;
}

function resolve(doc, schema, seen = new Set()) {
  let s = schema ?? {};
  while (s.$ref) {
    if (seen.has(s.$ref)) return { $cycle: s.$ref };
    seen.add(s.$ref);
    s = doc.components?.schemas?.[s.$ref.split('/').pop()] ?? {};
  }
  return s;
}

function typeOf(s) {
  if (s.type) return s.format ? `${s.type}:${s.format}` : s.type;
  if (s.properties) return 'object';
  return 'any';
}

/** Compares two schemas. `direction` is 'request' (the client sends it) or 'response' (it receives it). */
function compareSchema(oldDoc, newDoc, oldS, newS, where, direction, reasons, seen) {
  // A named schema pair is compared once per direction (schemas can refer to themselves).
  if (oldS?.$ref || newS?.$ref) {
    const key = `${direction}|${oldS?.$ref}|${newS?.$ref}`;
    if (seen.has(key)) return;
    seen.add(key);
  }
  const a = resolve(oldDoc, oldS);
  const b = resolve(newDoc, newS);
  if (a.$cycle || b.$cycle) return;

  if (typeOf(a) !== typeOf(b)) {
    reasons.major.push(`${where}: type ${typeOf(a)} -> ${typeOf(b)}`);
    return;
  }
  if (a.enum || b.enum) {
    const before = new Set(a.enum ?? []);
    const after = new Set(b.enum ?? []);
    for (const v of before) if (!after.has(v)) reasons.major.push(`${where}: enum value ${v} removed`);
    for (const v of after) if (!before.has(v)) reasons.minor.push(`${where}: enum value ${v} added`);
  }
  if (typeOf(a) === 'array') {
    compareSchema(oldDoc, newDoc, a.items, b.items, `${where}[]`, direction, reasons, seen);
    return;
  }
  if (a.additionalProperties || b.additionalProperties) {
    if (typeof a.additionalProperties === 'object' && typeof b.additionalProperties === 'object') {
      compareSchema(oldDoc, newDoc, a.additionalProperties, b.additionalProperties, `${where}{}`, direction, reasons, seen);
    }
  }
  const ap = a.properties ?? {};
  const bp = b.properties ?? {};
  const areq = new Set(a.required ?? []);
  const breq = new Set(b.required ?? []);
  for (const name of Object.keys(ap)) {
    const at = `${where}.${name}`;
    if (!(name in bp)) {
      reasons.major.push(`${at}: removed`);
      continue;
    }
    if (direction === 'request' && !areq.has(name) && breq.has(name)) reasons.major.push(`${at}: now required`);
    if (direction === 'response' && areq.has(name) && !breq.has(name)) reasons.major.push(`${at}: no longer required`);
    if (direction === 'response' && !areq.has(name) && breq.has(name)) reasons.patch.push(`${at}: now always sent`);
    compareSchema(oldDoc, newDoc, ap[name], bp[name], at, direction, reasons, seen);
  }
  for (const name of Object.keys(bp)) {
    if (name in ap) continue;
    const at = `${where}.${name}`;
    if (direction === 'request' && breq.has(name)) reasons.major.push(`${at}: added as required`);
    else reasons.minor.push(`${at}: added`);
  }
  if (JSON.stringify({ ...a, properties: undefined, items: undefined }) !== JSON.stringify({ ...b, properties: undefined, items: undefined })) {
    reasons.patch.push(`${where}: schema details changed`);
  }
}

function jsonBody(doc, holder) {
  const content = holder?.content ?? {};
  const media = content['application/json'] ?? Object.values(content)[0];
  return media?.schema;
}

function successCode(op) {
  return Object.keys(op.responses ?? {}).filter((c) => c.startsWith('2')).sort()[0];
}

function compareOpenApi(oldDir, newDir, reasons) {
  const oldFiles = openApiFiles(oldDir);
  const newFiles = new Set(openApiFiles(newDir));
  for (const f of newFiles) if (!oldFiles.includes(f)) reasons.minor.push(`${f}: new API`);
  for (const f of oldFiles) {
    if (!newFiles.has(f)) {
      reasons.major.push(`${f}: removed`);
      continue;
    }
    const oldDoc = readJson(join(oldDir, 'openapi', f));
    const newDoc = readJson(join(newDir, 'openapi', f));
    const before = operations(oldDoc);
    const after = operations(newDoc);
    for (const id of after.keys()) if (!before.has(id)) reasons.minor.push(`${id}: new operation`);
    for (const [id, o] of before) {
      const n = after.get(id);
      if (!n) {
        reasons.major.push(`${id}: removed`);
        continue;
      }
      if (o.method !== n.method || o.path !== n.path) reasons.major.push(`${id}: ${o.method} ${o.path} -> ${n.method} ${n.path}`);
      if (successCode(o.op) !== successCode(n.op)) reasons.major.push(`${id}: success status ${successCode(o.op)} -> ${successCode(n.op)}`);
      const seen = new Set();
      const params = (op) => new Map((op.parameters ?? []).map((p) => [`${p.in}:${p.name}`, p]));
      const op1 = params(o.op);
      const op2 = params(n.op);
      for (const [k, p] of op1) {
        const q = op2.get(k);
        if (!q) {
          reasons.major.push(`${id}: parameter ${k} removed`);
          continue;
        }
        if (!p.required && q.required) reasons.major.push(`${id}: parameter ${k} now required`);
        compareSchema(oldDoc, newDoc, p.schema, q.schema, `${id} ${k}`, 'request', reasons, seen);
      }
      for (const [k, q] of op2) {
        if (op1.has(k)) continue;
        if (q.required) reasons.major.push(`${id}: required parameter ${k} added`);
        else reasons.minor.push(`${id}: optional parameter ${k} added`);
      }
      const ob = jsonBody(oldDoc, o.op.requestBody);
      const nb = jsonBody(newDoc, n.op.requestBody);
      if (ob && !nb) reasons.major.push(`${id}: request body removed`);
      else if (!ob && nb) {
        if (n.op.requestBody?.required) reasons.major.push(`${id}: required request body added`);
        else reasons.minor.push(`${id}: optional request body added`);
      } else if (ob && nb) compareSchema(oldDoc, newDoc, ob, nb, `${id} request`, 'request', reasons, seen);
      const code = successCode(o.op);
      const or = jsonBody(oldDoc, o.op.responses?.[code]);
      const nr = jsonBody(newDoc, n.op.responses?.[successCode(n.op)]);
      if (or && !nr) reasons.major.push(`${id}: response body removed`);
      else if (!or && nr) reasons.minor.push(`${id}: response body added`);
      else if (or && nr) compareSchema(oldDoc, newDoc, or, nr, `${id} response`, 'response', reasons, seen);
    }
  }
}

// ── Catalogs shipped with onehook-api-client ────────────────────────────────────────────────────

function compareKeys(before, after, label, reasons) {
  const a = new Set(before);
  const b = new Set(after);
  for (const k of a) if (!b.has(k)) reasons.major.push(`${label} ${k} removed`);
  for (const k of b) if (!a.has(k)) reasons.minor.push(`${label} ${k} added`);
}

function compareTelemetry(oldDir, newDir, reasons) {
  const f = 'telemetry/telemetry-catalog.json';
  if (!existsSync(join(oldDir, f)) || !existsSync(join(newDir, f))) return;
  const a = readJson(join(oldDir, f));
  const b = readJson(join(newDir, f));
  compareKeys(Object.keys(a.uiElements ?? {}), Object.keys(b.uiElements ?? {}), 'telemetry element', reasons);
  compareKeys(Object.keys(a.screens ?? {}), Object.keys(b.screens ?? {}), 'telemetry screen', reasons);
  compareKeys(Object.keys(a.signals ?? {}), Object.keys(b.signals ?? {}), 'telemetry signal', reasons);
  for (const name of Object.keys(a.enums ?? {})) {
    const values = (e) => (Array.isArray(e) ? e : Object.keys(e ?? {}));
    compareKeys(values(a.enums[name]), values(b.enums?.[name]), `telemetry enum ${name} value`, reasons);
  }
  if (a.hash !== b.hash && !reasons.major.length && !reasons.minor.length) reasons.patch.push('telemetry catalog details changed');
}

function compareMembership(oldDir, newDir, reasons) {
  const f = 'membership/membership-catalog.json';
  if (!existsSync(join(oldDir, f)) || !existsSync(join(newDir, f))) return;
  const tiers = (dir) => (readJson(join(dir, f)).tiers ?? []).map((t) => t.wire);
  compareKeys(tiers(oldDir), tiers(newDir), 'membership tier', reasons);
}

// ── Versions ────────────────────────────────────────────────────────────────────────────────────

export function nextVersion(latest, level, minMajor = 0) {
  const [ma, mi, pa] = latest.split('.').map(Number);
  if (ma < minMajor) return `${minMajor}.0.0`;
  if (level === 'major') return `${ma + 1}.0.0`;
  if (level === 'minor') return `${ma}.${mi + 1}.0`;
  return `${ma}.${mi}.${pa + 1}`;
}

function latestPublished(name) {
  try {
    const out = execFileSync('npm', ['view', name, 'versions', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const all = [].concat(JSON.parse(out)).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
    all.sort((x, y) => {
      const [a, b] = [x, y].map((v) => v.split('.').map(Number));
      return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    });
    return all.at(-1);
  } catch {
    return undefined;
  }
}

function packed(name, version) {
  const work = mkdtempSync(join(tmpdir(), 'api-compat-'));
  const out = execFileSync('npm', ['pack', `${name}@${version}`, '--json', '--pack-destination', work], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const [info] = JSON.parse(out);
  execFileSync('tar', ['-xzf', join(work, info.filename), '-C', work]);
  return { dir: join(work, 'package'), cleanup: () => rmSync(work, { recursive: true, force: true }) };
}

function report(level, reasons) {
  const lines = [`[api-compat] ${level}`];
  for (const l of [...LEVELS].reverse()) for (const r of reasons[l].slice(0, 60)) lines.push(`  ${l}: ${r}`);
  console.error(lines.join('\n'));
}

function arg(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'diff') {
    const { level, reasons } = compare(args[0], args[1]);
    report(level, reasons);
    console.log(level);
  } else if (cmd === 'next') {
    const name = arg(args, '--package');
    const dir = arg(args, '--new');
    const minMajor = Number(arg(args, '--min-major') ?? 0);
    if (!name || !dir) {
      console.error('usage: api-compat.mjs next --package <name> --new <dir> [--min-major N]');
      process.exit(2);
    }
    const latest = latestPublished(name);
    if (!latest) {
      console.log(minMajor > 0 ? `${minMajor}.0.0` : '1.0.0');
    } else {
      const old = packed(name, latest);
      try {
        const { level, reasons } = compare(old.dir, dir);
        report(level, reasons);
        const next = nextVersion(latest, level, minMajor);
        console.error(`[api-compat] ${name}: ${latest} -> ${next}`);
        console.log(next);
      } finally {
        old.cleanup();
      }
    }
  } else {
    console.error('usage: api-compat.mjs next|diff ...');
    process.exit(2);
  }
}
