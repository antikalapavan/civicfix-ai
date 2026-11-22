/**
 * CiviFix AI - In-Memory Image Optimization & Dimension Resizing Service
 * Phase 6: Client-side proportional downscaling and quality tuning to protect
 * Cloud Firestore's strict 1 MiB document limit and browser localStorage quotas.
 *
 * Guarantees:
 * 1. Operates 100% in-memory using HTML Canvas (zero temporary files or disk writes).
 * 2. Proportional aspect-ratio preservation.
 * 3. Targets ~250 KB (256,000 bytes) output size with an explicit 350 KB hard cap.
 * 4. Progressive quality and dimension reduction if initial pass exceeds limit.
 * 5. Fails explicitly if compression limits cannot be met (NEVER silently restores oversized Base64).
 */

export const IMAGE_LIMITS = {
  TARGET_BYTES: 250 * 1024,       // 250 KB target output size
  HARD_MAX_BYTES: 350 * 1024,     // 350 KB absolute hard cap
  INITIAL_MAX_DIM: 1280,          // 1280px initial max dimension
  MIN_ALLOWED_DIM: 320,           // Floor dimension
  INITIAL_QUALITY: 0.80,          // Initial JPEG quality
};

export const RESOLUTION_IMAGE_LIMITS = {
  TARGET_BYTES: 180 * 1024,       // 180 KB target output size for resolution evidence
  HARD_MAX_BYTES: 240 * 1024,     // 240 KB hard cap so fallback Data URI leaves room for citizen photo + timeline
  INITIAL_MAX_DIM: 1000,          // 1000px initial max dimension
  INITIAL_QUALITY: 0.78,          // Initial JPEG quality
};

export const CIVIC_UPLOAD_LIMITS = {
  ALLOWED_MIME_TYPES: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'] as const,
  ALLOWED_EXTENSIONS: ['.jpg', '.jpeg', '.png', '.webp'] as const,
  MAX_FILE_SIZE_BYTES: 5 * 1024 * 1024, // 5 MB raw upload limit
} as const;

export interface UploadValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates user-selected image format and raw file size against project upload limits.
 * Supports JPG, PNG, and WebP up to 5 MB, including extension fallback when mobile browsers
 * omit file.type on camera/gallery selections.
 */
export function validateCivicImageUpload(file: {
  type?: string;
  size?: number;
  name?: string;
} | null | undefined): UploadValidationResult {
  if (!file) {
    return { valid: false, error: 'No image file was selected.' };
  }

  const normalizedType = typeof file.type === 'string' ? file.type.trim().toLowerCase() : '';
  const normalizedName = typeof file.name === 'string' ? file.name.trim().toLowerCase() : '';

  if (normalizedType) {
    if (!(CIVIC_UPLOAD_LIMITS.ALLOWED_MIME_TYPES as readonly string[]).includes(normalizedType)) {
      return {
        valid: false,
        error: 'Unsupported image format. Please choose a JPG, PNG, or WebP photograph.',
      };
    }
  } else if (normalizedName) {
    const hasAllowedExt = CIVIC_UPLOAD_LIMITS.ALLOWED_EXTENSIONS.some((ext) =>
      normalizedName.endsWith(ext)
    );
    if (!hasAllowedExt) {
      return {
        valid: false,
        error: 'Unsupported image format. Please choose a JPG, PNG, or WebP photograph.',
      };
    }
  }

  if (typeof file.size === 'number') {
    if (file.size <= 0) {
      return {
        valid: false,
        error: 'The selected image file is empty. Please pick another photo.',
      };
    }
    if (file.size > CIVIC_UPLOAD_LIMITS.MAX_FILE_SIZE_BYTES) {
      return {
        valid: false,
        error: 'That photo is larger than 5MB. Please pick a smaller image.',
      };
    }
  }

  return { valid: true };
}

export interface ImageOptimizationOptions {
  maxDimension?: number;
  initialQuality?: number;
  targetBytes?: number;
  hardMaxBytes?: number;
}

export interface ImageOptimizationResult {
  success: boolean;
  dataUrl?: string;
  byteSize?: number;
  width?: number;
  height?: number;
  qualityUsed?: number;
  error?: string;
}

/**
 * Calculates proportional dimensions preserving original aspect ratio.
 */
export function calculateProportionalDimensions(
  origWidth: number,
  origHeight: number,
  maxDimension: number
): { width: number; height: number } {
  if (origWidth <= 0 || origHeight <= 0) {
    return { width: Math.max(1, maxDimension), height: Math.max(1, maxDimension) };
  }

  if (origWidth <= maxDimension && origHeight <= maxDimension) {
    return { width: origWidth, height: origHeight };
  }

  if (origWidth >= origHeight) {
    const width = maxDimension;
    const height = Math.max(1, Math.round((origHeight * maxDimension) / origWidth));
    return { width, height };
  } else {
    const height = maxDimension;
    const width = Math.max(1, Math.round((origWidth * maxDimension) / origHeight));
    return { width, height };
  }
}

/**
 * Calculates raw binary byte size of a Base64 string or Data URI.
 */
export function calculateBase64ByteSize(base64DataUrlOrRaw: string): number {
  if (!base64DataUrlOrRaw || typeof base64DataUrlOrRaw !== 'string') {
    return 0;
  }
  const cleanBase64 = base64DataUrlOrRaw.includes(',')
    ? base64DataUrlOrRaw.split(',')[1]
    : base64DataUrlOrRaw;

  // Calculate padding characters
  let padding = 0;
  if (cleanBase64.endsWith('==')) {
    padding = 2;
  } else if (cleanBase64.endsWith('=')) {
    padding = 1;
  }

  return Math.max(0, Math.floor((cleanBase64.length * 3) / 4) - padding);
}

/**
 * Estimates UTF-8 byte size of a Firestore document payload.
 */
export function estimateFirestoreDocumentSize(payload: Record<string, any>): number {
  try {
    const jsonStr = JSON.stringify(payload);
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(jsonStr).length;
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.byteLength(jsonStr, 'utf8');
    }
    return jsonStr.length;
  } catch {
    return 0;
  }
}

/**
 * Progressively resizes and encodes an image element using an in-memory HTML canvas.
 * Step 1: maxDim 1280, quality 0.80
 * Step 2: maxDim 1024, quality 0.70
 * Step 3: maxDim 800, quality 0.60
 * Step 4: maxDim 640, quality 0.50
 */
export async function optimizeImageFromSource(
  imageSource: HTMLImageElement,
  options?: ImageOptimizationOptions
): Promise<ImageOptimizationResult> {
  const targetBytes = options?.targetBytes || IMAGE_LIMITS.TARGET_BYTES;
  const hardMaxBytes = options?.hardMaxBytes || IMAGE_LIMITS.HARD_MAX_BYTES;

  if (typeof document === 'undefined') {
    return {
      success: false,
      error: 'Canvas image resizing requires a browser document environment.',
    };
  }

  const origWidth = imageSource.naturalWidth || imageSource.width;
  const origHeight = imageSource.naturalHeight || imageSource.height;

  if (origWidth <= 0 || origHeight <= 0) {
    return {
      success: false,
      error: 'Invalid image dimensions detected.',
    };
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return {
      success: false,
      error: 'Could not acquire 2D canvas rendering context.',
    };
  }

  // Progressive compression steps
  const compressionPasses = [
    { maxDim: options?.maxDimension || IMAGE_LIMITS.INITIAL_MAX_DIM, quality: options?.initialQuality || IMAGE_LIMITS.INITIAL_QUALITY },
    { maxDim: 1024, quality: 0.72 },
    { maxDim: 800, quality: 0.62 },
    { maxDim: 640, quality: 0.52 },
    { maxDim: 480, quality: 0.45 },
    { maxDim: 400, quality: 0.40 },
    { maxDim: 320, quality: 0.35 },
  ];

  let bestResult: ImageOptimizationResult | null = null;

  for (const pass of compressionPasses) {
    const { width, height } = calculateProportionalDimensions(origWidth, origHeight, pass.maxDim);

    canvas.width = width;
    canvas.height = height;

    // Use high-quality smoothing for clear municipal defect visibility
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(imageSource, 0, 0, width, height);

    const dataUrl = canvas.toDataURL('image/jpeg', pass.quality);
    const byteSize = calculateBase64ByteSize(dataUrl);

    bestResult = {
      success: byteSize <= hardMaxBytes,
      dataUrl,
      byteSize,
      width,
      height,
      qualityUsed: pass.quality,
    };

    // If within our target size (< 250 KB), accept immediately
    if (byteSize <= targetBytes) {
      return {
        ...bestResult,
        success: true,
      };
    }
  }

  // After all passes, check if we stayed under hard max cap (350 KB)
  if (bestResult && bestResult.byteSize && bestResult.byteSize <= hardMaxBytes) {
    return {
      ...bestResult,
      success: true,
    };
  }

  // Explicit failure: Never silently return original oversized image
  return {
    success: false,
    byteSize: bestResult?.byteSize,
    error: `Optimized image size (${bestResult?.byteSize ? Math.round(bestResult.byteSize / 1024) : 'unknown'} KB) exceeds the safe ${Math.round(hardMaxBytes / 1024)} KB limit. Please select another image.`,
  };
}

/**
 * High-level helper: In-memory optimization from a raw Data URL or File.
 */
export function optimizeBase64Image(
  rawBase64DataUrl: string,
  options?: ImageOptimizationOptions
): Promise<ImageOptimizationResult> {
  return new Promise((resolve) => {
    if (!rawBase64DataUrl || typeof rawBase64DataUrl !== 'string') {
      resolve({
        success: false,
        error: 'No image data provided for optimization.',
      });
      return;
    }

    if (typeof Image === 'undefined') {
      resolve({
        success: false,
        error: 'HTML Image constructor unavailable.',
      });
      return;
    }

    const img = new Image();
    img.onload = async () => {
      try {
        const result = await optimizeImageFromSource(img, options);
        resolve(result);
      } catch (err: any) {
        resolve({
          success: false,
          error: `Image optimization failed: ${err?.message || 'unknown canvas error'}`,
        });
      }
    };

    img.onerror = () => {
      resolve({
        success: false,
        error: 'Failed to load image for resizing. Image file may be corrupted.',
      });
    };

    img.src = rawBase64DataUrl;
  });
}

/**
 * Optimizes an administrative resolution evidence photo using tighter progressive
 * compression limits so that even when Firebase Storage is unavailable and a Data URI
 * fallback is stored, the complete report document stays safely below the application limit.
 */
export function optimizeResolutionPhotoDataUrl(
  rawBase64DataUrl: string,
  options?: ImageOptimizationOptions
): Promise<ImageOptimizationResult> {
  return optimizeBase64Image(rawBase64DataUrl, {
    maxDimension: options?.maxDimension ?? RESOLUTION_IMAGE_LIMITS.INITIAL_MAX_DIM,
    initialQuality: options?.initialQuality ?? RESOLUTION_IMAGE_LIMITS.INITIAL_QUALITY,
    targetBytes: options?.targetBytes ?? RESOLUTION_IMAGE_LIMITS.TARGET_BYTES,
    hardMaxBytes: options?.hardMaxBytes ?? RESOLUTION_IMAGE_LIMITS.HARD_MAX_BYTES,
  });
}

/**
 * Fast client-side downscaler:
 * Downscales an uploaded image to a max dimension of 1024px and compresses it to JPEG (quality 0.82)
 * BEFORE passing it to the backend OpenCV service or ML inspect endpoint.
 * Reduces payload size from ~5MB to ~80-120KB and prevents network/processing delay.
 */
export function downscaleBase64ForService(
  rawBase64DataUrl: string,
  maxDimension: number = 1024,
  quality: number = 0.82
): Promise<string> {
  return new Promise((resolve) => {
    if (!rawBase64DataUrl || typeof rawBase64DataUrl !== 'string') {
      resolve(rawBase64DataUrl || '');
      return;
    }

    const normalizedInput = rawBase64DataUrl.replace(
      /^data:image\/(?:jpg|pjpeg);base64,/i,
      'data:image/jpeg;base64,'
    );

    // Fallback for non-browser environments
    if (typeof Image === 'undefined' || typeof document === 'undefined') {
      resolve(normalizedInput);
      return;
    }

    const img = new Image();
    img.onload = () => {
      try {
        const origWidth = img.naturalWidth || img.width;
        const origHeight = img.naturalHeight || img.height;
        const isStandardFormat = /^data:image\/(?:jpeg|png|webp);base64,/i.test(normalizedInput);

        // If already within 1024px bounds, standard MIME format, and small (< 150KB), return directly
        if (
          isStandardFormat &&
          origWidth <= maxDimension &&
          origHeight <= maxDimension &&
          normalizedInput.length < 200_000
        ) {
          resolve(normalizedInput);
          return;
        }

        const { width, height } = calculateProportionalDimensions(origWidth, origHeight, maxDimension);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(rawBase64DataUrl);
          return;
        }

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'medium';
        ctx.drawImage(img, 0, 0, width, height);

        const compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve(compressedDataUrl);
      } catch {
        resolve(rawBase64DataUrl);
      }
    };

    img.onerror = () => {
      resolve(rawBase64DataUrl);
    };

    img.src = rawBase64DataUrl;
  });
}

/**
 * Computes a deterministic SHA-256 (or FNV-1a fallback) content fingerprint
 * of a base64 image string to detect duplicate complaint photo uploads.
 */
export async function computeImageFingerprint(dataUrlOrBase64: string): Promise<string> {
  if (!dataUrlOrBase64 || typeof dataUrlOrBase64 !== 'string') return '';
  const cleanPayload = dataUrlOrBase64.includes(',')
    ? dataUrlOrBase64.split(',')[1].trim()
    : dataUrlOrBase64.trim();
  if (!cleanPayload) return '';

  try {
    if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
      const bytes = new TextEncoder().encode(cleanPayload);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return `sha256:${hex}`;
    }
  } catch {
    // Fall back to deterministic FNV-1a double hash
  }

  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < cleanPayload.length; i++) {
    const c = cleanPayload.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    if (i % 2 === 0) {
      h2 ^= c;
      h2 = Math.imul(h2, 0x01000193);
    }
  }
  return `fnv:${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}:${cleanPayload.length}`;
}

export interface DuplicatePhotoCheckResult {
  isDuplicate: boolean;
  matchingTrackingNumber?: string;
  matchingTitle?: string;
  matchingDate?: string;
}

/**
 * Checks whether an uploaded photo (by fingerprint or exact data URI match)
 * already appears in the citizen's previously submitted reports.
 */
export async function checkDuplicatePhoto(
  candidateDataUrl: string,
  existingReports: Array<{
    trackingNumber?: string;
    title?: string;
    submittedAt?: string;
    photoUrl?: string;
    status?: string;
  }> = []
): Promise<DuplicatePhotoCheckResult> {
  if (!candidateDataUrl || !Array.isArray(existingReports) || existingReports.length === 0) {
    return { isDuplicate: false };
  }

  const candidateFingerprint = await computeImageFingerprint(candidateDataUrl);

  for (const rep of existingReports) {
    if (!rep?.photoUrl || rep.status === 'Withdrawn') continue;
    if (rep.photoUrl === candidateDataUrl) {
      return {
        isDuplicate: true,
        matchingTrackingNumber: rep.trackingNumber,
        matchingTitle: rep.title,
        matchingDate: rep.submittedAt,
      };
    }
    if (rep.photoUrl.startsWith('data:')) {
      const existingFingerprint = await computeImageFingerprint(rep.photoUrl);
      if (candidateFingerprint && existingFingerprint === candidateFingerprint) {
        return {
          isDuplicate: true,
          matchingTrackingNumber: rep.trackingNumber,
          matchingTitle: rep.title,
          matchingDate: rep.submittedAt,
        };
      }
    }
  }

  return { isDuplicate: false };
}
