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
2. Paste asset IDs into **`ASSET_ID`** — **one ID per line** (recommended, ~500 per run) or comma-separated
3. Optionally use **`ASSET_IDS_FILE`** if the IDs are already committed in the repo
4. Run with **`DRY_RUN=true`** first; check CloudWatch for `totalReset`
5. Run again with **`DRY_RUN=false`** to apply

### Pipeline variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ASSET_ID` | One of ASSET_ID / ASSET_IDS_FILE | — | Creative Drive asset IDs: **one per line** (paste) or comma-separated |
| `ASSET_IDS_FILE` | One of ASSET_ID / ASSET_IDS_FILE | — | Repo file path, one ID per line (optional) |
| `DRY_RUN` | No | `true` | `true` = log only, no DynamoDB writes |
| `ONLY_FAILED` | No | `true` | `true` = skip records that are not `FAILED` |
| `SYNC_INVOKE` | No | `true` | `true` = wait for Lambda and print result in Bitbucket log |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Bitbucket green but nothing in CloudWatch | Old pipeline used async invoke; wrong log group | Check **Bitbucket step log** first; use log group `/aws/lambda/dam-migration-ingest-prod` |
| `Parsed asset count: 0` | Bitbucket stripped newlines from `ASSET_ID` | Use comma-separated on one line, or fewer IDs |
| Lambda `divisionId must be provided` | Ingest Lambda not deployed with `retry-failed-assets` handler | Merge branch and run deployment pipeline |
| `ResourceNotFoundException` | Wrong `INGEST_LAMBDA` name or region | Pipeline now prints `aws sts get-caller-identity` and `get-function` for verification |

### Example: 500 IDs pasted into ASSET_ID

1. **Pipelines** → **Run pipeline** → **Custom** → **retry-failed-assets**
2. Paste into **`ASSET_ID`** (one ID per line):

```
1005992
1005993
1005994
...
```

3. Set variables:

```
DRY_RUN     = true
ONLY_FAILED = true
```

4. Confirm CloudWatch log `retry-failed-assets completed` shows expected `totalReset`.
5. Re-run with `DRY_RUN=false`.
6. Repeat for the next 500 IDs until all ~1153 are done.

### Example: IDs from a repo file (optional)

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

### Bitbucket pipeline log (recommended)

The pipeline defaults to **`SYNC_INVOKE=true`**, so the Lambda result is printed in the **Bitbucket step log** (look for `retry-failed-assets completed` and `totalReset`). You do not need CloudWatch for the first check.

Set `SYNC_INVOKE=false` only if you want fire-and-forget async invoke (then use CloudWatch).

### CloudWatch Logs

Log group: `/aws/lambda/dam-migration-ingest-prod` (not Bitbucket Cloud Insights)

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
