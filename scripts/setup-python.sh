#!/usr/bin/env bash
# CiviFix AI - Reproducible Python Virtual Environment Setup
# Phase 7: Installs Python ML and OpenCV dependencies into .venv
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="$DIR/.venv"

echo "[CiviFix Setup] Checking Python virtual environment in $VENV_DIR..."

if [ ! -d "$VENV_DIR" ] || [ ! -f "$VENV_DIR/bin/pip" ]; then
  echo "[CiviFix Setup] Creating virtual environment at $VENV_DIR..."
  rm -rf "$VENV_DIR"
  python3 -m venv "$VENV_DIR" 2>/dev/null || python3 -m virtualenv "$VENV_DIR" || (
    curl -sS https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py && python3 /tmp/get-pip.py --no-warn-script-location
    python3 -m pip install virtualenv
    python3 -m virtualenv "$VENV_DIR"
  )
fi



echo "[CiviFix Setup] Installing OpenCV dependencies from ml/requirements.txt into virtual environment..."
"$VENV_DIR/bin/pip" install --upgrade pip --quiet
"$VENV_DIR/bin/pip" install -r "$DIR/ml/requirements.txt" --quiet

echo "[CiviFix Setup] Python virtual environment setup complete."
