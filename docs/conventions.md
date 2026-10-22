# Implementation conventions

Read this before changing code. These rules came from decisions made with the project owner. Lint, typecheck and tests enforce most of them, but not all.

This file holds the rules that apply everywhere. Rules for one area of the code live next to it in [`.claude/rules/`](../.claude/rules/) (see **Area rules** below). Claude Code loads each one automatically when it works on matching files, and they are plain Markdown for everyone else.

## Ground rules

1. **Use the latest stable npm packages.** Add them with `pnpm add <pkg>@latest`. Versions are exact (`saveExact`). A package used by more than one workspace package is pinned once in the `catalog:` of `pnpm-workspace.yaml` and referenced as `"catalog:"`; bump its version there. Follow the API of the current major version and never pin an older major. If a latest major turns out to be incompatible, ask the owner before downgrading.
   - **One sanctioned exception:** `apps/web` pins **Mantine 5, React 18 and React Router 7**, because `@refinedev/mantine` requires them. Renovate holds these back. Do not upgrade them without asking.
2. **Strong typing and minimal casts.**
   - Do not use `any`, `as` assertions (`as const` is fine), non-null `!`, or `@ts-ignore`/`@ts-expect-error`.
   - **Parse at boundaries; don't cast.** Treat everything that enters the system as `unknown` until zod parses it: HTTP input, env vars, DB documents, plugin modules, `JSON.parse` output and target responses.
   - If an assertion truly can't be avoided, put it in one tiny named helper. Give it an `oxlint-disable-next-line <rules> -- <reason>` line whose reason explains why the assertion is safe. The only one today is `asCallerType` in `apps/web/src/providers/data-provider.ts`.
3. **Prefer open-source libraries to hand-written boilerplate.** Check for a maintained package before writing a parser, a client or a UI widget.
4. **Clean, hexagonal architecture.**
   - The domain (`packages/core`) never imports a framework or a DB driver.
   - Adapters implement ports.
   - `apps/server` is the composition root. Nest provider factories wire ports to adapters there and nowhere else (see **Server modules**). Core, engine and providers never import Nest.
   - `apps/demo` (the demo launcher, seed data and screenshot tool) is a client of the public API only. Nothing imports it, and it is not part of the server image.
5. **No code comments.** If code needs a comment, rename or restructure it until it doesn't.
   - The only exception is the required `oxlint-disable-next-line <rules> -- <reason>` line, and the reason goes there.
   - Document schema fields with `.describe()` or `.meta({ description })`, so the text reaches OpenAPI and the provider forms.
   - Record framework quirks (a "why" that no name can carry) in this file or the matching area rules instead.

## Toolchain

| Concern         | Tool                                                                                                                  | Command                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Package manager | pnpm 11 workspaces (`pnpm-workspace.yaml`; build scripts are denied unless listed in `allowBuilds`)                   | `pnpm install`                              |
| Task runner     | Turborepo                                                                                                             | `pnpm build`, `pnpm typecheck`, `pnpm test` |
| Compiler        | **TypeScript 7** (native)                                                                                             | `tsc -p tsconfig.json` per package          |
| Lint            | **oxlint `--type-aware`** (`.oxlintrc.json`). typescript-eslint does not support TS 7, so don't add ESLint.           | `pnpm lint`                                 |
| Format          | **oxfmt** (`.oxfmtrc.json`, also sorts imports). Biome is not used: its linter has no type-aware `no-unsafe-*` rules. | `pnpm format` / `pnpm format:check`         |
| Tests           | **Vitest 5** + **Testcontainers** (`mongo:8`)                                                                         | `pnpm test`                                 |

**Definition of done:** run `pnpm lint && pnpm typecheck && pnpm format:check && pnpm test`. Every command must be clean, including zero lint warnings in new code.

### tsconfig

- `tsconfig.base.json` enables these on top of `strict`:
  - `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
  - `noImplicitOverride` and `noPropertyAccessFromIndexSignature`
  - `verbatimModuleSyntax`
  - `customConditions: ["@cloud-trigger/source"]` (a project-specific name, because some npm packages publish a plain `source` condition pointing at raw TypeScript)
- Each package has a `tsconfig.json` (typecheck, `noEmit`, which also includes `vitest.config.ts`) and a `tsconfig.build.json` (`rootDir: src`, `outDir: dist`, `customConditions: []`, which excludes tests).
- `exactOptionalPropertyTypes` means an optional property in a port or DTO is declared as `prop?: T | undefined` when callers may pass `undefined`. Don't spread possibly-undefined props into third-party components. Build an object that contains only the defined values instead (see `common(p)` in `apps/web/src/components/rjsf-theme.tsx`).
- Imports use `.js` extensions (ESM, `"type": "module"`), and type-only imports use `import type`.

### New workspace package checklist

1. Write a `package.json` with the following:
   - `"type": "module"` and `"private": true`
   - `files: ["dist"]`
   - exports `{ ".": { "@cloud-trigger/source": "./src/index.ts", "types": "./dist/index.d.ts", "default": "./dist/index.js" } }`
   - scripts `build`/`typecheck`/`test`
2. Add `tsconfig.json` and `tsconfig.build.json`, copied from `packages/core`.
3. Add a `vitest.config.ts` that re-exports `../../vitest.shared.ts` (it resolves the `@cloud-trigger/source` condition). The root `vitest.config.ts` picks up `packages/*` and `apps/*` automatically.
4. Depend on siblings with `"@cloud-trigger/x": "workspace:*"`. Quote the spec in zsh: `pnpm add '@cloud-trigger/core@workspace:*'`.
5. If the package ships in the server image, check that `pnpm deploy --prod --legacy` in `deploy/Dockerfile` still picks it up.

### oxlint rules you will hit

- These rules are set to `error`:
  - `consistent-type-assertions: never`, `no-explicit-any`, `no-non-null-assertion`
  - all the `no-unsafe-*` rules
  - `no-floating-promises`, `no-misused-promises`
  - `switch-exhaustiveness-check`
  - `import/no-cycle`
  - `ban-ts-comment`
- Style rules (both autofix with `pnpm lint --fix`; when they overlap, run it again):
  - `curly: all`: every `if`/`else`/`for`/`while`/`do` body gets braces.
  - `@stylistic/padding-line-between-statements` (loaded through oxlint `jsPlugins`): a blank line before every `return`, unless the `return` is the only statement in its block.
- End an exhaustive `switch` in `default: return assertNever(x)` (from `@cloud-trigger/core`).
- Use `toSorted`/`toReversed` instead of mutating `sort`/`reverse`.
- `Array.isArray` on `T | readonly T[]` yields `any`. Use a typed guard instead (see `isReadonlyArray` in `persistence-mongo/src/errors.ts`).
- Write interfaces with property-arrow members (`fn: () => void`) when values get destructured, to satisfy `unbound-method`.
- In React, declare components at module level (no nested components) and don't call impure functions such as `Date.now()` during render.
- Every disable comment needs a `-- reason` description.

## Area rules

Read the file for the area you are changing. Each one starts with the paths it covers.

| Area                                                             | File                                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Domain model, errors and ports (`packages/core`)                 | [`core.md`](../.claude/rules/core.md)                                                                |
| Providers and connections                                        | [`providers.md`](../.claude/rules/providers.md), and [providers.md](providers.md) for the full guide |
| Engine (`packages/engine`)                                       | [`engine.md`](../.claude/rules/engine.md)                                                            |
| Persistence adapters (`packages/persistence-*`)                  | [`persistence.md`](../.claude/rules/persistence.md)                                                  |
| API contract and server (`packages/api-contract`, `apps/server`) | [`server.md`](../.claude/rules/server.md)                                                            |
| Web UI (`apps/web`)                                              | [`web.md`](../.claude/rules/web.md)                                                                  |
| Docker, Helm and configuration                                   | [`deploy.md`](../.claude/rules/deploy.md)                                                            |

## Keeping docs current

Update the docs in the same change as the behaviour: `README.md`, this file, the area rules, `docs/providers.md`, and the design records in `docs/` (or mark a section superseded). The index is [docs/README.md](README.md).
