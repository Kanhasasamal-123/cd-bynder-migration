/**
 * Simplified Integration Test: CreativeDrive → Bynder
 *
 * This test validates the core integration logic between CreativeDrive and Bynder
 * without requiring AWS services (Lambda, DynamoDB, Secrets Manager).
 *
 * Prerequisites:
 * - .env.local file with credentials (see .env.local.template)
 *
 * Usage:
 *   npm run test:integration
 */

import { CreativeDriveClient, CreativeDriveCredentials } from '../../src/lib/creativedrive-client';
import { BynderClient, BynderCredentials } from '../../src/lib/bynder-client';
import { MigrationService, MigrationAsset } from '../../src/lib/migration-service';
import { calculateDateRange } from '../../src/lib/utils/dateUtils';

/**
 * Get CreativeDrive credentials from environment
 */
function getCreativeDriveCredentials(): CreativeDriveCredentials {
  const apiKey = process.env.CREATIVEDRIVE_API_KEY;

  if (!apiKey) {
    throw new Error('CREATIVEDRIVE_API_KEY environment variable is required');
  }

  return { apiKey };
}

/**
 * Get Bynder credentials from environment
 */
function getBynderCredentials(): BynderCredentials {
  const clientId = process.env.BYNDER_CLIENT_ID;
  const clientSecret = process.env.BYNDER_CLIENT_SECRET;
  const accessTokenUrl = process.env.BYNDER_ACCESS_TOKEN_URL;
  const apiBaseUrl = process.env.BYNDER_API_BASE_URL;

  if (!clientId || !clientSecret || !accessTokenUrl || !apiBaseUrl) {
    throw new Error(
      'BYNDER_CLIENT_ID, BYNDER_CLIENT_SECRET, BYNDER_ACCESS_TOKEN_URL, and BYNDER_API_BASE_URL environment variables are required'
    );
  }

  return {
    clientId,
    clientSecret,
    accessTokenUrl,
    apiBaseUrl,
  };
}

describe('CreativeDrive to Bynder Integration', () => {
  const describeIfIntegration =
    process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

  describeIfIntegration('End-to-End Migration', () => {
    let creativeDriveClient: CreativeDriveClient;
    let bynderClient: BynderClient;
    let migrationService: MigrationService;

    beforeAll(async () => {
      try {
        const creativeDriveCredentials = getCreativeDriveCredentials();
        const bynderCredentials = getBynderCredentials();

        // Initialize clients
        creativeDriveClient = new CreativeDriveClient(creativeDriveCredentials);
        bynderClient = new BynderClient(bynderCredentials);
        migrationService = new MigrationService(creativeDriveClient, bynderClient);
      } catch (error) {
        console.error('Failed to initialize clients:', error);
        throw error;
      }
    });

    it('should fetch an asset from CreativeDrive and upload to Bynder', async () => {
      const divisions = await creativeDriveClient.getDivisions();

      const divisionId = divisions[0]?.attributes.id;
      if (!divisionId) {
        throw new Error('No divisions found in CreativeDrive account');
      }

      const rootFolders = await creativeDriveClient.getRootFolders(divisionId);

      const rootFolderId = rootFolders[0]?.attributes.id;
      if (!rootFolderId) {
        throw new Error('No root folders found in CreativeDrive division');
      }

      const subfolders = await creativeDriveClient.getSubfolders(rootFolderId);

      if (subfolders.length === 0) {
        throw new Error('No subfolders found in CreativeDrive root folder');
      }

      let offset = 0;
      const limit = 50;
      let hasMore = true;

      // Use a very wide date range to get all assets (last 100 years = ~52,560,000 minutes)
      const dateRange = calculateDateRange(52560000);

      let asset;

      while (hasMore && !asset) {
        try {
          const { assets: assetsWithUrls, total } = await creativeDriveClient.searchAssets({
            divisions: [],
            folderId: '',
            dateRange,
            options: {
              limit,
              offset,
            },
          });

          asset = assetsWithUrls.find((entry) => entry.attributes.id.toString() === process.env.CD_ASSET_ID);

          offset += limit;
          hasMore = offset < total;
          
        } catch (error) {
          console.error('Error fetching assets:', error);
          break;
        }
      }

      if (!asset) {
        throw new Error(`Asset with ID ${process.env.CD_ASSET_ID} not found in CreativeDrive subfolder`);
      }

      const assetId = asset.attributes.id;
      const publicUrl = asset.attributes.meta.image_origin;

      console.log(`\n${'='.repeat(60)}`);
      console.log('Starting asset migration test');
      console.log(`${'='.repeat(60)}`);
      console.log(`Asset ID: ${assetId}`);

      const assetMetadata = await creativeDriveClient.getAssetMetadata(assetId);

      const metadata = assetMetadata.reduce(
        (acc, meta) => {
          acc[meta.attributes.name] = meta.attributes.value;
          return acc;
        },
        {} as Record<string, string>
      );

      const migrationAsset: MigrationAsset = {
        creativeDriveAssetId: assetId,
        originalFilename:
          assetMetadata.find((meta) => meta.attributes.name === 'system_original_filename')
            ?.attributes.value || 'unknown',
        publicUrl,
        metadata,
      };

      // Migrate asset using the migration service
      const result = await migrationService.migrateAsset(migrationAsset, {
        onProgress: (progress) => {
          console.log(`[${progress.stage}] ${progress.message}`);
        },
      });

      expect(result).toBeDefined();
      expect(result.creativeDriveAssetId).toBe(assetId);
      expect(result.bynderId).toBeDefined();
      expect(result.bynderId).not.toBeNull();
      expect(typeof result.bynderId).toBe('string');
      expect(result.filename).toBeDefined();

      console.log(`\n${'='.repeat(60)}`);
      console.log('✅ Migration completed successfully!');
      console.log(`${'='.repeat(60)}`);
      console.log(`   CreativeDrive Asset ID: ${result.creativeDriveAssetId}`);
      console.log(`   Bynder Asset ID: ${result.bynderId}`);
      console.log(`   Filename: ${result.filename}`);
      console.log(`${'='.repeat(60)}\n`);
    }, 120000); // 2 minute timeout
  });
});
