# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Architecture

See `docs/ARCHITECTURE.md` for the up-to-date architecture reference (components, DynamoDB schema, secrets, CI/CD flow) and its own "Known discrepancies with older docs" section. Keep it in sync with `src/ingest.ts`, `src/processor.ts`, `src/lib/*`, and `cloudformation/infrastructure.yml` when any of those change - don't let `README.md`'s "Architecture" section or `infra_dia.mmd` drift again; they should stay pointers to the detailed doc, not a second source of truth.

Sharp edges found while writing that doc (2026-07-14), still true as of this writing:

- `cloudformation/infrastructure.yml` provisions an S3 bucket (`MigrationAssetsBucket`) and grants the Processor Lambda S3 permissions, but no Lambda code actually uses S3 - assets stream CreativeDrive -> Lambda memory -> Bynder directly. Don't assume S3 involvement when debugging the upload path.
- `src/config.ts` (`validateConfig`) is a dead stub not imported anywhere; both Lambdas read `process.env` directly.
- DynamoDB tracker `status` has four values in practice: `PENDING`, `UPLOADED`, `FAILED`, `ABORTED` (not three - `ABORTED` is easy to miss since it only fires for white-background divisions with no matching grey-background Bynder asset).
- The "nightly" Bitbucket custom pipelines (`nightly-migration-76`, `nightly-migration-white-bg-divisions`) have no schedule defined in `bitbucket-pipelines.yml` itself; scheduling (if any) lives in Bitbucket's own Scheduled Pipelines UI, not in the repo.
