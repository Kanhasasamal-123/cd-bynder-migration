import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { AssetMetadata } from './creativedrive-client';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

export interface DynamoAssetRecord {
  creativeDriveAssetId: string;
  status?: string;
  originalFilename: string;
  filesize: number;
  extension: string;
  folderId: string;
  divisionId: string;
  sourceUrl: string;
  publicUrl: string;
  metadata?: Record<string, string>;
  migrationMode?: 'full' | 'delta' | 'update';
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Write asset record to DynamoDB using UpdateCommand.
 * This preserves existing fields (like bynderId) that aren't being updated.
 */
export async function updateAssetRecord(
  tableName: string,
  record: DynamoAssetRecord
): Promise<void> {
  const now = new Date().toISOString();

  const command = new UpdateCommand({
    TableName: tableName,
    Key: {
      creativeDriveAssetId: record.creativeDriveAssetId
    },
    UpdateExpression: `SET #status = :status, originalFilename = :originalFilename, 
      filesize = :filesize, extension = :extension, folderId = :folderId, 
      divisionId = :divisionId, sourceUrl = :sourceUrl, publicUrl = :publicUrl, 
      metadata = :metadata, migrationMode = :migrationMode, 
      updatedAt = :updatedAt, createdAt = if_not_exists(createdAt, :createdAt)`,
    ExpressionAttributeNames: {
      '#status': 'status'
    },
    ExpressionAttributeValues: {
      ':status': record.status ?? 'PENDING',
      ':originalFilename': record.originalFilename,
      ':filesize': record.filesize,
      ':extension': record.extension,
      ':folderId': record.folderId,
      ':divisionId': record.divisionId,
      ':sourceUrl': record.sourceUrl,
      ':publicUrl': record.publicUrl,
      ':metadata': record.metadata ?? {},
      ':migrationMode': record.migrationMode ?? 'delta',
      ':createdAt': record.createdAt ?? now,
      ':updatedAt': now
    }
  });

  await docClient.send(command);
}

export interface ExistingAssetStatus {
  assetId: string;
  exists: boolean;
  status?: string;
}

/**
 * Batch check which assets already exist in DynamoDB and their status.
 * DynamoDB BatchGetItem supports up to 100 items per call.
 */
export async function batchCheckAssetStatus(
  tableName: string,
  assetIds: string[]
): Promise<Map<string, ExistingAssetStatus>> {
  const results = new Map<string, ExistingAssetStatus>();
  
  if (assetIds.length === 0) {
    return results;
  }

  // DynamoDB BatchGetItem limit is 100 items
  const BATCH_SIZE = 100;
  
  for (let i = 0; i < assetIds.length; i += BATCH_SIZE) {
    const batchIds = assetIds.slice(i, i + BATCH_SIZE);
    
    const keys = batchIds.map(id => ({ creativeDriveAssetId: String(id) }));
    
    try {
      const response = await docClient.send(new BatchGetCommand({
        RequestItems: {
          [tableName]: {
            Keys: keys,
            ProjectionExpression: 'creativeDriveAssetId, #status',
            ExpressionAttributeNames: { '#status': 'status' },
          },
        },
      }));

      // Process found items
      const items = response.Responses?.[tableName] || [];
      for (const item of items) {
        const assetId = item.creativeDriveAssetId as string;
        results.set(assetId, {
          assetId,
          exists: true,
          status: item.status as string | undefined,
        });
      }

      // Mark missing items as not existing
      for (const id of batchIds) {
        if (!results.has(id)) {
          results.set(id, { assetId: id, exists: false });
        }
      }
    } catch (error) {
      // On error, assume items don't exist (will be checked individually during write)
      console.error(`BatchGetCommand failed for batch starting at ${i}: ${error}`);
      for (const id of batchIds) {
        if (!results.has(id)) {
          results.set(id, { assetId: id, exists: false });
        }
      }
    }
  }

  return results;
}

/**
 * Convert CreativeDrive metadata array into an object for easier storage.
 */
export function metadataArrayToMap(
  metadata?: AssetMetadata[]
): Record<string, string> {
  const map: Record<string, string> = {};
  metadata?.forEach((meta) => {
    map[meta.attributes.name] = meta.attributes.value;
  });
  return map;
}

interface SourceUrlParams {
  url?: string;
  path?: string;
  filename?: string;
  fallback?: string;
  metadata?: Record<string, string>;
}

/**
 * Build the source URL using CreativeDrive metadata or fall back value.
 */
export function buildSourceUrl({
  url,
  path,
  filename,
  fallback,
  metadata = {}
}: SourceUrlParams): string {
  const resolvedUrl = url ?? metadata.url ?? '';
  const resolvedPath = path ?? metadata.path ?? '';
  const resolvedFilename = filename ?? metadata.filename ?? '';

  if (resolvedUrl && resolvedPath && resolvedFilename) {
    return `${resolvedUrl}${resolvedPath}/${resolvedFilename}`;
  }

  return fallback ?? '';
}

interface CreativeDriveAssetLike {
  attributes: {
    id: string;
    original_filename: string;
    original_filesize: number;
    extension: string;
    division_id?: string;
    folder_id?: string;
    ts_folder_id?: string;
    url?: string;
    path?: string;
    filename?: string;
    meta?: {
      image_origin?: string;
    };
  };
}

interface UpdateCreativeDriveAssetOptions {
  status?: string;
  migrationMode?: 'full' | 'delta' | 'update';
  publicUrl?: string;
}

export async function updateCreativeDriveAssetRecord(
  tableName: string,
  asset: CreativeDriveAssetLike,
  metadata?: AssetMetadata[],
  options: UpdateCreativeDriveAssetOptions = {},
  isDryRun: boolean = false
): Promise<boolean> {
  const metadataMap = metadataArrayToMap(metadata);
  const folderId =
    asset.attributes.folder_id ??
    asset.attributes.ts_folder_id ??
    '';
  const divisionId = asset.attributes.division_id ?? '';

  const sourceUrl = buildSourceUrl({
    url: asset.attributes.url,
    path: asset.attributes.path,
    filename: asset.attributes.filename ?? asset.attributes.original_filename,
    metadata: metadataMap,
    fallback: options.publicUrl ?? asset.attributes.meta?.image_origin ?? ''
  });

  if (!isDryRun) {
    await updateAssetRecord(tableName, {
      creativeDriveAssetId: String(asset.attributes.id),
      status: options.status ?? 'PENDING',
      originalFilename: asset.attributes.original_filename,
      filesize: asset.attributes.original_filesize,
      extension: asset.attributes.extension,
      folderId: String(folderId),
      divisionId: String(divisionId),
      sourceUrl,
      publicUrl: options.publicUrl ?? asset.attributes.meta?.image_origin ?? '',
      metadata: metadataMap,
      migrationMode: options.migrationMode ?? 'delta'
    });
  } else {
    console.log(`Dry run: would update asset record for ${asset.attributes.id}` 
      + `with status: ${options.status ?? 'PENDING'}`
      + `, migrationMode: ${options.migrationMode ?? 'delta'}`
      + `, publicUrl: ${options.publicUrl ?? asset.attributes.meta?.image_origin ?? ''}`
      + `, metadata: ${JSON.stringify(metadataMap)}`
      + `, sourceUrl: ${sourceUrl}`
      + `, folderId: ${String(folderId)}`
      + `, divisionId: ${String(divisionId)}`
      + `, creativeDriveAssetId: ${String(asset.attributes.id)}`
      + `, originalFilename: ${asset.attributes.original_filename}`
      + `, filesize: ${asset.attributes.original_filesize}`
      + `, extension: ${asset.attributes.extension}`
    );
  }

  return true;
}

