# Retry Failed Assets Pipeline

Reset `FAILED` migration tracker records to `PENDING` so the Processor Lambda can retry uploading them to Bynder.

Uses the **Ingest Lambda** with action `retry-failed-assets`. Fetches fresh download URLs from Creative Drive, then updates DynamoDB. Does not call Bynder.

## When to use

- Assets reached DynamoDB but the **Processor** marked them `FAILED` (e.g. transient network errors).
- Stored `publicUrl` values may have **expired** — this action refreshes them from Creative Drive before re-queueing.
- You have a list of `creativeDriveAssetId` values to retry.
- You do not have AWS Console access but can run Bitbucket pipelines.

## Prerequisites

1. **Deployed code** — Ingest Lambda must include the `retry-failed-assets` handler (merge to `main` and run the deployment pipeline).
2. **Bitbucket repository variables** — Same AWS credentials as other pipelines (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`).

## How to run (Bitbucket)

1. **Pipelines** → **Run pipeline** → **Custom** → **`retry-failed-assets`**
2. Provide asset IDs using **one** of:
   - **`ASSET_ID`** — comma-separated list (fine for small batches)
   - **`ASSET_IDS_FILE`** — path to a file in the repo, one ID per line (recommended for ~1000+ IDs)
3. Run with **`DRY_RUN=true`** first; check CloudWatch for `totalReset`
4. Run again with **`DRY_RUN=false`** to apply

### Pipeline variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ASSET_ID` | One of ASSET_ID / ASSET_IDS_FILE | — | Comma-separated Creative Drive asset IDs |
| `ASSET_IDS_FILE` | One of ASSET_ID / ASSET_IDS_FILE | — | Repo file path, one ID per line (e.g. `data/retry-asset-ids.txt`) |
| `DRY_RUN` | No | `true` | `true` = log only, no DynamoDB writes |
| `ONLY_FAILED` | No | `true` | `true` = skip records that are not `FAILED` |

### Example: 1153 IDs from a file

1. Create `data/retry-asset-ids.txt` in the repo (one ID per line).
2. Commit and push to the branch you run the pipeline from.
3. Run pipeline:

```
ASSET_IDS_FILE = data/retry-asset-ids.txt
DRY_RUN        = true
ONLY_FAILED    = true
```

4. Confirm CloudWatch log `retry-failed-assets completed` shows expected `totalReset`.
5. Re-run with `DRY_RUN=false`.

## What the Lambda does

1. **BatchGet** existing records from the migration tracker table.
2. For each eligible ID, **fetch fresh URLs from Creative Drive** (`GET /assets/{id}` + `/metadatas`).
3. **SET** `status` = `PENDING`, **SET** `publicUrl` / `sourceUrl`, **REMOVE** `errorMessage`.
4. Processor Lambda picks up `PENDING` records via the DynamoDB stream (max 7 concurrent).

### Lambda payload (reference)

```json
{
  "action": "retry-failed-assets",
  "assetIds": ["1005992", "1005993"],
  "dryRun": false,
  "onlyFailed": true
}
```

## Verifying success

### CloudWatch Logs

Log group: `/aws/lambda/dam-migration-ingest-prod`

Look for `retry-failed-assets completed`:

| Field | Expected |
|-------|----------|
| `totalRequested` | Number of IDs you supplied |
| `totalReset` | Records updated to `PENDING` |
| `totalSkippedNotFailed` | IDs not in `FAILED` status |
| `totalSkippedNotInDynamo` | IDs missing from tracker table |
| `totalFailures` | `0` |

Then monitor `/aws/lambda/dam-migration-processor-prod` as assets are reprocessed.

## Related pipelines

| Pipeline | Purpose |
|----------|---------|
| `retry-failed-assets` | Reset `FAILED` → `PENDING` for specific asset IDs |
| `run-migration` | Ingest assets from Creative Drive (does not retry `FAILED` in delta mode) |
| `clear-bynder-id-state` | Remove incorrect `bynderId` for a whole folder |
