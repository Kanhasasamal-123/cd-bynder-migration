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
  PutCommand: jest.fn((params) => ({ ...params, __type: 'PutCommand' })),
  GetCommand: jest.fn((params) => ({ ...params, __type: 'GetCommand' })),
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
      dryRun: false,
    });
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    expect(mockDynamoSend).toHaveBeenCalledTimes(2);
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
      dryRun: false,
    });
    expect(mockAxiosPost).toHaveBeenCalledTimes(2);
    expect(mockDynamoSend).toHaveBeenCalledTimes(4);
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
      dryRun: false,
    });
    expect(mockDynamoSend).toHaveBeenCalledTimes(2);
  });

  it('should honor syncLastDays parameter', async () => {
    mockAxiosPost.mockResolvedValueOnce({
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
    mockAxiosPost.mockResolvedValueOnce({
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

    const result = await handler(
      { maxAssets: 10, divisionId: '45', dryRun: true },
      {} as any,
      {} as any
    );

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.dryRun).toBe(true);
    expect(body.totalAssetsIngested).toBe(1);
    expect(mockDynamoSend).not.toHaveBeenCalled();
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });
});
