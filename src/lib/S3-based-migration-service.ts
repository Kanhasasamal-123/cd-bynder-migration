/**
 * S3 Migration Service
 *
 * Orchestrates the migration of assets from CreativeDrive to S3
 */

import { CreativeDriveClient } from './creativedrive-client';
import { AssetS3Client, S3UploadResult } from './s3-client';

export interface MigrationResult {
  creativeDriveAssetId: string;
  filename: string;
  s3Bucket: string;
  s3Key: string;
  s3Uri: string;
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
  /** Retained for future use if metadata needs to be stored along with the S3 object. */
  metadata?: Record<string, string>;
}

export interface MigrationOptions {
  onProgress?: (progress: MigrationProgress) => void;
}

export class S3MigrationService {
  private creativeDriveClient: CreativeDriveClient;
  private s3Client: AssetS3Client;

  constructor(creativeDriveClient: CreativeDriveClient, s3Client: AssetS3Client) {
    this.creativeDriveClient = creativeDriveClient;
    this.s3Client = s3Client;
  }

  /**
   * Migrate an asset to S3
   */
  async migrateAsset(asset: MigrationAsset, options: MigrationOptions = {}): Promise<MigrationResult> {
    const { onProgress } = options;

    console.log('Starting S3 asset migration:', {
      creativeDriveAssetId: asset.creativeDriveAssetId,
      filename: asset.originalFilename,
    });

    // Validate required asset information
    if (!asset.creativeDriveAssetId) {
      throw new Error('CreativeDrive asset ID is required');
    }

    if (!asset.originalFilename) {
      throw new Error(`Original filename is missing for asset: ${asset.creativeDriveAssetId}`);
    }

    if (!asset.publicUrl) {
      throw new Error(`CreativeDrive public URL is missing for asset: ${asset.creativeDriveAssetId}`);
    }

    onProgress?.({
      stage: 'download',
      message: 'Downloading asset from CreativeDrive',
      details: {
        creativeDriveAssetId: asset.creativeDriveAssetId,
        filename: asset.originalFilename,
      },
    });

    // Step 1: Download asset from CreativeDrive
    const buffer = await this.creativeDriveClient.downloadAsset(asset.publicUrl);

    console.log('Asset downloaded successfully:', {
      creativeDriveAssetId: asset.creativeDriveAssetId,
      filename: asset.originalFilename,
      size: buffer.length,
    });

    if (buffer.length === 0) {
      throw new Error(`Downloaded asset is empty: ${asset.creativeDriveAssetId}`);
    }

    onProgress?.({
      stage: 'upload',
      message: 'Uploading asset to S3',
      details: {
        creativeDriveAssetId: asset.creativeDriveAssetId,
        filename: asset.originalFilename,
        size: buffer.length,
      },
    });

    // Step 2: Upload the downloaded file to S3
    // S3 key structure: {creativeDriveAssetId}/{originalFilename} (e.g. 5138227/MKJ8710-0710_8.tif)
    const s3Result: S3UploadResult = await this.s3Client.uploadFile(
      buffer,
      asset.originalFilename,
      asset.creativeDriveAssetId
    );

    onProgress?.({
      stage: 'complete',
      message: 'Asset uploaded successfully to S3',
      details: {
        creativeDriveAssetId: asset.creativeDriveAssetId,
        filename: asset.originalFilename,
        s3Bucket: s3Result.bucket,
        s3Key: s3Result.key,
        s3Uri: s3Result.s3Uri,
      },
    });

    console.log('S3 migration completed successfully:', {
      creativeDriveAssetId: asset.creativeDriveAssetId,
      filename: asset.originalFilename,
      s3Bucket: s3Result.bucket,
      s3Key: s3Result.key,
      s3Uri: s3Result.s3Uri,
    });

    return {
      creativeDriveAssetId: asset.creativeDriveAssetId,
      filename: asset.originalFilename,
      s3Bucket: s3Result.bucket,
      s3Key: s3Result.key,
      s3Uri: s3Result.s3Uri,
    };
  }
}