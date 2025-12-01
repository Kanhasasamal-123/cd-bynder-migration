import { Handler } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CreativeDriveClient, Folder, AssetMetadata } from './lib/creativedrive-client';
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
  divName?: string;
  folderNames?: string[];
  assetIds?: string[];
  mode?: 'full' | 'delta';
}

async function getCreativeDriveCredentials(): Promise<CreativeDriveCredentials> {
  const command = new GetSecretValueCommand({ SecretId: SECRET_NAME });
  const response = await secretsClient.send(command);

  if (!response.SecretString) {
    throw new Error('Secret value not found');
  }

  return JSON.parse(response.SecretString) as CreativeDriveCredentials;
}

async function fetchAllFoldersRecursively(
  client: CreativeDriveClient,
  folderId: string,
  folderNameFilter?: string[]
): Promise<Folder[]> {
  const allFolders: Folder[] = [];
  const subfolders = await client.getSubfolders(folderId);

  for (const subfolder of subfolders) {
    // Add the subfolder if it matches the filter or if no filter is specified
    if (!folderNameFilter || folderNameFilter.includes(subfolder.attributes.name)) {
      allFolders.push(subfolder);
    }

    // Recursively fetch subfolders
    const nestedFolders = await fetchAllFoldersRecursively(
      client,
      subfolder.attributes.id,
      folderNameFilter
    );
    allFolders.push(...nestedFolders);
  }

  return allFolders;
}

async function writeAssetToDynamoDB(
  asset: Asset,
  metadata?: AssetMetadata[],
  publicUrl?: string,
  mode?: 'full' | 'delta'
): Promise<void> {
  await putCreativeDriveAssetRecord(TABLE_NAME, asset, metadata, {
    status: 'PENDING',
    migrationMode: mode || 'delta',
    publicUrl: publicUrl || ''
  });
}

interface IngestionFailure {
  assetId?: string;
  folderId?: string;
  folderName?: string;
  filename?: string;
  error: string;
  stage: 'fetch_metadata' | 'write_dynamodb' | 'fetch_assets' | 'fetch_folders' | 'other';
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
    const folderNameFilter = event.folderNames;
    const assetIdFilter = event.assetIds;
    const divNameFilter = event.divName;
    const mode = event.mode || 'delta';

    console.log(`Migration mode: ${mode}`);
    console.log(`Max assets to ingest: ${maxAssets === Infinity ? 'unlimited' : maxAssets}`);
    
    if (divNameFilter) {
      console.log(`Filtering by division name: ${divNameFilter}`);
    }
    if (folderNameFilter) {
      console.log(`Filtering by folder names: ${folderNameFilter.join(', ')}`);
    }
    if (assetIdFilter) {
      console.log(`Filtering by asset IDs: ${assetIdFilter.join(', ')}`);
    }

    // Track which filtered asset IDs still need to be found
    const remainingAssetIds = assetIdFilter ? new Set(assetIdFilter) : null;

    // Fetch all divisions
    const divisions = await client.getDivisions();
    console.log(`Found ${divisions.length} divisions`);

    let totalAssetsIngested = 0;
    let limitReached = false;
    const failures: IngestionFailure[] = [];

    for (const division of divisions) {
      if (divNameFilter && division.attributes.name !== divNameFilter) {
        console.log(`Skipping division: ${division.attributes.name} (not matching filter)`);
        continue;
      }
      if (limitReached) break;

      const divisionId = division.attributes.id;
      console.log(`Processing division: ${division.attributes.name} (ID: ${divisionId})`);

      // Fetch root folders for this division
      const rootFolders = await client.getRootFolders(divisionId);
      console.log(`Found ${rootFolders.length} root folders in division ${divisionId}`);

      // Process each root folder
      for (const rootFolder of rootFolders) {
        if (limitReached) break;

        // Check if root folder matches filter
        if (folderNameFilter && !folderNameFilter.includes(rootFolder.attributes.name)) {
          console.log(`Skipping root folder: ${rootFolder.attributes.name} (not in filter)`);
          continue;
        }

        // Build list of all folders to process (root folder + all subfolders)
        const foldersToProcess: Folder[] = [rootFolder];

        // Recursively fetch all subfolders
        console.log(`Fetching subfolders for: ${rootFolder.attributes.name}`);
        try {
          const subfolders = await fetchAllFoldersRecursively(
            client,
            rootFolder.attributes.id,
            folderNameFilter
          );
          foldersToProcess.push(...subfolders);

          console.log(
            `Processing ${foldersToProcess.length} folders (1 root + ${subfolders.length} subfolders)`
          );
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : 'Unknown error fetching subfolders';
          console.error(
            `Failed to fetch subfolders for ${rootFolder.attributes.name}: ${errorMsg}`
          );
          failures.push({
            folderId: rootFolder.attributes.id,
            folderName: rootFolder.attributes.name,
            error: errorMsg,
            stage: 'fetch_folders',
          });
          // Continue processing the root folder even if subfolders fail
          console.log('Continuing with root folder only...');
        }

        // Process assets in each folder
        for (const folder of foldersToProcess) {
          if (limitReached) break;

          const folderId = folder.attributes.id;
          console.log(`Processing folder: ${folder.attributes.name} (ID: ${folderId})`);

          // Use the search endpoint to get assets with public URLs
          let offset = 0;
          const limit = 50;
          let hasMore = true;

          // Use a very wide date range to get all assets (last 100 years = ~52,560,000 minutes)
          const dateRange = calculateDateRange(52560000);

          while (hasMore && !limitReached) {
            try {
              const { assets: assetsWithUrls, total } = await client.searchAssets({
                divisions: [],
                folderId: folderId,
                dateRange,
                options: {
                  limit,
                  offset,
                },
              });

              console.log(
                `Fetched ${assetsWithUrls.length} assets from folder ${folderId} (offset: ${offset}, total: ${total})`
              );

              for (const assetWithUrl of assetsWithUrls) {
                if (totalAssetsIngested >= maxAssets) {
                  limitReached = true;
                  console.log(`Reached max assets limit of ${maxAssets}`);
                  break;
                }

                // Apply asset ID filter
                if (assetIdFilter && !assetIdFilter.includes(assetWithUrl.attributes.id)) {
                  console.log(`Skipping asset ${assetWithUrl.attributes.id} (not in filter)`);
                  continue;
                }

                try {
                  // Fetch complete metadata for the asset
                  console.log(`Fetching metadata for asset: ${assetWithUrl.attributes.id}`);
                  const metadata = await client.getAssetMetadata(assetWithUrl.attributes.id);

                  // Convert AssetWithPublicUrl to Asset format for writeAssetToDynamoDB
                  const asset: Asset = {
                    type: 'asset',
                    attributes: {
                      id: assetWithUrl.attributes.id,
                      original_filename: assetWithUrl.attributes.original_filename,
                      original_filesize: assetWithUrl.attributes.original_filesize,
                      extension: assetWithUrl.attributes.extension,
                      ts_folder_id: assetWithUrl.attributes.folder_id || folderId,
                      division_id: assetWithUrl.attributes.division_id || divisionId,
                      url: '',
                      path: '',
                      filename: assetWithUrl.attributes.original_filename,
                    },
                  };

                  // Write to DynamoDB with metadata and public URL
                  await writeAssetToDynamoDB(
                    asset,
                    metadata,
                    assetWithUrl.attributes.meta.image_origin,
                    mode
                  );
                  totalAssetsIngested++;

                  console.log(
                    `Ingested asset: ${assetWithUrl.attributes.original_filename} (${totalAssetsIngested}/${maxAssets === Infinity ? '∞' : maxAssets})`
                  );

                  // If filtering by asset IDs, track that we've found this one
                  if (remainingAssetIds) {
                    remainingAssetIds.delete(assetWithUrl.attributes.id);
                    // If all filtered assets have been found, stop processing
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
                    folderId: folderId,
                    folderName: folder.attributes.name,
                    error: errorMsg,
                    stage: errorMsg.includes('metadata') ? 'fetch_metadata' : 'write_dynamodb',
                  });
                  // Continue with next asset
                }
              }

              offset += limit;
              hasMore = offset < total && assetsWithUrls.length > 0;
            } catch (error) {
              const errorMsg =
                error instanceof Error ? error.message : 'Unknown error fetching assets';
              console.error(`Failed to fetch assets from folder ${folderId}: ${errorMsg}`);
              failures.push({
                folderId: folderId,
                folderName: folder.attributes.name,
                error: errorMsg,
                stage: 'fetch_assets',
              });
              // Break out of the while loop for this folder and move to next folder
              break;
            }
          }
        }
      }
    }

    // Log failure summary
    if (failures.length > 0) {
      console.warn(`\n⚠️  Ingestion completed with ${failures.length} failure(s):`);
      failures.forEach((failure, index) => {
        console.warn(`  ${index + 1}. ${failure.stage}: ${failure.error}`);
        if (failure.filename) console.warn(`     File: ${failure.filename} (${failure.assetId})`);
        if (failure.folderName)
          console.warn(`     Folder: ${failure.folderName} (${failure.folderId})`);
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
        failures:
          failures.length > 0
            ? failures.map((f) => ({
                stage: f.stage,
                error: f.error,
                assetId: f.assetId,
                filename: f.filename,
                folderId: f.folderId,
                folderName: f.folderName,
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
