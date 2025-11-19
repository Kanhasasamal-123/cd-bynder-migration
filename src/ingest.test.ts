import { handler } from './ingest';

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
  PutCommand: jest.fn((params) => params),
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
    mockDynamoSend = jest.fn().mockResolvedValue({});
    mockSecretsSend = jest.fn().mockResolvedValue({
      SecretString: JSON.stringify({ apiKey: 'test-api-key' }),
    });
    mockAxiosGet = jest.fn();
    mockAxiosPost = jest.fn();

    process.env.MIGRATION_TRACKER_TABLE = 'test-table';
    process.env.CREATIVE_DRIVE_SECRET_NAME = 'test-secret';
  });

  it('should fetch divisions and write assets to DynamoDB', async () => {
    // Mock divisions API response (GET /divisions)
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        data: [
          {
            type: 'division',
            attributes: {
              id: '45',
              name: 'Test Division',
              storage: '100.0',
              totalFolders: 1,
            },
          },
        ],
      },
    });

    // Mock root folders search API response (POST /folders/_search)
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        data: [
          {
            type: 'folder',
            attributes: {
              id: '104849',
              name: 'Test Folder',
              parent_id: null,
              division_id: '45',
            },
          },
        ],
      },
    });

    // Mock subfolders API response (GET /folders/{id}/folders)
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        data: [],
      },
    });

    // Mock asset search API response (POST /search)
    mockAxiosPost.mockResolvedValueOnce({
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
    });

    // Mock asset metadata API response (GET /assets/{id}/metadatas)
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
          {
            type: 'metadata',
            attributes: {
              id: '2',
              attribute_id: '11',
              name: 'Description',
              value: 'Test Description',
            },
          },
        ],
      },
    });

    const result = await handler({ maxAssets: 10 }, {} as any, {} as any);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      message: 'Ingestion completed successfully',
      totalAssetsIngested: 1,
    });

    expect(mockDynamoSend).toHaveBeenCalled();
  });

  it('should handle API errors gracefully', async () => {
    // Mock API error (critical failure - can't fetch divisions)
    mockAxiosGet.mockRejectedValueOnce(new Error('API Error'));

    // Should throw for critical errors
    await expect(handler({}, {} as any, {} as any)).rejects.toThrow('Critical ingestion failure');
  });

  it('should filter by folder names', async () => {
    // Mock divisions API response
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        data: [
          {
            type: 'division',
            attributes: {
              id: '45',
              name: 'Test Division',
              storage: '100.0',
              totalFolders: 2,
            },
          },
        ],
      },
    });

    // Mock root folders search API response with 2 folders
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        data: [
          {
            type: 'folder',
            attributes: {
              id: '104849',
              name: 'Matching Folder',
              parent_id: null,
              division_id: '45',
            },
          },
          {
            type: 'folder',
            attributes: {
              id: '104850',
              name: 'Non-Matching Folder',
              parent_id: null,
              division_id: '45',
            },
          },
        ],
      },
    });

    // Mock subfolders for first folder (matching)
    mockAxiosGet.mockResolvedValueOnce({
      data: { data: [] },
    });

    // Mock asset search for matching folder
    mockAxiosPost.mockResolvedValueOnce({
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
    });

    // Mock metadata
    mockAxiosGet.mockResolvedValueOnce({
      data: { data: [] },
    });

    const result = await handler(
      { maxAssets: 10, folderNames: ['Matching Folder'] },
      {} as any,
      {} as any
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      message: 'Ingestion completed successfully',
      totalAssetsIngested: 1,
    });
  });

  it('should filter by asset IDs', async () => {
    // Mock divisions API response
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        data: [
          {
            type: 'division',
            attributes: {
              id: '45',
              name: 'Test Division',
              storage: '100.0',
              totalFolders: 1,
            },
          },
        ],
      },
    });

    // Mock root folders search API response
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        data: [
          {
            type: 'folder',
            attributes: {
              id: '104849',
              name: 'Test Folder',
              parent_id: null,
              division_id: '45',
            },
          },
        ],
      },
    });

    // Mock subfolders
    mockAxiosGet.mockResolvedValueOnce({
      data: { data: [] },
    });

    // Mock asset search with multiple assets
    mockAxiosPost.mockResolvedValueOnce({
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
          {
            type: 'asset',
            attributes: {
              id: '595168',
              original_filename: 'test-image-2.tif',
              original_filesize: 3570356,
              extension: 'tif',
              folder_id: '104849',
              division_id: '45',
              meta: {
                image_origin: 'https://cdn.example.com/public/test2.tif',
              },
            },
          },
        ],
        meta: { total: 2 },
      },
    });

    // Mock metadata for the matching asset only
    mockAxiosGet.mockResolvedValueOnce({
      data: { data: [] },
    });

    const result = await handler({ maxAssets: 10, assetIds: ['595167'] }, {} as any, {} as any);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      message: 'Ingestion completed successfully',
      totalAssetsIngested: 1,
    });
  });
});
