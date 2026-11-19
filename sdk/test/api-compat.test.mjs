// Tests for api-compat.mjs (the version decision every API package's publish workflow makes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compare, nextVersion } from '../scripts/api-compat.mjs';

const base = () => ({
  openapi: '3.0.2',
  paths: {
    '/things/{id}': {
      get: {
        operationId: 'GetThing',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } } },
      },
      put: {
        operationId: 'PutThing',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PutThing' } } } },
        responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } } },
      },
    },
  },
  components: {
    schemas: {
      Thing: {
        type: 'object',
        properties: { id: { type: 'string' }, kind: { $ref: '#/components/schemas/Kind' }, next: { $ref: '#/components/schemas/Thing' } },
        required: ['id', 'kind'],
      },
      PutThing: { type: 'object', properties: { name: { type: 'string' }, kind: { $ref: '#/components/schemas/Kind' } }, required: ['name'] },
      Kind: { type: 'string', enum: ['A', 'B'] },
    },
  },
});

function level(change) {
  const root = mkdtempSync(join(tmpdir(), 'api-compat-test-'));
  try {
    for (const [dir, doc] of [['old', base()], ['new', change(base())]]) {
      mkdirSync(join(root, dir, 'openapi'), { recursive: true });
      writeFileSync(join(root, dir, 'openapi', 'S.openapi.json'), JSON.stringify(doc));
    }
    return compare(join(root, 'old'), join(root, 'new')).level;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const schemas = (d) => d.components.schemas;

test('no change is a patch; a description change is a patch', () => {
  assert.equal(level((d) => d), 'patch');
  assert.equal(level((d) => ((d.paths['/things/{id}'].get.description = 'x'), d)), 'patch');
});

test('additions are minor', () => {
  assert.equal(level((d) => ((schemas(d).Thing.properties.extra = { type: 'string' }), d)), 'minor', 'response member');
  assert.equal(level((d) => ((schemas(d).PutThing.properties.note = { type: 'string' }), d)), 'minor', 'optional request member');
  assert.equal(level((d) => (schemas(d).Kind.enum.push('C'), d)), 'minor', 'enum value');
  assert.equal(level((d) => ((d.paths['/new'] = { get: { operationId: 'New', responses: { 200: {} } } }), d)), 'minor', 'operation');
});

test('breaking changes are major', () => {
  assert.equal(level((d) => (delete d.paths['/things/{id}'].put, d)), 'major', 'operation removed');
  assert.equal(level((d) => (delete schemas(d).Thing.properties.id, (schemas(d).Thing.required = ['kind']), d)), 'major', 'response member removed');
  assert.equal(level((d) => ((schemas(d).Thing.required = ['id']), d)), 'major', 'response member no longer required');
  assert.equal(level((d) => (schemas(d).PutThing.required.push('kind'), d)), 'major', 'request member now required');
  assert.equal(level((d) => ((schemas(d).PutThing.properties.must = { type: 'string' }), schemas(d).PutThing.required.push('must'), d)), 'major', 'required request member added');
  assert.equal(level((d) => ((schemas(d).Thing.properties.id = { type: 'integer' }), d)), 'major', 'type changed');
  assert.equal(level((d) => ((schemas(d).Kind.enum = ['A']), d)), 'major', 'enum value removed');
  assert.equal(level((d) => ((d.paths['/things/{id}'].get.responses = { 201: d.paths['/things/{id}'].get.responses[200] }), d)), 'major', 'success status changed');
});

test('the next version starts the clean line, then follows the level', () => {
  assert.equal(nextVersion('1.0.46', 'patch', 2), '2.0.0');
  assert.equal(nextVersion('2.0.0', 'patch', 2), '2.0.1');
  assert.equal(nextVersion('2.0.3', 'minor', 2), '2.1.0');
  assert.equal(nextVersion('2.4.1', 'major', 2), '3.0.0');
});
