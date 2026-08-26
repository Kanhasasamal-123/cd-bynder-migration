/**
 * S3 Client
 *
 * Handles uploading migrated assets to the target Amazon S3 bucket.
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export interface S3UploadResult {
  bucket: string;
  key: string;
  s3Uri: string;
}

export class AssetS3Client {
  private s3Client: S3Client;
  private bucketName: string;

  constructor(bucketName: string, region: string) {
    if (!bucketName) {
      throw new Error('S3 bucket name is required');
    }

    if (!region) {
      throw new Error('AWS region is required');
    }

    this.bucketName = bucketName;
    this.s3Client = new S3Client({ region });
  }

  /**
   * Upload an asset to the target S3 bucket.
   */
  async uploadFile(buffer: Buffer, filename: string, creativeDriveAssetId: string): Promise<S3UploadResult> {
    if (!buffer || buffer.length === 0) {
      throw new Error(`Cannot upload empty asset: ${filename}`);
    }

    if (!creativeDriveAssetId) {
      throw new Error(`CreativeDrive asset ID is required for: ${filename}`);
    }

    // S3 object structure: bucket/creativeDriveAssetId/filename (e.g. 5138227/MKJ8710-0710_8.tif)
    const key = `${creativeDriveAssetId}/${filename}`;

    console.log('Uploading asset to S3:', {
      bucket: this.bucketName,
      key,
      filename,
      size: buffer.length,
      creativeDriveAssetId,
    });

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: buffer,
    });

    await this.s3Client.send(command);

    const s3Uri = `s3://${this.bucketName}/${key}`;

    console.log('Asset uploaded successfully to S3:', {
      bucket: this.bucketName,
      key,
      s3Uri,
    });

    return { bucket: this.bucketName, key, s3Uri };
  }
}