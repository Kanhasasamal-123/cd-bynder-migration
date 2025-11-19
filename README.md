# CreativeDrive to Bynder DAM Migration

A serverless AWS infrastructure and TypeScript application for migrating 2.7GB of digital assets from Accenture CreativeDrive to Bynder.

## Project Overview

This project implements a complete, production-ready digital asset migration system with:

- **Infrastructure as Code**: All AWS resources managed via CloudFormation
- **Serverless Architecture**: AWS Lambda functions for scalable processing
- **Tracking & Monitoring**: DynamoDB table tracks each asset's migration status
- **Secure Credentials**: AWS Secrets Manager stores API keys
- **CI/CD Pipeline**: Bitbucket automates deployment

## Architecture

### Components

1. **CreativeDrive Ingest Lambda** (`src/ingest.ts`)
   - Queries CreativeDrive API to retrieve asset listings
   - Navigates the folder hierarchy (Divisions → Root Folders → Subfolders → Assets)
   - Writes asset metadata to DynamoDB with `PENDING` status

2. **Asset Migration Processor Lambda** (`src/processor.ts`)
   - Triggered by DynamoDB Streams when assets are added
   - Downloads assets from CreativeDrive and uploads directly to Bynder
   - **Direct upload optimization**: Streams assets directly without S3 intermediate storage (~$167 cost savings)
   - Simulates upload to Bynder (ready for actual Bynder API integration)
   - Updates DynamoDB status (`PENDING` → `UPLOADED` or `FAILED`)

3. **DynamoDB Table** (`MigrationTrackerTable`)
   - Partition Key: `creativeDriveAssetId` (String)
   - Tracks: filename, filesize, status, URLs, timestamps, error messages

4. **Secrets Manager**
   - CreativeDrive API credentials
   - Bynder API credentials

## CreativeDrive API Integration

Based on the provided Postman collection, the application implements:

### API Endpoints

1. **Divisions List**
   ```
   GET https://sandbox-share-api.creativedrive.com/api/v1/divisions
   ```
   - Retrieves all divisions with storage information
   - Returns: Division ID, name, storage size, folder count

2. **Root Folders Search**
   ```
   POST https://sandbox-share-api.creativedrive.com/api/v1/folders/_search
   Body: {
     "conditions": [
       "division_id = <divisionId>",
       "parent_id IS NULL",
       "active"
     ]
   }
   ```
   - Finds root-level folders in a division

3. **Subfolders List**
   ```
   GET https://sandbox-share-api.creativedrive.com/api/v1/folders/<folderId>/folders
   ```
   - Retrieves subfolders within a parent folder

4. **Assets List**
   ```
   GET https://sandbox-share-api.creativedrive.com/api/v1/folders/<folderId>/assets
   Query params: limit=100&offset=<offset>
   ```
   - Paginated asset retrieval (default 25, max 100 per page)
   - Returns: Asset ID, filename, filesize, extension, URL, path

5. **Asset Metadata**
   ```
   GET https://sandbox-share-api.creativedrive.com/api/v1/assets/<assetId>/metadatas
   ```
   - Detailed metadata for a specific asset

6. **Asset Search (Advanced)**
   ```
   POST https://sandbox-share-api.creativedrive.com/api/v1/search
   Body: {
     "parent_folder": <folderId>,
     "offset": <offset>,
     "limit": <limit>
   }
   ```
   - Retrieves assets with signed download URLs

### Authentication

All API requests require an API key sent in the Authorization header:
```
Authorization: <API Key>
```

The API key is securely stored in AWS Secrets Manager and retrieved at runtime.

### Data Volume

## Prerequisites

- Node.js 20.x or later
- npm or yarn
- AWS CLI configured with appropriate credentials
- AWS account with permissions for:
  - CloudFormation
  - Lambda
  - DynamoDB
  - S3
  - Secrets Manager
  - IAM
  - CloudWatch Logs

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd creative-drive-bynder-migration

# Install dependencies
npm install

# Install Husky hooks
npm run prepare
```

## Configuration

### Repo Secrets

Configure these secrets in your Bitbucket repository settings

**Required Secrets:**
- `AWS_ACCESS_KEY_ID` - Your AWS access key
- `AWS_SECRET_ACCESS_KEY` - Your AWS secret key
- `CREATIVEDRIVE_API_KEY` - CreativeDrive API key
- `BYNDER_CLIENT_ID` - Bynder OAuth client ID
- `BYNDER_CLIENT_SECRET` - Bynder OAuth client secret
- `BYNDER_ACCESS_TOKEN_URL` - Bynder OAuth token URL
- `BYNDER_API_BASE_URL` - Bynder API base URL

## Deployment

### Automatic Deployment (Recommended)

See DEPLOYMENT_GUIDE.md

### Manual Deployment

If you need to deploy manually:

```bash
# Build and test
npm run build
npm test

# Package Lambda functions
cd dist
zip -r ../lambda-deployment.zip .
cd ..
zip -r lambda-deployment.zip node_modules

# Upload to S3
aws s3 cp lambda-deployment.zip s3://dam-migration-lambda-packages/

# Deploy CloudFormation stack
aws cloudformation deploy \
  --template-file cloudformation/infrastructure.yml \
  --stack-name dam-migration-personal \
  --parameter-overrides \
    Environment=personal \
    ProjectName=dam-migration \
    CreativeDriveApiKey=YOUR_API_KEY \
    BynderClientId=YOUR_CLIENT_ID \
    BynderClientSecret=YOUR_CLIENT_SECRET \
    BynderAccessTokenUrl=YOUR_TOKEN_URL \
    BynderApiBaseUrl=YOUR_API_URL \
    LambdaZipBucket=dam-migration-lambda-packages \
    LambdaZipKey=lambda-deployment.zip \
  --capabilities CAPABILITY_NAMED_IAM \
  --region us-east-1
```

## Development

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm test -- --watch

# Run tests with coverage
npm test -- --coverage

# Run integration test
npm run test:integration
```

### Linting

```bash
# Run ESLint
npm run lint

# Auto-fix linting issues
npm run lint:fix
```

### Type Checking

```bash
# Compile TypeScript
npm run build

# Type check without emitting files
npx tsc --noEmit
```

### Pre-commit Hooks

Husky automatically runs `lint` and `build` before every commit. This ensures code quality and prevents broken code from being committed.

## Usage

### Trigger Ingestion (Automatic)

Run DAM Migration pipeline in Bitbucket
-- specify maxAssets
-- specify mode (delta: migrate next n assets, full: migrate n assets)
-- optionally specify FOLDER_NAMES / ASSET_IDS


### Trigger Ingestion (Manual)

Invoke the Ingest Lambda function:

```bash
aws lambda invoke \
  --function-name CreativeDriveIngestLambda \
  --payload '{}' \
  response.json

cat response.json
```

### Monitor Progress

Query DynamoDB to check migration status:

```bash
aws dynamodb scan \
  --table-name MigrationTrackerTable \
  --filter-expression "attribute_exists(#status)" \
  --expression-attribute-names '{"#status":"status"}'
```

### Check CloudWatch Logs

```bash
# Ingest Lambda logs
aws logs tail /aws/lambda/CreativeDriveIngestLambda --follow

# Processor Lambda logs
aws logs tail /aws/lambda/AssetMigrationProcessorLambda --follow
```

## DynamoDB Schema

### MigrationTrackerTable

| Attribute | Type | Description |
|-----------|------|-------------|
| `creativeDriveAssetId` | String (PK) | Unique asset ID from CreativeDrive |
| `status` | String | PENDING, UPLOADED, FAILED |
| `originalFilename` | String | Original filename from CreativeDrive |
| `filesize` | Number | File size in bytes |
| `extension` | String | File extension (e.g., 'tif', 'jpg') |
| `sourceUrl` | String | CreativeDrive download URL |
| `publicUrl` | String | Public URL for accessing the asset |
| `bynderId` | String | Bynder asset ID after upload |
| `divisionId` | String | CreativeDrive division ID |
| `folderId` | String | CreativeDrive folder ID |
| `metadata` | Object | Asset metadata as key-value pairs |
| `errorMessage` | String | Error details if migration fails |
| `createdAt` | String | Timestamp when record was created |
| `updatedAt` | String | Timestamp of last update |

**Status Values:**
- `PENDING`: Asset queued for processing
- `UPLOADED`: Asset successfully uploaded to Bynder
- `FAILED`: Asset migration failed (see errorMessage)

## Troubleshooting

### Lambda Function Timeouts

If processing large files, increase Lambda timeout in `cloudformation/infrastructure.yml`:

```yaml
ProcessorLambda:
  Type: AWS::Lambda::Function
  Properties:
    Timeout: 900  # 15 minutes (current: 300)
```

Then deploy the updated stack.

### DynamoDB Throughput

The table already uses `PAY_PER_REQUEST` billing mode for automatic scaling. No manual configuration needed.

## Security Considerations

- API keys stored securely in AWS Secrets Manager
- Lambda functions use least-privilege IAM roles
- All resources deployed in private VPC (optional)
- CloudWatch Logs for audit trail
