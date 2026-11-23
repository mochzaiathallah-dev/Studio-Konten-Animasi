import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

/**
 * POST /api/story — Cerita ala bang-story (HANYA naskahnya).
 *
 * Body JSON:
 *   { idea: string, durationTarget: string, voiceId: string, language?: string }
 *   durationTarget: "30 dtk" | "1 mnt" | "3 mnt" | "5 mnt" | "10 mnt"
 *   language: kode bahasa naskah, default "id" (Indonesia).
 *
 * Alur:
 *   1. Validasi ide + suara referensi ada.
 *   2. OpenAI (gpt-4o-mini, response JSON) menulis naskah cerita
 *      berbahasa yang diminta, dipecah jadi adegan-adegan
 *      (3–8 adegan sesuai durasi target), tiap adegan
 *      { title, narration } — narration = teks VO per adegan
 *      (1–3 kalimat, natural, tanpa tag ekspresi aneh).
 *   3. Naskah disimpan ke tabel `stories` (kolom script, jsonb).
 *   4. TIAP adegan dibuatkan 1 job VO di tabel `jobs`
 *      (voice_id sama, text = narration, status queued) — worker
 *      VoxCPM2 yang memprosesnya seperti job biasa.
 *   5. Kembalikan { storyId, scenes: [{ title, narration, jobId }] }.
 *
 * OpenAI dipakai HANYA untuk menulis naskah; suara tetap VoxCPM2
 * (kloning suara referensi). Key OpenAI HANYA di server (env
 * OPENAI_API_KEY) — tidak pernah dikirim ke frontend.
 *
 * Catatan Next.js 16 (cacheComponents aktif): route handler yang memakai
 * `request` sudah dinamis secara default — tanpa `dynamic =
 * 'force-dynamic'` dan tanpa `runtime` segment config.
 */

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = "gpt-4o-mini";

// Durasi target → jumlah adegan (durasi VO akhir mengikuti panjang
// narasi yang dihasilkan, bukan angka ini secara kaku).
const SCENE_COUNT: Record<string, number> = {
  "30 dtk": 3,
  "1 mnt": 4,
  "3 mnt": 5,
  "5 mnt": 6,
  "10 mnt": 8,
};

const VALID_DURATIONS = Object.keys(SCENE_COUNT);

type Scene = { title: string; narration: string };

function serviceUnavailable() {
  return NextResponse.json(
    {
      error:
        "Supabase belum terhubung — isi NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, dan SUPABASE_SERVICE_ROLE_KEY di .env.local",
    },
    { status: 503 },
  );
}

export async function POST(req: NextRequest) {
  const supabase = getServiceClient();
  if (!supabase) return serviceUnavailable();

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return NextResponse.json(
      {
        error:
          "OPENAI_API_KEY belum diisi — isi di .env.local (lokal) atau Environment Variables Vercel. Key didapat di platform.openai.com → API keys. Key ini dipakai HANYA untuk menulis naskah; suara tetap VoxCPM2.",
      },
      { status: 503 },
    );
  }

  let body: {
    idea?: unknown;
    durationTarget?: unknown;
    voiceId?: unknown;
    language?: unknown;
  };
  try {
    body = (await req.json()) as {
      idea?: unknown;
      durationTarget?: unknown;
      voiceId?: unknown;
      language?: unknown;
    };
  } catch {
    return NextResponse.json({ error: "Body harus JSON yang valid." }, { status: 400 });
  }

  const idea = typeof body.idea === "string" ? body.idea.trim() : "";
  const durationTarget =
    typeof body.durationTarget === "string" && VALID_DURATIONS.includes(body.durationTarget)
      ? body.durationTarget
      : "1 mnt";
  const voiceId = typeof body.voiceId === "string" ? body.voiceId.trim() : "";
  const language =
    typeof body.language === "string" && body.language.trim()
      ? body.language.trim()
      : "id";

  if (!idea) {
    return NextResponse.json({ error: "Ide cerita tidak boleh kosong." }, { status: 400 });
  }
  if (idea.length > 1000) {
    return NextResponse.json(
      { error: "Ide cerita maksimal 1000 karakter." },
      { status: 400 },
    );
  }
  if (!voiceId) {
    return NextResponse.json({ error: "Pilih dulu suara referensi." }, { status: 400 });
  }

  // Pastikan voiceId benar-benar ada (FK di DB juga menjaganya).
  const { data: voice, error: voiceError } = await supabase
    .from("voices")
    .select("id")
    .eq("id", voiceId)
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

  const sceneCount = SCENE_COUNT[durationTarget];
  const languageName = language === "id" ? "Bahasa Indonesia" : language;

  const systemPrompt =
    "Kamu adalah penulis naskah cerita berbahasa Indonesia yang natural, " +
    "hidup, dan enak dibacakan sebagai voice-over. Tulis naskah yang mengalir " +
    "seperti dongeng/cerita, bukan seperti daftar poin atau teks AI yang kaku.";
  const userPrompt =
    `Tulis naskah cerita dalam ${languageName} dari ide berikut:\n\n"${idea}"\n\n` +
    `Target durasi cerita: ${durationTarget}. Pecah naskah menjadi TEPAT ${sceneCount} adegan. ` +
    `Setiap adegan berisi:\n` +
    `- "title": judul adegan yang singkat dan menarik (maks 8 kata).\n` +
    `- "narration": teks voice-over adegan itu, 1–3 kalimat, natural dan enak dibacakan, ` +
    `tanpa tag ekspresi aneh (tanpa [tertawa], *efek*, atau sejenisnya).\n\n` +
    `Balas HANYA dengan JSON valid, tanpa teks lain:\n` +
    `{"scenes": [{"title": "...", "narration": "..."}]}`;

  let scenes: Scene[];
  try {
    const openaiRes = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.8,
      }),
    });

    if (!openaiRes.ok) {
      let detail = "";
      try {
        const errJson = (await openaiRes.json()) as {
          error?: { message?: string };
        };
        detail = errJson.error?.message ?? "";
      } catch {
        // Abaikan — pakai pesan generik di bawah.
      }
      return NextResponse.json(
        {
          error: `OpenAI menolak permintaan (${openaiRes.status})${detail ? `: ${detail}` : ""} — periksa OPENAI_API_KEY dan saldo akun OpenAI Anda.`,
        },
        { status: 502 },
      );
    }

    const openaiData = (await openaiRes.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = openaiData.choices?.[0]?.message?.content ?? "";
    if (!content) {
      return NextResponse.json(
        { error: "OpenAI mengembalikan jawaban kosong — coba lagi." },
        { status: 502 },
      );
    }

    let parsed: { scenes?: unknown };
    try {
      parsed = JSON.parse(content) as { scenes?: unknown };
    } catch {
      return NextResponse.json(
        { error: "OpenAI mengembalikan jawaban yang bukan JSON — coba lagi." },
        { status: 502 },
      );
    }

    if (!Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
      return NextResponse.json(
        { error: "OpenAI tidak mengembalikan adegan apa pun — coba lagi." },
        { status: 502 },
      );
    }

    scenes = parsed.scenes
      .filter(
        (s): s is { title?: unknown; narration?: unknown } =>
          typeof s === "object" && s !== null,
      )
      .map((s) => ({
        title: typeof s.title === "string" ? s.title.trim() : "",
        narration: typeof s.narration === "string" ? s.narration.trim() : "",
      }))
      .filter((s) => s.title && s.narration)
      .slice(0, 8);

    if (scenes.length === 0) {
      return NextResponse.json(
        { error: "Adegan dari OpenAI kosong atau tidak valid — coba lagi." },
        { status: 502 },
      );
    }
  } catch (err) {
    return NextResponse.json(
      {
        error: `Gagal menghubungi OpenAI: ${err instanceof Error ? err.message : "kesalahan jaringan"}`,
      },
      { status: 502 },
    );
  }

  // Simpan cerita + naskahnya.
  const { data: story, error: storyError } = await supabase
    .from("stories")
    .insert({
      idea,
      duration_target: durationTarget,
      language,
      script: scenes,
    })
    .select("id")
    .single();

  if (storyError || !story) {
    return NextResponse.json(
      { error: storyError?.message ?? "Gagal menyimpan cerita." },
      { status: 500 },
    );
  }

  // Satu job VO per adegan — worker memprosesnya seperti job biasa.
  const jobsToInsert = scenes.map((s) => ({
    voice_id: voiceId,
    text: s.narration,
    status: "queued",
  }));
  const { data: jobs, error: jobsError } = await supabase
    .from("jobs")
    .insert(jobsToInsert)
    .select("id");

  if (jobsError || !jobs || jobs.length !== scenes.length) {
    return NextResponse.json(
      {
        error: `Naskah tersimpan, tapi job VO gagal dibuat: ${jobsError?.message ?? "jumlah job tidak sesuai"}. Coba buat VO per adegan secara manual di bagian 2.`,
        storyId: story.id,
      },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      storyId: story.id,
      scenes: scenes.map((s, i) => ({
        title: s.title,
        narration: s.narration,
        jobId: (jobs[i] as { id: string }).id,
      })),
    },
    { status: 201 },
  );
}
