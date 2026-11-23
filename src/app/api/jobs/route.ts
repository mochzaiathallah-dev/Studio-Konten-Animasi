import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

/**
 * API Jobs VO.
 *
 * GET    /api/jobs        — daftar semua job (terbaru dulu, + nama suara).
 * GET    /api/jobs?fields=light — mode ringan untuk polling status:
 *   hanya id, status, output_path, error (tanpa teks/nama suara).
 * POST   /api/jobs        — buat job baru. Body JSON:
 *   { voice_id: string, text: string }
 *   Validasi: voice_id harus ada di tabel voices; teks tidak kosong,
 *   maksimal 2000 karakter. Status awal: queued (worker yang memproses).
 * DELETE /api/jobs?id=…  — hapus job + file output di Storage bila ada.
 *
 * Catatan Next.js 16 (cacheComponents aktif): route handler yang memakai
 * `request` sudah dinamis secara default — tanpa `dynamic = 'force-dynamic'`
 * dan tanpa `runtime` segment config.
 */

const MAX_TEXT_LENGTH = 2000;

function serviceUnavailable() {
  return NextResponse.json(
    {
      error:
        "Supabase belum terhubung — isi NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, dan SUPABASE_SERVICE_ROLE_KEY di .env.local",
    },
    { status: 503 },
  );
}

export async function GET(req: NextRequest) {
  const supabase = getServiceClient();
  if (!supabase) return serviceUnavailable();

  // Mode ringan untuk polling status (hemat kuota free plan):
  // GET /api/jobs?fields=light hanya mengambil id, status, output_path,
  // dan error — tanpa teks dan nama suara. Dipakai interval polling
  // halaman utama saat ada job aktif.
  if (req.nextUrl.searchParams.get("fields") === "light") {
    const { data, error } = await supabase
      .from("jobs")
      .select("id, status, output_path, error")
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ jobs: data ?? [] });
  }

  const { data, error } = await supabase
    .from("jobs")
    .select("id, voice_id, text, status, output_path, error, created_at, voices(name)")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ jobs: data ?? [] });
}

export async function POST(req: NextRequest) {
  const supabase = getServiceClient();
  if (!supabase) return serviceUnavailable();

  let body: { voice_id?: unknown; text?: unknown };
  try {
    body = (await req.json()) as { voice_id?: unknown; text?: unknown };
  } catch {
    return NextResponse.json({ error: "Body harus JSON yang valid." }, { status: 400 });
  }

  const voice_id = typeof body.voice_id === "string" ? body.voice_id.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";

  if (!voice_id) {
    return NextResponse.json({ error: "Pilih dulu suara referensi." }, { status: 400 });
  }
  if (!text) {
    return NextResponse.json({ error: "Teks VO tidak boleh kosong." }, { status: 400 });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json(
      { error: `Teks VO maksimal ${MAX_TEXT_LENGTH} karakter.` },
      { status: 400 },
    );
  }

  // Pastikan voice_id benar-benar ada (FK di DB juga menjaganya).
  const { data: voice, error: voiceError } = await supabase
    .from("voices")
    .select("id")
    .eq("id", voice_id)
    .maybeSingle();
  if (voiceError) {
    return NextResponse.json({ error: voiceError.message }, { status: 500 });
  }
  if (!voice) {
    return NextResponse.json(
      { error: "Suara referensi tidak ditemukan." },
      { status: 404 },
    );
  }

  const { data, error } = await supabase
    .from("jobs")
    .insert({ voice_id, text, status: "queued" })
    .select("id, voice_id, text, status, output_path, error, created_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ job: data }, { status: 201 });
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

  const { data: job, error: fetchError } = await supabase
    .from("jobs")
    .select("id, output_path")
    .eq("id", id)
    .maybeSingle();
  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }
  if (!job) {
    return NextResponse.json({ error: "Job tidak ditemukan." }, { status: 404 });
  }

  // Hapus file hasil di Storage bila ada (abaikan error hapus file —
  // yang penting row job terhapus).
  if (job.output_path) {
    await supabase.storage.from("vo-outputs").remove([job.output_path]);
  }

  const { error } = await supabase.from("jobs").delete().eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
