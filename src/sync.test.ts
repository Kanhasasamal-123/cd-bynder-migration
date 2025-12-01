import { handler } from './sync';
import { Context } from 'aws-lambda';

// Create simple mock functions - must be before jest.mock calls
let mockValidateConfig: jest.Mock;
let mockSearchAssets: jest.Mock;
let mockGetAssetMetadata: jest.Mock;
let mockPutCreativeDriveAssetRecord: jest.Mock;
let mockCalculateDateRange: jest.Mock;

// Mock config module
jest.mock('./config', () => ({
  validateConfig: (...args: any[]) => mockValidateConfig(...args),
}));

// Mock CreativeDriveClient
jest.mock('./lib/creativedrive-client', () => ({
  CreativeDriveClient: jest.fn().mockImplementation(() => ({
    searchAssets: (...args: any[]) => mockSearchAssets(...args),
    getAssetMetadata: (...args: any[]) => mockGetAssetMetadata(...args),
  })),
}));

// Mock DynamoDB helper
jest.mock('./lib/dynamodb-client', () => ({
  putCreativeDriveAssetRecord: (...args: any[]) => mockPutCreativeDriveAssetRecord(...args),
}));

// Mock dateUtils
jest.mock('./lib/utils/dateUtils', () => ({
  calculateDateRange: (...args: any[]) => mockCalculateDateRange(...args),
}));

describe('Sync Lambda Handler', () => {
  let mockContext: Context;
  const mockDateRange = {
    start: '2025-01-01',
    end: '2025-01-02',
  };

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();

    // Setup default mocks
    mockValidateConfig = jest.fn().mockReturnValue({
      apiKey: 'test-api-key',
      apiBaseUrl: 'https://test-api.example.com',
      division: '45',
      tableName: 'test-table',
      syncIntervalMinutes: 60,
    });

    mockCalculateDateRange = jest.fn().mockReturnValue(mockDateRange);

    mockSearchAssets = jest.fn();
    mockGetAssetMetadata = jest.fn().mockResolvedValue([]);
    mockPutCreativeDriveAssetRecord = jest.fn().mockResolvedValue(undefined);

    // Mock Lambda context
    mockContext = {
      awsRequestId: 'test-request-id',
      functionName: 'test-function',
      functionVersion: '1',
      invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:test-function',
      memoryLimitInMB: '128',
      logGroupName: '/aws/lambda/test-function',
      logStreamName: '2025/01/01/[$LATEST]test',
      getRemainingTimeInMillis: jest.fn().mockReturnValue(30000),
      callbackWaitsForEmptyEventLoop: true,
      done: jest.fn(),
      fail: jest.fn(),
      succeed: jest.fn(),
    } as Context;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Successful sync', () => {
    it('should successfully sync a single page of assets', async () => {
      const mockAssets = [
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
              image_origin: 'https://cdn.example.com/image1.tif',
            },
          },
        },
        {
          type: 'asset',
          attributes: {
            id: '595168',
            original_filename: 'test-image-2.jpg',
            original_filesize: 1024000,
            extension: 'jpg',
            folder_id: '104849',
            division_id: '45',
            meta: {
              image_origin: 'https://cdn.example.com/image2.jpg',
            },
          },
        },
      ];

      mockSearchAssets.mockResolvedValueOnce({
        assets: mockAssets,
        total: 2,
      });

      const result = await handler({}, mockContext);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Asset sync completed successfully');
      expect(body.stats.totalAssets).toBe(2);
      expect(body.stats.newAssets).toBe(2);
      expect(body.stats.updatedAssets).toBe(0);
      expect(body.stats.duration).toBeGreaterThanOrEqual(0);

      expect(mockValidateConfig).toHaveBeenCalledTimes(1);
      expect(mockCalculateDateRange).toHaveBeenCalledWith(60);
      expect(mockSearchAssets).toHaveBeenCalledWith({
        divisions: [45],
        dateRange: mockDateRange,
        folderId: '',
        options: {
          limit: 100,
          offset: 0,
        },
      });
      expect(mockGetAssetMetadata).toHaveBeenCalledTimes(2);
      expect(mockPutCreativeDriveAssetRecord).toHaveBeenCalledTimes(2);
      expect(mockPutCreativeDriveAssetRecord).toHaveBeenCalledWith(
        'test-table',
        mockAssets[0],
        [],
        expect.objectContaining({
          status: 'PENDING',
          migrationMode: 'update',
          publicUrl: 'https://cdn.example.com/image1.tif',
        })
      );
    });

    it('should handle pagination and sync multiple pages', async () => {
      const firstPageAssets = Array.from({ length: 100 }, (_, i) => ({
        type: 'asset',
        attributes: {
          id: `595${i}`,
          original_filename: `test-image-${i}.tif`,
          original_filesize: 3570356,
          extension: 'tif',
          folder_id: '104849',
          division_id: '45',
          meta: {
            image_origin: `https://cdn.example.com/image${i}.tif`,
          },
        },
      }));

      const secondPageAssets = Array.from({ length: 50 }, (_, i) => ({
        type: 'asset',
        attributes: {
          id: `596${i}`,
          original_filename: `test-image-${i + 100}.tif`,
          original_filesize: 3570356,
          extension: 'tif',
          folder_id: '104849',
          division_id: '45',
          meta: {
            image_origin: `https://cdn.example.com/image${i + 100}.tif`,
          },
        },
      }));

      // First page
      mockSearchAssets.mockResolvedValueOnce({
        assets: firstPageAssets,
        total: 150,
      });

      // Second page
      mockSearchAssets.mockResolvedValueOnce({
        assets: secondPageAssets,
        total: 150,
      });

      const result = await handler({}, mockContext);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.stats.totalAssets).toBe(150);
      expect(body.stats.newAssets).toBe(150);
      expect(body.stats.updatedAssets).toBe(0);

      expect(mockSearchAssets).toHaveBeenCalledTimes(2);
      expect(mockSearchAssets).toHaveBeenNthCalledWith(1, {
        divisions: [45],
        dateRange: mockDateRange,
        folderId: '',
        options: {
          limit: 100,
          offset: 0,
        },
      });
      expect(mockSearchAssets).toHaveBeenNthCalledWith(2, {
        divisions: [45],
        dateRange: mockDateRange,
        folderId: '',
        options: {
          limit: 100,
          offset: 100,
        },
      });
      expect(mockPutCreativeDriveAssetRecord).toHaveBeenCalledTimes(150);
    });

    it('should handle empty results', async () => {
      mockSearchAssets.mockResolvedValueOnce({
        assets: [],
        total: 0,
      });

      const result = await handler({}, mockContext);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.stats.totalAssets).toBe(0);
      expect(body.stats.newAssets).toBe(0);
      expect(body.stats.updatedAssets).toBe(0);

      expect(mockSearchAssets).toHaveBeenCalledTimes(1);
      expect(mockPutCreativeDriveAssetRecord).not.toHaveBeenCalled();
    });

    it('should handle response without data array', async () => {
      mockSearchAssets.mockResolvedValueOnce({
        total: 0,
      });

      const result = await handler({}, mockContext);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.stats.totalAssets).toBe(0);

      expect(mockPutCreativeDriveAssetRecord).not.toHaveBeenCalled();
    });

    it('should handle response without meta total', async () => {
      const mockAssets = [
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
              image_origin: 'https://cdn.example.com/image.tif',
            },
          },
        },
      ];

      mockSearchAssets.mockResolvedValueOnce({
        assets: mockAssets,
      });

      const result = await handler({}, mockContext);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.stats.totalAssets).toBe(1);
      expect(body.stats.newAssets).toBe(1);
      expect(body.stats.updatedAssets).toBe(0);

      expect(mockSearchAssets).toHaveBeenCalledTimes(1);
      expect(mockPutCreativeDriveAssetRecord).toHaveBeenCalledTimes(1);
    });

    it('should calculate duration correctly', async () => {
      mockSearchAssets.mockResolvedValueOnce({
        assets: [],
        total: 0,
      });

      const result = await handler({}, mockContext);
      const body = JSON.parse(result.body);
      
      // Duration should be non-negative and reasonable (less than 1 second for this test)
      expect(body.stats.duration).toBeGreaterThanOrEqual(0);
      expect(body.stats.duration).toBeLessThan(1000);
    });
  });

  describe('Error handling', () => {
    it('should return 500 status code when config validation fails', async () => {
      mockValidateConfig.mockImplementation(() => {
        throw new Error('Invalid configuration');
      });

      const result = await handler({}, mockContext);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Asset sync failed');
      expect(body.error).toBe('Invalid configuration');

      expect(mockSearchAssets).not.toHaveBeenCalled();
      expect(mockPutCreativeDriveAssetRecord).not.toHaveBeenCalled();
    });

    it('should return 500 status code when API call fails', async () => {
      mockSearchAssets.mockRejectedValueOnce(new Error('API request failed'));

      const result = await handler({}, mockContext);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Asset sync failed');
      expect(body.error).toBe('API request failed');

      expect(mockSearchAssets).toHaveBeenCalledTimes(1);
      expect(mockPutCreativeDriveAssetRecord).not.toHaveBeenCalled();
    });

    it('should handle DynamoDB failures gracefully', async () => {
      const mockAssets = [
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
              image_origin: 'https://cdn.example.com/image.tif',
            },
          },
        },
      ];

      mockSearchAssets.mockResolvedValueOnce({
        assets: mockAssets,
        total: 1,
      });

      mockPutCreativeDriveAssetRecord.mockRejectedValueOnce(new Error('DynamoDB write failed'));

      const result = await handler({}, mockContext);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.stats.totalAssets).toBe(1);
      expect(body.stats.newAssets).toBe(0);

      expect(mockSearchAssets).toHaveBeenCalledTimes(1);
      expect(mockPutCreativeDriveAssetRecord).toHaveBeenCalledTimes(1);
    });

    it('should return 500 status code when date range calculation fails', async () => {
      mockCalculateDateRange.mockImplementation(() => {
        throw new Error('Invalid date range');
      });

      const result = await handler({}, mockContext);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Asset sync failed');
      expect(body.error).toBe('Invalid date range');

      expect(mockSearchAssets).not.toHaveBeenCalled();
    });

    it('should handle non-Error exceptions', async () => {
      mockSearchAssets.mockRejectedValueOnce('String error');

      const result = await handler({}, mockContext);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Asset sync failed');
    });
  });

  describe('Logging', () => {
    it('should log sync start with request ID', async () => {
      mockSearchAssets.mockResolvedValueOnce({
        assets: [],
        total: 0,
      });

      await handler({}, mockContext);

      expect(console.log).toHaveBeenCalledWith(
        'Starting asset sync process',
        expect.objectContaining({
          requestId: 'test-request-id',
          timestamp: expect.any(String),
        })
      );
    });

    it('should log configuration validation', async () => {
      mockSearchAssets.mockResolvedValueOnce({
        assets: [],
        total: 0,
      });

      await handler({}, mockContext);

      expect(console.log).toHaveBeenCalledWith(
        'Configuration validated',
        expect.objectContaining({
          division: '45',
          tableName: 'test-table',
        })
      );
    });

    it('should log date range', async () => {
      mockSearchAssets.mockResolvedValueOnce({
        assets: [],
        total: 0,
      });

      await handler({}, mockContext);

      expect(console.log).toHaveBeenCalledWith(
        'Syncing assets from date range',
        mockDateRange
      );
    });

    it('should log batch fetching', async () => {
      const mockAssets = [
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
              image_origin: 'https://cdn.example.com/image.tif',
            },
          },
        },
      ];

      mockSearchAssets.mockResolvedValueOnce({
        assets: mockAssets,
        total: 1,
      });

      await handler({}, mockContext);

      expect(console.log).toHaveBeenCalledWith(
        'Fetching assets batch (offset: 0)'
      );
      expect(console.log).toHaveBeenCalledWith(
        'Fetched 1 assets (1 total available)'
      );
      expect(console.log).toHaveBeenCalledWith(
        'Batch stored: 1 assets'
      );
    });

    it('should log sync completion', async () => {
      mockSearchAssets.mockResolvedValueOnce({
        assets: [],
        total: 0,
      });

      await handler({}, mockContext);

      expect(console.log).toHaveBeenCalledWith(
        'Asset sync completed successfully',
        expect.objectContaining({
          totalAssets: 0,
          newAssets: 0,
          updatedAssets: 0,
          duration: expect.any(Number),
        })
      );
    });

    it('should log errors when sync fails', async () => {
      const error = new Error('Test error');
      mockSearchAssets.mockRejectedValueOnce(error);

      await handler({}, mockContext);

      expect(console.error).toHaveBeenCalledWith(
        'Asset sync failed',
        expect.objectContaining({
          error: 'Test error',
          stack: expect.any(String),
        })
      );
    });
  });

  describe('Configuration and context', () => {
    it('should use config values correctly', async () => {
      mockValidateConfig.mockReturnValue({
        apiKey: 'custom-api-key',
        apiBaseUrl: 'https://custom-api.example.com',
        division: '99',
        tableName: 'custom-table',
        syncIntervalMinutes: 120,
      });

      mockSearchAssets.mockResolvedValueOnce({
        assets: [],
        total: 0,
      });

      await handler({}, mockContext);

      expect(mockCalculateDateRange).toHaveBeenCalledWith(120);
      expect(mockSearchAssets).toHaveBeenCalledWith({
        divisions: [99],
        folderId: '',
        dateRange: mockDateRange,
        options: {
          limit: 100,
          offset: 0,
        },
      });
    });

    it('should handle different event types', async () => {
      mockSearchAssets.mockResolvedValueOnce({
        assets: [],
        total: 0,
      });

      const eventBridgeEvent = {
        version: '0',
        id: 'test-event-id',
        'detail-type': 'Scheduled Event',
        source: 'aws.events',
        account: '123456789012',
        time: '2025-01-01T00:00:00Z',
        region: 'us-east-1',
        resources: ['arn:aws:events:us-east-1:123456789012:rule/test-rule'],
        detail: {},
      };

      const result = await handler(eventBridgeEvent, mockContext);

      expect(result.statusCode).toBe(200);
      // Event parameter is prefixed with underscore, so it's not used
      // This test just ensures the handler doesn't crash on different event types
    });
  });
});
