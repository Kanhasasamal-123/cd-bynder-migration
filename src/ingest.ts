import { Handler } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CreativeDriveClient, AssetMetadata, SearchAssetsResult } from './lib/creativedrive-client';
import { calculateDateRange } from './lib/utils/dateUtils';
import { updateCreativeDriveAssetRecord, batchCheckAssetStatus } from './lib/dynamodb-client';

const secretsClient = new SecretsManagerClient({});

// Read env vars at runtime (not at module load) for testability
const getTableName = () => process.env.MIGRATION_TRACKER_TABLE || '';
const getSecretName = () => process.env.CREATIVE_DRIVE_SECRET_NAME || '';

// Configuration for parallel fetching
const SEARCH_PAGE_SIZE = 1000; // Assets per searchAssets call
const MAX_PARALLEL_SEARCHES = 20; // Max concurrent searchAssets requests
const METADATA_BATCH_SIZE = 20; // Parallel metadata fetches
const WRITE_BATCH_SIZE = 100; // Parallel DynamoDB writes

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
  fetchOffset?: number;
  divisionId: string;
  folderId?: string;
  assetId?: string;
  mode?: 'full' | 'delta';
  syncLastDays?: number;
  dateFrom?: string;
  dateTo?: string;
  dryRun?: boolean;
}

interface IngestionFailure {
  assetId?: string;
  divisionId?: string;
  filename?: string;
  error: string;
  stage: 'fetch_metadata' | 'write_dynamodb' | 'fetch_assets' | 'other';
}

interface FetchedAsset {
  id: string;
  original_filename: string;
  original_filesize: number;
  extension: string;
  folder_id: string;
  division_id: string;
  publicUrl: string;
}

interface FetchAllAssetsParams {
  client: CreativeDriveClient;
  divisionId: number;
  folderId: string;
  dateRange: { start: string; end: string };
  assetId?: string;
  fetchOffset?: number;
  maxAssets?: number;
}

interface FetchAllAssetsResult {
  assets: FetchedAsset[];
  failures: IngestionFailure[];
  totalAvailable: number;
}

/**
 * Fetch assets from CreativeDrive in parallel batches.
 * Uses fetchOffset and maxAssets to limit the fetch range and avoid fetching too many assets.
 */
async function fetchAllAssets(params: FetchAllAssetsParams): Promise<FetchAllAssetsResult> {
  const { client, divisionId, folderId, dateRange, assetId, fetchOffset = 0, maxAssets = Infinity } = params;
  const failures: IngestionFailure[] = [];

  // For specific asset ID, just do a single search
  if (assetId) {
    try {
      const { assets } = await client.searchAssets({
        divisions: [divisionId],
        folderId,
        dateRange,
        query: assetId,
        options: { limit: 10, offset: 0 },
      });
      
      const fetchedAssets: FetchedAsset[] = assets.map(a => ({
        id: a.attributes.id,
        original_filename: a.attributes.original_filename,
        original_filesize: a.attributes.original_filesize,
        extension: a.attributes.extension,
        folder_id: a.attributes.folder_id || '',
        division_id: a.attributes.division_id || String(divisionId),
        publicUrl: a.attributes.meta?.image_origin || '',
      }));
      
      return { assets: fetchedAssets, failures, totalAvailable: assets.length };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      failures.push({ assetId, error: errorMsg, stage: 'fetch_assets' });
      return { assets: [], failures, totalAvailable: 0 };
    }
  }

  // First, get the total count with a small request
  console.log('Fetching total asset count...');
  let totalAvailable = 0;
  try {
    const { total } = await client.searchAssets({
      divisions: [divisionId],
      folderId,
      dateRange,
      options: { limit: 1, offset: 0 },
    });
    totalAvailable = total;
    console.log(`Total assets available: ${totalAvailable}`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    failures.push({ divisionId: String(divisionId), error: errorMsg, stage: 'fetch_assets' });
    return { assets: [], failures, totalAvailable: 0 };
  }

  // Calculate the range to fetch based on fetchOffset and maxAssets
  const startOffset = fetchOffset;
  const endOffset = Math.min(startOffset + maxAssets, totalAvailable);
  const assetsToFetch = endOffset - startOffset;
  
  console.log(`Will fetch ${assetsToFetch} assets (offset ${startOffset} to ${endOffset - 1}) from ${totalAvailable} total available`);

  // Calculate how many pages we need to fetch
  const numPages = Math.ceil(assetsToFetch / SEARCH_PAGE_SIZE);
  
  // Generate offsets starting from fetchOffset
  const offsets: number[] = [];
  for (let i = 0; i < numPages; i++) {
    const offset = startOffset + (i * SEARCH_PAGE_SIZE);
    if (offset >= endOffset) break;
    offsets.push(offset);
  }

  // Fetch pages in parallel batches
  const allAssets: FetchedAsset[] = [];
  let shouldStop = false;
  
  for (let batchStart = 0; batchStart < offsets.length && !shouldStop; batchStart += MAX_PARALLEL_SEARCHES) {
    const batchOffsets = offsets.slice(batchStart, batchStart + MAX_PARALLEL_SEARCHES);
    const batchNum = Math.floor(batchStart / MAX_PARALLEL_SEARCHES) + 1;
    const totalBatches = Math.ceil(offsets.length / MAX_PARALLEL_SEARCHES);
    
    console.log(`Fetching batch ${batchNum}/${totalBatches} (${batchOffsets.length} parallel requests)...`);
    
    const searchPromises = batchOffsets.map(offset => {
      // Calculate the limit for this page (might be less than SEARCH_PAGE_SIZE for the last page)
      const limit = Math.min(SEARCH_PAGE_SIZE, endOffset - offset);
      return client.searchAssets({
        divisions: [divisionId],
        folderId,
        dateRange,
        options: { limit, offset },
      }).then(result => ({ offset, result, error: null as Error | null }))
        .catch(error => ({ offset, result: null as SearchAssetsResult | null, error: error as Error }))
    });

    const results = await Promise.all(searchPromises);
    
    for (const { offset, result, error } of results) {
      if (shouldStop) break;
      
      if (error) {
        console.error(`Failed to fetch assets at offset ${offset}: ${error.message}`);
        failures.push({
          divisionId: String(divisionId),
          error: `Offset ${offset}: ${error.message}`,
          stage: 'fetch_assets',
        });
        continue;
      }
      
      if (result && result.assets) {
        for (const a of result.assets) {
          // Stop if we've reached maxAssets
          if (allAssets.length >= maxAssets) {
            shouldStop = true;
            break;
          }
          allAssets.push({
            id: a.attributes.id,
            original_filename: a.attributes.original_filename,
            original_filesize: a.attributes.original_filesize,
            extension: a.attributes.extension,
            folder_id: a.attributes.folder_id || '',
            division_id: a.attributes.division_id || String(divisionId),
            publicUrl: a.attributes.meta?.image_origin || '',
          });
        }
      }
    }
    
    console.log(`Batch ${batchNum} complete. Total assets fetched: ${allAssets.length}`);
  }

  console.log(`Fetch complete: ${allAssets.length} assets loaded into memory`);
  return { assets: allAssets, failures, totalAvailable };
}

async function getCreativeDriveCredentials(): Promise<CreativeDriveCredentials> {
  const command = new GetSecretValueCommand({ SecretId: getSecretName() });
  const response = await secretsClient.send(command);

  if (!response.SecretString) {
    throw new Error('Secret value not found');
  }

  return JSON.parse(response.SecretString) as CreativeDriveCredentials;
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
    const fetchOffset = event.fetchOffset || 0;
    const assetId = event.assetId?.trim();
    const divisionId = event.divisionId?.trim();
    const folderId = event.folderId?.trim() || '';
    const mode = event.mode || 'delta';
    const syncLastDays = event.syncLastDays;
    const dateFrom = event.dateFrom?.trim();
    const dateTo = event.dateTo?.trim();
    const isDryRun = event.dryRun === true;

    if (!divisionId) {
      throw new Error('divisionId must be provided');
    }

    const numericDivisionId = Number(divisionId);
    if (isNaN(numericDivisionId)) {
      throw new Error(`Invalid divisionId: ${divisionId}`);
    }

    // Validate date range parameters
    const hasDateRange = dateFrom || dateTo;
    const hasSyncLastDays = syncLastDays && syncLastDays > 0;

    if (hasDateRange && hasSyncLastDays) {
      throw new Error('Cannot specify both syncLastDays and dateFrom/dateTo. Use one or the other.');
    }

    if ((dateFrom && !dateTo) || (!dateFrom && dateTo)) {
      throw new Error('Both dateFrom and dateTo must be provided together.');
    }

    // Parse date from DD/MM/YY format to YYYY-MM-DD
    const parseDateDDMMYY = (dateStr: string): string => {
      const parts = dateStr.split('/');
      if (parts.length !== 3) {
        throw new Error(`Invalid date format: ${dateStr}. Expected DD/MM/YY`);
      }
      const [day, month, year] = parts;
      const fullYear = parseInt(year, 10) < 50 ? `20${year}` : `19${year}`;
      return `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    };

    let dateRange;
    if (dateFrom && dateTo) {
      const start = parseDateDDMMYY(dateFrom);
      const end = parseDateDDMMYY(dateTo);
      dateRange = { start, end };
    } else {
      const syncWindowMinutes = hasSyncLastDays ? syncLastDays * 24 * 60 : 52560000;
      dateRange = calculateDateRange(syncWindowMinutes);
    }

    console.log(`Migration mode: ${mode}${isDryRun ? ' (dry-run)' : ''}`);
    
    if (assetId) {
      console.log(`Searching for asset ID: ${assetId}`);
    } else {
      console.log(`Max assets to ingest: ${maxAssets === Infinity ? 'unlimited' : maxAssets}`);
      if (fetchOffset > 0) {
        console.log(`Starting fetch from offset: ${fetchOffset}`);
      }
    }
    
    if (dateFrom && dateTo) {
      console.log(`Date range: ${dateFrom} to ${dateTo}`, dateRange);
    } else if (hasSyncLastDays) {
      console.log(`Limiting to the last ${syncLastDays} day(s)`, dateRange);
    }

    if (folderId) {
      console.log(`Filtering by folder ID: ${folderId}`);
    }

    console.log(`Processing division ID: ${divisionId}`);

    let totalAssetsIngested = 0;
    let totalSkipped = 0;
    const failures: IngestionFailure[] = [];

    // ========================================
    // PHASE 1: Fetch all assets into memory
    // ========================================
    console.log('\n========== PHASE 1: Fetching assets ==========');
    const fetchStartTime = Date.now();
    
    const { assets: fetchedAssets, failures: fetchFailures } = await fetchAllAssets({
      client,
      divisionId: numericDivisionId,
      folderId,
      dateRange,
      assetId,
      fetchOffset,
      maxAssets,
    });
    
    failures.push(...fetchFailures);
    
    const fetchDuration = ((Date.now() - fetchStartTime) / 1000).toFixed(1);
    console.log(`Phase 1 complete: ${fetchedAssets.length} assets fetched in ${fetchDuration}s`);
    
    if (fetchedAssets.length === 0) {
      if (assetId) {
        console.warn(`Asset ID ${assetId} not found`);
      } else {
        console.warn('No assets found matching criteria');
      }
    }

    // ========================================
    // PHASE 1.5: Filter out already-migrated assets
    // ========================================
    console.log('\n========== PHASE 1.5: Checking DynamoDB for existing assets ==========');
    const filterStartTime = Date.now();
    
    let assetsToProcess: FetchedAsset[] = [];
    
    if (mode === 'full') {
      // In full mode, process all assets (will overwrite existing)
      assetsToProcess = fetchedAssets;
      console.log(`Full mode: will process all ${fetchedAssets.length} assets`);
    } else {
      // Delta mode: check which assets already exist and skip non-PENDING ones
      const assetIds = fetchedAssets.map(a => a.id);
      console.log(`Checking ${assetIds.length} assets against DynamoDB...`);
      
      const existingStatus = await batchCheckAssetStatus(getTableName(), assetIds);
      
      let alreadyMigrated = 0;
      let pendingOrNew = 0;
      
      for (const asset of fetchedAssets) {
        const idStr = String(asset.id);
        const status = existingStatus.get(idStr);

        console.log(`Asset ${asset.id} status: ${status?.status ?? 'not found'}`);
        
        if (status?.exists && status.status && status.status !== 'PENDING') {
          // Already migrated (has non-PENDING status), skip
          alreadyMigrated++;
          totalSkipped++;
        } else {
          // New or PENDING, needs processing
          assetsToProcess.push(asset);
          pendingOrNew++;
        }
      }
      
      console.log(`DynamoDB check complete: ${alreadyMigrated} already migrated (skipped), ${pendingOrNew} need processing`);
    }
    
    const filterDuration = ((Date.now() - filterStartTime) / 1000).toFixed(1);
    console.log(`Phase 1.5 complete: ${assetsToProcess.length} assets to process in ${filterDuration}s`);

    // ========================================
    // PHASE 2: Fetch metadata in parallel
    // ========================================
    console.log('\n========== PHASE 2: Fetching metadata ==========');
    const metadataStartTime = Date.now();
    
    interface AssetWithMetadata {
      asset: FetchedAsset;
      metadata: AssetMetadata[] | null;
    }
    
    const assetsWithMetadata: AssetWithMetadata[] = [];
    
    if (assetsToProcess.length === 0) {
      console.log('No assets need processing, skipping metadata fetch');
    } else {
      // Fetch metadata in parallel batches
      for (let i = 0; i < assetsToProcess.length; i += METADATA_BATCH_SIZE) {
        const batch = assetsToProcess.slice(i, i + METADATA_BATCH_SIZE);
        const batchNum = Math.floor(i / METADATA_BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(assetsToProcess.length / METADATA_BATCH_SIZE);
        
        console.log(`Fetching metadata batch ${batchNum}/${totalBatches} (${batch.length} assets)...`);
        
        const metadataPromises = batch.map(asset =>
          client.getAssetMetadata(asset.id)
            .then(metadata => ({ asset, metadata, error: null as Error | null }))
            .catch(error => ({ asset, metadata: null as AssetMetadata[] | null, error: error as Error }))
        );
        
        const results = await Promise.all(metadataPromises);
        
        for (const { asset, metadata, error } of results) {
          if (error) {
            console.error(`Failed to fetch metadata for ${asset.id}: ${error.message}`);
            failures.push({
              assetId: asset.id,
              filename: asset.original_filename,
              divisionId,
              error: error.message,
              stage: 'fetch_metadata',
            });
          } else {
            assetsWithMetadata.push({ asset, metadata });
          }
        }
      }
    }
    
    const metadataDuration = ((Date.now() - metadataStartTime) / 1000).toFixed(1);
    console.log(`Phase 2 complete: ${assetsWithMetadata.length} assets with metadata in ${metadataDuration}s`);

    // ========================================
    // PHASE 3: Write to DynamoDB in parallel
    // ========================================
    console.log('\n========== PHASE 3: Writing to DynamoDB ==========');
    const writeStartTime = Date.now();
    
    for (let i = 0; i < assetsWithMetadata.length; i += WRITE_BATCH_SIZE) {
      const batch = assetsWithMetadata.slice(i, i + WRITE_BATCH_SIZE);
      const batchNum = Math.floor(i / WRITE_BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(assetsWithMetadata.length / WRITE_BATCH_SIZE);
      
      console.log(`Writing batch ${batchNum}/${totalBatches} (${batch.length} assets)...`);
      
      const writePromises = batch.map(({ asset, metadata }) => {
        const assetRecord: Asset = {
          type: 'asset',
          attributes: {
            id: asset.id,
            original_filename: asset.original_filename,
            original_filesize: asset.original_filesize,
            extension: asset.extension,
            ts_folder_id: asset.folder_id,
            division_id: asset.division_id,
            url: '',
            path: '',
            filename: asset.original_filename,
          },
        };
        
        return updateCreativeDriveAssetRecord(getTableName(), assetRecord, metadata || undefined, {
          status: 'PENDING',
          migrationMode: mode,
          publicUrl: asset.publicUrl,
        }, isDryRun)
          .then(inserted => ({ asset, inserted, error: null as Error | null }))
          .catch(error => ({ asset, inserted: false, error: error as Error }));
      });
      
      const results = await Promise.all(writePromises);
      
      for (const { asset, inserted, error } of results) {
        if (error) {
          console.error(`Failed to write ${asset.id}: ${error.message}`);
          failures.push({
            assetId: asset.id,
            filename: asset.original_filename,
            divisionId,
            error: error.message,
            stage: 'write_dynamodb',
          });
        } else if (inserted) {
          totalAssetsIngested++;
        } else {
          totalSkipped++;
        }
      }
      
      console.log(`Batch ${batchNum} complete: ${totalAssetsIngested} ingested, ${totalSkipped} skipped`);
    }
    
    const writeDuration = ((Date.now() - writeStartTime) / 1000).toFixed(1);
    console.log(`Phase 3 complete: ${totalAssetsIngested} written, ${totalSkipped} skipped in ${writeDuration}s`)

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
        totalSkipped,
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
      totalSkipped,
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
