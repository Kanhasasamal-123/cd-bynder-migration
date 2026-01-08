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
    const { onProgress } = options;

    // Apply filename fallback for style_number and color_code
    const filenameMetadata = this.bynderClient.extractMetadataFromFilename(asset.originalFilename);
    
    // Ensure metadata object exists
    if (!asset.metadata) {
      asset.metadata = {};
    }

    let existingBynderId: string | null = null;

    existingBynderId = await this.bynderClient.findMedia(
      asset.metadata.style_number || filenameMetadata.styleNumber,
      asset.metadata.color_code || filenameMetadata.colorCode,
      asset.metadata.angle_code || filenameMetadata.angleCode
    );
    if (existingBynderId) {
      onProgress?.({
        stage: 'update',
        message: `Creating new version for Bynder asset ${existingBynderId}`,
        details: { style_number: asset.metadata?.style_number, 
          color_code: asset.metadata?.color_code,
          },
      });
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

    // Step 3: Upload to Bynder (new asset or new version)
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
        mediaId: existingBynderId ?? undefined,
      }
    );

    onProgress?.({
      stage: 'complete',
      message: existingBynderId
        ? `Bynder asset ${existingBynderId} updated with new version`
        : `Migration completed successfully`,
      details: {
        creativeDriveAssetId: asset.creativeDriveAssetId,
        bynderId,
        mode: existingBynderId ? 'update' : 'create',
      },
    });

    return {
      creativeDriveAssetId: asset.creativeDriveAssetId,
      bynderId,
      filename: asset.originalFilename,
    };
  }
}
