import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

/**
 * API Suara Referensi.
 *
 * GET    /api/voices — daftar semua suara (terbaru dulu).
 * POST   /api/voices — simpan suara baru. Body JSON:
 *   { name: string, ref_path: string, prompt_text: string }
 *   File audio TIDAK diunggah lewat sini — browser mengunggah langsung
 *   ke Storage (bucket voice-refs) dengan anon key, lalu mengirim
 *   path-nya ke endpoint ini.
 * DELETE /api/voices?id=… — hapus suara + file referensi di Storage.
 *   Job VO yang memakai suara ini ikut terhapus (FK on delete cascade
 *   di schema.sql); file output job-job itu dihapus best-effort.
 *
 * Catatan Next.js 16 (cacheComponents aktif di next.config.ts):
 * route handler yang memakai `request` sudah dinamis secara default —
 * TIDAK memakai `export const dynamic = 'force-dynamic'` (deprecated
 * di pola ini) dan TIDAK memakai `runtime` segment config.
 */

type VoiceBody = {
  name?: unknown;
  ref_path?: unknown;
  prompt_text?: unknown;
};

function serviceUnavailable() {
  return NextResponse.json(
    {
      error:
        "Supabase belum terhubung — isi NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, dan SUPABASE_SERVICE_ROLE_KEY di .env.local",
    },
    { status: 503 },
  );
}

export async function GET() {
  const supabase = getServiceClient();
  if (!supabase) return serviceUnavailable();

  const { data, error } = await supabase
    .from("voices")
    .select("id, name, ref_path, prompt_text, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ voices: data ?? [] });
}

export async function POST(req: NextRequest) {
  const supabase = getServiceClient();
  if (!supabase) return serviceUnavailable();

  let body: VoiceBody;
  try {
    body = (await req.json()) as VoiceBody;
  } catch {
    return NextResponse.json({ error: "Body harus JSON yang valid." }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const ref_path = typeof body.ref_path === "string" ? body.ref_path.trim() : "";
  const prompt_text =
    typeof body.prompt_text === "string" ? body.prompt_text.trim() : "";

  if (!name) {
    return NextResponse.json({ error: "Nama suara wajib diisi." }, { status: 400 });
  }
  if (name.length > 100) {
    return NextResponse.json(
      { error: "Nama suara maksimal 100 karakter." },
      { status: 400 },
    );
  }
  if (!ref_path) {
    return NextResponse.json(
      { error: "ref_path wajib diisi — unggah dulu file audio referensi ke Storage." },
      { status: 400 },
    );
  }
  if (!prompt_text) {
    return NextResponse.json(
      {
        error:
          "Teks prompt wajib diisi — kalimat persis yang diucapkan di audio referensi (WAJIB untuk cloning VoxCPM2).",
      },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from("voices")
    .insert({ name, ref_path, prompt_text })
    .select("id, name, ref_path, prompt_text, created_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ voice: data }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const supabase = getServiceClient();
  if (!supabase) return serviceUnavailable();

  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { error: "Parameter ?id= wajib diisi." },
      { status: 400 },
    );
  }

  const { data: voice, error: fetchError } = await supabase
    .from("voices")
    .select("id, ref_path")
    .eq("id", id)
    .maybeSingle();
  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }
  if (!voice) {
    return NextResponse.json({ error: "Suara tidak ditemukan." }, { status: 404 });
  }

  // Kumpulkan path output job-job suara ini dulu — setelah row suara
  // dihapus, job ikut terhapus (cascade) dan path-nya tak terlacak.
  const { data: voiceJobs } = await supabase
    .from("jobs")
    .select("output_path")
    .eq("voice_id", id);
  const outputPaths = (voiceJobs ?? [])
    .map((j) => j.output_path as string | null)
    .filter((p): p is string => Boolean(p));

  // Hapus row suara (job ikut terhapus via FK cascade).
  const { error } = await supabase.from("voices").delete().eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Hapus file di Storage — best-effort: kegagalan di sini tidak
  // membatalkan hapus row yang sudah berhasil.
  if (voice.ref_path) {
    await supabase.storage.from("voice-refs").remove([voice.ref_path]);
  }
  if (outputPaths.length > 0) {
    await supabase.storage.from("vo-outputs").remove(outputPaths);
  }

  return NextResponse.json({ ok: true });
}
