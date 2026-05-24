# Clear Bynder ID State Pipeline

Reset incorrect `bynderId` values on migration tracker records so assets can be re-uploaded to Bynder with the correct linkage.

This uses the **Ingest Lambda** with a dedicated event action (`clear-bynderId-state`). It does **not** delete assets in Bynder or Creative Drive — it only updates the DynamoDB tracker table.

## When to use

Use this pipeline when:

- `bynderId` was set incorrectly on tracker records (e.g. wrong grey-background match, bad re-run).
- You need to re-process a folder/division through the normal migration flow.
- Records are `UPLOADED` but should be treated as not yet migrated.

Typical case: all assets in a Creative Drive **folder** and **division** need their tracker state reset (e.g. folder `104851`, division `45`).

## Prerequisites

1. **Deployed code** — Ingest Lambda must include the `clear-bynderId-state` handler (merge to `main` and run the deployment pipeline, or deploy manually).
2. **Bitbucket repository variables** — Same AWS credentials as other pipelines (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`).
3. **Optional:** `INGEST_LAMBDA` (default: `dam-migration-ingest-prod`).

## How to run (Bitbucket)

1. Open **Pipelines** → **Run pipeline**.
2. Choose branch (usually `main`).
3. Select **Custom** → **`clear-bynder-id-state`**.
4. Set variables (see table below).
5. Click **Run**.

The pipeline invokes the Ingest Lambda asynchronously (`StatusCode 202`). **Results appear in CloudWatch**, not in the Bitbucket step output.

### Recommended workflow

| Step | `DRY_RUN` | Purpose |
|------|-----------|---------|
| 1 | `true` | Confirm `totalMatching` / `totalCleared` counts in logs without writing |
| 2 | `false` | Apply `REMOVE bynderId` and `status = PENDING` |
| 3 | — | Re-run normal migration (`run-migration` or processor) for those assets |

### Pipeline variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DIVISION_ID` | **Yes** | — | Creative Drive division ID (e.g. `45`) |
| `FOLDER_ID` | **Yes** | — | Creative Drive folder ID (e.g. `104851`) |
| `MAX_ASSETS` | No | `10000` | Max assets to fetch from Creative Drive |
| `DRY_RUN` | No | `false` | `true` = log only, no DynamoDB updates |
| `FETCH_OFFSET` | No | — | Skip first N assets from CD search (pagination) |
| `SYNC_LAST_DAYS` | No | — | Limit CD search to last N days (omit for full folder scan) |
| `DATE_FROM` | No | — | CD search start (`DD/MM/YY`), use with `DATE_TO` |
| `DATE_TO` | No | — | CD search end (`DD/MM/YY`) |
| `FETCH_SORT` | No | `desc` | Sort order for CD asset search |

If `SYNC_LAST_DAYS` and `DATE_FROM`/`DATE_TO` are all omitted, the Lambda uses a wide date window so all assets in the folder are included.

### Example: folder 104851, division 45

```
DIVISION_ID = 45
FOLDER_ID   = 104851
DRY_RUN     = true    # first run
MAX_ASSETS  = 10000
```

Then repeat with `DRY_RUN = false`.

## What the Lambda does

1. **Fetch** asset IDs from Creative Drive for the given `divisionId` + `folderId` (same search as ingest).
2. **Resolve** folder on each asset (`folder_id` or `ts_folder_id`).
3. For each asset ID that **exists** in the migration tracker table:
   - **REMOVE** attribute `bynderId`
   - **SET** `status` = `PENDING`
   - **SET** `updatedAt` = now
4. Skip asset IDs not found in DynamoDB (`totalSkippedNotInDynamo`).

Assets are **not** re-ingested with full metadata in this action — only tracker fields above are updated.

### Lambda payload (reference)

```json
{
  "action": "clear-bynderId-state",
  "divisionId": "45",
  "folderId": "104851",
  "maxAssets": 10000,
  "fetchSort": "desc",
  "dryRun": false
}
```

Defined in `bitbucket-pipelines.yml` under custom pipeline `clear-bynder-id-state`. Handler: `src/ingest.ts` → `handleClearBynderIdState`. DynamoDB update: `src/lib/dynamodb-client.ts` → `clearBynderIdForAsset`.

## Verifying success

### CloudWatch Logs

Log group: `/aws/lambda/dam-migration-ingest-prod` (or your `INGEST_LAMBDA` name).

Look for completion log `clear-bynderId-state completed` with:

| Field | Expected |
|-------|----------|
| `totalFetched` | Number of assets returned from Creative Drive |
| `totalMatching` | Assets processed (usually equals `totalFetched`) |
| `totalCleared` | DynamoDB updates succeeded |
| `totalFailures` | `0` |
| `totalSkippedNotInDynamo` | IDs in CD but not in tracker table |
| `dryRun` | `false` when applying changes |

Per-asset lines: `Cleared bynderId for <creativeDriveAssetId> ...`

### DynamoDB

Check a known record (e.g. `4206785`):

- `bynderId` attribute should be **absent**
- `status` should be **`PENDING`**

```bash
aws dynamodb get-item \
  --table-name dam-migration-tracker-prod \
  --key '{"creativeDriveAssetId":{"S":"4206785"}}'
```

### After clearing

`PENDING` records are picked up by the **Processor Lambda** when the DynamoDB stream fires, or you can trigger migration via the **`run-migration`** custom pipeline (ingest + stream flow depending on your setup).

For white-background assets (non-division-76), ensure the correct grey-background Bynder asset exists before re-processing.

## Manual invoke (AWS CLI)

Same payload as the pipeline:

```bash
aws lambda invoke \
  --function-name dam-migration-ingest-prod \
  --invocation-type Event \
  --payload '{"action":"clear-bynderId-state","divisionId":"45","folderId":"104851","maxAssets":10000,"dryRun":true}' \
  --cli-binary-format raw-in-base64-out \
  /dev/null
```

Use `--invocation-type RequestResponse` and capture output to a file if you want the JSON response in the terminal (synchronous, may timeout on large folders).

## Troubleshooting

| Symptom | Cause | Fix |
|---------|--------|-----|
| `totalMatching: 0` but `totalFetched: 72` | Old code filtered on `folder_id` only; CD uses `ts_folder_id` | Deploy latest ingest Lambda |
| `totalFailures: 72`, error near `, SET updatedAt` | Invalid DynamoDB `UpdateExpression` (`REMOVE` and `SET` comma-joined) | Deploy latest `dynamodb-client` fix |
| `totalCleared: 0`, all skipped | Records not in tracker table | Run ingest for folder first, or check `creativeDriveAssetId` |
| Bitbucket shows `202` but no change | Async invoke — check CloudWatch, not pipeline logs | Tail ingest Lambda logs |
| Record still `UPLOADED` | Job failed or wrong asset ID | Confirm asset ID in CD result set and re-run with `DRY_RUN=false` |

## Related pipelines

| Pipeline | Purpose |
|----------|---------|
| `run-migration` | Ingest assets from Creative Drive into tracker (`action` omitted = normal ingest) |
| `clear-bynder-id-state` | Remove `bynderId` and set `PENDING` for a folder/division |
| Processor (automatic) | Stream on tracker table uploads `PENDING` assets to Bynder |

See also [BITBUCKET_SETUP.md](../BITBUCKET_SETUP.md) for general pipeline configuration.
