/**
 * CreativeDrive API Client
 *
 * Handles all interactions with the CreativeDrive API including:
 * - Asset metadata fetching
 * - Asset downloading
 * - Division and folder management
 * - Asset search with pagination
 */

import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { DateRange } from './utils/dateUtils';

const CREATIVE_DRIVE_BASE_URL = 'https://sandbox-share-api.creativedrive.com/api/v1';

export interface CreativeDriveCredentials {
  apiKey: string;
}

export interface CreativeDriveAsset {
  id: string;
  originalFilename: string;
  filesize: number;
  extension: string;
  publicUrl: string;
}

export interface Options {
  limit?: number;
  offset?: number;
}
export interface SearchParams {
  divisions: number[];
  folderId: string;
  dateRange: DateRange;
  query?: string;
  options: Options;
  fetchSort?: string;
}

export interface Division {
  type: string;
  attributes: {
    id: string;
    name: string;
    storage: string;
    totalFolders: number;
  };
}

export interface Folder {
  type: string;
  attributes: {
    id: string;
    name: string;
    parent_id: string | null;
    division_id: string;
  };
}

export interface AssetMetadata {
  type: string;
  attributes: {
    id: string;
    attribute_id: string;
    name: string;
    value: string;
  };
}

export interface AssetWithPublicUrl {
  type: string;
  attributes: {
    id: string;
    original_filename: string;
    original_filesize: number;
    extension: string;
    folder_id: string;
    division_id: string;
    meta: {
      image_origin: string;
      [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

export interface SearchAssetsResult {
  assets: AssetWithPublicUrl[];
  total: number;
}

export class CreativeDriveClient {
  private credentials: CreativeDriveCredentials;
  private maxRetries: number = 3;
  private retryDelayMs: number = 1000;

  constructor(
    credentials: CreativeDriveCredentials,
    options: { maxRetries?: number; retryDelayMs?: number } = {}
  ) {
    this.credentials = credentials;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
  }

  /**
   * Helper function to make axios requests with retry logic and detailed error logging
   */
  private async makeRequest<T>(
    method: 'get' | 'post',
    url: string,
    config: AxiosRequestConfig,
    data?: any // eslint-disable-line @typescript-eslint/no-explicit-any
  ): Promise<T> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response =
          method === 'get' ? await axios.get(url, config) : await axios.post(url, data, config);
        return response.data;
      } catch (error) {
        const isLastAttempt = attempt === this.maxRetries;
        const axiosError = error as AxiosError;

        // Log detailed error information
        const errorDetails = {
          attempt,
          maxRetries: this.maxRetries,
          method: method.toUpperCase(),
          url,
          status: axiosError.response?.status,
          statusText: axiosError.response?.statusText,
          responseData: axiosError.response?.data,
          message: axiosError.message,
        };

        console.error('CreativeDrive API request failed:', errorDetails);

        // Don't retry on 4xx errors (client errors) - only retry on 5xx (server errors) and network issues
        const shouldRetry =
          !isLastAttempt &&
          (!axiosError.response ||
            (axiosError.response.status >= 500 && axiosError.response.status < 600));

        if (!shouldRetry) {
          throw new Error(
            `CreativeDrive API request failed after ${attempt} attempt(s): ${method.toUpperCase()} ${url} - Status: ${axiosError.response?.status || 'Network Error'} - ${axiosError.message}`
          );
        }

        // Wait before retrying (exponential backoff)
        const delay = this.retryDelayMs * Math.pow(2, attempt - 1);
        console.log(`Retrying in ${delay}ms... (attempt ${attempt + 1}/${this.maxRetries})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new Error(`Failed to make request after ${this.maxRetries} attempts`);
  }

  /**
   * Fetch asset metadata from CreativeDrive
   */
  async getAsset(assetId: string): Promise<CreativeDriveAsset> {
    const response = await this.makeRequest<any>(
      'get',
      `${CREATIVE_DRIVE_BASE_URL}/assets/${assetId}/metadatas`,
      { headers: { 'X-API-KEY': this.credentials.apiKey } }
    );

    const asset = response.data || response;

    return {
      id: asset.id,
      originalFilename: asset.original_filename || asset.filename,
      filesize: asset.filesize,
      extension: asset.extension,
      publicUrl: asset.public_url,
    };
  }

  /**
   * Download asset file from CreativeDrive
   */
  async downloadAsset(publicUrl: string): Promise<Buffer> {
    const response = await axios.get(publicUrl, {
      responseType: 'arraybuffer',
    });

    return Buffer.from(response.data);
  }

  /**
   * Fetch all divisions
   */
  async getDivisions(): Promise<Division[]> {
    const response = await this.makeRequest<{ data: Division[] }>(
      'get',
      `${CREATIVE_DRIVE_BASE_URL}/divisions`,
      { headers: { Authorization: this.credentials.apiKey } }
    );
    return response.data || [];
  }

  /**
   * Fetch root folders for a division
   */
  async getRootFolders(divisionId: string): Promise<Folder[]> {
    const response = await this.makeRequest<{ data: Folder[] }>(
      'post',
      `${CREATIVE_DRIVE_BASE_URL}/folders/_search`,
      { headers: { Authorization: this.credentials.apiKey } },
      { conditions: [`division_id = ${divisionId}`, 'parent_id IS NULL', 'active'] }
    );
    return response.data || [];
  }

  /**
   * Fetch subfolders for a parent folder
   */
  async getSubfolders(folderId: string): Promise<Folder[]> {
    const response = await this.makeRequest<{ data: Folder[] }>(
      'get',
      `${CREATIVE_DRIVE_BASE_URL}/folders/${folderId}/folders`,
      { headers: { Authorization: this.credentials.apiKey } }
    );
    return response.data || [];
  }

  /**
   * Fetch assets with public URLs from a folder (with pagination)
   */
  async searchAssets({ divisions = [], folderId = '', dateRange, query, options = {}, fetchSort = 'desc' }: SearchParams): Promise<SearchAssetsResult> {
    const { limit = 50, offset = 0 } = options;

    const payload: any = {
      limit,
      offset,
      divisions,
      filters: [
        {
          _att_created: {
            values: [`${dateRange.start}, ${dateRange.end}`],
            global: false
          }
        }
      ],
      sort_order: fetchSort
    };

    // Only include query if provided
    if (query) {
      payload.query = query;
    }

    // Only include parent_folder if folderId is provided and valid
    if (folderId && folderId.trim() !== '') {
      const parsedFolderId = parseInt(folderId, 10);
      if (!isNaN(parsedFolderId)) {
        payload.parent_folder = parsedFolderId;
      }
    }

    const response = await this.makeRequest<{
      data: AssetWithPublicUrl[];
      meta?: { total: number };
    }>(
      'post',
      `${CREATIVE_DRIVE_BASE_URL}/search`,
      { headers: { Authorization: this.credentials.apiKey } },
      payload
    );

    return {
      assets: response.data || [],
      total: response.meta?.total || 0,
    };
  }

  /**
   * Fetch a single asset by its numeric ID (returns asset attributes including original_filename).
   */
  async getAssetById(assetId: string): Promise<AssetWithPublicUrl> {
    const response = await this.makeRequest<{ data: AssetWithPublicUrl }>(
      'get',
      `${CREATIVE_DRIVE_BASE_URL}/assets/${assetId}`,
      { headers: { Authorization: this.credentials.apiKey } }
    );
    return response.data;
  }

  /**
   * Fetch metadata for an asset
   */
  async getAssetMetadata(assetId: string): Promise<AssetMetadata[]> {
    const response = await this.makeRequest<{ data: AssetMetadata[] }>(
      'get',
      `${CREATIVE_DRIVE_BASE_URL}/assets/${assetId}/metadatas`,
      { headers: { Authorization: this.credentials.apiKey } }
    );
    return response.data || [];
  }

}
