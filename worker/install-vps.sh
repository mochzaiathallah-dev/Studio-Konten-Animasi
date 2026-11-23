#!/usr/bin/env bash
# Instalasi worker VO Studio di VPS instabox (dijalankan di box, log ke install.log)
set -u
cd ~/vo-studio-worker
export TMPDIR=/tmp
export HF_HUB_DISABLE_XET=1
export PIP_DISABLE_PIP_VERSION_CHECK=1

echo "[1/6] venv..."
python3 -m venv .venv || { echo VENV_FAIL; exit 1; }

echo "[2/6] pip upgrade..."
.venv/bin/pip install --upgrade pip

echo "[3/6] torch CPU (unduhan besar)..."
.venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu || { echo TORCH_FAIL; exit 1; }

echo "[4/6] voxcpm..."
.venv/bin/pip install voxcpm==2.0.3 || { echo VOXCPM_FAIL; exit 1; }

echo "[5/6] torchaudio CPU (ganti build CUDA)..."
.venv/bin/pip install --force-reinstall torchaudio --index-url https://download.pytorch.org/whl/cpu || { echo TORCHAUDIO_FAIL; exit 1; }

echo "[6/6] requirements.txt..."
.venv/bin/pip install -r requirements.txt || { echo REQ_FAIL; exit 1; }

echo "[verifikasi] import..."
.venv/bin/python -c "import torch, torchaudio, voxcpm, supabase, soundfile; print('IMPORT_OK torch', torch.__version__)" || { echo IMPORT_FAIL; exit 1; }

echo INSTALL_DONE
