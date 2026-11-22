# CivicFix AI OpenCV image-processing service

This directory contains the optional local Flask service used for advisory photo-quality inspection, localized Telea cleanup previews, and image-similarity checks. Gemini remains the real AI provider for civic issue analysis; this service does not classify complaints and does not generate mock Gemini results.

## Endpoints

- `GET /health` reports whether Flask and OpenCV are available.
- `POST /image/inspect` validates a Base64 image and returns advisory blur, lighting, contrast, and resolution warnings.
- `POST /image/inpaint-cleanup` performs bounded OpenCV Telea inpainting inside server-provided defect boxes.
- `POST /image/verify-similarity` compares original and transformed images and reports preservation metrics.

The service binds to loopback port `5001` and is started by the Express supervisor when a Python environment with Flask and OpenCV is available. If it is unavailable, CivicFix continues with the TypeScript/Gemini paths and clearly reports the advisory service as unavailable.

## Local setup

Install the dependencies into the project virtual environment:

```bash
python3 -m venv .venv
.venv/bin/pip install -r ml/requirements.txt
```

On Windows, create the environment with `py -3 -m venv .venv` and install with `.venv\Scripts\pip.exe install -r ml/requirements.txt`.

Run the service directly when needed:

```bash
python3 ml/app.py
```

The application can also start it automatically through `src/server/mlSupervisor.ts`. No Firebase rules, live data, or production records are changed by this service.

## Limitations

This is an optional local image-processing helper. It is not a machine-learning complaint classifier, and it must not be treated as proof that a civic issue exists. Gemini responses are validated and handled independently by the Express backend.
