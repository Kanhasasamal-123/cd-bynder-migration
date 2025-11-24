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

  async mapFieldToPayload(payload: Record<string, any>, cdFieldValue: string, bynderFieldName: string): Promise<void> {

    const bynderPropertyId: string | undefined = this.metaproperties.get(bynderFieldName);
    if (!bynderPropertyId) {
      throw new Error(`Bynder metaproperty ID not found for field: ${bynderFieldName}`);
    }

    payload[`metaproperty.${bynderPropertyId.toString()}`] = cdFieldValue || ''
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
    } = {}
  ): Promise<string> {
    const { chunkSize = 1024 * 1024 * 5, onProgress } = options;

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
    if (this.metaproperties.size === 0) {
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

    // Build metaproperties payload
    const metapropertiesPayload: Record<string, string> = {};

    await this.mapFieldToPayload(metapropertiesPayload, assetMetadata['style_number'] || '', 'Style_Number');
    await this.mapFieldToPayload(metapropertiesPayload, assetMetadata['color_code'] || '', 'RLM_NRF_Color_Code');
    await this.mapFieldToPayload(metapropertiesPayload, assetMetadata['angle_code'] || '', 'Ecom_Angle_Code');
    await this.mapFieldToPayload(metapropertiesPayload, assetMetadata['angle_name'] || '', 'Angle_Name');
    if (assetMetadata['date_created'] || assetMetadata['date_shot']) {
      const datePart = assetMetadata['date_created'] || assetMetadata['date_shot'];
      const normalizedDatePart = datePart.replace(/:/g, '-');
      await this.mapFieldToPayload(metapropertiesPayload, `${normalizedDatePart}T00:00:00Z`, 'Date_Created');
    }
    // await this.mapFieldToPayload(metapropertiesPayload, assetMetadata[''] || '', 'Shotlist_Name_Setlist_Name');
    // await this.mapFieldToPayload(metapropertiesPayload, assetMetadata[''] || '', 'Photographer');
    // await this.mapFieldToPayload(metapropertiesPayload, assetMetadata[''] || '', 'Model');
    // await this.mapFieldToPayload(metapropertiesPayload, assetMetadata[''] || '', 'Stylist');
    // await this.mapFieldToPayload(metapropertiesPayload, assetMetadata[''] || '', 'Art_Director');
    // await this.mapFieldToPayload(metapropertiesPayload, assetMetadata[''] || '', 'Image_Width');
    // await this.mapFieldToPayload(metapropertiesPayload, assetMetadata[''] || '', 'Image_Height');
    // await this.mapFieldToPayload(metapropertiesPayload, assetMetadata['system_resolution'] || '', '');
    // await this.mapFieldToPayload(metapropertiesPayload, assetMetadata[''] || '', 'Hair_Makeup');
    // await this.mapFieldToPayload(metapropertiesPayload, assetMetadata[''] || '', 'Location');
    // await this.mapFieldToPayload(metapropertiesPayload, assetMetadata[''] || '', 'Digital_Tech');
    // await this.mapFieldToPayload(metapropertiesPayload, assetMetadata[''] || '', 'Photographer_Assistant');
    // await this.mapFieldToPayload(metapropertiesPayload, assetMetadata[''] || '', 'Stylist_Assistant');
    await this.mapFieldToPayload(metapropertiesPayload, '26:35', 'Ratio');
    await this.mapFieldToPayload(metapropertiesPayload, assetMetadata['model'] || '', 'Exif_Field_Model');
    await this.mapFieldToPayload(metapropertiesPayload, assetMetadata['exposure_time'] || '', 'Exposure_Time');
    await this.mapFieldToPayload(metapropertiesPayload, assetMetadata['f_number'] || '', 'F_Number');
    await this.mapFieldToPayload(metapropertiesPayload, assetMetadata['shutter_speed_value'] || '', 'Shutter_Speed');
    await this.mapFieldToPayload(metapropertiesPayload, assetMetadata['aperture_value'] || '', 'Aperture_Value');
    // await this.mapFieldToPayload(metapropertiesPayload, assetMetadata[''] || '', 'Max_Aperture_Value');
    await this.mapFieldToPayload(metapropertiesPayload, assetMetadata['metering_mode'] || '', 'Metering_Mode');
    if (assetMetadata['month']) {
      const monthValue = assetMetadata['month'].substring(0,2);
      const yearValue = '20' + assetMetadata['month'].substring(2,4);
      await this.mapFieldToPayload(metapropertiesPayload, monthValue, 'Season');
      await this.mapFieldToPayload(metapropertiesPayload, yearValue, 'Year');
    }

    const formData = new FormData();

    // 2. Append simple text fields (key-value pairs)
    // The key 'name_field' is the name the API expects for this parameter.
    formData.append('importId', importId);
    formData.append('name', filename); 

    for (const [key, value] of Object.entries(metapropertiesPayload)) {
      formData.append(key, value);
    }

    const saveResponse = await axios.post(
      `${this.credentials.apiBaseUrl}/api/v4/media/save/${importId}`,
      formData,
      { headers: authHeader }
    );

    if (saveResponse.status < 200 || saveResponse.status >= 300) {
      throw new Error('Failed to update Bynder asset metadata');
    }

    const bynderId = saveResponse.data.mediaid;

    if (!bynderId) {
      throw new Error('Failed to get Bynder asset ID from save response');
    }

    return bynderId;
  }
}
