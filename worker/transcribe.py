"""Transkripsi SATU file audio dengan faster-whisper dalam proses FRESH.

Dipanggil worker.py sekali per job transkripsi (bukan sekali per
worker) — pola yang sama seperti synthesize.py: tiap job = 1 proses
baru (heap bersih), lalu proses mati.

Pola ini disalin dari transcribe_vo.py (Ayam Bawang, terbukti jalan):
  - WhisperModel("small", device="cpu", compute_type="int8")
  - transcribe(..., vad_filter=True) — buang hening antar ujaran.
  Bedanya: word_timestamps=False — untuk transkrip website cukup
  segmen ber-timestamp (start/end/teks), tanpa waktu per kata.

Audio TIDAK diberikan sebagai path file ke model.transcribe():
faster-whisper 1.2.1 mendekode path lewat PyAV (av.open dengan
kwarg metadata_errors) dan av 19.x menolak kwarg itu
(TypeError) — bug yang sama dengan yang dialami transcribe_vo.py.
Sebagai gantinya audio didekode dulu ke array float32 mono 16 kHz
via ffmpeg (load_audio_16k), lalu array-nya yang diberikan ke
model.transcribe() — PyAV tidak tersentuh sama sekali.

Pemakaian:  python transcribe.py <audio> <language> <out_json>
  language: "id" / "en" / "auto" ("auto" = deteksi otomatis -> None).
  out_json: {"text": "...", "segments": [{"start": 0.0, "end": 3.5,
            "text": "..."}, ...], "language": "id",
            "language_probability": 0.99}

Syarat RAM: model small ±1-2 GB (jauh di bawah VoxCPM2 ±6,2 GB),
jadi aman jalan di box yang sama — asal TIDAK bersamaan dengan
sintesis VO (worker.py memproses satu job dalam satu waktu).
"""

import json
import subprocess
import sys
import time

import numpy as np

MODEL_NAME = "small"

AUDIO, LANGUAGE, OUT_FILE = sys.argv[1], sys.argv[2], sys.argv[3]


def load_audio_16k(path: str) -> np.ndarray:
    """Decode audio apa pun (mp3/wav/m4a/...) jadi float32 mono 16 kHz
    via ffmpeg. Dipakai agar model.transcribe() menerima array, bukan
    path — path membuat faster-whisper memanggil av.open() yang crash
    di PyAV 19.x (metadata_errors). Pola terbukti transcribe_vo.py."""
    cmd = [
        "ffmpeg", "-nostdin", "-threads", "0", "-i", path,
        "-f", "f32le", "-ac", "1", "-acodec", "pcm_f32le",
        "-ar", "16000", "-",
    ]
    out = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32)


def main() -> None:
    from faster_whisper import WhisperModel

    lang = None if LANGUAGE in ("auto", "", "None") else LANGUAGE

    t0 = time.time()
    audio = load_audio_16k(AUDIO)
    print(f"[t={time.time() - t0:.0f}s] audio {len(audio) / 16000:.1f} dtk", flush=True)
    model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
    print(f"[t={time.time() - t0:.0f}s] model {MODEL_NAME} loaded", flush=True)

    t1 = time.time()
    segments_iter, info = model.transcribe(
        audio,
        language=lang,
        beam_size=5,
        word_timestamps=False,
        vad_filter=True,
    )
    segments = [
        {
            "start": round(float(s.start), 2),
            "end": round(float(s.end), 2),
            "text": s.text.strip(),
        }
        for s in segments_iter
    ]
    text = " ".join(s["text"] for s in segments).strip()
    result = {
        "text": text,
        "segments": segments,
        "language": info.language,
        "language_probability": round(float(info.language_probability), 3),
    }
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    print(
        f"[t={time.time() - t1:.0f}s] DONE lang={info.language} "
        f"(p={info.language_probability:.2f}) segs={len(segments)} "
        f"chars={len(text)}",
        flush=True,
    )


if __name__ == "__main__":
    main()
