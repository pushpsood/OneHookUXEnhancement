import test from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicates, loadGeneratedShapes, shapesOf } from './contract/modelScan';
import { productionSources } from './contract/sourceScan';

/**
 * Model source of truth: wire models (request and response bodies this service serves or sends) come
 * only from generated code, never from hand-written types:
 *  - this service's own API: src/generated/mrOneHookModels.ts (from sdk/model/*.smithy);
 *  - the backend APIs it calls: onehook-api-client.
 * A hand-written type in src/ that duplicates a generated shape (same name, same members, or the same
 * enum values) fails the build; derive it from the generated type instead. When the generated shape is
 * wrong or missing, change the Smithy model (sdk/model here, or OneHookBackend for onehook-api-client).
 *
 * {@link NOT_WIRE_MODELS} lists hand-written types that look like a generated shape but are not wire
 * models, each with the reason.
 */

/** `file#name` -> why it is not a duplicate of the generated shape it resembles. */
const NOT_WIRE_MODELS: Readonly<Record<string, string>> = {};

const shapes = loadGeneratedShapes();
const duplicates = findDuplicates(productionSources(), shapes);

test('reads the generated shapes of every source', () => {
  const count = (source: string) => shapes.filter((s) => s.id.startsWith(`${source}#`)).length;
  assert.ok(count('onehook-api-client') > 200, 'onehook-api-client shapes');
  assert.ok(count('src/generated/mrOneHookModels.ts') > 10, 'mrOneHookModels shapes');
});

test('no hand-written type duplicates a generated one', () => {
  const offenders = duplicates
    .filter((d) => !NOT_WIRE_MODELS[`${d.file}#${d.name}`])
    .map((d) => `${d.file}:${d.line} ${d.name} duplicates ${d.of} (${d.why})`);
  assert.deepEqual(offenders, []);
});

test('every NOT_WIRE_MODELS entry is still needed and gives a reason', () => {
  const flagged = new Set(duplicates.map((d) => `${d.file}#${d.name}`));
  for (const [key, reason] of Object.entries(NOT_WIRE_MODELS)) {
    assert.ok(flagged.has(key), `${key} no longer resembles a generated shape: remove it`);
    assert.ok(reason.length > 40, `${key} needs a reason`);
  }
});

test('the scanner flags copies and allows derived types', () => {
  const fake = shapesOf(
    'fake',
    `
    export interface ChatTurn { role: "user" | "assistant"; content: string; at?: string }
    export interface Health { status: string; service: string; version: string; region?: string }
    export type SuggestionStatus = "PENDING" | "ACCEPTED" | "DECLINED";
    export declare const Mode: { readonly A: "STANDARD"; readonly B: "DATING" };
    `
  );
  assert.deepEqual(
    fake.map((s) => `${s.kind} ${s.name}`),
    ['object ChatTurn', 'object Health', 'enum SuggestionStatus', 'enum Mode']
  );
  const scan = (text: string) => findDuplicates([{ file: 'src/fake.ts', text }], fake).map((d) => `${d.name} -> ${d.of.split('#')[1]}`);
  assert.deepEqual(
    scan(`
      interface ChatTurn { role: string; content: string }
      type Status = { status: string; service: string; version: string };
      type S = 'DECLINED' | 'PENDING' | 'ACCEPTED';
      type M = 'DATING' | 'STANDARD';
    `),
    ['ChatTurn -> ChatTurn', 'Status -> Health', 'S -> SuggestionStatus', 'M -> Mode']
  );
  assert.deepEqual(
    scan(`
      import type { ChatTurn as Generated, Health } from './generated/mrOneHookModels';
      import type { SuggestionStatus } from '../generated/mrOneHookModels';
      type ChatTurn = Generated;
      interface Status extends Health { uptimeMs: number }
      type View = Omit<Health, 'region'> & { status: string; service: string; version: string };
      type S = Exclude<SuggestionStatus, 'PENDING'>;
      type Sort = 'NEWEST' | 'OLDEST';
    `),
    []
  );
});
