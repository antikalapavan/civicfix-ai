import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { searchCivicKnowledge } from './src/data/civicKnowledge';
import { mlSupervisor } from './src/server/mlSupervisor';
import {
  performGroundedInpainting,
  verifyImageSimilarity,
  attemptGeminiImageToImage,
  BoundingBox,
} from './src/server/groundedCleanup';
import {
  CANONICAL_CIVIC_CATEGORIES,
  parseImagePayload,
  buildCivicValidationPrompt,
  normalizeCivicValidationResponse,
  buildFallbackValidationResult,
  BEFORE_AFTER_DISCLAIMER,
  mapToCanonicalCategory,
  normalizeSeverity,
  normalizeConfidenceLevel,
} from './src/server/civicVisionHelpers';
import {
  requestGroqCivicImageAnalysis,
  resolveGroqApiKey,
  resolveGroqModel,
  GROQ_SUPPORTED_IMAGE_MIME_TYPES,
  GroqVisionError,
} from './src/server/xaiVision';
import {
  requireAuth,
  verifyAdminFromDecodedToken,
} from './src/server/firebaseAuthMiddleware';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Gemini model used for text and multimodal civic triage.
 * `gemini-4-hydrogen` was previously the fallback, but it is not a generally
 * available Gemini API model. Repair that legacy value so old deployments
 * recover without exposing a key or image data.
 */
const configuredGeminiModel = (process.env.GEMINI_MODEL || '').trim();
export const GEMINI_MODEL =
  !configuredGeminiModel || configuredGeminiModel === 'gemini-4-hydrogen'
    ? 'gemini-2.5-flash'
    : configuredGeminiModel;
export const GEMINI_MODEL_WAS_REPAIRED = configuredGeminiModel === 'gemini-4-hydrogen';
export const GROQ_MODEL = resolveGroqModel();

export const app = express();
app.set('trust proxy', 1);

const portArgIndex = process.argv.indexOf('--port');
const portFromArgs = portArgIndex !== -1 && process.argv[portArgIndex + 1] ? parseInt(process.argv[portArgIndex + 1], 10) : null;
// Dev server strictly runs on port 3000 in AI Studio; in production falls back to process.env.PORT
const PORT = portFromArgs || (process.env.PORT ? Number(process.env.PORT) : 3000);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);

const HOSTED_ORIGIN_PATTERN =
  /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:run\.app|web\.app|firebaseapp\.com|aistudio\.google\.com|googleusercontent\.com)$/i;
const NATIVE_APP_ORIGINS = new Set(['capacitor://localhost', 'http://localhost']);

/**
 * Normalizes a configured origin from APP_URL or ALLOWED_ORIGINS:
 * trims whitespace, removes trailing slashes, rejects wildcards/paths/credentials,
 * and returns the canonical "<scheme>://<host>[:<port>]" origin string.
 */
export function normalizeConfiguredOrigin(rawOrigin?: string | null): string | null {
  if (typeof rawOrigin !== 'string') return null;
  const trimmed = rawOrigin.trim();
  if (!trimmed || trimmed === '*' || trimmed.includes('*')) return null;

  const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
  if (!withoutTrailingSlash) return null;

  try {
    const parsed = new URL(withoutTrailingSlash);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.search || parsed.hash) return null;
    if (parsed.pathname !== '/') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Builds the normalized Set of explicitly configured origins from ALLOWED_ORIGINS and APP_URL.
 */
export function buildAllowedOrigins(
  env: Record<string, string | undefined> = process.env
): Set<string> {
  const allowed = new Set<string>();
  const rawList = (env.ALLOWED_ORIGINS || '').split(',');
  if (env.APP_URL) {
    rawList.push(env.APP_URL);
  }
  for (const item of rawList) {
    const normalized = normalizeConfiguredOrigin(item);
    if (normalized) {
      allowed.add(normalized);
    }
  }
  return allowed;
}

/**
 * Validates an incoming browser Origin header against explicitly configured origins,
 * localhost development ports, and approved hosted domains without ever allowing wildcards.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: Set<string>
): boolean {
  if (!origin) return true;
  if (typeof origin !== 'string') return false;

  const trimmed = origin.trim();
  if (!trimmed || trimmed === '*' || trimmed.includes('*') || trimmed.endsWith('/')) {
    return false;
  }

  if (NATIVE_APP_ORIGINS.has(trimmed.toLowerCase())) {
    return true;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
  if (parsed.pathname !== '/') return false;

  // Browser Origin headers must match canonical "<scheme>://<host>[:<port>]" exactly
  if (trimmed.toLowerCase() !== parsed.origin.toLowerCase()) {
    return false;
  }

  if (allowedOrigins.has(parsed.origin)) {
    return true;
  }

  if (
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') &&
    parsed.port !== ''
  ) {
    return true;
  }

  if (
    parsed.protocol === 'https:' &&
    !parsed.port &&
    HOSTED_ORIGIN_PATTERN.test(parsed.hostname)
  ) {
    return true;
  }

  return false;
}

const configuredOrigins = buildAllowedOrigins(process.env);

app.use(
  cors({
    origin: (origin, callback) => {
      if (isOriginAllowed(origin, configuredOrigins)) {
        return callback(null, true);
      }
      const corsErr: any = new Error('Origin not allowed by CiviFix CORS policy');
      corsErr.status = 403;
      corsErr.code = 'CORS_ORIGIN_DENIED';
      return callback(corsErr);
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err?.code === 'CORS_ORIGIN_DENIED') {
    return res.status(403).json({
      success: false,
      error: 'Origin not allowed by CiviFix CORS policy',
    });
  }
  return next(err);
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many API requests from this client. Please wait a few minutes and retry.',
  },
});

app.use('/api', apiLimiter);
app.use(express.json({ limit: '10mb' }));

interface GeminiCooldownState {
  consecutiveFailures: number;
  cooldownUntil: number;
  lastErrorCode: number | string | null;
  lastErrorReason: string | null;
}

const geminiCooldown: GeminiCooldownState = {
  consecutiveFailures: 0,
  cooldownUntil: 0,
  lastErrorCode: null,
  lastErrorReason: null,
};

let lastApiKey: string | undefined = undefined;

const PLACEHOLDER_API_KEYS = new Set([
  'MY_GEMINI_API_KEY',
  'MY_PERSONAL_GEMINI_API_KEY',
  'YOUR_GEMINI_API_KEY',
  'REPLACE_ME',
  'GEMINI_API_KEY',
]);

/**
 * Resolves a usable Gemini API key from server environment variables,
 * ignoring empty strings, whitespace, and .env.example placeholder tokens.
 */
export function resolveGeminiApiKey(
  env: Record<string, string | undefined> = process.env
): string | null {
  // The standard server key is the supported production source. Keep the
  // personal key only as a backwards-compatible fallback for local setups.
  const candidates = [env.GEMINI_API_KEY, env.GEMINI_API_KEY_PERSONAL];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (PLACEHOLDER_API_KEYS.has(trimmed.toUpperCase())) continue;
    return trimmed;
  }
  return null;
}

/**
 * Sanitizes an upstream error message so secrets or API keys can never leak into server logs.
 */
function sanitizeGeminiLogMessage(err: any): string {
  const raw = typeof err?.message === 'string' ? err.message : String(err || 'Unknown error');
  return raw
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '[REDACTED_KEY]')
    .replace(/([?&]key=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

/**
 * Returns true only for rate-limit / quota exhaustion errors that should trigger a brief cooldown.
 * Timeouts, bad-request payload errors, and transient 5xx errors must NOT block subsequent user retries.
 */
export function shouldTriggerGeminiCooldown(err: any): boolean {
  const status = err?.status;
  const msg = typeof err?.message === 'string' ? err.message : '';
  return (
    status === 429 ||
    /RESOURCE_EXHAUSTED|quota exceeded|rate limit|too many requests|\b429\b/i.test(msg)
  );
}

/**
 * Checks if Gemini client is currently in an active cooldown window.
 * Returns false if cooldown has elapsed or never triggered.
 */
function isGeminiInCooldown(): boolean {
  if (Date.now() >= geminiCooldown.cooldownUntil) {
    return false;
  }
  return true;
}

/**
 * Records a successful Gemini call, resetting backoff and failure counters.
 */
function recordGeminiSuccess() {
  geminiCooldown.consecutiveFailures = 0;
  geminiCooldown.cooldownUntil = 0;
  geminiCooldown.lastErrorCode = null;
  geminiCooldown.lastErrorReason = null;
}

/**
 * Dynamically retrieves Gemini Client using @google/genai SDK.
 * Reads the standard server key first, with the personal key as a backwards-compatible
 * fallback, on each request so key updates in AI Studio Secrets are picked up immediately.
 * Automatically recovers and retries once cooldown window expires or when bypassCooldown is requested.
 */
function getGeminiClient(options?: { bypassCooldown?: boolean }): GoogleGenAI | null {
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) return null;

  if (apiKey !== lastApiKey) {
    lastApiKey = apiKey;
    recordGeminiSuccess();
  }

  // During a rate-limit cooldown window, skip automatic calls unless explicitly retried by the user
  if (!options?.bypassCooldown && isGeminiInCooldown()) {
    return null;
  }

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function logGeminiRequestDiagnostics(params: {
  context: string;
  model: string;
  mimeType?: string;
  base64Length?: number;
  hasAuthUser?: boolean;
}) {
  console.info('[CiviFix] Gemini request', {
    context: params.context,
    model: params.model,
    modelRepaired: GEMINI_MODEL_WAS_REPAIRED,
    apiKeyConfigured: Boolean(resolveGeminiApiKey()),
    authenticated: Boolean(params.hasAuthUser),
    mimeType: params.mimeType || undefined,
    payloadBytesApprox: params.base64Length ? Math.floor((params.base64Length * 3) / 4) : undefined,
  });
}

function handleGeminiError(err: any, context: string) {
  const isTimeout =
    err?.name === 'AbortError' ||
    err?.name === 'TimeoutError' ||
    (typeof err?.message === 'string' && /timed out|timeout|aborted/i.test(err.message));
  const isQuotaOrRateLimit = shouldTriggerGeminiCooldown(err);
  const isPermissionOrAuth =
    err?.status === 401 ||
    err?.status === 403 ||
    (typeof err?.message === 'string' &&
      /PERMISSION_DENIED|API_KEY_INVALID|billing|\b403\b|\b401\b/i.test(err.message));
  const sanitizedDetail = sanitizeGeminiLogMessage(err);

  geminiCooldown.lastErrorCode =
    err?.status || (isTimeout ? 504 : isQuotaOrRateLimit ? 429 : isPermissionOrAuth ? 403 : 500);
  geminiCooldown.lastErrorReason = isTimeout
    ? 'Request timeout'
    : isQuotaOrRateLimit
    ? 'Quota/Rate limit'
    : isPermissionOrAuth
    ? 'Auth/Permission error'
    : 'Service error';

  if (isQuotaOrRateLimit) {
    geminiCooldown.consecutiveFailures++;
    // Short bounded backoff for rate limits only: 10s initial, up to 30s max
    const backoffMs = Math.min(
      30_000,
      10_000 * Math.pow(1.5, Math.min(geminiCooldown.consecutiveFailures - 1, 3))
    );
    geminiCooldown.cooldownUntil = Date.now() + backoffMs;
    console.warn(
      `[CiviFix] Gemini ${context}: ${geminiCooldown.lastErrorReason} (${geminiCooldown.lastErrorCode}). Cooldown active for ${Math.round(
        backoffMs / 1000
      )}s. Detail: ${sanitizedDetail}`
    );
  } else {
    console.warn(
      `[CiviFix] Gemini ${context}: ${geminiCooldown.lastErrorReason} (${geminiCooldown.lastErrorCode}). No global cooldown applied so retries remain immediate. Detail: ${sanitizedDetail}`
    );
  }
}

// Supported canonical civic categories (8 top-level categories)
const VALID_CATEGORIES = [...CANONICAL_CIVIC_CATEGORIES];

/**
 * Endpoint: GET /api/health
 * Phase 7: Unified service health check for Cloud Run and automated monitors.
 * Reports Express uptime, ML supervisor connectivity, and service readiness.
 * STRICTLY avoids exposing API keys, secret tokens, or sensitive environment values.
 */
app.get('/api/health', async (_req, res) => {
  const mlStatus = await mlSupervisor.getSanitizedStatus();
  const geminiConfigured = Boolean(resolveGeminiApiKey());

  return res.status(200).json({
    status: 'healthy',
    service: 'CiviFix AI Gateway',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    environment: process.env.NODE_ENV || 'development',
    services: {
      opencvInspection: {
        isConfigured: mlStatus.isConfigured,
        isRunning: mlStatus.isRunning,
        isHealthy: mlStatus.isHealthy,
        opencvAvailable: mlStatus.opencvAvailable,
        opencvVersion: mlStatus.opencvVersion,
      },
      geminiTriage: {
        isConfigured: geminiConfigured,
        model: GEMINI_MODEL,
      },
      groqVision: {
        isConfigured: Boolean(resolveGroqApiKey()),
        model: GROQ_MODEL,
      },
      openStreetMap: {
        isConfigured: true,
        provider: 'OpenStreetMap Nominatim',
      },
    },
  });
});

/**
 * Internal Python OpenCV Service configuration (loopback port 5001).
 */
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://127.0.0.1:5001';

/**
 * Endpoint: POST /api/image/inspect
 * Phase 5: Forwards complaint photo to internal Python OpenCV service (port 5001).
 * Features:
 * - Enforces 5MB server-side limit (accounting for Base64 overhead)
 * - 3-second timeout via AbortSignal.timeout(3000)
 * - Returns structured advisory warnings (blur, lighting, contrast, resolution)
 * - Generic client errors that do NOT leak stack traces
 * - Non-blocking: report submission remains completely unaffected if service is unavailable
 */
app.post('/api/image/inspect', requireAuth, async (req, res) => {
  const photoBase64 = req.body?.photoBase64 || req.body?.image_base64;

  if (!photoBase64 || typeof photoBase64 !== 'string' || !photoBase64.trim()) {
    return res.status(400).json({
      success: false,
      error: 'Missing required image payload.',
      warnings: [],
      is_advisory_only: true,
    });
  }

  const cleanPayload = photoBase64.trim();

  // Enforce server-side 5MB limit (~6.7MB Base64 string; allow small buffer up to 7.5MB)
  if (cleanPayload.length > 7_500_000) {
    return res.status(400).json({
      success: false,
      error: 'Photo exceeds maximum 5MB size limit. Please choose a smaller photo.',
      warnings: ['Photo exceeds 5MB size limit. Please upload a smaller photo.'],
      is_advisory_only: true,
    });
  }

  // Reject invalid header formats
  if (cleanPayload.startsWith('data:') && !cleanPayload.startsWith('data:image/')) {
    return res.status(400).json({
      success: false,
      error: 'Unsupported file format. Please upload a JPEG, PNG, or WebP image.',
      warnings: ['Unsupported image format. Allowed formats: JPEG, PNG, WebP.'],
      is_advisory_only: true,
    });
  }

  try {
    const mlResponse = await fetch(`${ML_SERVICE_URL}/image/inspect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ image_base64: cleanPayload }),
      signal: AbortSignal.timeout(3000),
    });

    if (!mlResponse.ok) {
      const errData: any = await mlResponse.json().catch(() => ({}));
      return res.status(200).json({
        success: false,
        isAvailable: mlResponse.status !== 503,
        error: errData.error || 'Image quality inspection service could not analyze the image.',
        warnings: errData.warnings || [],
        is_advisory_only: true,
      });
    }

    const data: any = await mlResponse.json();
    return res.status(200).json({
      success: true,
      isAvailable: true,
      quality: data.quality || null,
      warnings: data.warnings || [],
      is_advisory_only: true,
    });
  } catch (err: any) {
    const isTimeout =
      err?.name === 'TimeoutError' ||
      err?.name === 'AbortError' ||
      (typeof err?.message === 'string' && err.message.toLowerCase().includes('timeout'));

    console.info(
      `[CiviFix] Image quality inspection skipped (${isTimeout ? 'timed out after 3s' : 'ML service unreachable'}). Report submission unaffected.`
    );

    // Return friendly advisory fallback so client UI never breaks
    return res.status(200).json({
      success: false,
      isAvailable: false,
      isTimeout: Boolean(isTimeout),
      warnings: [],
      is_advisory_only: true,
      message: 'Image inspection service is currently unavailable. You may proceed with submission.',
    });
  }
});


/**
 * Endpoint: GET /api/maps/reverse-geocode
 * Safely performs server-side reverse geocoding via OpenStreetMap Nominatim.
 * Avoids browser CORS restrictions and does not require a provider API key.
 * If geocoding fails, returns success: false without erroring,
 * preserving manual citizen address entry.
 */
app.get('/api/maps/reverse-geocode', requireAuth, async (req, res) => {
  console.log('[ReverseGeocode] Backend route reached', { lat: req.query.lat, lng: req.query.lng });
  const latStr = req.query.lat as string;
  const lngStr = req.query.lng as string;

  if (!latStr || !lngStr) {
    return res.status(400).json({
      success: false,
      error: 'Missing required query parameters: lat and lng',
    });
  }

  const lat = parseFloat(latStr);
  const lng = parseFloat(lngStr);

  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({
      success: false,
      error: 'Invalid coordinates provided.',
    });
  }

  try {
    const geoUrl = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=18&addressdetails=1`;
    const geoRes = await fetch(geoUrl, {
      headers: {
        'User-Agent': 'CiviFix AI civic location picker',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(4000),
    });

    if (!geoRes.ok) {
      return res.status(200).json({
        success: false,
        isConfigured: true,
        address: null,
        message: `OpenStreetMap geocoding HTTP ${geoRes.status}`,
      });
    }

    const data: any = await geoRes.json();
    if (typeof data?.display_name === 'string' && data.display_name.trim()) {
      return res.status(200).json({
        success: true,
        isConfigured: true,
        address: data.display_name,
        placeId: data.osm_id ? String(data.osm_id) : undefined,
      });
    }

    return res.status(200).json({
      success: false,
      isConfigured: true,
      address: null,
      status: data?.error || 'NO_RESULT',
      message: data?.error || 'No address found for these coordinates.',
    });
  } catch (err: any) {
    console.warn('[CiviFix] OpenStreetMap reverse geocoding failed', { reason: String(err?.message || err).slice(0, 160) });
    return res.status(200).json({
      success: false,
      isConfigured: true,
      address: null,
      message: 'OpenStreetMap geocoding request timed out or network error.',
    });
  }
});

/**
 * Endpoint: POST /api/gemini/analyze-issue
 * Analyzes civic issue description and optional photo.
 * Returns suggested category, whether it matches citizen selection,
 * recommended severity, and confidence (or null if not measurable).
 */
app.post('/api/gemini/analyze-issue', requireAuth, async (req, res) => {
  const { description, selectedCategory, photoBase64, forceRefresh } = req.body || {};

  const trimmedDescription = typeof description === 'string' ? description.trim() : '';
  const parsedImg =
    photoBase64 && typeof photoBase64 === 'string' ? parseImagePayload(photoBase64) : null;

  if (!trimmedDescription && !parsedImg) {
    return res.status(400).json({
      success: false,
      error: 'Issue description or photograph is required for AI triage.',
      isFallback: true,
      confidence: null,
      confidenceLevel: null,
    });
  }

  const normalizedSelectedCategory = selectedCategory
    ? mapToCanonicalCategory(selectedCategory)
    : 'Other civic issues';

  const buildAnalyzeFallback = () => ({
    success: false,
    isFallback: true,
    suggestedCategory: normalizedSelectedCategory,
    suggestedExpandedCategory: normalizedSelectedCategory,
    categoryMatch: true,
    severity: 'Medium' as const,
    suggestedSeverity: 'Medium' as const,
    severityReason:
      'Default Medium severity assigned because live AI triage is temporarily unavailable.',
    detectedIssueType: selectedCategory
      ? `${normalizedSelectedCategory} (Citizen Selection)`
      : 'Civic Issue',
    shortExplanation:
      'Live AI triage is currently unavailable; your selected category and details were preserved for review.',
    suggestedTitle: `${normalizedSelectedCategory} issue reported for inspection`,
    suggestedDescription:
      trimmedDescription ||
      `Citizen reported a ${normalizedSelectedCategory.toLowerCase()} issue for municipal inspection.`,
    confidence: null,
    confidenceLevel: null,
    aiNotes: 'Standard category and severity assigned based on citizen selection.',
  });

  const ai = getGeminiClient({ bypassCooldown: Boolean(forceRefresh) });
  if (!ai) {
    return res.status(200).json(buildAnalyzeFallback());
  }

  try {
    const prompt = `You are a municipal civic issue triage assistant for CiviFix AI.
Analyze the citizen issue report using BOTH the written context and any attached photograph.

Description: "${trimmedDescription || 'No written description provided yet; rely on visible evidence in the photograph.'}"
Citizen Selected Category: "${selectedCategory || 'Unknown'}"

Allowed Categories (8 canonical top-level categories): ${JSON.stringify(VALID_CATEGORIES)}
Category guidance:
- "Garbage accumulation": piled/scattered municipal waste, illegal dumping, roadside trash heaps
- "Overflowing dustbins": public dustbins/dumpsters overflowing with trash spilling around them
- "Potholes": distinct road cavities, deep potholes, sunken asphalt holes
- "Damaged roads": widespread road cracks, broken/eroded asphalt, buckled road surface
- "Drainage problems": blocked drains, clogged grates, sewage overflow, stagnant water, waterlogging
- "Water leakage": leaking water pipes, burst mains, leaking standposts/valves, clean water wastage
- "Streetlight problems": broken, leaning, shattered, flickering, or unlit streetlights
- "Other civic issues": damaged footpaths, fallen trees, broken public benches/signs, or other civic infrastructure defects

Allowed Severity: ["Low", "Medium", "High"]
Allowed confidenceLevel: ["Low", "Medium", "High"] or null if uncertain.

Instructions:
1. Determine the single most accurate civic category from the 8 Allowed Categories.
2. Determine if the citizen selected category aligns with your assessment (comparing equivalent legacy/expanded names fairly).
3. Estimate suggestedSeverity ("Low", "Medium", or "High") and explain why in severityReason (1 concise sentence).
4. Provide detectedIssueType (specific visible/reported problem label) and shortExplanation (1-2 crisp sentences).
5. Draft suggestedTitle (4-10 words, no invented street names) and suggestedDescription (2-3 factual sentences).
6. Set confidenceLevel to "High", "Medium", or "Low" when supported by evidence, or null when uncertain.
7. Provide a brief 1-2 sentence municipal triageNote.

Return JSON adhering to the specified schema.`;

    const parts: any[] = [];
    if (parsedImg) {
      parts.push({
        inlineData: {
          mimeType: parsedImg.mimeType,
          data: parsedImg.cleanBase64,
        },
      });
    }
    parts.push({ text: prompt });

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: { parts },
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            suggestedCategory: {
              type: Type.STRING,
              description: 'The suggested category from the 8 allowed canonical categories.',
            },
            categoryAgreement: {
              type: Type.BOOLEAN,
              description: 'Whether the citizen selected category matches the AI assessment.',
            },
            suggestedSeverity: {
              type: Type.STRING,
              description: 'Automatic severity assessment: Low, Medium, or High.',
            },
            severity: {
              type: Type.STRING,
              description: 'Low, Medium, or High severity.',
            },
            severityReason: {
              type: Type.STRING,
              description: 'One-sentence explanation for the estimated severity level.',
            },
            detectedIssueType: {
              type: Type.STRING,
              description: 'Specific civic issue subtype detected or described.',
            },
            shortExplanation: {
              type: Type.STRING,
              description: 'Concise 1-2 sentence citizen-facing explanation of the detected issue.',
            },
            suggestedTitle: {
              type: Type.STRING,
              description: 'Concise 4-10 word complaint title.',
            },
            suggestedDescription: {
              type: Type.STRING,
              description: 'Clear 2-3 sentence complaint description grounded in facts.',
            },
            confidenceLevel: {
              type: Type.STRING,
              description: 'Low, Medium, or High when measurable; otherwise null.',
              nullable: true,
            },
            triageNote: {
              type: Type.STRING,
              description: 'Brief 1-2 sentence municipal triage note explaining the classification.',
            },
          },
          required: [
            'suggestedCategory',
            'categoryAgreement',
            'suggestedSeverity',
            'severityReason',
            'detectedIssueType',
            'shortExplanation',
            'suggestedTitle',
            'suggestedDescription',
            'triageNote',
          ],
        },
      },
    });

    recordGeminiSuccess();
    const rawText = response.text?.trim() || '';
    let parsed: any = {};
    try {
      parsed = JSON.parse(rawText);
    } catch {
      const clean = rawText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      parsed = JSON.parse(clean);
    }

    const suggestedCategory = mapToCanonicalCategory(
      parsed.suggestedCategory || parsed.detectedIssueType
    );
    const suggestedSeverity = normalizeSeverity(parsed.suggestedSeverity || parsed.severity);
    const confidenceLevel = normalizeConfidenceLevel(parsed.confidenceLevel);
    const categoryMatch =
      typeof parsed.categoryAgreement === 'boolean'
        ? parsed.categoryAgreement
        : !selectedCategory || normalizedSelectedCategory === suggestedCategory;
    const detectedIssueType =
      (typeof parsed.detectedIssueType === 'string' && parsed.detectedIssueType.trim()) ||
      suggestedCategory;
    const shortExplanation =
      (typeof parsed.shortExplanation === 'string' && parsed.shortExplanation.trim()) ||
      (typeof parsed.triageNote === 'string' && parsed.triageNote.trim()) ||
      `Classified as ${suggestedCategory} based on submitted evidence.`;
    const severityReason =
      (typeof parsed.severityReason === 'string' && parsed.severityReason.trim()) ||
      `${suggestedSeverity} severity assessed from the reported ${suggestedCategory.toLowerCase()} details.`;
    const suggestedTitle =
      (typeof parsed.suggestedTitle === 'string' && parsed.suggestedTitle.trim()) ||
      `${detectedIssueType} reported for municipal action`;
    const suggestedDescription =
      (typeof parsed.suggestedDescription === 'string' && parsed.suggestedDescription.trim()) ||
      trimmedDescription ||
      shortExplanation;

    return res.status(200).json({
      success: true,
      isFallback: false,
      suggestedCategory,
      suggestedExpandedCategory: suggestedCategory,
      categoryMatch,
      severity: suggestedSeverity,
      suggestedSeverity,
      severityReason,
      detectedIssueType,
      shortExplanation,
      suggestedTitle,
      suggestedDescription,
      confidence: confidenceLevel,
      confidenceLevel,
      aiNotes: parsed.triageNote || shortExplanation,
    });
  } catch (err: any) {
    handleGeminiError(err, 'analyze-issue');
    return res.status(200).json(buildAnalyzeFallback());
  }
});

export const GEMINI_IMAGE_VALIDATION_DEADLINE_MS = 18_000;
export const GEMINI_IMAGE_VALIDATION_ATTEMPT_TIMEOUT_MS = 12_000;
export const GEMINI_IMAGE_VALIDATION_MAX_ATTEMPTS = 2;

/** POST /api/groq/validate-civic-image — authenticated Groq Vision civic triage. */
app.post('/api/groq/validate-civic-image', requireAuth, async (req, res) => {
  const { photoBase64, description, selectedCategory, qualitySummary } = req.body || {};
  if (!photoBase64 || typeof photoBase64 !== 'string' || !photoBase64.trim()) {
    return res.status(400).json({ success: false, code: 'INVALID_IMAGE', error: 'A photograph payload is required.' });
  }
  if (photoBase64.length > 7_500_000) {
    return res.status(413).json({ success: false, code: 'IMAGE_TOO_LARGE', error: 'Photo exceeds the maximum size limit.' });
  }
  const parsedImg = parseImagePayload(photoBase64);
  if (!parsedImg || !GROQ_SUPPORTED_IMAGE_MIME_TYPES.has(parsedImg.mimeType)) {
    return res.status(400).json({ success: false, code: 'UNSUPPORTED_IMAGE', error: 'Only JPEG and PNG images are supported for Groq analysis.' });
  }
  const apiKey = resolveGroqApiKey();
  console.info('[CiviFix] Grok Vision request', {
    model: GROQ_MODEL,
    mimeType: parsedImg.mimeType,
    payloadBytesApprox: Math.floor((parsedImg.cleanBase64.length * 3) / 4),
    authenticated: Boolean(req.user?.uid),
    apiKeyConfigured: Boolean(apiKey),
  });
  if (!apiKey) {
    return res.status(503).json({ success: false, code: 'NOT_CONFIGURED', error: 'Live photo analysis is not configured.' });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const result = await requestGroqCivicImageAnalysis({
      apiKey,
      model: GROQ_MODEL,
      imageDataUrl: `data:${parsedImg.mimeType};base64,${parsedImg.cleanBase64}`,
      prompt: buildCivicValidationPrompt({ description, selectedCategory, qualitySummary }) +
        '\nAlso provide civic awareness: why this issue is harmful, how citizens can prevent it, and what citizens should responsibly do. Name a responsible department only when identifiable from the visible issue.',
      qualitySummary,
      signal: controller.signal,
    });
    return res.status(200).json({ success: true, ...result });
  } catch (err: any) {
    const groqError = err instanceof GroqVisionError ? err : new GroqVisionError('PROVIDER_UNAVAILABLE', 'Groq image analysis failed.');
    console.warn('[CiviFix] Grok Vision request failed', {
      code: groqError.code,
      status: groqError.status || null,
      providerType: groqError.providerType || null,
      providerMessage: groqError.message.slice(0, 300),
      model: GROQ_MODEL,
      mimeType: parsedImg.mimeType,
    });
    const status = groqError.code === 'TIMEOUT' ? 504 : groqError.code === 'RATE_LIMITED' ? 429 :
      groqError.code === 'AUTHENTICATION_FAILED' ? 502 : groqError.code === 'QUOTA_EXCEEDED' ? 503 :
      groqError.code === 'INVALID_RESPONSE' ? 502 : groqError.code === 'INVALID_REQUEST' ? 400 : 503;
    return res.status(status).json({ success: false, code: groqError.code, error: groqError.message });
  } finally {
    clearTimeout(timer);
  }
});

const CIVIC_IMAGE_VALIDATION_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    decision: {
      type: Type.STRING,
      description:
        'One of VALID_CIVIC_ISSUE, UNRELATED_IMAGE, UNCLEAR_IMAGE, POSSIBLE_CIVIC_ISSUE_NEEDS_REVIEW',
    },
    isCivicIssue: {
      type: Type.BOOLEAN,
      description: 'True if image shows a civic defect, false if clearly unrelated/non-civic',
    },
    issueDetected: {
      type: Type.STRING,
      description: 'Short label of visible problem, Needs Review, or Non-Civic',
    },
    detectedIssueType: {
      type: Type.STRING,
      description: 'Specific visible civic issue subtype detected in the photograph',
    },
    primaryCategory: {
      type: Type.STRING,
      description:
        'One of: Garbage accumulation, Overflowing dustbins, Potholes, Damaged roads, Drainage problems, Water leakage, Streetlight problems, Other civic issues, or Unrelated / Non-Civic',
    },
    visualSubType: {
      type: Type.STRING,
      description:
        'Specific subtype such as Pothole, Road cracks, Garbage dumping, Overflowing dustbin, Blocked drain, Sewage overflow, Waterlogging, Water leakage, Broken streetlight, Damaged footpath, Fallen tree, Damaged public infrastructure, or Needs Review',
    },
    suggestedSeverity: {
      type: Type.STRING,
      description: 'Automatic severity assessment: Low, Medium, or High',
    },
    severityReason: {
      type: Type.STRING,
      description: 'One clear sentence explaining why the severity level was chosen',
    },
    shortExplanation: {
      type: Type.STRING,
      description: 'Short 1-2 sentence explanation of the detected civic issue',
    },
    suggestedTitle: {
      type: Type.STRING,
      description: 'Suggested 4-10 word complaint title for the citizen to review or edit',
    },
    suggestedDescription: {
      type: Type.STRING,
      description: 'Suggested 2-3 sentence complaint description grounded in visible evidence',
    },
    confidenceLevel: {
      type: Type.STRING,
      description: 'Low, Medium, or High when evidence supports it; otherwise null',
      nullable: true,
    },
    detectedObjects: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    visibleObservations: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Only directly visible facts in the pixels without guessing hidden faults',
    },
    aiAssumptions: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Clearly tentative possible causes not directly visible in pixels',
    },
    visualEvidence: {
      type: Type.STRING,
    },
    potentialPublicImpact: {
      type: Type.STRING,
    },
    explanation: {
      type: Type.STRING,
    },
    recommendedActions: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    safetyPrecautions: {
      type: Type.STRING,
    },
    confidencePercent: {
      type: Type.INTEGER,
      description: '50-95 if clear, 0 if uncertain',
    },
    defectBoundingBoxes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          ymin: { type: Type.INTEGER },
          xmin: { type: Type.INTEGER },
          ymax: { type: Type.INTEGER },
          xmax: { type: Type.INTEGER },
          label: { type: Type.STRING },
        },
        required: ['ymin', 'xmin', 'ymax', 'xmax'],
      },
    },
  },
  required: [
    'decision',
    'isCivicIssue',
    'issueDetected',
    'detectedIssueType',
    'primaryCategory',
    'suggestedSeverity',
    'severityReason',
    'shortExplanation',
    'suggestedTitle',
    'suggestedDescription',
    'visibleObservations',
    'explanation',
    'recommendedActions',
    'safetyPrecautions',
  ],
};

export async function generateCivicImageValidationWithDeadline(params: {
  ai: Pick<GoogleGenAI, 'models'>;
  parsedImg: { mimeType: string; cleanBase64: string };
  prompt: string;
  model?: string;
  deadlineMs?: number;
  attemptTimeoutMs?: number;
  maxAttempts?: number;
}) {
  const {
    ai,
    parsedImg,
    prompt,
    model = GEMINI_MODEL,
    deadlineMs = GEMINI_IMAGE_VALIDATION_DEADLINE_MS,
    attemptTimeoutMs = GEMINI_IMAGE_VALIDATION_ATTEMPT_TIMEOUT_MS,
    maxAttempts = GEMINI_IMAGE_VALIDATION_MAX_ATTEMPTS,
  } = params;

  const deadlineController = new AbortController();
  const boundedAttemptTimeoutMs = Math.min(attemptTimeoutMs, deadlineMs);
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let abortRejectListener: (() => void) | null = null;

  const deadlinePromise = new Promise<never>((_, reject) => {
    abortRejectListener = () => {
      const abortErr: any = new Error(`Gemini Vision validation timed out after ${deadlineMs}ms`);
      abortErr.name = 'AbortError';
      reject(abortErr);
    };
    deadlineController.signal.addEventListener('abort', abortRejectListener, { once: true });
  });

  deadlineTimer = setTimeout(() => {
    const abortErr: any = new Error(`Gemini Vision validation timed out after ${deadlineMs}ms`);
    abortErr.name = 'AbortError';
    deadlineController.abort(abortErr);
  }, deadlineMs);

  try {
    const generatePromise = ai.models.generateContent({
      model,
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: parsedImg.mimeType,
              data: parsedImg.cleanBase64,
            },
          },
          { text: prompt },
        ],
      },
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        abortSignal: deadlineController.signal,
        httpOptions: {
          timeout: boundedAttemptTimeoutMs,
          retryOptions: {
            attempts: maxAttempts,
            initialDelay: 0.4,
            maxDelay: 1.0,
          },
        },
        responseMimeType: 'application/json',
        responseSchema: CIVIC_IMAGE_VALIDATION_RESPONSE_SCHEMA,
      },
    });

    return await Promise.race([generatePromise, deadlinePromise]);
  } finally {
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer);
    }
    if (abortRejectListener) {
      deadlineController.signal.removeEventListener('abort', abortRejectListener);
    }
  }
}

/**
 * Legacy Gemini implementation retained temporarily for backward-compatible server-side tests.
 * The application route is /api/groq/validate-civic-image; no frontend code calls this route.
 * to verify whether the image depicts a genuine civic problem, detect unrelated images,
 * separate visible observations from assumptions, evaluate cultural/religious photos neutrally,
 * and route uncertain photos to "Needs Review".
 */
app.post('/api/gemini/validate-civic-image-legacy', requireAuth, async (req, res) => {
  const { photoBase64, description, selectedCategory, qualitySummary, forceRefresh } = req.body || {};

  if (!photoBase64 || typeof photoBase64 !== 'string' || !photoBase64.trim()) {
    return res.status(400).json({
      success: false,
      error: 'A photograph payload is required for image verification.',
    });
  }

  if (photoBase64.length > 7_500_000) {
    return res.status(400).json({
      success: false,
      error: 'Photo exceeds maximum 5MB size limit. Please upload a smaller image.',
    });
  }

  const parsedImg = parseImagePayload(photoBase64);
  if (!parsedImg) {
    return res.status(400).json({
      success: false,
      error: 'Unsupported or invalid image encoding. Allowed formats: JPEG, PNG, WebP.',
    });
  }

  logGeminiRequestDiagnostics({
    context: 'validate-civic-image',
    model: GEMINI_MODEL,
    mimeType: parsedImg.mimeType,
    base64Length: parsedImg.cleanBase64.length,
    hasAuthUser: Boolean(req.user?.uid),
  });

  const ai = getGeminiClient({ bypassCooldown: Boolean(forceRefresh) });
  if (!ai) {
    return res.status(200).json(
      buildFallbackValidationResult({
        selectedCategory,
        description,
        qualitySummary,
        reason: 'Live AI image verification is temporarily unavailable or resting between requests.',
      })
    );
  }

  try {
    const prompt = buildCivicValidationPrompt({
      description,
      selectedCategory,
      qualitySummary,
    });

    const response = await generateCivicImageValidationWithDeadline({
      ai,
      parsedImg,
      prompt,
      model: GEMINI_MODEL,
    });

    recordGeminiSuccess();
    const rawText = response.text?.trim() || '{}';
    let parsed: any = {};
    try {
      parsed = JSON.parse(rawText);
    } catch {
      const clean = rawText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      try {
        parsed = JSON.parse(clean);
      } catch (parseErr: any) {
        console.warn('[CiviFix] Gemini validate-civic-image response parse failed', {
          model: GEMINI_MODEL,
          responseLength: rawText.length,
          detail: sanitizeGeminiLogMessage(parseErr),
        });
        throw parseErr;
      }
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Gemini returned an invalid civic validation object');
    }

    const result = normalizeCivicValidationResponse({
      parsed,
      qualitySummary,
      modelUsed: GEMINI_MODEL,
    });

    return res.status(200).json(result);
  } catch (err: any) {
    handleGeminiError(err, 'validate-civic-image');
    const isTimeout =
      err?.name === 'AbortError' ||
      err?.name === 'TimeoutError' ||
      (typeof err?.message === 'string' && /timed out|timeout|aborted/i.test(err.message));
    return res.status(200).json(
      buildFallbackValidationResult({
        selectedCategory,
        description,
        qualitySummary,
        reason: isTimeout
          ? 'Automatic photo detection took too long. Your photograph is saved for manual review or you can retry.'
          : 'Live AI image analysis encountered a temporary delay. You can retry or proceed with manual review.',
      })
    );
  }
});

interface ChatContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

export const SUPPORTED_CHAT_LANGUAGES: Record<
  string,
  { name: string; nativeName: string; script: string; promptNote: string }
> = {
  en: {
    name: 'English',
    nativeName: 'English',
    script: 'Latin script',
    promptNote: 'Respond in clear, natural, and grammatically correct English.',
  },
  hi: {
    name: 'Hindi',
    nativeName: 'हिन्दी',
    script: 'Devanagari script',
    promptNote: 'You MUST respond entirely and fluently in Hindi (हिन्दी) using native Devanagari script. Do not write Hindi in Latin/English alphabets.',
  },
  te: {
    name: 'Telugu',
    nativeName: 'తెలుగు',
    script: 'Telugu script',
    promptNote: 'You MUST respond entirely and fluently in Telugu (తెలుగు) using native Telugu script. Do not write Telugu in English alphabets.',
  },
  ta: {
    name: 'Tamil',
    nativeName: 'தமிழ்',
    script: 'Tamil script',
    promptNote: 'You MUST respond entirely and fluently in Tamil (தமிழ்) using native Tamil script. Do not write Tamil in English alphabets.',
  },
  kn: {
    name: 'Kannada',
    nativeName: 'ಕನ್ನಡ',
    script: 'Kannada script',
    promptNote: 'You MUST respond entirely and fluently in Kannada (ಕನ್ನಡ) using native Kannada script. Do not write Kannada in English alphabets.',
  },
};

/**
 * Generates civic assistant system instructions customized for the selected language.
 */
export function buildCivicSystemInstruction(language: string = 'en'): string {
  const langKey = typeof language === 'string' ? language.trim().toLowerCase() : 'en';
  const lang = SUPPORTED_CHAT_LANGUAGES[langKey] || SUPPORTED_CHAT_LANGUAGES.en;

  return `You are CiviFix AI, a knowledgeable, friendly, and practical conversational civic assistant.

CIVIC EXPERTISE & MUNICIPAL SAFEGUARDS:
- Focus strictly on civic issues: garbage disposal, waste segregation (2-Bin 1-Bag system), potholes, road craters, drainage, water leakage, broken streetlights, public sanitation, hygiene, and municipal services.
- Give practical, clear, structured, and responsible guidance.
- Detail the standard 2-Bin 1-Bag waste segregation system:
  • Green Bin (Wet Waste): organic kitchen food scraps, vegetable peels, garden waste.
  • Blue Bin (Dry Recyclables): clean paper, cardboard, plastics, cans, bottles, metals. Food waste must NEVER enter the Blue Bin.
  • Red Bag (Domestic Hazardous / Sanitary): diapers, sanitary pads, expired medicines, broken glass.
  • E-Waste (E-Drop): discarded electronics (old phones, batteries, chargers, cables) must be delivered to designated municipal e-waste collection centers or quarterly ward e-drives.
- Accurately explain CiviFix application navigation:
  • To report an issue: tap the "+ Report" screen at the bottom, take a clear photo safely from the sidewalk, confirm GPS/address and ward, select category and severity, and submit.
  • To track an issue: open the "My Reports" screen at the bottom to view real-time status transitions (Submitted -> Under Review -> In Progress -> Resolved).
  • To follow up: open any pending ticket in "My Reports" and use "Add Note" to append follow-up photos or citizen remarks.
- NEVER invent government schemes, official phone numbers, municipal contact emails, emergency hotlines, or fake complaint numbers.
- Do NOT claim that a complaint has been submitted or resolved unless the user or application explicitly confirms it.
- Remind citizens to photograph road and drainage hazards safely from sidewalks, never in active vehicle traffic.

CONVERSATION BEHAVIOUR & MULTI-TURN CONTEXT MEMORY:
- Remember and actively use previous messages in the current conversation.
- Understand and resolve follow-up questions such as "What should I do next?", "Explain that", "How can I report it?", "What about its battery?", "Where can I take it?", and pronouns ("it", "them", "this", "there").
- Avoid repeating the same full answer unnecessarily; provide the logical next step or relevant follow-up clarification.
- Ask a short clarification question only when essential information is genuinely missing.
- Be polite, concise, and helpful.

NON-CIVIC QUESTIONS:
- Politely explain that you specialize in municipal civic issues and waste management, and redirect the user back to civic assistance (e.g., reporting road hazards, water leaks, or waste segregation).
- Do not provide lengthy unrelated answers.

MULTILINGUAL SUPPORT:
- The user has currently selected: ${lang.name} (${lang.nativeName}).
- ${lang.promptNote}
- Do not randomly mix languages or switch to English unless requested.
- If conversation history contains messages in a different language, seamlessly maintain continuity and answer in ${lang.name} (${lang.nativeName}).
- If the user writes in a language outside the five supported languages (English, Hindi, Telugu, Tamil, Kannada), politely ask them to select one of the five supported languages.`;
}

/**
 * Validates and sanitizes multi-turn chat history for @google/genai SDK:
 * 1. History items must have non-empty text strings and valid roles.
 * 2. Consecutive messages from the same role are coalesced into a single entry.
 * 3. The history sequence begins with role: 'user' (leading model greetings are omitted).
 * 4. Trailing user messages (including current user message if pre-appended) are removed from
 *    history so that chat.sendMessage() appends the user message exactly once.
 * 5. Roles strictly alternate: user -> model -> user -> model.
 * 6. History is bounded to the 10 most recent alternating turns.
 */
export function sanitizeConversationHistory(history: any[], currentMessage?: string): ChatContent[] {
  if (!Array.isArray(history) || history.length === 0) {
    return [];
  }

  const rawEntries: Array<{ role: 'user' | 'model'; text: string }> = [];

  for (const item of history) {
    if (!item || typeof item !== 'object') continue;
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!text) continue;
    const role: 'user' | 'model' =
      item.role === 'user' || item.sender === 'user' ? 'user' : 'model';
    rawEntries.push({ role, text });
  }

  if (rawEntries.length === 0) {
    return [];
  }

  // Coalesce consecutive messages from the same role
  const coalesced: Array<{ role: 'user' | 'model'; text: string }> = [];
  for (const entry of rawEntries) {
    if (coalesced.length > 0 && coalesced[coalesced.length - 1].role === entry.role) {
      coalesced[coalesced.length - 1].text += '\n' + entry.text;
    } else {
      coalesced.push({ ...entry });
    }
  }

  // Ensure history sequence starts with role 'user'
  while (coalesced.length > 0 && coalesced[0].role !== 'user') {
    coalesced.shift();
  }

  // If the last entry in history is a 'user' turn (e.g. if caller pre-appended current message,
  // or a trailing unresponded user turn exists), drop it so chat.sendMessage() appends current user message exactly once.
  if (coalesced.length > 0 && coalesced[coalesced.length - 1].role === 'user') {
    coalesced.pop();
  }

  // Ensure history ends with role 'model' before chat.sendMessage
  while (coalesced.length > 0 && coalesced[coalesced.length - 1].role !== 'model') {
    coalesced.pop();
  }

  // Limit to most recent 10 alternating turns (5 complete conversational rounds)
  const bounded = coalesced.slice(-10);

  return bounded.map((entry) => ({
    role: entry.role,
    parts: [{ text: entry.text }],
  }));
}

/**
 * Endpoint: POST /api/gemini/chat
 * Handles multi-turn conversational civic guidance with multilingual support and offline fallback.
 */
app.post('/api/gemini/chat', requireAuth, async (req, res) => {
  const { message, history, language } = req.body || {};

  // 1. Validate user message
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message text is required.' });
  }

  if (message.length > 4000) {
    return res.status(400).json({ error: 'Message text exceeds the maximum limit of 4000 characters.' });
  }

  // 2. Validate conversation history if provided
  if (history !== undefined && history !== null) {
    if (!Array.isArray(history)) {
      return res.status(400).json({ error: 'History must be an array of conversation turns.' });
    }

    if (history.length > 50) {
      return res.status(400).json({ error: 'History exceeds the maximum limit of 50 messages.' });
    }

    for (let i = 0; i < history.length; i++) {
      const item = history[i];
      if (!item || typeof item !== 'object') {
        return res.status(400).json({ error: `History entry at index ${i} is not a valid object.` });
      }
      const role = item.role || item.sender;
      if (role !== 'user' && role !== 'model' && role !== 'assistant') {
        return res.status(400).json({
          error: `History entry at index ${i} contains an invalid role '${role}'. Role must be 'user' or 'model'.`,
        });
      }
      if (typeof item.text !== 'string') {
        return res.status(400).json({ error: `History entry at index ${i} text must be a string.` });
      }
      if (item.text.length > 4000) {
        return res.status(400).json({ error: `History entry at index ${i} text exceeds 4000 characters.` });
      }
    }
  }

  const selectedLanguage = typeof language === 'string' && SUPPORTED_CHAT_LANGUAGES[language.toLowerCase()]
    ? language.toLowerCase()
    : 'en';

  const ai = getGeminiClient();
  if (!ai || isGeminiInCooldown()) {
    const matched = searchCivicKnowledge(message, history);
    let reply = matched
      ? matched.answer
      : 'I am the CiviFix Civic Assistant. You can report civic problems (garbage overflow, road potholes, water leaks, blocked stormwater drains, broken streetlights) using the "Report" screen, and review category prevention guides right inside the form.';

    if (selectedLanguage !== 'en') {
      const notices: Record<string, string> = {
        hi: '\n\n[नोट: यह CiviFix नागरिक ज्ञानकोश से ऑफलाइन उत्तर है।]',
        te: '\n\n[గమనిక: ఇది CiviFix పౌర నాలెడ్జ్ బేస్ నుండి ఆఫ్‌లైన్ సమాధానం.]',
        ta: '\n\n[குறிப்பு: இது CiviFix குடிமை அறிவுத்தளத்தின் ஆஃப்லைன் பதில்.]',
        kn: '\n\n[ಗಮನಿಸಿ: ಇದು CiviFix ನಾಗರಿಕ ಜ್ಞಾನಕೋಶದಿಂದ ಆಫ್‌ಲೈನ್ ಉತ್ತರವಾಗಿದೆ.]',
      };
      if (notices[selectedLanguage]) {
        reply += notices[selectedLanguage];
      }
    }

    return res.status(200).json({
      reply,
      isFallback: true,
      fallbackTopic: matched ? matched.title : 'Civic Knowledge Base',
      intent: matched?.intent,
      suggestedAction: matched?.suggestedAction,
      language: selectedLanguage,
    });
  }

  try {
    const formattedHistory = sanitizeConversationHistory(history, message.trim());
    const systemInstruction = buildCivicSystemInstruction(selectedLanguage);

    const chat = ai.chats.create({
      model: GEMINI_MODEL,
      history: formattedHistory,
      config: {
        systemInstruction,
      },
    });

    const response = await chat.sendMessage({
      message: message.trim(),
    });

    const replyText = response.text?.trim() || 'I am here to help with civic guidelines and issue reporting.';
    recordGeminiSuccess();

    return res.status(200).json({
      reply: replyText,
      isFallback: false,
      language: selectedLanguage,
    });
  } catch (err: any) {
    handleGeminiError(err, 'chat');

    // Provide intelligent, domain-specific civic fallback response
    const matched = searchCivicKnowledge(message, history);
    let reply = matched
      ? matched.answer
      : 'I am the CiviFix Civic Assistant. You can report civic problems (garbage overflow, road potholes, water leaks, blocked stormwater drains, broken streetlights) using the "Report" screen, and review category prevention guides right inside the form.';

    if (selectedLanguage !== 'en') {
      const notices: Record<string, string> = {
        hi: '\n\n[नोट: यह CiviFix नागरिक ज्ञानकोश से ऑफलाइन उत्तर है।]',
        te: '\n\n[గమనిక: ఇది CiviFix పౌర నాలెడ్జ్ బేస్ నుండి ఆఫ్‌లైన్ సమాధానం.]',
        ta: '\n\n[குறிப்பு: இது CiviFix குடிமை அறிவுத்தளத்தின் ஆஃப்லைன் பதில்.]',
        kn: '\n\n[ಗಮನಿಸಿ: ಇದು CiviFix ನಾಗರಿಕ ಜ್ಞಾನಕೋಶದಿಂದ ಆಫ್‌ಲೈನ್ ಉತ್ತರವಾಗಿದೆ.]',
      };
      if (notices[selectedLanguage]) {
        reply += notices[selectedLanguage];
      }
    }

    return res.status(200).json({
      reply,
      isFallback: true,
      fallbackTopic: matched ? matched.title : 'Civic Knowledge Base',
      intent: matched?.intent,
      suggestedAction: matched?.suggestedAction,
      language: selectedLanguage,
    });
  }
});

/**
 * Endpoint: POST /api/civic/visualize-improvement
 * Same-image Before & After illustrative improvement preview across ALL civic categories:
 * Garbage dumping/overflowing bins, potholes/road cracks, blocked drains/sewage overflow,
 * water leakage/waterlogging, broken streetlights, damaged footpaths, fallen trees, damaged public property.
 * Uses the EXACT original photograph as the reference and preserves all unaffected surroundings.
 * If defect localization / image editing cannot run safely, returns an explicit unavailable state
 * rather than substituting any unrelated image.
 */
app.post('/api/civic/visualize-improvement', requireAuth, async (req, res) => {
  const {
    photoBase64,
    category = 'Other',
    visualSubType = '',
    description = '',
    detectedBoxes = [],
  } = req.body || {};

  if (!photoBase64 || typeof photoBase64 !== 'string' || !photoBase64.trim()) {
    return res.status(400).json({
      error: 'Citizen photograph is required to generate an improvement preview.',
    });
  }

  const parsedImg = parseImagePayload(photoBase64);
  if (!parsedImg) {
    return res.status(400).json({
      error: 'Invalid or unsupported image encoding.',
    });
  }

  const disclaimer = BEFORE_AFTER_DISCLAIMER;
  const canonicalCategory = mapToCanonicalCategory(category);
  let effectiveBoxes: BoundingBox[] = Array.isArray(detectedBoxes)
    ? detectedBoxes
        .map((b: any) => ({
          ymin: Number(b.ymin) || 0,
          xmin: Number(b.xmin) || 0,
          ymax: Number(b.ymax) || 0,
          xmax: Number(b.xmax) || 0,
          label: b.label || canonicalCategory,
        }))
        .filter((b: BoundingBox) => b.ymax > b.ymin && b.xmax > b.xmin)
    : [];

  let identifiedIssues: string[] = [];
  let recommendedActions: string[] = [];
  let environmentalBenefit = '';
  let resolvedSubType = visualSubType || canonicalCategory;
  let isRegionClear = true;
  let unclearReason = '';

  const ai = getGeminiClient();

  // Reuse detectedBoxes from prior validation call when present to avoid redundant Gemini requests
  if (effectiveBoxes.length === 0 && ai && !isGeminiInCooldown()) {
    try {
      const prompt = `You are a civic infrastructure visual localization assistant.
Locate the primary visible civic defect in THIS EXACT photograph so only that damaged/polluted area can be visually restored in a Before & After preview, leaving buildings, cars, sky, and surroundings untouched.

Reported Category: "${canonicalCategory}" (${visualSubType || 'General'})
Citizen Note: "${typeof description === 'string' ? description.trim().slice(0, 240) : ''}"

Target defect types:
- Garbage accumulation: scattered waste piles, illegal dumping, litter heaps
- Overflowing dustbins: overflowing municipal dustbins, spilled garbage around containers
- Potholes: pothole cavity or deep sunken asphalt hole
- Damaged roads: road surface cracks, crumbled/eroded asphalt, broken road edges
- Drainage problems: clogged drain grates, sewage overflow, stagnant water, or waterlogging patch
- Water leakage: leaking spray/puddle around municipal water supply pipe or valve
- Streetlight problems: broken, leaning, or dark streetlamp fixture area
- Other civic issues: damaged footpath tiles, fallen branches, damaged signs or public property

Rules:
1. Only localize what is visibly present. If the defect is too blurry or ambiguous to isolate safely, set isRegionClear: false.
2. Provide 1-3 normalized boxes [ymin, xmin, ymax, xmax] in 0..1000 covering ONLY the defect itself (<= 60% of image).
Return JSON matching the schema.`;

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          { inlineData: { mimeType: parsedImg.mimeType, data: parsedImg.cleanBase64 } },
          { text: prompt },
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              isRegionClear: { type: Type.BOOLEAN },
              unclearReason: { type: Type.STRING },
              issueSubType: { type: Type.STRING },
              identifiedIssues: { type: Type.ARRAY, items: { type: Type.STRING } },
              recommendedActions: { type: Type.ARRAY, items: { type: Type.STRING } },
              environmentalBenefit: { type: Type.STRING },
              defectBoundingBoxes: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    ymin: { type: Type.INTEGER },
                    xmin: { type: Type.INTEGER },
                    ymax: { type: Type.INTEGER },
                    xmax: { type: Type.INTEGER },
                    label: { type: Type.STRING },
                  },
                  required: ['ymin', 'xmin', 'ymax', 'xmax'],
                },
              },
            },
            required: ['isRegionClear', 'identifiedIssues', 'recommendedActions', 'environmentalBenefit'],
          },
        },
      });

      recordGeminiSuccess();
      const parsed = JSON.parse(response.text?.trim() || '{}');
      isRegionClear = parsed.isRegionClear !== false;
      if (parsed.unclearReason) unclearReason = parsed.unclearReason;
      if (parsed.issueSubType) resolvedSubType = parsed.issueSubType;
      if (Array.isArray(parsed.identifiedIssues)) identifiedIssues = parsed.identifiedIssues.filter(Boolean);
      if (Array.isArray(parsed.recommendedActions)) recommendedActions = parsed.recommendedActions.filter(Boolean);
      if (parsed.environmentalBenefit) environmentalBenefit = parsed.environmentalBenefit;
      if (Array.isArray(parsed.defectBoundingBoxes)) {
        effectiveBoxes = parsed.defectBoundingBoxes
          .map((b: any) => ({
            ymin: Number(b.ymin) || 0,
            xmin: Number(b.xmin) || 0,
            ymax: Number(b.ymax) || 0,
            xmax: Number(b.xmax) || 0,
            label: b.label || resolvedSubType,
          }))
          .filter((b: BoundingBox) => b.ymax > b.ymin && b.xmax > b.xmin);
      }
    } catch (err: any) {
      handleGeminiError(err, 'civic_visualize_improvement');
    }
  }

  // If no bounding boxes could be isolated reliably (or AI unavailable without cached boxes), return an honest unavailable state
  if (!isRegionClear || effectiveBoxes.length === 0) {
    return res.status(200).json({
      isUnavailable: true,
      unavailableReason:
        unclearReason ||
        'Before & After image preview is temporarily unavailable because the affected area could not be isolated cleanly. Your original photo remains unchanged.',
      identifiedIssues,
      recommendedActions,
      environmentalBenefit:
        environmentalBenefit || 'Manual municipal inspection remains unaffected using your original uploaded photo.',
      visualizedImageUrl: '',
      category: canonicalCategory,
      issueSubType: resolvedSubType,
      isRegionClear: false,
      unclearReason:
        unclearReason ||
        'Defect region could not be localized safely without risking changes to unaffected surroundings.',
      detectedBoxes: [],
      maskCoveragePercent: 0,
      transformationMethod: 'unavailable',
      canRetry: true,
      disclaimer,
      timestamp: new Date().toISOString(),
    });
  }

  let totalBoxAreaUnits = 0;
  for (const box of effectiveBoxes) {
    totalBoxAreaUnits += Math.max(0, box.ymax - box.ymin) * Math.max(0, box.xmax - box.xmin);
  }
  const maskCoveragePercent = Math.min(60, Number(((totalBoxAreaUnits / 1_000_000) * 100).toFixed(1)));

  try {
    let editedPhoto: string | null = null;
    let methodUsed = 'grounded-inpainting';
    let modelUsed = '';

    if (process.env.ENABLE_PAID_IMAGE_EDIT === 'true' && ai && !isGeminiInCooldown()) {
      try {
        const issueList = identifiedIssues.length > 0 ? identifiedIssues : [resolvedSubType || canonicalCategory];
        const imgEditResult = await attemptGeminiImageToImage(ai, photoBase64, issueList);
        if (imgEditResult?.transformedPhoto) {
          const quickSim = await verifyImageSimilarity(
            photoBase64,
            imgEditResult.transformedPhoto,
            effectiveBoxes,
            false
          );
          if (quickSim.verified && quickSim.correlation >= 0.7 && quickSim.waste_removed) {
            editedPhoto = imgEditResult.transformedPhoto;
            methodUsed = 'image-to-image-model';
            modelUsed = imgEditResult.modelUsed;
          }
        }
      } catch {
        // Fallback smoothly to grounded OpenCV Telea inpainting
      }
    }

    if (!editedPhoto) {
      const inpaintResult = await performGroundedInpainting(
        photoBase64,
        effectiveBoxes,
        `${canonicalCategory} ${resolvedSubType}`
      );
      editedPhoto = inpaintResult.cleanedPhoto;
      methodUsed = 'grounded-inpainting';
      modelUsed = inpaintResult.method;
    }

    const similarity = await verifyImageSimilarity(
      photoBase64,
      editedPhoto,
      effectiveBoxes,
      false
    );

    if (!similarity.scene_preserved || !similarity.waste_removed) {
      return res.status(200).json({
        isUnavailable: true,
        unavailableReason:
          'Improvement preview was withheld because the repair consistency check could not confirm that unaffected surroundings remained intact.',
        identifiedIssues,
        recommendedActions,
        environmentalBenefit,
        visualizedImageUrl: '',
        category: canonicalCategory,
        issueSubType: resolvedSubType,
        isRegionClear: true,
        detectedBoxes: effectiveBoxes,
        maskCoveragePercent,
        transformationMethod: 'unavailable',
        canRetry: true,
        disclaimer,
        timestamp: new Date().toISOString(),
      });
    }

    return res.status(200).json({
      isUnavailable: false,
      identifiedIssues:
        identifiedIssues.length > 0 ? identifiedIssues : [`Visible ${resolvedSubType} defect localized in photo`],
      recommendedActions:
        recommendedActions.length > 0
          ? recommendedActions
          : ['Municipal field team targeted restoration using attached report location and photo'],
      environmentalBenefit:
        environmentalBenefit ||
        'Targeted remediation restores safer, cleaner neighborhood conditions while preserving surrounding public infrastructure.',
      visualizedImageUrl: editedPhoto,
      isCleanArea: false,
      category: canonicalCategory,
      issueSubType: resolvedSubType,
      isRegionClear: true,
      detectedBoxes: effectiveBoxes,
      maskCoveragePercent,
      transformationMethod: methodUsed,
      verification: {
        passed: true,
        modelUsed,
        transformationMethod: methodUsed,
        similarityScore: similarity.similarity_score,
        correlation: similarity.correlation,
        psnr: similarity.psnr,
        scenePreserved: similarity.scene_preserved,
        wasteRemoved: similarity.waste_removed,
        wasteRegionDifference: similarity.waste_region_diff,
        unaffectedRegionRetention: similarity.unaffected_retention,
        artifactsDetected: similarity.artifacts_detected,
        hallucinationsDetected: similarity.hallucinations_detected,
        verificationNotes: 'Localized surface restoration applied strictly inside defect bounding boxes on your original photograph.',
      },
      disclaimer,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.warn('[CiviFix] Civic Before & After unavailable:', err?.message || err);
    return res.status(200).json({
      isUnavailable: true,
      unavailableReason:
        'Image editing service is temporarily unavailable. Your original uploaded photo remains intact.',
      identifiedIssues,
      recommendedActions,
      environmentalBenefit,
      visualizedImageUrl: '',
      category: canonicalCategory,
      issueSubType: resolvedSubType,
      isRegionClear: true,
      detectedBoxes: effectiveBoxes,
      maskCoveragePercent,
      transformationMethod: 'unavailable',
      canRetry: true,
      disclaimer,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Zero-Trust Administrative Identity Verification API
 * Verifies the caller's Firebase ID Token cryptographically via Firebase Admin SDK
 * and inspects Firebase custom claims / active /admins/{uid} authorization.
 */
app.post('/api/admin/verify', requireAuth, async (req, res) => {
  if (!req.decodedToken || !req.user) {
    return res.status(401).json({
      authorized: false,
      error: 'Authentication required.',
    });
  }

  const check = await verifyAdminFromDecodedToken(req.decodedToken);
  if (!check.authorized) {
    return res.status(403).json({
      authorized: false,
      error:
        check.reason ||
        'Access denied: This account does not have verified municipal administrator privileges.',
    });
  }

  return res.status(200).json({
    authorized: true,
    uid: req.user.uid,
    email: req.user.email,
    role: check.role,
    department: check.department,
    source: check.source,
    agency: 'CiviFix AI Municipal Operations',
    verifiedAt: new Date().toISOString(),
  });
});

// Start server with Vite middleware in development
export async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // In production serve dist whether launched from root (server.ts) or compiled bundle (dist/server.mjs)
    const distDir = fs.existsSync(path.resolve(__dirname, 'index.html'))
      ? __dirname
      : path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`CiviFix AI server listening on http://0.0.0.0:${PORT}`);
    // Start Python ML service in background via supervisor
    mlSupervisor.start().catch((err) => {
      console.warn(`[Python-ML] Supervisor initial startup notice: ${err?.message || err}`);
    });
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${PORT} in use, retrying in 1s...`);
      setTimeout(() => {
        try {
          server.close();
        } catch {
          // ignore close error
        }
        server.listen(PORT, '0.0.0.0');
      }, 1000);
    } else {
      console.error('Server listen error:', err);
    }
  });

  const gracefulShutdown = async (signal: string) => {
    console.log(`[CiviFix] ${signal} signal received: closing server and terminating child processes...`);
    await mlSupervisor.stop();
    server.close(() => {
      console.log('[CiviFix] Server closed cleanly.');
      process.exit(0);
    });
  };

  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.once('SIGINT', () => gracefulShutdown('SIGINT'));
  return server;
}


process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

if (process.env.CIVIFIX_NO_LISTEN !== '1') {
  startServer().catch((err) => {
    console.error('Failed to start CiviFix AI server:', err);
  });
}
