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

  /**
   * Extract Style_Number and RLM_NRF_Color_Code from filename
   * Filename format: STYLE_NUMBER-COLOR_CODE_SUFFIX.ext (e.g., "49F5RMFS2B-0848_2.tif" or "MK-2258U-0255.tif")
   */
  extractMetadataFromFilename(filename: string): { styleNumber: string; colorCode: string, angleCode: string } {
    const lastDashIndex = filename.lastIndexOf('-');
    const underscoreIndex = filename.indexOf('_');
    const dotIndex = filename.lastIndexOf('.');

    if (lastDashIndex === -1) {
      return { styleNumber: '', colorCode: '', angleCode: '' };
    }

    const styleNumber = filename.substring(0, lastDashIndex);
    
    // Color code ends at underscore if present, otherwise at the file extension
    const colorCodeEndIndex = underscoreIndex !== -1 ? underscoreIndex : dotIndex;
    const colorCode = colorCodeEndIndex !== -1 
      ? filename.substring(lastDashIndex + 1, colorCodeEndIndex)
      : filename.substring(lastDashIndex + 1);

    // Angle code is the part after underscore, up to the file extension
    // If no underscore, angle code is empty
    const angleCode = underscoreIndex !== -1 && dotIndex !== -1
      ? filename.substring(underscoreIndex + 1, dotIndex)
      : '';

    return { styleNumber, colorCode, angleCode };
  }

  private buildMetapropertiesPayload(assetMetadata: Record<string, string>): Record<string, string> {
    const metapropertiesPayload: Record<string, string> = {};

    const styleNumber = assetMetadata['style_number'] || '';
    const colorCode = assetMetadata['color_code'] || '';

    this.mapFieldToPayload(metapropertiesPayload, styleNumber, 'Style_Number');
    this.mapFieldToPayload(metapropertiesPayload, colorCode, 'RLM_NRF_Color_Code');
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
      const normalized_system_uploaded_date_ts = new Date(assetMetadata['system_uploaded']);
      const archiveDatePeriod = new Date('2022-12-14'); 
      if (normalized_system_uploaded_date_ts.getTime() < archiveDatePeriod.getTime()) {
        this.mapFieldToPayload(metapropertiesPayload, 'Archived', 'Asset_Status');
      } else {
        this.mapFieldToPayload(metapropertiesPayload, 'In Progress Ecom', 'Asset_Status');
      }

    } else {
      this.mapFieldToPayload(metapropertiesPayload, 'In Progress Ecom', 'Asset_Status');
    }

    

    this.mapFieldToPayload(metapropertiesPayload, assetMetadata['model_name'] || '', 'Recognized_Faces');

    const indexedProductString = styleNumber + '-' + colorCode;
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
      /** When true and mediaId is set, finalize as additional file on existing asset (Step 4 "Finalize additional file") */
      addAsAdditionalFile?: boolean;
    } = {}
  ): Promise<string> {
    const { chunkSize = 1024 * 1024 * 5, onProgress, mediaId, addAsAdditionalFile = false } = options;

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

    // Step 4: Finalize upload (or finalize as additional file on existing asset)
    const chunkData = new URLSearchParams({
      targetid: uploadData.s3file.targetid,
      s3_filename: uploadData.s3_filename,
      chunks: totalChunks.toString(),
      original_filename: filename,
    });

    let importId: string | undefined;

    if (mediaId && addAsAdditionalFile) {
      // Finalize additional file: add uploaded file as new file on existing asset
      // https://api.bynder.com/reference/finalize-additional-file
      const additionalFileEndpoint = `${this.credentials.apiBaseUrl}/api/v4/media/${mediaId}/save/additional/${uploadData.s3file.uploadid}/`;
      const additionalResponse = await axios.post(additionalFileEndpoint, chunkData, {
        headers: {
          ...authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
      if (additionalResponse.status < 200 || additionalResponse.status >= 300) {
        throw new Error('Failed to finalize additional file on existing Bynder asset');
      }
      return mediaId;
    }

    const finalizeResponse = await axios.post(
      `${this.credentials.apiBaseUrl}/api/v4/upload/${uploadData.s3file.uploadid}`,
      chunkData,
      { headers: authHeader }
    );

    // Step 5: Poll for completion
    importId = finalizeResponse.data.importId;
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

    // Apply filename fallback for style_number, color_code, and angle_code
    const filenameMetadata = this.extractMetadataFromFilename(filename);

    // If style_number is empty, use filename-derived value
    if (!assetMetadata['style_number']) {
      assetMetadata['style_number'] = filenameMetadata.styleNumber;
    }

    // If color_code is empty or less than 3 digits, use filename-derived value
    if (!assetMetadata['color_code'] || assetMetadata['color_code'].length < 3) {
      assetMetadata['color_code'] = filenameMetadata.colorCode;
    }

    // Different save flow for existing assets vs new assets
    // See: https://api.bynder.com/reference/saveuploadedfiletoexistingasset
    // The saveuploadedfiletoexistingasset endpoint doesn't accept metadata payload,
    // so we need to update metadata separately after saving
    
    if (mediaId) {
      // Existing asset: save file first (no metadata), then update metadata separately
      const saveEndpoint = `${this.credentials.apiBaseUrl}/api/v4/media/${mediaId}/save/${importId}`;
      
      const saveResponse = await axios.post(saveEndpoint, null, { headers: authHeader });

      if (saveResponse.status < 200 || saveResponse.status >= 300) {
        throw new Error('Failed to save file to existing Bynder asset');
      }

      // Update metadata separately using the Modify asset endpoint
      await this.updateMediaMetadata(mediaId, assetMetadata);

      return mediaId;
    } else {
      // New asset: save with metadata in one call
      const metapropertiesPayload = this.buildMetapropertiesPayload(assetMetadata);

      const formData = new FormData();
      formData.append('importId', importId);
      formData.append('name', filename);

      // If SHARE uploaded date is < 12/14/2022 mark ArchiveDate in Bynder as 12/15/2025
      if (assetMetadata['system_uploaded']) {
        const normalized_system_uploaded_date_ts = new Date(assetMetadata['system_uploaded']);
        const archiveDatePeriod = new Date('2022-12-14'); //ArchiveDate timeperiod
        if (normalized_system_uploaded_date_ts.getTime() < archiveDatePeriod.getTime()) {
          formData.append('archiveDate', '2025-12-15T00:00:00Z')
        }
      }

      for (const [key, value] of Object.entries(metapropertiesPayload)) {
        formData.append(key, value);
      }

      const saveEndpoint = `${this.credentials.apiBaseUrl}/api/v4/media/save/${importId}`;
      const saveResponse = await axios.post(saveEndpoint, formData, { headers: authHeader });

      if (saveResponse.status < 200 || saveResponse.status >= 300) {
        throw new Error('Failed to save new Bynder asset');
      }

      const bynderId = saveResponse.data.mediaid;

      if (!bynderId) {
        throw new Error('Failed to get Bynder asset ID from save response');
      }

      return bynderId;
    }
  }

  /**
   * Get a single metaproperty value from a media item (Bynder response shape can vary).
   */
  private getMetapropertyValueFromMedia(mediaItem: Record<string, unknown>, metapropertyName: string): string | null {
    const propId = this.metaproperties.get(metapropertyName);
    if (!propId) return null;

    const raw =
      (mediaItem.metaproperty as Record<string, unknown>)?.[propId] ??
      (mediaItem.metaproperties as Record<string, unknown>)?.[propId] ??
      (mediaItem as Record<string, unknown>)[`metaproperty.${propId}`];

    if (raw == null) return null;
    if (typeof raw === 'string') return raw.trim() || null;
    if (Array.isArray(raw) && raw.length > 0) {
      const first = raw[0];
      if (typeof first === 'string') return first.trim() || null;
      if (first && typeof first === 'object' && 'name' in first) return String((first as { name: string }).name).trim() || null;
      if (first && typeof first === 'object' && 'id' in first) return String((first as { id: string }).id).trim() || null;
    }
    if (typeof raw === 'object' && raw !== null && 'name' in raw) return String((raw as { name: string }).name).trim() || null;
    if (typeof raw === 'object' && raw !== null && 'id' in raw) return String((raw as { id: string }).id).trim() || null;
    return null;
  }

  /**
   * Find one asset by Style_Number only, then filter client-side by RLM_NRF_Color_Code and Ecom_Angle_Code
   * so we don't rely on the Bynder API filtering with multiple params.
   */
  async findMedia(styleNumber: string, colorCode: string, angleCode?: string): Promise<string | null> {
    const accessToken = await this.getAccessToken();
    const authHeader = { Authorization: `Bearer ${accessToken}` };
    await this.ensureMetapropertiesLoaded(authHeader);

    const params: Record<string, string | number> = {
      property_Style_Number: styleNumber,
      limit: 200,
    };

    const response = await axios.get(`${this.credentials.apiBaseUrl}/api/v4/media/`, {
      headers: authHeader,
      params,
    });


    const data = response.data;
    let candidates: Record<string, unknown>[] = [];
    if (Array.isArray(data)) {
      candidates = data;
    } else if (Array.isArray(data?.media)) {
      candidates = data.media;
    } else if (Array.isArray(data?.items)) {
      candidates = data.items;
    } else if (Array.isArray(data?.results)) {
      candidates = data.results;
    }

    console.log('Found existing assets for style number: ', candidates);

    const normalizedColor = (colorCode || '').trim();
    const normalizedAngle = (angleCode || '').trim();

    for (const item of candidates) {
      const itemColor = this.getMetapropertyValueFromMedia(item, 'RLM_NRF_Color_Code');
      const itemAngle = this.getMetapropertyValueFromMedia(item, 'Ecom_Angle_Code');
      const colorMatch = normalizedColor ? (itemColor || '').trim() === normalizedColor : true;
      const angleMatch = normalizedAngle ? (itemAngle || '').trim() === normalizedAngle : true;
      if (colorMatch && angleMatch) {
        const id = (item as { id?: string }).id;
        console.log('Found matching asset: ', id);
        return id || null;
      }
    }

    return null;
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
