# Bitbucket Pipelines Setup Guide

This guide explains how to configure and use Bitbucket Pipelines for this project. 

## Overview

The `bitbucket-pipelines.yml` file defines these pipelines:

1. **Pull Request Validation** — Automatically runs on all PRs
2. **CloudFormation Deployment** — Automatically runs on main branch pushes
3. **Manual Migration Trigger** (`run-migration`) — Custom pipeline for ingesting assets
4. **Clear Bynder ID State** (`clear-bynder-id-state`) — Custom pipeline to reset incorrect `bynderId` on tracker records
5. **Retry Failed Assets** (`retry-failed-assets`) — Reset `FAILED` tracker records to `PENDING` for a list of asset IDs
6. **Nightly Migration** (`nightly-migration-76`) — Scheduled-style custom pipeline for division 76
7. **Nightly Migration - White BG** (`nightly-migration-white-bg-divisions`) — Scheduled-style custom pipeline for all white-background divisions (45, 46, 65, 89, 231, 232, 233)

## Prerequisites

### 1. Enable Pipelines

In your Bitbucket repository:
1. Go to **Repository Settings** → **Pipelines** → **Settings**
2. Enable **Pipelines**

### 2. Configure Repository Variables

Go to **Repository Settings** → **Pipelines** → **Repository variables** and add the following:

#### Required for All Pipelines
- `AWS_ACCESS_KEY_ID` - AWS access key ID (secured)
- `AWS_SECRET_ACCESS_KEY` - AWS secret access key (secured)
- `AWS_REGION` - AWS region (default: `us-east-1`)

#### Required for Deployment Pipeline
- `CREATIVEDRIVE_API_KEY` - Creative Drive API key (secured)
- `BYNDER_CLIENT_ID` - Bynder OAuth client ID (secured)
- `BYNDER_CLIENT_SECRET` - Bynder OAuth client secret (secured)
- `BYNDER_ACCESS_TOKEN_URL` - Bynder token endpoint URL
- `BYNDER_API_BASE_URL` - Bynder API base URL
- `LAMBDA_BUCKET` - S3 bucket for Lambda packages (optional, default: `dam-migration-lambda-packages`)
- `STACK_NAME` - CloudFormation stack name (optional, default: `dam-migration-prod`)

#### Required for Migration Pipeline
- `INGEST_LAMBDA` - Ingest Lambda function name (optional, default: `dam-migration-ingest-prod`)

**Note:** Mark sensitive variables (API keys, secrets) as "Secured" when adding them.

### 3. Configure Deployment Environment

1. Go to **Repository Settings** → **Deployments**
2. Create a deployment environment named `migration`
3. This allows you to add environment-specific variables and restrictions

## Pipeline Usage

### 1. Pull Request Validation

**Trigger:** Automatically runs when you create or update a pull request

**What it does:**
- Installs dependencies
- Runs ESLint
- Compiles TypeScript
- Runs unit tests

### 2. CloudFormation Deployment

**Trigger:** Automatically runs when code is pushed to the `main` branch

**What it does:**
1. Lint, build, and test the code
2. Package Lambda functions into a ZIP file
3. Create/verify Lambda package S3 bucket
4. Upload Lambda package to S3
5. Validate CloudFormation template
6. Deploy CloudFormation stack with all parameters
7. Display stack outputs

**To trigger manually:**
1. Go to **Pipelines** in your repository
2. Click **Run pipeline**
3. Select the `main` branch
4. Click **Run**

### 3. Manual Migration Trigger

**Trigger:** Manual - must be triggered via Bitbucket UI

**How to run:**
1. Go to **Pipelines** in your repository
2. Click **Run pipeline**
3. Select **Custom** → **run-migration**
4. Configure the following variables:
   - **MODE**: Migration mode (`delta` or `full`)
     - `delta`: Skip already uploaded assets (default)
     - `full`: Reprocess all assets
   - **MAX_ASSETS**: Maximum number of assets to ingest (default: `10`)
   - **FOLDER_NAMES**: Comma-separated list of folder names to filter (optional)
   - **ASSET_IDS**: Comma-separated list of asset IDs to filter (optional)
5. Click **Run**

**What it does:**
1. Invokes the Ingest Lambda function with specified parameters
2. Monitors the Lambda execution
3. Checks DynamoDB for migration status
4. Displays summary with CloudWatch log locations

### 4. Clear Bynder ID State (`clear-bynder-id-state`)

**Full documentation:** [docs/clear-bynder-id-state-pipeline.md](docs/clear-bynder-id-state-pipeline.md)

**Trigger:** Manual — **Custom** → **clear-bynder-id-state**

**Purpose:** Reset incorrect `bynderId` values on DynamoDB tracker records for a Creative Drive folder/division so assets can be re-migrated. Does not modify Bynder or Creative Drive.

**Quick start:**

1. **Pipelines** → **Run pipeline** → **Custom** → **clear-bynder-id-state**
2. Set `DIVISION_ID` (e.g. `45`) and `FOLDER_ID` (e.g. `104851`) — both required
3. Run with `DRY_RUN=true` first; check CloudWatch for `totalCleared`
4. Run again with `DRY_RUN=false` to apply
5. Re-run migration / let the processor handle `PENDING` records

**Required variables:** `DIVISION_ID`, `FOLDER_ID`

**Common optional variables:** `DRY_RUN` (`true`/`false`), `MAX_ASSETS` (default `10000`)

**Lambda:** `dam-migration-ingest-prod` (override with `INGEST_LAMBDA`). Invoked asynchronously — **check CloudWatch** for results, not the Bitbucket log alone.

### 5. Retry Failed Assets (`retry-failed-assets`)

**Full documentation:** [docs/retry-failed-assets-pipeline.md](docs/retry-failed-assets-pipeline.md)

**Trigger:** Manual — **Custom** → **retry-failed-assets**

**Purpose:** Reset `FAILED` DynamoDB tracker records to `PENDING` for a specific list of asset IDs, **refreshing expired Creative Drive download URLs** first, so the Processor Lambda can retry them.

**Quick start:**

1. Paste IDs into **`ASSET_ID`** (one per line, ~500 per run) — no file upload needed
2. **Pipelines** → **Run pipeline** → **Custom** → **retry-failed-assets**
3. Run with `DRY_RUN=true` first; check CloudWatch for `totalReset`
4. Run again with `DRY_RUN=false`; repeat for remaining batches

**Required variables:** `ASSET_ID` or `ASSET_IDS_FILE` (one of)

### Variable Naming
- **Bitbucket:** `$VARIABLE_NAME`

### Workflow Files
- **Bitbucket:** Single `bitbucket-pipelines.yml` in repository root

### Manual Triggers
- **Bitbucket:** `custom` pipelines with variables

### Artifacts
- **Bitbucket:** `artifacts:` definition in step (automatically available in subsequent steps)

### Deployment Environments
- **Bitbucket:** `deployment:` in step definition

## Monitoring Pipelines

### View Pipeline Runs
1. Go to **Pipelines** in your repository
2. Click on any pipeline run to view detailed logs
3. Each step can be expanded to see full output

### Failed Pipelines
- Failed steps will show in red
- Click on the failed step to see error details
- You can re-run failed pipelines from the UI

## Troubleshooting

### AWS Credentials Issues
- Verify `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are set and marked as secured
- Check that the IAM user has necessary permissions for CloudFormation, Lambda, S3, and DynamoDB

### Lambda Package Upload Fails
- Ensure the S3 bucket name is unique (try changing `LAMBDA_BUCKET` variable)
- Verify AWS credentials have S3 permissions

### CloudFormation Deployment Fails
- Check CloudWatch Logs for detailed error messages
- Verify all required secrets are configured
- Ensure the CloudFormation template is valid

### Migration Pipeline Fails
- Verify Lambda function name matches `INGEST_LAMBDA` variable
- Check DynamoDB table exists: `dam-migration-tracker-prod`
- Review CloudWatch logs for the Lambda functions

## Cost Optimization

Bitbucket provides 50 build minutes/month for free on the Free plan. To optimize:
- Use caching for `node_modules` (already configured)
- Only run deployment pipeline when necessary
- Consider upgrading to a paid plan if you need more build minutes

## Next Steps

After setting up Bitbucket Pipelines:
1. Test the PR pipeline by creating a test pull request
2. Verify deployment pipeline works by pushing to main (or running manually)
3. Test the migration pipeline with a small `MAX_ASSETS` value first
4. Monitor CloudWatch Logs and DynamoDB to verify everything works as expected

## Support

For issues with:
- **Bitbucket Pipelines:** Check [Bitbucket Pipelines Documentation](https://support.atlassian.com/bitbucket-cloud/docs/get-started-with-bitbucket-pipelines/)
- **AWS Resources:** Review CloudWatch Logs and CloudFormation events
- **Migration Logic:** Check the source code and unit tests
