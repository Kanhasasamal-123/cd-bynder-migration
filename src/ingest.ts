import { Handler } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CreativeDriveClient, AssetMetadata } from './lib/creativedrive-client';
import { calculateDateRange } from './lib/utils/dateUtils';
import { putCreativeDriveAssetRecord } from './lib/dynamodb-client';

const secretsClient = new SecretsManagerClient({});

const TABLE_NAME = process.env.MIGRATION_TRACKER_TABLE || '';
const SECRET_NAME = process.env.CREATIVE_DRIVE_SECRET_NAME || '';

interface CreativeDriveCredentials {
  apiKey: string;
}

interface Asset {
  type: string;
  attributes: {
    id: string;
    original_filename: string;
    original_filesize: number;
    extension: string;
    ts_folder_id: string;
    division_id: string;
    url: string;
    path: string;
    filename: string;
  };
}

interface IngestEvent {
  maxAssets?: number;
  divisionId: string;
  folderId?: string;
  assetId?: string;
  mode?: 'full' | 'delta';
  syncLastDays?: number;
  dryRun?: boolean;
}

async function getCreativeDriveCredentials(): Promise<CreativeDriveCredentials> {
  const command = new GetSecretValueCommand({ SecretId: SECRET_NAME });
  const response = await secretsClient.send(command);

  if (!response.SecretString) {
    throw new Error('Secret value not found');
  }

  return JSON.parse(response.SecretString) as CreativeDriveCredentials;
}

async function writeAssetToDynamoDB(
  asset: Asset,
  metadata?: AssetMetadata[],
  publicUrl?: string,
  mode?: 'full' | 'delta'
): Promise<boolean> {
  return putCreativeDriveAssetRecord(TABLE_NAME, asset, metadata, {
    status: 'PENDING',
    migrationMode: mode || 'delta',
    publicUrl: publicUrl || ''
  });
}

interface IngestionFailure {
  assetId?: string;
  divisionId?: string;
  filename?: string;
  error: string;
  stage: 'fetch_metadata' | 'write_dynamodb' | 'fetch_assets' | 'other';
}

export const handler: Handler = async (event: IngestEvent) => {
  console.log('Starting CreativeDrive ingestion process', { event });

  try {
    const credentials = await getCreativeDriveCredentials();
    const client = new CreativeDriveClient({
      apiKey: credentials.apiKey,
    });

    // Get configuration from event
    const maxAssets = event.maxAssets || Infinity;
    const assetId = event.assetId?.trim();
    const divisionId = event.divisionId?.trim();
    const folderId = event.folderId?.trim() || '';
    const mode = event.mode || 'delta';
    const syncLastDays = event.syncLastDays;
    const isDryRun = event.dryRun === true;

    if (!divisionId) {
      throw new Error('divisionId must be provided');
    }

    const numericDivisionId = Number(divisionId);
    if (isNaN(numericDivisionId)) {
      throw new Error(`Invalid divisionId: ${divisionId}`);
    }

    const syncWindowMinutes =
      syncLastDays && syncLastDays > 0 ? syncLastDays * 24 * 60 : 52560000;
    const dateRange = calculateDateRange(syncWindowMinutes);

    console.log(`Migration mode: ${mode}${isDryRun ? ' (dry-run)' : ''}`);
    
    if (assetId) {
      console.log(`Searching for asset ID: ${assetId}`);
    } else {
      console.log(`Max assets to ingest: ${maxAssets === Infinity ? 'unlimited' : maxAssets}`);
    }
    
    if (syncLastDays && syncLastDays > 0) {
      console.log(`Limiting to the last ${syncLastDays} day(s)`, dateRange);
    }

    if (folderId) {
      console.log(`Filtering by folder ID: ${folderId}`);
    }

    console.log(`Processing division ID: ${divisionId}`);

    let totalAssetsIngested = 0;
    const failures: IngestionFailure[] = [];
    let limitReached = false;
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 10;

    // When searching for a specific assetId, we don't paginate - just one request
    const pageSize = assetId ? 10 : 50;
    let offset = 0;
    let hasMore = true;

    while (hasMore && !limitReached) {
      try {
        const { assets: assetsWithUrls = [], total } = await client.searchAssets({
          divisions: [numericDivisionId],
          folderId,
          dateRange,
          query: assetId,
          options: {
            limit: pageSize,
            offset,
          },
        });

        if (!assetId) {
          console.log(
            `Fetched ${assetsWithUrls.length} assets (offset: ${offset}, total: ${total})`
          );
        }

        if (assetsWithUrls.length === 0) {
          if (assetId) {
            console.warn(`Asset ID ${assetId} not found in search results`);
          }
          hasMore = false;
          continue;
        }

        for (const assetWithUrl of assetsWithUrls) {
          // For specific assetId search, ignore maxAssets limit
          if (!assetId && totalAssetsIngested >= maxAssets) {
            limitReached = true;
            console.log(`Reached max assets limit of ${maxAssets}`);
            break;
          }

          try {
            if (isDryRun) {
              console.log(
                `[DRY-RUN] Would ingest asset ${assetWithUrl.attributes.id} (${assetWithUrl.attributes.original_filename})`
              );
              totalAssetsIngested++;
              continue;
            }

            console.log(`Fetching metadata for asset: ${assetWithUrl.attributes.id}`);
            const metadata = await client.getAssetMetadata(assetWithUrl.attributes.id);

            const asset: Asset = {
              type: 'asset',
              attributes: {
                id: assetWithUrl.attributes.id,
                original_filename: assetWithUrl.attributes.original_filename,
                original_filesize: assetWithUrl.attributes.original_filesize,
                extension: assetWithUrl.attributes.extension,
                ts_folder_id: assetWithUrl.attributes.folder_id || '',
                division_id: assetWithUrl.attributes.division_id || divisionId,
                url: '',
                path: '',
                filename: assetWithUrl.attributes.original_filename,
              },
            };

            const recordInserted = await writeAssetToDynamoDB(
              asset,
              metadata,
              assetWithUrl.attributes.meta?.image_origin,
              mode
            );

            if (!recordInserted) {
              continue;
            }

            totalAssetsIngested++;
            consecutiveErrors = 0;

            const progress = assetId 
              ? '' 
              : ` (${totalAssetsIngested}/${maxAssets === Infinity ? '∞' : maxAssets})`;
            console.log(`Ingested asset: ${assetWithUrl.attributes.original_filename}${progress}`);
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : 'Unknown error processing asset';
            console.error(
              `Failed to process asset ${assetWithUrl.attributes.id} (${assetWithUrl.attributes.original_filename}): ${errorMsg}`
            );
            failures.push({
              assetId: assetWithUrl.attributes.id,
              filename: assetWithUrl.attributes.original_filename,
              divisionId,
              error: errorMsg,
              stage: errorMsg.includes('metadata') ? 'fetch_metadata' : 'write_dynamodb',
            });

            consecutiveErrors++;
            if (consecutiveErrors >= maxConsecutiveErrors) {
              console.error(
                `Reached ${maxConsecutiveErrors} consecutive errors while processing assets. Halting ingestion.`
              );
              limitReached = true;
              break;
            }
          }
        }

        // For specific assetId, we're done after first batch (no pagination needed)
        if (assetId) {
          hasMore = false;
        } else {
          offset += pageSize;
          hasMore = offset < total;
        }
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : 'Unknown error fetching assets';
        const context = assetId ? `asset ${assetId}` : `division ${divisionId}`;
        console.error(`Failed to fetch assets from ${context}: ${errorMsg}`);
        failures.push({
          assetId: assetId || undefined,
          divisionId,
          error: errorMsg,
          stage: 'fetch_assets',
        });
        hasMore = false;
      }
    }

    // Log failure summary
    if (failures.length > 0) {
      console.warn(`\n⚠️  Ingestion completed with ${failures.length} failure(s):`);
      failures.forEach((failure, index) => {
        console.warn(`  ${index + 1}. ${failure.stage}: ${failure.error}`);
        if (failure.filename) {
          console.warn(`     File: ${failure.filename} (${failure.assetId})`);
        }
        if (failure.divisionId) {
          console.warn(`     Division: ${failure.divisionId}`);
        }
      });
    }

    const result = {
      statusCode: 200,
      body: JSON.stringify({
        message:
          failures.length === 0
            ? 'Ingestion completed successfully'
            : `Ingestion completed with ${failures.length} failure(s)`,
        totalAssetsIngested,
        totalFailures: failures.length,
        dryRun: isDryRun,
        failures:
          failures.length > 0
            ? failures.map((f) => ({
                stage: f.stage,
                error: f.error,
                assetId: f.assetId,
                filename: f.filename,
                divisionId: f.divisionId,
              }))
            : undefined,
      }),
    };

    console.log('Ingestion completed', {
      totalAssetsIngested,
      totalFailures: failures.length,
    });
    return result;
  } catch (error) {
    console.error('Critical error during ingestion:', error);

    // Only throw for critical errors (credentials, connectivity, etc.)
    // Individual asset/folder failures are tracked in the failures array
    const errorMessage =
      error instanceof Error
        ? `Critical ingestion failure: ${error.message}`
        : 'Critical ingestion failure: Unknown error';

    throw new Error(errorMessage);
  }
};
