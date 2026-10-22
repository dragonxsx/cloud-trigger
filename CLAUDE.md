# cloud-trigger

Self-hosted service that triggers remote endpoints on schedules (cron, interval, once) and records each run.

- Definition of done: `pnpm lint && pnpm typecheck && pnpm format:check && pnpm test`, all clean.
- Don't commit or push unless asked.
- Per-area rules in `.claude/rules/` load automatically when you touch matching files.
- To add a provider, read `docs/providers.md`. Design records and other docs are indexed in `docs/README.md`.
- Machine-specific notes (ports, binary paths) go in the gitignored `CLAUDE.local.md`, not here.

The rules below apply to every change:

@docs/conventions.md
