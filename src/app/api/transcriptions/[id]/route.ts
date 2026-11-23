import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

/**
 * DELETE /api/transcriptions/<id> — hapus transkripsi + file audio
 * di bucket `transcript-audio` bila ada.
 *
 * Catatan Next.js 16: `params` pada route handler adalah Promise —
 * wajib di-await sebelum dipakai (lihat docs route handler).
 */

function serviceUnavailable() {
  return NextResponse.json(
    {
      error:
        "Supabase belum terhubung — isi NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, dan SUPABASE_SERVICE_ROLE_KEY di .env.local",
    },
    { status: 503 },
  );
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = getServiceClient();
  if (!supabase) return serviceUnavailable();

  const { id } = await params;
  if (!id) {
    return NextResponse.json(
      { error: "Parameter id wajib diisi." },
      { status: 400 },
    );
  }

  const { data: tr, error: fetchError } = await supabase
    .from("transcriptions")
    .select("id, audio_path")
    .eq("id", id)
    .maybeSingle();
  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }
  if (!tr) {
    return NextResponse.json({ error: "Transkripsi tidak ditemukan." }, { status: 404 });
  }

  // Hapus file audio di Storage bila ada (abaikan error hapus file —
  // yang penting row transkripsi terhapus).
  if (tr.audio_path) {
    await supabase.storage.from("transcript-audio").remove([tr.audio_path]);
  }

  const { error } = await supabase.from("transcriptions").delete().eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
