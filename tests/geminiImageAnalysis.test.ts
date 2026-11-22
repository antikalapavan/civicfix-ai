import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ThinkingLevel } from '@google/genai';

process.env.CIVIFIX_NO_LISTEN = '1';

import {
  parseImagePayload,
  normalizeCivicValidationResponse,
} from '../src/server/civicVisionHelpers';
import { downscaleBase64ForService } from '../src/services/imageOptimizer';
import {
  validateCivicIssueImage,
  clearCivicImageCaches,
  FRIENDLY_IMAGE_VERIFY_FALLBACK_MESSAGE,
} from '../src/services/civicImageService';

const SAMPLE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function runTests() {
  process.env.CIVIFIX_NO_LISTEN = '1';
  const {
    GEMINI_MODEL,
    GEMINI_IMAGE_VALIDATION_DEADLINE_MS,
    GEMINI_IMAGE_VALIDATION_ATTEMPT_TIMEOUT_MS,
    GEMINI_IMAGE_VALIDATION_MAX_ATTEMPTS,
    resolveGeminiApiKey,
    shouldTriggerGeminiCooldown,
    generateCivicImageValidationWithDeadline,
  } = await import('../server');
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   ${err?.message || err}`);
      failed++;
    }
  }

  console.log('\n======================================================');
  console.log('  CIVIFIX AI — GEMINI IMAGE ANALYSIS REGRESSION SUITE');
  console.log('======================================================\n');

  await test('1. parseImagePayload normalizes non-IANA image/jpg & image/pjpeg to image/jpeg', () => {
    const jpg = parseImagePayload(`data:image/jpg;base64,${SAMPLE_BASE64}`);
    assert.ok(jpg, 'image/jpg should be accepted');
    assert.equal(jpg!.mimeType, 'image/jpeg');
    assert.equal(jpg!.cleanBase64, SAMPLE_BASE64);

    const pjpeg = parseImagePayload(`data:IMAGE/PJPEG;base64,${SAMPLE_BASE64}`);
    assert.ok(pjpeg, 'IMAGE/PJPEG should be accepted');
    assert.equal(pjpeg!.mimeType, 'image/jpeg');
  });

  await test('2. parseImagePayload strips base64 whitespace and rejects unsupported MIME types', () => {
    const withNewlines = parseImagePayload(
      `data:image/png;base64, ${SAMPLE_BASE64.slice(0, 32)}\n${SAMPLE_BASE64.slice(32)} `
    );
    assert.ok(withNewlines, 'image/png with whitespace should parse cleanly');
    assert.equal(withNewlines!.mimeType, 'image/png');
    assert.equal(withNewlines!.cleanBase64, SAMPLE_BASE64);

    assert.equal(parseImagePayload(`data:image/svg+xml;base64,${SAMPLE_BASE64}`), null);
    assert.equal(parseImagePayload(`data:text/plain;base64,${SAMPLE_BASE64}`), null);
    assert.equal(parseImagePayload('data:not-a-valid-header'), null);
  });

  await test('3. downscaleBase64ForService normalizes data:image/jpg;base64 to data:image/jpeg;base64', async () => {
    const normalized = await downscaleBase64ForService(`data:image/jpg;base64,${SAMPLE_BASE64}`);
    assert.ok(
      normalized.startsWith('data:image/jpeg;base64,'),
      `Expected image/jpeg prefix, got: ${normalized.slice(0, 32)}`
    );
  });

  await test('4. resolveGeminiApiKey ignores placeholders and prefers the standard server key', () => {
    assert.equal(
      resolveGeminiApiKey({
        GEMINI_API_KEY_PERSONAL: 'MY_PERSONAL_GEMINI_API_KEY',
        GEMINI_API_KEY: 'MY_GEMINI_API_KEY',
      }),
      null
    );
    assert.equal(
      resolveGeminiApiKey({
        GEMINI_API_KEY_PERSONAL: '   ',
        GEMINI_API_KEY: 'real-server-key-123',
      }),
      'real-server-key-123'
    );
    assert.equal(
      resolveGeminiApiKey({
        GEMINI_API_KEY_PERSONAL: '  personal-key-456  ',
        GEMINI_API_KEY: 'fallback-key-789',
      }),
      'fallback-key-789'
    );
  });

  await test('5. civic image analysis uses a configured non-retired model', () => {
    assert.ok(GEMINI_MODEL.trim().length > 0);
    assert.notEqual(GEMINI_MODEL, 'gemini-4-hydrogen');
  });

  await test('6. shouldTriggerGeminiCooldown only trips on 429 / quota errors, never on timeouts or 400/500', () => {
    const timeoutErr = Object.assign(new Error('Gemini Vision validation timed out after 18000ms'), {
      name: 'AbortError',
    });
    assert.equal(shouldTriggerGeminiCooldown(timeoutErr), false);
    assert.equal(shouldTriggerGeminiCooldown({ status: 400, message: 'INVALID_ARGUMENT' }), false);
    assert.equal(shouldTriggerGeminiCooldown({ status: 500, message: 'Internal error' }), false);
    assert.equal(shouldTriggerGeminiCooldown({ status: 503, message: 'Service unavailable' }), false);

    assert.equal(shouldTriggerGeminiCooldown({ status: 429, message: 'Too Many Requests' }), true);
    assert.equal(
      shouldTriggerGeminiCooldown({ message: 'RESOURCE_EXHAUSTED: quota exceeded' }),
      true
    );
  });

  await test('7. generateCivicImageValidationWithDeadline sends canonical parts + ThinkingLevel.LOW', async () => {
    assert.equal(GEMINI_IMAGE_VALIDATION_DEADLINE_MS, 18_000);
    assert.equal(GEMINI_IMAGE_VALIDATION_ATTEMPT_TIMEOUT_MS, 12_000);
    assert.equal(GEMINI_IMAGE_VALIDATION_MAX_ATTEMPTS, 2);

    let capturedReq: any = null;
    const mockAi = {
      models: {
        generateContent: async (req: any) => {
          capturedReq = req;
          return {
            text: JSON.stringify({
              decision: 'VALID_CIVIC_ISSUE',
              isCivicIssue: true,
              issueDetected: 'Deep pothole on road',
              detectedIssueType: 'Pothole',
              primaryCategory: 'Potholes',
              suggestedSeverity: 'High',
              severityReason: 'Deep road crater poses a direct vehicle hazard.',
              shortExplanation: 'A large asphalt pothole is visible on the roadway.',
              suggestedTitle: 'Deep pothole causing road hazard',
              suggestedDescription: 'A deep pothole has formed on the main road surface.',
              visibleObservations: ['Cracked asphalt surrounding a sunken cavity'],
              explanation: 'Visible pothole requiring municipal road patching.',
              recommendedActions: ['Dispatch road repair crew'],
              safetyPrecautions: 'Place warning cones around the depression.',
            }),
          };
        },
      },
    } as any;

    const resp = await generateCivicImageValidationWithDeadline({
      ai: mockAi,
      parsedImg: { mimeType: 'image/jpeg', cleanBase64: SAMPLE_BASE64 },
      prompt: 'Inspect this civic issue photo.',
      model: GEMINI_MODEL,
      deadlineMs: 2_000,
      attemptTimeoutMs: 1_500,
      maxAttempts: 2,
    });

    assert.ok(capturedReq, 'generateContent must be invoked');
    assert.equal(capturedReq.model, GEMINI_MODEL);
    assert.ok(
      capturedReq.contents && Array.isArray(capturedReq.contents.parts),
      'contents must use canonical { parts: [...] } structure'
    );
    assert.equal(capturedReq.contents.parts[0]?.inlineData?.mimeType, 'image/jpeg');
    assert.equal(capturedReq.contents.parts[0]?.inlineData?.data, SAMPLE_BASE64);
    assert.equal(capturedReq.contents.parts[1]?.text, 'Inspect this civic issue photo.');
    assert.equal(
      capturedReq.config?.thinkingConfig?.thinkingLevel,
      ThinkingLevel.LOW,
      'Must configure ThinkingLevel.LOW so gemini-4-hydrogen meets real-time triage deadlines'
    );
    assert.ok(capturedReq.config?.abortSignal instanceof AbortSignal);

    const parsed = JSON.parse(resp.text || '{}');
    const normalized = normalizeCivicValidationResponse({
      parsed,
      modelUsed: GEMINI_MODEL,
    });
    assert.equal(normalized.isFallback, false);
    assert.equal(normalized.decision, 'VALID_CIVIC_ISSUE');
    assert.equal(normalized.primaryCategory, 'Potholes');
    assert.equal(normalized.suggestedSeverity, 'High');
  });

  await test('7. validateCivicIssueImage never caches isFallback responses and sends forceRefresh', async () => {
    clearCivicImageCaches();
    let callCount = 0;
    const capturedBodies: any[] = [];

    const fetcher: typeof fetch = (async (_input: any, init?: any) => {
      callCount++;
      capturedBodies.push(JSON.parse(String(init?.body || '{}')));
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: false,
            isFallback: true,
            decision: 'POSSIBLE_CIVIC_ISSUE_NEEDS_REVIEW',
            isCivicIssue: true,
            issueDetected: 'Needs Review',
            detectedIssueType: 'Needs Review',
            primaryCategory: 'Other civic issues',
            visualSubType: 'Needs Review',
            suggestedSeverity: 'Medium',
            severityReason: 'Pending review',
            shortExplanation: 'Unavailable',
            suggestedTitle: 'Civic issue reported',
            suggestedDescription: 'Manual review',
            confidenceLevel: null,
            detectedObjects: [],
            visibleObservations: [],
            aiAssumptions: [],
            visualEvidence: '',
            potentialPublicImpact: '',
            explanation: '',
            recommendedActions: [],
            safetyPrecautions: '',
            citizenMessage: '',
            confidence: null,
            requiresHumanReview: true,
            modelUsed: 'fallback',
            defectBoundingBoxes: [],
          }),
        } as any;
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          isFallback: false,
          decision: 'VALID_CIVIC_ISSUE',
          isCivicIssue: true,
          issueDetected: 'Overflowing garbage pile',
          detectedIssueType: 'Garbage accumulation',
          primaryCategory: 'Garbage accumulation',
          visualSubType: 'Garbage dumping',
          suggestedSeverity: 'Medium',
          severityReason: 'Waste pile blocks roadside drainage.',
          shortExplanation: 'Piled household waste is visible along the road.',
          suggestedTitle: 'Roadside garbage accumulation reported',
          suggestedDescription: 'Mixed waste has piled up along the curb.',
          confidenceLevel: 'High',
          detectedObjects: ['garbage bags'],
          visibleObservations: ['Scattered plastic bags and organic refuse'],
          aiAssumptions: [],
          visualEvidence: 'Visible waste pile',
          potentialPublicImpact: 'Hygiene risk',
          explanation: 'Municipal sanitation pickup needed.',
          recommendedActions: ['Clear waste pile'],
          safetyPrecautions: 'Avoid direct contact.',
          citizenMessage: 'Possible civic issue detected.',
          confidence: 'High',
          requiresHumanReview: false,
          modelUsed: GEMINI_MODEL,
          defectBoundingBoxes: [],
        }),
      } as any;
    }) as any;

    const first = await validateCivicIssueImage({
      photoBase64: `data:image/jpeg;base64,${SAMPLE_BASE64}`,
      description: '',
      fetcher,
    });
    assert.equal(first.isFallback, true);
    assert.equal(callCount, 1);
    assert.equal(capturedBodies[0].forceRefresh, false);

    // Calling again WITHOUT forceRefresh MUST re-query because fallback was NOT cached
    const second = await validateCivicIssueImage({
      photoBase64: `data:image/jpeg;base64,${SAMPLE_BASE64}`,
      description: '',
      fetcher,
    });
    assert.equal(second.isFallback, false);
    assert.equal(second.primaryCategory, 'Garbage accumulation');
    assert.equal(callCount, 2);

    // Calling a third time WITHOUT forceRefresh SHOULD use cache (valid non-fallback result)
    const third = await validateCivicIssueImage({
      photoBase64: `data:image/jpeg;base64,${SAMPLE_BASE64}`,
      description: '',
      fetcher,
    });
    assert.equal(third.primaryCategory, 'Garbage accumulation');
    assert.equal(callCount, 2, 'Valid non-fallback response should be served from cache');

    // Calling with forceRefresh: true SHOULD hit backend again and send forceRefresh: true
    await validateCivicIssueImage({
      photoBase64: `data:image/jpeg;base64,${SAMPLE_BASE64}`,
      description: '',
      forceRefresh: true,
      fetcher,
    });
    assert.equal(callCount, 3);
    assert.equal(capturedBodies[2].forceRefresh, true);
  });

  await test('8. validateCivicIssueImage throws user-friendly message on HTTP error (no raw stack/HTTP leak)', async () => {
    clearCivicImageCaches();
    const failingFetcher: typeof fetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal server stack trace' }),
    })) as any;

    await assert.rejects(
      () =>
        validateCivicIssueImage({
          photoBase64: `data:image/jpeg;base64,${SAMPLE_BASE64}`,
          description: '',
          fetcher: failingFetcher,
        }),
      (err: any) => err?.message === FRIENDLY_IMAGE_VERIFY_FALLBACK_MESSAGE
    );
  });

  await test('9. ReportIssueScreen runs Gemini in parallel with OpenCV, supports retry on Step 1 & Step 2, and never persists fallback AI data', () => {
    const screenSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/screens/ReportIssueScreen.tsx'),
      'utf8'
    );

    // Must NOT await inspectCivicPhotoQuality sequentially before runCivicImageVerification
    const inspectIdx = screenSrc.indexOf('inspectCivicPhotoQuality({');
    const verifyCallIdx = screenSrc.indexOf('await runCivicImageVerification(downscaled, null, false, uploadToken)');
    assert.ok(inspectIdx > 0 && verifyCallIdx > inspectIdx, 'Both inspection and verification must exist');
    const betweenBlock = screenSrc.slice(inspectIdx - 220, verifyCallIdx);
    assert.ok(
      betweenBlock.includes('void (async () => {'),
      'OpenCV inspection must run in a non-blocking parallel async block so Gemini starts immediately'
    );

    // Retry helper must be wired to both Step 1 and Step 2
    const retryMatches = screenSrc.match(/onClick=\{handleRetryPhotoAnalysis\}/g) || [];
    assert.ok(
      retryMatches.length >= 2,
      `Expected handleRetryPhotoAnalysis wired on both Step 1 and Step 2 (found ${retryMatches.length})`
    );

    // Fallback AI data must never be attached to submitted Firestore complaints
    assert.ok(
      screenSrc.includes('aiAnalysis && !aiAnalysis.isFallback ? aiAnalysis : undefined'),
      'handleSubmit must omit fallback aiAnalysis'
    );
    assert.ok(
      screenSrc.includes('imageVerification && !imageVerification.isFallback'),
      'handleSubmit must omit fallback imageVerification'
    );
  });

  await test('10. Frontend source never exposes or references GEMINI_API_KEY', () => {
    const srcDir = path.resolve(process.cwd(), 'src');
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        if (/\.(ts|tsx)$/.test(entry.name) && !full.includes(`${path.sep}server${path.sep}`)) {
          return [full];
        }
        return [];
      });

    for (const file of walk(srcDir)) {
      const content = fs.readFileSync(file, 'utf8');
      assert.ok(
        !content.includes('GEMINI_API_KEY'),
        `Frontend file must not reference GEMINI_API_KEY: ${file}`
      );
    }
  });

  console.log('\n======================================================');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
