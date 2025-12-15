/**
 * Bynder API Client
 *
 * Handles all interactions with the Bynder API including:
 * - OAuth authentication
 * - File upload (chunked)
 * - Media management
 */

import axios from 'axios';
import FormData from 'form-data';

export interface BynderCredentials {
  clientId: string;
  clientSecret: string;
  accessTokenUrl: string;
  apiBaseUrl: string;
}

interface BynderTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface BynderUploadInitResponse {
  s3file: {
    uploadid: string;
    targetid: string;
  };
  s3_filename: string;
  target_key: string;
  multipart_params: Record<string, string>;
}

interface BynderPollResponse {
  itemsDone?: string[];
  itemsFailed?: string[];
}
// 1. Define the core structure of the inner object (what's inside the dynamic key)
export interface BynderMetaproperty {
  name: string;
  id: string;
  [key: string]: any;
}

interface BynderMetapropertiesResponse {
  [fieldName: string]: BynderMetaproperty;
}

export class BynderClient {
  private credentials: BynderCredentials;
  private accessToken: string | null = null;
  private metaproperties: Map<string, string> = new Map<string, string>();

  constructor(credentials: BynderCredentials) {
    this.credentials = credentials;
  }

  /**
   * Get OAuth access token
   */
  async getAccessToken(): Promise<string> {
    if (this.accessToken) {
      return this.accessToken;
    }

    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', this.credentials.clientId);
    params.append('client_secret', this.credentials.clientSecret);

    const response = await axios.post<BynderTokenResponse>(
      this.credentials.accessTokenUrl,
      params,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    this.accessToken = response.data.access_token;
    return this.accessToken;
  }

  mapFieldToPayload(payload: Record<string, any>, cdFieldValue: string, bynderFieldName: string) {

    const bynderPropertyId: string | undefined = this.metaproperties.get(bynderFieldName);
    if (!bynderPropertyId) {
      throw new Error(`Bynder metaproperty ID not found for field: ${bynderFieldName}`);
    }
    if (cdFieldValue) {
      payload[`metaproperty.${bynderPropertyId.toString()}`] = cdFieldValue || ''
    }
  }

  private buildMetapropertiesPayload(assetMetadata: Record<string, string>): Record<string, string> {
    const metapropertiesPayload: Record<string, string> = {};

    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['style_number'] || '', 'Style_Number');
    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['color_code'] || '', 'RLM_NRF_Color_Code');
    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['angle_code'] || '', 'Ecom_Angle_Code');
    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['angle_name'] || '', 'Angle_Name');

    if (assetMetadata['date_shot'] || assetMetadata['date_asset_delivered'] ||assetMetadata['system_uploaded']) {
      const dateShot = assetMetadata['date_shot'] || assetMetadata['date_asset_delivered'] || assetMetadata['system_uploaded'];
      const dateShotParts = dateShot.split(' ');
      const dateShotDate = dateShotParts[0];
      const dateShotTime = dateShotParts[1];
      this.mapFieldToPayload(metapropertiesPayload, `${dateShotDate}T${dateShotTime}Z`, 'Date_Created');
    }

    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['asset_type'] || '', 'Shot_Type');
    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['setlist_name'] || '', 'Shotlist');
    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['photographer'] || '', 'Photographer');
    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['model_name'] || '', 'Model');
    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['stylist'] || '', 'Stylist');
    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['department'] || '', 'Art_Director');
    
    if (assetMetadata['system_dimensions']) {
      const dimensions = assetMetadata['system_dimensions'].split('x');
      this.mapFieldToPayload(metapropertiesPayload, dimensions[0].trim() || '', 'Image_Width');
      this.mapFieldToPayload(metapropertiesPayload, dimensions[1].trim() || '', 'Image_Height');
    }

    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['hair_makeup'] || '', 'Hair_Makeup');
    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['shoot_name'] || '', 'Location');
    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['digital_tech'] || '', 'Digital_Tech');
    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['photographer_assistant'] || '', 'Photographer_Assistant');
    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['stylist_assistant'] || '', 'Stylist_Assistant');

    this.mapFieldToPayload(metapropertiesPayload, '26:35', 'Ratio');
    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['model'] || '', 'Exif_Field_Model');
    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['exposure_time'] || '', 'Exposure_Time');
    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['f_number'] || '', 'F_Number');
    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['shutter_speed_value'] || '', 'Shutter_Speed');
    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['aperture_value'] || '', 'Aperture_Value');
    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['max_aperture_value'] || '', 'Max_Aperture_Value');
    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['metering_mode'] || '', 'Metering_Mode');

    if (assetMetadata['month']) {
      let monthValue = assetMetadata['month'].substring(0, 2);
      const yearValue = '20' + assetMetadata['month'].substring(2, 4);
      if (monthValue === 'RE') {
        monthValue = 'RE Resort';
      } else if (monthValue === 'SP') {
        monthValue = 'SP Spring';
      } else if (monthValue === 'TR') {
        monthValue = 'TR Trans';
      } else if (monthValue === 'FA') {
        monthValue = 'FA Fall';
      }
      this.mapFieldToPayload(metapropertiesPayload, monthValue, 'Season');
      this.mapFieldToPayload(metapropertiesPayload, yearValue, 'Year');
    }

    this.mapFieldToPayload(metapropertiesPayload, 'Ecom', 'Asset_Purpose');
    this.mapFieldToPayload(metapropertiesPayload, 'Product Image', 'Asset_Subtype');
    this.mapFieldToPayload(metapropertiesPayload, 'Image', 'Asset_Type');
    this.mapFieldToPayload(metapropertiesPayload, 'Ecom PDP', 'Program');

    // If SHARE metaproperty UPLOADED is <12/14/2022 the ASSET STATUS Bynder metaproperty should be "Archived"
    if (assetMetadata['system_uploaded']) {
     const normalized_system_uploaded_date = assetMetadata['system_uploaded'].replace(/:/g, '-');
      
      const normalized_system_uploaded_date_ts = new Date(normalized_system_uploaded_date);
      const archiveDatePeriod = new Date('2022-12-14'); //ArchiveDate timeperiod
      if (normalized_system_uploaded_date_ts.getTime() < archiveDatePeriod.getTime()) {
        this.mapFieldToPayload(metapropertiesPayload, 'Archived', 'Asset_Status');
      } else {
        this.mapFieldToPayload(metapropertiesPayload, 'In Progress', 'Asset_Status');
      }

    } else {
      this.mapFieldToPayload(metapropertiesPayload, 'In Progress', 'Asset_Status');
    }

    

    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['model_name'] || '', 'Recognized_Faces');

    const indexedProductString = assetMetadata['style_number'] + '-' + assetMetadata['color_code'];
    this.mapFieldToPayload(metapropertiesPayload, indexedProductString, 'Style_Number_RLM_Code');

    return metapropertiesPayload;
  }

  private async ensureMetapropertiesLoaded(authHeader: Record<string, string>): Promise<void> {
    if (this.metaproperties.size > 0) {
      return;
    }

    const metapropertiesResponse = await axios.get<BynderMetapropertiesResponse>(
      `${this.credentials.apiBaseUrl}/api/v4/metaproperties?options=0`,
      { headers: authHeader }
    );

    for (const fieldKey in metapropertiesResponse.data) {
      if (Object.prototype.hasOwnProperty.call(metapropertiesResponse.data, fieldKey)) {
        const field: BynderMetaproperty = metapropertiesResponse.data[fieldKey];
        this.metaproperties.set(field.name, field.id);
      }
    }
  }

  /**
   * Upload file to Bynder
   */
  async uploadFile(
    buffer: Buffer,
    filename: string,
    assetMetadata: Record<string, string>,
    options: {
      chunkSize?: number;
      onProgress?: (progress: { current: number; total: number; percentage: number }) => void;
      mediaId?: string;
    } = {}
  ): Promise<string> {
    const { chunkSize = 1024 * 1024 * 5, onProgress, mediaId } = options;

    const accessToken = await this.getAccessToken();
    const authHeader = { Authorization: `Bearer ${accessToken}` };

    // Step 1: Get S3 upload endpoint
    const endpointResponse = await axios.get(`${this.credentials.apiBaseUrl}/api/upload/endpoint`, {
      headers: authHeader,
    });
    const s3Endpoint = endpointResponse.data;

    // Step 2: Initialize upload
    const initResponse = await axios.post<BynderUploadInitResponse>(
      `${this.credentials.apiBaseUrl}/api/upload/init`,
      { filename },
      {
        headers: {
          ...authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    const uploadData = initResponse.data;

    // Step 3: Upload file in chunks
    const totalChunks = Math.ceil(buffer.length / chunkSize);
    const uploadedChunks: string[] = [];

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, buffer.length);
      const chunk = buffer.subarray(start, end);
      const partNumber = i + 1;

      const Filename = uploadData.multipart_params['key'] + '/p' + partNumber;

      // Upload chunk to S3
      const formData = new FormData();
      Object.entries(uploadData.multipart_params).forEach(([key, value]) => {
        if (key === 'key') {
          value = Filename;
        }
        formData.append(key, value);
      });
      formData.append('Filename', Filename);
      formData.append('name', filename);
      formData.append('chunk', partNumber);
      formData.append('chunks', totalChunks);
      formData.append('file', chunk);

      const s3UploadResponse = await axios.post(s3Endpoint, formData, {
        headers: formData.getHeaders(),
      });

      console.log(`S3 upload response for chunk ${partNumber}:`, {
        status: s3UploadResponse.status,
        statusText: s3UploadResponse.statusText,
      });

      if (s3UploadResponse.status < 200 || s3UploadResponse.status >= 300) {
        throw new Error(`S3 upload failed: ${s3UploadResponse.statusText}`);
      }

      // Delay to ensure S3 upload is fully processed before registering
      // Larger files may need more time for S3 to process
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Register chunk with Bynder (with retry logic)
      const chunkData = new URLSearchParams({
        targetid: uploadData.s3file.targetid,
        filename: Filename, // S3 path with part number (matches S3 upload)
        s3_filename: uploadData.s3_filename,
        chunks: totalChunks.toString(),
        chunkNumber: partNumber.toString(),
        original_filename: filename,
      });

      let retryCount = 0;
      const maxRetries = 5; // Increased retries for larger files

      while (retryCount < maxRetries) {
        try {
          await axios.post(
            `${this.credentials.apiBaseUrl}/api/v4/upload/${uploadData.s3file.uploadid}`,
            chunkData,
            {
              headers: {
                ...authHeader,
                'Content-Type': 'application/x-www-form-urlencoded',
              },
            }
          );
          break; // Success, exit retry loop
        } catch (error: unknown) {
          const axiosError = error as {
            response?: { status?: number; statusText?: string; data?: any };
          };
          if (
            axiosError.response?.data?.message === 'Upload not ready' &&
            retryCount < maxRetries - 1
          ) {
            retryCount++;
            const delay = 3000; // 3 seconds between retries
            console.log(
              `Chunk registration not ready, retrying in ${delay / 1000}s ` +
                `(attempt ${retryCount}/${maxRetries - 1})...`
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          // Not a retry-able error or max retries reached, log and throw
          if (axiosError.response) {
            console.error('Chunk registration failed:', {
              status: axiosError.response?.status,
              statusText: axiosError.response?.statusText,
              data: axiosError.response?.data,
              payload: {
                targetid: uploadData.s3file.targetid,
                filename: Filename,
                s3_filename: uploadData.s3_filename,
                chunks: totalChunks,
                original_filename: filename,
              },
            });
          }
          throw error;
        }
      }

      uploadedChunks.push(`p${partNumber}`);

      if (onProgress) {
        onProgress({
          current: partNumber,
          total: totalChunks,
          percentage: Math.round((partNumber / totalChunks) * 100),
        });
      }
    }

    // Step 4: Finalize upload
    const chunkData = new URLSearchParams({
      targetid: uploadData.s3file.targetid,
      s3_filename: uploadData.s3_filename,
      chunks: totalChunks.toString(),
      original_filename: filename,
    });

    const finalizeResponse = await axios.post(
      `${this.credentials.apiBaseUrl}/api/v4/upload/${uploadData.s3file.uploadid}`,
      chunkData,
      { headers: authHeader }
    );

    // Step 5: Poll for completion
    const importId = finalizeResponse.data.importId;
    let pollCount = 0;
    const maxPolls = 60;

    while (pollCount < maxPolls) {
      const pollResponse = await axios.get<BynderPollResponse>(
        `${this.credentials.apiBaseUrl}/api/v4/upload/poll/`,
        {
          params: { items: importId },
          headers: authHeader,
        }
      );

      if (pollResponse.data.itemsDone && pollResponse.data.itemsDone.length > 0) {
        break;
      }

      pollCount++;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (!importId) {
      throw new Error('Upload polling timeout - asset not processed');
    }

    // Step 6: Save media in Bynder
    await this.ensureMetapropertiesLoaded(authHeader);
    const metapropertiesPayload = this.buildMetapropertiesPayload(assetMetadata);

    const formData = new FormData();

    // 2. Append simple text fields (key-value pairs)
    // The key 'name_field' is the name the API expects for this parameter.
    formData.append('importId', importId);
    formData.append('name', filename);

    // If SHARE uploaded date is < 12/14/2022 mark ArchiveDate in Bynder as 12/15/2025
    if (assetMetadata['system_uploaded']) {
     const normalized_system_uploaded_date = assetMetadata['system_uploaded'].replace(/:/g, '-');
      
      const normalized_system_uploaded_date_ts = new Date(normalized_system_uploaded_date);
      const archiveDatePeriod = new Date('2022-12-14'); //ArchiveDate timeperiod
      if (normalized_system_uploaded_date_ts.getTime() < archiveDatePeriod.getTime()) {
        formData.append('archiveDate', '2025-12-15T00:00:00Z')
      }
    }

    for (const [key, value] of Object.entries(metapropertiesPayload)) {
      formData.append(key, value);
    }

    const saveEndpoint = mediaId
      ? `${this.credentials.apiBaseUrl}/api/v4/media/${mediaId}/save/${importId}`
      : `${this.credentials.apiBaseUrl}/api/v4/media/save/${importId}`;

    const saveResponse = await axios.post(saveEndpoint, formData, { headers: authHeader });

    if (saveResponse.status < 200 || saveResponse.status >= 300) {
      throw new Error('Failed to update Bynder asset metadata');
    }

    const bynderId = saveResponse.data.mediaid;

    if (!bynderId) {
      throw new Error('Failed to get Bynder asset ID from save response');
    }

    return bynderId;
  }

  async findMedia(styleNumber: string, colorCode: string, angleCode?: string): Promise<string | null> {
    const accessToken = await this.getAccessToken();
    const authHeader = { Authorization: `Bearer ${accessToken}` };

    const params: Record<string, string | number> = {
      property_Style_Number: styleNumber,
      property_RLM_NRF_Color_Code: colorCode,
      limit: 1,
    };

    if (angleCode) {
      params.property_Ecom_Angle_Code = angleCode;
    }

    const response = await axios.get(`${this.credentials.apiBaseUrl}/api/v4/media/`, {
      headers: authHeader,
      params,
    });

    const data = response.data;
    let candidates: any[] = [];
    if (Array.isArray(data)) {
      candidates = data;
    } else if (Array.isArray(data?.media)) {
      candidates = data.media;
    } else if (Array.isArray(data?.items)) {
      candidates = data.items;
    } else if (Array.isArray(data?.results)) {
      candidates = data.results;
    }

    const media = candidates[0];
    if (!media) {
      return null;
    }

    return media.id || null;
  }

  async updateMediaMetadata(mediaId: string, assetMetadata: Record<string, string>): Promise<void> {
    const accessToken = await this.getAccessToken();
    const authHeader = { Authorization: `Bearer ${accessToken}` };

    await this.ensureMetapropertiesLoaded(authHeader);
    const metapropertiesPayload = this.buildMetapropertiesPayload(assetMetadata);

    const formData = new FormData();
    formData.append('mediaid', mediaId);
    for (const [key, value] of Object.entries(metapropertiesPayload)) {
      formData.append(key, value);
    }

    await axios.post(
      `${this.credentials.apiBaseUrl}/api/v4/media/${mediaId}/`,
      formData,
      {
        headers: {
          ...authHeader,
          ...formData.getHeaders(),
        },
      }
    );
  }
}
