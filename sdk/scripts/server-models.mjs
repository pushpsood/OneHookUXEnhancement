/**
 * TypeScript model types for the SERVER of this package's API, rendered from the service's OpenAPI
 * (which Smithy generates from model/*.smithy). The server implements the API with these types, so its
 * handlers and the published client share one model. Dependency-free (types only, no runtime), unlike
 * the generated client whose models pull in the Smithy runtime.
 *
 * Every component schema becomes an `interface` (objects), a string-literal union (enums), an array or
 * `Record` alias. Request and response bodies keep their OpenAPI names
 * (`ProductConnectionChatRequestContent`, ...). Deterministic output.
 */

const refName = (ref) => ref.replace('#/components/schemas/', '');

function typeOf(s) {
  if (s.$ref) return refName(s.$ref);
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  switch (s.type) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array': {
      const item = typeOf(s.items ?? {});
      return item.includes('|') ? `(${item})[]` : `${item}[]`;
    }
    case 'object':
      if (s.additionalProperties && !s.properties) return `Record<string, ${typeOf(s.additionalProperties)}>`;
      if (!s.properties) return 'Record<string, unknown>';
      throw new Error(`inline object schemas are not supported: ${JSON.stringify(s)}`);
    default:
      if (Object.keys(s).length === 0) return 'unknown';
      throw new Error(`unsupported schema: ${JSON.stringify(s)}`);
  }
}

function doc(text, indent) {
  if (!text) return [];
  const lines = text.trim().split('\n');
  return lines.length === 1
    ? [`${indent}/** ${lines[0].replace(/\*\//g, '*\\/')} */`]
    : [`${indent}/**`, ...lines.map((l) => `${indent} * ${l.replace(/\*\//g, '*\\/')}`.trimEnd()), `${indent} */`];
}

/** `{ header, serviceName, spec }` -> the TypeScript source. */
export function renderServerModels({ header, serviceName, spec }) {
  const out = [header, '/* eslint-disable */', ''];
  const ops = Object.entries(spec.paths)
    .flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ operationId: op.operationId, method: method.toUpperCase(), path })))
    .sort((a, b) => (a.operationId < b.operationId ? -1 : 1));
  out.push(`/** Every ${serviceName} operation. */`);
  out.push('export const OPERATIONS = [');
  for (const o of ops) out.push(`  { operationId: ${JSON.stringify(o.operationId)}, method: ${JSON.stringify(o.method)}, path: ${JSON.stringify(o.path)} },`);
  out.push('] as const;', '');
  for (const name of Object.keys(spec.components.schemas).sort()) {
    const s = spec.components.schemas[name];
    out.push(...doc(s.description, ''));
    if (s.type === 'object' && s.properties) {
      const required = new Set(s.required ?? []);
      out.push(`export interface ${name} {`);
      for (const [prop, ps] of Object.entries(s.properties)) {
        out.push(...doc(ps.description, '  '));
        out.push(`  ${prop}${required.has(prop) ? '' : '?'}: ${typeOf(ps)};`);
      }
      out.push('}', '');
    } else if (s.type === 'object' && !s.additionalProperties) {
      out.push(`export type ${name} = Record<string, never>;`, '');
    } else {
      out.push(`export type ${name} = ${typeOf(s)};`, '');
    }
  }
  return out.join('\n');
}
