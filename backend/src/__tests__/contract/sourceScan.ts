import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Static scan of this service's production sources (src/**\/*.ts, without __tests__ and generated) for
 * the two things the API contract tests compare with the generated manifest:
 *  - every Express route it registers ({@link scanRoutes});
 *  - every OneHook backend operation it calls, which must go through the generated client ({@link scanSdkCalls}).
 *
 * The scan fails closed: anything it cannot resolve to a literal method and path (a path in a variable,
 * a router created without a name, `fetch` passed around, a URL it cannot read, ...) is returned as a
 * {@link ScanProblem}, and the tests fail on any problem. It never skips a call site.
 */

export interface SourceFile {
  /** Path relative to the backend root, e.g. `src/contextRoutes.ts`. */
  file: string;
  text: string;
}

export interface ScanProblem {
  file: string;
  line: number;
  reason: string;
}

export interface FoundRoute {
  file: string;
  line: number;
  method: string;
  /** Express path with `:param` written as `{param}`. */
  path: string;
}

export interface FoundCall {
  file: string;
  line: number;
  method: string;
  /** The path after the base URL, as written (`${...}` kept). */
  rawPath: string;
  /** Path with every interpolated segment written as `{}`, for template matching. */
  path: string;
}

/** The backend package root (the directory with this service's package.json). */
export function backendRoot(): string {
  let dir = __dirname;
  for (;;) {
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === 'onehook-ux-backend') {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('backend package.json not found above ' + __dirname);
    dir = parent;
  }
}

/** Every production TypeScript source: src/**\/*.ts except src/__tests__ and src/generated. */
export function productionSources(root = backendRoot()): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (rel === 'src/__tests__' || rel === 'src/generated') continue;
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        out.push({ file: rel, text: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(path.join(root, 'src'));
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

// ── Lexing ────────────────────────────────────────────────────────────────────

interface Lexed {
  /** The source with comments blanked (same length, newlines kept). */
  code: string;
  /** `code` with string, template and regex contents blanked too; delimiters and `${ }` are kept. */
  skel: string;
}

const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await',
]);

export function lex(src: string): Lexed {
  const code = src.split('');
  const skel = src.split('');
  const n = src.length;
  const blank = (arr: string[], from: number, to: number) => {
    for (let k = from; k < to; k++) if (arr[k] !== '\n') arr[k] = ' ';
  };
  const templateDepths: number[] = [];
  let depth = 0;
  let prev = '';
  let prevWord = '';

  /** Reads template text from `start`; returns the index after the closing backtick or after `${`. */
  const templateText = (start: number): { next: number; ended: boolean } => {
    let k = start;
    while (k < n) {
      const ch = src[k];
      if (ch === '\\') { k += 2; continue; }
      if (ch === '`') { blank(skel, start, k); return { next: k + 1, ended: true }; }
      if (ch === '$' && src[k + 1] === '{') {
        blank(skel, start, k);
        templateDepths.push(depth);
        depth++;
        return { next: k + 2, ended: false };
      }
      k++;
    }
    throw new Error('Unterminated template literal');
  };

  let i = 0;
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      blank(code, i, j); blank(skel, i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      const j = e < 0 ? n : e + 2;
      blank(code, i, j); blank(skel, i, j);
      i = j;
      continue;
    }
    if (c === '\'' || c === '"') {
      let k = i + 1;
      while (k < n && src[k] !== c) {
        if (src[k] === '\\') k++;
        k++;
      }
      blank(skel, i + 1, k);
      i = k + 1;
      prev = 'x'; prevWord = '';
      continue;
    }
    if (c === '`') {
      const r = templateText(i + 1);
      i = r.next;
      prev = r.ended ? 'x' : '('; prevWord = '';
      continue;
    }
    if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || (prev === 'w' && REGEX_KEYWORDS.has(prevWord)))) {
      let k = i + 1;
      let inClass = false;
      while (k < n) {
        const ch = src[k];
        if (ch === '\\') { k += 2; continue; }
        if (ch === '\n') throw new Error('Unterminated regex literal');
        if (inClass) { if (ch === ']') inClass = false; } else if (ch === '[') inClass = true; else if (ch === '/') break;
        k++;
      }
      blank(skel, i + 1, k);
      k++;
      while (k < n && /[a-z]/i.test(src[k]!)) k++;
      i = k;
      prev = 'x'; prevWord = '';
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === depth) {
        templateDepths.pop();
        const r = templateText(i + 1);
        i = r.next;
        prev = r.ended ? 'x' : '('; prevWord = '';
        continue;
      }
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[\w$]/.test(c)) {
      let k = i;
      while (k < n && /[\w$]/.test(src[k]!)) k++;
      prevWord = src.slice(i, k);
      prev = 'w';
      i = k;
      continue;
    }
    prev = c; prevWord = '';
    i++;
  }
  return { code: code.join(''), skel: skel.join('') };
}

function lineOf(src: string, offset: number): number {
  let line = 1;
  for (let k = 0; k < offset && k < src.length; k++) if (src[k] === '\n') line++;
  return line;
}

interface Arg {
  start: number;
  end: number;
  text: string;
}

/** The arguments of the call whose `(` is at `open`, split at top-level commas. */
function callArgs(lx: Lexed, open: number): Arg[] | undefined {
  const args: Arg[] = [];
  let depth = 0;
  let start = open + 1;
  for (let k = open + 1; k < lx.skel.length; k++) {
    const ch = lx.skel[k];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) {
        if (ch !== ')') return undefined;
        const text = lx.code.slice(start, k).trim();
        if (text) args.push({ start, end: k, text });
        return args;
      }
      depth--;
    } else if (ch === ',' && depth === 0) {
      args.push({ start, end: k, text: lx.code.slice(start, k).trim() });
      start = k + 1;
    }
  }
  return undefined;
}

type TemplatePart = { text: string } | { expr: string };

/** A string or template literal that is the whole of `arg`; undefined when `arg` is anything else. */
function literal(lx: Lexed, arg: Arg): { parts: TemplatePart[]; escaped: boolean } | undefined {
  let s = arg.start;
  while (/\s/.test(lx.code[s]!)) s++;
  const q = lx.code[s];
  if (q === '\'' || q === '"') {
    const close = lx.skel.indexOf(q, s + 1);
    if (close < 0 || lx.code.slice(close + 1, arg.end).trim() !== '') return undefined;
    const value = lx.code.slice(s + 1, close);
    return { parts: [{ text: value }], escaped: value.includes('\\') };
  }
  if (q !== '`') return undefined;
  const parts: TemplatePart[] = [];
  let k = s + 1;
  let textStart = k;
  while (k < arg.end) {
    if (lx.skel[k] === '`') {
      parts.push({ text: lx.code.slice(textStart, k) });
      if (lx.code.slice(k + 1, arg.end).trim() !== '') return undefined;
      return { parts, escaped: parts.some((p) => 'text' in p && p.text.includes('\\')) };
    }
    if (lx.skel[k] === '$' && lx.skel[k + 1] === '{') {
      parts.push({ text: lx.code.slice(textStart, k) });
      let depth = 1;
      let m = k + 2;
      while (m < arg.end && depth > 0) {
        if (lx.skel[m] === '{') depth++;
        else if (lx.skel[m] === '}') depth--;
        m++;
      }
      parts.push({ expr: lx.code.slice(k + 2, m - 1).trim() });
      k = m;
      textStart = k;
      continue;
    }
    k++;
  }
  return undefined;
}

/** The literal's value when it has no interpolation and no escapes. */
function plainString(lx: Lexed, arg: Arg | undefined): string | undefined {
  if (!arg) return undefined;
  const lit = literal(lx, arg);
  if (!lit || lit.escaped || lit.parts.length !== 1 || !('text' in lit.parts[0]!)) return undefined;
  return lit.parts[0].text;
}

// ── Routes ────────────────────────────────────────────────────────────────────

const ROUTE_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch']);
const UNSUPPORTED_VERBS = new Set(['all', 'options', 'head', 'route']);
/** Names bound to an Express app or router: `const app = express()`, `const router = Router()`, ... */
const RECEIVER_DECL = /\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=;]+)?=\s*(?:express\s*\(|express\s*\.\s*Router\s*\(|Router\s*\(|createApp\s*\()/g;
/** Every place an app or router is created. */
const FACTORY_CALL = /(?<![\w$.])(?:express\s*\(|express\s*\.\s*Router\s*\(|Router\s*\(|createApp\s*\()/g;
/** Parameters or fields typed as an app or router. */
const RECEIVER_PARAM = /([\w$]+)\s*\??\s*:\s*(?:express\s*\.\s*)?(?:Router|Express|Application)\b/g;
const VERB_CALL = /([\w$]+)\s*\.\s*(get|post|put|delete|patch|all|options|head|route|use)\s*\(/g;

/** `:sessionId` → `{sessionId}`; undefined for anything that is not a plain literal path. */
function expressPathToTemplate(expressPath: string): string | undefined {
  if (!/^(\/[A-Za-z0-9_.\-:]*)+$/.test(expressPath)) return undefined;
  return expressPath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

export function scanRoutes(files: SourceFile[]): { routes: FoundRoute[]; problems: ScanProblem[] } {
  const routes: FoundRoute[] = [];
  const problems: ScanProblem[] = [];
  for (const { file, text } of files) {
    const lx = lex(text);
    const receivers = new Set<string>();
    const declared = new Set<number>();
    for (const m of lx.skel.matchAll(RECEIVER_DECL)) {
      receivers.add(m[1]!);
      declared.add(m.index! + m[0].length);
    }
    for (const m of lx.skel.matchAll(RECEIVER_PARAM)) receivers.add(m[1]!);
    for (const m of lx.skel.matchAll(FACTORY_CALL)) {
      const before = lx.skel.slice(Math.max(0, m.index! - 40), m.index!);
      if (/\bfunction\s+$/.test(before)) continue; // the createApp definition
      if (!declared.has(m.index! + m[0].length)) {
        problems.push({ file, line: lineOf(text, m.index!), reason: 'an Express app or router is created without a `const <name> =`; its routes cannot be followed' });
      }
    }
    for (const m of lx.skel.matchAll(VERB_CALL)) {
      const receiver = m[1]!;
      const verb = m[2]!;
      const open = m.index! + m[0].length - 1;
      const line = lineOf(text, m.index!);
      const args = callArgs(lx, open);
      const first = args?.[0];
      const firstString = plainString(lx, first);
      const firstIsLiteral = first !== undefined && literal(lx, first) !== undefined;
      const known = receivers.has(receiver);
      if (!known) {
        // Not a known app/router (headers.get('x'), map.delete(k), ...) unless it is given a route path.
        const head = first ? literal(lx, first)?.parts[0] : undefined;
        const looksLikePath = head !== undefined && 'text' in head && head.text.startsWith('/');
        if (looksLikePath && (ROUTE_VERBS.has(verb) || UNSUPPORTED_VERBS.has(verb) || verb === 'use')) {
          problems.push({ file, line, reason: `\`${receiver}.${verb}(...)\` registers a path on \`${receiver}\`, which is not a known Express app or router` });
        }
        continue;
      }
      if (!args) {
        problems.push({ file, line, reason: `cannot read the arguments of \`${receiver}.${verb}(...)\`` });
        continue;
      }
      if (verb === 'use') {
        if (firstIsLiteral) problems.push({ file, line, reason: `\`${receiver}.use(<path>, ...)\` mounts under a prefix; the scanner only supports root mounts` });
        continue;
      }
      if (UNSUPPORTED_VERBS.has(verb)) {
        problems.push({ file, line, reason: `\`${receiver}.${verb}(...)\` is not supported by the route scan; register each method with get/post/put/delete/patch` });
        continue;
      }
      const template = firstString !== undefined ? expressPathToTemplate(firstString) : undefined;
      if (template === undefined) {
        problems.push({ file, line, reason: `\`${receiver}.${verb}(${first?.text ?? ''}, ...)\`: the route path is not a plain literal path` });
        continue;
      }
      routes.push({ file, line, method: verb.toUpperCase(), path: template });
    }
  }
  return { routes, problems };
}

// ── Outbound calls ────────────────────────────────────────────────────────────

/** Modules that make HTTP requests the fetch scan would not see. */
const OTHER_HTTP_MODULES = new Set([
  'http', 'https', 'node:http', 'node:https', 'http2', 'node:http2', 'axios', 'undici', 'got', 'node-fetch', 'cross-fetch', 'superagent',
]);
const IMPORT_FROM = /\b(?:import|export)\b[^;]*?\bfrom\s*(['"])([^'"]+)\1|\brequire\s*\(\s*(['"])([^'"]+)\3\s*\)|\bimport\s*\(\s*(['"])([^'"]+)\5\s*\)/g;
const FETCH_ALIAS = /([\w$]+)\s*\??\s*:\s*typeof\s+fetch\b/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The one production file allowed to call `fetch`: the transport of the generated OneHook client. It sends
 * the request the SDK serialized from the model; it never builds a URL or a body itself.
 */
export const SDK_TRANSPORT_FILE = 'src/oneHookApiClient.ts';

/** One OneHook backend operation this service calls through the generated `OneHook` client. */
export interface FoundSdkCall {
  file: string;
  line: number;
  /** The Smithy operation (`getAiContextMatch(` -> `GetAiContextMatch`, `new XCommand(` -> `X`). */
  operationId: string;
}

/**
 * Every call this service makes to another service must go through that service's generated client. For the
 * OneHook backend that is `onehook-api-client`'s `OneHook` client (built by ./oneHookApiClient.ts). This scan
 * returns every operation called on a value typed `OneHook` (or constructed as a `*Command`), and reports as a
 * problem any other outbound HTTP: a `fetch` (or a `typeof fetch` alias) called outside {@link SDK_TRANSPORT_FILE},
 * another HTTP module, or `XMLHttpRequest`. It fails closed: what it cannot follow is a problem.
 */
export function scanSdkCalls(files: SourceFile[]): { calls: FoundSdkCall[]; problems: ScanProblem[] } {
  const calls: FoundSdkCall[] = [];
  const problems: ScanProblem[] = [];
  const lexed = files.map((f) => ({ ...f, lx: lex(f.text) }));
  const aliases = new Set<string>(['fetch']);
  for (const { lx } of lexed) for (const m of lx.skel.matchAll(FETCH_ALIAS)) aliases.add(m[1]!);

  for (const { file, text, lx } of lexed) {
    for (const m of lx.code.matchAll(IMPORT_FROM)) {
      const spec = m[2] ?? m[4] ?? m[6] ?? '';
      if (OTHER_HTTP_MODULES.has(spec)) {
        problems.push({ file, line: lineOf(text, m.index!), reason: `imports \`${spec}\`; call other services through their generated client` });
      }
      if (spec === 'onehook-api-client' && /\bOneHookClient\b/.test(m[0])) {
        problems.push({ file, line: lineOf(text, m.index!), reason: 'uses the bare OneHookClient; use createOneHookApiClient (SigV4 + transport)' });
      }
    }
    if (/\bXMLHttpRequest\b/.test(lx.skel)) {
      problems.push({ file, line: lineOf(text, lx.skel.search(/\bXMLHttpRequest\b/)), reason: 'uses XMLHttpRequest' });
    }
    if (file !== SDK_TRANSPORT_FILE) {
      for (const alias of aliases) {
        for (const m of lx.skel.matchAll(new RegExp(`(?<![\\w$.])${escapeRe(alias)}\\s*\\(|\\.${escapeRe(alias)}\\s*\\(`, 'g'))) {
          problems.push({ file, line: lineOf(text, m.index!), reason: `\`${alias}(...)\` outside ${SDK_TRANSPORT_FILE}: call the service through its generated client` });
        }
      }
      for (const m of lx.skel.matchAll(/(?<![\w$])fetch(?![\w$])/g)) {
        const before = lx.skel.slice(Math.max(0, m.index! - 60), m.index!);
        const after = lx.skel.slice(m.index! + 5);
        if (/\btypeof\s+$/.test(before) || /\btypeof\s+fetch\s*=\s*$/.test(before) || /^\s*\(/.test(after)) continue;
        if (/[:,(]\s*$/.test(before) && /^\s*[,)]/.test(after)) continue; // passed on as the SDK transport
        problems.push({ file, line: lineOf(text, m.index!), reason: '`fetch` is used in a way the scan cannot follow' });
      }
    }

    // Values typed `OneHook` (fields, parameters, variables), and every `<value>.<operation>(` on them.
    const receivers = new Set<string>();
    for (const m of lx.skel.matchAll(/([\w$]+)\s*\??\s*:\s*OneHook\b(?![\w$])/g)) receivers.add(m[1]!);
    for (const m of lx.skel.matchAll(/\b(?:const|let)\s+([\w$]+)\s*=\s*createOneHookApiClient\s*\(/g)) receivers.add(m[1]!);
    for (const r of receivers) {
      for (const m of lx.skel.matchAll(new RegExp(`(?<![\\w$])(?:this\\.)?${escapeRe(r)}\\s*\\.\\s*([a-z][A-Za-z0-9]*)\\s*\\(`, 'g'))) {
        const method = m[1]!;
        if (method === 'send' || method === 'destroy' || method === 'middlewareStack') {
          problems.push({ file, line: lineOf(text, m.index!), reason: `\`${r}.${method}(\` cannot be read as an operation; call the operation method` });
          continue;
        }
        calls.push({ file, line: lineOf(text, m.index!), operationId: method[0]!.toUpperCase() + method.slice(1) });
      }
    }
    // `new XCommand(...)` for a command imported from onehook-api-client (AWS SDK commands are not ours).
    const sdkImports = new Set<string>();
    for (const m of lx.code.matchAll(/\bimport\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]onehook-api-client['"]/g)) {
      for (const name of m[1]!.split(',')) sdkImports.add(name.trim().split(/\s+as\s+/).pop()!.replace(/^type\s+/, ''));
    }
    for (const m of lx.skel.matchAll(/\bnew\s+([A-Z][A-Za-z0-9]*)Command\s*\(/g)) {
      if (sdkImports.has(`${m[1]}Command`)) calls.push({ file, line: lineOf(text, m.index!), operationId: m[1]! });
    }
  }
  return { calls, problems };
}

/** A manifest/OpenAPI path template with every `{param}` written as `{}`. */
export function normalizeTemplate(template: string): string {
  return template.replace(/\{[^}/]+\}/g, '{}');
}
