import { BynderClient } from './bynder-client';
import axios from 'axios';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('BynderClient', () => {
  let client: BynderClient;

  beforeEach(() => {
    jest.resetAllMocks();

    // Create client with mock credentials (won't make real API calls in these tests)
    client = new BynderClient({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      accessTokenUrl: 'https://test.bynder.com/oauth/token',
      apiBaseUrl: 'https://test.bynder.com',
    });
  });

  describe('extractMetadataFromFilename', () => {
    it('should extract style number and color code from standard filename', () => {
      const result = client.extractMetadataFromFilename('STYLE123-456.tif');
      
      expect(result.styleNumber).toBe('STYLE123');
      expect(result.colorCode).toBe('456');
      // No underscore, so angleCode is empty
      expect(result.angleCode).toBe('');
    });

    it('should extract style number, color code, and angle code with underscore separator', () => {
      const result = client.extractMetadataFromFilename('STYLE123-456_FRONT.tif');
      
      expect(result.styleNumber).toBe('STYLE123');
      expect(result.colorCode).toBe('456');
      expect(result.angleCode).toBe('FRONT');
    });

    it('should handle filenames with multiple dashes', () => {
      const result = client.extractMetadataFromFilename('STYLE-123-456.jpg');
      
      expect(result.styleNumber).toBe('STYLE-123');
      expect(result.colorCode).toBe('456');
      // No underscore, so angleCode is empty
      expect(result.angleCode).toBe('');
    });

    it('should handle filenames with multiple dashes and underscore', () => {
      const result = client.extractMetadataFromFilename('STYLE-123-456_A01.png');
      
      expect(result.styleNumber).toBe('STYLE-123');
      expect(result.colorCode).toBe('456');
      expect(result.angleCode).toBe('A01');
    });

    it('should return empty strings when no dash is present', () => {
      const result = client.extractMetadataFromFilename('filename.tif');
      
      expect(result.styleNumber).toBe('');
      expect(result.colorCode).toBe('');
      expect(result.angleCode).toBe('');
    });

    it('should handle filenames without extension', () => {
      const result = client.extractMetadataFromFilename('STYLE123-456');
      
      expect(result.styleNumber).toBe('STYLE123');
      // Without extension, colorCode goes to end of string
      expect(result.colorCode).toBe('456');
      // No underscore and no extension, so angleCode is empty
      expect(result.angleCode).toBe('');
    });

    it('should handle complex real-world filename patterns', () => {
      const result = client.extractMetadataFromFilename('710948949-001_4.tif');
      
      expect(result.styleNumber).toBe('710948949');
      expect(result.colorCode).toBe('001');
      expect(result.angleCode).toBe('4');
    });

    it('should handle filename with long style number', () => {
      const result = client.extractMetadataFromFilename('ABC123DEF456-789.tif');
      
      expect(result.styleNumber).toBe('ABC123DEF456');
      expect(result.colorCode).toBe('789');
      // No underscore, so angleCode is empty
      expect(result.angleCode).toBe('');
    });

    it('should handle filename ending with dash', () => {
      const result = client.extractMetadataFromFilename('STYLE-.tif');
      
      expect(result.styleNumber).toBe('STYLE');
      expect(result.colorCode).toBe('');
      expect(result.angleCode).toBe('');
    });
  });

  describe('findMedia', () => {
    it('selects candidates by originalFilename when provided', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { access_token: 'test-token', token_type: 'bearer', expires_in: 3600 },
      });
      mockedAxios.get
        .mockResolvedValueOnce({
          data: {
            'property.style_number': { id: 'STYLE001', name: 'Style_Number' },
            'property.color_code': { id: 'COLOR001', name: 'RLM_NRF_Color_Code' },
            'property.angle_code': { id: 'ANGLE001', name: 'Ecom_Angle_Code' },
          },
        })
        .mockResolvedValueOnce({
          data: {
            media: [
              {
                id: 'wrong-id',
                name: 'Wrong display name',
                originalFilename: 'ST123-CC123_SIDE.tif',
                metaproperty: {
                  COLOR001: 'CC123',
                  ANGLE001: 'FRONT',
                },
              },
              {
                id: 'right-id',
                name: 'ST123-CC123_FRONT.tif',
              },
            ],
          },
        });

      const result = await client.findMedia(
        'ST123',
        'CC123',
        'FRONT',
        jest.fn(),
        { originalFilename: 'ST123-CC123_FRONT.tif' }
      );

      expect(result).toBe('right-id');
      expect(mockedAxios.get).toHaveBeenLastCalledWith(
        'https://test.bynder.com/api/v4/media/',
        expect.objectContaining({
          params: {
            property_Style_Number: 'ST123',
            limit: 200,
          },
        })
      );
    });

    it('falls back to color and angle matching when originalFilename is not provided', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { access_token: 'test-token', token_type: 'bearer', expires_in: 3600 },
      });
      mockedAxios.get
        .mockResolvedValueOnce({
          data: {
            'property.style_number': { id: 'STYLE001', name: 'Style_Number' },
            'property.color_code': { id: 'COLOR001', name: 'RLM_NRF_Color_Code' },
            'property.angle_code': { id: 'ANGLE001', name: 'Ecom_Angle_Code' },
          },
        })
        .mockResolvedValueOnce({
          data: {
            media: [
              {
                id: 'matched-id',
                metaproperty: {
                  COLOR001: '123',
                  ANGLE001: 'FRONT',
                },
              },
            ],
          },
        });

      const result = await client.findMedia('ST123', '0123', 'FRONT', jest.fn());

      expect(result).toBe('matched-id');
    });
  });

  describe('getAdditionalFileCount', () => {
    it('counts mediaItems with type additional', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { access_token: 'token', token_type: 'Bearer', expires_in: 3600 },
      });
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          mediaItems: [
            { type: 'original', fileName: 'asset.tif' },
            { type: 'additional', fileName: 'asset.tif' },
            { type: 'web', fileName: 'preview.jpg' },
          ],
        },
      });

      const count = await client.getAdditionalFileCount('media-123');

      expect(count).toBe(1);
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://test.bynder.com/api/v4/media/media-123/',
        expect.objectContaining({ params: { versions: true } })
      );
    });

    it('returns 0 when mediaItems is missing', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { access_token: 'token', token_type: 'Bearer', expires_in: 3600 },
      });
      mockedAxios.get.mockResolvedValueOnce({ data: {} });

      const count = await client.getAdditionalFileCount('media-123');

      expect(count).toBe(0);
    });
  });
});
