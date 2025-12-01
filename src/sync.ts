/**
 * Lambda handler for syncing Creative Drive assets to DynamoDB
 * Runs hourly via EventBridge trigger
 *
 * @module index
 */

import { Context } from 'aws-lambda';
import { validateConfig } from './config';
import { CreativeDriveClient, AssetMetadata } from './lib/creativedrive-client';
import { calculateDateRange } from './lib/utils/dateUtils';
import { putCreativeDriveAssetRecord } from './lib/dynamodb-client';

/**
 * Lambda response structure
 */
export interface LambdaResponse {
  statusCode: number;
  body: string;
}

/**
 * Sync statistics
 */
export interface SyncStats {
  totalAssets: number;
  newAssets: number;
  updatedAssets: number;
  duration: number;
}

/**
 * Main Lambda handler function
 *
 * @param _event - Lambda event object from EventBridge
 * @param context - Lambda context object
 * @returns Response object with sync statistics
 */
export async function handler(_event: unknown, context: Context): Promise<LambdaResponse> {
  console.log('Starting asset sync process', {
    requestId: context.awsRequestId,
    timestamp: new Date().toISOString()
  });

  const startTime = Date.now();

  try {
    // Validate environment configuration
    const config = validateConfig();
    console.log('Configuration validated', {
      division: config.division,
      tableName: config.tableName
    });

    // Initialize services
    const apiClient = new CreativeDriveClient({
      apiKey: config.apiKey,
    });

    // Calculate date range for incremental sync
    // Get assets created/updated since last sync (default: last hour)
    const dateRange = calculateDateRange(config.syncIntervalMinutes);
    console.log('Syncing assets from date range', dateRange);

    // Convert division string to number
    const divisionId = parseInt(config.division, 10);
    if (isNaN(divisionId)) {
      throw new Error(`Invalid division ID: ${config.division}`);
    }

    // Fetch and store assets with pagination
    let totalAssets = 0;
    let newAssets = 0;
    let offset = 0;
    const limit = 100; // Process 100 assets at a time
    let hasMore = true;

    while (hasMore) {
      console.log(`Fetching assets batch (offset: ${offset})`);

      // Fetch assets from API
      const response = await apiClient.searchAssets({
        divisions: [divisionId],
        folderId: '',
        dateRange,
        options: {
          limit,
          offset,
        },
      });

      const assets = response.assets || [];
      const total = response.total || 0;

      console.log(`Fetched ${assets.length} assets (${total} total available)`);

      if (assets.length === 0) {
        hasMore = false;
        break;
      }

      for (const asset of assets) {
        try {
          const assetId = String(asset.attributes.id);
          
          const metadata: AssetMetadata[] = await apiClient.getAssetMetadata(assetId);

          await putCreativeDriveAssetRecord(config.tableName, asset, metadata, {
            status: 'PENDING',
            migrationMode: 'update',
            publicUrl: asset.attributes.meta?.image_origin || ''
          });
          newAssets++;
        } catch (error) {
          console.error(`Failed to store asset ${asset.attributes.id}:`, error);
          // Continue with next asset
        }
      }

      totalAssets += assets.length;
      console.log(`Batch stored: ${assets.length} assets`);

      // Check if there are more assets to fetch
      offset += limit;
      hasMore = offset < total;
    }

    const duration = Date.now() - startTime;
    const stats: SyncStats = {
      totalAssets,
      newAssets,
      updatedAssets: 0, // Always overwriting, so we can't distinguish new vs updated
      duration
    };

    console.log('Asset sync completed successfully', stats);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Asset sync completed successfully',
        stats
      })
    };

  } catch (error) {
    const err = error as Error;
    console.error('Asset sync failed', {
      error: err.message,
      stack: err.stack
    });

    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Asset sync failed',
        error: err.message
      })
    };
  }
}
