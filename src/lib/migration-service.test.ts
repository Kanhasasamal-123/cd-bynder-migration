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
    findMedia?: jest.Mock;
  }) {
    const creativeDriveClient = {
      downloadAsset: overrides?.downloadAsset || jest.fn().mockResolvedValue(Buffer.from('file')),
    };

    const bynderClient = {
      uploadFile: overrides?.uploadFile || jest.fn().mockResolvedValue('bynder-123'),
      findMedia: overrides?.findMedia || jest.fn().mockResolvedValue(null),
      extractMetadataFromFilename: jest.fn().mockReturnValue({ styleNumber: '', colorCode: '', angleCode: '' }),
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
      expect.objectContaining({ mediaId: undefined, addAsAdditionalFile: false })
    );
    expect(result.bynderId).toBe('bynder-123');
    expect(progressSpy).toHaveBeenCalled();
  });

  it('creates a new version when existingBynderId is provided', async () => {
    const { service, creativeDriveClient, bynderClient } = createService();

    const assetWithExistingBynder = {
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
      expect.objectContaining({ mediaId: 'existing-bynder-id', addAsAdditionalFile: false })
    );
    expect(result.bynderId).toBe('bynder-123');
    expect(progressSpy).toHaveBeenCalled();
  });

  it('adds file as additional file when no existingBynderId but Bynder has matching asset (Style_Number_RLM_Code + angle)', async () => {
    const findMedia = jest.fn().mockResolvedValue('matched-bynder-id');
    const { service, bynderClient } = createService({ findMedia });

    const progressSpy = jest.fn();
    const result = await service.migrateAsset(baseAsset, {
      onProgress: progressSpy,
    });

    expect(findMedia).toHaveBeenCalledWith('ST123', 'CC123', 'FRONT', expect.any(Function));
    expect(bynderClient.uploadFile).toHaveBeenCalledWith(
      expect.any(Buffer),
      baseAsset.originalFilename,
      baseAsset.metadata || {},
      expect.objectContaining({ mediaId: 'matched-bynder-id', addAsAdditionalFile: true })
    );
    expect(result.bynderId).toBe('bynder-123');
    expect(progressSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'match',
        message: expect.stringContaining('additional file'),
      })
    );
  });

  it('creates new asset when no existingBynderId and no angle_code (no match for additional file)', async () => {
    const assetNoAngle = { ...baseAsset, metadata: { style_number: 'ST123', color_code: 'CC123' } };
    const findMedia = jest.fn().mockResolvedValue(null);
    const { service, bynderClient } = createService({ findMedia });

    const result = await service.migrateAsset(assetNoAngle, { onProgress: jest.fn() });

    expect(findMedia).not.toHaveBeenCalled();
    expect(bynderClient.uploadFile).toHaveBeenCalledWith(
      expect.any(Buffer),
      assetNoAngle.originalFilename,
      assetNoAngle.metadata || {},
      expect.objectContaining({ mediaId: undefined, addAsAdditionalFile: false })
    );
    expect(result.bynderId).toBe('bynder-123');
  });
});

