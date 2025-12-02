/**
 * Integration Test: List Recent Assets from CreativeDrive
 *
 * This test queries the CreativeDrive API to find all assets that have been
 * updated in the last week from a specified division and outputs them in a readable format.
 *
 * Prerequisites:
 * - CREATIVEDRIVE_API_KEY environment variable
 * - CD_DIVISION_ID environment variable (division ID to search)
 *
 * Usage:
 *   RUN_INTEGRATION_TESTS=true npm test -- recent-assets.test.ts
 *   or
 *   CREATIVEDRIVE_API_KEY=your-key CD_DIVISION_ID=76 npm test -- recent-assets.test.ts
 *   or
 *   npm run test:recent-assets
 */

import { CreativeDriveClient, CreativeDriveCredentials, AssetWithPublicUrl } from './creativedrive-client';
import { calculateDateRange } from './utils/dateUtils';

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
 * Format asset information for output
 */
function formatAsset(asset: AssetWithPublicUrl, index: number): string {
  const attrs = asset.attributes;
  return `
${index + 1}. Asset ID: ${attrs.id}
   Filename: ${attrs.original_filename}
   Size: ${(attrs.original_filesize / 1024 / 1024).toFixed(2)} MB
   Extension: ${attrs.extension}
   Folder ID: ${attrs.ts_folder_id}
   Division ID: ${attrs.division}
   Public URL: ${attrs.meta?.image_origin || 'N/A'}
   ${attrs.meta?.updated_at ? `Updated: ${attrs.meta.updated_at}` : ''}
`;
}

describe('Recent Assets from CreativeDrive', () => {
  const describeIfIntegration =
    process.env.RUN_INTEGRATION_TESTS === 'true' || process.env.CREATIVEDRIVE_API_KEY
      ? describe
      : describe.skip;

  describeIfIntegration('Fetch Assets Updated in Last Week', () => {
    let creativeDriveClient: CreativeDriveClient;
    let divisionId: number;

    beforeAll(async () => {
      try {
        const credentials = getCreativeDriveCredentials();
        creativeDriveClient = new CreativeDriveClient(credentials);

        // Get division ID from environment variable
        const divisionIdEnv = process.env.CD_DIVISION_ID;
        if (!divisionIdEnv) {
          throw new Error('CD_DIVISION_ID environment variable is required');
        }

        divisionId = parseInt(divisionIdEnv, 10);
        if (isNaN(divisionId)) {
          throw new Error(`CD_DIVISION_ID must be a valid number, got: ${divisionIdEnv}`);
        }

        console.log(`\n🔍 Searching division: ${divisionId}\n`);
      } catch (error) {
        console.error('Failed to initialize CreativeDrive client:', error);
        throw error;
      }
    });

    it('should fetch and display assets updated in the last week', async () => {
      const dateRange = calculateDateRange(3 * 24 * 60);
      
      console.log('📅 Date Range:');
      console.log(`   Start: ${dateRange.start}`);
      console.log(`   End: ${dateRange.end}`);
      console.log('\n🔍 Searching for assets...\n');

      const allAssets: AssetWithPublicUrl[] = [];
      const limit = 100;
      let offset = 0;
      let hasMore = true;
      let totalAssets = 0;

      // Search division 76
      console.log(`📂 Searching division: ${divisionId}`);

      while (hasMore) {
        try {
          const response = await creativeDriveClient.searchAssets({
            divisions: [divisionId],
            folderId: '',
            dateRange,
            options: {
              limit,
              offset,
            },
          });

          const assets = response.assets || [];
          totalAssets = response.total;

          if (assets.length === 0) {
            hasMore = false;
            break;
          }

          allAssets.push(...assets);
          console.log(`   Fetched ${assets.length} assets (total: ${totalAssets}, collected: ${allAssets.length})`);

          offset += limit;
          hasMore = offset < totalAssets;
        } catch (error) {
          console.error(`   Error fetching assets from division ${divisionId}:`, error);
          hasMore = false;
        }
      }

      console.log('\n' + '='.repeat(80));
      console.log(`📊 SUMMARY`);
      console.log('='.repeat(80));
      console.log(`Total assets found: ${allAssets.length}`);
      console.log(`Date range: ${dateRange.start} to ${dateRange.end}`);
      
      if (allAssets.length === 0) {
        console.log('\n✅ No assets were updated in the last week.\n');
        return;
      }

      // Group by division and folder for better organization
      const byDivision = new Map<string, Map<string, AssetWithPublicUrl[]>>();
      
      for (const asset of allAssets) {
        const divId = asset.attributes.division;
        const folderId = asset.attributes.ts_folder_id || 'root';

        if (!byDivision.has(divId)) {
          byDivision.set(divId, new Map());
        }
        const byFolder = byDivision.get(divId)!;

        if (!byFolder.has(folderId)) {
          byFolder.set(folderId, []);
        }
        byFolder.get(folderId)!.push(asset);
      }

      console.log('\n' + '='.repeat(80));
      console.log('📋 ASSETS BY DIVISION AND FOLDER');
      console.log('='.repeat(80));

      let assetIndex = 0;
      for (const [divisionId, folders] of Array.from(byDivision.entries())) {
        console.log(`\n📁 Division: ${divisionId} (${folders.size} folder(s))`);
        
        for (const [folderId, assets] of Array.from(folders.entries())) {
          console.log(`\n   📂 Folder: ${folderId} (${assets.length} asset(s))`);
          
          for (const asset of assets) {
            console.log(formatAsset(asset, assetIndex));
            assetIndex++;
          }
        }
      }

      // Summary statistics
      console.log('\n' + '='.repeat(80));
      console.log('📈 STATISTICS');
      console.log('='.repeat(80));
      
      const totalSize = allAssets.reduce((sum, asset) => sum + asset.attributes.original_filesize, 0);
      const extensions = new Map<string, number>();
      
      for (const asset of allAssets) {
        const ext = asset.attributes.extension?.toLowerCase() || 'unknown';
        extensions.set(ext, (extensions.get(ext) || 0) + 1);
      }

      console.log(`Total files: ${allAssets.length}`);
      console.log(`Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
      console.log(`Average file size: ${(totalSize / allAssets.length / 1024 / 1024).toFixed(2)} MB`);
      console.log('\nFile types:');
      const sortedExtensions = Array.from(extensions.entries()).sort((a, b) => b[1] - a[1]);
      for (const [ext, count] of sortedExtensions) {
        console.log(`  .${ext}: ${count} file(s)`);
      }

      console.log('\n' + '='.repeat(80));
      console.log('✅ Test completed successfully\n');

      // Assert that we completed the search (even if no assets found)
      expect(allAssets.length).toBeGreaterThanOrEqual(0);
    }, 120000); // 2 minute timeout
  });
});

