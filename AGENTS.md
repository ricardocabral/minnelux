# Working on Minnelux

## Language and documentation

- Always write code comments, technical documentation, pull requests, and issues in English, regardless of the conversation language. Use English for GitHub titles, descriptions, and review comments. Use `## Post-merge plan` when a PR requires one.
- Update the canonical document in place and describe the current design. Keep change history in Git. Follow [CONTRIBUTING.md](CONTRIBUTING.md) for contribution and security checks.

## Shared checkout

Check `git status --short --branch` and compare `HEAD` with `origin/main` before editing or assessing what has landed. If parallel work may have changed the base, refresh `origin/main` with `git fetch origin main`. In a stale checkout, read the current specs with `git show origin/main:<path>`. Preserve existing edits by working in a separate worktree based on the current upstream commit. Give parallel workers the base SHA and the paths each owns.

## Start with the relevant contract

| Task | Start here |
| --- | --- |
| Product, privacy, and provider requirements | [Minnelux PRD](docs/prod/minnelux-prd.md) |
| Web UI and implementation order | [Web client spec](docs/dev/web-client/SPEC.md), [approved mockup](docs/prod/web-client-mockup.html), and [implementation plan](plans/web-client.md) |
| UI and library worker integration | [Worker message types](apps/web/src/library/worker-contract.ts) |
| Storage adapters, catalog, and publication | [Storage spec](docs/dev/storage/SPEC.md) and [adapter types](apps/web/src/storage/contract.ts) |
| Flickr ZIPs and catalog conversion | [Importer guide](apps/flickr-import/README.md), [importer spec](docs/dev/flickr-import/SPEC.md), and [repository contract](docs/dev/flickr-import/REPOSITORY-CONTRACT.md) |
| Provider behavior and live checks | [GCS browser proof](spikes/gcs/README.md), [S3 browser proof](spikes/s3/README.md), and [S3 owner setup](docs/prod/connect-amazon-s3.md) |

The client runs on static HTTPS and accesses the library owner's private bucket directly. Keep provider behavior inside adapters. **Remember login** saves one short-lived Google Cloud Storage login in browser IndexedDB when the user opts in. [Web client setup](apps/web/README.md#stay-connected-across-reloads)

Preserve original bytes and publish revisions by conditionally updating the library head. The Flickr importer has browser and command-line entry points that generate supported previews locally. The web client reads Flickr v1 revisions and writes v2 manifests. Preserve source metadata and media references through edits and upgrades. [CLI workflow](docs/prod/import-flickr-cli.md)

## Verify the affected path

- **Web client.** Use Node 24 or later. In `apps/web`, run `npm ci`, then the relevant checks from `npm run check`, `npm test`, and `npm run build`. For browser behavior, install Chromium with `npx playwright install chromium` and run `npm run test:browser` with a focused filter. Playwright starts a synthetic fixture server on port 4173. For Google sign-in changes, run `npm run test:browser -- google-login.browser.spec.ts`. [Web client setup](apps/web/README.md)
- **Flickr importer.** In `apps/flickr-import`, run `npm ci`, `npm test`, and `npm run build`. Use the [synthetic export](apps/flickr-import/README.md#verify-with-a-synthetic-export) and the [Flickr export format reference](docs/dev/flickr-import/EXPORT-FORMAT.md). Use synthetic data by default and a dedicated private test library for hosted checks.

## Firebase Hosting

Use the [Firebase Hosting runbook](spikes/gcs/README.md#redeploy). Identify the commit, Firebase site, and target path before publishing. Firebase replaces the full site's file set. Preserve the probe at `/`, the importer at `/flickr-import/`, and the static client at `/web/` when it is hosted on the same site, including the headers each route needs. For a web release, stage the regular `apps/web/dist/` build under `/web/`. After publishing, verify all staged routes and follow the runbook's rollback procedure if a route regresses.
