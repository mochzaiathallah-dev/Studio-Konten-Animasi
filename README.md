# VO Studio

Website untuk membuat voice-over (VO) dengan suara Anda sendiri —
**kloning suara VoxCPM2**: unggah audio referensi + tulis kalimat
persisnya, tulis teks VO, generate, dengarkan dan unduh hasilnya.

Bahasa UI: Indonesia. Stack: Next.js 16 (App Router, TypeScript,
Tailwind v4) + Supabase (database + Storage) + worker Python terpisah.

## Arsitektur (jujur — baca dulu)

```
Browser ──► Vercel (Next.js: halaman + API routes ringan)
               │  baca/tulis tabel voices + jobs (service role key)
               ▼
           Supabase ──► tabel voices, jobs, stories
                     ──► Storage: bucket voice-refs (private)
                                  bucket vo-outputs (public)
               ▲  polling jobs status=queued (tiap 10 dtk)
               │  cron harian → GET /api/ping (keep-alive, 1×/hari)
               │
           Worker Python (MESIN SENDIRI, bukan Vercel)
               │  download ref → sintesis VoxCPM2 → upload hasil
               ▼  update status job done/failed
```

**Vercel TIDAK BISA menjalankan sintesis VoxCPM2.** Modelnya 4,8 GB
dan butuh ±6,2 GB RAM saat jalan — jauh di atas limit serverless
Vercel. Karena itu sintesis dikerjakan worker Python terpisah di
mesin dengan RAM besar (VPS/server sendiri). Website hanya mengatur
antrean job; worker yang mengeksekusinya.

## Fitur

**Tampilan studio (update 2026-11-23, meniru UI/UX referensi OmniVoice
— aplikasi desktop voice-clone — tapi tetap web Vercel + Supabase):**

- **Tema Sistem / Gelap / Terang** — saklar di header kanan. "Sistem"
  mengikuti tema OS (dan ikut berubah bila OS berubah); pilihan tersimpan
  di `localStorage` dan diterapkan SEBELUM halaman digambar (script
  pra-paint di `layout.tsx`), jadi tidak ada kedipan tema. Seluruh warna
  halaman (kartu, input, tombol, badge) diambil dari variabel CSS di
  `globals.css` — satu ganti tema mengubah semuanya, termasuk mode gelap
  yang sebelumnya rusak (halaman lama hardcode warna terang).
- **Layout studio 2 kolom** — kiri: kontrol (Suara Referensi + Studio);
  kanan (menempel): Hasil Sintesis Audio + Parameter Karakter Vokal Aktif
  + daftar Hasil. Di layar kecil kolom menumpuk rapi.
- **Tab Voice Clone / Voice Design / Cerita** (seperti tab di OmniVoice):
  - **Voice Clone** — kloning apa adanya (ultimate cloning VoxCPM2).
  - **Voice Design** — rancang karakter suara di atas suara referensi:
    Gender, Usia, Pitch, Gaya Vokal, Dialek/Aksen Indonesia (10 pilihan),
    slider Kecepatan Bicara. Atribut dirangkai menjadi SATU instruksi
    gaya yang ditampilkan persis apa adanya sebelum Generate — lalu
    ditempel di depan teks VO. Ini pola resmi "controllable cloning"
    VoxCPM2; worker TIDAK diubah (ia meneruskan `job.text` apa adanya
    ke model), jadi tidak ada risiko merusak sintesis yang sudah jalan.
    Timbre tetap dari suara referensi Anda.
  - **Cerita** — sama seperti sebelumnya (OpenAI tulis naskah per adegan
    → tiap adegan jadi job VO VoxCPM).
- **Hapus suara** (baru, melengkapi CRUD) — tombol "Hapus suara" di tiap
  suara tersimpan: menghapus row di tabel `voices`, file referensi di
  bucket `voice-refs`, dan (lewat FK cascade) semua job VO suara itu
  beserta file output-nya. Semua CRUD (suara, job, cerita) tersimpan di
  Supabase — tidak ada data yang hanya hidup di browser.
- **Panel Hasil Sintesis Audio** — menampilkan job terbaru (waveform
  dekoratif, status, bilah progres saat diproses worker, player +
  tombol Unduh WAV bila selesai), dan **Parameter Karakter Vokal Aktif**
  — ringkasan mode + atribut + nilai asli worker (10 diffusion steps,
  cfg 2.0, seed 42, WAV 48 kHz, −14 LUFS).

Yang SENGAJA TIDAK disalin dari OmniVoice (supaya tidak ada fitur palsu):
tombol "Auto-Transkrip (Whisper ASR)" — butuh model Whisper + endpoint
baru, belum ada; chip simbol non-verbal (tawa, helaan napas, dsb.) —
VoxCPM tidak menjamin memahaminya sebagai efek suara; dan instalasi
model lokal / auto-install komponen — web Vercel tidak bisa menjalankan
model (sintesis tetap di worker terpisah). Ketiganya bisa ditambah nanti
bila diminta, dengan endpoint + worker yang sesuai.

1. **Suara Referensi** — upload audio (mp3/wav/m4a, ≤10 MB, disarankan
   ≤30 detik), beri nama, isi teks prompt (kalimat persis di audio —
   WAJIB untuk cloning VoxCPM2). File diunggah langsung dari browser
   ke Storage, lalu tersimpan di tabel `voices`. Daftar suara bisa
   dipilih untuk dipakai, dan bisa dihapus (lihat di atas).
2. **Buat VO** — pilih suara, tulis teks (maks 2000 karakter, ada
   hitungan karakter/kata), Generate → job masuk antrean
   (`status=queued`).
3. **Hasil** — daftar job dengan status `queued / processing / done /
   failed` (+ pesan error bila gagal). Status diperbarui otomatis
   HANYA saat ada job aktif (polling ringan tiap 3 detik, lihat
   "Keep-alive + hemat kuota" di bawah); bila tidak ada job aktif,
   tidak ada polling sama sekali. Bila selesai: audio player +
   tombol Download WAV + hapus job.
4. **Cerita** — tulis ide cerita + pilih durasi target (30 dtk /
   1 mnt / 3 mnt / 5 mnt / 10 mnt) + pilih suara, lalu "Buat Naskah
   & VO": OpenAI (gpt-4o-mini) menulis naskah per adegan (3–8 adegan),
   naskah disimpan di tabel `stories`, dan TIAP adegan langsung
   dibuatkan 1 job VO (suara tetap VoxCPM2 — OpenAI HANYA menulis
   naskah, tidak membuat suara). Naskah per adegan ditampilkan di
   halaman; hasil audionya muncul di bagian Hasil seperti job biasa.
5. **Layar status koneksi** — bila env Supabase belum diisi, aplikasi
   menampilkan peringatan jelas + langkah setup, dan form generate
   dinonaktifkan (aplikasi tetap bisa dibuka).

## Keep-alive + hemat kuota (free plan)

Supabase free plan **pause project setelah 7 hari tanpa aktivitas**
(bukan hitungan detik — project tidak mati sendiri dalam hitungan
detik). Batas free plan: egress 5 GB/bulan, database 500 MB, storage
1 GB, 50.000 MAU. Vercel free (Hobby): cron maks 2 job, frekuensi
harian. Aplikasi ini dirancang supaya tidak menggerus kuota itu:

- **Cron harian** (`vercel.json`): 1 cron, tiap tengah malam UTC,
  memanggil `GET /api/ping` — query paling ringan ke Supabase
  (`select id from voices limit 1`). 1 ping/hari ≈ 30 request/bulan,
  bisa diabaikan terhadap batas free plan. Satu ping sehari SUDAH
  CUKUP mencegah pause 7 hari — tidak perlu ping tiap detik/menit.
  Bila deploy BUKAN di Vercel (atau cron Hobby tidak aktif), cron
  apa pun (mis. UptimeRobot) yang memanggil `/api/ping` 1×/hari
  punya efek yang sama.
- **Polling status job hemat**: halaman utama HANYA polling saat ada
  job berstatus `queued`/`processing` — interval 3 detik, lewat
  `GET /api/jobs?fields=light` yang hanya mengambil
  `id, status, output_path, error` (tanpa teks/nama suara, tiap
  respons <1 KB). Begitu semua job `done`/`failed`, polling
  berhenti otomatis. Bila tidak ada job aktif, tidak ada polling
  sama sekali — jadi membuka website saja TIDAK memakan kuota.
- **Tanpa realtime/WebSocket** — sengaja, supaya tidak ada koneksi
  yang terus-menerus hidup.

## Cerita (OpenAI tulis naskah, VoxCPM baca)

Terinspirasi repo bang-story (bangtutorial/bang-story, MIT) — aplikasi
desktop Electron: ide cerita → AI susun naskah per adegan →
gambar/video AI (Higgsfield) → narasi AI → editor timeline → ekspor
MP4. Website ini mengambil **HANYA bagian naskahnya**:

- **Yang ada**: ide → OpenAI tulis naskah per adegan → tiap adegan
  jadi job VO VoxCPM (suara referensi Anda).
- **Yang TIDAK ada** (sengaja): gambar/video AI (Higgsfield tidak
  dipakai), editor timeline, ekspor MP4. Cerita di sini berhenti di
  audio per adegan — cukup untuk naskah + narasi.

Cara dapat OpenAI API key: [platform.openai.com](https://platform.openai.com)
→ API keys → Create new secret key. Isi ke `OPENAI_API_KEY` di
`.env.local` (lokal) / Environment Variables Vercel. Key ini HANYA
dipakai server (`/api/story`) — tidak pernah dikirim ke frontend dan
tidak boleh di-commit ke repo (lihat `.env.example`).
Perkiraan biaya: gpt-4o-mini ≈ $0,15/1 juta token input +
$0,60/1 juta token output — satu naskah cerita (3–8 adegan) kira-kira
$0,001–0,003 (kurang dari Rp50). Cek harga terbaru di
platform.openai.com. Bila key belum diisi, fitur Cerita menampilkan
error jelas "OPENAI_API_KEY belum diisi" (bukan crash).

## Setup Supabase

1. Buat project di [supabase.com](https://supabase.com) (free tier cukup).
2. Buka **SQL Editor** → jalankan isi `supabase/schema.sql`
   (tabel `voices` + `jobs` + `stories`, RLS aktif + policy permissive untuk
   alat pribadi — baca komentar keamanan di file itu).
3. Buka **Storage** → buat 2 bucket:
   - `voice-refs` — **private** (audio referensi).
   - `vo-outputs` — **public** (hasil VO diputar/diunduh web).
4. Salin dari **Settings → API**: Project URL, `anon public` key,
   `service_role` key.

## Menjalankan lokal

```sh
cp .env.example .env.local   # isi 3 variabel Supabase
npm install
npm run dev                  # http://localhost:3000
npm run build                # verifikasi build produksi
```

## Deploy ke Vercel

1. Push repo ini ke GitHub/GitLab.
2. Vercel → **Add New Project** → import repo → Framework: Next.js.
3. Isi **Environment Variables** (sama seperti `.env.local`):
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, dan (opsional, hanya untuk fitur
   Cerita) `OPENAI_API_KEY`.
4. Deploy. Website + API routes jalan; **worker TIDAK ikut ter-deploy**
   (lihat bawah). Cron harian keep-alive (`vercel.json`) ikut
   ter-deploy otomatis — 1 cron ke `/api/ping` tiap tengah malam UTC.

## Menjalankan worker (wajib supaya job diproses)

Worker ada di `worker/` — baca `worker/README.md` untuk langkah
lengkap (instalasi torch CPU, download bobot, env, systemd).
Singkatnya: mesin dengan RAM kosong ≥6,2 GB + Python 3.12 + ffmpeg,
lalu:

```sh
cd worker
pip install -r requirements.txt   # setelah torch CPU (lihat README worker)
export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... VOXCPM_MODEL_DIR=...
python worker.py
```

Tanpa worker yang jalan, job akan tetap `queued` — itu normal,
bukan error aplikasi.

## Struktur file

```
src/
  app/
    page.tsx              Halaman utama (studio 2 kolom: Suara Referensi +
                          tab Voice Clone / Voice Design / Cerita di kiri;
                          Hasil Sintesis + Parameter + daftar Hasil di kanan)
    layout.tsx            Layout + metadata + script pra-paint tema
    globals.css           Variabel tema Sistem/Gelap/Terang + komponen UI
    api/
      voices/route.ts     GET + POST + DELETE /api/voices (DELETE juga
                          menghapus file referensi + job suara itu)
      jobs/route.ts       GET (full + ?fields=light) + POST + DELETE /api/jobs
      story/route.ts      POST /api/story (OpenAI tulis naskah → job VO per adegan)
      ping/route.ts       GET /api/ping (keep-alive Supabase, query paling ringan)
  lib/supabase.ts         Client browser (anon) + server (service role)
supabase/schema.sql       Tabel voices + jobs + stories, RLS + policy
vercel.json               1 cron harian → /api/ping (cegah pause Supabase 7 hari)
worker/
  worker.py               Polling jobs, pecah teks, gabung, normalisasi
  synthesize.py           Sintesis 1 chunk (proses fresh, pola terbukti)
  requirements.txt        Dependensi worker (non-torch)
  README.md               Setup worker lengkap
.env.example              Daftar env vars (HANYA placeholder — tanpa nilai rahasia)
```

## Riwayat perubahan

- **2026-11-23 — UI/UX studio ala OmniVoice (v1.1):** tema Sistem/Gelap/
  Terang + script pra-paint (tanpa kedipan), layout 2 kolom, tab Voice
  Clone / Voice Design / Cerita, panel Hasil Sintesis + Parameter Aktif,
  DELETE /api/voices (lengkapi CRUD). Logika/API/worker/schema TIDAK
  diubah — hanya `page.tsx`, `layout.tsx`, `globals.css`,
  `api/voices/route.ts` (tambah DELETE), dan README. Tes: `npm run lint`
  bersih, `npm run build` sukses, smoke test server produksi (halaman
  200, semua string UI baru ada, API mengembalikan 503 JSON yang benar
  saat env belum diisi, tanpa error server). Verifikasi visual lewat
  browser cloud TIDAK bisa jalan — browser itu berjalan di sandbox
  terpisah dan tidak bisa mencapai `localhost:3100` (ERR_CONNECTION_
  REFUSED); verifikasi visual (klik tema + tab) perlu dilakukan di
  browser lokal / setelah deploy Vercel.
- **2026-11-20 — v1.0:** rilis awal (upload suara, buat VO, Cerita,
  keep-alive harian, worker VoxCPM2).

## Catatan pola VoxCPM2 yang dipakai

Diambil dari pola yang sudah terbukti jalan (proyek Sego Njamoer /
Juleha, `VO-VOXCPM.md`):

- `torch.set_default_dtype(torch.bfloat16)` **sebelum** konstruksi
  model (tanpa ini OOM saat load).
- `torch.manual_seed(42)` — `generate()` voxcpm 2.0.3 **tidak**
  menerima kwarg `seed`.
- Ultimate cloning: `prompt_wav_path` + `prompt_text` +
  `reference_wav_path` (ketiganya audio referensi yang sama).
- `cfg_value=2.0`, `inference_timesteps=10`, model lokal dengan
  `config.json max_length` 1024 (hemat KV cache ±265 MB).
- Satu chunk = satu proses fresh (tanpa allocator creep); teks panjang
  dipecah di titik/koma (±25 kata/chunk).
- Normalisasi loudnorm ke −14 LUFS skala earshot (target ffmpeg
  I=−17 karena skala mono ffmpeg ~3 LU lebih rendah).
