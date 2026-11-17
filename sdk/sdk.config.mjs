/** What scripts/assemble.mjs and scripts/manifest.mjs build from model/*.smithy. */
export default {
  packageName: 'onehook-mr-onehook-client',
  description: 'Generated TypeScript client and route manifest for the Mr OneHook API (MrOneHookService).',
  repo: 'OneHookUXEnhancement',
  repository: { type: 'git', url: 'https://github.com/pushpsood/OneHookUXEnhancement.git' },
  /** Smithy service shape id -> manifest `service`. */
  smithyServices: { 'club.onehook.mronehook#MrOneHookService': 'mr-onehook' },
  /** The generated client is the package root. */
  clients: [{ subpath: '', projection: 'typescript-codegen' }],
  /** Native manifest names: Swift `ApiManifest.mrOneHookOperations`, Kotlin `MrOneHookApiManifest`. */
  nativeName: 'mrOneHook',
  nativeType: 'MrOneHook',
  /** Committed copies in this repo that the server's contract tests read (refreshed by manifest:sync). */
  localCopies: [
    { from: 'openapi/MrOneHookService.openapi.json', dest: 'backend/src/__tests__/contract/MrOneHookService.openapi.json' },
    { from: 'manifest/api-manifest.ts', dest: 'backend/src/generated/mrOneHookApiManifest.ts' },
    // The server's request / response / error model types (the backend implements the API with them).
    { from: 'server-models/MrOneHookService', dest: 'backend/src/generated/mrOneHookModels.ts' },
  ],
};
