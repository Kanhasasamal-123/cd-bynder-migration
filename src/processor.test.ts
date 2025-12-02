import { handler } from './processor';
import { DynamoDBStreamEvent } from 'aws-lambda';

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
  GetCommand: jest.fn((params) => params),
  UpdateCommand: jest.fn((params) => params),
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

describe('AssetMigrationProcessorLambda', () => {
  beforeEach(() => {
    mockDynamoSend = jest.fn();
    mockSecretsSend = jest.fn().mockResolvedValue({
      SecretString: JSON.stringify({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        accessTokenUrl: 'https://test.bynder.com/oauth/token',
        apiBaseUrl: 'https://test.bynder.com',
      }),
    });
    mockAxiosGet = jest.fn();
    mockAxiosPost = jest.fn();

    process.env.MIGRATION_TRACKER_TABLE = 'test-table';
    process.env.BYNDER_SECRET_NAME = 'bynder-secret';
  });

  it('should process asset and update status to UPLOADED', async () => {
    // No existing Bynder asset
    mockAxiosGet.mockResolvedValueOnce({ data: [] });

    const mockEvent: DynamoDBStreamEvent = {
      Records: [
        {
          eventID: '1',
          eventName: 'INSERT',
          eventVersion: '1.0',
          eventSource: 'aws:dynamodb',
          awsRegion: 'us-east-1',
          dynamodb: {
            NewImage: {
              creativeDriveAssetId: { S: '595167' },
              status: { S: 'PENDING' },
            },
            SequenceNumber: '1',
            SizeBytes: 100,
            StreamViewType: 'NEW_IMAGE',
          },
        },
      ],
    };

    // Mock DynamoDB Get (asset record)
    mockDynamoSend
      .mockResolvedValueOnce({
        Item: {
          creativeDriveAssetId: '595167',
          status: 'PENDING',
          originalFilename: 'test-image.tif',
          filesize: 3570356,
          extension: 'tif',
          sourceUrl: 'https://cdn.example.com/assets/test.tif',
          publicUrl: 'https://cdn.example.com/assets/test.tif',
          metadata: {
            style_number: 'ST123',
            color_code: 'CC123',
          },
        },
      })
      .mockResolvedValueOnce({}); // UpdateCommand (UPLOADED)

    // Mock axios download from CreativeDrive
    mockAxiosGet.mockResolvedValueOnce({
      data: Buffer.from('test data'),
      headers: { 'content-type': 'image/tiff' },
    });

    // Mock Bynder OAuth token
    mockAxiosPost.mockResolvedValueOnce({
      data: { access_token: 'test-token', token_type: 'bearer', expires_in: 3600 },
    });

    // Mock Bynder get endpoint
    mockAxiosGet.mockResolvedValueOnce({
      data: 'https://s3.amazonaws.com/test-bucket',
    });

    // Mock Bynder init upload
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        multipart_params: { key: 'test-key', policy: 'test-policy' },
        s3file: { uploadid: 'test-upload-id', targetid: 'test-target-id' },
        s3_filename: 'pluploads/test-uuid/test-image.tif',
      },
    });

    // Mock S3 upload (chunk)
    mockAxiosPost.mockResolvedValueOnce({ status: 202, statusText: 'OK' });

    // Mock Bynder register chunk
    mockAxiosPost.mockResolvedValueOnce({ data: {} });

    // Mock Bynder finalize
    mockAxiosPost.mockResolvedValueOnce({ data: { importId: 'test-import-id' } });

    // Mock Bynder poll (success on first call)
    mockAxiosGet.mockResolvedValueOnce({
      data: { itemsDone: ['test-import-id'] },
    });

    // Mock Bynder get metaproperties
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        'property.brand': { id: 'ABC123', name: 'Brand' },
        'property.style_number': { id: 'STYLE001', name: 'Style_Number' },
        'property.color_code': { id: 'COLOR001', name: 'RLM_NRF_Color_Code' },
        'property.angle_code': { id: 'ANGLE001', name: 'Ecom_Angle_Code' },
        'property.angle_name': { id: 'ANGLENAME001', name: 'Angle_Name' },
        'property.date_created': { id: 'DATE001', name: 'Date_Created' },
        'property.ratio': { id: 'RATIO001', name: 'Ratio' },
        'property.model': { id: 'MODEL002', name: 'Model' },
        'property.model_exif': { id: 'MODEL001', name: 'Exif_Field_Model' },
        'property.exposure': { id: 'EXPOSURE001', name: 'Exposure_Time' },
        'property.fnumber': { id: 'FNUMBER001', name: 'F_Number' },
        'property.shutter': { id: 'SHUTTER001', name: 'Shutter_Speed' },
        'property.aperture': { id: 'APERTURE001', name: 'Aperture_Value' },
        'property.metering': { id: 'METERING001', name: 'Metering_Mode' },
        'property.season': { id: 'SEASON001', name: 'Season' },
        'property.year': { id: 'YEAR001', name: 'Year' },
        'property.asset_purpose': { id: 'ASSETPURPOSE001', name: 'Asset_Purpose' },
        'property.asset_subtype': { id: 'ASSETSUBTYPE001', name: 'Asset_Subtype' },
        'property.asset_type': { id: 'ASSETTYPE001', name: 'Asset_Type' },
        'property.program': { id: 'PROGRAM001', name: 'Program' },
      },
    });

    // Mock Bynder metaproperty options GET requests (for each field being mapped)
    // These are called by mapFieldToPayload for each metadata field
    // Order must match the order in bynder-client.ts mapFieldToPayload calls
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Style_Number
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // RLM_NRF_Color_Code
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Ecom_Angle_Code
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Angle_Name
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Date_Created (if date_created exists)
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Model
    mockAxiosGet.mockResolvedValueOnce({ data: [{ id: 'ratio-opt-1' }] }); // Ratio (26:35)
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Exif_Field_Model
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Exposure_Time
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // F_Number
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Shutter_Speed
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Aperture_Value
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Metering_Mode
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Asset_Purpose
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Asset_Subtype
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Asset_Type
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Program

    // Mock Bynder save media
    mockAxiosPost.mockResolvedValueOnce({
      data: { mediaid: 'bynder-12345' },
    });

    const result = await handler(mockEvent, {} as any, {} as any);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      message: 'Batch processing complete',
      succeeded: 1,
      failed: 0,
    });

    // Verify DynamoDB was called (Get + Update)
    expect(mockDynamoSend).toHaveBeenCalledTimes(2);
  });

  it('should update existing Bynder asset when filename matches', async () => {
    const mockEvent: DynamoDBStreamEvent = {
      Records: [
        {
          eventID: '1',
          eventName: 'INSERT',
          eventVersion: '1.0',
          eventSource: 'aws:dynamodb',
          awsRegion: 'us-east-1',
          dynamodb: {
            NewImage: {
              creativeDriveAssetId: { S: '595167' },
              status: { S: 'PENDING' },
            },
            SequenceNumber: '1',
            SizeBytes: 100,
            StreamViewType: 'NEW_IMAGE',
          },
        },
      ],
    };

    mockDynamoSend
      .mockResolvedValueOnce({
        Item: {
          creativeDriveAssetId: '595167',
          status: 'PENDING',
          originalFilename: 'test-image.tif',
          filesize: 3570356,
          extension: 'tif',
          sourceUrl: 'https://cdn.example.com/assets/test.tif',
          publicUrl: 'https://cdn.example.com/assets/test.tif',
          metadata: {
            style_number: 'ST123',
            color_code: 'CC123',
          },
        },
      })
      .mockResolvedValueOnce({}); // UpdateCommand (UPLOADED)

    // Bynder OAuth token
    mockAxiosPost.mockResolvedValueOnce({
      data: { access_token: 'test-token', token_type: 'bearer', expires_in: 3600 },
    });

    // Existing media search result
    mockAxiosGet.mockResolvedValueOnce({
      data: [{ id: 'existing-bynder-id' }],
    });

    // Mock axios download from CreativeDrive
    mockAxiosGet.mockResolvedValueOnce({
      data: Buffer.from('test data'),
      headers: { 'content-type': 'image/tiff' },
    });

    // Mock Bynder get endpoint
    mockAxiosGet.mockResolvedValueOnce({
      data: 'https://s3.amazonaws.com/test-bucket',
    });

    // Mock Bynder init upload
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        multipart_params: { key: 'test-key', policy: 'test-policy' },
        s3file: { uploadid: 'test-upload-id', targetid: 'test-target-id' },
        s3_filename: 'pluploads/test-uuid/test-image.tif',
      },
    });

    // Mock S3 upload (chunk)
    mockAxiosPost.mockResolvedValueOnce({ status: 202, statusText: 'OK' });

    // Mock Bynder register chunk
    mockAxiosPost.mockResolvedValueOnce({ data: {} });

    // Mock Bynder finalize
    mockAxiosPost.mockResolvedValueOnce({ data: { importId: 'test-import-id' } });

    // Mock Bynder poll (success)
    mockAxiosGet.mockResolvedValueOnce({
      data: { itemsDone: ['test-import-id'] },
    });

    // Mock Bynder get metaproperties
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        'property.brand': { id: 'ABC123', name: 'Brand' },
        'property.style_number': { id: 'STYLE001', name: 'Style_Number' },
        'property.color_code': { id: 'COLOR001', name: 'RLM_NRF_Color_Code' },
        'property.angle_code': { id: 'ANGLE001', name: 'Ecom_Angle_Code' },
        'property.angle_name': { id: 'ANGLENAME001', name: 'Angle_Name' },
        'property.date_created': { id: 'DATE001', name: 'Date_Created' },
        'property.ratio': { id: 'RATIO001', name: 'Ratio' },
        'property.model': { id: 'MODEL002', name: 'Model' },
        'property.model_exif': { id: 'MODEL001', name: 'Exif_Field_Model' },
        'property.exposure': { id: 'EXPOSURE001', name: 'Exposure_Time' },
        'property.fnumber': { id: 'FNUMBER001', name: 'F_Number' },
        'property.shutter': { id: 'SHUTTER001', name: 'Shutter_Speed' },
        'property.aperture': { id: 'APERTURE001', name: 'Aperture_Value' },
        'property.metering': { id: 'METERING001', name: 'Metering_Mode' },
        'property.season': { id: 'SEASON001', name: 'Season' },
        'property.year': { id: 'YEAR001', name: 'Year' },
        'property.asset_purpose': { id: 'ASSETPURPOSE001', name: 'Asset_Purpose' },
        'property.asset_subtype': { id: 'ASSETSUBTYPE001', name: 'Asset_Subtype' },
        'property.asset_type': { id: 'ASSETTYPE001', name: 'Asset_Type' },
        'property.program': { id: 'PROGRAM001', name: 'Program' },
      },
    });

    // Mock Bynder metaproperty options GET requests (match upload flow)
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Style_Number
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // RLM_NRF_Color_Code
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Ecom_Angle_Code
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Angle_Name
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Date_Created
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Model
    mockAxiosGet.mockResolvedValueOnce({ data: [{ id: 'ratio-opt-1' }] }); // Ratio
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Exif_Field_Model
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Exposure_Time
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // F_Number
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Shutter_Speed
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Aperture_Value
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Metering_Mode
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Asset_Purpose
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Asset_Subtype
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Asset_Type
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Program

    // Mock Bynder save media (new version)
    mockAxiosPost.mockResolvedValueOnce({
      data: { mediaid: 'existing-bynder-id' },
    });

    const result = await handler(mockEvent, {} as any, {} as any);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      message: 'Batch processing complete',
      succeeded: 1,
      failed: 0,
    });
    expect(mockDynamoSend).toHaveBeenCalledTimes(2); // Get + Update
  });

  it('should handle processing errors and update status to FAILED', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: [] });
    const mockEvent: DynamoDBStreamEvent = {
      Records: [
        {
          eventID: '1',
          eventName: 'INSERT',
          eventVersion: '1.0',
          eventSource: 'aws:dynamodb',
          awsRegion: 'us-east-1',
          dynamodb: {
            NewImage: {
              creativeDriveAssetId: { S: '595167' },
              status: { S: 'PENDING' },
            },
            SequenceNumber: '1',
            SizeBytes: 100,
            StreamViewType: 'NEW_IMAGE',
          },
        },
      ],
    };

    // Mock DynamoDB Get (asset record)
    mockDynamoSend
      .mockResolvedValueOnce({
        Item: {
          creativeDriveAssetId: '595167',
          status: 'PENDING',
          originalFilename: 'test-image.tif',
          filesize: 3570356,
          sourceUrl: 'https://cdn.example.com/assets/test.tif',
          publicUrl: 'https://cdn.example.com/assets/test.tif',
        },
      })
      .mockResolvedValueOnce({}); // UpdateCommand (FAILED)

    // Mock axios download failure
    mockAxiosGet.mockRejectedValueOnce(new Error('Download failed'));

    const result = await handler(mockEvent, {} as any, {} as any);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      message: 'Batch processing complete',
      succeeded: 0,
      failed: 1,
    });

    // Verify status was updated to FAILED
    expect(mockDynamoSend).toHaveBeenCalledTimes(2); // Get + Failed Update
  });

  it('should skip already processed assets', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: [] });
    const mockEvent: DynamoDBStreamEvent = {
      Records: [
        {
          eventID: '1',
          eventName: 'MODIFY',
          eventVersion: '1.0',
          eventSource: 'aws:dynamodb',
          awsRegion: 'us-east-1',
          dynamodb: {
            NewImage: {
              creativeDriveAssetId: { S: '595167' },
              status: { S: 'UPLOADED' },
            },
            SequenceNumber: '1',
            SizeBytes: 100,
            StreamViewType: 'NEW_IMAGE',
          },
        },
      ],
    };

    // Mock DynamoDB Get (already uploaded asset)
    mockDynamoSend.mockResolvedValueOnce({
      Item: {
        creativeDriveAssetId: '595167',
        status: 'UPLOADED',
        originalFilename: 'test-image.tif',
        bynderId: 'bynder-123',
      },
    });

    const result = await handler(mockEvent, {} as any, {} as any);

    expect(result.statusCode).toBe(200);

    // Verify no updates were made (only the Get call)
    expect(mockDynamoSend).toHaveBeenCalledTimes(1);
  });

  it('should use correct chunk filename format when registering chunks', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: [] });
    const mockEvent: DynamoDBStreamEvent = {
      Records: [
        {
          eventID: '1',
          eventName: 'INSERT',
          eventVersion: '1.0',
          eventSource: 'aws:dynamodb',
          awsRegion: 'us-east-1',
          dynamodb: {
            NewImage: {
              creativeDriveAssetId: { S: '595167' },
              status: { S: 'PENDING' },
            },
            SequenceNumber: '1',
            SizeBytes: 100,
            StreamViewType: 'NEW_IMAGE',
          },
        },
      ],
    };

    // Mock DynamoDB Get (asset record)
    mockDynamoSend
      .mockResolvedValueOnce({
        Item: {
          creativeDriveAssetId: '595167',
          status: 'PENDING',
          originalFilename: 'test-image.tif',
          filesize: 3570356,
          extension: 'tif',
          sourceUrl: 'https://cdn.example.com/assets/test.tif',
          publicUrl: 'https://cdn.example.com/assets/test.tif',
          metadata: {
            style_number: 'ST123',
            color_code: 'CC123',
          },
        },
      })
      .mockResolvedValueOnce({}); // UpdateCommand (UPLOADED)

    // Mock axios download from CreativeDrive
    mockAxiosGet.mockResolvedValueOnce({
      data: Buffer.from('test data'),
      headers: { 'content-type': 'image/tiff' },
    });

    // Mock Bynder OAuth token
    mockAxiosPost.mockResolvedValueOnce({
      data: { access_token: 'test-token', token_type: 'bearer', expires_in: 3600 },
    });

    // Mock Bynder get endpoint
    mockAxiosGet.mockResolvedValueOnce({
      data: 'https://s3.amazonaws.com/test-bucket',
    });

    // Mock Bynder init upload
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        multipart_params: { key: 'test-key', policy: 'test-policy' },
        s3file: { uploadid: 'test-upload-id', targetid: 'test-target-id' },
        s3_filename: 'pluploads/test-uuid/test-image.tif',
      },
    });

    // Mock S3 upload (chunk)
    mockAxiosPost.mockResolvedValueOnce({ status: 202, statusText: 'OK' });
    // Mock S3 upload (chunk)
    mockAxiosPost.mockResolvedValueOnce({ status: 202, statusText: 'OK' });

    // Mock Bynder finalize
    mockAxiosPost.mockResolvedValueOnce({ data: { importId: 'test-import-id' } });

    // Mock Bynder poll (success on first call)
    mockAxiosGet.mockResolvedValueOnce({
      data: { itemsDone: ['test-import-id'] },
    });

    // Mock Bynder get metaproperties
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        'property.brand': { id: 'ABC123', name: 'Brand' },
        'property.style_number': { id: 'STYLE001', name: 'Style_Number' },
        'property.color_code': { id: 'COLOR001', name: 'RLM_NRF_Color_Code' },
        'property.angle_code': { id: 'ANGLE001', name: 'Ecom_Angle_Code' },
        'property.angle_name': { id: 'ANGLENAME001', name: 'Angle_Name' },
        'property.date_created': { id: 'DATE001', name: 'Date_Created' },
        'property.ratio': { id: 'RATIO001', name: 'Ratio' },
        'property.model': { id: 'MODEL001', name: 'Exif_Field_Model' },
        'property.exposure': { id: 'EXPOSURE001', name: 'Exposure_Time' },
        'property.fnumber': { id: 'FNUMBER001', name: 'F_Number' },
        'property.shutter': { id: 'SHUTTER001', name: 'Shutter_Speed' },
        'property.aperture': { id: 'APERTURE001', name: 'Aperture_Value' },
        'property.metering': { id: 'METERING001', name: 'Metering_Mode' },
        'property.season': { id: 'SEASON001', name: 'Season' },
        'property.year': { id: 'YEAR001', name: 'Year' },
      },
    });

    // Mock Bynder metaproperty options GET requests (for each field being mapped)
    // These are called by mapFieldToPayload for each metadata field
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Style_Number
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // RLM_NRF_Color_Code
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Ecom_Angle_Code
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Angle_Name
    mockAxiosGet.mockResolvedValueOnce({ data: [{ id: 'ratio-opt-1' }] }); // Ratio (26:35)
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Exif_Field_Model
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Exposure_Time
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // F_Number
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Shutter_Speed
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Aperture_Value
    mockAxiosGet.mockResolvedValueOnce({ data: [] }); // Metering_Mode

    // Mock Bynder save media
    mockAxiosPost.mockResolvedValueOnce({
      data: { mediaid: 'bynder-12345' },
    });

    await handler(mockEvent, {} as any, {} as any);

    const chunkRegistrationPayload = mockAxiosPost.mock.calls
      .map(([, data]) => data)
      .find(
        (data) =>
          data instanceof URLSearchParams && data.get('chunkNumber') !== null
      ) as URLSearchParams | undefined;

    if (!chunkRegistrationPayload) {
      throw new Error('Chunk registration payload was not captured');
    }
    // Verify the chunk registration payload uses the correct format (now sent as URLSearchParams)
    expect(chunkRegistrationPayload).toBeDefined();
    expect(chunkRegistrationPayload.get('targetid')).toBe('test-target-id');
    expect(chunkRegistrationPayload.get('filename')).toMatch(/\/p1$/); // Should be full path with /p1 appended
    expect(chunkRegistrationPayload.get('s3_filename')).toBe('pluploads/test-uuid/test-image.tif');
    expect(chunkRegistrationPayload.get('chunks')).toBe('1'); // Note: URLSearchParams stores as string
    expect(chunkRegistrationPayload.get('original_filename')).toBe('test-image.tif');
  });

  it('should handle 500 error from Bynder chunk registration', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: [] });
    const mockEvent: DynamoDBStreamEvent = {
      Records: [
        {
          eventID: '1',
          eventName: 'INSERT',
          eventVersion: '1.0',
          eventSource: 'aws:dynamodb',
          awsRegion: 'us-east-1',
          dynamodb: {
            NewImage: {
              creativeDriveAssetId: { S: '595167' },
              status: { S: 'PENDING' },
            },
            SequenceNumber: '1',
            SizeBytes: 100,
            StreamViewType: 'NEW_IMAGE',
          },
        },
      ],
    };

    // Mock DynamoDB Get (asset record)
    mockDynamoSend
      .mockResolvedValueOnce({
        Item: {
          creativeDriveAssetId: '595167',
          status: 'PENDING',
          originalFilename: 'test-image.tif',
          filesize: 3570356,
          extension: 'tif',
          sourceUrl: 'https://cdn.example.com/assets/test.tif',
          publicUrl: 'https://cdn.example.com/assets/test.tif',
          metadata: {
            style_number: 'ST123',
            color_code: 'CC123',
          },
        },
      })
      .mockResolvedValueOnce({}); // UpdateCommand (FAILED)

    // Mock axios download from CreativeDrive
    mockAxiosGet.mockResolvedValueOnce({
      data: Buffer.from('test data'),
      headers: { 'content-type': 'image/tiff' },
    });

    // Mock Bynder OAuth token
    mockAxiosPost.mockResolvedValueOnce({
      data: { access_token: 'test-token', token_type: 'bearer', expires_in: 3600 },
    });

    // Mock Bynder get endpoint
    mockAxiosGet.mockResolvedValueOnce({
      data: 'https://s3.amazonaws.com/test-bucket',
    });

    // Mock Bynder init upload
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        multipart_params: { key: 'test-key', policy: 'test-policy' },
        s3file: { uploadid: 'test-upload-id', targetid: 'test-target-id' },
        s3_filename: 'pluploads/test-uuid/test-image.tif',
      },
    });

    // Mock S3 upload (chunk) - succeeds
    mockAxiosPost.mockResolvedValueOnce({ data: {} });

    // Mock Bynder register chunk - return 500 error
    mockAxiosPost.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 500,
        data: { error: 'Internal Server Error' },
      },
      config: {
        url: 'https://test.bynder.com/api/v4/upload/',
        method: 'post',
        data: JSON.stringify({
          id: 'test-upload-id',
          targetid: 'test-target-id',
          filename: 'pluploads/test-uuid/test-image.tif/p1', // Old broken format
          chunkNumber: 1,
        }),
      },
    });

    const result = await handler(mockEvent, {} as any, {} as any);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      message: 'Batch processing complete',
      succeeded: 0,
      failed: 1,
    });

    // Verify status was updated to FAILED
    expect(mockDynamoSend).toHaveBeenCalledTimes(2); // Get + Failed Update
  });
});
