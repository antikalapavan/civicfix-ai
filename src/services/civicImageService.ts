import {
  AnyCivicCategory,
  CivicCategory,
  CivicImageVerificationResult,
  CivicIssueBoundingBox,
  CleanupVisualizationResult,
} from '../types/civic';
import { getFirebaseAuthHeaders } from '../lib/firebase';
import { computeImageFingerprint } from './imageOptimizer';

const validationCache = new Map<string, CivicImageVerificationResult>();
const visualizationCache = new Map<string, CleanupVisualizationResult>();

export function clearCivicImageCaches(): void {
  validationCache.clear();
  visualizationCache.clear();
}

export const VALIDATE_CIVIC_IMAGE_TIMEOUT_MS = 22_000;
export const INSPECT_CIVIC_IMAGE_TIMEOUT_MS = 5_000;

export const FRIENDLY_IMAGE_TIMEOUT_MESSAGE =
  'Photo check took too long. You can try again or choose a category manually.';

export const FRIENDLY_IMAGE_VERIFY_FALLBACK_MESSAGE =
  'We could not finish checking the photo automatically. You can try again or choose a category manually.';

export function isAbortOrTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const anyErr = err as { name?: string; message?: string };
  if (anyErr.name === 'AbortError' || anyErr.name === 'TimeoutError') return true;
  if (typeof anyErr.message === 'string') {
    return /timed out|timeout|aborted/i.test(anyErr.message);
  }
  return false;
}

export interface ValidateCivicImageParams {
  photoBase64: string;
  description?: string;
  selectedCategory?: AnyCivicCategory | CivicCategory | string;
  qualitySummary?: Record<string, any> | null;
  forceRefresh?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}

export async function validateCivicIssueImage(
  params: ValidateCivicImageParams
): Promise<CivicImageVerificationResult> {
  const {
    photoBase64,
    description = '',
    selectedCategory,
    qualitySummary,
    forceRefresh = false,
    timeoutMs = VALIDATE_CIVIC_IMAGE_TIMEOUT_MS,
    signal: externalSignal,
    fetcher = fetch,
  } = params;

  const fingerprint = await computeImageFingerprint(photoBase64);
  const cacheKey = `${fingerprint}::${selectedCategory || ''}::${description.trim().toLowerCase().slice(0, 120)}`;

  if (!forceRefresh && validationCache.has(cacheKey)) {
    return validationCache.get(cacheKey)!;
  }

  if (externalSignal?.aborted) {
    const cancelErr: any = new Error('Photo verification cancelled.');
    cancelErr.name = 'AbortError';
    throw cancelErr;
  }

  const effectiveTimeoutMs = Math.max(1, timeoutMs);
  const controller = new AbortController();
  let timedOut = false;
  let cancelledByCaller = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let externalAbortListener: (() => void) | null = null;
  let raceAbortListener: (() => void) | null = null;

  if (externalSignal) {
    externalAbortListener = () => {
      cancelledByCaller = true;
      const cancelErr: any = new Error('Photo verification cancelled.');
      cancelErr.name = 'AbortError';
      controller.abort(cancelErr);
    };
    externalSignal.addEventListener('abort', externalAbortListener, { once: true });
  }

  const abortPromise = new Promise<never>((_, reject) => {
    raceAbortListener = () => {
      if (cancelledByCaller) {
        const cancelErr: any = new Error('Photo verification cancelled.');
        cancelErr.name = 'AbortError';
        reject(cancelErr);
      } else {
        const timeoutErr: any = new Error(FRIENDLY_IMAGE_TIMEOUT_MESSAGE);
        timeoutErr.name = 'AbortError';
        reject(timeoutErr);
      }
    };
    controller.signal.addEventListener('abort', raceAbortListener, { once: true });
  });

  timeoutTimer = setTimeout(() => {
    timedOut = true;
    const timeoutErr: any = new Error(FRIENDLY_IMAGE_TIMEOUT_MESSAGE);
    timeoutErr.name = 'AbortError';
    controller.abort(timeoutErr);
  }, effectiveTimeoutMs);

  try {
    const requestPayload = JSON.stringify({
      photoBase64,
      description: description.trim(),
      selectedCategory,
      qualitySummary: qualitySummary || undefined,
      forceRefresh: Boolean(forceRefresh),
    });

    const authHeaders = await Promise.race([getFirebaseAuthHeaders(false), abortPromise]);
    let response = await Promise.race([
      fetcher('/api/groq/validate-civic-image', {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
        },
        body: requestPayload,
        signal: controller.signal,
      }),
      abortPromise,
    ]);

    console.info('[CiviFix] Groq frontend response received', {
      status: response.status,
      ok: response.ok,
      authenticatedRequest: Boolean(authHeaders.Authorization),
    });

    if (response.status === 401) {
      const refreshedHeaders = await Promise.race([getFirebaseAuthHeaders(true), abortPromise]);
      if (refreshedHeaders.Authorization) {
        response = await Promise.race([
          fetcher('/api/groq/validate-civic-image', {
            method: 'POST',
            headers: {
              ...refreshedHeaders,
              'Content-Type': 'application/json',
            },
            body: requestPayload,
            signal: controller.signal,
          }),
          abortPromise,
        ]);
      }
    }

    if (!response.ok) {
      // Do not surface raw technical HTTP/stack details to citizens
      throw new Error(FRIENDLY_IMAGE_VERIFY_FALLBACK_MESSAGE);
    }

    const result: CivicImageVerificationResult = await Promise.race([
      response.json(),
      abortPromise,
    ]);
    console.info('[CiviFix] Groq analysis received by frontend', {
      decision: result?.decision || 'missing',
      category: result?.primaryCategory || 'missing',
      severity: result?.suggestedSeverity || 'missing',
      requiresHumanReview: Boolean(result?.requiresHumanReview),
      isFallback: Boolean(result?.isFallback),
    });
    // Never cache fallback responses so clicking "Try Again" or re-uploading genuinely calls Gemini
    if (result && !result.isFallback) {
      validationCache.set(cacheKey, result);
    }
    return result;
  } catch (err: any) {
    if (cancelledByCaller) {
      const cancelErr: any = new Error('Photo verification cancelled.');
      cancelErr.name = 'AbortError';
      throw cancelErr;
    }
    if (timedOut || isAbortOrTimeoutError(err)) {
      const timeoutErr: any = new Error(FRIENDLY_IMAGE_TIMEOUT_MESSAGE);
      timeoutErr.name = 'AbortError';
      throw timeoutErr;
    }
    if (err?.message === FRIENDLY_IMAGE_VERIFY_FALLBACK_MESSAGE) {
      throw err;
    }
    throw new Error(FRIENDLY_IMAGE_VERIFY_FALLBACK_MESSAGE);
  } finally {
    if (timeoutTimer !== null) {
      clearTimeout(timeoutTimer);
    }
    if (externalSignal && externalAbortListener) {
      externalSignal.removeEventListener('abort', externalAbortListener);
    }
    if (raceAbortListener) {
      controller.signal.removeEventListener('abort', raceAbortListener);
    }
  }
}

export interface InspectCivicPhotoResult {
  success?: boolean;
  valid?: boolean;
  quality?: Record<string, any>;
  warnings?: string[];
}

export async function inspectCivicPhotoQuality(params: {
  photoBase64: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<InspectCivicPhotoResult | null> {
  const {
    photoBase64,
    timeoutMs = INSPECT_CIVIC_IMAGE_TIMEOUT_MS,
    signal: externalSignal,
    fetcher = fetch,
  } = params;

  if (externalSignal?.aborted) {
    return null;
  }

  const controller = new AbortController();
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let externalAbortListener: (() => void) | null = null;
  let raceAbortListener: (() => void) | null = null;

  if (externalSignal) {
    externalAbortListener = () => controller.abort();
    externalSignal.addEventListener('abort', externalAbortListener, { once: true });
  }

  const abortPromise = new Promise<null>((resolve) => {
    raceAbortListener = () => resolve(null);
    controller.signal.addEventListener('abort', raceAbortListener, { once: true });
  });

  timeoutTimer = setTimeout(() => {
    controller.abort();
  }, Math.max(1, timeoutMs));

  try {
    const authHeaders = await Promise.race([getFirebaseAuthHeaders(), abortPromise]);
    if (!authHeaders) return null;

    const response = await Promise.race([
      fetcher('/api/image/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ photoBase64 }),
        signal: controller.signal,
      }),
      abortPromise,
    ]);

    if (!response || !response.ok) {
      return null;
    }

    const data = await Promise.race([response.json(), abortPromise]);
    return data ?? null;
  } catch {
    // Non-blocking: inspection timeout/error never blocks Gemini analysis or displays technical errors
    return null;
  } finally {
    if (timeoutTimer !== null) {
      clearTimeout(timeoutTimer);
    }
    if (externalSignal && externalAbortListener) {
      externalSignal.removeEventListener('abort', externalAbortListener);
    }
    if (raceAbortListener) {
      controller.signal.removeEventListener('abort', raceAbortListener);
    }
  }
}

export interface VisualizeCivicImprovementParams {
  photoBase64: string;
  category: CivicCategory | string;
  visualSubType?: string;
  description?: string;
  detectedBoxes?: CivicIssueBoundingBox[];
  forceRefresh?: boolean;
  fetcher?: typeof fetch;
}

export async function visualizeCivicImprovement(
  params: VisualizeCivicImprovementParams
): Promise<CleanupVisualizationResult> {
  const {
    photoBase64,
    category,
    visualSubType = '',
    description = '',
    detectedBoxes = [],
    forceRefresh = false,
    fetcher = fetch,
  } = params;

  const fingerprint = await computeImageFingerprint(photoBase64);
  const boxSig = Array.isArray(detectedBoxes) && detectedBoxes.length > 0
    ? detectedBoxes.map((b) => `${b.ymin},${b.xmin},${b.ymax},${b.xmax}`).join('|')
    : 'auto';
  const cacheKey = `${fingerprint}::${category}::${visualSubType}::${boxSig}`;

  if (!forceRefresh && visualizationCache.has(cacheKey)) {
    return visualizationCache.get(cacheKey)!;
  }

  const authHeaders = await getFirebaseAuthHeaders();
  const response = await fetcher('/api/civic/visualize-improvement', {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      photoBase64,
      category,
      visualSubType,
      description: description.trim(),
      detectedBoxes,
    }),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody?.error || `Before & After preview returned HTTP ${response.status}`);
  }

  const result: CleanupVisualizationResult = await response.json();
  if (!result.isUnavailable && result.visualizedImageUrl) {
    visualizationCache.set(cacheKey, result);
  }
  return result;
}
