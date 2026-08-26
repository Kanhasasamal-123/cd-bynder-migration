import { Handler, DynamoDBStreamEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CreativeDriveClient } from './lib/creativedrive-client';
import { S3MigrationService, MigrationAsset } from './lib/S3-based-migration-service';
import { AssetS3Client } from './lib/s3-client';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const secretsClient = new SecretsManagerClient({});

const TABLE_NAME = process.env.MIGRATION_TRACKER_TABLE || '';
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || '';
const AWS_REGION = process.env.AWS_REGION || 'ap-south-1';
const SECRET_NAME = process.env.CREATIVE_DRIVE_SECRET_NAME || '';

/** Division 76 contains grey-background assets. All other divisions are white-background. */
const GREY_BACKGROUND_DIVISION_ID = '76';

/**
 * White-background assets must attach to an already-migrated grey-background
 * asset. Because DynamoDB Streams do not guarantee grey arrives before white,
 * a "no match found" result is retried a few times (with a short delay,
 * re-queued via status=PENDING) before being permanently aborted.
 */
const MAX_MATCH_ATTEMPTS = 5;
const MATCH_RETRY_DELAY_MS = 3000;

/** Cache the resolved API key across warm invocations so we don't call Secrets Manager for every single asset. */
let cachedApiKey: string | null = null;

interface MigrationRecord {
  creativeDriveAssetId: string;
  status: string;
  originalFilename: string;
  filesize: number;
  extension: string;
  sourceUrl: string;
  publicUrl: string;
  divisionId?: string;
  bynderId?: string;
  s3Bucket?: string;
  s3Key?: string;
  s3Uri?: string;
  matchAttempts?: number;
  errorMessage?: string;
  metadata: Record<string, string>;
}

async function getCreativeDriveApiKey(): Promise<string> {
  if (cachedApiKey) {
    return cachedApiKey;
  }

  if (!SECRET_NAME) {
    throw new Error('CREATIVE_DRIVE_SECRET_NAME environment variable is not configured');
  }

  const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));

  if (!response.SecretString) {
    throw new Error('CreativeDrive secret has no SecretString value');
  }

  const parsed = JSON.parse(response.SecretString) as { apiKey: string };

  if (!parsed.apiKey) {
    throw new Error('CreativeDrive secret is missing "apiKey" field');
  }

  cachedApiKey = parsed.apiKey;
  return cachedApiKey;
}

async function getAssetRecord(creativeDriveAssetId: string): Promise<MigrationRecord | null> {
  const command = new GetCommand({
    TableName: TABLE_NAME,
    Key: { creativeDriveAssetId },
  });

  const response = await docClient.send(command);
  return (response.Item as MigrationRecord) || null;
}

async function updateAssetStatus(
  creativeDriveAssetId: string,
  status: string,
  updates: Partial<MigrationRecord> = {}
): Promise<void> {
  const updateExpressions: string[] = ['#status = :status', '#updatedAt = :updatedAt'];
  const expressionAttributeNames: Record<string, string> = {
    '#status': 'status',
    '#updatedAt': 'updatedAt',
  };
  const expressionAttributeValues: Record<string, unknown> = {
    ':status': status,
    ':updatedAt': new Date().toISOString(),
  };

  Object.entries(updates).forEach(([key, value], index) => {
    const attrName = `#attr${index}`;
    const attrValue = `:val${index}`;
    updateExpressions.push(`${attrName} = ${attrValue}`);
    expressionAttributeNames[attrName] = key;
    expressionAttributeValues[attrValue] = value;
  });

  const command = new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { creativeDriveAssetId },
    UpdateExpression: `SET ${updateExpressions.join(', ')}`,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
  });

  await docClient.send(command);
}

async function processAsset(creativeDriveAssetId: string): Promise<void> {
  console.log(`Processing asset: ${creativeDriveAssetId}`);

  try {
    // Step 1: Get asset metadata from DynamoDB
    const record = await getAssetRecord(creativeDriveAssetId);
    if (!record) {
      throw new Error(`Asset record not found: ${creativeDriveAssetId}`);
    }

    if (record.status !== 'PENDING') {
      console.log(
        `Skipping asset ${creativeDriveAssetId} (status: ${record.status}). Only PENDING records are processed.`
      );
      return;
    }

    if (!TABLE_NAME) {
      throw new Error('MIGRATION_TRACKER_TABLE environment variable is not configured');
    }

    if (!S3_BUCKET_NAME) {
      throw new Error('S3_BUCKET_NAME environment variable is not configured');
    }

    // Step 2: Download from CreativeDrive and upload directly to S3
    const apiKey = await getCreativeDriveApiKey();
    const creativeDriveClient = new CreativeDriveClient({ apiKey });
    const s3Client = new AssetS3Client(S3_BUCKET_NAME, AWS_REGION);

    // Pass the DynamoDB doc client and table name through so the service can scan for
    // already-migrated grey-background assets to match white-background assets against.
    const migrationService = new S3MigrationService(creativeDriveClient, s3Client, docClient, TABLE_NAME);

    // Convert DynamoDB record to MigrationAsset format
    const isGreyBackground = record.divisionId === GREY_BACKGROUND_DIVISION_ID;
    const asset: MigrationAsset = {
      creativeDriveAssetId: record.creativeDriveAssetId,
      originalFilename: record.originalFilename,
      publicUrl: record.publicUrl,
      metadata: record.metadata,
      // White-background assets (non-div-76) must attach to an existing grey-background
      // asset already migrated to S3. If no match is found they should be aborted, not
      // created standalone.
      requiresExistingAsset: !isGreyBackground,
    };

    const result = await migrationService.migrateAsset(asset, {
      onProgress: (progress) => {
        console.log(`${progress.stage}: ${progress.message}`);
        if (progress.details) {
          console.log(JSON.stringify(progress.details));
        }
      },
    });

    if (result.aborted) {
      // No matching grey-background asset found yet. Grey asset may not have finished
      // uploading (DynamoDB Streams don't guarantee grey-before-white ordering), so retry
      // a few times before permanently aborting.
      const attempts = (record.matchAttempts || 0) + 1;

      if (attempts < MAX_MATCH_ATTEMPTS) {
        console.log(
          `Asset ${creativeDriveAssetId} no match yet (attempt ${attempts}/${MAX_MATCH_ATTEMPTS}), retrying`
        );

        await new Promise((resolve) => setTimeout(resolve, MATCH_RETRY_DELAY_MS));

        // Set status back to PENDING so this MODIFY re-triggers the stream and the match is retried.
        await updateAssetStatus(creativeDriveAssetId, 'PENDING', { matchAttempts: attempts });
      } else {
        await updateAssetStatus(creativeDriveAssetId, 'ABORTED', {
          errorMessage: result.abortReason,
          matchAttempts: attempts,
        });
        console.log(
          `Asset ${creativeDriveAssetId} aborted after ${attempts} attempts: ${result.abortReason}`
        );
      }

      return;
    }

    if (result.skipped) {
      await updateAssetStatus(creativeDriveAssetId, 'UPLOADED', {
        s3Bucket: result.s3Bucket,
        s3Key: result.s3Key,
        s3Uri: result.s3Uri,
      });
      console.log(
        `Asset ${creativeDriveAssetId} skipped (already attached) -> ${result.s3Uri}`
      );
      return;
    }

    await updateAssetStatus(creativeDriveAssetId, 'UPLOADED', {
      s3Bucket: result.s3Bucket,
      s3Key: result.s3Key,
      s3Uri: result.s3Uri,
    });

    console.log(
      `Successfully processed asset ${creativeDriveAssetId} -> ${result.s3Uri}`
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to process asset ${creativeDriveAssetId}:`, errorMessage);

    await updateAssetStatus(creativeDriveAssetId, 'FAILED', { errorMessage });
    throw error;
  }
}

export const handler: Handler<DynamoDBStreamEvent> = async (event) => {
  console.log('S3 Asset Migration Processor triggered', {
    recordCount: event.Records.length,
  });

  const results = await Promise.allSettled(
    event.Records.map(async (record) => {
      if (record.eventName === 'INSERT' || record.eventName === 'MODIFY') {
        const newImage = record.dynamodb?.NewImage;
        if (newImage?.creativeDriveAssetId?.S) {
          await processAsset(newImage.creativeDriveAssetId.S);
        }
      }
    })
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;

  console.log(`Processing complete: ${succeeded} succeeded, ${failed} failed`);

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'S3 batch processing complete',
      succeeded,
      failed,
    }),
  };
};