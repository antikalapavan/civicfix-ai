import {
  EXPANDED_CIVIC_CATEGORIES,
  ExpandedCivicCategory,
  CivicImageVerificationResult,
  CivicIssueBoundingBox,
  VerificationDecision,
  normalizeCivicCategory,
} from '../types/civic';

export const CANONICAL_CIVIC_CATEGORIES: readonly ExpandedCivicCategory[] = EXPANDED_CIVIC_CATEGORIES;

export const CITIZEN_VALID_MESSAGE =
  'Possible civic issue detected. You can continue with your report.';

export const CITIZEN_UNRELATED_MESSAGE =
  'This image does not appear to show a civic problem. Please upload a relevant photo.';

export const CITIZEN_UNCLEAR_MESSAGE =
  'We could not verify this image clearly. You can retry analysis, upload a clearer photo, or continue with manual officer review.';

export const BEFORE_AFTER_DISCLAIMER =
  'AI-generated improvement preview – illustrative only.';

const GEMINI_SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
]);

export function parseImagePayload(
  rawInput: string
): { mimeType: string; cleanBase64: string } | null {
  if (!rawInput || typeof rawInput !== 'string') return null;
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  const mimeMatch = trimmed.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,/i);
  if (trimmed.startsWith('data:') && !mimeMatch) {
    return null;
  }

  let mimeType = (mimeMatch ? mimeMatch[1] : 'image/jpeg').toLowerCase();
  if (mimeType === 'image/jpg' || mimeType === 'image/pjpeg') {
    mimeType = 'image/jpeg';
  }
  if (!GEMINI_SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    return null;
  }

  const cleanBase64 = trimmed
    .replace(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,/i, '')
    .replace(/\s+/g, '');
  if (!cleanBase64 || cleanBase64.length < 16) return null;

  return { mimeType, cleanBase64 };
}

export function mapToCanonicalCategory(rawCategory?: string | null): ExpandedCivicCategory {
  return normalizeCivicCategory(rawCategory);
}

export function normalizeSeverity(rawSeverity?: unknown): 'Low' | 'Medium' | 'High' {
  if (typeof rawSeverity !== 'string') return 'Medium';
  const lower = rawSeverity.trim().toLowerCase();
  if (lower === 'low' || lower === 'minor') return 'Low';
  if (lower === 'high' || lower === 'hazard' || lower === 'critical' || lower === 'severe') {
    return 'High';
  }
  return 'Medium';
}

export function normalizeConfidenceLevel(
  rawLevel?: unknown,
  confNum: number = 0
): 'Low' | 'Medium' | 'High' | null {
  if (typeof rawLevel === 'string') {
    const trimmed = rawLevel.trim();
    if (trimmed) {
      const lower = trimmed.toLowerCase();
      if (lower === 'high' || lower === 'very high') return 'High';
      if (lower === 'medium' || lower === 'moderate') return 'Medium';
      if (lower === 'low') return 'Low';
      if (
        lower === 'null' ||
        lower === 'unknown' ||
        lower === 'uncertain' ||
        lower === 'unmeasured' ||
        lower === 'not measured'
      ) {
        return null;
      }
      const pctMatch = trimmed.match(/^(\d{1,3})\s*%$/);
      if (pctMatch) {
        const pct = Number(pctMatch[1]);
        if (pct >= 80) return 'High';
        if (pct >= 55) return 'Medium';
        if (pct > 0) return 'Low';
      }
    }
  }
  if (confNum >= 80) return 'High';
  if (confNum >= 55) return 'Medium';
  if (confNum > 0) return 'Low';
  return null;
}

export function buildCivicValidationPrompt(params: {
  description?: string;
  selectedCategory?: string;
  qualitySummary?: any;
}): string {
  const desc = params.description?.trim()
    ? `"${params.description.trim()}"`
    : 'No written description provided yet.';
  const selCat = params.selectedCategory || 'Not specified';
  const qualNote = params.qualitySummary
    ? `Image quality telemetry: rating=${params.qualitySummary.quality_rating || 'unknown'}, isBlurry=${Boolean(
        params.qualitySummary.is_blurry
      )}, isDark=${Boolean(params.qualitySummary.is_dark)}, isOverexposed=${Boolean(
        params.qualitySummary.is_overexposed
      )}, isPoorVisibility=${Boolean(params.qualitySummary.is_poor_visibility)}.`
    : '';

  return `You are a careful municipal civic-issue visual triage assistant for CiviFix AI.
Evaluate BOTH the attached citizen photograph AND their written complaint context.

Citizen Written Description: ${desc}
Citizen Selected Category: "${selCat}"
${qualNote}

Allowed primaryCategory values (choose the single best match):
- "Garbage accumulation" (piled or scattered municipal garbage, illegal waste dumping, litter heaps on streets or open lots)
- "Overflowing dustbins" (public dustbins, trash cans, or municipal waste containers overflowing with waste spilling out or piled around the bin)
- "Potholes" (distinct road surface cavities, deep holes, sunken asphalt craters)
- "Damaged roads" (widespread road cracks, broken/crumbled asphalt, damaged road edges, buckled pavement surface)
- "Drainage problems" (blocked stormwater drains, clogged grates, sewage overflow, stagnant dirty water, street waterlogging)
- "Water leakage" (leaking public water supply pipes, burst water mains, leaking standposts/valves, continuous clean water wastage)
- "Streetlight problems" (broken, leaning, shattered, flickering, or unlit/dark streetlights and lamp poles)
- "Other civic issues" (damaged footpaths, fallen trees, damaged traffic signs, broken public benches/property, or "Needs Review" when uncertain)
- "Unrelated / Non-Civic" (ONLY when the image clearly does not depict a civic/sanitation/infrastructure issue—e.g. selfie, portrait, indoor pet, meme, blank screenshot, indoor meal)

CRITICAL EVALUATION & ACCURACY RULES:
1. CULTURAL & RELIGIOUS NEUTRALITY: Do NOT reject or penalize a photograph merely because religious symbols, temples, shrines, mosques, churches, festivals, or cultural artifacts appear in the frame. Judge objectively whether a real civic, sanitation, road, drainage, or infrastructure issue is visibly present.
2. STRICT EVIDENCE SEPARATION:
   - "visibleObservations": list ONLY concrete, directly visible facts in the image (e.g., "Piled plastic wrappers next to a curb", "Dark depression in asphalt pavement"). Never invent hidden underground pipes, wiring faults, or unsupported findings.
   - "aiAssumptions": list clearly framed possible causes or interpretations that are NOT directly proven by pixels alone (e.g., "Surface crack may expand if rainwater collects", "Bin overflow may indicate missed pickup"). Keep empty or clearly tentative.
3. SEVERITY, EXPLANATION & COMPLAINT DRAFTING:
   - "detectedIssueType": concise specific name of the visible issue (e.g., "Overflowing roadside dustbin", "Deep asphalt pothole", "Blocked stormwater grate").
   - "suggestedSeverity": classify strictly as "Low", "Medium", or "High" based on visible public safety risk, traffic/pedestrian obstruction, sanitation/contamination hazard, and visible scale.
   - "severityReason": 1 clear sentence explaining why that severity level fits the visible evidence.
   - "shortExplanation": 1-2 crisp sentences summarizing what the photo shows for the citizen before submission.
   - "suggestedTitle": concise 4-10 word complaint title describing the visible issue without inventing street names.
   - "suggestedDescription": clear 2-3 sentence municipal complaint draft grounded strictly in visible facts (never fabricate locations, dates, or underground causes).
   - "confidenceLevel": "High", "Medium", or "Low" when visual evidence supports an assessment, or null if uncertain.
4. UNCERTAIN / LOW-CONFIDENCE HANDLING:
   - Never pretend AI can verify every photo with 100% certainty.
   - If blurry, poorly lit, or ambiguous, set decision to "POSSIBLE_CIVIC_ISSUE_NEEDS_REVIEW" or "UNCLEAR_IMAGE", visualSubType to "Needs Review", and requiresHumanReview: true.
   - Only set confidencePercent (50..95) when visual evidence is clear; use 0 when uncertain or fallback.
5. BOUNDING BOXES:
   - When a distinct civic defect is visible (litter pile, overflowing bin, pothole, cracked road, blocked drain, puddle, fallen branch, broken bench/sign, dark lamp), provide 1-3 normalized bounding boxes [ymin, xmin, ymax, xmax] in 0..1000 coordinates targeting ONLY the defect region so an illustrative Before & After repair preview preserves unaffected buildings, trees, and cars.

Return one JSON object and no Markdown. Use exactly these field names:
decision, isCivicIssue, issueDetected, detectedIssueType, primaryCategory, visualSubType,
suggestedSeverity, severityReason, shortExplanation, suggestedTitle, suggestedDescription,
confidenceLevel, confidencePercent, detectedObjects, visibleObservations, aiAssumptions,
visualEvidence, potentialPublicImpact, explanation, recommendedActions, safetyPrecautions,
defectBoundingBoxes.
For civic issues, decision must be exactly VALID_CIVIC_ISSUE or POSSIBLE_CIVIC_ISSUE_NEEDS_REVIEW;
for clearly unrelated images it must be exactly UNRELATED_IMAGE; for unclear images it must be exactly UNCLEAR_IMAGE.
suggestedSeverity must be exactly Low, Medium, or High. Always include every listed field; use an empty array, null, or a cautious explanatory string when a field does not apply.`;
}

export interface NormalizedValidationInput {
  parsed: any;
  qualitySummary?: any;
  modelUsed?: string;
}

export function normalizeCivicValidationResponse({
  parsed,
  qualitySummary,
  modelUsed =
    process.env.GEMINI_MODEL && process.env.GEMINI_MODEL !== 'gemini-4-hydrogen'
      ? process.env.GEMINI_MODEL
      : 'gemini-2.5-flash',
}: NormalizedValidationInput): CivicImageVerificationResult {
  const rawDecision = String(parsed?.decision || '').trim();
  const normalizedDecision = rawDecision.toUpperCase().replace(/[\s-]+/g, '_');
  const isCivicRaw = parsed?.isCivicIssue;
  const confNum = typeof parsed?.confidencePercent === 'number' ? parsed.confidencePercent : 0;

  let decision: VerificationDecision;
  if (
    normalizedDecision === 'VALID_CIVIC_ISSUE' ||
    normalizedDecision === 'VALID' ||
    normalizedDecision === 'CIVIC_ISSUE'
  ) {
    decision = 'VALID_CIVIC_ISSUE';
  } else if (normalizedDecision === 'UNRELATED_IMAGE' || normalizedDecision === 'NOT_CIVIC_ISSUE' || normalizedDecision === 'NOT_CIVIC') {
    decision = 'UNRELATED_IMAGE';
  } else if (normalizedDecision === 'UNCLEAR_IMAGE' || normalizedDecision === 'UNCLEAR') {
    decision = 'UNCLEAR_IMAGE';
  } else if (normalizedDecision === 'POSSIBLE_CIVIC_ISSUE_NEEDS_REVIEW' || normalizedDecision === 'POSSIBLE_CIVIC_ISSUE') {
    decision = 'POSSIBLE_CIVIC_ISSUE_NEEDS_REVIEW';
  } else if (isCivicRaw === false) {
    decision = 'UNRELATED_IMAGE';
  } else if (isCivicRaw === true && confNum >= 60) {
    decision = 'VALID_CIVIC_ISSUE';
  } else {
    decision = 'POSSIBLE_CIVIC_ISSUE_NEEDS_REVIEW';
  }

  const isUnrelated = decision === 'UNRELATED_IMAGE';
  const isUnclearOrLowConf =
    decision === 'UNCLEAR_IMAGE' ||
    decision === 'POSSIBLE_CIVIC_ISSUE_NEEDS_REVIEW' ||
    (confNum > 0 && confNum < 55);

  if (isUnrelated) {
    const unrelatedExplanation =
      parsed?.explanation ||
      'This photo appears to show a non-civic subject (such as a portrait, personal photo, or unrelated scene) rather than a municipal issue.';
    const unrelatedConfidenceLevel = normalizeConfidenceLevel(parsed?.confidenceLevel, confNum);

    return {
      decision: 'UNRELATED_IMAGE',
      isCivicIssue: false,
      issueDetected: parsed?.issueDetected || 'No visible civic or infrastructure problem',
      detectedIssueType:
        parsed?.detectedIssueType || parsed?.visualSubType || 'Unrelated / Non-Civic subject',
      primaryCategory: 'Unrelated / Non-Civic',
      visualSubType: parsed?.visualSubType || 'Unrelated photograph',
      detectedObjects: Array.isArray(parsed?.detectedObjects) ? parsed.detectedObjects : [],
      detectedBoxes: [],
      visualEvidence:
        parsed?.visualEvidence || 'The uploaded image does not appear to depict a public civic or sanitation issue.',
      visibleObservations: Array.isArray(parsed?.visibleObservations)
        ? parsed.visibleObservations.filter(Boolean)
        : ['No street, drainage, waste, lighting, or public infrastructure defect identified.'],
      aiAssumptions: Array.isArray(parsed?.aiAssumptions) ? parsed.aiAssumptions.filter(Boolean) : [],
      potentialPublicImpact: '',
      explanation: unrelatedExplanation,
      shortExplanation: parsed?.shortExplanation || unrelatedExplanation,
      suggestedSeverity: 'Low',
      severityReason:
        parsed?.severityReason || 'No public infrastructure or sanitation hazard detected in this photograph.',
      suggestedTitle: '',
      suggestedDescription: '',
      citizenStatusMessage: CITIZEN_UNRELATED_MESSAGE,
      recommendedActions:
        Array.isArray(parsed?.recommendedActions) && parsed.recommendedActions.length > 0
          ? parsed.recommendedActions
          : ['Upload a clear photograph showing the street, drain, waste, or damaged public asset.'],
      safetyPrecautions: parsed?.safetyPrecautions || 'Photograph civic issues safely from a sidewalk or pedestrian area.',
      confidence: confNum >= 50 ? `${Math.min(98, Math.round(confNum))}%` : null,
      confidenceLevel: unrelatedConfidenceLevel,
      confidenceBand: confNum >= 80 ? 'High' : confNum >= 50 ? 'Moderate' : 'Uncertain',
      imageQuality: buildImageQualityObject(qualitySummary),
      beforeAfterEligible: false,
      requiresHumanReview: true,
      rejectionReason: CITIZEN_UNRELATED_MESSAGE,
      canProceedToSubmit: false,
      isFallback: false,
      modelUsed,
      timestamp: new Date().toISOString(),
    };
  }

  const canonicalCategory = mapToCanonicalCategory(
    parsed?.primaryCategory || parsed?.detectedIssueType || parsed?.issueDetected
  );
  const rawBoxes: CivicIssueBoundingBox[] = Array.isArray(parsed?.defectBoundingBoxes)
    ? parsed.defectBoundingBoxes
        .map((b: any) => ({
          ymin: Number(b.ymin) || 0,
          xmin: Number(b.xmin) || 0,
          ymax: Number(b.ymax) || 0,
          xmax: Number(b.xmax) || 0,
          label: typeof b.label === 'string' ? b.label : 'civic_defect',
        }))
        .filter((b: CivicIssueBoundingBox) => b.ymax > b.ymin && b.xmax > b.xmin)
    : [];

  const finalDecision: VerificationDecision = isUnclearOrLowConf
    ? decision === 'UNCLEAR_IMAGE'
      ? 'UNCLEAR_IMAGE'
      : 'POSSIBLE_CIVIC_ISSUE_NEEDS_REVIEW'
    : 'VALID_CIVIC_ISSUE';

  const requiresHumanReview = finalDecision !== 'VALID_CIVIC_ISSUE';
  const suggestedSeverity = normalizeSeverity(parsed?.suggestedSeverity || parsed?.severity);
  const explanationText =
    parsed?.explanation ||
    (requiresHumanReview
      ? 'The photo may depict a civic issue, though visual clarity is limited. A municipal officer review is recommended.'
      : 'Visual evidence aligns with a municipal civic issue ready for reporting.');
  const detectedIssueType =
    (typeof parsed?.detectedIssueType === 'string' && parsed.detectedIssueType.trim()) ||
    (typeof parsed?.visualSubType === 'string' && parsed.visualSubType.trim()) ||
    (typeof parsed?.issueDetected === 'string' && parsed.issueDetected.trim()) ||
    (requiresHumanReview ? 'Needs Review' : canonicalCategory);
  const shortExplanation =
    (typeof parsed?.shortExplanation === 'string' && parsed.shortExplanation.trim()) ||
    explanationText;
  const severityReason =
    (typeof parsed?.severityReason === 'string' && parsed.severityReason.trim()) ||
    `${suggestedSeverity} severity estimated based on visible ${canonicalCategory.toLowerCase()} conditions in the photograph.`;
  const suggestedTitle =
    (typeof parsed?.suggestedTitle === 'string' && parsed.suggestedTitle.trim()) ||
    (requiresHumanReview
      ? `${canonicalCategory} issue flagged for inspection`
      : `${detectedIssueType} reported for municipal action`);
  const suggestedDescription =
    (typeof parsed?.suggestedDescription === 'string' && parsed.suggestedDescription.trim()) ||
    `${shortExplanation} Reported under ${canonicalCategory} for field inspection and remediation.`;
  const confidenceLevel = requiresHumanReview
    ? normalizeConfidenceLevel(parsed?.confidenceLevel, 0) === 'Low'
      ? 'Low'
      : null
    : normalizeConfidenceLevel(parsed?.confidenceLevel, confNum);

  return {
    decision: finalDecision,
    isCivicIssue: requiresHumanReview ? 'uncertain' : true,
    issueDetected:
      parsed?.issueDetected ||
      (requiresHumanReview ? 'Needs Review' : detectedIssueType),
    detectedIssueType,
    primaryCategory: canonicalCategory,
    visualSubType:
      parsed?.visualSubType ||
      (requiresHumanReview ? 'Needs Review' : detectedIssueType),
    secondaryCategories: Array.isArray(parsed?.secondaryCategories)
      ? parsed.secondaryCategories.map((c: string) => mapToCanonicalCategory(c))
      : undefined,
    detectedObjects: Array.isArray(parsed?.detectedObjects) ? parsed.detectedObjects.filter(Boolean) : [],
    detectedBoxes: rawBoxes,
    visualEvidence:
      parsed?.visualEvidence || 'Visual inspection reviewed the uploaded street/area photograph.',
    visibleObservations: Array.isArray(parsed?.visibleObservations)
      ? parsed.visibleObservations.filter(Boolean)
      : parsed?.visualEvidence
      ? [parsed.visualEvidence]
      : [],
    aiAssumptions: Array.isArray(parsed?.aiAssumptions) ? parsed.aiAssumptions.filter(Boolean) : [],
    potentialPublicImpact:
      parsed?.potentialPublicImpact ||
      'Unresolved civic defects can reduce neighborhood hygiene, accessibility, or road safety.',
    explanation: explanationText,
    shortExplanation,
    suggestedSeverity,
    severityReason,
    suggestedTitle,
    suggestedDescription,
    citizenStatusMessage: requiresHumanReview ? CITIZEN_UNCLEAR_MESSAGE : CITIZEN_VALID_MESSAGE,
    recommendedActions:
      Array.isArray(parsed?.recommendedActions) && parsed.recommendedActions.length > 0
        ? parsed.recommendedActions.filter(Boolean)
        : ['Submit report with exact street landmark so municipal crews can inspect on site.'],
    safetyPrecautions:
      parsed?.safetyPrecautions ||
      'Keep clear of moving traffic, open drains, or exposed electrical wiring when taking photos.',
    confidence:
      !requiresHumanReview && confNum >= 50 ? `${Math.min(98, Math.round(confNum))}%` : null,
    confidenceLevel,
    confidenceBand: requiresHumanReview
      ? 'Uncertain'
      : confNum >= 80
      ? 'High'
      : confNum >= 55
      ? 'Moderate'
      : 'Uncertain',
    imageQuality: buildImageQualityObject(qualitySummary),
    beforeAfterEligible: rawBoxes.length > 0 && !requiresHumanReview,
    requiresHumanReview,
    rejectionReason: null,
    canProceedToSubmit: true,
    isFallback: false,
    modelUsed,
    timestamp: new Date().toISOString(),
  };
}

export function buildFallbackValidationResult(params: {
  selectedCategory?: string;
  description?: string;
  qualitySummary?: any;
  reason?: string;
}): CivicImageVerificationResult {
  const canonicalCategory = mapToCanonicalCategory(params.selectedCategory);
  const trimmedDesc = typeof params.description === 'string' ? params.description.trim() : '';
  return {
    decision: 'POSSIBLE_CIVIC_ISSUE_NEEDS_REVIEW',
    isCivicIssue: 'uncertain',
    issueDetected: 'Needs Review (Automatic image check temporarily unavailable)',
    detectedIssueType: 'Needs Review',
    primaryCategory: canonicalCategory,
    visualSubType: 'Needs Review',
    detectedObjects: [],
    detectedBoxes: [],
    visualEvidence:
      params.reason ||
      'Automated image verification is temporarily unavailable. Your uploaded photograph is preserved intact for municipal officer review.',
    visibleObservations: [],
    aiAssumptions: [
      'Live image analysis could not be completed at this moment; category relies on your selection and description.',
    ],
    potentialPublicImpact:
      'Municipal teams will inspect the attached photograph and address details after submission.',
    explanation:
      'Because automatic image analysis could not run right now, you can retry image verification or submit directly for human officer review.',
    shortExplanation:
      'Automatic image analysis is temporarily unavailable; please review category, severity, and details manually before submitting.',
    suggestedSeverity: 'Medium',
    severityReason:
      'Default Medium severity assigned because automated visual severity estimation is temporarily unavailable.',
    suggestedTitle: `${canonicalCategory} issue reported for inspection`,
    suggestedDescription:
      trimmedDesc ||
      `Citizen reported a ${canonicalCategory.toLowerCase()} issue with an attached photograph for municipal review.`,
    citizenStatusMessage: CITIZEN_UNCLEAR_MESSAGE,
    recommendedActions: [
      'Retry photo analysis if you have an active connection, or continue submitting for municipal inspection.',
    ],
    safetyPrecautions: 'Ensure your photo shows the issue clearly from a safe pedestrian vantage point.',
    confidence: null,
    confidenceLevel: null,
    confidenceBand: 'Uncertain',
    imageQuality: buildImageQualityObject(params.qualitySummary),
    beforeAfterEligible: false,
    requiresHumanReview: true,
    rejectionReason: null,
    canProceedToSubmit: true,
    isFallback: true,
    modelUsed: 'Unavailable (Manual Review Path)',
    timestamp: new Date().toISOString(),
  };
}

function buildImageQualityObject(qualitySummary?: any): CivicImageVerificationResult['imageQuality'] {
  const rating =
    qualitySummary?.quality_rating === 'Good' ||
    qualitySummary?.quality_rating === 'Acceptable' ||
    qualitySummary?.quality_rating === 'Needs Attention'
      ? qualitySummary.quality_rating
      : 'Acceptable';

  return {
    rating,
    isBlurry: Boolean(qualitySummary?.is_blurry),
    isDark: Boolean(qualitySummary?.is_dark),
    isOverexposed: Boolean(qualitySummary?.is_overexposed),
    isPoorVisibility: Boolean(qualitySummary?.is_poor_visibility),
    blurScore: typeof qualitySummary?.blur_score === 'number' ? qualitySummary.blur_score : undefined,
    brightness: typeof qualitySummary?.brightness === 'number' ? qualitySummary.brightness : undefined,
    contrastStd: typeof qualitySummary?.contrast_std === 'number' ? qualitySummary.contrast_std : undefined,
  };
}
