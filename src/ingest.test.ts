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

  it('should fetch specified division and write assets to DynamoDB', async () => {
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
    });
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    expect(mockDynamoSend).toHaveBeenCalledTimes(1);
  });

  it('should handle API errors gracefully', async () => {
    mockAxiosPost.mockRejectedValueOnce(new Error('API Error'));

    const result = await handler({ divisionId: '45' }, {} as any, {} as any);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.totalFailures).toBe(1);
    expect(body.message).toMatch(/completed with 1 failure/);
  });

  it('should ingest assets for multiple division IDs', async () => {
    mockAxiosPost
      .mockResolvedValueOnce({
        data: {
          data: [
            {
              type: 'asset',
              attributes: {
                id: '100',
                original_filename: 'division45-file.tif',
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
      })
      .mockResolvedValueOnce({
        data: {
          data: [
            {
              type: 'asset',
              attributes: {
                id: '101',
                original_filename: 'division46-file.tif',
                original_filesize: 100,
                extension: 'tif',
                folder_id: '201',
                division_id: '46',
                meta: {
                  image_origin: 'https://example.com/46.tif',
                },
              },
            },
          ],
          meta: { total: 1 },
        },
      });

    mockAxiosGet
      .mockResolvedValueOnce({ data: { data: [] } })
      .mockResolvedValueOnce({ data: { data: [] } });

    const result = await handler(
      { maxAssets: 10, divisionIds: ['45', '46'] },
      {} as any,
      {} as any
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      message: 'Ingestion completed successfully',
      totalAssetsIngested: 2,
    });
    expect(mockAxiosPost).toHaveBeenCalledTimes(2);
    expect(mockDynamoSend).toHaveBeenCalledTimes(2);
  });

  it('should filter by asset IDs', async () => {
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

    mockAxiosGet.mockResolvedValueOnce({ data: { data: [] } });

    const result = await handler(
      { maxAssets: 10, divisionId: '45', assetIds: ['595167'] },
      {} as any,
      {} as any
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      message: 'Ingestion completed successfully',
      totalAssetsIngested: 1,
    });
    expect(mockDynamoSend).toHaveBeenCalledTimes(1);
  });
});
