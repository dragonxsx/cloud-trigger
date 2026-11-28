# Contributing

1. Read [docs/conventions.md](docs/conventions.md) and the area rules it links to for the code you are changing.
2. Use the latest stable packages (`pnpm add <pkg>@latest`), except for the pinned web stack listed in the conventions.
3. Before opening a pull request, make sure this passes cleanly, with zero new lint warnings:

   ```sh
   pnpm lint && pnpm typecheck && pnpm format:check && pnpm test
   ```

   `pnpm test` needs Docker, because databases run through Testcontainers.

4. Update the docs in the same change as the behaviour ([docs/README.md](docs/README.md) lists them).
5. Write commit messages and pull request titles as [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `feat!:` …). They decide the next version.

## Releases

Releases are automated by [release-please](https://github.com/googleapis/release-please) (`.github/workflows/release.yml`, `release-please-config.json`). Every push to `main` updates an open release pull request that bumps the version, writes `CHANGELOG.md` and sets the Helm chart's `appVersion`. Before 1.0, `feat` bumps the minor version and everything else the patch version. Merging that pull request tags `vX.Y.Z`, creates the GitHub Release, builds the image natively on amd64 and arm64 runners, pushes it to `ghcr.io/dragonxsx/cloud-trigger` as `X.Y.Z`, `X.Y` and `latest` (with SBOM and provenance), and signs it with cosign. The chart's own `version` is still bumped by hand when the chart changes.

## Screenshots and the website

The README and the GitHub Pages site (`site/`, deployed by `.github/workflows/pages.yml`) share the images in `docs/assets/`. When the UI changes visibly, refresh the screenshots from the demo:

```sh
pnpm build
pnpm --filter @cloud-trigger/demo start        # leave it running for a few hours so the dashboard charts fill
pnpm --filter @cloud-trigger/demo screenshots  # in a second terminal
```

`screenshots` signs in as the demo admin and writes light and dark PNGs to `docs/assets/screenshots/`. It uses Chrome from its default macOS location; set `CHROME_PATH` or pass `--chrome` elsewhere. To preview the site, copy `docs/assets` to `site/assets` (ignored by git) and serve `site/` with any static server.
