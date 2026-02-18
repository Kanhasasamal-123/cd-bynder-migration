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
  existingBynderId?: string;
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

    // Ensure metadata object exists
    if (!asset.metadata) {
      asset.metadata = {};
    }

    // Resolve style_number, color_code, angle_code for matching (metadata or from filename)
    const filenameMeta = this.bynderClient.extractMetadataFromFilename(asset.originalFilename);
    const styleNumber = asset.metadata?.style_number || filenameMeta.styleNumber;
    const colorCode = asset.metadata?.color_code || filenameMeta.colorCode;
    const angleCode = asset.metadata?.angle_code || filenameMeta.angleCode;

    // When no existingBynderId, check if an asset in Bynder matches Style_Number_RLM_Code and angle code
    // If so, we will add this file as an additional file to that existing asset (finalize additional file API)
    let targetBynderId: string | undefined = asset.existingBynderId;
    let addAsAdditionalFile = false;
    if (!targetBynderId && styleNumber && colorCode && angleCode) {
      const matchingMediaId = await this.bynderClient.findMedia(styleNumber, colorCode, angleCode, onProgress);
      if (matchingMediaId) {
        targetBynderId = matchingMediaId;
        addAsAdditionalFile = true;
        onProgress?.({
          stage: 'match',
          message: `Found existing Bynder asset ${matchingMediaId} (Style_Number_RLM_Code + angle); will add as additional file`,
          details: { styleNumber, colorCode, angleCode, bynderId: matchingMediaId },
        });
      }
    }

    if (asset.existingBynderId) {
      onProgress?.({
        stage: 'update',
        message: `Creating new version for Bynder asset ${asset.existingBynderId}`,
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

    // Step 3: Upload to Bynder (new asset, new version, or additional file on matching asset)
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
        mediaId: targetBynderId,
        addAsAdditionalFile,
      }
    );

    const mode = asset.existingBynderId ? 'update' : addAsAdditionalFile ? 'additional_file' : 'create';
    onProgress?.({
      stage: 'complete',
      message: asset.existingBynderId
        ? `Bynder asset ${asset.existingBynderId} updated with new version`
        : addAsAdditionalFile
          ? `Bynder asset ${bynderId} updated with additional file`
          : `Migration completed successfully`,
      details: {
        creativeDriveAssetId: asset.creativeDriveAssetId,
        bynderId,
        mode,
      },
    });

    return {
      creativeDriveAssetId: asset.creativeDriveAssetId,
      bynderId,
      filename: asset.originalFilename,
    };
  }
}
