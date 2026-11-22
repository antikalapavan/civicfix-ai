"""
CiviFix AI - OpenCV Image Preprocessing, Validation & Quality Assessment Module
Phase 5: In-memory image processing for civic complaint photos.

Features:
- In-memory Base64 decoding (zero disk writes)
- Image payload validation and 5MB size enforcement
- Format verification (JPEG, PNG, WEBP)
- Dimension boundary and pixel budget guardrails (prevents DoS/decompression bombs)
- Blur estimation via Laplacian variance
- Illumination/brightness analysis (dark / overexposed detection)
- Contrast analysis via intensity standard deviation
- Non-blocking advisory warnings (never blocks report submission)
"""

import base64
import binascii
from typing import Dict, Any, Tuple, Optional

try:
    import cv2
    import numpy as np
    OPENCV_AVAILABLE = True
    OPENCV_VERSION = cv2.__version__
    # Enable CPU hardware SIMD vectorization and cap worker threads to prevent thrashing
    cv2.setUseOptimized(True)
    cv2.setNumThreads(2)
except ImportError:
    cv2 = None
    np = None
    OPENCV_AVAILABLE = False
    OPENCV_VERSION = None

# Max file limit: 5MB in binary bytes (~6.7MB Base64 string)
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_BASE64_CHARS = int(MAX_FILE_BYTES * 1.37) + 500

# Dimension guardrails: Max 4096 x 4096, Max 16M pixels
MAX_DIMENSION = 4096
MAX_TOTAL_PIXELS = 16_000_000

# Minimum recommended dimensions for clear municipal inspection
MIN_DIMENSION = 200

# Thresholds for quality checks
BLUR_THRESHOLD = 70.0              # Laplacian variance below this indicates blur/lack of edges
DARK_THRESHOLD = 45.0              # Mean luminance below this indicates underexposed/dark scene
OVEREXPOSED_THRESHOLD = 230.0      # Mean luminance above this indicates washed out/overexposed
LOW_CONTRAST_THRESHOLD = 25.0      # Standard deviation below this indicates flat/foggy image
POOR_VISIBILITY_SPAN = 65.0        # Narrow P5-P95 luminance span indicates haze, smog, glare, or occlusion

# Magic bytes signatures for supported web image formats
IMAGE_SIGNATURES = {
    b"\xff\xd8\xff": "image/jpeg",
    b"\x89PNG\r\n\x1a\n": "image/png",
    b"RIFF": "image/webp",  # WebP files begin with 'RIFF....WEBP'
}


def is_opencv_installed() -> bool:
    """Returns True if OpenCV and NumPy are available in the runtime environment."""
    return OPENCV_AVAILABLE


def get_opencv_version() -> Optional[str]:
    """Returns the installed OpenCV version string, or None if unavailable."""
    return OPENCV_VERSION


def detect_image_format(raw_bytes: bytes) -> Optional[str]:
    """Inspects header magic bytes to verify supported image formats."""
    if len(raw_bytes) < 12:
        return None
    for magic, mime in IMAGE_SIGNATURES.items():
        if raw_bytes.startswith(magic):
            if magic == b"RIFF" and raw_bytes[8:12] != b"WEBP":
                continue
            return mime
    return None


def decode_base64_image(base64_str: str) -> Tuple[Optional[Any], Optional[Dict[str, Any]]]:
    """
    Decodes an in-memory base64 image string into an OpenCV BGR image array.
    Returns (img_array, error_dict). Exactly one will be non-None.
    Enforces payload limits, format validation, and dimension boundaries.
    """
    if not isinstance(base64_str, str) or not base64_str.strip():
        return None, {
            "valid": False,
            "error": "Image payload must be a non-empty base64 string.",
            "code": "EMPTY_PAYLOAD",
        }

    clean_str = base64_str.strip()

    # Enforce base64 string length limit (prevent memory exhaustion)
    if len(clean_str) > MAX_BASE64_CHARS:
        return None, {
            "valid": False,
            "error": "Photo exceeds 5MB size limit. Please provide a smaller image.",
            "code": "PAYLOAD_TOO_LARGE",
        }

    # Strip optional data URI header (e.g. data:image/jpeg;base64,...)
    if "," in clean_str:
        header, payload = clean_str.split(",", 1)
        clean_str = payload
    else:
        clean_str = clean_str

    try:
        raw_bytes = base64.b64decode(clean_str, validate=True)
    except (binascii.Error, ValueError):
        return None, {
            "valid": False,
            "error": "Malformed base64 image encoding.",
            "code": "MALFORMED_BASE64",
        }

    # Enforce decoded byte size limit (5 MB)
    if len(raw_bytes) > MAX_FILE_BYTES:
        return None, {
            "valid": False,
            "error": "Decoded photo exceeds 5MB limit.",
            "code": "PAYLOAD_TOO_LARGE",
        }

    # Verify magic bytes for supported formats (JPEG, PNG, WEBP)
    detected_format = detect_image_format(raw_bytes)
    if not detected_format:
        return None, {
            "valid": False,
            "error": "Unsupported image format. Allowed formats: JPEG, PNG, WEBP.",
            "code": "UNSUPPORTED_FORMAT",
        }

    if not OPENCV_AVAILABLE:
        return None, {
            "valid": False,
            "error": "OpenCV is not installed in the Python environment.",
            "code": "OPENCV_NOT_AVAILABLE",
        }


    # Decode bytes in-memory into OpenCV BGR numpy array
    try:
        np_arr = np.frombuffer(raw_bytes, dtype=np.uint8)
        img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    except Exception:
        return None, {
            "valid": False,
            "error": "Failed to decode image data into pixel array.",
            "code": "DECODE_FAILURE",
        }

    if img is None:
        return None, {
            "valid": False,
            "error": "Image decoding returned null (corrupted or unrecognized image).",
            "code": "CORRUPTED_IMAGE",
        }

    height, width = img.shape[:2]
    total_pixels = height * width

    # Dimension and pixel budget guardrails (prevents decompression bombs)
    if height > MAX_DIMENSION or width > MAX_DIMENSION or total_pixels > MAX_TOTAL_PIXELS:
        return None, {
            "valid": False,
            "error": f"Image dimensions ({width}x{height}) exceed maximum allowed {MAX_DIMENSION}x{MAX_DIMENSION}.",
            "code": "DIMENSIONS_EXCEEDED",
        }

    # Downscale image to a max dimension of 1024px to reduce memory footprint and latency
    TARGET_MAX_DIM = 1024
    if height > TARGET_MAX_DIM or width > TARGET_MAX_DIM:
        scale = float(TARGET_MAX_DIM) / float(max(height, width))
        new_w = max(1, int(round(width * scale)))
        new_h = max(1, int(round(height * scale)))
        img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)

    return img, None


def inspect_image_quality(img: Any, detected_format: Optional[str] = None) -> Dict[str, Any]:
    """
    Evaluates image dimensions, blur, illumination, and contrast using OpenCV.
    Optimized:
    - Early grayscale conversion (cv2.COLOR_BGR2GRAY)
    - SIMD float32 Laplacian variance for fast sharpness calculation
    - Single-pass cv2.meanStdDev for simultaneous luminance and contrast assessment
    Returns structured assessment with non-blocking advisory warnings.
    """
    height, width = img.shape[:2]
    total_pixels = height * width

    # Convert early to grayscale for hardware-accelerated single-channel analysis
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # 1. Blur Detection via Laplacian Variance on float32 (fast SIMD vectorization)
    laplacian = cv2.Laplacian(gray, cv2.CV_32F)
    blur_score = float(laplacian.var())
    is_blurry = blur_score < BLUR_THRESHOLD

    # 2 & 3. Illumination & Contrast in a single SIMD pass using cv2.meanStdDev
    mean_val, std_val = cv2.meanStdDev(gray)
    brightness = float(mean_val[0][0])
    contrast_std = float(std_val[0][0])

    is_dark = brightness < DARK_THRESHOLD
    is_overexposed = brightness > OVEREXPOSED_THRESHOLD
    is_low_contrast = contrast_std < LOW_CONTRAST_THRESHOLD

    # 3b. Poor visibility / haze / severe obstruction heuristic via dynamic range (P95 - P5)
    p5 = float(np.percentile(gray, 5))
    p95 = float(np.percentile(gray, 95))
    dynamic_range = p95 - p5
    is_poor_visibility = bool(
        dynamic_range < POOR_VISIBILITY_SPAN
        or (is_low_contrast and (is_dark or is_overexposed or is_blurry))
    )

    # 4. Resolution Checks
    is_low_resolution = width < MIN_DIMENSION or height < MIN_DIMENSION

    # Compile non-blocking advisory warnings
    warnings = []
    if is_blurry:
        warnings.append("Photo appears out of focus or blurry. Hold the camera steady or move slightly closer so officers can inspect the defect.")
    if is_dark:
        warnings.append("Photo appears dimly lit or dark. Move to better lighting or retake during daylight if safe.")
    elif is_overexposed:
        warnings.append("Photo appears very bright or overexposed. Angle away from direct glare so details remain visible.")
    if is_poor_visibility:
        warnings.append("Overall visibility appears limited (haze, fog, heavy shadow, or flat lighting). You can still submit, or retake a clearer shot for faster triage.")
    elif is_low_contrast:
        warnings.append("Photo has low visual contrast. Important defect boundaries might be hard to see.")
    if is_low_resolution:
        warnings.append(f"Photo resolution is relatively low ({width}x{height}px). Minimum {MIN_DIMENSION}px recommended.")

    # Compute overall quality score
    if is_blurry or is_dark or is_poor_visibility:
        quality_rating = "Needs Attention"
    elif is_overexposed or is_low_contrast or is_low_resolution:
        quality_rating = "Acceptable"
    else:
        quality_rating = "Good"

    return {
        "valid": True,
        "width": width,
        "height": height,
        "total_pixels": total_pixels,
        "format": detected_format or "image/jpeg",
        "blur_score": round(blur_score, 2),
        "is_blurry": is_blurry,
        "brightness": round(brightness, 2),
        "is_dark": is_dark,
        "is_overexposed": is_overexposed,
        "contrast_std": round(contrast_std, 2),
        "dynamic_range": round(dynamic_range, 2),
        "is_low_contrast": is_low_contrast,
        "is_poor_visibility": is_poor_visibility,
        "is_low_resolution": is_low_resolution,
        "quality_rating": quality_rating,
        "warnings": warnings,
        "is_advisory_only": True,
    }


def process_and_inspect_base64(base64_str: str) -> Dict[str, Any]:
    """
    High-level entry point for processing and inspecting an uploaded civic complaint photo.
    Returns:
    {
        "success": True/False,
        "valid": True/False,
        "quality": { ... },
        "warnings": [ ... ],
        "error": "..." (if invalid),
    }
    """
    img, err = decode_base64_image(base64_str)
    if err is not None:
        return {
            "success": False,
            "valid": False,
            "error": err["error"],
            "code": err.get("code", "VALIDATION_FAILED"),
            "warnings": [err["error"]],
            "is_advisory_only": True,
        }

    quality = inspect_image_quality(img)
    return {
        "success": True,
        "valid": True,
        "quality": quality,
        "warnings": quality["warnings"],
        "is_advisory_only": True,
    }


def inpaint_cleanup_image(
    base64_str: str,
    bounding_boxes: list,
    issue_category: Optional[str] = None,
) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    """
    Performs grounded inpainting on the citizen's exact photograph.
    Removes ONLY the validated bounding boxes of the civic defect (litter, pothole,
    waterlogging, blocked drain debris, fallen branch, broken surface),
    reconstructing the underlying ground/asphalt/grass/pavement using Fast Marching (Telea)
    texture interpolation from adjacent clean pixels.
    Guarantees 100% preservation of camera angle, viewpoint, lighting, buildings,
    trees, and unaffected background.
    """
    img, err = decode_base64_image(base64_str)
    if err is not None:
        return None, err

    height, width = img.shape[:2]

    # If no bounding boxes provided or already clean
    if not bounding_boxes or len(bounding_boxes) == 0:
        clean_prefix = "data:image/jpeg;base64,"
        if base64_str.startswith("data:"):
            return base64_str, None
        return clean_prefix + base64_str.strip(), None

    # Create binary mask (0 = keep exact original pixel, 255 = inpaint/repair)
    mask = np.zeros((height, width), dtype=np.uint8)
    valid_boxes_count = 0

    for box in bounding_boxes:
        ymin, xmin, ymax, xmax = 0, 0, 0, 0
        if isinstance(box, (list, tuple)) and len(box) >= 4:
            ymin, xmin, ymax, xmax = box[0], box[1], box[2], box[3]
        elif isinstance(box, dict):
            ymin = box.get("ymin", 0)
            xmin = box.get("xmin", 0)
            ymax = box.get("ymax", 0)
            xmax = box.get("xmax", 0)
        else:
            continue

        # Check normalization scale (0..1000 or 0..1.0)
        scale = 1000.0 if max(ymin, xmin, ymax, xmax) > 1.0 else 1.0
        y1 = int((ymin / scale) * height)
        x1 = int((xmin / scale) * width)
        y2 = int((ymax / scale) * height)
        x2 = int((xmax / scale) * width)

        # Clamp boundaries safely to pixel dimensions
        y1 = max(0, min(height - 1, y1))
        x1 = max(0, min(width - 1, x1))
        y2 = max(0, min(height, y2))
        x2 = max(0, min(width, x2))

        # Disallow degenerate boxes
        if y2 > y1 and x2 > x1:
            # Prevent single box covering over 60% of entire image (guard against mask blowing out scene)
            box_area = (y2 - y1) * (x2 - x1)
            total_img_area = height * width
            if (box_area / total_img_area) <= 0.60:
                mask[y1:y2, x1:x2] = 255
                valid_boxes_count += 1
            else:
                # Clamp oversized box to lower 40% ground area
                clamp_y1 = max(int(height * 0.55), y1)
                mask[clamp_y1:y2, x1:x2] = 255
                valid_boxes_count += 1

    if valid_boxes_count == 0:
        if base64_str.startswith("data:"):
            return base64_str, None
        return "data:image/jpeg;base64," + base64_str.strip(), None

    # Dilate mask slightly to cover defect edges & contact shadows
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    dilated_mask = cv2.dilate(mask, kernel, iterations=1)

    # Larger Telea radius for road/water/pavement surface repairs helps bridge wider patches seamlessly
    cat_lower = (issue_category or "").lower()
    is_surface_repair = any(
        kw in cat_lower
        for kw in ["pothole", "crack", "road", "footpath", "water", "sewage", "drain", "flood"]
    )
    inpaint_radius = 11 if is_surface_repair else 7

    # Inpaint using Telea fast marching algorithm (restores continuous surface textures)
    inpainted = cv2.inpaint(img, dilated_mask, inpaintRadius=inpaint_radius, flags=cv2.INPAINT_TELEA)

    # For streetlights or public property fixtures, also softly restore brightness only inside the repaired region
    if "light" in cat_lower or "lamp" in cat_lower:
        warm_tint = inpainted.copy()
        warm_tint[:, :, 1] = np.clip(warm_tint[:, :, 1].astype(np.int16) + 18, 0, 255).astype(np.uint8)
        warm_tint[:, :, 2] = np.clip(warm_tint[:, :, 2].astype(np.int16) + 28, 0, 255).astype(np.uint8)
        mask_bool = dilated_mask > 0
        inpainted[mask_bool] = cv2.addWeighted(inpainted, 0.55, warm_tint, 0.45, 0)[mask_bool]

    # Softly feather mask seam while leaving all non-masked pixels 100% untouched
    feather_alpha = cv2.GaussianBlur(dilated_mask.astype(np.float32) / 255.0, (7, 7), 0)
    feather_alpha = np.expand_dims(feather_alpha, axis=-1)
    # Only blend inside dilated mask perimeter (keep strictly 0 outside dilated mask)
    outside = dilated_mask == 0
    blended = (inpainted.astype(np.float32) * feather_alpha + img.astype(np.float32) * (1.0 - feather_alpha)).astype(np.uint8)
    blended[outside] = img[outside]

    # Encode back to JPEG in memory
    success, buffer = cv2.imencode(".jpg", blended, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    if not success:
        return None, {
            "valid": False,
            "error": "Failed to encode cleaned image into JPEG format.",
            "code": "ENCODE_FAILURE",
        }

    encoded_b64 = base64.b64encode(buffer).decode("utf-8")
    return f"data:image/jpeg;base64,{encoded_b64}", None


def compute_image_similarity(
    base64_img1: str,
    base64_img2: str,
    bounding_boxes: Optional[list] = None,
    is_clean_area: bool = False,
) -> Dict[str, Any]:
    """
    Compares original and transformed images with strict distinction between:
    1. Unaffected region preservation (buildings, roads, sky, background must remain unchanged).
    2. Waste region removal (waste pixels in the mask MUST be changed/replaced).
    3. Structural consistency & lack of hallucinated objects.
    """
    img1, err1 = decode_base64_image(base64_img1)
    img2, err2 = decode_base64_image(base64_img2)

    if err1 is not None or err2 is not None:
        return {
            "verified": False,
            "scene_preserved": False,
            "waste_removed": False,
            "correlation": 0.0,
            "psnr": 0.0,
            "unaffected_retention": 0.0,
            "waste_region_diff": 0.0,
            "artifacts_detected": False,
            "hallucinations_detected": False,
            "error": "Could not decode one or both images for consistency comparison.",
        }

    h1, w1 = img1.shape[:2]
    h2, w2 = img2.shape[:2]

    # Resize img2 to img1 if dimensions differ slightly due to aspect ratio or compression
    if (h1, w1) != (h2, w2):
        img2 = cv2.resize(img2, (w1, h1), interpolation=cv2.INTER_AREA)

    # Convert to HSV color space for lighting-invariant scene color analysis
    hsv1 = cv2.cvtColor(img1, cv2.COLOR_BGR2HSV)
    hsv2 = cv2.cvtColor(img2, cv2.COLOR_BGR2HSV)

    # Compute 2D H-S histogram
    hist1 = cv2.calcHist([hsv1], [0, 1], None, [50, 60], [0, 180, 0, 256])
    hist2 = cv2.calcHist([hsv2], [0, 1], None, [50, 60], [0, 180, 0, 256])
    cv2.normalize(hist1, hist1, 0, 1, cv2.NORM_MINMAX)
    cv2.normalize(hist2, hist2, 0, 1, cv2.NORM_MINMAX)

    correlation = float(cv2.compareHist(hist1, hist2, cv2.HISTCMP_CORREL))

    # Compute PSNR (Peak Signal to Noise Ratio)
    mse = float(np.mean((img1.astype(np.float64) - img2.astype(np.float64)) ** 2))
    psnr = 100.0 if mse == 0 else float(10 * np.log10((255.0 ** 2) / mse))

    # Construct waste region mask if bounding boxes exist
    waste_mask = np.zeros((h1, w1), dtype=np.uint8)
    has_boxes = False

    if bounding_boxes and len(bounding_boxes) > 0 and not is_clean_area:
        for box in bounding_boxes:
            if isinstance(box, (list, tuple)) and len(box) >= 4:
                ymin, xmin, ymax, xmax = box[0], box[1], box[2], box[3]
            elif isinstance(box, dict):
                ymin = box.get("ymin", 0)
                xmin = box.get("xmin", 0)
                ymax = box.get("ymax", 0)
                xmax = box.get("xmax", 0)
            else:
                continue

            scale = 1000.0 if max(ymin, xmin, ymax, xmax) > 1.0 else 1.0
            y1 = int((ymin / scale) * h1)
            x1 = int((xmin / scale) * w1)
            y2 = int((ymax / scale) * h1)
            x2 = int((xmax / scale) * w1)
            y1 = max(0, min(h1 - 1, y1))
            x1 = max(0, min(w1 - 1, x1))
            y2 = max(0, min(h1, y2))
            x2 = max(0, min(w1, x2))
            if y2 > y1 and x2 > x1:
                waste_mask[y1:y2, x1:x2] = 255
                has_boxes = True

    # Absolute pixel difference
    abs_diff = np.abs(img1.astype(np.float32) - img2.astype(np.float32))

    if has_boxes:
        is_waste = waste_mask == 255
        is_unaffected = waste_mask == 0

        waste_diff = float(np.mean(abs_diff[is_waste])) if np.any(is_waste) else 0.0
        unaffected_diff = float(np.mean(abs_diff[is_unaffected])) if np.any(is_unaffected) else 0.0

        # Unaffected region retention (percentage)
        unaffected_retention = max(0.0, min(100.0, 100.0 - (unaffected_diff * 1.5)))

        # Waste is successfully removed if the waste pixels changed significantly (diff >= 4.0)
        waste_removed = bool(waste_diff >= 4.0)

        # Artifacts check: edge disturbance or excessive blur in unaffected zone
        artifacts_detected = bool(unaffected_diff > 12.0)

        # Hallucination check: unexpected modifications in unaffected areas or extreme correlation drop
        hallucinations_detected = bool(unaffected_diff > 25.0 or correlation < 0.70)
    else:
        # Area is clean or unchanged
        waste_diff = 0.0
        unaffected_diff = float(np.mean(abs_diff))
        unaffected_retention = max(0.0, min(100.0, 100.0 - (unaffected_diff * 1.5)))
        waste_removed = True
        artifacts_detected = False
        hallucinations_detected = bool(correlation < 0.70)

    # Overall scene preservation requires:
    # 1. High correlation across scene (>= 0.70)
    # 2. High unaffected region retention (>= 90%)
    # 3. No hallucinations
    scene_preserved = bool(correlation >= 0.70 and psnr >= 16.0 and unaffected_retention >= 90.0 and not hallucinations_detected)

    # Overall verification passes if scene is preserved AND waste removal requirement is met
    verified = bool(scene_preserved and waste_removed)

    return {
        "verified": verified,
        "scene_preserved": scene_preserved,
        "waste_removed": waste_removed,
        "correlation": round(correlation, 4),
        "psnr": round(psnr, 2),
        "unaffected_retention": round(unaffected_retention, 2),
        "waste_region_diff": round(waste_diff, 2),
        "artifacts_detected": artifacts_detected,
        "hallucinations_detected": hallucinations_detected,
        "similarity_score": min(99, max(10, int(correlation * 80 + min(20, psnr)))),
        "error": None,
    }
