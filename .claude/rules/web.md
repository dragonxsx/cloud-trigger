---
paths:
  - 'apps/web/**'
---

# Web (`apps/web`)

- The UI is Refine core 5 with `@refinedev/mantine` (Mantine 5 + Emotion), on React 18 and React Router 7.
- All data goes through the typed oRPC client in `src/lib/api.ts`.
  - A new resource gets a `ResourceAdapter` entry in `src/providers/data-provider.ts`. Parse writes with the core or contract zod schemas.
  - Map `INVALID_CONFIG` issues to Refine field `errors`.
- Live updates use `src/providers/live-provider.ts` over the SSE route. One stream is shared by all subscribers, and oRPC's `ClientRetryPlugin` reconnects it (`retry: Infinity`).
- Forms use `useForm` from `@mantine/form` (Refine's `useForm` for resource CRUD), not one `useState` per field. Put rules in `validate`, render `<form noValidate>` and submit through `form.onSubmit(…, () => focusFirstInvalidField())`; read errors with `fieldError(form.errors, path)`.
- Provider configs are rendered by RJSF 6 with the custom Mantine 5 theme in `src/components/rjsf-theme.tsx`. `@rjsf/mantine` needs Mantine 8, so don't use it.
  - Validation uses Ajv 2020.
  - Use `experimental_defaultFormStateBehavior={{ emptyObjectFields: 'populateRequiredDefaults' }}`.
- Charts use ECharts 6 through `echarts/core` with only the needed charts and components registered, rendered by `echarts-for-react/esm/core`. The CommonJS `lib/` entry breaks under Vite.
- Workflow graphs are laid out by dagre (`src/lib/graph-layout.ts`, left to right), and edges follow dagre's bend points through the `routed` edge type. Keep `nodeHeight` in step with what `StepNodeView` renders. `EdgeRoute` is a `type`, not an `interface`, because React Flow edge data needs an index signature.
- Run statuses use the reserved palette `RUN_STATUS_STYLE` from core (wrapped by `src/lib/status.tsx`, and shared with the badges and the charts), and those colours are never reused for categories. Group colours come from `GROUP_SWATCHES`.
- Job and workflow targets, event-source triggers and notification rules are edited with `ConnectedProviderPicker` (`kind` is `target`, `trigger` or `notifier`), which adds the connection and endpoint pickers. With an endpoint picked, it renders the target schema without `required` and `default` (`patchSchema`), so the form only produces overrides.
- Pages are lazy-loaded through `lazyNamed` in `App.tsx`. Keep the initial bundle under 1 MB, and keep `chunkSizeWarningLimit` at 600 kB (the ECharts chunk is the largest). React, React Router and TanStack Query go to a fixed `react-vendor` chunk (`codeSplitting.groups` in `vite.config.ts`); without it, rolldown's automatic chunking folds them into `index` whenever a new lazy page changes the import graph.
- When a CommonJS-only dependency lacks named ESM exports, Vitest and Node can disagree (Vitest uses the `module` field). Check new dependencies by importing the built `dist` in plain Node, as the server does; `rrule.ts` shows the interop pattern.
- Styling: theme tokens live in `src/theme.ts`, and CSS variables `--ct-*` live in `src/styles.css`, with dark mode under `[data-theme='dark']`. The fonts are Hanken Grotesk and JetBrains Mono.
- Before declaring a UI change done, run the dev servers (web on 5173 by default, API on 8080) and screenshot the page in headless Chrome, for example `chrome --headless=new --screenshot=out.png --window-size=1440,1000 http://localhost:5173/`. Put machine-specific ports and the Chrome binary path in your `CLAUDE.local.md`.
