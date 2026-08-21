/**
 * S3 Migration Service
 *
 * Orchestrates the migration of assets from CreativeDrive to S3.
 *
 * Flow:
 *
 * CreativeDrive
 *      ↓
 * DynamoDB record provides publicUrl
 *      ↓
 * Download asset
 *      ↓
 * Buffer
 *      ↓
 * S3
 *      ↓
 * Return S3 location
 */

import { CreativeDriveClient } from './creativedrive-client';
import { AssetS3Client, S3UploadResult } from './s3-client';

export interface MigrationResult {
  creativeDriveAssetId: string;
  filename: string;

  // S3 destination information
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
  /**
   * Unique CreativeDrive asset ID.
   */
  creativeDriveAssetId: string;

  /**
   * Original filename of the asset.
   */
  originalFilename: string;

  /**
   * Public URL used to download the asset from CreativeDrive.
   *
   * This value comes from the DynamoDB migration record.
   */
  publicUrl: string;

  /**
   * CreativeDrive metadata.
   *
   * Retained for future use if metadata needs to be
   * stored along with the S3 object.
   */
  metadata?: Record<string, string>;
}

export interface MigrationOptions {
  onProgress?: (progress: MigrationProgress) => void;
}

export class S3MigrationService {
  private readonly creativeDriveClient: CreativeDriveClient;
  private readonly s3Client: AssetS3Client;

  constructor(
    creativeDriveClient: CreativeDriveClient,
    s3Client: AssetS3Client
  ) {
    this.creativeDriveClient = creativeDriveClient;
    this.s3Client = s3Client;
  }

  /**
   * Migrate one asset from CreativeDrive to S3.
   *
   * Current migration flow:
   *
   * DynamoDB
   *     ↓
   * CreativeDrive asset information
   *     ↓
   * CreativeDrive publicUrl
   *     ↓
   * Download asset
   *     ↓
   * Buffer
   *     ↓
   * S3
   */
  async migrateAsset(
    asset: MigrationAsset,
    options: MigrationOptions = {}
  ): Promise<MigrationResult> {
    const { onProgress } = options;

    console.log('Starting S3 asset migration:', {
      creativeDriveAssetId: asset.creativeDriveAssetId,
      filename: asset.originalFilename,
    });

    /*
     * Validate required asset information.
     */
    if (!asset.creativeDriveAssetId) {
      throw new Error('CreativeDrive asset ID is required');
    }

    if (!asset.originalFilename) {
      throw new Error(
        `Original filename is missing for asset: ${asset.creativeDriveAssetId}`
      );
    }

    if (!asset.publicUrl) {
      throw new Error(
        `CreativeDrive public URL is missing for asset: ${asset.creativeDriveAssetId}`
      );
    }

    /*
     * Step 1:
     * Download the asset from CreativeDrive.
     *
     * The publicUrl comes from DynamoDB.
     *
     * Example:
     *
     * DynamoDB
     *    ↓
     * publicUrl
     *    ↓
     * CreativeDrive
     *    ↓
     * Buffer
     */
    onProgress?.({
      stage: 'download',
      message: 'Downloading asset from CreativeDrive',
      details: {
        creativeDriveAssetId: asset.creativeDriveAssetId,
        filename: asset.originalFilename,
      },
    });

    const buffer = await this.creativeDriveClient.downloadAsset(
      asset.publicUrl
    );

    console.log('Asset downloaded successfully:', {
      creativeDriveAssetId: asset.creativeDriveAssetId,
      filename: asset.originalFilename,
      size: buffer.length,
    });

    /*
     * Step 2:
     * Validate the downloaded file.
     */
    if (buffer.length === 0) {
      throw new Error(
        `Downloaded asset is empty: ${asset.creativeDriveAssetId}`
      );
    }

    /*
     * Step 3:
     * Upload the downloaded file to S3.
     *
     * S3 key structure:
     *
     * {creativeDriveAssetId}/{originalFilename}
     *
     * Example:
     *
     * 5138227/MKJ8710-0710_8.tif
     */
    onProgress?.({
      stage: 'upload',
      message: 'Uploading asset to S3',
      details: {
        creativeDriveAssetId: asset.creativeDriveAssetId,
        filename: asset.originalFilename,
        size: buffer.length,
      },
    });

    const s3Result: S3UploadResult =
      await this.s3Client.uploadFile(
        buffer,
        asset.originalFilename,
        asset.creativeDriveAssetId
      );

    /*
     * Step 4:
     * Migration completed successfully.
     */
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

    /*
     * Step 5:
     * Return the S3 destination information.
     *
     * The processor uses this information to update
     * the DynamoDB migration tracker.
     */
    return {
      creativeDriveAssetId: asset.creativeDriveAssetId,
      filename: asset.originalFilename,
      s3Bucket: s3Result.bucket,
      s3Key: s3Result.key,
      s3Uri: s3Result.s3Uri,
    };
  }
}