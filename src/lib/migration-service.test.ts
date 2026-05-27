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
      extractMetadataFromFilename: jest
        .fn()
        .mockReturnValue({ styleNumber: 'ST123', colorCode: 'CC123', angleCode: 'FRONT' }),
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
      expect.objectContaining({
        style_number: 'ST123',
        color_code: 'CC123',
        angle_code: 'FRONT',
      }),
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
      expect.objectContaining({
        style_number: 'ST123',
        color_code: 'CC123',
        angle_code: 'FRONT',
      }),
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
      {},
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

  it('skips re-upload when white-background asset already has bynderId (no new version on parent)', async () => {
    const findMedia = jest.fn();
    const downloadAsset = jest.fn();
    const uploadFile = jest.fn();
    const { service } = createService({ findMedia, downloadAsset, uploadFile });

    const whiteBackgroundAsset: MigrationAsset = {
      ...baseAsset,
      existingBynderId: 'parent-grey-bynder-id',
      requiresExistingAsset: true,
    };

    const result = await service.migrateAsset(whiteBackgroundAsset, { onProgress: jest.fn() });

    expect(result.skipped).toBe(true);
    expect(result.bynderId).toBe('parent-grey-bynder-id');
    expect(findMedia).not.toHaveBeenCalled();
    expect(downloadAsset).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('matches white-background additional files by original filename', async () => {
    const findMedia = jest.fn().mockResolvedValue('matched-bynder-id');
    const { service, bynderClient } = createService({ findMedia });
    const whiteBackgroundAsset: MigrationAsset = {
      ...baseAsset,
      originalFilename: 'ST123-CC123_FRONT.tif',
      requiresExistingAsset: true,
    };

    const result = await service.migrateAsset(whiteBackgroundAsset, {
      onProgress: jest.fn(),
    });

    expect(findMedia).toHaveBeenCalledWith(
      'ST123',
      'CC123',
      'FRONT',
      expect.any(Function),
      { originalFilename: 'ST123-CC123_FRONT.tif' }
    );
    expect(bynderClient.uploadFile).toHaveBeenCalledWith(
      expect.any(Buffer),
      whiteBackgroundAsset.originalFilename,
      {},
      expect.objectContaining({ mediaId: 'matched-bynder-id', addAsAdditionalFile: true })
    );
    expect(result.bynderId).toBe('bynder-123');
  });

  it('uses filename-derived codes for matching, not Creative Drive metadata', async () => {
    const findMedia = jest.fn().mockResolvedValue(null);
    const extractMetadataFromFilename = jest.fn().mockReturnValue({
      styleNumber: 'FROM-FILE-STYLE',
      colorCode: '001',
      angleCode: '4',
    });
    const bynderClient = {
      uploadFile: jest.fn().mockResolvedValue('bynder-123'),
      findMedia,
      extractMetadataFromFilename,
    };
    const service = new MigrationService(
      { downloadAsset: jest.fn().mockResolvedValue(Buffer.from('file')) } as any,
      bynderClient as any
    );

    const asset: MigrationAsset = {
      ...baseAsset,
      originalFilename: '710948949-001_4.tif',
      metadata: {
        style_number: 'WRONG-STYLE',
        color_code: 'WRONG-COLOR',
        angle_code: 'WRONG-ANGLE',
      },
    };

    await service.migrateAsset(asset, { onProgress: jest.fn() });

    expect(findMedia).toHaveBeenCalledWith('FROM-FILE-STYLE', '001', '4', expect.any(Function));
  });

  it('creates new asset when no existingBynderId and no angle_code (no match for additional file)', async () => {
    const assetNoAngle = { ...baseAsset, metadata: { style_number: 'ST123', color_code: 'CC123' } };
    const findMedia = jest.fn().mockResolvedValue(null);
    const extractMetadataFromFilename = jest
      .fn()
      .mockReturnValue({ styleNumber: 'ST123', colorCode: 'CC123', angleCode: '' });
    const bynderClient = {
      uploadFile: jest.fn().mockResolvedValue('bynder-123'),
      findMedia,
      extractMetadataFromFilename,
    };
    const service = new MigrationService(
      { downloadAsset: jest.fn().mockResolvedValue(Buffer.from('file')) } as any,
      bynderClient as any
    );

    const result = await service.migrateAsset(assetNoAngle, { onProgress: jest.fn() });

    expect(findMedia).not.toHaveBeenCalled();
    expect(bynderClient.uploadFile).toHaveBeenCalledWith(
      expect.any(Buffer),
      assetNoAngle.originalFilename,
      expect.objectContaining({
        style_number: 'ST123',
        color_code: 'CC123',
        angle_code: '',
      }),
      expect.objectContaining({ mediaId: undefined, addAsAdditionalFile: false })
    );
    expect(result.bynderId).toBe('bynder-123');
  });
});

