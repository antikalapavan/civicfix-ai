"""
CiviFix AI - Unit Tests for OpenCV Image Processing Module
Tests:
- Empty & malformed inputs
- Unsupported format rejection
- Size limit guardrails
- Synthetic Sharp, Blurry, Dark, and Normal image inspections
"""

import os
import sys
import base64
import unittest

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, CURRENT_DIR)

from image_processor import (
    decode_base64_image,
    process_and_inspect_base64,
    is_opencv_installed,
    BLUR_THRESHOLD,
    DARK_THRESHOLD,
)

try:
    import cv2
    import numpy as np
except ImportError:
    cv2 = None
    np = None


class TestImageProcessor(unittest.TestCase):

    def test_empty_input(self):
        result = process_and_inspect_base64("")
        self.assertFalse(result["success"])
        self.assertFalse(result["valid"])
        self.assertIn("non-empty", result["error"])

    def test_malformed_base64(self):
        result = process_and_inspect_base64("not_valid_base64!!!@@@###")
        self.assertFalse(result["success"])
        self.assertFalse(result["valid"])

    def test_oversized_payload(self):
        # Create dummy string exceeding max base64 size
        huge_str = "A" * (8 * 1024 * 1024)
        result = process_and_inspect_base64(huge_str)
        self.assertFalse(result["success"])
        self.assertIn("size limit", result["error"].lower())

    def test_unsupported_format(self):
        # Valid base64 of non-image text
        text_b64 = base64.b64encode(b"This is just plain text, not an image.").decode()
        result = process_and_inspect_base64(text_b64)
        self.assertFalse(result["success"])
        self.assertIn("unsupported", result["error"].lower())

    @unittest.skipUnless(is_opencv_installed(), "OpenCV not installed in runtime")
    def test_synthetic_dark_image(self):
        # Create dark image (intensity 10/255)
        dark_img = np.full((300, 300, 3), 10, dtype=np.uint8)
        _, buf = cv2.imencode(".jpg", dark_img)
        b64 = base64.b64encode(buf).decode()

        result = process_and_inspect_base64(b64)
        self.assertTrue(result["success"])
        self.assertTrue(result["valid"])
        self.assertTrue(result["quality"]["is_dark"])
        self.assertLess(result["quality"]["brightness"], DARK_THRESHOLD)
        self.assertTrue(any("dimly lit" in w.lower() for w in result["warnings"]))

    @unittest.skipUnless(is_opencv_installed(), "OpenCV not installed in runtime")
    def test_synthetic_blurry_image(self):
        # Create solid color image with zero edge gradients
        blank_img = np.full((300, 300, 3), 128, dtype=np.uint8)
        _, buf = cv2.imencode(".jpg", blank_img)
        b64 = base64.b64encode(buf).decode()

        result = process_and_inspect_base64(b64)
        self.assertTrue(result["success"])
        self.assertTrue(result["valid"])
        self.assertTrue(result["quality"]["is_blurry"])
        self.assertLess(result["quality"]["blur_score"], BLUR_THRESHOLD)
        self.assertTrue(any("blurry" in w.lower() for w in result["warnings"]))

    @unittest.skipUnless(is_opencv_installed(), "OpenCV not installed in runtime")
    def test_synthetic_sharp_normal_image(self):
        # Create sharp checkerboard pattern with high edge gradient
        sharp_img = np.zeros((300, 300, 3), dtype=np.uint8)
        for i in range(0, 300, 20):
            for j in range(0, 300, 20):
                if (i // 20 + j // 20) % 2 == 0:
                    sharp_img[i:i+20, j:j+20] = [200, 200, 200]
                else:
                    sharp_img[i:i+20, j:j+20] = [50, 50, 50]

        _, buf = cv2.imencode(".jpg", sharp_img)
        b64 = base64.b64encode(buf).decode()

        result = process_and_inspect_base64(b64)
        self.assertTrue(result["success"])
        self.assertTrue(result["valid"])
        self.assertFalse(result["quality"]["is_blurry"])
        self.assertFalse(result["quality"]["is_dark"])
        self.assertFalse(result["quality"]["is_overexposed"])
        self.assertEqual(result["quality"]["quality_rating"], "Good")
        self.assertEqual(len(result["warnings"]), 0)


if __name__ == "__main__":
    unittest.main()
