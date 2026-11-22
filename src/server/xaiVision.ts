import { normalizeCivicValidationResponse } from './civicVisionHelpers';
import type { CivicImageVerificationResult } from '../types/civic';

export const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const DEFAULT_GROQ_MODEL = 'qwen/qwen3.8-27b';
export const GROQ_SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png']);

export function resolveGroqApiKey(env: Record<string, string | undefined> = process.env): string | null {
  const value = typeof env.GROQ_API_KEY === 'string' ? env.GROQ_API_KEY.trim() : '';
  return value && !/^YOUR_|^REPLACE_ME$|^GROQ_API_KEY$/i.test(value) ? value : null;
}

export function resolveGroqModel(env: Record<string, string | undefined> = process.env): string {
  const value = typeof env.GROQ_MODEL === 'string' ? env.GROQ_MODEL.trim() : '';
  return value || DEFAULT_GROQ_MODEL;
}

export const GROQ_CIVIC_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decision: { type: 'string' },
    isCivicIssue: { type: 'boolean' },
    issueDetected: { type: 'string' },
    detectedIssueType: { type: 'string' },
    primaryCategory: { type: 'string' },
    visualSubType: { type: 'string' },
    suggestedSeverity: { type: 'string', enum: ['Low', 'Medium', 'High'] },
    severityReason: { type: 'string' },
    shortExplanation: { type: 'string' },
    suggestedTitle: { type: 'string' },
    suggestedDescription: { type: 'string' },
    confidenceLevel: { type: ['string', 'null'] },
    confidencePercent: { type: 'integer' },
    detectedObjects: { type: 'array', items: { type: 'string' } },
    visibleObservations: { type: 'array', items: { type: 'string' } },
    aiAssumptions: { type: 'array', items: { type: 'string' } },
    visualEvidence: { type: 'string' },
    potentialPublicImpact: { type: 'string' },
    explanation: { type: 'string' },
    recommendedActions: { type: 'array', items: { type: 'string' } },
    safetyPrecautions: { type: 'string' },
    defectBoundingBoxes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ymin: { type: 'integer' }, xmin: { type: 'integer' },
          ymax: { type: 'integer' }, xmax: { type: 'integer' }, label: { type: 'string' },
        },
        required: ['ymin', 'xmin', 'ymax', 'xmax'],
      },
    },
  },
  required: [
    'decision', 'isCivicIssue', 'issueDetected', 'detectedIssueType', 'primaryCategory',
    'suggestedSeverity', 'severityReason', 'shortExplanation', 'suggestedTitle',
    'suggestedDescription', 'confidenceLevel', 'confidencePercent', 'detectedObjects',
    'visibleObservations', 'aiAssumptions', 'visualEvidence', 'potentialPublicImpact',
    'explanation', 'recommendedActions', 'safetyPrecautions', 'defectBoundingBoxes',
  ],
} as const;

export class GroqVisionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
    public readonly providerType?: string,
  ) {
    super(message);
    this.name = 'GroqVisionError';
  }
}

function sanitizeProviderDetail(value: unknown): string {
  return String(value || 'Unknown Groq error')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi, '[IMAGE_REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export function extractGroqResponseText(payload: any): string {
  const result = payload?.choices?.[0]?.message?.content;
  if (typeof result === 'string' && result.trim()) return result.trim();
  throw new GroqVisionError('INVALID_RESPONSE', 'Groq returned no analysis text.');
}

export function parseGroqAnalysis(text: string, qualitySummary?: any, modelUsed?: string): CivicImageVerificationResult {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
    console.info('[CiviFix] Groq analysis JSON parsed', {
      parseSucceeded: true,
      parsedKeys: Object.keys(parsed).sort(),
      categoryFieldValid: typeof parsed?.primaryCategory === 'string' && parsed.primaryCategory.trim().length > 0,
      severityFieldValid: ['Low', 'Medium', 'High'].includes(parsed?.suggestedSeverity),
      decision: typeof parsed?.decision === 'string' ? parsed.decision : 'missing',
      confidencePercent: typeof parsed?.confidencePercent === 'number' ? parsed.confidencePercent : null,
    });
  } catch {
    console.warn('[CiviFix] Groq analysis JSON parsed', { parseSucceeded: false });
    throw new GroqVisionError('INVALID_RESPONSE', 'Groq returned invalid analysis JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GroqVisionError('INVALID_RESPONSE', 'Groq returned an invalid civic analysis object.');
  }
  const expectedFields = new Set([
    'decision', 'isCivicIssue', 'issueDetected', 'detectedIssueType', 'primaryCategory', 'visualSubType',
    'suggestedSeverity', 'severityReason', 'shortExplanation', 'suggestedTitle', 'suggestedDescription',
    'confidenceLevel', 'confidencePercent', 'detectedObjects', 'visibleObservations', 'aiAssumptions',
    'visualEvidence', 'potentialPublicImpact', 'explanation', 'recommendedActions', 'safetyPrecautions',
    'defectBoundingBoxes',
  ]);
  const repaired: Record<string, any> = { ...parsed };
  let repairedFieldCount = 0;
  for (const key of Object.keys(parsed)) {
    const cleanedKey = key.trim().replace(/^\"+|\"+$/g, '');
    if (cleanedKey !== key && expectedFields.has(cleanedKey) && repaired[cleanedKey] === undefined) {
      repaired[cleanedKey] = parsed[key];
      repairedFieldCount++;
    }
  }
  if (repairedFieldCount > 0) {
    console.warn('[CiviFix] Groq analysis field names repaired', { repairedFieldCount });
  }
  const normalized = normalizeCivicValidationResponse({ parsed: repaired, qualitySummary, modelUsed });
  console.info('[CiviFix] Groq analysis normalized', {
    decision: normalized.decision,
    category: normalized.primaryCategory,
    severity: normalized.suggestedSeverity,
    requiresHumanReview: normalized.requiresHumanReview,
    isFallback: normalized.isFallback,
  });
  return normalized;
}

export async function requestGroqCivicImageAnalysis(params: {
  apiKey: string;
  model: string;
  imageDataUrl: string;
  prompt: string;
  qualitySummary?: any;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<CivicImageVerificationResult> {
  const fetcher = params.fetcher || fetch;
  let response: Response;
  try {
    response = await fetcher(GROQ_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${params.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: params.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: params.prompt },
            { type: 'image_url', image_url: { url: params.imageDataUrl } },
          ],
        }],
        response_format: { type: 'json_object' },
      }),
      signal: params.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError' || /timeout|timed out/i.test(String(err?.message || ''))) {
      throw new GroqVisionError('TIMEOUT', 'Groq image analysis timed out.');
    }
    throw new GroqVisionError('NETWORK_ERROR', 'Groq image analysis could not be reached.');
  }
  if (!response.ok) {
    const rawBody = await response.text().catch(() => '');
    let providerType = 'unknown';
    let providerMessage = '';
    try {
      const body = JSON.parse(rawBody);
      const errorObject = body?.error;
      providerType = typeof errorObject?.type === 'string' ? errorObject.type :
        typeof body?.type === 'string' ? body.type : providerType;
      providerMessage = typeof errorObject === 'string' ? errorObject :
        typeof errorObject?.message === 'string' ? errorObject.message :
        typeof body?.message === 'string' ? body.message :
        errorObject ? JSON.stringify(errorObject) : '';
    } catch {
      providerMessage = rawBody;
    }
    const detail = sanitizeProviderDetail(providerMessage || `HTTP ${response.status}`);
    if (response.status === 401 || response.status === 403) throw new GroqVisionError('AUTHENTICATION_FAILED', `Groq authentication failed: ${detail}`, response.status, providerType);
    if (response.status === 402) throw new GroqVisionError('QUOTA_EXCEEDED', `Groq API credits or quota are unavailable: ${detail}`, response.status, providerType);
    if (response.status === 429) throw new GroqVisionError('RATE_LIMITED', `Groq is rate limiting requests: ${detail}`, response.status, providerType);
    if (response.status === 408 || response.status === 504) throw new GroqVisionError('TIMEOUT', `Groq image analysis timed out: ${detail}`, response.status, providerType);
    if (response.status >= 500) throw new GroqVisionError('PROVIDER_UNAVAILABLE', `Groq image analysis is temporarily unavailable: ${detail}`, response.status, providerType);
    throw new GroqVisionError('INVALID_REQUEST', `Groq rejected the image analysis request: ${detail}`, response.status, providerType);
  }
  const payload = await response.json().catch(() => null);
  const choice = payload?.choices?.[0];
  console.info('[CiviFix] Groq HTTP response', {
    status: response.status,
    choicesCount: Array.isArray(payload?.choices) ? payload.choices.length : 0,
    contentPresent: typeof choice?.message?.content === 'string' && choice.message.content.trim().length > 0,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
  });
  return parseGroqAnalysis(extractGroqResponseText(payload), params.qualitySummary, params.model);
}
