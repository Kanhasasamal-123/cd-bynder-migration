import { MigrationService, MigrationAsset } from './migration-service';

describe('MigrationService', () => {
  const baseAsset: MigrationAsset = {
    creativeDriveAssetId: 'cd-123',
    originalFilename: 'sample.jpg',
    publicUrl: 'https://example.com/sample.jpg',
    metadata: {
      style_number: 'ST123',
      color_code: 'CC123',
      angle_code: 'FRONT',
    },
  };

  function createService(overrides?: {
    uploadFile?: jest.Mock;
    downloadAsset?: jest.Mock;
  }) {
    const creativeDriveClient = {
      downloadAsset: overrides?.downloadAsset || jest.fn().mockResolvedValue(Buffer.from('file')),
    };

    const bynderClient = {
      uploadFile: overrides?.uploadFile || jest.fn().mockResolvedValue('bynder-123'),
    };

    return {
      service: new MigrationService(
        creativeDriveClient as any,
        bynderClient as any
      ),
      creativeDriveClient,
      bynderClient,
    };
  }

  it('uploads new asset when no existingBynderId is provided', async () => {
    const { service, creativeDriveClient, bynderClient } = createService();

    const progressSpy = jest.fn();
    const result = await service.migrateAsset(baseAsset, {
      onProgress: progressSpy,
    });

    expect(creativeDriveClient.downloadAsset).toHaveBeenCalledWith(baseAsset.publicUrl);
    expect(bynderClient.uploadFile).toHaveBeenCalledWith(
      expect.any(Buffer),
      baseAsset.originalFilename,
      baseAsset.metadata || {},
      expect.objectContaining({ mediaId: undefined })
    );
    expect(result.bynderId).toBe('bynder-123');
    expect(progressSpy).toHaveBeenCalled();
  });

  it('creates a new version when existingBynderId is provided', async () => {
    const { service, creativeDriveClient, bynderClient } = createService();

    const assetWithExistingBynder: MigrationAsset = {
      ...baseAsset,
      existingBynderId: 'existing-bynder-id',
    };

    const progressSpy = jest.fn();
    const result = await service.migrateAsset(assetWithExistingBynder, {
      onProgress: progressSpy,
    });

    expect(creativeDriveClient.downloadAsset).toHaveBeenCalledWith(assetWithExistingBynder.publicUrl);
    expect(bynderClient.uploadFile).toHaveBeenCalledWith(
      expect.any(Buffer),
      assetWithExistingBynder.originalFilename,
      assetWithExistingBynder.metadata || {},
      expect.objectContaining({ mediaId: 'existing-bynder-id' })
    );
    expect(result.bynderId).toBe('bynder-123');
    expect(progressSpy).toHaveBeenCalled();
  });
});

