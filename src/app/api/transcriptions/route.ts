import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

/**
 * API Transkripsi Whisper.
 *
 * GET    /api/transcriptions — daftar semua transkripsi (terbaru dulu).
 * GET    /api/transcriptions?fields=light — mode ringan untuk polling
 *   status: hanya id, status, text, segments, error (tanpa audio_path).
 * POST   /api/transcriptions — buat job transkrip baru. Body JSON:
 *   { audio_path: string, audio_name?: string, language?: "id" | "en" | "auto" }
 *   File audio TIDAK diunggah lewat sini — browser mengunggah langsung
 *   ke Storage (bucket transcript-audio) dengan anon key, lalu mengirim
 *   path-nya ke endpoint ini. Status awal: queued (worker di box yang
 *   mentranskrip dengan faster-whisper model "small").
 * DELETE — lihat src/app/api/transcriptions/[id]/route.ts
 *   (DELETE /api/transcriptions/<id>), yang menghapus transkripsi
 *   + file audio di Storage bila ada.
 *
 * Catatan Next.js 16 (cacheComponents aktif): route handler yang memakai
 * `request` sudah dinamis secara default — tanpa `dynamic = 'force-dynamic'`
 * dan tanpa `runtime` segment config.
 */

const SUPPORTED_LANGUAGES = ["id", "en", "auto"] as const;

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
  // GET /api/transcriptions?fields=light hanya mengambil id, status,
  // text, segments, dan error — tanpa audio_path. Dipakai interval
  // polling halaman utama saat ada transkripsi aktif.
  if (req.nextUrl.searchParams.get("fields") === "light") {
    const { data, error } = await supabase
      .from("transcriptions")
      .select("id, status, text, segments, error")
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ transcriptions: data ?? [] });
  }

  const { data, error } = await supabase
    .from("transcriptions")
    .select(
      "id, audio_path, audio_name, model, language, status, text, segments, error, created_at",
    )
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ transcriptions: data ?? [] });
}

export async function POST(req: NextRequest) {
  const supabase = getServiceClient();
  if (!supabase) return serviceUnavailable();

  let body: { audio_path?: unknown; audio_name?: unknown; language?: unknown };
  try {
    body = (await req.json()) as {
      audio_path?: unknown;
      audio_name?: unknown;
      language?: unknown;
    };
  } catch {
    return NextResponse.json({ error: "Body harus JSON yang valid." }, { status: 400 });
  }

  const audio_path = typeof body.audio_path === "string" ? body.audio_path.trim() : "";
  const audio_name =
    typeof body.audio_name === "string" ? body.audio_name.trim() : null;
  const language =
    typeof body.language === "string" && body.language.trim()
      ? body.language.trim()
      : "id";

  if (!audio_path) {
    return NextResponse.json(
      { error: "audio_path wajib diisi — unggah dulu file audio ke Storage." },
      { status: 400 },
    );
  }
  if (!(SUPPORTED_LANGUAGES as readonly string[]).includes(language)) {
    return NextResponse.json(
      { error: "Bahasa tidak didukung — pilih Indonesia, Inggris, atau Otomatis." },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from("transcriptions")
    .insert({ audio_path, audio_name, language, status: "queued" })
    .select(
      "id, audio_path, audio_name, model, language, status, text, segments, error, created_at",
    )
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ transcription: data }, { status: 201 });
}
