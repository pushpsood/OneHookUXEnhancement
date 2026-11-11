import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Static scan of this service's production sources (src/**\/*.ts, without __tests__ and generated) for
 * the two things the API contract tests compare with the generated manifest:
 *  - every Express route it registers ({@link scanRoutes});
 *  - every outbound HTTP call it makes ({@link scanOutboundCalls}).
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
const URL_MUTATION = /\.\s*(?:pathname|href|host|hostname|port|protocol|origin)\s*=(?!=)/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function scanOutboundCalls(files: SourceFile[]): { calls: FoundCall[]; problems: ScanProblem[] } {
  const calls: FoundCall[] = [];
  const problems: ScanProblem[] = [];
  const lexed = files.map((f) => ({ ...f, lx: lex(f.text) }));

  // Every name typed `typeof fetch` (constructor parameters, fields) is a fetch alias, in every file.
  const aliases = new Set<string>(['fetch']);
  for (const { lx } of lexed) for (const m of lx.skel.matchAll(FETCH_ALIAS)) aliases.add(m[1]!);

  for (const { file, text, lx } of lexed) {
    // Imports read from `code`: module specifiers are string contents, blanked in `skel`.
    for (const m of lx.code.matchAll(IMPORT_FROM)) {
      const spec = m[2] ?? m[4] ?? m[6] ?? '';
      if (OTHER_HTTP_MODULES.has(spec)) {
        problems.push({ file, line: lineOf(text, m.index!), reason: `imports \`${spec}\`; outbound HTTP must go through fetch so the contract scan sees it` });
      }
    }
    if (/\bXMLHttpRequest\b/.test(lx.skel)) {
      problems.push({ file, line: lineOf(text, lx.skel.search(/\bXMLHttpRequest\b/)), reason: 'uses XMLHttpRequest; outbound HTTP must go through fetch' });
    }
    // `fetch` itself may only be called, used as a type, or be the default of a `typeof fetch` parameter.
    for (const m of lx.skel.matchAll(/(?<![\w$])fetch(?![\w$])/g)) {
      const before = lx.skel.slice(Math.max(0, m.index! - 60), m.index!);
      const after = lx.skel.slice(m.index! + 5);
      if (/\btypeof\s+$/.test(before)) continue;
      if (/^\s*\(/.test(after)) continue;
      if (/\btypeof\s+fetch\s*=\s*$/.test(before)) continue;
      problems.push({ file, line: lineOf(text, m.index!), reason: '`fetch` is passed around in a way the scan cannot follow; call it, or take it as a `typeof fetch` parameter' });
    }

    for (const alias of aliases) {
      for (const m of lx.skel.matchAll(new RegExp(`(?<![\\w$])${escapeRe(alias)}\\s*\\(`, 'g'))) {
        const open = m.index! + m[0].length - 1;
        const line = lineOf(text, m.index!);
        const fail = (reason: string) => problems.push({ file, line, reason: `outbound call \`${alias}(...)\`: ${reason}` });
        const args = callArgs(lx, open);
        if (!args || args.length < 1) { fail('cannot read its arguments'); continue; }
        const urlArg = /^([\w$]+)(?:\.toString\(\)|\.href)?$/.exec(args[0]!.text);
        if (!urlArg) { fail(`the URL \`${args[0]!.text}\` is not a \`const\` URL variable`); continue; }
        const ident = urlArg[1]!;
        const decls = [...lx.skel.slice(0, m.index!).matchAll(new RegExp(`\\bconst\\s+${escapeRe(ident)}\\s*(?::[^=;]+)?=\\s*new\\s+URL\\s*\\(`, 'g'))];
        const decl = decls[decls.length - 1];
        if (!decl) { fail(`no \`const ${ident} = new URL(...)\` before it`); continue; }
        const between = lx.skel.slice(decl.index!, m.index!);
        if (URL_MUTATION.test(between.replace(new RegExp(`^[\\s\\S]*?new\\s+URL`), ''))) {
          fail(`\`${ident}\` is changed between \`new URL\` and the call`); continue;
        }
        const urlArgs = callArgs(lx, decl.index! + decl[0].length - 1);
        if (!urlArgs || urlArgs.length !== 1) { fail(`\`new URL(...)\` for \`${ident}\` must take one template argument`); continue; }
        const lit = literal(lx, urlArgs[0]!);
        const head = lit?.parts[0];
        const base = lit?.parts[1];
        if (!lit || lit.escaped || !head || !('text' in head) || head.text !== '' || !base || !('expr' in base) || !/^[\w$.]+$/.test(base.expr)) {
          fail(`the URL must be \`\${<baseUrl>}/<path>\`, got \`${urlArgs[0]!.text}\``); continue;
        }
        const rest = lit.parts.slice(2).map((p) => ('text' in p ? p.text : '\u0000')).join('');
        const rawRest = lit.parts.slice(2).map((p) => ('text' in p ? p.text : `\${${p.expr}}`)).join('');
        const pathOnly = rest.split('?')[0]!;
        if (!pathOnly.startsWith('/')) { fail(`the path \`${rawRest}\` does not start with /`); continue; }
        const segments = pathOnly.split('/').slice(1);
        if (segments.some((s) => s.includes('\u0000') && s !== '\u0000')) {
          fail(`\`${rawRest}\`: an interpolation must be a whole path segment`); continue;
        }
        const normalized = '/' + segments.map((s) => (s === '\u0000' ? '{}' : s)).join('/');
        if (!/^(\/([A-Za-z0-9_.\-]+|\{\}))+$/.test(normalized)) { fail(`cannot read the path \`${rawRest}\``); continue; }

        const init = args[1];
        const methods = init && init.text.startsWith('{') ? [...init.text.matchAll(/\bmethod\s*:\s*(['"])([A-Z]+)\1/g)] : [];
        if (methods.length !== 1) { fail('its init must be an object literal with one literal `method`'); continue; }
        const method = methods[0]![2]!;

        // auth: iam needs a SigV4 signature over the same method and URL before the call.
        const urlProp = ident === 'url' ? /(?:^|[{,\s])url\s*(?=[,}])|\burl\s*:\s*url\b/ : new RegExp(`\\burl\\s*:\\s*${escapeRe(ident)}\\b`);
        let signed = false;
        for (const s of lx.skel.slice(decl.index!, m.index!).matchAll(/\.\s*sign\s*\(/g)) {
          const signOpen = decl.index! + s.index! + s[0].length - 1;
          const signArg = callArgs(lx, signOpen)?.[0];
          if (signArg && signArg.text.startsWith('{')
            && new RegExp(`\\bmethod\\s*:\\s*(['"])${method}\\1`).test(signArg.text)
            && urlProp.test(signArg.text)) {
            signed = true;
          }
        }
        if (!signed) { fail(`no \`.sign({ method: '${method}', url: ${ident}, ... })\` between \`new URL\` and the call (auth: iam)`); continue; }

        calls.push({ file, line, method, rawPath: rawRest, path: normalized });
      }
    }
  }
  return { calls, problems };
}

/** A manifest/OpenAPI path template with every `{param}` written as `{}`. */
export function normalizeTemplate(template: string): string {
  return template.replace(/\{[^}/]+\}/g, '{}');
}
