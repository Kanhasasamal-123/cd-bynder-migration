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
  divisionId?: string;
  divisionIds?: string[];
  assetIds?: string[];
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
    const assetIdFilter = event.assetIds;
    const divisionIdsInput = event.divisionIds ?? (event.divisionId ? [event.divisionId] : []);
    const mode = event.mode || 'delta';
    const syncLastDays = event.syncLastDays;
    const isDryRun = event.dryRun === true;

    const normalizedDivisionIds = Array.from(
      new Set(
        divisionIdsInput
          .map((id) => (id ?? '').toString().trim())
          .filter((id) => id.length > 0)
      )
    );

    if (normalizedDivisionIds.length === 0) {
      throw new Error('divisionId or divisionIds must be provided');
    }

    const syncWindowMinutes =
      syncLastDays && syncLastDays > 0 ? syncLastDays * 24 * 60 : 52560000;
    const dateRange = calculateDateRange(syncWindowMinutes);

    console.log(`Migration mode: ${mode}${isDryRun ? ' (dry-run)' : ''}`);
    console.log(`Max assets to ingest: ${maxAssets === Infinity ? 'unlimited' : maxAssets}`);
    if (syncLastDays && syncLastDays > 0) {
      console.log(`Limiting to the last ${syncLastDays} day(s)`, dateRange);
    } else {
      console.log('Sync window not provided; ingesting full available history');
    }

    if (assetIdFilter) {
      console.log(`Filtering by asset IDs: ${assetIdFilter.join(', ')}`);
    }

    // Track which filtered asset IDs still need to be found
    const remainingAssetIds = assetIdFilter ? new Set(assetIdFilter) : null;

    let totalAssetsIngested = 0;
    let limitReached = false;
    const failures: IngestionFailure[] = [];
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 10;

    for (const rawDivisionId of normalizedDivisionIds) {
      if (limitReached) break;

      const numericDivisionId = Number(rawDivisionId);
      if (Number.isNaN(numericDivisionId)) {
        console.warn(`Skipping division (invalid ID: ${rawDivisionId})`);
        continue;
      }

      console.log(`Processing division ID: ${rawDivisionId}`);

      let offset = 0;
      const pageSize = 50;
      let hasMore = true;

      while (hasMore && !limitReached) {
        try {
          const { assets: assetsWithUrls = [], total } = await client.searchAssets({
            divisions: [numericDivisionId],
            folderId: '',
            dateRange,
            options: {
              limit: pageSize,
              offset,
            },
          });

          console.log(
            `Fetched ${assetsWithUrls.length} assets from division ${rawDivisionId} (offset: ${offset}, total: ${total})`
          );

          if (assetsWithUrls.length === 0) {
            hasMore = false;
            break;
          }

          for (const assetWithUrl of assetsWithUrls) {
            if (totalAssetsIngested >= maxAssets) {
              limitReached = true;
              console.log(`Reached max assets limit of ${maxAssets}`);
              break;
            }

            if (assetIdFilter && !assetIdFilter.includes(assetWithUrl.attributes.id)) {
              console.log(`Skipping asset ${assetWithUrl.attributes.id} (not in filter)`);
              continue;
            }

            try {
              if (isDryRun) {
                console.log(
                  `[DRY-RUN] Would ingest asset ${assetWithUrl.attributes.id} (${assetWithUrl.attributes.original_filename})`
                );
                totalAssetsIngested++;
                if (remainingAssetIds) {
                  remainingAssetIds.delete(assetWithUrl.attributes.id);
                  if (remainingAssetIds.size === 0) {
                    limitReached = true;
                    console.log(
                      `All ${assetIdFilter?.length} filtered asset(s) have been processed in dry-run. Stopping.`
                    );
                    break;
                  }
                }
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
                  division_id: assetWithUrl.attributes.division_id || rawDivisionId,
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
                if (remainingAssetIds) {
                  remainingAssetIds.delete(assetWithUrl.attributes.id);
                  if (remainingAssetIds.size === 0) {
                    limitReached = true;
                    console.log(
                      `All ${assetIdFilter?.length} filtered asset(s) have already been processed. Stopping.`
                    );
                    break;
                  }
                }
                continue;
              }

              totalAssetsIngested++;
              consecutiveErrors = 0;

              console.log(
                `Ingested asset: ${assetWithUrl.attributes.original_filename} (${totalAssetsIngested}/${
                  maxAssets === Infinity ? '∞' : maxAssets
                })`
              );

              if (remainingAssetIds) {
                remainingAssetIds.delete(assetWithUrl.attributes.id);
                if (remainingAssetIds.size === 0) {
                  limitReached = true;
                  console.log(
                    `All ${assetIdFilter?.length} filtered asset(s) have been ingested. Stopping.`
                  );
                  break;
                }
              }
            } catch (error) {
              const errorMsg =
                error instanceof Error ? error.message : 'Unknown error processing asset';
              console.error(
                `Failed to process asset ${assetWithUrl.attributes.id} (${assetWithUrl.attributes.original_filename}): ${errorMsg}`
              );
              failures.push({
                assetId: assetWithUrl.attributes.id,
                filename: assetWithUrl.attributes.original_filename,
                divisionId: rawDivisionId,
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

          offset += pageSize;
          hasMore = offset < total;
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : 'Unknown error fetching assets';
          console.error(`Failed to fetch assets from division ${rawDivisionId}: ${errorMsg}`);
          failures.push({
            divisionId: rawDivisionId,
            error: errorMsg,
            stage: 'fetch_assets',
          });
          break;
        }
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

    // Log warning if not all filtered asset IDs were found
    if (remainingAssetIds && remainingAssetIds.size > 0) {
      console.warn(`\n⚠️  Warning: ${remainingAssetIds.size} filtered asset ID(s) were not found:`);
      console.warn(`  ${Array.from(remainingAssetIds).join(', ')}`);
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
        unfoundAssetIds:
          remainingAssetIds && remainingAssetIds.size > 0
            ? Array.from(remainingAssetIds)
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
