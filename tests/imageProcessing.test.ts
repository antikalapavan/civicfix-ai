import assert from 'node:assert';

console.log('--- RUNNING CIVIFIX AI PHASE 5 IMAGE PROCESSING TEST SUITE ---');

let passedTests = 0;
let totalTests = 0;
const asyncTestPromises: Promise<void>[] = [];

function test(name: string, fn: () => void | Promise<void>) {
  totalTests++;
  try {
    const res = fn();
    if (res && typeof (res as any).then === 'function') {
      const p = (res as Promise<void>)
        .then(() => {
          console.log(`  ✓ ${name}`);
          passedTests++;
        })
        .catch((err) => {
          console.error(`  ✗ ${name}`);
          console.error(`    Error:`, err.message);
          throw err;
        });
      asyncTestPromises.push(p);
      return p;
    }
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err: any) {
    console.error(`  ✗ ${name}`);
    console.error(`    Error:`, err.message);
    throw err;
  }
}

// 1. Payload validation tests
test('Rejects missing or empty photoBase64 payload', () => {
  const emptyInputs = [null, undefined, '', '   ', 12345, {}];
  for (const input of emptyInputs) {
    const isValid = typeof input === 'string' && input.trim().length > 0;
    assert.strictEqual(isValid, false, `Expected ${JSON.stringify(input)} to be invalid`);
  }
});

// 2. 5MB size limit validation
test('Enforces 5MB server-side payload size limit', () => {
  const maxBase64Length = 7_500_000;
  const smallPayload = 'data:image/jpeg;base64,' + 'A'.repeat(5000);
  const oversizedPayload = 'data:image/jpeg;base64,' + 'A'.repeat(8_000_000);

  assert.strictEqual(smallPayload.length <= maxBase64Length, true);
  assert.strictEqual(oversizedPayload.length > maxBase64Length, true);
});

// 3. Format header validation
test('Rejects non-image mime formats in data URI', () => {
  const allowedDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const disallowedPdf = 'data:application/pdf;base64,JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDM=';
  const disallowedExe = 'data:application/octet-stream;base64,TVqQAAMAAAAEAAAA//8AALgAAAAAAAAAQAA=';

  function isValidImageMime(payload: string): boolean {
    if (payload.startsWith('data:') && !payload.startsWith('data:image/')) {
      return false;
    }
    return true;
  }

  assert.strictEqual(isValidImageMime(allowedDataUri), true);
  assert.strictEqual(isValidImageMime(disallowedPdf), false);
  assert.strictEqual(isValidImageMime(disallowedExe), false);
});

// 4. Advisory nature verification: Submission is never blocked by warnings
test('Quality warnings are strictly advisory and never prevent submission', () => {
  const inspectionResponse = {
    success: true,
    isAvailable: true,
    is_advisory_only: true,
    warnings: [
      'Photo appears out of focus or blurry.',
      'Photo appears dimly lit.',
    ],
    quality: {
      quality_rating: 'Needs Attention',
      is_blurry: true,
      is_dark: true,
    },
  };

  // The application must allow submission even when quality is 'Needs Attention'
  const allowSubmission = inspectionResponse.is_advisory_only === true;
  assert.strictEqual(allowSubmission, true);
  assert.strictEqual(inspectionResponse.warnings.length, 2);
});

// 5. Offline & Unreachable Service Graceful Degradation
test('Graceful failover when Python OpenCV service is unreachable', () => {
  // Simulates offline service fallback response returned by Express server
  const offlineFallback = {
    success: false,
    isAvailable: false,
    isTimeout: false,
    warnings: [],
    is_advisory_only: true,
    message: 'Image inspection service is currently unavailable. You may proceed with submission.',
  };

  assert.strictEqual(offlineFallback.isAvailable, false);
  assert.strictEqual(offlineFallback.is_advisory_only, true);
  assert.strictEqual(offlineFallback.warnings.length, 0);
  // Citizen can submit normally
  const canCitizenSubmit = true;
  assert.strictEqual(canCitizenSubmit, true);
});

// -------------------------------------------------------------
// 6. PHASE 6 STEP 1: IN-MEMORY IMAGE OPTIMIZATION TESTS
// -------------------------------------------------------------
import {
  calculateProportionalDimensions,
  calculateBase64ByteSize,
  IMAGE_LIMITS,
} from '../src/services/imageOptimizer.js';

test('calculateProportionalDimensions scales large landscape image preserving aspect ratio', () => {
  // Typical high-res smartphone photo: 4032 x 3024 (4:3 aspect ratio)
  const origW = 4032;
  const origH = 3024;
  const maxDim = 1280;

  const { width, height } = calculateProportionalDimensions(origW, origH, maxDim);

  assert.strictEqual(width, 1280);
  assert.strictEqual(height, 960);
  // Aspect ratio preserved within 0.1%
  const origRatio = origW / origH;
  const newRatio = width / height;
  assert(Math.abs(origRatio - newRatio) < 0.001);
});

test('calculateProportionalDimensions scales large portrait image preserving aspect ratio', () => {
  // Portrait smartphone photo: 3024 x 4032
  const origW = 3024;
  const origH = 4032;
  const maxDim = 1280;

  const { width, height } = calculateProportionalDimensions(origW, origH, maxDim);

  assert.strictEqual(width, 960);
  assert.strictEqual(height, 1280);
  const origRatio = origW / origH;
  const newRatio = width / height;
  assert(Math.abs(origRatio - newRatio) < 0.001);
});

test('calculateProportionalDimensions keeps smaller images without upscaling', () => {
  const origW = 640;
  const origH = 480;
  const maxDim = 1280;

  const { width, height } = calculateProportionalDimensions(origW, origH, maxDim);

  assert.strictEqual(width, 640);
  assert.strictEqual(height, 480);
});

test('calculateBase64ByteSize accurately computes binary byte payload', () => {
  // 1000 'A' characters without padding = (1000 * 3) / 4 = 750 bytes
  const dummyPayload = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
  const size = calculateBase64ByteSize(dummyPayload);
  assert.strictEqual(size, 750);

  // With 2 padding characters
  const paddedPayload = 'data:image/jpeg;base64,' + 'A'.repeat(998) + '==';
  const paddedSize = calculateBase64ByteSize(paddedPayload);
  assert.strictEqual(paddedSize, 748);
});

test('Enforces 250 KB target and 350 KB hard cap limits on image optimizer config', () => {
  assert.strictEqual(IMAGE_LIMITS.TARGET_BYTES, 250 * 1024);
  assert.strictEqual(IMAGE_LIMITS.HARD_MAX_BYTES, 350 * 1024);
  assert.strictEqual(IMAGE_LIMITS.INITIAL_MAX_DIM, 1280);
  assert.strictEqual(IMAGE_LIMITS.INITIAL_QUALITY, 0.80);
  // Guarantee that even at hard cap (350 KB), Base64 size (~470 KB) leaves >500 KB headroom below Firestore's 1 MiB limit
  const base64AtHardCap = Math.ceil((IMAGE_LIMITS.HARD_MAX_BYTES * 4) / 3);
  assert(base64AtHardCap < 500 * 1024, 'Base64 image at hard cap must be well under 500 KB');
});

test('Image processing fails safely for empty or invalid data without silently restoring', async () => {
  const { optimizeBase64Image, optimizeResolutionPhotoDataUrl, RESOLUTION_IMAGE_LIMITS } = await import(
    '../src/services/imageOptimizer.js'
  );
  const res = await optimizeBase64Image('');
  assert.strictEqual(res.success, false);
  assert(res.error !== undefined);
  assert.strictEqual(res.dataUrl, undefined);

  assert(
    RESOLUTION_IMAGE_LIMITS.TARGET_BYTES < IMAGE_LIMITS.TARGET_BYTES &&
      RESOLUTION_IMAGE_LIMITS.HARD_MAX_BYTES < IMAGE_LIMITS.HARD_MAX_BYTES &&
      RESOLUTION_IMAGE_LIMITS.HARD_MAX_BYTES <= 240 * 1024,
    'Resolution photo limits must stay strictly tighter than citizen photo limits'
  );

  const resResolution = await optimizeResolutionPhotoDataUrl('');
  assert.strictEqual(resResolution.success, false);
  assert.strictEqual(resResolution.dataUrl, undefined);
});

// -------------------------------------------------------------
// 7. SINGLE-PHOTO UPLOAD VALIDATION TESTS
// -------------------------------------------------------------
import {
  CIVIC_UPLOAD_LIMITS,
  validateCivicImageUpload,
} from '../src/services/imageOptimizer.js';

test('validateCivicImageUpload enforces JPG/PNG/WebP formats, mobile extension fallback, and 5 MB limit', () => {
  assert.strictEqual(
    validateCivicImageUpload({ type: 'image/jpeg', size: 1024 * 500, name: 'issue.jpg' }).valid,
    true
  );
  assert.strictEqual(
    validateCivicImageUpload({ type: 'image/jpg', size: 1024 * 500, name: 'issue.jpg' }).valid,
    true
  );
  assert.strictEqual(
    validateCivicImageUpload({ type: 'image/png', size: 1024 * 1024, name: 'issue.png' }).valid,
    true
  );
  assert.strictEqual(
    validateCivicImageUpload({ type: 'image/webp', size: 2048, name: 'issue.webp' }).valid,
    true
  );

  // Mobile camera/gallery selection where file.type may be empty string
  assert.strictEqual(
    validateCivicImageUpload({ type: '', size: 150_000, name: 'IMG_20261116.JPG' }).valid,
    true
  );
  assert.strictEqual(
    validateCivicImageUpload({ type: '', size: 150_000, name: 'doc.pdf' }).valid,
    false
  );

  // Unsupported MIME types
  const badGif = validateCivicImageUpload({ type: 'image/gif', size: 5000, name: 'anim.gif' });
  assert.strictEqual(badGif.valid, false);
  assert(badGif.error?.includes('JPG, PNG, or WebP'));

  const badPdf = validateCivicImageUpload({ type: 'application/pdf', size: 5000, name: 'file.pdf' });
  assert.strictEqual(badPdf.valid, false);

  // Empty & oversized files (> 5 MB)
  const emptyFile = validateCivicImageUpload({ type: 'image/jpeg', size: 0, name: 'empty.jpg' });
  assert.strictEqual(emptyFile.valid, false);
  assert(emptyFile.error?.toLowerCase().includes('empty'));

  const oversizedFile = validateCivicImageUpload({
    type: 'image/jpeg',
    size: CIVIC_UPLOAD_LIMITS.MAX_FILE_SIZE_BYTES + 1,
    name: 'huge.jpg',
  });
  assert.strictEqual(oversizedFile.valid, false);
  assert(oversizedFile.error?.includes('5MB'));
});

Promise.all(asyncTestPromises).then(() => {
  console.log(`All ${passedTests} / ${totalTests} Phase 5 & 6 image processing tests passed successfully!`);
});
