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
      extractMetadataFromFilename: jest.fn().mockReturnValue({ styleNumber: '', colorCode: '' }),
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

  it('creates a new version when findMedia returns existing Bynder ID', async () => {
    const findMediaMock = jest.fn().mockResolvedValue('existing-bynder-id');
    const { service, creativeDriveClient, bynderClient } = createService({
      findMedia: findMediaMock,
    });

    const progressSpy = jest.fn();
    const result = await service.migrateAsset(baseAsset, {
      onProgress: progressSpy,
    });

    expect(findMediaMock).toHaveBeenCalledWith(
      baseAsset.metadata?.style_number,
      baseAsset.metadata?.color_code,
      baseAsset.metadata?.angle_code
    );
    expect(creativeDriveClient.downloadAsset).toHaveBeenCalledWith(baseAsset.publicUrl);
    expect(bynderClient.uploadFile).toHaveBeenCalledWith(
      expect.any(Buffer),
      baseAsset.originalFilename,
      baseAsset.metadata || {},
      expect.objectContaining({ mediaId: 'existing-bynder-id' })
    );
    expect(result.bynderId).toBe('bynder-123');
    expect(progressSpy).toHaveBeenCalled();
  });
});

