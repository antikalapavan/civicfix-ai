import { GoogleGenAI, Type } from '@google/genai';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

export interface BoundingBox {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
  label?: string;
}

export interface VerificationMetrics {
  passed: boolean;
  modelUsed: string;
  transformationMethod: string;
  similarityScore: number;
  correlation: number;
  psnr: number;
  scenePreserved: boolean;
  verificationNotes: string;
}

const ML_PORT = 5001;

/**
 * Finds the virtualenv python binary or falls back to system python3.
 */
function resolvePythonBinary(): string {
  const candidates = [
    path.resolve(process.cwd(), '.venv/bin/python3'),
    path.resolve(process.cwd(), '.venv/bin/python'),
    path.resolve(process.cwd(), 'ml/.venv/bin/python3'),
    path.resolve(process.cwd(), '.venv/Scripts/python.exe'),
    path.resolve(process.cwd(), 'ml/.venv/Scripts/python.exe'),
    process.env.PYTHON_BIN,
    'python3',
    'python',
    'py',
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (path.isAbsolute(c) && fs.existsSync(c)) {
      return c;
    }
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Direct Python execution fallback if HTTP loopback service is warming up.
 */
async function runDirectPython(script: string, inputJson: any): Promise<any> {
  const pythonBin = resolvePythonBinary();
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, ['-c', script], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python process exited with code ${code}: ${stderr || stdout}`));
      } else {
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e: any) {
          reject(new Error(`Failed to parse Python output: ${e.message} — Raw: ${stdout}`));
        }
      }
    });

    child.stdin.write(JSON.stringify(inputJson));
    child.stdin.end();
  });
}

/**
 * Performs grounded inpainting on the exact photograph to remove identified litter patches,
 * preserving 100% of the camera viewpoint, buildings, trees, vehicles, and lighting.
 */
export async function performGroundedInpainting(
  photoBase64: string,
  boundingBoxes: BoundingBox[],
  issueCategory?: string
): Promise<{ cleanedPhoto: string; method: string }> {
  // 1. Try internal loopback Flask service first
  try {
    const res = await fetch(`http://127.0.0.1:${ML_PORT}/image/inpaint-cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        photoBase64,
        bounding_boxes: boundingBoxes,
        issue_category: issueCategory || null,
      }),
      signal: AbortSignal.timeout(4000),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.success && data.cleaned_photo) {
        return {
          cleanedPhoto: data.cleaned_photo,
          method: 'OpenCV Fast Marching Inpainting (Telea)',
        };
      }
    }
  } catch {
    // Loopback service not ready or timing out; use direct Python fallback
  }

  // 2. Direct Python in-process fallback
  const pythonScript = `
import sys, json, os
sys.path.insert(0, os.path.abspath('ml'))
from image_processor import inpaint_cleanup_image

data = json.load(sys.stdin)
b64 = data.get('photoBase64', '')
boxes = data.get('bounding_boxes', [])
cat = data.get('issue_category')
cleaned, err = inpaint_cleanup_image(b64, boxes, cat)
if err is not None:
    print(json.dumps({'success': False, 'error': err.get('error')}))
else:
    print(json.dumps({'success': True, 'cleaned_photo': cleaned}))
`;

  const fallbackResult = await runDirectPython(pythonScript, {
    photoBase64,
    bounding_boxes: boundingBoxes,
    issue_category: issueCategory || null,
  });

  if (!fallbackResult.success || !fallbackResult.cleaned_photo) {
    throw new Error(fallbackResult.error || 'Failed to inpaint cleanup on photo.');
  }

  return {
    cleanedPhoto: fallbackResult.cleaned_photo,
    method: 'OpenCV Fast Marching Inpainting (Telea)',
  };
}

/**
 * Computes HSV histogram correlation, PSNR, unaffected background preservation,
 * and waste region difference between original and transformed images.
 */
export async function verifyImageSimilarity(
  origBase64: string,
  transBase64: string,
  boundingBoxes: BoundingBox[] = [],
  isCleanArea: boolean = false
): Promise<{
  verified: boolean;
  scene_preserved: boolean;
  waste_removed: boolean;
  correlation: number;
  psnr: number;
  unaffected_retention: number;
  waste_region_diff: number;
  artifacts_detected: boolean;
  hallucinations_detected: boolean;
  similarity_score: number;
  error: string | null;
}> {
  // 1. Try internal loopback Flask service
  try {
    const res = await fetch(`http://127.0.0.1:${ML_PORT}/image/verify-similarity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        original_base64: origBase64,
        transformed_base64: transBase64,
        bounding_boxes: boundingBoxes,
        is_clean_area: isCleanArea,
      }),
      signal: AbortSignal.timeout(4000),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        return data;
      }
    }
  } catch {
    // Fall back to direct Python
  }

  // 2. Direct Python fallback
  const pythonScript = `
import sys, json, os
sys.path.insert(0, os.path.abspath('ml'))
from image_processor import compute_image_similarity

data = json.load(sys.stdin)
orig = data.get('original_base64', '')
trans = data.get('transformed_base64', '')
boxes = data.get('bounding_boxes', [])
is_clean = data.get('is_clean_area', False)
metrics = compute_image_similarity(orig, trans, bounding_boxes=boxes, is_clean_area=is_clean)
print(json.dumps({'success': True, **metrics}))
`;

  const result = await runDirectPython(pythonScript, {
    original_base64: origBase64,
    transformed_base64: transBase64,
    bounding_boxes: boundingBoxes,
    is_clean_area: isCleanArea,
  });

  return result;
}

/**
 * Attempts image-to-image transformation with gemini-3.1-flash-lite-image if available.
 * Returns null if the model is unsupported, unavailable, or restricted.
 */
export async function attemptGeminiImageToImage(
  ai: GoogleGenAI,
  photoBase64: string,
  issues: string[]
): Promise<{ transformedPhoto: string; modelUsed: string } | null> {
  try {
    const mimeMatch = photoBase64.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const cleanBase64 = photoBase64.replace(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,/, '');

    const prompt = `You are an image restoration specialist.
Attached is a citizen's photograph of a public street / area with visible litter and waste: ${issues.join(', ')}.
Task: Generate an edited version of THIS EXACT SAME photograph with the litter and waste removed.
CRITICAL PRESERVATION CONSTRAINTS:
1. Preserve 100% of the original camera angle, perspective, buildings, structures, roads, trees, vehicles, and lighting.
2. Remove ONLY the identified litter and debris, replacing that ground area with clean pavement or natural ground texture.
3. DO NOT add any new buildings, roads, people, vehicles, or fantasy elements.
4. The output must be an image.`;

    const imageModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
    const response = await ai.models.generateContent({
      model: imageModel,
      contents: [
        { inlineData: { mimeType, data: cleanBase64 } },
        { text: prompt },
      ],
    });

    const candidate = response.candidates?.[0];
    const imagePart = candidate?.content?.parts?.find((p: any) => p.inlineData?.data);

    if (imagePart?.inlineData?.data) {
      const outMime = imagePart.inlineData.mimeType || 'image/jpeg';
      return {
        transformedPhoto: `data:${outMime};base64,${imagePart.inlineData.data}`,
        modelUsed: `${imageModel} (Image-to-Image Editing)`,
      };
    }
  } catch {
    console.info('[CleanupVision] Image-to-image model unavailable. Transitioning to grounded Telea reconstruction.');
  }

  return null;
}

/**
 * Multimodal scene preservation verification using gemini-3.8-flash comparing
 * original Before photo with transformed After photo.
 */
export async function verifySceneConsistencyWithGemini(
  ai: GoogleGenAI,
  origBase64: string,
  transBase64: string
): Promise<{ scenePreserved: boolean; noHallucinations: boolean; verificationNotes: string }> {
  try {
    const mimeMatch1 = origBase64.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,/);
    const mimeType1 = mimeMatch1 ? mimeMatch1[1] : 'image/jpeg';
    const clean1 = origBase64.replace(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,/, '');

    const mimeMatch2 = transBase64.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,/);
    const mimeType2 = mimeMatch2 ? mimeMatch2[1] : 'image/jpeg';
    const clean2 = transBase64.replace(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,/, '');

    const prompt = `Compare Image 1 (Original civic photograph) and Image 2 (Simulated clean community photograph).
Rigorous scene preservation verification:
1. Did Image 2 preserve the exact camera angle, perspective, viewpoint, and background structures (buildings, roads, trees, walls)?
2. Were any imaginary buildings, fake people, fantasy objects, or random landscapes added? (noHallucinations should be true if NONE were added).
3. Did Image 2 cleanly remove the litter/debris from the affected ground areas?

Return JSON matching the schema.`;

    const configuredVisionModel = (process.env.GEMINI_MODEL || '').trim();
    const visionModel =
      configuredVisionModel && configuredVisionModel !== 'gemini-4-hydrogen'
        ? configuredVisionModel
        : 'gemini-2.5-flash';
    const response = await ai.models.generateContent({
      model: visionModel,
      contents: [
        { inlineData: { mimeType: mimeType1, data: clean1 } },
        { inlineData: { mimeType: mimeType2, data: clean2 } },
        { text: prompt },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            scenePreserved: {
              type: Type.BOOLEAN,
              description: 'Whether camera angle, buildings, and background are preserved',
            },
            noHallucinations: {
              type: Type.BOOLEAN,
              description: 'Whether NO imaginary buildings, fantasy elements or fake people were added',
            },
            cleanupEffective: {
              type: Type.BOOLEAN,
              description: 'Whether litter was removed from ground',
            },
            verificationNotes: {
              type: Type.STRING,
              description: 'Brief 1-sentence verification assessment',
            },
          },
          required: ['scenePreserved', 'noHallucinations', 'cleanupEffective', 'verificationNotes'],
        },
      },
    });

    const parsed = JSON.parse(response.text?.trim() || '{}');
    return {
      scenePreserved: Boolean(parsed.scenePreserved),
      noHallucinations: Boolean(parsed.noHallucinations),
      verificationNotes: parsed.verificationNotes || 'Scene geometry and background verified against original.',
    };
  } catch {
    console.info('[CleanupVision] Gemini comparative verification unavailable; do not mark Gemini check passed.');
    return {
      scenePreserved: false,
      noHallucinations: false,
      verificationNotes: 'Gemini visual consistency check unavailable.',
    };
  }
}
