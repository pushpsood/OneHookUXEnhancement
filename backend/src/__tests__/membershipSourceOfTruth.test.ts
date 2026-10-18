import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUBSCRIPTION_TIERS } from 'onehook-api-client/membership';

// Membership tiers come ONLY from onehook-api-client (owned by the OneHook backend Smithy model).
// Production sources must not spell a tier out as a string literal.
test('no production source hardcodes a membership tier name', () => {
  // Tests compile to dist/__tests__; the sources sit one level up (dist/*.js).
  const dir = join(__dirname, '..');
  const names = [...SUBSCRIPTION_TIERS.flatMap((t) => [t.wire, t.displayName])];
  const literal = new RegExp(`(["'\`])(${names.join('|')})\\1`, 'gi');
  const offenders: string[] = [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 5, `expected compiled sources in ${dir}`);
  for (const f of files) {
    const code = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const m of code.matchAll(literal)) offenders.push(`${f}: ${m[0]}`);
  }
  assert.deepEqual(offenders, []);
});
