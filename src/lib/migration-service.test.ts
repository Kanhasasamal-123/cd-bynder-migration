import { MigrationService, MigrationAsset } from './migration-service';

describe('MigrationService', () => {
  const baseAsset: MigrationAsset = {
    creativeDriveAssetId: 'cd-123',
    originalFilename: 'sample.jpg',
    publicUrl: 'https://example.com/sample.jpg',
    metadata: {
      style_number: 'ST123',
      color_code: 'CC123',
    },
  };

  function createService(overrides?: {
    findMediaByFilename?: jest.Mock;
    uploadFile?: jest.Mock;
    downloadAsset?: jest.Mock;
  }) {
    const creativeDriveClient = {
      downloadAsset: overrides?.downloadAsset || jest.fn().mockResolvedValue(Buffer.from('file')),
    };

    const bynderClient = {
      findMediaByFilename:
        overrides?.findMediaByFilename || jest.fn().mockResolvedValue(null),
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

  it('uploads new asset when no existing Bynder media is found', async () => {
    const { service, creativeDriveClient, bynderClient } = createService();

    const progressSpy = jest.fn();
    const result = await service.migrateAsset(baseAsset, {
      onProgress: progressSpy,
    });

    expect(bynderClient.findMediaByFilename).toHaveBeenCalledWith(
      baseAsset.metadata!.style_number,
      baseAsset.metadata!.color_code
    );
    expect(creativeDriveClient.downloadAsset).toHaveBeenCalledWith(baseAsset.publicUrl);
    expect(bynderClient.uploadFile).toHaveBeenCalledWith(
      expect.any(Buffer),
      baseAsset.originalFilename,
      baseAsset.metadata || {},
      expect.any(Object)
    );
    expect(result.bynderId).toBe('bynder-123');
    expect(progressSpy).toHaveBeenCalled();
  });

  it('creates a new version when Bynder asset already exists', async () => {
    const { service, creativeDriveClient, bynderClient } = createService({
      findMediaByFilename: jest.fn().mockResolvedValue('existing-bynder-id'),
    });

    const progressSpy = jest.fn();
    const result = await service.migrateAsset(baseAsset, {
      onProgress: progressSpy,
    });

    expect(bynderClient.findMediaByFilename).toHaveBeenCalledWith(
      baseAsset.metadata!.style_number,
      baseAsset.metadata!.color_code
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

