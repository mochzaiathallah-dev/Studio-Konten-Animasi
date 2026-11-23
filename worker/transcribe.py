"""Transkripsi SATU file audio dengan faster-whisper dalam proses FRESH.

Dipanggil worker.py sekali per job transkripsi (bukan sekali per
worker) — pola yang sama seperti synthesize.py: tiap job = 1 proses
baru (heap bersih), lalu proses mati.

Pola ini disalin dari transcribe_vo.py (Ayam Bawang, terbukti jalan):
  - WhisperModel("small", device="cpu", compute_type="int8")
  - transcribe(..., vad_filter=True) — buang hening antar ujaran.
  Bedanya: word_timestamps=False — untuk transkrip website cukup
  segmen ber-timestamp (start/end/teks), tanpa waktu per kata.

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
import sys
import time

MODEL_NAME = "small"

AUDIO, LANGUAGE, OUT_FILE = sys.argv[1], sys.argv[2], sys.argv[3]


def main() -> None:
    from faster_whisper import WhisperModel

    lang = None if LANGUAGE in ("auto", "", "None") else LANGUAGE

    t0 = time.time()
    model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
    print(f"[t={time.time() - t0:.0f}s] model {MODEL_NAME} loaded", flush=True)

    t1 = time.time()
    segments_iter, info = model.transcribe(
        AUDIO,
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
