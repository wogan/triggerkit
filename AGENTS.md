# AGENTS.md

Guidance for AI agents (and humans) working in this repository.

## Project Overview

**triggerkit** is a Trigger.dev **build extension** (not a Vite plugin, despite the
legacy `vite-plugin-triggerkit` name that still appears in some docs) that lets you
import SvelteKit functions, classes, and exports directly into Trigger.dev tasks via a
virtual module (`virtual:triggerkit`) — with zero changes to your SvelteKit source.

- Package: `triggerkit` (ESM, `"type": "module"`)
- Runtime: Node >= 18
- License: MIT
- Peer deps: `@trigger.dev/sdk` ^3 || ^4, `@trigger.dev/build` ^3 || ^4, `esbuild` >= 0.19

## Package Manager & Node

Use **npm** (there is a `package-lock.json` and an `.npmrc` with `engine-strict=true`).
Node version is pinned via `.nvmrc` (Node 24); use `nvm use` to load it.

```bash
nvm use
npm install
```

## Common Commands

| Task | Command |
| --- | --- |
| Install deps | `npm install` |
| Build (bundle + package) | `npm run build` |
| Watch build | `npm run dev` |
| Run tests (watch) | `npm test` |
| Run tests once | `npx vitest run` |
| Run tests + coverage | `npm run test:coverage` |
| Lint (prettier check + eslint) | `npm run lint` |
| Format | `npm run format` |
| Add a changeset | `npm run changeset` |
| Bump versions | `npm run version` |
| Publish | `npm run release` |

- `npm run build` = `vite build` (lib mode, ES) → `dist/index.js`, then `npm run package`.
- `npm run package` = `svelte-kit sync && svelte-package && publint && cp README.md dist/`.
- Output goes to `dist/` (gitignored).

## Testing

- Framework: **Vitest** (node environment, `globals: true`, single worker thread, 10s timeout).
- Test files: `src/**/*.{test,spec}.{ts,js,...}`.
- Tests need `tsconfig.json`'s extends target to exist: run `npx svelte-kit sync` once after a
  fresh install (or `npm run package`/`npm run build`, which run it) before `vitest`.
- The only suite is `src/test/triggerkit.spec.ts`, which mocks `fs` and `path` and drives
  `triggerkit().onBuildStart(mockContext)`.
- Run a single file: `npx vitest run src/test/triggerkit.spec.ts`.
- Run a single test by name: `npx vitest run -t "should transform"`.

## Linting & Formatting

- **Prettier** (`.prettierrc`): tabs, single quotes, no trailing commas, print width 100, Svelte plugin.
- **ESLint 9** flat config (`eslint.config.js`): `typescript-eslint` + `eslint-plugin-svelte` + prettier.
- `npm run lint` runs `prettier --check .` then `eslint .`. Run `npm run format` to auto-fix formatting.
- Keep code Prettier-clean; lint fails on formatting drift.

## Architecture

Everything lives in `src/lib/`:

- `index.ts` — public entry. Re-exports `triggerkit` and the `PluginOptions` type.
- `triggerkit.ts` — the whole plugin (~1400 lines). `triggerkit(options?)` returns a
  Trigger.dev `BuildExtension` (from `@trigger.dev/build/extensions`).
- `types/index.ts` — `PluginOptions`, `ExportedItem`, `CachedFile`, `FileWithExports`, etc.

### How it works (the `onBuildStart` hook)

1. **Load env** — `loadSvelteKitEnvironment` reads `.env`, `.env.local`,
   `.env.development*` from the consumer's `workingDir` into `process.env`.
2. **Scan** — `scanFolderForExports` recursively walks `includeDirs` (default `src/lib`),
   reads each `.ts`/`.js` file, transforms `$env/static/*` imports, and caches files that
   have extractable exports. `scanFolderForEnvVars` collects the env var names.
3. **Register an esbuild plugin** that:
   - resolves `src/...` imports relative to `workingDir`,
   - resolves `virtual:triggerkit` and `$env/static/(public|private)` to a virtual module,
   - on load, emits the generated virtual module source.
4. **Generate types** — `generateFunctionTypeDeclarations` writes `src/virtual-triggerkit.d.ts`
   into the **consumer's** project (`process.cwd()`), not this repo.
5. **Add a layer** — `context.addLayer` so the scanned files are included in the build.

### Key functions (all in `triggerkit.ts`)

- `extractExportedItems(content, includeTypes)` — **regex-based** extraction of exported
  functions, classes, and constants (methods/properties/constructor for classes). This is
  the heart of the plugin and is *not* a real TS AST parse — it is fragile.
- `transformSvelteKitEnvImports(source)` — rewrites `import { X } from '$env/static/...'`
  into `const { X } = process.env;`.
- `generateVirtualModuleContent` + `generateIndividualExports` / `generateGroupedExports` /
  `generateMixedExports` — build the virtual module source per `exportStrategy.mode`.
- `generateFunctionTypeDeclarations` — emits the `.d.ts`.
- `parseEnvFile` / `extractEnvironmentVariables` — env parsing helpers.

### Virtual module

- ID: `virtual:triggerkit` (constant `VIRTUAL_MODULE_ID`), namespace `triggerkit-namespace`.
- Consumers import from it: `import { myFn, MyClass, functions } from 'virtual:triggerkit'`.
- Always exports a `functions` object aggregating all function exports.

## Code Style

- TypeScript, ESM. Import specifiers use explicit `.js` extensions (e.g. `./triggerkit.js`).
- Follow Prettier (tabs, single quotes, no trailing commas, 100 cols).
- Public API types live in `types/index.ts`; document public APIs with JSDoc.
- Prefer `interface` over type aliases for object shapes.

## Gotchas / Notes

- **Regex-based parsing.** `extractExportedItems` and `extractFunctionSignatures` rely on
  regex patterns, not a TS parser. New export syntax may not be detected. When changing
  extraction, update the corresponding regex *and* the type-declaration path — they must
  stay in sync (see the 2.0.2 fix, where class support was added to
  `generateFunctionTypeDeclarations` but had been missing before).
- **Two near-duplicate extractors.** `extractExportedItems` (used for the virtual module +
  types) and `extractFunctionSignatures` (functions only) overlap. Prefer
  `extractExportedItems`; keep them consistent.
- **Stale script.** `npm run generate-virtual-types` points at `scripts/generate-virtual-types.js`,
  which does not exist in the repo. Don't rely on it.
- **Naming drift.** The package is `triggerkit`, but `CONTRIBUTING.md` and some comments
  still say `vite-plugin-triggerkit`. It is a Trigger.dev build extension, not a Vite plugin
  (Vite is only used to bundle the package).
- **Logging is inconsistent.** Some paths use `context.logger.log/warn`, others use
  `console.log` (e.g. in `scanFolderForExports`). Prefer `context.logger` and respect
  `debugLevel` (`minimal` | `verbose` | `off`).
- **`context` is typed `any`** in most helper functions (the Trigger.dev `BuildExtension`
  context type isn't threaded through).
- **Generated files are consumer-side.** `src/virtual-triggerkit.d.ts` is written into the
  *user's* project at build time. This repo's own `src/` is the plugin source, not a
  SvelteKit app.
- **`.gitignore`** ignores `/src/routes`, `/src/lib/server`, `/src/lib/client`, `/src/trigger`
  — these are consumer-project directories, not part of this package. Don't create them here.

## Release Process

- Uses **Changesets** (`.changeset/`, base branch `main`, `access: restricted`).
- For a change: `npm run changeset` (write a changeset), then `npm run version` (bump + update
  `CHANGELOG.md`), then `npm run release` (package + `changeset publish`).
- `CHANGELOG.md` is generated by Changesets — don't hand-edit it.
