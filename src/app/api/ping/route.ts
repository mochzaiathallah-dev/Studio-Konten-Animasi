import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

/**
 * GET /api/ping — keep-alive Supabase free plan.
 *
 * Query paling ringan yang mungkin: satu row id dari tabel voices.
 * Dipanggil 1×/hari oleh cron Vercel (vercel.json) supaya project
 * Supabase tidak pause (free plan pause setelah 7 hari tanpa
 * aktivitas). 1 ping/hari ≈ 30 request/bulan — bisa diabaikan
 * terhadap batas free plan (egress 5 GB/bln, 50.000 MAU).
 *
 * Catatan Next.js 16 (cacheComponents aktif): route handler yang
 * memakai `request` sudah dinamis secara default — tanpa
 * `dynamic = 'force-dynamic'` dan tanpa `runtime` segment config.
 */

export async function GET() {
  const supabase = getServiceClient();
  if (!supabase) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Supabase belum terhubung — isi NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, dan SUPABASE_SERVICE_ROLE_KEY di .env.local",
      },
      { status: 503 },
    );
  }

  const { error } = await supabase.from("voices").select("id").limit(1);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
