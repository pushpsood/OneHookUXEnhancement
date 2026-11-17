import { readFileSync } from 'node:fs';
import path from 'node:path';
// TypeScript 7 (the compiler this package builds with) has no JS API; the scanner uses the 5.x API.
import ts from 'typescript-api';
import { backendRoot, type SourceFile } from './sourceScan';

/**
 * Static scanner behind modelSourceOfTruth.test.ts: finds hand-written types in src/ that duplicate a
 * generated wire shape, so wire models come only from:
 *
 *   src/generated/mrOneHookModels.ts   (this service's own MrOneHookService Smithy model, via its OpenAPI)
 *   onehook-api-client                 (OneHookBackend: the backend models this service calls)
 *
 * A generated shape is an `interface X { ... }` / `type X = { ... }` (its member names) or an enum
 * (`type X = "a" | "b"`, `declare const X: { readonly A: "a" }`, `declare enum X { A = "a" }`; its values).
 * A hand-written declaration is a DUPLICATE when it is:
 *  - an object type (not extending a generated type) that shares 3 or more members with a generated
 *    shape, takes at least 75% of its own members from it, and has every required member of it (or,
 *    when the shape has fewer than 2 required members, at least 75% of its members); or
 *    whose name equals a generated shape's and shares 2 or more members with it; or
 *  - a union of string literals whose values equal a generated enum's values (2 or more).
 * Types built FROM generated ones (`type X = Generated`, `Pick<Generated, ...>`, `Generated & {...}`,
 * `interface X extends Generated`) are allowed.
 */

export interface GeneratedShape {
  /** `<source>#<Name>`. */
  id: string;
  name: string;
  kind: 'object' | 'enum';
  /** Object: every member name. Enum: every value. */
  members: string[];
  /** Object: the members not marked optional. */
  required: string[];
}

export interface Duplicate {
  file: string;
  line: number;
  name: string;
  of: string;
  why: string;
}

/** Where generated wire models come from: npm packages (their .d.ts) and this service's generated file. */
export const GENERATED_SOURCES: readonly { source: string; files: () => string[] }[] = [
  {
    source: 'onehook-api-client',
    files: () => {
      const dir = path.dirname(require.resolve('onehook-api-client/package.json', { paths: [backendRoot()] }));
      return ['dist-types/models/models_0.d.ts', 'dist-types/graphql/types.d.ts'].map((f) => path.join(dir, f));
    },
  },
  {
    source: 'src/generated/mrOneHookModels.ts',
    files: () => [path.join(backendRoot(), 'src/generated/mrOneHookModels.ts')],
  },
];

/** Import specifiers that bring in generated models (a package, or the generated file by any relative path). */
function isModelSpecifier(spec: string): boolean {
  return spec === 'onehook-api-client' || spec.startsWith('onehook-api-client/') || /(^|\/)generated\/mrOneHookModels$/.test(spec);
}

const IGNORED_GENERATED = new Set(['Scalars', 'Maybe', 'InputMaybe', 'Exact', 'Query', 'Mutation', 'Subscription']);

function memberName(m: ts.TypeElement): string | undefined {
  if (!m.name) return undefined;
  if (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) return m.name.text;
  return undefined;
}

function objectMembers(members: ts.NodeArray<ts.TypeElement>): { all: string[]; required: string[] } {
  const all: string[] = [];
  const required: string[] = [];
  for (const m of members) {
    if (!ts.isPropertySignature(m)) continue;
    const name = memberName(m);
    if (!name || name === '__typename' || name === '$metadata') continue;
    all.push(name);
    if (!m.questionToken) required.push(name);
  }
  return { all, required };
}

function stringUnion(node: ts.TypeNode): string[] | undefined {
  const parts = ts.isUnionTypeNode(node) ? node.types : [node];
  const values: string[] = [];
  for (const p of parts) {
    if (!ts.isLiteralTypeNode(p) || !ts.isStringLiteral(p.literal)) return undefined;
    values.push(p.literal.text);
  }
  return values.length >= 2 ? values : undefined;
}

/** Every generated object shape and enum declared in `text`. */
export function shapesOf(source: string, text: string): GeneratedShape[] {
  const sf = ts.createSourceFile('gen.d.ts', text, ts.ScriptTarget.Latest, true);
  const out: GeneratedShape[] = [];
  const add = (name: string, kind: GeneratedShape['kind'], members: string[], required: string[]) => {
    if (IGNORED_GENERATED.has(name) || /^(Mutation|Query|Subscription)[A-Z]\w*Args$/.test(name)) return;
    out.push({ id: `${source}#${name}`, name, kind, members, required });
  };
  for (const st of sf.statements) {
    if (ts.isInterfaceDeclaration(st)) {
      const { all, required } = objectMembers(st.members);
      add(st.name.text, 'object', all, required);
    } else if (ts.isTypeAliasDeclaration(st) && ts.isTypeLiteralNode(st.type)) {
      const { all, required } = objectMembers(st.type.members);
      add(st.name.text, 'object', all, required);
    } else if (ts.isTypeAliasDeclaration(st)) {
      const values = stringUnion(st.type);
      if (values) add(st.name.text, 'enum', values, values);
    } else if (ts.isEnumDeclaration(st)) {
      const values = st.members
        .map((m) => (m.initializer && ts.isStringLiteral(m.initializer) ? m.initializer.text : undefined))
        .filter((v): v is string => v !== undefined);
      add(st.name.text, 'enum', values, values);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.type || !ts.isTypeLiteralNode(d.type)) continue;
        const values = d.type.members
          .map((m) =>
            ts.isPropertySignature(m) && m.type && ts.isLiteralTypeNode(m.type) && ts.isStringLiteral(m.type.literal)
              ? m.type.literal.text
              : undefined
          )
          .filter((v): v is string => v !== undefined);
        if (values.length) add(d.name.text, 'enum', values, values);
      }
    }
  }
  return out;
}

/** Every generated shape of every source. */
export function loadGeneratedShapes(): GeneratedShape[] {
  return GENERATED_SOURCES.flatMap(({ source, files }) => files().flatMap((f) => shapesOf(source, readFileSync(f, 'utf8'))));
}

/** Names imported (as types or values) from a model source. */
function modelImports(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !isModelSpecifier(st.moduleSpecifier.text)) continue;
    const bindings = st.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) out.add(el.name.text);
    if (bindings && ts.isNamespaceImport(bindings)) out.add(bindings.name.text);
  }
  return out;
}

/** True when `node` is built from an imported model type (an alias, Pick/Omit/Partial, an intersection, an import type). */
function referencesImport(node: ts.Node, imported: Set<string>): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isTypeReferenceNode(n) || ts.isExpressionWithTypeArguments(n)) {
      const head = ts.isTypeReferenceNode(n) ? n.typeName : n.expression;
      const first = ts.isIdentifier(head) ? head.text : ts.isQualifiedName(head) ? head.left.getText() : head.getText().split('.')[0];
      if (first && imported.has(first)) found = true;
    } else if (ts.isImportTypeNode(n)) {
      found = true;
    }
    if (!found) n.forEachChild(visit);
  };
  visit(node);
  return found;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((v) => b.includes(v));

/** Hand-written declarations in `sources` that duplicate a generated shape. */
export function findDuplicates(sources: readonly SourceFile[], shapes: readonly GeneratedShape[]): Duplicate[] {
  const objects = shapes.filter((s) => s.kind === 'object' && s.members.length >= 3);
  const named = new Map(shapes.filter((s) => s.kind === 'object').map((s) => [s.name, s]));
  const enums = shapes.filter((s) => s.kind === 'enum' && s.members.length >= 2);
  const out: Duplicate[] = [];
  for (const { file, text } of sources) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const imported = modelImports(sf);
    const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const checkObject = (decl: ts.Node, name: string, members: ts.NodeArray<ts.TypeElement>) => {
      const { all } = objectMembers(members);
      const sameName = named.get(name);
      if (sameName) {
        const shared = all.filter((m) => sameName.members.includes(m));
        if (shared.length >= 2) {
          out.push({ file, line: line(decl), name, of: sameName.id, why: `same name, shares ${shared.join(', ')}` });
          return;
        }
      }
      const overlap = (s: GeneratedShape) => all.filter((m) => s.members.includes(m)).length;
      const covered = objects.filter(
        (s) =>
          overlap(s) >= 3 &&
          overlap(s) / all.length >= 0.75 &&
          // Every required member, or (for shapes with few required members) most of the shape.
          (s.required.length >= 2 ? s.required.every((m) => all.includes(m)) : overlap(s) / s.members.length >= 0.75)
      );
      const best = covered.sort((a, b) => overlap(b) - overlap(a))[0];
      if (best) {
        const shared = all.filter((m) => best.members.includes(m));
        out.push({ file, line: line(decl), name, of: best.id, why: `same shape: ${shared.join(', ')}` });
      }
    };
    const visit = (n: ts.Node) => {
      if (ts.isInterfaceDeclaration(n)) {
        const extendsGenerated = n.heritageClauses?.some((h) => h.types.some((t) => referencesImport(t, imported)));
        if (!extendsGenerated) checkObject(n, n.name.text, n.members);
      } else if (ts.isTypeAliasDeclaration(n)) {
        if (ts.isTypeLiteralNode(n.type)) {
          checkObject(n, n.name.text, n.type.members);
        } else if (!referencesImport(n.type, imported)) {
          const values = stringUnion(n.type);
          const match = values && enums.find((e) => sameSet(e.members, values));
          if (match) out.push({ file, line: line(n), name: n.name.text, of: match.id, why: `same values: ${values.join(', ')}` });
        }
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  return out;
}
