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
  aborted?: boolean;
  abortReason?: string;
  /** True when migration was skipped because the asset was already attached in Bynder. */
  skipped?: boolean;
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
  /**
   * When true, the asset must be attached to an existing Bynder asset.
   * If no matching asset is found, migration is aborted rather than creating
   * a standalone new asset. Used for white-background assets (non-div-76)
   * that should only exist as additional files on a grey-background asset.
   */
  requiresExistingAsset?: boolean;
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

    // Always derive style/color/angle from filename (CD metadata can be wrong)
    const filenameMeta = this.bynderClient.extractMetadataFromFilename(asset.originalFilename);
    const { styleNumber, colorCode, angleCode } = filenameMeta;

    // When no existingBynderId, check if an asset in Bynder matches the current asset.
    // If so, we will add this file as an additional file to that existing asset (finalize additional file API)
    let targetBynderId: string | undefined = asset.existingBynderId;
    let addAsAdditionalFile = false;
    const shouldMatchByOriginalFilename = Boolean(asset.requiresExistingAsset);
    const hasEnoughMatchData = shouldMatchByOriginalFilename
      ? Boolean(styleNumber && asset.originalFilename)
      : Boolean(styleNumber && colorCode && angleCode);
    if (!targetBynderId && hasEnoughMatchData) {
      const matchingMediaId = shouldMatchByOriginalFilename
        ? await this.bynderClient.findMedia(styleNumber, colorCode, angleCode, onProgress, {
            originalFilename: asset.originalFilename,
          })
        : await this.bynderClient.findMedia(styleNumber, colorCode, angleCode, onProgress);
      if (matchingMediaId) {
        targetBynderId = matchingMediaId;
        addAsAdditionalFile = true;
        onProgress?.({
          stage: 'match',
          message: shouldMatchByOriginalFilename
            ? `Found existing Bynder asset ${matchingMediaId} (Style_Number + original filename); will add as additional file`
            : `Found existing Bynder asset ${matchingMediaId} (Style_Number_RLM_Code + angle); will add as additional file`,
          details: { styleNumber, colorCode, angleCode, originalFilename: asset.originalFilename, bynderId: matchingMediaId },
        });
      }
    }

    // Each Bynder asset should have at most one additional file. Skip re-upload when the
    // target already has one (avoids duplicate additional files after clear-bynderId re-runs).
    if (targetBynderId && (addAsAdditionalFile || asset.requiresExistingAsset)) {
      const additionalFileCount = await this.bynderClient.getAdditionalFileCount(targetBynderId);
      if (additionalFileCount >= 1) {
        onProgress?.({
          stage: 'skip',
          message: `Bynder asset ${targetBynderId} already has ${additionalFileCount} additional file(s); skipping upload`,
          details: {
            creativeDriveAssetId: asset.creativeDriveAssetId,
            filename: asset.originalFilename,
            bynderId: targetBynderId,
            additionalFileCount,
          },
        });
        return {
          creativeDriveAssetId: asset.creativeDriveAssetId,
          bynderId: targetBynderId,
          filename: asset.originalFilename,
          skipped: true,
        };
      }
      if (asset.requiresExistingAsset) {
        addAsAdditionalFile = true;
      }
    }

    // If this asset requires an existing Bynder asset (e.g. white BG that must attach
    // to a grey BG) and none was found, abort rather than creating a standalone asset.
    if (asset.requiresExistingAsset && !targetBynderId) {
      const abortReason = 'No matching grey-background asset found in Bynder; white-background asset cannot be uploaded as a standalone new asset';
      onProgress?.({
        stage: 'abort',
        message: abortReason,
        details: { creativeDriveAssetId: asset.creativeDriveAssetId, filename: asset.originalFilename },
      });
      return {
        creativeDriveAssetId: asset.creativeDriveAssetId,
        bynderId: '',
        filename: asset.originalFilename,
        aborted: true,
        abortReason,
      };
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

    // Additional files: pass no metadata so Bynder attributes are never updated (file attach only).
    // BynderClient.uploadFile enforces empty assetMetadata when addAsAdditionalFile is true.
    const uploadMetadata: Record<string, string> = addAsAdditionalFile
      ? {}
      : {
          ...asset.metadata,
          style_number: styleNumber,
          color_code: colorCode,
          angle_code: angleCode,
        };

    // Step 3: Upload to Bynder (new asset, new version, or additional file on matching asset)
    const bynderId = await this.bynderClient.uploadFile(
      buffer,
      asset.originalFilename,
      uploadMetadata,
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
