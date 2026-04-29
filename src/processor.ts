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
  divisionId?: string;
  bynderId?: string;
  errorMessage?: string;
  metadata: Record<string, string>;
}

/** Division 76 contains grey-background assets. All other divisions are white-background. */
const GREY_BACKGROUND_DIVISION_ID = '76';

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

    // Step 2: Download from CreativeDrive and upload directly to Bynder
    const bynderCredentials = await getBynderCredentials();
    const creativeDriveClient = new CreativeDriveClient({ apiKey: '' });
    const bynderClient = new BynderClient(bynderCredentials);
    const migrationService = new MigrationService(creativeDriveClient, bynderClient);

    // Convert DynamoDB record to MigrationAsset format
    const isGreyBackground = record.divisionId === GREY_BACKGROUND_DIVISION_ID;
    const asset: MigrationAsset = {
      creativeDriveAssetId: record.creativeDriveAssetId,
      originalFilename: record.originalFilename,
      publicUrl: record.publicUrl,
      metadata: record.metadata,
      existingBynderId: record.bynderId,
      // White-background assets (non-div-76) must attach to an existing grey-background
      // Bynder asset. If no match is found they should be aborted, not created standalone.
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
      await updateAssetStatus(creativeDriveAssetId, 'ABORTED', { errorMessage: result.abortReason });
      console.log(
        `Asset ${creativeDriveAssetId} aborted: ${result.abortReason}`
      );
      return;
    }

    await updateAssetStatus(creativeDriveAssetId, 'UPLOADED', { bynderId: result.bynderId });

    console.log(
      `Successfully processed asset ${creativeDriveAssetId} -> Bynder ID: ${result.bynderId}`
    );
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
