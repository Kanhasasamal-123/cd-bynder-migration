import { handler } from './ingest';
import * as dateUtils from './lib/utils/dateUtils';

// Create simple mock functions - must be before jest.mock calls
let mockDynamoSend: jest.Mock;
let mockSecretsSend: jest.Mock;
let mockAxiosGet: jest.Mock;
let mockAxiosPost: jest.Mock;

// Mock AWS SDK modules
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({
      send: (...args: any[]) => mockDynamoSend(...args),
    })),
  },
  UpdateCommand: jest.fn().mockImplementation((params) => ({ ...params, _commandType: 'Update' })),
  BatchGetCommand: jest.fn().mockImplementation((params) => ({ ...params, _commandType: 'BatchGet' })),
}));

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({
    send: (...args: any[]) => mockSecretsSend(...args),
  })),
  GetSecretValueCommand: jest.fn((params) => params),
}));

// Mock axios
jest.mock('axios', () => ({
  get: (...args: any[]) => mockAxiosGet(...args),
  post: (...args: any[]) => mockAxiosPost(...args),
}));

describe('CreativeDriveIngestLambda', () => {
  beforeEach(() => {
    // Default mock: BatchGetCommand returns empty (no existing assets), UpdateCommand succeeds
    mockDynamoSend = jest.fn().mockImplementation((cmd) => {
      // BatchGetCommand has RequestItems property
      if (cmd.RequestItems) {
        // Return empty responses (no existing assets)
        return Promise.resolve({ Responses: { 'test-table': [] } });
      }
      // UpdateCommand
      return Promise.resolve({});
    });
    mockSecretsSend = jest.fn().mockResolvedValue({
      SecretString: JSON.stringify({ apiKey: 'test-api-key' }),
    });
    mockAxiosGet = jest.fn();
    mockAxiosPost = jest.fn();
    jest.spyOn(dateUtils, 'calculateDateRange').mockReturnValue({
      start: '2020-01-01',
      end: '2020-01-02',
    });

    process.env.MIGRATION_TRACKER_TABLE = 'test-table';
    process.env.CREATIVE_DRIVE_SECRET_NAME = 'test-secret';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should fetch specified division and write assets to DynamoDB', async () => {
    // Phase 1 makes 2 search calls: one for count, one for assets
    const assetResponse = {
      data: {
        data: [
          {
            type: 'asset',
            attributes: {
              id: '595167',
              original_filename: 'test-image.tif',
              original_filesize: 3570356,
              extension: 'tif',
              folder_id: '104849',
              division_id: '45',
              meta: {
                image_origin: 'https://cdn.example.com/public/test.tif',
              },
            },
          },
        ],
        meta: { total: 1 },
      },
    };
    mockAxiosPost.mockResolvedValue(assetResponse);

    mockAxiosGet.mockResolvedValueOnce({
      data: {
        data: [
          {
            type: 'metadata',
            attributes: {
              id: '1',
              attribute_id: '10',
              name: 'Title',
              value: 'Test Image Title',
            },
          },
        ],
      },
    });

    const result = await handler({ maxAssets: 10, divisionId: '45' }, {} as any, {} as any);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      message: 'Ingestion completed successfully',
      totalAssetsIngested: 1,
      dryRun: false,
    });
    // Phase 1: 2 POST calls (count + assets), Phase 1.5: 1 BatchGet, Phase 3: 1 Update
    expect(mockAxiosPost).toHaveBeenCalled();
    expect(mockDynamoSend).toHaveBeenCalledTimes(2); // 1 BatchGet + 1 Put
  });

  it('should skip already processed assets in delta mode and not count them', async () => {
    const assetResponse = {
      data: {
        data: [
          {
            type: 'asset',
            attributes: {
              id: '595167',
              original_filename: 'test-image.tif',
              original_filesize: 100,
              extension: 'tif',
              folder_id: '200',
              division_id: '45',
              meta: {
                image_origin: 'https://example.com/45.tif',
              },
            },
          },
        ],
        meta: { total: 1 },
      },
    };
    mockAxiosPost.mockResolvedValue(assetResponse);

    // Reset and set up mock to return UPLOADED asset - should be skipped in Phase 1.5
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({
      Responses: {
        'test-table': [
          { creativeDriveAssetId: '595167', status: 'UPLOADED' }
        ]
      }
    });

    const result = await handler({ maxAssets: 10, divisionId: '45' }, {} as any, {} as any);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      message: 'Ingestion completed successfully',
      totalAssetsIngested: 0,
      dryRun: false,
    });
    // Only 1 BatchGetCommand, no UpdateCommand since asset was skipped
    expect(mockDynamoSend).toHaveBeenCalledTimes(1);
    // No metadata fetch since asset was filtered out
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('should handle API errors gracefully', async () => {
    mockAxiosPost.mockRejectedValueOnce(new Error('API Error'));

    const result = await handler({ divisionId: '45' }, {} as any, {} as any);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.totalFailures).toBe(1);
    expect(body.message).toMatch(/completed with 1 failure/);
    expect(body.dryRun).toBe(false);
  });

  it('should search by specific asset ID using query parameter', async () => {
    mockAxiosPost.mockResolvedValue({
      data: {
        data: [
          {
            type: 'asset',
            attributes: {
              id: '595167',
              original_filename: 'test-image-1.tif',
              original_filesize: 3570356,
              extension: 'tif',
              folder_id: '104849',
              division_id: '45',
              meta: {
                image_origin: 'https://cdn.example.com/public/test1.tif',
              },
            },
          },
        ],
        meta: { total: 1 },
      },
    });

    mockAxiosGet.mockResolvedValueOnce({ data: { data: [] } });

    const result = await handler(
      { divisionId: '45', assetId: '595167' },
      {} as any,
      {} as any
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      message: 'Ingestion completed successfully',
      totalAssetsIngested: 1,
      dryRun: false,
    });
    // Verify search was called with query parameter
    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining('/search'),
      expect.objectContaining({ query: '595167' }),
      expect.any(Object)
    );
    // 1 BatchGet + 1 Update
    expect(mockDynamoSend).toHaveBeenCalledTimes(2);
  });

  it('should honor syncLastDays parameter', async () => {
    mockAxiosPost.mockResolvedValue({
      data: {
        data: [
          {
            type: 'asset',
            attributes: {
              id: '900',
              original_filename: 'recent-file.tif',
              original_filesize: 123,
              extension: 'tif',
              folder_id: '500',
              division_id: '45',
              meta: {
                image_origin: 'https://example.com/recent.tif',
              },
            },
          },
        ],
        meta: { total: 1 },
      },
    });

    mockAxiosGet.mockResolvedValueOnce({ data: { data: [] } });

    await handler(
      { maxAssets: 10, divisionId: '45', syncLastDays: 3 },
      {} as any,
      {} as any
    );

    expect(dateUtils.calculateDateRange).toHaveBeenCalledWith(3 * 24 * 60);
  });

  it('supports dry-run mode without writing to DynamoDB', async () => {
    mockAxiosPost.mockResolvedValue({
      data: {
        data: [
          {
            type: 'asset',
            attributes: {
              id: '999',
              original_filename: 'dry-run-file.tif',
              original_filesize: 50,
              extension: 'tif',
              folder_id: '300',
              division_id: '45',
              meta: {
                image_origin: 'https://example.com/dry.tif',
              },
            },
          },
        ],
        meta: { total: 1 },
      },
    });

    // Mock metadata fetch
    mockAxiosGet.mockResolvedValueOnce({ data: { data: [] } });

    const result = await handler(
      { maxAssets: 10, divisionId: '45', dryRun: true },
      {} as any,
      {} as any
    );

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.dryRun).toBe(true);
    expect(body.totalAssetsIngested).toBe(1);
    // In dry-run, batch check is called but no writes
    expect(mockDynamoSend).toHaveBeenCalledTimes(1); // Only BatchGet, no Update
    // Metadata fetch should happen in dry-run
    expect(mockAxiosGet).toHaveBeenCalled();
  });

  it('clear-bynderId-state removes bynderId for assets in folder and division', async () => {
    mockAxiosPost
      .mockResolvedValueOnce({ data: { data: [], meta: { total: 2 } } })
      .mockResolvedValueOnce({
        data: {
          data: [
            {
              type: 'asset',
              attributes: {
                id: '1001',
                original_filename: 'a.tif',
                original_filesize: 1,
                extension: 'tif',
                folder_id: '104851',
                division_id: '45',
              },
            },
            {
              type: 'asset',
              attributes: {
                id: '1002',
                original_filename: 'b.tif',
                original_filesize: 1,
                extension: 'tif',
                folder_id: '104851',
                division_id: '45',
              },
            },
          ],
          meta: { total: 2 },
        },
      });

    mockDynamoSend.mockImplementation((cmd) => {
      if (cmd.RequestItems) {
        return Promise.resolve({
          Responses: {
            'test-table': [
              { creativeDriveAssetId: '1001', status: 'UPLOADED' },
              { creativeDriveAssetId: '1002', status: 'UPLOADED' },
            ],
          },
        });
      }
      return Promise.resolve({});
    });

    const result = await handler(
      {
        action: 'clear-bynderId-state',
        divisionId: '45',
        folderId: '104851',
        maxAssets: 100,
      },
      {} as any,
      {} as any
    );

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.action).toBe('clear-bynderId-state');
    expect(body.totalCleared).toBe(2);
    expect(body.totalMatching).toBe(2);

    const updateCalls = mockDynamoSend.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd) => cmd.UpdateExpression?.includes('REMOVE bynderId'));
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0].Key).toEqual({ creativeDriveAssetId: '1001' });
    expect(updateCalls[0].ExpressionAttributeValues[':status']).toBe('PENDING');
  });

  it('clear-bynderId-state dry-run does not write to DynamoDB', async () => {
    mockAxiosPost
      .mockResolvedValueOnce({ data: { data: [], meta: { total: 1 } } })
      .mockResolvedValueOnce({
        data: {
          data: [
            {
              type: 'asset',
              attributes: {
                id: '1001',
                original_filename: 'a.tif',
                original_filesize: 1,
                extension: 'tif',
                folder_id: '104851',
                division_id: '45',
              },
            },
          ],
          meta: { total: 1 },
        },
      });

    mockDynamoSend.mockImplementation((cmd) => {
      if (cmd.RequestItems) {
        return Promise.resolve({
          Responses: {
            'test-table': [{ creativeDriveAssetId: '1001', status: 'UPLOADED' }],
          },
        });
      }
      return Promise.resolve({});
    });

    const result = await handler(
      {
        action: 'clear-bynderId-state',
        divisionId: '45',
        folderId: '104851',
        dryRun: true,
      },
      {} as any,
      {} as any
    );

    const body = JSON.parse(result.body);
    expect(body.totalCleared).toBe(1);
    expect(body.dryRun).toBe(true);

    const removeCalls = mockDynamoSend.mock.calls.filter(
      ([cmd]) => cmd.UpdateExpression?.includes('REMOVE bynderId')
    );
    expect(removeCalls).toHaveLength(0);
  });

  it('clear-bynderId-state requires folderId', async () => {
    await expect(
      handler({ action: 'clear-bynderId-state', divisionId: '45' }, {} as any, {} as any)
    ).rejects.toThrow('folderId must be provided');
  });

  it('clear-bynderId-state processes assets when CD returns ts_folder_id not folder_id', async () => {
    mockAxiosPost
      .mockResolvedValueOnce({ data: { data: [], meta: { total: 1 } } })
      .mockResolvedValueOnce({
        data: {
          data: [
            {
              type: 'asset',
              attributes: {
                id: '4206785',
                original_filename: 'test.tif',
                original_filesize: 1,
                extension: 'tif',
                ts_folder_id: '104851',
                division_id: '45',
              },
            },
          ],
          meta: { total: 1 },
        },
      });

    mockDynamoSend.mockImplementation((cmd) => {
      if (cmd.RequestItems) {
        return Promise.resolve({
          Responses: {
            'test-table': [{ creativeDriveAssetId: '4206785', status: 'UPLOADED' }],
          },
        });
      }
      return Promise.resolve({});
    });

    const result = await handler(
      {
        action: 'clear-bynderId-state',
        divisionId: '45',
        folderId: '104851',
      },
      {} as any,
      {} as any
    );

    const body = JSON.parse(result.body);
    expect(body.totalMatching).toBe(1);
    expect(body.totalCleared).toBe(1);

    const updateCalls = mockDynamoSend.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd) => cmd.UpdateExpression?.includes('REMOVE bynderId'));
    expect(updateCalls[0].Key).toEqual({ creativeDriveAssetId: '4206785' });
  });
});
