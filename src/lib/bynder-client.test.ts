import { BynderClient } from './bynder-client';

describe('BynderClient', () => {
  let client: BynderClient;

  beforeEach(() => {
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
});
