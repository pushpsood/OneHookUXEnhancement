/**
 * Assembles the publishable npm package from the Smithy build (`mvn -q exec:java` -> build/smithy).
 *
 *   node scripts/assemble.mjs
 *
 * Reads ../sdk.config.mjs:
 *   packageName, description, smithyServices (shape id -> manifest `service`), sessionTrait (optional),
 *   clients: [{ subpath, projection }]   generated TypeScript clients ("" = the package root)
 *   rootSource (optional)                 a hand-written src/index.ts for the package root
 *   assets (optional): [{ from, to }]     extra directories shipped verbatim (from: relative to sdk/,
 *                                         to: a top-level package dir, exported as "./<to>/*")
 *
 * Output: build/package (package.json, dist-cjs, dist-es, dist-types, openapi/, manifest/, assets). The
 * package also exports its route manifest at "./manifest" (TS) and as raw Swift / Kotlin / JSON assets for
 * the native apps, generated from the same model (scripts/manifest.mjs). openapi/ holds the OpenAPI of the
 * services in config.smithyServices only; any other service in the Smithy build stays internal.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import config from '../sdk.config.mjs';
import { generateManifest, loadModel, NATIVE_FILES } from './manifest.mjs';

const sdkDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(sdkDir, 'build/smithy/source');
const out = join(sdkDir, 'build/package');
const version = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8')).version;

function fail(msg) {
  console.error(`[assemble] ${msg}`);
  process.exit(1);
}

/** Every regular file under `dir` (recursive). */
function files(dir) {
  return readdirSync(dir, { recursive: true }).map((f) => join(dir, String(f))).filter((f) => statSync(f).isFile());
}

// 1. Validate the codegen output and that every client shares the root client's dependency set.
const firstDir = join(source, config.clients[0].projection);
if (!existsSync(join(firstDir, 'package.json'))) fail(`Smithy output not found in ${firstDir}. Run 'mvn -q exec:java' first.`);
const base = JSON.parse(readFileSync(join(firstDir, 'package.json'), 'utf8'));
for (const { projection } of config.clients) {
  const dir = join(source, projection);
  if (!existsSync(join(dir, 'src/index.ts'))) fail(`Generated client not found: ${dir}`);
  const deps = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies ?? {};
  for (const [dep, v] of Object.entries(deps)) {
    if (base.dependencies[dep] !== v) fail(`${projection} needs ${dep}@${v}, the package has ${base.dependencies[dep]}`);
  }
}

// 2. Lay out src/: each client under its subpath (the root one at src/), plus the manifest.
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'src'), { recursive: true });
for (const f of ['tsconfig.json', 'tsconfig.cjs.json', 'tsconfig.es.json', 'tsconfig.types.json']) {
  cpSync(join(firstDir, f), join(out, f));
}
for (const { subpath, projection } of config.clients) {
  const target = subpath ? join(out, 'src', subpath) : join(out, 'src');
  cpSync(join(source, projection, 'src'), target, { recursive: true });
  if (!subpath) continue;
  // The generated runtime config reads `../package.json` (src/ is one level below the package root).
  let rewired = 0;
  for (const file of files(target).filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(file, 'utf8');
    const next = text.replace(/from "\.\.\/package\.json"/g, 'from "../../package.json"');
    if (next !== text) {
      writeFileSync(file, next);
      rewired += 1;
    }
  }
  if (!rewired) fail(`${projection}: no "../package.json" import to rewire (codegen layout changed?)`);
}
if (config.rootSource) cpSync(join(sdkDir, config.rootSource), join(out, 'src/index.ts'));

const model = loadModel(join(source, 'model/model.json'));
const manifest = generateManifest(model, config);
mkdirSync(join(out, 'src/manifest'), { recursive: true });
writeFileSync(join(out, 'src/manifest/index.ts'), manifest['api-manifest.ts']);
mkdirSync(join(out, 'manifest'), { recursive: true });
for (const f of ['api-manifest.json', ...NATIVE_FILES]) writeFileSync(join(out, 'manifest', f), manifest[f]);

// OpenAPI of every published service, for the native apps' code generators and for tests that validate
// bodies against the contract.
mkdirSync(join(out, 'openapi'), { recursive: true });
const published = new Set(Object.keys(config.smithyServices).map((id) => `${id.split('#')[1]}.openapi.json`));
for (const dir of readdirSync(source).filter((d) => d.startsWith('openapi'))) {
  for (const f of readdirSync(join(source, dir)).filter((f) => published.has(f))) {
    cpSync(join(source, dir, f), join(out, 'openapi', f));
    published.delete(f);
  }
}
if (published.size) fail(`no OpenAPI in the Smithy build for ${[...published].join(', ')}`);

for (const { from, to } of config.assets ?? []) {
  const dir = resolve(sdkDir, from);
  if (!existsSync(dir)) fail(`asset directory ${dir} not found`);
  cpSync(dir, join(out, to), { recursive: true });
}

// 3. package.json: the generated build scripts and dependencies, this package's name and exports.
const entry = (p) => ({
  types: `./dist-types/${p}index.d.ts`,
  browser: `./dist-es/${p}index.js`,
  import: `./dist-es/${p}index.js`,
  require: `./dist-cjs/${p}index.js`,
});
const exportsMap = { '.': entry(''), './manifest': entry('manifest/') };
const browser = {};
const reactNative = {};
for (const { subpath } of config.clients) {
  const p = subpath ? `${subpath}/` : '';
  if (subpath) exportsMap[`./${subpath}`] = entry(p);
  browser[`./dist-es/${p}runtimeConfig`] = `./dist-es/${p}runtimeConfig.browser`;
  reactNative[`./dist-es/${p}runtimeConfig`] = `./dist-es/${p}runtimeConfig.native`;
}
for (const f of ['api-manifest.json', ...NATIVE_FILES]) exportsMap[`./manifest/${f}`] = `./manifest/${f}`;
exportsMap['./openapi/*'] = './openapi/*';
for (const { to } of config.assets ?? []) exportsMap[`./${to.split('/')[0]}/*`] = `./${to.split('/')[0]}/*`;
exportsMap['./package.json'] = './package.json';

const pkg = {
  name: config.packageName,
  version,
  description: config.description,
  license: 'UNLICENSED',
  author: 'OneHook',
  repository: config.repository,
  sideEffects: false,
  main: './dist-cjs/index.js',
  module: './dist-es/index.js',
  types: './dist-types/index.d.ts',
  exports: exportsMap,
  browser,
  'react-native': reactNative,
  files: ['dist-*/**', 'manifest/**', 'openapi/**', ...new Set((config.assets ?? []).map(({ to }) => `${to.split('/')[0]}/**`))],
  scripts: {
    build: base.scripts.build,
    'build:cjs': base.scripts['build:cjs'],
    'build:es': base.scripts['build:es'],
    'build:types': base.scripts['build:types'],
  },
  dependencies: base.dependencies,
  devDependencies: base.devDependencies,
  engines: base.engines,
};
writeFileSync(join(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
cpSync(join(sdkDir, 'LICENSE'), join(out, 'LICENSE'));

// 4. Compile (the generated build script uses concurrently's `yarn:` prefixes).
try {
  execSync('yarn install --silent', { cwd: out, stdio: 'inherit' });
  execSync('yarn build', { cwd: out, stdio: 'inherit' });
} catch {
  fail('compile failed (see output above)');
}

const required = ['dist-cjs/index.js', 'dist-es/index.js', 'dist-types/index.d.ts', 'dist-es/manifest/index.js'];
for (const { subpath } of config.clients) {
  if (subpath) required.push(`dist-es/${subpath}/index.js`, `dist-cjs/${subpath}/index.js`, `dist-types/${subpath}/index.d.ts`);
}
for (const f of required) if (!existsSync(join(out, f))) fail(`missing build artifact ${f}`);
console.log(`[assemble] ${config.packageName}@${version} ready in build/package (${Object.keys(exportsMap).length} exports)`);
