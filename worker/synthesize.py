"""Sintesis SATU chunk VO dengan VoxCPM2 dalam proses FRESH.

Dipanggil worker.py sekali per chunk (bukan sekali per job) — pola yang
terbukti 16/16 chunk lolos tanpa OOM (VO-VOXCPM.md §8b): tiap chunk =
1 proses baru (heap bersih, tanpa allocator creep), lalu proses mati.

Pola ini disalin dari generate_vo_chunk.py (Juleha, terbukti jalan):
  - torch.set_default_dtype(torch.bfloat16) SEBELUM konstruksi model
    (tanpa ini, kerangka model 2B dibuat float32 ±9 GB lalu OOM).
  - VoxCPM.from_pretrained(VOXCPM_MODEL_DIR, load_denoiser=False,
    device="cpu", optimize=False).
  - torch.manual_seed(42) sebelum generate — voxcpm 2.0.3 TIDAK
    menerima kwarg `seed` (contoh lama di skill kedaluwarsa).
  - Ultimate cloning: prompt_wav_path + prompt_text + reference_wav_path
    (ketiganya = audio referensi yang sama).
  - cfg_value=2.0, inference_timesteps=10.
  - Output wav 48 kHz (sample rate model).

Pemakaian:  python synthesize.py <ref_wav> "<prompt_text>" "<teks>" <out_wav>
Env:        VOXCPM_MODEL_DIR (direktori model lokal), OMP_NUM_THREADS=1,
            MKL_NUM_THREADS=1, MALLOC_ARENA_MAX=1 (diatur worker.py).

Syarat RAM: MemAvailable >= ~6.200.000 kB saat proses jalan.
"""

import os
import resource
import sys
import time

import numpy as np
import torch

# WAJIB sebelum import voxcpm / konstruksi model (lihat docstring).
torch.set_default_dtype(torch.bfloat16)
torch.set_num_threads(1)
torch.set_num_interop_threads(1)

import soundfile as sf  # noqa: E402
from voxcpm import VoxCPM  # noqa: E402

MODEL_DIR = os.environ.get("VOXCPM_MODEL_DIR", "")
REF_WAV, PROMPT_TEXT, TEXT, OUT_FILE = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]


def rss_gb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6


def main() -> None:
    if not MODEL_DIR or not os.path.isdir(MODEL_DIR):
        print("VOXCPM_MODEL_DIR belum diisi / bukan direktori.", flush=True)
        sys.exit(2)
    print(
        f"torch {torch.__version__}, threads={torch.get_num_threads()}, "
        f"default_dtype={torch.get_default_dtype()}",
        flush=True,
    )

    t0 = time.time()
    model = VoxCPM.from_pretrained(
        MODEL_DIR,
        load_denoiser=False,
        device="cpu",
        optimize=False,
    )
    print(f"[t={time.time() - t0:.0f}s] model loaded, peak RSS={rss_gb():.2f} GB", flush=True)
    sr = model.tts_model.sample_rate

    t1 = time.time()
    torch.manual_seed(42)
    wav = model.generate(
        text=TEXT,
        prompt_wav_path=REF_WAV,
        prompt_text=PROMPT_TEXT,
        reference_wav_path=REF_WAV,
        cfg_value=2.0,
        inference_timesteps=10,
    )
    wav = np.asarray(wav, dtype=np.float32)
    sf.write(OUT_FILE, wav, sr)
    print(
        f"[t={time.time() - t1:.0f}s] SAVED {OUT_FILE} dur={len(wav) / sr:.2f}s, "
        f"peak RSS={rss_gb():.2f} GB",
        flush=True,
    )
    print(f"DONE total wall={time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
