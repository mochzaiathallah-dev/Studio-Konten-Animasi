import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Helper Supabase untuk VO Studio.
 *
 * - Browser (anon key): hanya dipakai untuk upload audio referensi langsung
 *   ke Storage (bucket voice-refs). TIDAK pernah menyentuh service role key.
 * - Server (service role key): dipakai API routes untuk baca/tulis tabel
 *   voices + jobs dan hapus file output. Key ini HANYA ada di server
 *   (env tanpa prefix NEXT_PUBLIC_) dan tidak pernah dikirim ke browser.
 *
 * Semua fungsi mengembalikan null bila env belum diisi, supaya aplikasi
 * tetap bisa dibuka dan menampilkan layar "belum terhubung".
 */

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

let browserClient: SupabaseClient | null = null;

export function getBrowserClient(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
  if (!browserClient) {
    browserClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string,
    );
  }
  return browserClient;
}

export function getServiceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export type Voice = {
  id: string;
  name: string;
  ref_path: string;
  prompt_text: string;
  created_at: string;
};

export type JobStatus = "queued" | "processing" | "done" | "failed";

export type Job = {
  id: string;
  voice_id: string;
  text: string;
  status: JobStatus;
  output_path: string | null;
  error: string | null;
  created_at: string;
  voices?: { name: string } | null;
};

/** URL publik file hasil di bucket `vo-outputs` (bucket public). */
export function publicOutputUrl(outputPath: string | null): string | null {
  if (!outputPath) return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return null;
  return `${url.replace(/\/$/, "")}/storage/v1/object/public/vo-outputs/${outputPath}`;
}

export type TranscriptionStatus = "queued" | "processing" | "done" | "failed";

/** Satu segmen transkrip ber-timestamp (waktu dalam detik). */
export type TranscriptionSegment = {
  start: number;
  end: number;
  text: string;
};

export type Transcription = {
  id: string;
  audio_path: string;
  audio_name: string | null;
  model: string;
  language: string;
  status: TranscriptionStatus;
  text: string | null;
  segments: TranscriptionSegment[] | null;
  error: string | null;
  created_at: string;
};
