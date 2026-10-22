# Contributing

1. Read [docs/conventions.md](docs/conventions.md) and the area rules it links to for the code you are changing.
2. Use the latest stable packages (`pnpm add <pkg>@latest`), except for the pinned web stack listed in the conventions.
3. Before opening a pull request, make sure this passes cleanly, with zero new lint warnings:

   ```sh
   pnpm lint && pnpm typecheck && pnpm format:check && pnpm test
   ```

   `pnpm test` needs Docker, because databases run through Testcontainers.

4. Update the docs in the same change as the behaviour ([docs/README.md](docs/README.md) lists them).
