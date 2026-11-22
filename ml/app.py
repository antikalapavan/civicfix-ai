"""
CiviFix AI - Internal OpenCV Image Processing Microservice
Endpoints:
- GET  /health                   -> Verifies service health and OpenCV availability
- POST /image/inspect            -> Validates Base64 photo and assesses quality (blur, lighting, contrast, resolution)
- POST /image/inpaint-cleanup    -> Performs localized OpenCV Telea inpainting inside validated defect boxes
- POST /image/verify-similarity  -> Computes HSV correlation, PSNR, and unaffected region retention metrics

Default Port: 5001 (internal loopback only; avoids port 3000 used by CiviFix AI Express app)
"""

import os
import sys
import glob

# Ensure .venv site-packages are discovered if invoked via system python
_app_dir = os.path.dirname(os.path.abspath(__file__))
_project_root = os.path.abspath(os.path.join(_app_dir, ".."))
_site_packages_pattern = os.path.join(_project_root, ".venv", "lib", "python*", "site-packages")
for _sp in glob.glob(_site_packages_pattern):
    if os.path.isdir(_sp) and _sp not in sys.path:
        sys.path.insert(0, _sp)

from flask import Flask, request, jsonify
import concurrent.futures

_worker_pool = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="cv_worker")

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))

# Import image processing module
try:
    from image_processor import (
        process_and_inspect_base64,
        is_opencv_installed,
        get_opencv_version,
        inpaint_cleanup_image,
        compute_image_similarity,
    )
except ImportError:
    sys.path.insert(0, CURRENT_DIR)
    from image_processor import (
        process_and_inspect_base64,
        is_opencv_installed,
        get_opencv_version,
        inpaint_cleanup_image,
        compute_image_similarity,
    )

app = Flask(__name__)


@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint reporting OpenCV availability and version."""
    return (
        jsonify(
            {
                "status": "healthy",
                "service": "CiviFix AI - OpenCV Image Processing Service",
                "opencv_available": is_opencv_installed(),
                "opencv_version": get_opencv_version(),
                "image_processing_supported": is_opencv_installed(),
            }
        ),
        200,
    )


@app.route("/image/inspect", methods=["POST"])
def inspect_image():
    """
    OpenCV Image Validation, Preprocessing & Quality Inspection Endpoint.
    Expects JSON payload: { "image_base64": "..." } or { "photoBase64": "..." }
    """
    if not is_opencv_installed():
        return (
            jsonify(
                {
                    "success": False,
                    "isAvailable": False,
                    "error": "OpenCV is not installed in the Python environment.",
                    "warnings": [],
                    "is_advisory_only": True,
                }
            ),
            503,
        )

    if not request.is_json:
        return (
            jsonify(
                {
                    "success": False,
                    "error": "Request body must be valid JSON with 'Content-Type: application/json'.",
                    "warnings": [],
                    "is_advisory_only": True,
                }
            ),
            400,
        )

    body = request.get_json(silent=True)
    if not body or not isinstance(body, dict):
        return (
            jsonify(
                {
                    "success": False,
                    "error": "Invalid request body.",
                    "warnings": [],
                    "is_advisory_only": True,
                }
            ),
            400,
        )

    image_payload = body.get("image_base64") or body.get("photoBase64")
    if not image_payload or not isinstance(image_payload, str):
        return (
            jsonify(
                {
                    "success": False,
                    "error": "Field 'image_base64' or 'photoBase64' is required.",
                    "warnings": [],
                    "is_advisory_only": True,
                }
            ),
            400,
        )

    try:
        future = _worker_pool.submit(process_and_inspect_base64, image_payload)
        inspection_result = future.result(timeout=4.0)
        status_code = 200 if inspection_result["success"] else 400
        return jsonify(inspection_result), status_code
    except concurrent.futures.TimeoutError:
        return (
            jsonify(
                {
                    "success": False,
                    "error": "Image inspection timed out after 4 seconds.",
                    "warnings": ["Image inspection timed out; proceeding with report submission."],
                    "is_advisory_only": True,
                }
            ),
            200,
        )
    except Exception:
        return (
            jsonify(
                {
                    "success": False,
                    "error": "Internal error occurred while processing image.",
                    "warnings": [],
                    "is_advisory_only": True,
                }
            ),
            500,
        )


@app.route("/image/inpaint-cleanup", methods=["POST"])
def inpaint_cleanup():
    """Performs localized Telea inpainting inside defect bounding boxes on the exact citizen photo."""
    if not is_opencv_installed():
        return jsonify({"success": False, "error": "OpenCV is not available."}), 503

    body = request.get_json(silent=True) or {}
    image_payload = body.get("photoBase64") or body.get("photo_base64")
    bounding_boxes = body.get("bounding_boxes", [])
    issue_category = body.get("issue_category")

    if not image_payload:
        return jsonify({"success": False, "error": "Photo payload is required."}), 400

    try:
        future = _worker_pool.submit(inpaint_cleanup_image, image_payload, bounding_boxes, issue_category)
        cleaned_b64, err = future.result(timeout=10.0)
        if err is not None:
            return jsonify({"success": False, "error": err.get("error", "Inpainting failed")}), 400

        return jsonify({
            "success": True,
            "cleaned_photo": cleaned_b64,
            "method": "opencv-telea-inpainting",
            "boxes_cleaned": len(bounding_boxes),
        }), 200
    except concurrent.futures.TimeoutError:
        return jsonify({"success": False, "error": "Inpainting operation timed out after 10 seconds."}), 504
    except Exception as exc:
        return jsonify({"success": False, "error": f"Inpainting processing exception: {str(exc)}"}), 500


@app.route("/image/verify-similarity", methods=["POST"])
def verify_similarity():
    """Compares original and transformed photographs for scene identity and unaffected region retention."""
    if not is_opencv_installed():
        return jsonify({"success": False, "error": "OpenCV is not available."}), 503

    body = request.get_json(silent=True) or {}
    orig = body.get("original_base64")
    trans = body.get("transformed_base64")
    boxes = body.get("bounding_boxes", [])
    is_clean = body.get("is_clean_area", False)

    if not orig or not trans:
        return jsonify({"success": False, "error": "Both original and transformed photos are required."}), 400

    try:
        future = _worker_pool.submit(compute_image_similarity, orig, trans, bounding_boxes=boxes, is_clean_area=is_clean)
        metrics = future.result(timeout=6.0)
        return jsonify({"success": True, **metrics}), 200
    except concurrent.futures.TimeoutError:
        return jsonify({"success": False, "error": "Similarity verification timed out after 6 seconds."}), 504
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("ML_PORT", 5001))
    print(f"Starting CiviFix AI OpenCV Image Processing Flask API on http://127.0.0.1:{port}...")
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
