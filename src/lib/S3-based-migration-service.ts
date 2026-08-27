/**
 * S3 Migration Service
 *
 * Orchestrates the migration of assets from CreativeDrive to S3
 */

import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { CreativeDriveClient } from './creativedrive-client';
import { AssetS3Client, S3UploadResult } from './s3-client';

/** Division 76 contains grey-background assets. All other divisions are white-background. */
const GREY_BACKGROUND_DIVISION_ID = '76';

export interface MigrationResult {
  creativeDriveAssetId: string;
  filename: string;
  s3Bucket: string;
  s3Key: string;
  s3Uri: string;
  aborted?: boolean;
  abortReason?: string;
  /** True when migration was skipped because the matched grey asset already has a companion file. */
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
  /** Retained for future use if metadata needs to be stored along with the S3 object. */
  metadata?: Record<string, string>;
  /**
   * When true, this (white-background) asset must be uploaded into the S3 folder
   * of an already-migrated grey-background asset with matching style/color/angle.
   * If no match is found, migration is aborted rather than uploaded standalone.
   */
  requiresExistingAsset?: boolean;
}

export interface MigrationOptions {
  onProgress?: (progress: MigrationProgress) => void;
}

/** Result of scanning for a matching grey-background record. */
interface MatchedGreyAsset {
  creativeDriveAssetId: string;
  /** Set once a white asset has claimed (or finished attaching to) this grey asset. */
  companionAssetId?: string;
}

export class S3MigrationService {
  private creativeDriveClient: CreativeDriveClient;
  private s3Client: AssetS3Client;
  private docClient: DynamoDBDocumentClient;
  private tableName: string;

  constructor(
    creativeDriveClient: CreativeDriveClient,
    s3Client: AssetS3Client,
    docClient: DynamoDBDocumentClient,
    tableName: string
  ) {
    this.creativeDriveClient = creativeDriveClient;
    this.s3Client = s3Client;
    this.docClient = docClient;
    this.tableName = tableName;
  }

  /**
   * Extract Style_Number, color code, and angle code from a filename.
   * Filename format: STYLE_NUMBER-COLOR_CODE_SUFFIX.ext (e.g., "49F5RMFS2B-0848_2.tif").
   *
   * Mirrors BynderClient.extractMetadataFromFilename so grey/white matching
   * uses the same style/color/angle derivation on both destinations.
   */
  private extractMetadataFromFilename(filename: string): { styleNumber: string; colorCode: string; angleCode: string } {
    const lastDashIndex = filename.lastIndexOf('-');
    const underscoreIndex = filename.indexOf('_');
    const dotIndex = filename.lastIndexOf('.');

    if (lastDashIndex === -1) {
      return { styleNumber: '', colorCode: '', angleCode: '' };
    }

    const styleNumber = filename.substring(0, lastDashIndex);

    const colorCodeEndIndex = underscoreIndex !== -1 ? underscoreIndex : dotIndex;
    const colorCode = colorCodeEndIndex !== -1
      ? filename.substring(lastDashIndex + 1, colorCodeEndIndex)
      : filename.substring(lastDashIndex + 1);

    const angleCode = underscoreIndex !== -1 && dotIndex !== -1
      ? filename.substring(underscoreIndex + 1, dotIndex)
      : '';

    return { styleNumber, colorCode, angleCode };
  }

  /**
   * Scan DynamoDB for an already-uploaded grey-background (division 76) record
   * whose filename-derived style/color/angle matches the given asset.
   *
   * FIX 1: ConsistentRead is required here. Without it, a scan can hit a
   * replica that hasn't yet caught up with a grey record's status flipping
   * to UPLOADED moments earlier, causing a real match to be missed.
   *
   * FIX 2: Scan is paginated. A single ScanCommand call caps out at ~1MB of
   * data; once the table grows past a few thousand rows, older grey records
   * silently fall outside a single page and stop being matchable.
   */
  private async findMatchingGreyAsset(
    styleNumber: string,
    colorCode: string,
    angleCode: string
  ): Promise<MatchedGreyAsset | null> {
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
      const command = new ScanCommand({
        TableName: this.tableName,
        FilterExpression: '#status = :status AND #divisionId = :divisionId',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#divisionId': 'divisionId',
        },
        ExpressionAttributeValues: {
          ':status': 'UPLOADED',
          ':divisionId': GREY_BACKGROUND_DIVISION_ID,
        },
        ConsistentRead: true,
        ExclusiveStartKey: lastEvaluatedKey,
      });

      const response = await this.docClient.send(command);
      const items = response.Items || [];

      for (const item of items) {
        const candidateFilename = item.originalFilename as string | undefined;
        if (!candidateFilename) {
          continue;
        }

        const candidateMeta = this.extractMetadataFromFilename(candidateFilename);
        const match =
          candidateMeta.styleNumber === styleNumber &&
          candidateMeta.colorCode === colorCode &&
          candidateMeta.angleCode === angleCode;

        if (match) {
          return {
            creativeDriveAssetId: item.creativeDriveAssetId as string,
            companionAssetId: item.companionAssetId as string | undefined,
          };
        }
      }

      lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey);

    return null;
  }

  /**
   * Atomically claim a grey-background asset for a companion (white-background)
   * upload, using a conditional write so only one white asset can ever win the
   * attach even if two concurrent Lambda invocations match the same grey asset
   * at the same time.
   *
   * FIX 3: replaces the old approach of counting objects already in the S3
   * folder (`countObjectsInFolder(...) >= 2`) to decide whether to skip, which
   * had a check-then-act race: two concurrent invocations could both read the
   * same "1 object so far" count and both proceed to upload a companion file.
   *
   * Returns true if this call won the claim (proceed with upload), false if
   * another asset already holds it (skip).
   */
  private async tryClaimGreyAsset(greyAssetId: string, whiteAssetId: string): Promise<boolean> {
    try {
      await this.docClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { creativeDriveAssetId: greyAssetId },
          UpdateExpression: 'SET companionAssetId = :whiteAssetId',
          ConditionExpression: 'attribute_not_exists(companionAssetId)',
          ExpressionAttributeValues: { ':whiteAssetId': whiteAssetId },
        })
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return false;
      }
      throw error;
    }
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

    // Always derive style/color/angle from filename
    const { styleNumber, colorCode, angleCode } = this.extractMetadataFromFilename(asset.originalFilename);

    // Destination folder in S3: the asset's own folder, unless it requires
    // attaching to an existing grey-background asset's folder.
    let targetFolderId = asset.creativeDriveAssetId;

    if (asset.requiresExistingAsset) {
      const matchedGrey = await this.findMatchingGreyAsset(styleNumber, colorCode, angleCode);

      if (!matchedGrey) {
        const abortReason =
          'No matching grey-background asset found in S3/DynamoDB; white-background asset cannot be uploaded as a standalone new asset';

        onProgress?.({
          stage: 'abort',
          message: abortReason,
          details: { creativeDriveAssetId: asset.creativeDriveAssetId, filename: asset.originalFilename },
        });

        return {
          creativeDriveAssetId: asset.creativeDriveAssetId,
          filename: asset.originalFilename,
          s3Bucket: '',
          s3Key: '',
          s3Uri: '',
          aborted: true,
          abortReason,
        };
      }

      const { creativeDriveAssetId: matchedGreyAssetId, companionAssetId: existingCompanionId } = matchedGrey;

      onProgress?.({
        stage: 'match',
        message: `Found existing grey-background asset ${matchedGreyAssetId}; will upload into its S3 folder`,
        details: { styleNumber, colorCode, angleCode, matchedGreyAssetId },
      });

      // Each grey-background folder should have at most one companion (additional)
      // file. If a *different* white asset already claimed this grey asset, skip.
      // If this same asset already claimed it (e.g. a retried invocation after a
      // partial earlier failure), fall through and continue the upload.
      if (existingCompanionId && existingCompanionId !== asset.creativeDriveAssetId) {
        const s3Uri = `s3://${matchedGreyAssetId}/`;

        onProgress?.({
          stage: 'skip',
          message: `Grey-background asset ${matchedGreyAssetId} already has a companion file (${existingCompanionId}); skipping upload`,
          details: {
            creativeDriveAssetId: asset.creativeDriveAssetId,
            filename: asset.originalFilename,
            matchedGreyAssetId,
            existingCompanionId,
          },
        });

        return {
          creativeDriveAssetId: asset.creativeDriveAssetId,
          filename: asset.originalFilename,
          s3Bucket: '',
          s3Key: `${matchedGreyAssetId}/`,
          s3Uri,
          skipped: true,
        };
      }

      if (!existingCompanionId) {
        const claimed = await this.tryClaimGreyAsset(matchedGreyAssetId, asset.creativeDriveAssetId);

        if (!claimed) {
          // Lost the race to another concurrent invocation that claimed this
          // grey asset between our scan and our claim attempt.
          const s3Uri = `s3://${matchedGreyAssetId}/`;

          onProgress?.({
            stage: 'skip',
            message: `Grey-background asset ${matchedGreyAssetId} was claimed by another asset concurrently; skipping upload`,
            details: {
              creativeDriveAssetId: asset.creativeDriveAssetId,
              filename: asset.originalFilename,
              matchedGreyAssetId,
            },
          });

          return {
            creativeDriveAssetId: asset.creativeDriveAssetId,
            filename: asset.originalFilename,
            s3Bucket: '',
            s3Key: `${matchedGreyAssetId}/`,
            s3Uri,
            skipped: true,
          };
        }
      }

      targetFolderId = matchedGreyAssetId;
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
        targetFolderId,
      },
    });

    // Step 2: Upload the downloaded file to S3
    // S3 key structure: {targetFolderId}/{originalFilename} — targetFolderId is either
    // this asset's own ID (standalone), or the matched grey asset's ID (attached).
    const s3Result: S3UploadResult = await this.s3Client.uploadFile(
      buffer,
      asset.originalFilename,
      targetFolderId
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