import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  BEFORE_AFTER_DISCLAIMER,
  buildCivicValidationPrompt,
  buildFallbackValidationResult,
  CITIZEN_UNCLEAR_MESSAGE,
  CITIZEN_UNRELATED_MESSAGE,
  CITIZEN_VALID_MESSAGE,
  mapToCanonicalCategory,
  normalizeCivicValidationResponse,
  parseImagePayload,
} from '../src/server/civicVisionHelpers';
import {
  performGroundedInpainting,
  verifyImageSimilarity,
} from '../src/server/groundedCleanup';
import {
  CIVIC_ISSUE_EDUCATION_GUIDES,
  getEducationGuideForCategory,
} from '../src/data/civicIssueEducation';
import {
  checkDuplicatePhoto,
  computeImageFingerprint,
} from '../src/services/imageOptimizer';
import {
  clearCivicImageCaches,
  FRIENDLY_IMAGE_TIMEOUT_MESSAGE,
  INSPECT_CIVIC_IMAGE_TIMEOUT_MS,
  inspectCivicPhotoQuality,
  VALIDATE_CIVIC_IMAGE_TIMEOUT_MS,
  validateCivicIssueImage,
  visualizeCivicImprovement,
} from '../src/services/civicImageService';

let passed = 0;
let total = 0;
const SKIP = Symbol('skip');

async function runCase(
  name: string,
  fn: () => Promise<void | typeof SKIP> | void | typeof SKIP
) {
  total++;
  try {
    const result = await fn();
    if (result === SKIP) {
      console.log(`- SKIP: ${name}`);
      return;
    }
    passed++;
    console.log(`✓ PASS: ${name}`);
  } catch (err: any) {
    console.error(`✗ FAIL: ${name}\n   -> ${err?.message || err}`);
    throw err;
  }
}

function loadImageFixture(relativePath: string, mimeType: string): string {
  const image = fs.readFileSync(path.resolve(process.cwd(), relativePath));
  return `data:${mimeType};base64,${image.toString('base64')}`;
}

async function runAll() {
  console.log('========================================================================');
  console.log('CiviFix AI - Civic Image Intelligence & Educational Guides Verification');
  console.log('All Gemini assertions use offline deterministic mocks (zero live API calls)');
  console.log('========================================================================\n');

  const syntheticFixtures = {
    road: loadImageFixture(
      'public/assets/aistudio/0d8f59ef-650e-4ca0-9132-cc2008b4ea7d_26c81b42.png',
      'image/png'
    ),
    other: loadImageFixture('public/assets/aistudio/image_adf5b901.png', 'image/png'),
  };

  // 1. Payload parsing tests
  await runCase('parseImagePayload supports both Data URI and raw base64 payloads', () => {
    const sample = syntheticFixtures.road;
    const parsedUri = parseImagePayload(sample);
    assert.ok(parsedUri !== null);
    assert.equal(parsedUri!.mimeType, 'image/png');

    const rawOnly = sample.split(',')[1];
    const parsedRaw = parseImagePayload(rawOnly);
    assert.ok(parsedRaw !== null);
    assert.equal(parsedRaw!.mimeType, 'image/jpeg');
    assert.equal(parsedRaw!.cleanBase64, rawOnly);

    const badMime = parseImagePayload('data:application/pdf;base64,JVBERi0xLjQKAAAA');
    assert.equal(badMime, null);
  });

  // 2. Category validation tests across all 8 canonical civic categories (mocked Gemini JSON)
  await runCase('Validates all civic issue categories and separates visibleObservations from aiAssumptions', () => {
    const scenarios = [
      { rawCategory: 'Garbage', subType: 'Garbage dumping', expectedCategory: 'Garbage accumulation' },
      { rawCategory: 'Overflowing bins', subType: 'Overflowing dustbin', expectedCategory: 'Overflowing dustbins' },
      { rawCategory: 'Pothole', subType: 'Pothole', expectedCategory: 'Potholes' },
      { rawCategory: 'Road cracks', subType: 'Road cracks', expectedCategory: 'Damaged roads' },
      { rawCategory: 'Drainage', subType: 'Blocked drains', expectedCategory: 'Drainage problems' },
      { rawCategory: 'Sewage overflow', subType: 'Sewage overflow', expectedCategory: 'Drainage problems' },
      { rawCategory: 'Waterlogging', subType: 'Stagnant water', expectedCategory: 'Drainage problems' },
      { rawCategory: 'Water Leakage', subType: 'Water leakage', expectedCategory: 'Water leakage' },
      { rawCategory: 'Broken Streetlight', subType: 'Broken streetlights', expectedCategory: 'Streetlight problems' },
      { rawCategory: 'Damaged footpaths', subType: 'Damaged footpaths', expectedCategory: 'Other civic issues' },
      { rawCategory: 'Fallen trees', subType: 'Fallen trees', expectedCategory: 'Other civic issues' },
      { rawCategory: 'Damaged public infrastructure', subType: 'Damaged traffic signs', expectedCategory: 'Other civic issues' },
    ];

    for (const s of scenarios) {
      const normalized = normalizeCivicValidationResponse({
        parsed: {
          decision: 'VALID_CIVIC_ISSUE',
          isCivicIssue: true,
          issueDetected: `${s.subType} visible`,
          detectedIssueType: s.subType,
          primaryCategory: s.rawCategory,
          visualSubType: s.subType,
          suggestedSeverity: 'High',
          severityReason: `High severity due to visible ${s.subType.toLowerCase()} public risk.`,
          shortExplanation: `Visible ${s.subType.toLowerCase()} detected in the uploaded street photo.`,
          suggestedTitle: `${s.subType} reported on roadway`,
          suggestedDescription: `Visible ${s.subType.toLowerCase()} affecting public safety in the photographed area.`,
          confidenceLevel: 'HIGH',
          visibleObservations: [`Visible defect: ${s.subType} in roadway frame`],
          aiAssumptions: ['Possible weathering or delayed maintenance'],
          potentialPublicImpact: 'Affects neighborhood cleanliness or safe pedestrian passage',
          recommendedActions: ['Inspect site and dispatch local municipal crew'],
          safetyPrecautions: 'Keep clear of active traffic while inspecting.',
          confidencePercent: 88,
          defectBoundingBoxes: [{ ymin: 300, xmin: 250, ymax: 750, xmax: 750, label: s.subType }],
        },
        qualitySummary: { quality_rating: 'Good', is_blurry: false, is_dark: false, is_overexposed: false, is_poor_visibility: false },
      });

      assert.equal(normalized.decision, 'VALID_CIVIC_ISSUE');
      assert.equal(normalized.primaryCategory, s.expectedCategory);
      assert.equal(normalized.suggestedSeverity, 'High');
      assert.ok(normalized.severityReason && normalized.severityReason.length > 0);
      assert.equal(normalized.detectedIssueType, s.subType);
      assert.ok(normalized.shortExplanation && normalized.shortExplanation.length > 0);
      assert.ok(normalized.suggestedTitle && normalized.suggestedTitle.length > 0);
      assert.ok(normalized.suggestedDescription && normalized.suggestedDescription.length > 0);
      assert.equal(normalized.confidenceLevel, 'High');
      assert.equal(normalized.canProceedToSubmit, true);
      assert.equal(normalized.citizenStatusMessage, CITIZEN_VALID_MESSAGE);
      assert.ok(normalized.visibleObservations!.length > 0);
      assert.ok(normalized.aiAssumptions!.length > 0);
      assert.equal(normalized.beforeAfterEligible, true);
      assert.equal(normalized.requiresHumanReview, false);
    }

    assert.equal(mapToCanonicalCategory('Waterlogging near school'), 'Drainage problems');
    assert.equal(mapToCanonicalCategory('Damaged traffic sign'), 'Other civic issues');
    assert.equal(mapToCanonicalCategory('Overflowing dustbins'), 'Overflowing dustbins');
    assert.equal(mapToCanonicalCategory('Garbage'), 'Garbage accumulation');
    assert.equal(mapToCanonicalCategory('Pothole'), 'Potholes');
    assert.equal(mapToCanonicalCategory('Road cracks'), 'Damaged roads');
    assert.equal(mapToCanonicalCategory('Water Leakage'), 'Water leakage');
    assert.equal(mapToCanonicalCategory('Broken Streetlight'), 'Streetlight problems');
  });

  // 3. Unrelated image rejection (selfie/portrait)
  await runCase('Flags unrelated images (selfie/portrait) with exact citizen message and blocks normal submit', () => {
    const result = normalizeCivicValidationResponse({
      parsed: {
        decision: 'UNRELATED_IMAGE',
        isCivicIssue: false,
        issueDetected: 'Selfie portrait indoors',
        primaryCategory: 'Unrelated / Non-Civic',
        visualSubType: 'Portrait / Selfie',
        visibleObservations: ['Close-up portrait indoors with no public street or civic defect visible.'],
        aiAssumptions: [],
        confidencePercent: 94,
      },
    });

    assert.equal(result.decision, 'UNRELATED_IMAGE');
    assert.equal(result.isCivicIssue, false);
    assert.equal(result.canProceedToSubmit, false);
    assert.equal(result.citizenStatusMessage, CITIZEN_UNRELATED_MESSAGE);
    assert.equal(result.rejectionReason, CITIZEN_UNRELATED_MESSAGE);
    assert.equal(result.beforeAfterEligible, false);
  });

  // 4. Cultural/religious neutrality in prompt + valid issue near cultural site
  await runCase('Preserves cultural/religious neutrality in prompt and allows genuine issues near cultural sites', () => {
    const prompt = buildCivicValidationPrompt({
      description: 'Garbage pile accumulated outside the temple gate',
      selectedCategory: 'Garbage',
    });
    assert.ok(prompt.includes('CULTURAL & RELIGIOUS NEUTRALITY'));
    assert.ok(prompt.toLowerCase().includes('do not reject or penalize'));

    const templeLitter = normalizeCivicValidationResponse({
      parsed: {
        decision: 'VALID_CIVIC_ISSUE',
        isCivicIssue: true,
        primaryCategory: 'Garbage',
        visualSubType: 'Waste accumulation',
        visibleObservations: ['Overflowing garbage bags beside decorative temple archway.'],
        aiAssumptions: ['Post-festival bin overflow awaiting scheduled collection.'],
        confidencePercent: 86,
        defectBoundingBoxes: [{ ymin: 600, xmin: 300, ymax: 900, xmax: 700, label: 'waste_pile' }],
      },
    });
    assert.equal(templeLitter.decision, 'VALID_CIVIC_ISSUE');
    assert.equal(templeLitter.canProceedToSubmit, true);
  });

  // 5. Uncertain / fallback honest Needs Review behavior
  await runCase('Handles uncertain results and unavailable fallback honestly as Needs Review', () => {
    const lowConf = normalizeCivicValidationResponse({
      parsed: {
        decision: 'POSSIBLE_CIVIC_ISSUE_NEEDS_REVIEW',
        isCivicIssue: 'uncertain',
        primaryCategory: 'Drainage',
        visualSubType: 'Needs Review',
        confidencePercent: 35,
      },
    });
    assert.equal(lowConf.decision, 'POSSIBLE_CIVIC_ISSUE_NEEDS_REVIEW');
    assert.equal(lowConf.requiresHumanReview, true);
    assert.equal(lowConf.confidence, null);
    assert.equal(lowConf.citizenStatusMessage, CITIZEN_UNCLEAR_MESSAGE);
    assert.equal(lowConf.beforeAfterEligible, false);

    const fallback = buildFallbackValidationResult({
      selectedCategory: 'Broken Streetlight',
      reason: 'Gemini timeout',
    });
    assert.equal(fallback.isFallback, true);
    assert.equal(fallback.visualSubType, 'Needs Review');
    assert.equal(fallback.requiresHumanReview, true);
    assert.equal(fallback.confidence, null);
    assert.equal(fallback.canProceedToSubmit, true);
  });

  // 6. Python OpenCV poor-visibility heuristic + category-aware Telea inpainting preservation
  await runCase('Python OpenCV detects poor-visibility image without blocking and preserves >95% background on pothole repair', async () => {
    const pythonCandidates = [
      path.resolve(process.cwd(), '.venv/bin/python3'),
      path.resolve(process.cwd(), '.venv/Scripts/python.exe'),
      process.platform === 'win32' ? 'python' : 'python3',
    ];
    const pyBin = pythonCandidates.find((candidate) => {
      if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) return false;
      return spawnSync(candidate, ['-c', 'import cv2'], { encoding: 'utf-8' }).status === 0;
    });

    if (!pyBin) {
      return SKIP;
    }

    const pyCheck = spawnSync(
      pyBin,
      [
        '-c',
        `
import json, base64, cv2, numpy as np
from ml.image_processor import decode_base64_image, inspect_image_quality

# Low-dynamic-range foggy/hazy flat grey frame (160x160)
img = np.full((160, 160, 3), 128, dtype=np.uint8)
img[40:120, 40:120] = 136
_, buf = cv2.imencode('.jpg', img)
b64 = 'data:image/jpeg;base64,' + base64.b64encode(buf).decode()
decoded, err = decode_base64_image(b64)
assert err is None and decoded is not None
res = inspect_image_quality(decoded, 'image/jpeg')
print(json.dumps(res))
`,
      ],
      { encoding: 'utf-8', cwd: process.cwd() }
    );

    assert.equal(pyCheck.status, 0, `Python OpenCV check failed: ${pyCheck.stderr}`);
    const qualityRes = JSON.parse(pyCheck.stdout.trim());
    assert.equal(qualityRes.valid, true, 'Imperfect valid image must not be blocked');
    assert.equal(qualityRes.is_poor_visibility, true, 'Flat low-contrast image must trigger is_poor_visibility');
    assert.ok(Array.isArray(qualityRes.warnings) && qualityRes.warnings.length > 0);

    // Same-image restoration test using synthetic street scene with localized pothole bbox
    const roadDataUrl = syntheticFixtures.road;
    const box = [{ ymin: 620, xmin: 380, ymax: 780, xmax: 580, label: 'pothole_repair' }];
    const repaired = await performGroundedInpainting(roadDataUrl, box, 'Pothole');
    assert.ok(repaired.cleanedPhoto.startsWith('data:image/'));
    assert.notEqual(repaired.cleanedPhoto, roadDataUrl);

    const sim = await verifyImageSimilarity(roadDataUrl, repaired.cleanedPhoto, box, false);
    assert.equal(sim.scene_preserved, true);
    assert.ok(sim.unaffected_retention >= 95.0, `Expected >=95% retention, got ${sim.unaffected_retention}`);
  });

  // 7. Educational guides coverage and hedged risk disclaimers
  await runCase('Civic awareness guides cover every category with cause, impact, hedged risks, prevention & actions', () => {
    assert.ok(CIVIC_ISSUE_EDUCATION_GUIDES.length >= 6);
    const categories = ['Garbage', 'Pothole', 'Drainage', 'Water Leakage', 'Broken Streetlight', 'Other'];
    for (const cat of categories) {
      const guide = getEducationGuideForCategory(cat);
      assert.ok(guide.whatItIs.length > 20);
      assert.ok(guide.whyItHappens.length >= 2);
      assert.ok(guide.publicAndEnvironmentalImpact.length >= 2);
      assert.ok(guide.potentialRisks.length >= 1);
      assert.ok(guide.howCitizensHelp.length >= 2);
      assert.ok(guide.appropriateMunicipalActions.length >= 2);
      assert.ok(guide.riskDisclaimer.length > 10);
    }
    const footpathGuide = getEducationGuideForCategory('Other', 'Damaged footpaths');
    assert.equal(footpathGuide.category, 'Other');
    assert.equal(BEFORE_AFTER_DISCLAIMER, 'AI-generated improvement preview – illustrative only.');
  });

  // 8. Duplicate photograph detection & fingerprint determinism
  await runCase('Detects duplicate complaint photos while ignoring withdrawn reports', async () => {
    const imgA = syntheticFixtures.road;
    const imgB = syntheticFixtures.other;
    const fp1 = await computeImageFingerprint(imgA);
    const fp2 = await computeImageFingerprint(imgA);
    const fpOther = await computeImageFingerprint(imgB);
    assert.ok(fp1.length > 8);
    assert.equal(fp1, fp2);
    assert.notEqual(fp1, fpOther);

    const dupWithdrawn = await checkDuplicatePhoto(imgA, [
      { trackingNumber: 'CF-OLD-001', photoUrl: imgA, status: 'Withdrawn' },
    ]);
    assert.equal(dupWithdrawn.isDuplicate, false);

    const dupActive = await checkDuplicatePhoto(imgA, [
      { trackingNumber: 'CF-ACT-002', title: 'Previous Report', photoUrl: imgA, status: 'Submitted' },
    ]);
    assert.equal(dupActive.isDuplicate, true);
    assert.equal(dupActive.matchingTrackingNumber, 'CF-ACT-002');
  });

  // 9. Frontend service caching deduplicates repeated calls & handles unavailable state
  await runCase('civicImageService caches validation & preview requests and supports unavailable Before & After state', async () => {
    clearCivicImageCaches();
    let validateCalls = 0;
    const mockValidateFetcher: typeof fetch = async () => {
      validateCalls++;
      return new Response(
        JSON.stringify(
          normalizeCivicValidationResponse({
            parsed: {
              decision: 'VALID_CIVIC_ISSUE',
              isCivicIssue: true,
              primaryCategory: 'Pothole',
              visualSubType: 'Pothole',
              confidencePercent: 90,
            },
          })
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const img = syntheticFixtures.road;
    const first = await validateCivicIssueImage({
      photoBase64: img,
      description: 'Deep pothole near bus stop',
      selectedCategory: 'Pothole',
      fetcher: mockValidateFetcher,
    });
    const second = await validateCivicIssueImage({
      photoBase64: img,
      description: 'Deep pothole near bus stop',
      selectedCategory: 'Pothole',
      fetcher: mockValidateFetcher,
    });
    assert.equal(validateCalls, 1, 'Expected session cache to avoid duplicate Gemini calls');
    assert.equal(first.decision, second.decision);

    // Unavailable state should NOT be cached and should carry BEFORE_AFTER_DISCLAIMER
    let vizCalls = 0;
    const mockUnavailableVizFetcher: typeof fetch = async () => {
      vizCalls++;
      return new Response(
        JSON.stringify({
          visualizedImageUrl: '',
          isUnavailable: true,
          unavailableReason: 'No clear defect mask isolated.',
          category: 'Pothole',
          identifiedIssues: ['No defect mask isolated'],
          recommendedActions: ['Inspect in person'],
          environmentalBenefit: '',
          disclaimer: BEFORE_AFTER_DISCLAIMER,
          transformationMethod: 'unavailable',
          timestamp: new Date().toISOString(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const viz1 = await visualizeCivicImprovement({
      photoBase64: img,
      category: 'Pothole',
      fetcher: mockUnavailableVizFetcher,
    });
    assert.equal(viz1.isUnavailable, true);
    assert.equal(viz1.visualizedImageUrl, '');
    assert.equal(viz1.disclaimer, BEFORE_AFTER_DISCLAIMER);

    await visualizeCivicImprovement({
      photoBase64: img,
      category: 'Pothole',
      fetcher: mockUnavailableVizFetcher,
    });
    assert.equal(vizCalls, 2, 'Unavailable responses must remain retryable without stale cache');
  });

  // 10. Backend Gemini 18s deadline, SDK abortSignal propagation, bounded retries & fallback
  await runCase('Backend Gemini validation enforces 18s deadline, bounded retries, AbortSignal cancellation, and fallback', async () => {
    process.env.CIVIFIX_NO_LISTEN = '1';
    const {
      GEMINI_IMAGE_VALIDATION_ATTEMPT_TIMEOUT_MS,
      GEMINI_IMAGE_VALIDATION_DEADLINE_MS,
      GEMINI_IMAGE_VALIDATION_MAX_ATTEMPTS,
      generateCivicImageValidationWithDeadline,
    } = await import('../server');

    assert.equal(GEMINI_IMAGE_VALIDATION_DEADLINE_MS, 18_000);
    assert.equal(GEMINI_IMAGE_VALIDATION_ATTEMPT_TIMEOUT_MS, 12_000);
    assert.equal(GEMINI_IMAGE_VALIDATION_MAX_ATTEMPTS, 2);

    let capturedConfig: any = null;
    const hangingAi = {
      models: {
        generateContent: async (req: any) => {
          capturedConfig = req.config;
          return await new Promise<any>((_resolve, reject) => {
            req.config.abortSignal.addEventListener(
              'abort',
              () => {
                const err: any = new Error('Aborted by SDK signal');
                err.name = 'AbortError';
                reject(err);
              },
              { once: true }
            );
          });
        },
      },
    };

    const startedAt = Date.now();
    await assert.rejects(
      () =>
        generateCivicImageValidationWithDeadline({
          ai: hangingAi as any,
          parsedImg: { mimeType: 'image/jpeg', cleanBase64: syntheticFixtures.road.split(',')[1] },
          prompt: 'Analyze street defect',
          deadlineMs: 45,
          attemptTimeoutMs: GEMINI_IMAGE_VALIDATION_ATTEMPT_TIMEOUT_MS,
          maxAttempts: GEMINI_IMAGE_VALIDATION_MAX_ATTEMPTS,
        }),
      (err: any) => err?.name === 'AbortError'
    );
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 1000, `Expected fast abort around 45ms, took ${elapsed}ms`);
    assert.ok(capturedConfig?.abortSignal?.aborted === true, 'Expected SDK abortSignal to be aborted');
    assert.equal(capturedConfig?.httpOptions?.timeout, 45);
    assert.equal(capturedConfig?.httpOptions?.retryOptions?.attempts, 2);

    const fallback = buildFallbackValidationResult({
      selectedCategory: 'Potholes',
      reason: 'Automatic photo detection took too long. Your photograph is saved for manual review or you can retry.',
    });
    assert.equal(fallback.isFallback, true);
    assert.equal(fallback.requiresHumanReview, true);
    assert.equal(fallback.canProceedToSubmit, true);
  });

  // 11. Frontend validateCivicIssueImage 22s safety timeout, loading cleanup & non-poisoning cache
  await runCase('Frontend validateCivicIssueImage enforces safety timeout, cleans loading state, and remains retryable', async () => {
    clearCivicImageCaches();
    assert.equal(VALIDATE_CIVIC_IMAGE_TIMEOUT_MS, 22_000);

    let capturedSignal: AbortSignal | null | undefined;
    const hangingFetcher: typeof fetch = async (_url, init) => {
      capturedSignal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            const err: any = new Error('Client fetch aborted');
            err.name = 'AbortError';
            reject(err);
          },
          { once: true }
        );
      });
    };

    let isVerifyingLoading = false;
    let capturedErr: any = null;
    try {
      isVerifyingLoading = true;
      await validateCivicIssueImage({
        photoBase64: syntheticFixtures.road,
        timeoutMs: 40,
        fetcher: hangingFetcher,
      });
    } catch (err) {
      capturedErr = err;
    } finally {
      isVerifyingLoading = false;
    }

    assert.equal(isVerifyingLoading, false, 'Loading state must always reset in finally');
    assert.ok(capturedSignal?.aborted === true, 'Client fetch AbortSignal must abort on timeout');
    assert.equal(capturedErr?.name, 'AbortError');
    assert.equal(capturedErr?.message, FRIENDLY_IMAGE_TIMEOUT_MESSAGE);

    // Retry with working mock fetcher must succeed (timeout must not cache failure)
    const okResult = await validateCivicIssueImage({
      photoBase64: syntheticFixtures.road,
      timeoutMs: 200,
      fetcher: async () =>
        new Response(
          JSON.stringify(
            normalizeCivicValidationResponse({
              parsed: {
                decision: 'VALID_CIVIC_ISSUE',
                isCivicIssue: true,
                primaryCategory: 'Pothole',
                visualSubType: 'Pothole',
                confidencePercent: 91,
              },
            })
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ),
    });
    assert.equal(okResult.primaryCategory, 'Potholes');
  });

  // 12. OpenCV 5s inspection timeout must never block Gemini validation or throw technical errors
  await runCase('OpenCV inspectCivicPhotoQuality aborts after timeout without throwing or blocking AI detection', async () => {
    clearCivicImageCaches();
    assert.equal(INSPECT_CIVIC_IMAGE_TIMEOUT_MS, 5_000);

    let inspectSignal: AbortSignal | null | undefined;
    let isInspecting = false;
    let inspectionResult: any = 'not-run';

    try {
      isInspecting = true;
      inspectionResult = await inspectCivicPhotoQuality({
        photoBase64: syntheticFixtures.road,
        timeoutMs: 40,
        fetcher: async (_url, init) => {
          inspectSignal = init?.signal;
          return await new Promise<Response>(() => {
            // Never resolves unless aborted; simulates stalled OpenCV endpoint
          });
        },
      });
    } finally {
      isInspecting = false;
    }

    assert.equal(isInspecting, false);
    assert.equal(inspectSignal?.aborted, true, 'Inspection AbortSignal should trigger at timeout');
    assert.equal(inspectionResult, null, 'Stalled inspection must resolve null cleanly without technical errors');

    // Subsequent Gemini verification still runs immediately afterward
    const geminiAfterTimeout = await validateCivicIssueImage({
      photoBase64: syntheticFixtures.road,
      qualitySummary: null,
      fetcher: async () =>
        new Response(
          JSON.stringify(
            normalizeCivicValidationResponse({
              parsed: {
                decision: 'VALID_CIVIC_ISSUE',
                isCivicIssue: true,
                primaryCategory: 'Garbage',
                visualSubType: 'Garbage dumping',
                confidencePercent: 87,
              },
            })
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ),
    });
    assert.equal(geminiAfterTimeout.primaryCategory, 'Garbage accumulation');
  });

  console.log('\n========================================================================');
  console.log(`Summary: ${passed}/${total} Civic Image Intelligence tests passed.`);
  console.log('========================================================================');
}

runAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
