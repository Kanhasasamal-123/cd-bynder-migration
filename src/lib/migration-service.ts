/**
 * Migration Service
 *
 * Orchestrates the migration of assets from CreativeDrive to Bynder
 */

import { CreativeDriveClient } from './creativedrive-client';
import { BynderClient } from './bynder-client';

export interface MigrationResult {
  creativeDriveAssetId: string;
  bynderId: string;
  filename: string;
}

export interface MigrationProgress {
  stage: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface MigrationAsset {
  creativeDriveAssetId: string;
  originalFilename: string;
  publicUrl: string;
  metadata?: Record<string, string>;
}

export interface MigrationOptions {
  onProgress?: (progress: MigrationProgress) => void;
  upsertByFilename?: string;
}

export class MigrationService {
  private creativeDriveClient: CreativeDriveClient;
  private bynderClient: BynderClient;

  constructor(creativeDriveClient: CreativeDriveClient, bynderClient: BynderClient) {
    this.creativeDriveClient = creativeDriveClient;
    this.bynderClient = bynderClient;
  }

  /**
   * Migrate an asset to Bynder
   */
  async migrateAsset(asset: MigrationAsset, options: MigrationOptions = {}): Promise<MigrationResult> {
    const { onProgress, upsertByFilename } = options;
    const lookupFilename = upsertByFilename ?? asset.originalFilename;

    if (lookupFilename) {
      const existingBynderId = await this.bynderClient.findMediaByFilename(lookupFilename);
      if (existingBynderId) {
        onProgress?.({
          stage: 'update',
          message: `Updating existing Bynder asset ${existingBynderId}`,
          details: { filename: lookupFilename },
        });

        await this.bynderClient.updateMediaMetadata(existingBynderId, asset.metadata || {});

        onProgress?.({
          stage: 'complete',
          message: `Updated Bynder asset metadata`,
          details: {
            creativeDriveAssetId: asset.creativeDriveAssetId,
            bynderId: existingBynderId,
            mode: 'update',
          },
        });

        return {
          creativeDriveAssetId: asset.creativeDriveAssetId,
          bynderId: existingBynderId,
          filename: asset.originalFilename,
        };
      }
    }

    onProgress?.({
      stage: 'download',
      message: `Downloading asset from CreativeDrive`,
      details: {
        assetId: asset.creativeDriveAssetId,
        filename: asset.originalFilename,
      },
    });

    // Step 2: Download asset from CreativeDrive
    const buffer = await this.creativeDriveClient.downloadAsset(asset.publicUrl);

    onProgress?.({
      stage: 'upload',
      message: `Uploading to Bynder (${buffer.length} bytes)`,
      details: {
        filename: asset.originalFilename,
        size: buffer.length,
      },
    });

    // Step 3: Upload to Bynder
    const bynderId = await this.bynderClient.uploadFile(
      buffer,
      asset.originalFilename,
      asset.metadata || {},
      {
        onProgress: (uploadProgress) => {
          onProgress?.({
            stage: 'upload_chunk',
            message: `Uploading chunk ${uploadProgress.current}/${uploadProgress.total}`,
            details: {
              current: uploadProgress.current,
              total: uploadProgress.total,
            },
          });
        },
      }
    );

    onProgress?.({
      stage: 'complete',
      message: `Migration completed successfully`,
      details: {
        creativeDriveAssetId: asset.creativeDriveAssetId,
        bynderId,
      },
    });

    return {
      creativeDriveAssetId: asset.creativeDriveAssetId,
      bynderId,
      filename: asset.originalFilename,
    };
  }
}
