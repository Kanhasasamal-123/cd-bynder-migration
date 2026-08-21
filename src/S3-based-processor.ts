import { Handler, DynamoDBStreamEvent } from 'aws-lambda';
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

import { CreativeDriveClient } from './lib/creativedrive-client';
import {
  S3MigrationService,
  MigrationAsset,
} from './lib/S3-based-migration-service';
import { AssetS3Client } from './lib/s3-client';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const TABLE_NAME =
  process.env.MIGRATION_TRACKER_TABLE || '';

const S3_BUCKET_NAME =
  process.env.S3_BUCKET_NAME || '';

const AWS_REGION =
  process.env.AWS_REGION || 'ap-south-1';

interface MigrationRecord {
  creativeDriveAssetId: string;
  status: string;
  originalFilename: string;
  filesize: number;
  extension: string;
  sourceUrl: string;
  publicUrl: string;

  // Retained for compatibility with existing DynamoDB records.
  divisionId?: string;
  bynderId?: string;

  // S3 destination information.
  s3Bucket?: string;
  s3Key?: string;
  s3Uri?: string;

  errorMessage?: string;
  metadata: Record<string, string>;
}

/**
 * Get an asset record from DynamoDB.
 */
async function getAssetRecord(
  creativeDriveAssetId: string
): Promise<MigrationRecord | null> {
  const command = new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      creativeDriveAssetId,
    },
  });

  const response = await docClient.send(command);

  return (response.Item as MigrationRecord) || null;
}

/**
 * Update migration status and additional information
 * in DynamoDB.
 */
async function updateAssetStatus(
  creativeDriveAssetId: string,
  status: string,
  updates: Partial<MigrationRecord> = {}
): Promise<void> {
  const updateExpressions: string[] = [
    '#status = :status',
    '#updatedAt = :updatedAt',
  ];

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

    updateExpressions.push(
      `${attrName} = ${attrValue}`
    );

    expressionAttributeNames[attrName] = key;
    expressionAttributeValues[attrValue] = value;
  });

  const command = new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      creativeDriveAssetId,
    },
    UpdateExpression:
      `SET ${updateExpressions.join(', ')}`,
    ExpressionAttributeNames:
      expressionAttributeNames,
    ExpressionAttributeValues:
      expressionAttributeValues,
  });

  await docClient.send(command);
}

/**
 * Process one asset.
 *
 * Current migration flow:
 *
 * DynamoDB
 *     ↓
 * CreativeDrive
 *     ↓
 * Download asset
 *     ↓
 * S3
 *     ↓
 * Update DynamoDB
 */
async function processAsset(
  creativeDriveAssetId: string
): Promise<void> {
  console.log(
    `Processing asset: ${creativeDriveAssetId}`
  );

  try {
    /*
     * Step 1:
     * Get the asset record from DynamoDB.
     */
    const record = await getAssetRecord(
      creativeDriveAssetId
    );

    if (!record) {
      throw new Error(
        `Asset record not found: ${creativeDriveAssetId}`
      );
    }

    /*
     * Step 2:
     * Only process PENDING assets.
     */
    if (record.status !== 'PENDING') {
      console.log(
        `Skipping asset ${creativeDriveAssetId} ` +
        `(status: ${record.status}). ` +
        `Only PENDING records are processed.`
      );

      return;
    }

    /*
     * Step 3:
     * Validate required configuration.
     */
    if (!TABLE_NAME) {
      throw new Error(
        'MIGRATION_TRACKER_TABLE environment variable is not configured'
      );
    }

    if (!S3_BUCKET_NAME) {
      throw new Error(
        'S3_BUCKET_NAME environment variable is not configured'
      );
    }

    /*
     * Step 4:
     * Create CreativeDrive client.
     *
     * IMPORTANT:
     * Replace the empty API key with the existing
     * CreativeDrive credential/Secrets Manager logic
     * used by your project.
     */
    const creativeDriveClient =
      new CreativeDriveClient({
        apiKey: '',
      });

    /*
     * Step 5:
     * Create S3 client.
     */
    const s3Client = new AssetS3Client(
      S3_BUCKET_NAME,
      AWS_REGION
    );

    /*
     * Step 6:
     * Create the S3 migration service.
     *
     * Current destination:
     *
     * CreativeDrive → S3
     */
    const migrationService =
      new S3MigrationService(
        creativeDriveClient,
        s3Client
      );

    /*
     * Step 7:
     * Convert DynamoDB record into MigrationAsset.
     *
     * publicUrl tells the migration service
     * which CreativeDrive asset to download.
     */
    const asset: MigrationAsset = {
      creativeDriveAssetId:
        record.creativeDriveAssetId,

      originalFilename:
        record.originalFilename,

      publicUrl:
        record.publicUrl,

      metadata:
        record.metadata,
    };

    /*
     * Step 8:
     * Download the asset from CreativeDrive
     * and upload it to S3.
     */
    const result =
      await migrationService.migrateAsset(
        asset,
        {
          onProgress: (progress) => {
            console.log(
              `${progress.stage}: ${progress.message}`
            );

            if (progress.details) {
              console.log(
                JSON.stringify(progress.details)
              );
            }
          },
        }
      );

    /*
     * Step 9:
     * Migration succeeded.
     *
     * Store the S3 bucket, key and URI in DynamoDB.
     */
    await updateAssetStatus(
      creativeDriveAssetId,
      'UPLOADED',
      {
        s3Bucket: result.s3Bucket,
        s3Key: result.s3Key,
        s3Uri: result.s3Uri,
      }
    );

    console.log(
      `Successfully processed asset ` +
      `${creativeDriveAssetId} -> ${result.s3Uri}`
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : 'Unknown error';

    console.error(
      `Failed to process asset ` +
      `${creativeDriveAssetId}:`,
      errorMessage
    );

    /*
     * Update DynamoDB when processing fails.
     */
    await updateAssetStatus(
      creativeDriveAssetId,
      'FAILED',
      {
        errorMessage,
      }
    );

    throw error;
  }
}

/**
 * DynamoDB Stream handler.
 *
 * Triggered when a DynamoDB INSERT or MODIFY event occurs.
 */
export const handler: Handler<
  DynamoDBStreamEvent
> = async (event) => {
  console.log(
    'S3 Asset Migration Processor triggered',
    {
      recordCount: event.Records.length,
    }
  );

  /*
   * Process INSERT and MODIFY records.
   */
  const results =
    await Promise.allSettled(
      event.Records.map(
        async (record) => {
          if (
            record.eventName === 'INSERT' ||
            record.eventName === 'MODIFY'
          ) {
            const newImage =
              record.dynamodb?.NewImage;

            const assetId =
              newImage
                ?.creativeDriveAssetId
                ?.S;

            if (assetId) {
              await processAsset(assetId);
            }
          }
        }
      )
    );

  const succeeded =
    results.filter(
      (result) =>
        result.status === 'fulfilled'
    ).length;

  const failed =
    results.filter(
      (result) =>
        result.status === 'rejected'
    ).length;

  console.log(
    `Processing complete: ` +
    `${succeeded} succeeded, ` +
    `${failed} failed`
  );

  return {
    statusCode: 200,
    body: JSON.stringify({
      message:
        'S3 batch processing complete',
      succeeded,
      failed,
    }),
  };
};