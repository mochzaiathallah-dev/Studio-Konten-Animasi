-- ============================================================
-- VO Studio — skema Supabase
-- Jalankan file ini di Supabase Dashboard → SQL Editor → Run.
--
-- Tabel:
--   voices  — suara referensi (audio di Storage bucket voice-refs)
--   jobs    — antrean generate VO (hasil di Storage bucket vo-outputs)
--   stories — naskah cerita per adegan (ditulis OpenAI; tiap adegan
--              dibuatkan 1 job VO di tabel jobs)
--
-- CATATAN KEAMANAN (baca dulu):
-- Aplikasi ini dirancang sebagai ALAT PRIBADI (satu pengguna), bukan
-- layanan multi-user publik. RLS aktif, tapi policy di bawah ini
-- PERMISSIVE (anon + authenticated boleh baca/tulis semua row) supaya
-- aplikasi web-nya langsung jalan tanpa sistem login.
-- Jangan deploy URL publik dengan policy ini bila ada data orang lain
-- di dalamnya. Untuk pemakaian multi-user, ganti policy dengan
-- auth.uid() per pengguna.
-- ============================================================

-- uuid_generate_v4() / gen_random_uuid()
create extension if not exists "pgcrypto";

-- ------------------------- voices -------------------------
create table if not exists public.voices (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- path file di bucket Storage `voice-refs`, mis. "refs/<uuid>.wav"
  ref_path text not null,
  -- kalimat PERSIS yang diucapkan di audio referensi.
  -- WAJIB untuk ultimate cloning VoxCPM2 (prompt_text).
  prompt_text text not null,
  created_at timestamptz not null default now()
);

-- -------------------------- jobs --------------------------
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  voice_id uuid not null references public.voices (id) on delete cascade,
  text text not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'done', 'failed')),
  -- path file hasil di bucket Storage `vo-outputs`, mis. "outputs/<job-id>.wav"
  output_path text,
  -- pesan error bila status = 'failed'
  error text,
  created_at timestamptz not null default now()
);

create index if not exists jobs_status_created_idx
  on public.jobs (status, created_at);

-- ------------------------- stories ------------------------
-- Cerita ala bang-story (HANYA naskahnya — tanpa gambar/video AI).
-- Satu cerita = ide + naskah per adegan (JSON) yang ditulis OpenAI;
-- tiap adegan lalu dibuatkan 1 job VO di tabel jobs (voice_id sama).
create table if not exists public.stories (
  id uuid primary key default gen_random_uuid(),
  idea text not null,
  -- target durasi yang dipilih user: "30 dtk" / "1 mnt" / "3 mnt" /
  -- "5 mnt" / "10 mnt" (panduan jumlah adegan; durasi VO akhir
  -- mengikuti panjang narasi yang dihasilkan).
  duration_target text not null default '1 mnt',
  -- bahasa naskah, default 'id' (Indonesia).
  language text not null default 'id',
  -- naskah per adegan: [{ "title": "...", "narration": "..." }, ...]
  script jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists stories_created_idx
  on public.stories (created_at);

-- --------------------------- RLS --------------------------
-- RLS AKTIF di kedua tabel (wajib supaya policy berlaku).
alter table public.voices enable row level security;
alter table public.jobs enable row level security;

-- Policy permissive untuk alat pribadi (lihat catatan di atas).
-- anon = pengunjung web (anon key), authenticated = login (bila ada).
drop policy if exists "voices_all_anon" on public.voices;
create policy "voices_all_anon" on public.voices
  for all to anon, authenticated using (true) with check (true);

drop policy if exists "jobs_all_anon" on public.jobs;
create policy "jobs_all_anon" on public.jobs
  for all to anon, authenticated using (true) with check (true);

alter table public.stories enable row level security;

drop policy if exists "stories_all_anon" on public.stories;
create policy "stories_all_anon" on public.stories
  for all to anon, authenticated using (true) with check (true);

-- ------------------------- bucket -------------------------
-- Bucket dibuat lewat Dashboard → Storage (bukan lewat SQL):
--   1. Bucket `voice-refs`  — PRIVATE (audio referensi, jangan publik).
--      Supabase Dashboard → Storage → New bucket → nama "voice-refs",
--      biarkan "Public bucket" MATI.
--   2. Bucket `vo-outputs`  — PUBLIC (hasil VO diputar/diunduh web).
--      New bucket → nama "vo-outputs", nyalakan "Public bucket".
-- Policy Storage di bawah ini WAJIB dijalankan (RLS aktif di
-- storage.objects dan TIDAK ada policy bawaan — tanpa ini, upload
-- audio dari browser ditolak "new row violates row-level security
-- policy" meski tabel sudah benar). Policy ini bagian dari file ini,
-- jadi cukup jalankan ulang schema.sql ini sekali.
drop policy if exists "voice_refs_insert_anon" on storage.objects;
create policy "voice_refs_insert_anon" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'voice-refs');

drop policy if exists "voice_refs_select_anon" on storage.objects;
create policy "voice_refs_select_anon" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'voice-refs');

drop policy if exists "vo_outputs_select_anon" on storage.objects;
create policy "vo_outputs_select_anon" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'vo-outputs');
-- Upload/update/delete di vo-outputs hanya lewat service role
-- (worker) — service role bypass RLS, jadi tidak butuh policy.
