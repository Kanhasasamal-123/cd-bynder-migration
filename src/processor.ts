import { Handler, DynamoDBStreamEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { BynderClient, BynderCredentials } from './lib/bynder-client';
import { CreativeDriveClient } from './lib/creativedrive-client';
import { MigrationService, MigrationAsset } from './lib/migration-service';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const secretsClient = new SecretsManagerClient({});

const TABLE_NAME = process.env.MIGRATION_TRACKER_TABLE || '';
const BYNDER_SECRET_NAME = process.env.BYNDER_SECRET_NAME || '';

interface MigrationRecord {
  creativeDriveAssetId: string;
  status: string;
  originalFilename: string;
  filesize: number;
  extension: string;
  sourceUrl: string;
  publicUrl: string;
  migrationMode?: 'full' | 'delta';
  bynderId?: string;
  errorMessage?: string;
  metadata: Record<string, string>;
}

async function getBynderCredentials(): Promise<BynderCredentials> {
  const command = new GetSecretValueCommand({ SecretId: BYNDER_SECRET_NAME });
  const response = await secretsClient.send(command);

  if (!response.SecretString) {
    throw new Error('Bynder secret not found');
  }

  return JSON.parse(response.SecretString) as BynderCredentials;
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
  const expressionAttributeValues: Record<string, any> = {
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

/**
 * Migrate asset from CreativeDrive to Bynder using shared client libraries
 */
async function migrateAssetToBynder(
  asset: MigrationAsset,
  credentials: BynderCredentials
): Promise<string> {
  // Create clients
  const creativeDriveClient = new CreativeDriveClient({
    apiKey: '', // Not needed for download if we already have the publicUrl
  });
  const bynderClient = new BynderClient(credentials);
  const migrationService = new MigrationService(creativeDriveClient, bynderClient);

  // Migrate the asset
  const result = await migrationService.migrateAsset(asset, {
    onProgress: (progress) => {
      console.log(`${progress.stage}: ${progress.message}`);
      if (progress.details) {
        console.log(JSON.stringify(progress.details));
      }
    },
  });

  console.log(`Successfully uploaded to Bynder: ${result.bynderId}`);
  console.log(`Filename: ${result.filename}`);

  return result.bynderId;
}

async function processAsset(creativeDriveAssetId: string): Promise<void> {
  console.log(`Processing asset: ${creativeDriveAssetId}`);

  try {
    // Step 1: Get asset metadata from DynamoDB
    const record = await getAssetRecord(creativeDriveAssetId);
    if (!record) {
      throw new Error(`Asset record not found: ${creativeDriveAssetId}`);
    }

    // In delta mode, skip already processed assets
    // In full mode, reprocess even if UPLOADED
    const mode = record.migrationMode || 'delta';
    if (record.status !== 'PENDING' && mode === 'delta') {
      console.log(`Asset ${creativeDriveAssetId} is already processed (status: ${record.status})`);
      return;
    }

    if (record.status === 'UPLOADED' && mode === 'full') {
      console.log(`Asset ${creativeDriveAssetId} is UPLOADED but mode is 'full', reprocessing...`);
    }

    // Step 2: Download from CreativeDrive and upload directly to Bynder
    const bynderCredentials = await getBynderCredentials();

    // Convert DynamoDB record to MigrationAsset format
    const asset: MigrationAsset = {
      creativeDriveAssetId: record.creativeDriveAssetId,
      originalFilename: record.originalFilename,
      publicUrl: record.publicUrl,
      metadata: record.metadata,
    };

    const bynderId = await migrateAssetToBynder(asset, bynderCredentials);

    await updateAssetStatus(creativeDriveAssetId, 'UPLOADED', { bynderId });

    console.log(`Successfully processed asset ${creativeDriveAssetId} -> Bynder ID: ${bynderId}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to process asset ${creativeDriveAssetId}:`, errorMessage);

    await updateAssetStatus(creativeDriveAssetId, 'FAILED', { errorMessage });
    throw error;
  }
}

export const handler: Handler<DynamoDBStreamEvent> = async (event) => {
  console.log('Asset Migration Processor triggered', {
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
      message: 'Batch processing complete',
      succeeded,
      failed,
    }),
  };
};
