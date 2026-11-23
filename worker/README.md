# Worker VO Studio

Worker Python yang menjalankan sintesis suara VoxCPM2. **Bukan** bagian
dari deploy Vercel — Vercel hanya menjalankan website + API ringan.
Worker ini harus jalan di mesin sendiri (VPS/server) dengan
**RAM kosong ≥ 6,2 GB** (peak RSS sintesis ±6,12 GB, terukur).

## Cara kerja

1. Polling tabel `jobs` tiap 10 detik, ambil job tertua `status=queued`.
2. Set `processing`, download audio referensi dari bucket `voice-refs`,
   konversi ke wav 16 kHz mono (ffmpeg).
3. Pecah teks jadi chunk (±25 kata, pecah di koma), sintesis **tiap chunk
   dalam proses fresh** (`synthesize.py`) — pola yang terbukti 16/16
   chunk lolos tanpa OOM.
4. Gabung chunk (hening 0,25 dtk di antaranya), normalisasi loudnorm
   ke −14 LUFS, upload ke bucket `vo-outputs`, set job `done`.
5. Bila gagal: job `failed` + pesan error, worker lanjut ke job berikut.

## 1. Syarat mesin worker

- Python 3.12 (atau 3.11+)
- **ffmpeg** terinstal (`ffmpeg -version`)
- RAM kosong **≥ 6,2 GB** saat sintesis jalan (cek: `grep MemAvailable /proc/meminfo`)
- Disk kosong ±6 GB (bobot model 4,8 GB)
- Koneksi internet (download bobot sekali, ±30 menit)

## 2. Instalasi (urutan penting — jangan dibalik)

```sh
python3 -m venv .venv
source .venv/bin/activate
export TMPDIR=/tmp  # atau direktori tmp yang cukup besar

# (a) torch CPU dulu dari index PyTorch:
.venv/bin/pip install --upgrade pip
.venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu

# (b) voxcpm (menarik torchaudio build CUDA dari PyPI — akan diperbaiki di (c)):
.venv/bin/pip install voxcpm==2.0.3

# (c) WAJIB: ganti torchaudio ke build CPU (tanpa ini import gagal
#     "OSError: libcudart.so.13"):
.venv/bin/pip install --force-reinstall torchaudio --index-url https://download.pytorch.org/whl/cpu

# (d) sisa dependensi:
.venv/bin/pip install -r requirements.txt
```

Versi terverifikasi: `voxcpm 2.0.3`, `torch 2.15.0+cpu`, `torchaudio 2.11.1+cpu`.

## 3. Download bobot model (sekali saja)

```sh
export HF_HUB_DISABLE_XET=1   # WAJIB: download XET gagal di tengah jalan
python3 - <<'EOF'
from huggingface_hub import snapshot_download
snapshot_download("openbmb/VoxCPM2")
EOF
```

Lalu buat salinan lokal dengan `config.json` yang `max_length`-nya
1024 (bukan 8192) — ini menghemat ±265 MB pre-alokasi KV cache dan
terbukti membuat sintesis lolos (tidak mengubah bobot/kualitas):

```sh
mkdir -p voxcpm-model-local
cp ~/.cache/huggingface/hub/models--openbmb--VoxCPM2/snapshots/*/config.json voxcpm-model-local/
# edit voxcpm-model-local/config.json: "max_length": 8192 -> 1024
# lalu symlink file-file bobot lainnya ke voxcpm-model-local/
# (atau salin seluruh isi snapshot ke voxcpm-model-local/)
```

Detail lengkap pola ini ada di `VO-VOXCPM.md` §7 (proyek Sego Njamoer).

## 4. Environment variables

Buat `worker/.env` (atau export di shell):

```sh
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...   # service role, RAHASIAKAN
VOXCPM_MODEL_DIR=/path/ke/voxcpm-model-local
POLL_INTERVAL_SECONDS=10
```

Worker membaca env dari proses (tidak membaca file `.env` sendiri —
gunakan `export $(cat .env | xargs)` atau `python-dotenv` bila mau).

## 5. Menjalankan

```sh
cd worker
../.venv/bin/python worker.py
# log: "Worker jalan — polling tiap 10 dtk, model: ..."
```

Untuk jalan terus di server, pakai `systemd` (contoh unit, sesuaikan path):

```ini
[Unit]
Description=VO Studio Worker
After=network.target

[Service]
WorkingDirectory=/opt/vo-studio/worker
EnvironmentFile=/opt/vo-studio/worker/.env
ExecStart=/opt/vo-studio/.venv/bin/python worker.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

## 6. Troubleshooting

- **OOM saat load model** — pastikan `torch.set_default_dtype(bfloat16)`
  sudah jalan sebelum konstruksi model (sudah ada di `synthesize.py`);
  pastikan tidak ada proses berat lain di mesin yang sama.
- **OOM saat generate chunk panjang** — worker sudah memecah teks
  ±25 kata/chunk; bila masih OOM, turunkan `MAX_WORDS_PER_CHUNK`
  di `worker.py` jadi 15.
- **"libcudart.so.13"** — torchaudio build CUDA terinstal; ulangi
  langkah 2(c).
- **Job stuck `processing`** — worker mati di tengah job (restart /
  OOM). Set manual kembali ke `queued` di Supabase (Table Editor)
  supaya diproses ulang.
- **Suara hasil tidak mirip** — cek `prompt_text` di tabel `voices`:
  harus PERSIS kalimat yang diucapkan di audio referensi.
