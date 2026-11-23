"""Worker VO Studio — polling antrean jobs Supabase, sintesis VoxCPM2
+ transkripsi Whisper.

JANGAN jalankan file ini di Vercel (serverless tidak bisa menjalankan
VoxCPM2: model 4,8 GB, butuh ±6,2 GB RAM). Jalankan di mesin sendiri
(VPS/server) dengan RAM kosong >= 6,2 GB — lihat worker/README.md.

Alur per job VO:
  1. Ambil job tertua status=queued (sekali satu job).
  2. Set status=processing.
  3. Download audio referensi dari bucket `voice-refs`, konversi ke
     wav 16 kHz mono (pola yang terbukti: referensi Sego 16 kHz mono).
  4. Pecah teks jadi chunk (maks ±25 kata, pecah di koma) lalu sintesis
     TIAP CHUNK DALAM PROSES FRESH (subprocess synthesize.py) — pola
     yang terbukti 16/16 chunk lolos tanpa OOM (lihat VO-VOXCPM.md §8b).
  5. Gabung chunk dengan hening digital 0,25 dtk, normalisasi loudnorm
     ke -14 LUFS (skala earshot), upload ke bucket `vo-outputs`,
     set status=done + output_path.
  6. Bila gagal: set status=failed + pesan error, lanjut ke job berikut
     (jangan crash loop).

Alur per job TRANSCRIPSI (tabel `transcriptions`):
  1. Ambil transkripsi tertua status=queued (sekali satu job).
  2. Set status=processing.
  3. Download audio dari bucket `transcript-audio`, transkrip dalam
     PROSES FRESH (subprocess transcribe.py, faster-whisper "small").
  4. Set status=done + text + segments (jsonb), atau failed + error.

PENTING: worker memproses SATU job dalam satu waktu — JANGAN paralel.
RAM box 8 GB: VoxCPM butuh ±6,2 GB, faster-whisper small ±1-2 GB;
keduanya bersamaan = OOM. Tiap iterasi polling: job VO dulu, baru
transkripsi bila tidak ada VO aktif.

Env yang dibutuhkan (worker/.env atau environment):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  VOXCPM_MODEL_DIR (direktori model lokal, berisi config.json dll),
  POLL_INTERVAL_SECONDS (default 10).
"""

import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import soundfile as sf
from supabase import create_client

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
MODEL_DIR = os.environ.get("VOXCPM_MODEL_DIR", "")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL_SECONDS", "10"))

MAX_WORDS_PER_CHUNK = 25
SILENCE_BETWEEN_CHUNKS_S = 0.25
OUT_SAMPLE_RATE = 48000

WORKER_DIR = Path(__file__).resolve().parent
SYNTHESIZE_PY = WORKER_DIR / "synthesize.py"
TRANSCRIBE_PY = WORKER_DIR / "transcribe.py"


def log(msg: str) -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def split_text(text: str, max_words: int = MAX_WORDS_PER_CHUNK) -> list[str]:
    """Pecah teks jadi chunk pendek di jeda alami (titik lalu koma).

    Pola yang terbukti (VO-VOXCPM.md §8b): chunk panjang (22 kata)
    dipecah di koma jadi 16+6 kata; tiap chunk = 1 proses fresh.
    """
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    chunks: list[str] = []
    for sentence in sentences:
        words = sentence.split()
        while len(words) > max_words:
            cut = max_words
            for i in range(max_words - 1, 0, -1):
                if words[i].endswith(","):
                    cut = i + 1
                    break
            chunks.append(" ".join(words[:cut]))
            words = words[cut:]
        if words:
            chunks.append(" ".join(words))
    return [c for c in chunks if c.strip()]


def run_cmd(cmd: list[str], desc: str) -> None:
    """Jalankan perintah; lempar RuntimeError bila gagal."""
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "")[-2000:]
        raise RuntimeError(f"{desc} gagal (exit {proc.returncode}): {tail}")


def convert_ref_to_wav(src: Path, dst: Path) -> None:
    """Audio referensi (mp3/wav/m4a) -> wav 16 kHz mono (pola terbukti)."""
    run_cmd(
        [
            "ffmpeg", "-y", "-v", "error",
            "-i", str(src),
            "-ac", "1", "-ar", "16000",
            str(dst),
        ],
        "Konversi audio referensi",
    )


def join_chunks(chunk_files: list[Path], out_path: Path) -> None:
    """Gabung chunk wav 48 kHz dengan hening digital 0,25 dtk di antaranya."""
    parts: list[np.ndarray] = []
    silence = np.zeros(int(SILENCE_BETWEEN_CHUNKS_S * OUT_SAMPLE_RATE), dtype=np.float32)
    for i, f in enumerate(chunk_files):
        wav, sr = sf.read(str(f), dtype="float32")
        if sr != OUT_SAMPLE_RATE:
            raise RuntimeError(f"Chunk {f.name} sample rate {sr}, harus {OUT_SAMPLE_RATE}.")
        if wav.ndim > 1:
            wav = wav[:, 0]
        if i > 0:
            parts.append(silence)
        parts.append(wav.astype(np.float32))
    joined = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
    sf.write(str(out_path), joined, OUT_SAMPLE_RATE)


def normalize_loudness(src: Path, dst: Path) -> bool:
    """Two-pass loudnorm ffmpeg ke -14 LUFS (skala earshot).

    CATATAN (temuan terbukti, VO-VOXCPM.md §8d): ffmpeg loudnorm membaca
    ~3,0 LU LEBIH RENDAH dari skala earshot untuk file mono, jadi target
    ffmpeg I=-17 menghasilkan -14,0 LUFS di earshot. Jangan ganti ke I=-14
    (hasilnya ~-11 LUFS, terlalu keras). Bila loudnorm gagal, kembalikan
    False supaya pemanggil memakai file tanpa normalisasi.
    """
    import json

    try:
        proc = subprocess.run(
            [
                "ffmpeg", "-i", str(src),
                "-af", "loudnorm=I=-17:TP=-1.5:LRA=11:print_format=json",
                "-f", "null", "-",
            ],
            capture_output=True, text=True,
        )
        m = re.search(r"\{[^}]*\}", proc.stderr)
        if not m:
            return False
        measured = json.loads(m.group(0))
        filt = (
            "loudnorm=I=-17:TP=-1.5:LRA=11"
            f":measured_I={measured['input_i']}"
            f":measured_TP={measured['input_tp']}"
            f":measured_LRA={measured['input_lra']}"
            f":measured_thresh={measured['input_thresh']}"
            f":offset={measured['target_offset']}"
            ":linear=true,"
            "aresample=48000:resampler=soxr"
        )
        run_cmd(
            ["ffmpeg", "-y", "-v", "error", "-i", str(src), "-af", filt, str(dst)],
            "Normalisasi loudness",
        )
        return True
    except Exception as exc:  # noqa: BLE001 — normalisasi opsional, jangan gagalkan job
        log(f"Normalisasi loudness dilewati: {exc}")
        return False


def process_job(supabase, job: dict) -> None:
    job_id = job["id"]
    log(f"Job {job_id}: mulai (voice {job['voice_id']})")
    supabase.table("jobs").update({"status": "processing"}).eq("id", job_id).execute()

    with tempfile.TemporaryDirectory(prefix=f"vo-{job_id[:8]}-") as tmp:
        tmpdir = Path(tmp)
        try:
            # --- Ambil suara referensi (ref_path + prompt_text) ---
            voice = (
                supabase.table("voices")
                .select("ref_path, prompt_text")
                .eq("id", job["voice_id"])
                .single()
                .execute()
                .data
            )
            if not voice:
                raise RuntimeError("Suara referensi tidak ditemukan.")
            prompt_text: str = voice["prompt_text"]
            ref_path: str = voice["ref_path"]

            # --- Download + konversi referensi ---
            ref_bytes = supabase.storage.from_("voice-refs").download(ref_path)
            # Nama sumber HARUS beda dari ref.wav: bila ref_path berekstensi
            # .wav, "ref" + suffix == "ref.wav" == ref_wav sehingga ffmpeg
            # menolak (input == output). Pakai "ref-src" agar selalu beda.
            ref_src = tmpdir / ("ref-src" + Path(ref_path).suffix)
            ref_src.write_bytes(ref_bytes)
            ref_wav = tmpdir / "ref.wav"
            convert_ref_to_wav(ref_src, ref_wav)

            # --- Pecah teks + sintesis per chunk (proses fresh) ---
            chunks = split_text(job["text"])
            log(f"Job {job_id}: {len(chunks)} chunk")
            chunk_files: list[Path] = []
            env = {
                **os.environ,
                "OMP_NUM_THREADS": "1",
                "MKL_NUM_THREADS": "1",
                "MALLOC_ARENA_MAX": "1",
                "VOXCPM_MODEL_DIR": MODEL_DIR,
            }
            for i, chunk_text in enumerate(chunks):
                out_chunk = tmpdir / f"chunk-{i:02d}.wav"
                proc = subprocess.run(
                    [
                        sys.executable, str(SYNTHESIZE_PY),
                        str(ref_wav), prompt_text, chunk_text, str(out_chunk),
                    ],
                    capture_output=True, text=True, env=env,
                )
                if proc.returncode != 0:
                    tail = (proc.stderr or proc.stdout or "")[-2000:]
                    raise RuntimeError(f"Sintesis chunk {i + 1}/{len(chunks)} gagal: {tail}")
                chunk_files.append(out_chunk)
                log(f"Job {job_id}: chunk {i + 1}/{len(chunks)} OK")

            # --- Gabung + normalisasi ---
            joined = tmpdir / "joined.wav"
            join_chunks(chunk_files, joined)
            final = tmpdir / "final.wav"
            if not normalize_loudness(joined, final):
                final = joined

            # --- Upload hasil ---
            out_path = f"outputs/{job_id}.wav"
            data = final.read_bytes()
            supabase.storage.from_("vo-outputs").upload(
                out_path, data, {"content-type": "audio/wav", "upsert": "true"}
            )
            supabase.table("jobs").update(
                {"status": "done", "output_path": out_path, "error": None}
            ).eq("id", job_id).execute()
            log(f"Job {job_id}: DONE -> {out_path}")
        except Exception as exc:  # noqa: BLE001 — satu job gagal tidak boleh mematikan worker
            err = str(exc)[:500]
            log(f"Job {job_id}: FAILED — {err}")
            supabase.table("jobs").update(
                {"status": "failed", "error": err}
            ).eq("id", job_id).execute()


def process_transcription(supabase, tr: dict) -> None:
    """Transkrip SATU audio dengan faster-whisper (proses fresh).

    Audio diunduh dari bucket `transcript-audio` apa adanya (format
    asli mp3/wav/m4a), lalu transcribe.py mendekodenya ke array
    float32 mono 16 kHz via ffmpeg sebelum diberikan ke
    faster-whisper (decode lewat path file crash di PyAV 19.x).
    Hasil JSON transcribe.py (text + segments) disimpan ke baris
    transcriptions.
    """
    import json

    tr_id = tr["id"]
    log(f"Transkrip {tr_id}: mulai ({tr.get('audio_name') or tr['audio_path']})")
    supabase.table("transcriptions").update({"status": "processing"}).eq("id", tr_id).execute()

    with tempfile.TemporaryDirectory(prefix=f"tr-{tr_id[:8]}-") as tmp:
        tmpdir = Path(tmp)
        try:
            audio_bytes = supabase.storage.from_("transcript-audio").download(tr["audio_path"])
            audio_src = tmpdir / ("audio" + Path(tr["audio_path"]).suffix)
            audio_src.write_bytes(audio_bytes)

            out_json = tmpdir / "result.json"
            language = tr.get("language") or "id"
            proc = subprocess.run(
                [
                    sys.executable, str(TRANSCRIBE_PY),
                    str(audio_src), language, str(out_json),
                ],
                capture_output=True, text=True,
                env={**os.environ, "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1"},
            )
            if proc.returncode != 0:
                tail = (proc.stderr or proc.stdout or "")[-2000:]
                raise RuntimeError(f"Transkripsi gagal: {tail}")
            result = json.loads(out_json.read_text(encoding="utf-8"))
            supabase.table("transcriptions").update(
                {
                    "status": "done",
                    "text": result.get("text") or "",
                    "segments": result.get("segments") or [],
                    "error": None,
                }
            ).eq("id", tr_id).execute()
            log(
                f"Transkrip {tr_id}: DONE "
                f"lang={result.get('language')} segs={len(result.get('segments') or [])}"
            )
        except Exception as exc:  # noqa: BLE001 — satu job gagal tidak boleh mematikan worker
            # Simpan EKOR pesan error (bukan kepala): akar masalah ada di
            # baris terakhir traceback, kepala 500 karakter hanya berisi
            # "Transkripsi gagal: Traceback..." tanpa penyebabnya.
            err = str(exc)[-1500:]
            log(f"Transkrip {tr_id}: FAILED — {err}")
            supabase.table("transcriptions").update(
                {"status": "failed", "error": err}
            ).eq("id", tr_id).execute()


def main() -> None:
    if not SUPABASE_URL or not SERVICE_KEY:
        raise SystemExit("Isi SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY di environment.")
    if not MODEL_DIR or not Path(MODEL_DIR).is_dir():
        raise SystemExit(
            "VOXCPM_MODEL_DIR belum diisi / bukan direktori. "
            "Lihat worker/README.md untuk cara mengunduh bobot VoxCPM2."
        )
    supabase = create_client(SUPABASE_URL, SERVICE_KEY)
    log(f"Worker jalan — polling tiap {POLL_INTERVAL} dtk, model: {MODEL_DIR}")
    while True:
        try:
            # VO dulu (prioritas): satu job dalam satu waktu, jangan
            # paralel dengan transkripsi (RAM box 8 GB tidak cukup
            # untuk VoxCPM ±6,2 GB + faster-whisper sekaligus).
            res = (
                supabase.table("jobs")
                .select("id, voice_id, text")
                .eq("status", "queued")
                .order("created_at")
                .limit(1)
                .execute()
            )
            queued = res.data or []
            if queued:
                process_job(supabase, queued[0])
                continue
            # Tidak ada VO aktif — baru cek antrean transkripsi.
            res_tr = (
                supabase.table("transcriptions")
                .select("id, audio_path, audio_name, language")
                .eq("status", "queued")
                .order("created_at")
                .limit(1)
                .execute()
            )
            queued_tr = res_tr.data or []
            if queued_tr:
                process_transcription(supabase, queued_tr[0])
            else:
                time.sleep(POLL_INTERVAL)
        except KeyboardInterrupt:
            log("Worker dihentikan.")
            break
        except Exception as exc:  # noqa: BLE001 — polling tidak boleh mati karena error sesaat
            log(f"Error polling (coba lagi {POLL_INTERVAL} dtk): {exc}")
            time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
