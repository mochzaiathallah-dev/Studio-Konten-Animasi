"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getBrowserClient,
  isSupabaseConfigured,
  publicOutputUrl,
  type Job,
  type Transcription,
  type TranscriptionSegment,
  type Voice,
} from "@/lib/supabase";
import { PADI_LOGO_HEADER } from "@/lib/padi-logo";

const MAX_TEXT_LENGTH = 2000;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB
const STORY_DURATIONS = ["30 dtk", "1 mnt", "3 mnt", "5 mnt", "10 mnt"];

/* ------------------------------------------------------------------ */
/* Tema (Sistem / Gelap / Terang) — pilihan disimpan di localStorage  */
/* key "vo-studio-theme". Nilai "system" mengikuti preferensi OS.      */
/* ------------------------------------------------------------------ */
type ThemeMode = "system" | "dark" | "light";
const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "Sistem" },
  { value: "dark", label: "Gelap" },
  { value: "light", label: "Terang" },
];

/* ------------------------------------------------------------------ */
/* Mode studio — meniru tab Voice Clone / Voice Design di referensi   */
/* OmniVoice (aplikasi desktop). Cerita = fitur bang-story yang sudah */
/* ada; Transkrip = fitur Whisper (transkripsi audio → teks + segmen). */
/* Mode HANYA mengubah kontrol di panel kiri; semua alur simpan ke DB, */
/* antrean job, dan worker tetap sama.                                */
/* ------------------------------------------------------------------ */
type StudioMode = "clone" | "design" | "story" | "transcript";

/* Bahasa transkripsi Whisper: Indonesia (default) atau deteksi otomatis. */
const TRANSCRIPT_LANGUAGES: { value: string; label: string }[] = [
  { value: "id", label: "Indonesia" },
  { value: "auto", label: "Otomatis (deteksi bahasa)" },
];

/* Atribut Voice Design (panel kanan referensi OmniVoice). Nilainya   */
/* dirangkai menjadi SATU instruksi gaya berbahasa Inggris di depan   */
/* teks VO — pola "controllable cloning" VoxCPM2 yang resmi:           */
/*   generate(text="(...)teks", prompt_wav_path=..., ...)              */
/* Worker TIDAK diubah: ia meneruskan job.text apa adanya ke model,   */
/* jadi prefix ini sampai ke VoxCPM tanpa perubahan kode worker/API.   */
const DESIGN_GENDERS = [
  { value: "male", label: "Pria" },
  { value: "female", label: "Wanita" },
] as const;
const DESIGN_AGES = [
  { value: "child", label: "Anak" },
  { value: "teenage", label: "Remaja" },
  { value: "young adult", label: "Dewasa muda" },
  { value: "adult", label: "Dewasa" },
  { value: "middle-aged", label: "Paruh baya" },
  { value: "elderly", label: "Lansia" },
] as const;
const DESIGN_PITCHES = [
  { value: "low pitch", label: "Rendah" },
  { value: "moderate pitch", label: "Sedang" },
  { value: "high pitch", label: "Tinggi" },
] as const;
const DESIGN_STYLES = [
  { value: "natural tone", label: "Auto (Normal)" },
  { value: "warm and friendly tone", label: "Hangat & Ramah" },
  { value: "firm and formal tone", label: "Tegas & Formal" },
  { value: "cheerful tone", label: "Ceria" },
  { value: "relaxed and casual tone", label: "Santai" },
  { value: "authoritative tone", label: "Berwibawa" },
  { value: "dramatic tone", label: "Dramatis" },
] as const;
const DESIGN_DIALECTS = [
  { value: "standard Indonesian accent", label: "Auto (Standar Baku / Bahasa Indonesia Resmi)" },
  { value: "Javanese Indonesian accent", label: "Jawa" },
  { value: "Sundanese Indonesian accent", label: "Sunda" },
  { value: "Betawi Indonesian accent", label: "Betawi" },
  { value: "Medan Indonesian accent", label: "Medan" },
  { value: "Makassar Indonesian accent", label: "Makassar" },
  { value: "Balinese Indonesian accent", label: "Bali" },
  { value: "Minangkabau Indonesian accent", label: "Minang" },
  { value: "Banjar Indonesian accent", label: "Banjar" },
  { value: "Malay Indonesian accent", label: "Melayu" },
] as const;

const STATUS_LABEL: Record<Job["status"], string> = {
  queued: "Antre",
  processing: "Diproses",
  done: "Selesai",
  failed: "Gagal",
};

const STATUS_BADGE: Record<Job["status"], string> = {
  queued: "badge badge-queued",
  processing: "badge badge-processing",
  done: "badge badge-done",
  failed: "badge badge-failed",
};

/* Tinggi batang waveform dekoratif (panel hasil, ala OmniVoice). */
const WAVE_BARS = [
  12, 22, 30, 18, 36, 26, 14, 32, 24, 38, 20, 28, 16, 34, 22, 30, 14,
  26, 36, 18, 28, 12, 24, 32, 20, 16, 28, 22,
];

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("id-ID", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/* Detik → "HH:MM:SS,mmm" (format timestamp SRT). */
function formatSrtTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalS = Math.floor(totalMs / 1000);
  const s = totalS % 60;
  const m = Math.floor(totalS / 60) % 60;
  const h = Math.floor(totalS / 3600);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/* Segmen Whisper → isi file .srt (dibuat client-side). */
function buildSrt(segments: TranscriptionSegment[]): string {
  return segments
    .map(
      (seg, i) =>
        `${i + 1}\n${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n${seg.text.trim()}\n`,
    )
    .join("\n");
}

/* Unduh teks sebagai file (tanpa request server). */
function downloadTextFile(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function Home() {
  const configured = isSupabaseConfigured();

  /* ---------- Tema ---------- */
  /* Inisialisasi malas dari localStorage (tanpa effect — supaya tidak
     ada render berantai; saat SSR, window belum ada → "system"). */
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "system";
    try {
      const saved = localStorage.getItem("vo-studio-theme");
      if (saved === "dark" || saved === "light" || saved === "system") {
        return saved;
      }
    } catch {
      // localStorage tidak tersedia — biarkan script pra-paint + CSS.
    }
    return "system";
  });
  useEffect(() => {
    const apply = () => {
      const dark =
        themeMode === "dark" ||
        (themeMode === "system" &&
          window.matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    };
    apply();
    try {
      localStorage.setItem("vo-studio-theme", themeMode);
    } catch {
      // Abaikan — tema tetap jalan untuk sesi ini.
    }
    if (themeMode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [themeMode]);

  /* ---------- Data (CRUD Supabase — tidak berubah) ---------- */
  const [voices, setVoices] = useState<Voice[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string>("");

  // Form suara referensi
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [voiceName, setVoiceName] = useState("");
  const [promptText, setPromptText] = useState("");
  const [savingVoice, setSavingVoice] = useState(false);
  const [deletingVoiceId, setDeletingVoiceId] = useState<string | null>(null);

  // Studio: mode + teks VO (dipakai bersama Clone & Design)
  const [mode, setMode] = useState<StudioMode>("clone");
  const [voText, setVoText] = useState("");
  const [creatingJob, setCreatingJob] = useState(false);

  // Atribut Voice Design
  const [designGender, setDesignGender] = useState<string>("male");
  const [designAge, setDesignAge] = useState<string>("young adult");
  const [designPitch, setDesignPitch] = useState<string>("moderate pitch");
  const [designStyle, setDesignStyle] = useState<string>("natural tone");
  const [designDialect, setDesignDialect] = useState<string>(
    "standard Indonesian accent",
  );
  const [designSpeed, setDesignSpeed] = useState<number>(1);

  // Form cerita (ala bang-story — hanya naskahnya)
  const [storyIdea, setStoryIdea] = useState("");
  const [storyDuration, setStoryDuration] = useState("1 mnt");
  const [creatingStory, setCreatingStory] = useState(false);
  const [storyResult, setStoryResult] = useState<{
    storyId: string;
    idea?: string;
    createdAt?: string;
    scenes: { title: string; narration: string; jobId: string }[];
  } | null>(null);
  // Membedakan "masih memuat" dari "memang kosong": selama fetch awal
  // belum selesai, daftar menampilkan "Memuat…" — bukan "Belum ada…"
  // (di halaman baru, daftar sempat tampil 0 sebelum fetch selesai).
  const [loadingVoices, setLoadingVoices] = useState(configured);
  const [loadingJobs, setLoadingJobs] = useState(configured);

  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Transkrip (Whisper) — audio → teks + segmen ber-timestamp
  const [transcriptions, setTranscriptions] = useState<Transcription[]>([]);
  const [loadingTranscriptions, setLoadingTranscriptions] = useState(configured);
  const [transcriptFile, setTranscriptFile] = useState<File | null>(null);
  const [transcriptLanguage, setTranscriptLanguage] = useState("id");
  const [creatingTranscription, setCreatingTranscription] = useState(false);
  const [deletingTranscriptionId, setDeletingTranscriptionId] = useState<string | null>(null);
  const [expandedTranscriptionId, setExpandedTranscriptionId] = useState<string | null>(null);
  const [copiedTranscriptionId, setCopiedTranscriptionId] = useState<string | null>(null);
  const transcriptFileInputRef = useRef<HTMLInputElement>(null);

  /* Instruksi gaya Voice Design — dirangkai dari atribut di atas. */
  const designPrefix = useMemo(() => {
    const genderLabel = designGender === "female" ? "female" : "male";
    const article =
      designAge === "elderly" || designAge === "adult" ? "An" : "A";
    const parts: string[] = [designPitch, designStyle, designDialect];
    if (designSpeed < 0.95) parts.push("slower pace");
    if (designSpeed > 1.1) parts.push("slightly faster pace");
    return `(${article} ${designAge} ${genderLabel} voice, ${parts.join(", ")})`;
  }, [designGender, designAge, designPitch, designStyle, designDialect, designSpeed]);

  const loadVoices = useCallback(async () => {
    try {
      const res = await fetch("/api/voices");
      const data = (await res.json()) as { voices?: Voice[]; error?: string };
      if (res.ok) {
        setVoices(data.voices ?? []);
        // Pilih otomatis suara terbaru bila belum ada yang dipilih —
        // setelah reload, Generate langsung bisa dipakai tanpa klik
        // "Pakai suara ini" dulu.
        setSelectedVoiceId((prev) => prev || data.voices?.[0]?.id || prev);
      }
    } catch {
      // Biarkan daftar kosong; banner koneksi sudah menjelaskan.
    } finally {
      setLoadingVoices(false);
    }
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs");
      const data = (await res.json()) as { jobs?: Job[]; error?: string };
      if (res.ok) setJobs(data.jobs ?? []);
    } catch {
      // Biarkan daftar kosong.
    } finally {
      setLoadingJobs(false);
    }
  }, []);

  // Muat naskah cerita TERAKHIR dari database (tabel stories) — naskah
  // sebelumnya hanya hidup di state sesi, jadi hilang setelah reload
  // padahal sudah tersimpan. Job per adegan dicocokkan lewat teks
  // narasi (job cerita punya text == narration adegan).
  const loadLatestStory = useCallback(async () => {
    try {
      const res = await fetch("/api/story?limit=1");
      const data = (await res.json()) as {
        stories?: {
          id: string;
          idea: string;
          duration_target: string;
          script: { title: string; narration: string }[];
          created_at: string;
        }[];
        error?: string;
      };
      if (!res.ok) return;
      const latest = data.stories?.[0];
      if (!latest || !Array.isArray(latest.script)) return;
      const scenes = latest.script
        .filter(
          (s) =>
            s && typeof s.title === "string" && typeof s.narration === "string",
        )
        .map((s) => ({ title: s.title, narration: s.narration, jobId: "" }));
      if (scenes.length === 0) return;
      // Jangan timpa naskah yang baru saja dibuat di sesi ini.
      setStoryResult((prev) =>
        prev
          ? prev
          : {
              storyId: latest.id,
              idea: latest.idea,
              createdAt: latest.created_at,
              scenes,
            },
      );
    } catch {
      // Abaikan — naskah sesi ini tetap tampil bila ada.
    }
  }, []);

  // Poll RINGAN status job (hemat kuota free plan): hanya saat ada job
  // aktif, tiap 3 detik, dan hanya mengambil id/status/output_path/error
  // (GET /api/jobs?fields=light). Berhenti otomatis bila semua job
  // sudah done/failed — dan tidak polling sama sekali bila tidak ada
  // job aktif.
  const loadJobStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs?fields=light");
      const data = (await res.json()) as {
        jobs?: Pick<Job, "id" | "status" | "output_path" | "error">[];
        error?: string;
      };
      if (!res.ok) return;
      const updates = new Map((data.jobs ?? []).map((j) => [j.id, j]));
      setJobs((prev) =>
        prev.map((j) => {
          const u = updates.get(j.id);
          return u
            ? { ...j, status: u.status, output_path: u.output_path, error: u.error }
            : j;
        }),
      );
    } catch {
      // Abaikan — poll berikutnya mencoba lagi.
    }
  }, []);

  const loadTranscriptions = useCallback(async () => {
    try {
      const res = await fetch("/api/transcriptions");
      const data = (await res.json()) as {
        transcriptions?: Transcription[];
        error?: string;
      };
      if (res.ok) setTranscriptions(data.transcriptions ?? []);
    } catch {
      // Biarkan daftar kosong.
    } finally {
      setLoadingTranscriptions(false);
    }
  }, []);

  // Poll RINGAN status transkripsi (pola sama seperti job VO): hanya
  // saat ada transkripsi aktif, tiap 3 detik. Mode light membawa
  // text + segments supaya teks langsung tampil begitu status done,
  // tanpa memuat ulang daftar penuh.
  const loadTranscriptionStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/transcriptions?fields=light");
      const data = (await res.json()) as {
        transcriptions?: Pick<
          Transcription,
          "id" | "status" | "text" | "segments" | "error"
        >[];
        error?: string;
      };
      if (!res.ok) return;
      const updates = new Map((data.transcriptions ?? []).map((t) => [t.id, t]));
      setTranscriptions((prev) =>
        prev.map((t) => {
          const u = updates.get(t.id);
          return u
            ? { ...t, status: u.status, text: u.text, segments: u.segments, error: u.error }
            : t;
        }),
      );
    } catch {
      // Abaikan — poll berikutnya mencoba lagi.
    }
  }, []);

  useEffect(() => {
    if (!configured) return;
    // Muat data awal setelah mount — di callback microtask, bukan
    // setState sinkron di badan effect (aturan
    // react-hooks/set-state-in-effect).
    void Promise.resolve().then(() => {
      loadVoices();
      loadJobs();
      loadLatestStory();
      loadTranscriptions();
    });
  }, [configured, loadVoices, loadJobs, loadLatestStory, loadTranscriptions]);

  // Adegan cerita + jobId-nya (dicocokkan dari daftar job lewat teks
  // narasi — job cerita punya text == narration adegan). Dihitung
  // saat render, bukan disimpan di state, supaya tidak ada efek yang
  // menulis state (aturan react-hooks/set-state-in-effect).
  const storyScenes = useMemo(() => {
    if (!storyResult) return [];
    return storyResult.scenes.map((s) => ({
      ...s,
      jobId: s.jobId || jobs.find((j) => j.text === s.narration)?.id || "",
    }));
  }, [storyResult, jobs]);

  // Poll status job tiap 3 detik selama ada job yang masih antre/diproses.
  const hasActiveJob = jobs.some((j) => j.status === "queued" || j.status === "processing");
  const hasProcessingJob = jobs.some((j) => j.status === "processing");
  useEffect(() => {
    if (!configured || !hasActiveJob) return;
    const t = setInterval(loadJobStatus, 3000);
    return () => clearInterval(t);
  }, [configured, hasActiveJob, loadJobStatus]);

  // Poll status transkripsi tiap 3 detik selama ada yang masih
  // antre/diproses (pola sama seperti job VO).
  const hasActiveTranscription = transcriptions.some(
    (t) => t.status === "queued" || t.status === "processing",
  );
  const hasProcessingTranscription = transcriptions.some(
    (t) => t.status === "processing",
  );
  useEffect(() => {
    if (!configured || !hasActiveTranscription) return;
    const t = setInterval(loadTranscriptionStatus, 3000);
    return () => clearInterval(t);
  }, [configured, hasActiveTranscription, loadTranscriptionStatus]);

  async function handleSaveVoice(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    if (!audioFile || !voiceName.trim() || !promptText.trim()) {
      setNotice({ kind: "err", text: "Lengkapi file audio, nama suara, dan teks prompt." });
      return;
    }
    const client = getBrowserClient();
    if (!client) {
      setNotice({ kind: "err", text: "Supabase belum terhubung." });
      return;
    }
    setSavingVoice(true);
    try {
      const ext = audioFile.name.split(".").pop()?.toLowerCase() || "wav";
      const refPath = `refs/${crypto.randomUUID()}.${ext}`;
      const { error: uploadError } = await client.storage
        .from("voice-refs")
        .upload(refPath, audioFile, {
          contentType: audioFile.type || "audio/wav",
          upsert: false,
        });
      if (uploadError) throw new Error(`Gagal mengunggah audio: ${uploadError.message}`);

      const res = await fetch("/api/voices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: voiceName.trim(),
          ref_path: refPath,
          prompt_text: promptText.trim(),
        }),
      });
      const data = (await res.json()) as { voice?: Voice; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Gagal menyimpan suara.");

      setNotice({ kind: "ok", text: `Suara "${voiceName.trim()}" tersimpan di database.` });
      setAudioFile(null);
      setVoiceName("");
      setPromptText("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      setSelectedVoiceId(data.voice?.id ?? "");
      await loadVoices();
    } catch (err) {
      setNotice({
        kind: "err",
        text: err instanceof Error ? err.message : "Terjadi kesalahan.",
      });
    } finally {
      setSavingVoice(false);
    }
  }

  async function handleDeleteVoice(id: string, name: string) {
    if (
      !window.confirm(
        `Hapus suara "${name}"? Audio referensinya juga dihapus dari Storage, dan semua job VO yang memakai suara ini ikut terhapus.`,
      )
    ) {
      return;
    }
    setNotice(null);
    setDeletingVoiceId(id);
    try {
      const res = await fetch(`/api/voices?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Gagal menghapus suara.");
      if (selectedVoiceId === id) setSelectedVoiceId("");
      setNotice({ kind: "ok", text: `Suara "${name}" dihapus dari database.` });
      await loadVoices();
      await loadJobs();
    } catch (err) {
      setNotice({
        kind: "err",
        text: err instanceof Error ? err.message : "Terjadi kesalahan.",
      });
    } finally {
      setDeletingVoiceId(null);
    }
  }

  async function handleCreateJob(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    if (!selectedVoiceId) {
      setNotice({ kind: "err", text: "Pilih dulu suara referensi." });
      return;
    }
    if (!voText.trim()) {
      setNotice({ kind: "err", text: "Teks VO tidak boleh kosong." });
      return;
    }
    // Mode Design: instruksi gaya ditempel di depan teks (lihat
    // komentar di atas — worker meneruskannya apa adanya ke VoxCPM2).
    const finalText =
      mode === "design" ? `${designPrefix} ${voText.trim()}` : voText.trim();
    if (finalText.length > MAX_TEXT_LENGTH) {
      setNotice({
        kind: "err",
        text: `Teks + instruksi gaya melebihi ${MAX_TEXT_LENGTH} karakter — persingkat teks VO-nya.`,
      });
      return;
    }
    setCreatingJob(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice_id: selectedVoiceId, text: finalText }),
      });
      const data = (await res.json()) as { job?: Job; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Gagal membuat job.");
      setNotice({
        kind: "ok",
        text:
          mode === "design"
            ? "Job VO (Voice Design) dibuat dan masuk antrean. Worker akan memprosesnya — status diperbarui otomatis."
            : "Job VO dibuat dan masuk antrean. Worker akan memprosesnya — status diperbarui otomatis.",
      });
      setVoText("");
      await loadJobs();
    } catch (err) {
      setNotice({
        kind: "err",
        text: err instanceof Error ? err.message : "Terjadi kesalahan.",
      });
    } finally {
      setCreatingJob(false);
    }
  }

  async function handleCreateStory(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    if (!selectedVoiceId) {
      setNotice({ kind: "err", text: "Pilih dulu suara referensi." });
      return;
    }
    if (!storyIdea.trim()) {
      setNotice({ kind: "err", text: "Tulis dulu ide ceritanya." });
      return;
    }
    setCreatingStory(true);
    try {
      const res = await fetch("/api/story", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idea: storyIdea.trim(),
          durationTarget: storyDuration,
          voiceId: selectedVoiceId,
          language: "id",
        }),
      });
      const data = (await res.json()) as {
        storyId?: string;
        scenes?: { title: string; narration: string; jobId: string }[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Gagal membuat cerita.");
      setStoryResult({
        storyId: data.storyId ?? "",
        scenes: data.scenes ?? [],
      });
      setNotice({
        kind: "ok",
        text: `Naskah jadi — ${data.scenes?.length ?? 0} adegan. Tiap adegan sudah masuk antrean VO di bagian Hasil.`,
      });
      await loadJobs();
    } catch (err) {
      setNotice({
        kind: "err",
        text: err instanceof Error ? err.message : "Terjadi kesalahan.",
      });
    } finally {
      setCreatingStory(false);
    }
  }

  async function handleDeleteJob(id: string) {
    setDeletingJobId(id);
    try {
      const res = await fetch(`/api/jobs?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Gagal menghapus job.");
      setJobs((prev) => prev.filter((j) => j.id !== id));
    } catch (err) {
      setNotice({
        kind: "err",
        text: err instanceof Error ? err.message : "Terjadi kesalahan.",
      });
    } finally {
      setDeletingJobId(null);
    }
  }

  async function handleCreateTranscription(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    if (!transcriptFile) {
      setNotice({ kind: "err", text: "Pilih dulu file audio yang mau ditranskrip." });
      return;
    }
    const client = getBrowserClient();
    if (!client) {
      setNotice({ kind: "err", text: "Supabase belum terhubung." });
      return;
    }
    setCreatingTranscription(true);
    try {
      const ext = transcriptFile.name.split(".").pop()?.toLowerCase() || "mp3";
      const audioPath = `uploads/${crypto.randomUUID()}.${ext}`;
      const { error: uploadError } = await client.storage
        .from("transcript-audio")
        .upload(audioPath, transcriptFile, {
          contentType: transcriptFile.type || "audio/mpeg",
          upsert: false,
        });
      if (uploadError) throw new Error(`Gagal mengunggah audio: ${uploadError.message}`);

      const res = await fetch("/api/transcriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio_path: audioPath,
          audio_name: transcriptFile.name,
          language: transcriptLanguage,
        }),
      });
      const data = (await res.json()) as {
        transcription?: Transcription;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Gagal membuat transkripsi.");

      setNotice({
        kind: "ok",
        text: "Transkripsi dibuat dan masuk antrean. Worker akan mentranskripnya — status diperbarui otomatis.",
      });
      setTranscriptFile(null);
      if (transcriptFileInputRef.current) transcriptFileInputRef.current.value = "";
      await loadTranscriptions();
    } catch (err) {
      setNotice({
        kind: "err",
        text: err instanceof Error ? err.message : "Terjadi kesalahan.",
      });
    } finally {
      setCreatingTranscription(false);
    }
  }

  async function handleDeleteTranscription(id: string) {
    setDeletingTranscriptionId(id);
    try {
      const res = await fetch(`/api/transcriptions/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Gagal menghapus transkripsi.");
      setTranscriptions((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      setNotice({
        kind: "err",
        text: err instanceof Error ? err.message : "Terjadi kesalahan.",
      });
    } finally {
      setDeletingTranscriptionId(null);
    }
  }

  async function handleCopyTranscription(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback bila clipboard API diblokir (mis. konteks non-HTTPS):
      // pilih lewat textarea sementara lalu salin.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopiedTranscriptionId(id);
    window.setTimeout(() => {
      setCopiedTranscriptionId((prev) => (prev === id ? null : prev));
    }, 2000);
  }

  const wordCount = voText.trim() ? voText.trim().split(/\s+/).length : 0;
  const selectedVoice = voices.find((v) => v.id === selectedVoiceId);
  const latestJob = jobs[0] ?? null;
  const latestJobUrl = latestJob ? publicOutputUrl(latestJob.output_path) : null;
  const latestJobBusy =
    latestJob?.status === "queued" || latestJob?.status === "processing";
  /* Panjang terhitung di mode Design = prefix + spasi + teks. */
  const countedLength =
    mode === "design" ? designPrefix.length + 1 + voText.length : voText.length;

  const designSummary = (value: string, options: readonly { value: string; label: string }[]) =>
    options.find((o) => o.value === value)?.label ?? value;

  return (
    <main className="min-h-screen" style={{ background: "var(--bg)", color: "var(--text)" }}>
      <div className="mx-auto max-w-6xl px-4 py-6">
        {/* ---------- Header studio (ala OmniVoice) ---------- */}
        <header className="card mb-5 flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div className="flex items-center gap-3">
            <span
              className="inline-flex items-center rounded-lg border px-2 py-1"
              style={{ background: "#ffffff", borderColor: "var(--border)" }}
              title="PADI Tech Solutions"
            >
              {/* Data URI logo yang sudah dioptimasi; next/image tidak menambah apa-apa. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={PADI_LOGO_HEADER}
                alt="PADI Tech Solutions"
                width={72}
                height={48}
                style={{ display: "block", height: 40, width: "auto" }}
              />
            </span>
            <div>
              <h1 className="text-xl font-bold leading-tight">🎙️ VO Studio</h1>
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                Voice Clone &amp; Voice Design · Kloning suara VoxCPM2 · v1.0.0
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span
              className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium"
              style={{ borderColor: "var(--border)" }}
            >
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full"
                style={{
                  background: configured ? "#22c55e" : "#f59e0b",
                }}
              />
              {configured ? "Supabase Terhubung" : "Supabase Belum Terhubung"}
            </span>
            <div
              className="flex items-center gap-1 rounded-lg border p-1"
              style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
              role="group"
              aria-label="Pilih tema tampilan"
            >
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setThemeMode(opt.value)}
                  aria-pressed={themeMode === opt.value}
                  className={`seg-btn ${themeMode === opt.value ? "active" : ""}`}
                >
                  {opt.value === "system" ? "🖥️ " : opt.value === "dark" ? "🌙 " : "☀️ "}
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </header>

        {/* ---------- Banner status ---------- */}
        {!configured ? (
          <section className="banner-warn mb-6 rounded-lg p-5">
            <h2 className="text-lg font-semibold">Supabase belum terhubung</h2>
            <p className="mt-2 text-sm">
              Isi <code className="font-mono">NEXT_PUBLIC_SUPABASE_URL</code>,{" "}
              <code className="font-mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>, dan{" "}
              <code className="font-mono">SUPABASE_SERVICE_ROLE_KEY</code> di{" "}
              <code className="font-mono">.env.local</code> (lihat{" "}
              <code className="font-mono">.env.example</code> dan{" "}
              <code className="font-mono">README.md</code>).
            </p>
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
              <li>Buat project di Supabase, jalankan <code className="font-mono">supabase/schema.sql</code> di SQL Editor.</li>
              <li>Buat bucket <code className="font-mono">voice-refs</code> (private) dan <code className="font-mono">vo-outputs</code> (public).</li>
              <li>Salin URL + anon key + service role key ke <code className="font-mono">.env.local</code>, lalu restart dev server / redeploy.</li>
            </ol>
            <p className="mt-3 text-sm">
              Aplikasi tetap bisa dibuka, tapi form generate dinonaktifkan
              sampai Supabase terhubung.
            </p>
          </section>
        ) : (
          <section className="banner-ok mb-6 rounded-lg p-4 text-sm">
            <span className="font-semibold">✓ Sistem siap.</span>{" "}
            Supabase terhubung, semua suara / job / cerita tersimpan di
            database.{" "}
            {hasProcessingJob || hasProcessingTranscription ? (
              <span>Ada job yang sedang diproses worker — status diperbarui otomatis.</span>
            ) : hasActiveJob || hasActiveTranscription ? (
              <span>
                Ada job yang antre — menunggu worker berjalan (sintesis dan
                transkripsi bukan di Vercel).
              </span>
            ) : (
              <span>Worker memproses job saat aktif (sintesis &amp; transkripsi bukan di Vercel).</span>
            )}
          </section>
        )}

        {notice && (
          <div
            className={`mb-6 rounded-lg p-4 text-sm ${
              notice.kind === "ok" ? "notice-ok" : "notice-err"
            }`}
            role="status"
          >
            {notice.text}
          </div>
        )}

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          {/* ==================== KOLOM KIRI: kontrol ==================== */}
          <div className="min-w-0 space-y-6">
            {/* 1 — Suara Referensi */}
            <section className="card p-5">
              <h2 className="text-lg font-semibold">🎤 Suara Referensi</h2>
              <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
                Unggah audio suara Anda (mp3/wav/m4a, disarankan ≤30 detik dan
                jernih, tanpa musik). Tulis persis kalimat yang diucapkan di
                audio itu — teks ini WAJIB untuk cloning VoxCPM2.
              </p>
              <form onSubmit={handleSaveVoice} className="mt-4 space-y-4">
                <div>
                  <label className="label" htmlFor="ref-audio">File audio referensi</label>
                  <input
                    id="ref-audio"
                    ref={fileInputRef}
                    type="file"
                    accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac"
                    disabled={!configured || savingVoice}
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      if (f && f.size > MAX_AUDIO_BYTES) {
                        setNotice({
                          kind: "err",
                          text: "File audio maksimal 10 MB — potong dulu audionya.",
                        });
                        e.target.value = "";
                        return;
                      }
                      setAudioFile(f);
                    }}
                    className="input"
                  />
                  {audioFile && (
                    <p className="hint">
                      Dipilih: {audioFile.name} ({(audioFile.size / 1024).toFixed(0)} KB)
                    </p>
                  )}
                </div>
                <div>
                  <label className="label" htmlFor="voice-name">Nama suara</label>
                  <input
                    id="voice-name"
                    type="text"
                    value={voiceName}
                    maxLength={100}
                    placeholder="cth: Suara Athallah"
                    disabled={!configured || savingVoice}
                    onChange={(e) => setVoiceName(e.target.value)}
                    className="input"
                  />
                </div>
                <div>
                  <label className="label" htmlFor="prompt-text">
                    Teks prompt — kalimat persis di audio referensi
                  </label>
                  <textarea
                    id="prompt-text"
                    value={promptText}
                    rows={2}
                    placeholder="cth: Kurban bukan sekadar menyembelih hewan! Kurban adalah cara kita mendekatkan diri kepada Allah."
                    disabled={!configured || savingVoice}
                    onChange={(e) => setPromptText(e.target.value)}
                    className="textarea"
                  />
                  <p className="hint">
                    Harus sama persis dengan yang diucapkan di audio — kalau
                    beda, hasil cloning bisa meleset.
                  </p>
                </div>
                <button
                  type="submit"
                  disabled={!configured || savingVoice}
                  className="btn-primary"
                >
                  {savingVoice ? "Menyimpan…" : "💾 Simpan suara"}
                </button>
              </form>

              <div className="mt-6">
                <h3 className="text-sm font-semibold">
                  Suara tersimpan ({voices.length})
                </h3>
                {loadingVoices ? (
                  <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
                    Memuat daftar suara…
                  </p>
                ) : voices.length === 0 ? (
                  <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
                    Belum ada suara. Simpan satu suara referensi dulu.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {voices.map((v) => (
                      <li
                        key={v.id}
                        className={`flex items-start justify-between gap-3 rounded-lg border p-3 text-sm ${
                          selectedVoiceId === v.id ? "voice-item-selected" : ""
                        }`}
                        style={{ borderColor: "var(--border)" }}
                      >
                        <div className="min-w-0">
                          <p className="font-medium">{v.name}</p>
                          <p style={{ color: "var(--muted)" }}>“{v.prompt_text}”</p>
                          <p className="text-xs" style={{ color: "var(--faint)" }}>
                            {formatDate(v.created_at)}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col gap-2">
                          <button
                            type="button"
                            onClick={() => setSelectedVoiceId(v.id)}
                            className="btn-secondary"
                          >
                            {selectedVoiceId === v.id ? "✓ Dipakai" : "Pakai suara ini"}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteVoice(v.id, v.name)}
                            disabled={deletingVoiceId === v.id}
                            className="btn-danger-text disabled:opacity-50"
                          >
                            {deletingVoiceId === v.id ? "Menghapus…" : "Hapus suara"}
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            {/* 2 — Studio: Voice Clone / Voice Design / Cerita / Transkrip */}
            <section className="card p-5">
              <h2 className="text-lg font-semibold">🎛️ Studio</h2>
              <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
                {selectedVoice
                  ? `Suara dipakai: ${selectedVoice.name}`
                  : "Pilih dulu satu suara referensi di atas."}
              </p>

              <div
                className="mt-4 flex gap-1 rounded-lg border p-1"
                style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
                role="tablist"
                aria-label="Mode studio"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "clone"}
                  onClick={() => setMode("clone")}
                  className={`tab-btn ${mode === "clone" ? "active" : ""}`}
                >
                  🎙️ Voice Clone
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "design"}
                  onClick={() => setMode("design")}
                  className={`tab-btn ${mode === "design" ? "active" : ""}`}
                >
                  ✨ Voice Design
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "story"}
                  onClick={() => setMode("story")}
                  className={`tab-btn ${mode === "story" ? "active" : ""}`}
                >
                  📖 Cerita
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "transcript"}
                  onClick={() => setMode("transcript")}
                  className={`tab-btn ${mode === "transcript" ? "active" : ""}`}
                >
                  📝 Transkrip
                </button>
              </div>

              {/* --- Voice Clone --- */}
              {mode === "clone" && (
                <form onSubmit={handleCreateJob} className="mt-4 space-y-4">
                  <p className="text-sm" style={{ color: "var(--muted)" }}>
                    Kloning apa adanya: teks dibacakan dengan suara referensi
                    yang dipilih (ultimate cloning VoxCPM2 — tanpa instruksi
                    gaya tambahan).
                  </p>
                  <div>
                    <label className="label" htmlFor="vo-text-clone">Teks yang ingin diucapkan</label>
                    <textarea
                      id="vo-text-clone"
                      value={voText}
                      rows={5}
                      maxLength={MAX_TEXT_LENGTH}
                      placeholder="Tulis teks yang mau dibacakan dengan suara referensi…"
                      disabled={!configured || creatingJob}
                      onChange={(e) => setVoText(e.target.value)}
                      className="textarea"
                    />
                    <p className="hint">
                      {voText.length} / {MAX_TEXT_LENGTH} karakter · {wordCount} kata
                      {voText.length > 1500 &&
                        " · Teks panjang akan dipecah jadi beberapa potongan oleh worker."}
                    </p>
                  </div>
                  <button
                    type="submit"
                    disabled={!configured || creatingJob || !selectedVoiceId || !voText.trim()}
                    className="btn-primary w-full py-3 text-base"
                  >
                    {creatingJob ? "Membuat job…" : "⚡ Generate VO"}
                  </button>
                </form>
              )}

              {/* --- Voice Design --- */}
              {mode === "design" && (
                <form onSubmit={handleCreateJob} className="mt-4 space-y-4">
                  <p className="text-sm" style={{ color: "var(--muted)" }}>
                    Rancang karakter suara di atas suara referensi yang dipilih:
                    atribut di bawah dirangkai menjadi instruksi gaya untuk
                    VoxCPM2 (pola controllable cloning — timbre tetap dari
                    suara referensi Anda).
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="label" htmlFor="design-gender">Gender / Jenis Kelamin</label>
                      <select
                        id="design-gender"
                        value={designGender}
                        disabled={!configured || creatingJob}
                        onChange={(e) => setDesignGender(e.target.value)}
                        className="select"
                      >
                        {DESIGN_GENDERS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="label" htmlFor="design-age">Age / Usia</label>
                      <select
                        id="design-age"
                        value={designAge}
                        disabled={!configured || creatingJob}
                        onChange={(e) => setDesignAge(e.target.value)}
                        className="select"
                      >
                        {DESIGN_AGES.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="label" htmlFor="design-pitch">Pitch / Nada Suara</label>
                      <select
                        id="design-pitch"
                        value={designPitch}
                        disabled={!configured || creatingJob}
                        onChange={(e) => setDesignPitch(e.target.value)}
                        className="select"
                      >
                        {DESIGN_PITCHES.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="label" htmlFor="design-style">Style / Gaya Vokal</label>
                      <select
                        id="design-style"
                        value={designStyle}
                        disabled={!configured || creatingJob}
                        onChange={(e) => setDesignStyle(e.target.value)}
                        className="select"
                      >
                        {DESIGN_STYLES.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="sm:col-span-2">
                      <label className="label" htmlFor="design-dialect">Dialek &amp; Aksen Regional (Indonesian)</label>
                      <select
                        id="design-dialect"
                        value={designDialect}
                        disabled={!configured || creatingJob}
                        onChange={(e) => setDesignDialect(e.target.value)}
                        className="select"
                      >
                        {DESIGN_DIALECTS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                      <p className="hint">
                        Aksen adalah petunjuk gaya untuk model — hasilnya bisa
                        bervariasi, timbre suara referensi tetap dipertahankan.
                      </p>
                    </div>
                    <div className="sm:col-span-2">
                      <label className="label" htmlFor="design-speed">
                        Kecepatan Bicara — {designSpeed.toFixed(2)}x
                      </label>
                      <input
                        id="design-speed"
                        type="range"
                        min={0.8}
                        max={1.25}
                        step={0.05}
                        value={designSpeed}
                        disabled={!configured || creatingJob}
                        onChange={(e) => setDesignSpeed(Number(e.target.value))}
                        className="w-full"
                        style={{ accentColor: "var(--accent)" }}
                      />
                      <p className="hint">
                        0,80x lambat · 1,00x normal · 1,25x sedikit cepat.
                      </p>
                    </div>
                  </div>
                  <div>
                    <p className="label">Instruksi gaya yang akan dikirim</p>
                    <p
                      className="pill-box rounded-lg px-3 py-2 font-mono text-xs break-words"
                      style={{ color: "var(--muted)" }}
                    >
                      {designPrefix}
                    </p>
                    <p className="hint">
                      Ditempel di depan teks VO saat job dibuat — tersimpan
                      bersama teks job di database.
                    </p>
                  </div>
                  <div>
                    <label className="label" htmlFor="vo-text-design">Teks yang ingin diucapkan</label>
                    <textarea
                      id="vo-text-design"
                      value={voText}
                      rows={5}
                      maxLength={MAX_TEXT_LENGTH}
                      placeholder="Tulis teks yang mau dibacakan dengan karakter suara di atas…"
                      disabled={!configured || creatingJob}
                      onChange={(e) => setVoText(e.target.value)}
                      className="textarea"
                    />
                    <p className="hint">
                      {countedLength} / {MAX_TEXT_LENGTH} karakter (termasuk
                      instruksi gaya) · {wordCount} kata
                    </p>
                  </div>
                  <button
                    type="submit"
                    disabled={
                      !configured ||
                      creatingJob ||
                      !selectedVoiceId ||
                      !voText.trim() ||
                      countedLength > MAX_TEXT_LENGTH
                    }
                    className="btn-primary w-full py-3 text-base"
                  >
                    {creatingJob ? "Membuat job…" : "✨ Rancang Suara (Generate Custom Voice)"}
                  </button>
                </form>
              )}

              {/* --- Cerita --- */}
              {mode === "story" && (
                <form onSubmit={handleCreateStory} className="mt-4 space-y-4">
                  <p className="text-sm" style={{ color: "var(--muted)" }}>
                    Tulis ide cerita — naskahnya disusun AI (OpenAI) per adegan,
                    lalu tiap adegan langsung dibuatkan VO dengan suara referensi
                    yang dipilih. Tanpa gambar/video AI; suara tetap VoxCPM2.
                  </p>
                  <div>
                    <label className="label" htmlFor="story-idea">Ide cerita</label>
                    <textarea
                      id="story-idea"
                      value={storyIdea}
                      rows={3}
                      maxLength={1000}
                      placeholder="cth: Seekor sapi Hereford yang takut disembelih, lalu belajar cara handling yang benar dari petugas Juleha…"
                      disabled={!configured || creatingStory}
                      onChange={(e) => setStoryIdea(e.target.value)}
                      className="textarea"
                    />
                    <p className="hint">{storyIdea.length} / 1000 karakter</p>
                  </div>
                  <div className="flex flex-wrap gap-4">
                    <div>
                      <label className="label" htmlFor="story-duration">Durasi target</label>
                      <select
                        id="story-duration"
                        value={storyDuration}
                        disabled={!configured || creatingStory}
                        onChange={(e) => setStoryDuration(e.target.value)}
                        className="select"
                      >
                        {STORY_DURATIONS.map((d) => (
                          <option key={d} value={d}>{d}</option>
                        ))}
                      </select>
                      <p className="hint">
                        Menentukan jumlah adegan (3–8). Durasi VO akhir mengikuti
                        panjang narasi yang dihasilkan.
                      </p>
                    </div>
                    <div>
                      <label className="label">Suara untuk narasi</label>
                      <p
                        className="pill-box rounded-lg px-3 py-2 text-sm"
                        style={{ color: "var(--muted)" }}
                      >
                        {selectedVoice ? selectedVoice.name : "Belum ada suara dipilih"}
                      </p>
                    </div>
                  </div>
                  <button
                    type="submit"
                    disabled={!configured || creatingStory || !selectedVoiceId || !storyIdea.trim()}
                    className="btn-primary w-full py-3 text-base"
                  >
                    {creatingStory ? "Menulis naskah…" : "📖 Buat Naskah & VO"}
                  </button>
                </form>
              )}

              {mode === "story" && storyResult && storyScenes.length > 0 && (
                <div className="mt-6">
                  <h3 className="text-sm font-semibold">
                    Naskah — {storyScenes.length} adegan
                  </h3>
                  {storyResult.idea && (
                    <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
                      Ide: “{storyResult.idea}”
                      {storyResult.createdAt
                        ? ` · ${formatDate(storyResult.createdAt)}`
                        : ""}
                    </p>
                  )}
                  {storyResult.createdAt && (
                    <p className="mt-1 text-xs" style={{ color: "var(--faint)" }}>
                      Tersimpan di database — tetap tampil setelah reload.
                    </p>
                  )}
                  <ol className="mt-2 space-y-3">
                    {storyScenes.map((s, i) => (
                      <li
                        key={s.jobId || i}
                        className="rounded-lg border p-3 text-sm"
                        style={{ borderColor: "var(--border)" }}
                      >
                        <p className="font-medium">
                          Adegan {i + 1} — {s.title}
                        </p>
                        <p className="mt-1" style={{ color: "var(--muted)" }}>{s.narration}</p>
                        <p className="mt-1 text-xs" style={{ color: "var(--faint)" }}>
                          Job VO adegan ini ada di bagian Hasil di samping.
                        </p>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {/* --- Transkrip (Whisper) --- */}
              {mode === "transcript" && (
                <div className="mt-4 space-y-4">
                  <p className="text-sm" style={{ color: "var(--muted)" }}>
                    Unggah audio (rekaman, VO, wawancara) — worker di box
                    mentranskripnya dengan Whisper (faster-whisper, model
                    small). Hasilnya teks lengkap + segmen ber-timestamp,
                    bisa disalin dan diunduh .txt/.srt.
                  </p>
                  <form onSubmit={handleCreateTranscription} className="space-y-4">
                    <div>
                      <label className="label" htmlFor="transcript-audio">File audio</label>
                      <input
                        id="transcript-audio"
                        ref={transcriptFileInputRef}
                        type="file"
                        accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac"
                        disabled={!configured || creatingTranscription}
                        onChange={(e) => {
                          const f = e.target.files?.[0] ?? null;
                          if (f && f.size > MAX_AUDIO_BYTES) {
                            setNotice({
                              kind: "err",
                              text: "File audio maksimal 10 MB — potong dulu audionya.",
                            });
                            e.target.value = "";
                            return;
                          }
                          setTranscriptFile(f);
                        }}
                        className="input"
                      />
                      {transcriptFile && (
                        <p className="hint">
                          Dipilih: {transcriptFile.name} ({(transcriptFile.size / 1024).toFixed(0)} KB)
                        </p>
                      )}
                    </div>
                    <div>
                      <label className="label" htmlFor="transcript-language">Bahasa audio</label>
                      <select
                        id="transcript-language"
                        value={transcriptLanguage}
                        disabled={!configured || creatingTranscription}
                        onChange={(e) => setTranscriptLanguage(e.target.value)}
                        className="select"
                      >
                        {TRANSCRIPT_LANGUAGES.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                      <p className="hint">
                        Pilih “Otomatis” bila bahasanya campuran atau tidak yakin.
                      </p>
                    </div>
                    <button
                      type="submit"
                      disabled={!configured || creatingTranscription || !transcriptFile}
                      className="btn-primary w-full py-3 text-base"
                    >
                      {creatingTranscription ? "Mengunggah…" : "📝 Buat Transkrip"}
                    </button>
                  </form>

                  <div className="mt-6">
                    <h3 className="text-sm font-semibold">
                      Hasil transkripsi ({transcriptions.length})
                    </h3>
                    {loadingTranscriptions ? (
                      <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
                        Memuat hasil transkripsi…
                      </p>
                    ) : transcriptions.length === 0 ? (
                      <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
                        Belum ada transkripsi. Unggah satu audio di atas.
                      </p>
                    ) : (
                      <ul className="mt-2 space-y-3">
                        {transcriptions.map((tr) => {
                          const expanded = expandedTranscriptionId === tr.id;
                          const preview = tr.text ?? "";
                          const shown =
                            expanded || preview.length <= 300
                              ? preview
                              : `${preview.slice(0, 300)}…`;
                          const baseName = (tr.audio_name ?? "transkrip").replace(
                            /\.[^.]+$/,
                            "",
                          );
                          return (
                            <li
                              key={tr.id}
                              className="rounded-lg border p-3 text-sm"
                              style={{ borderColor: "var(--border)" }}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="font-medium break-words">
                                    {tr.audio_name ?? "Audio"} · {formatDate(tr.created_at)}
                                  </p>
                                  <p className="text-xs" style={{ color: "var(--faint)" }}>
                                    Bahasa:{" "}
                                    {tr.language === "auto"
                                      ? "Otomatis"
                                      : tr.language === "id"
                                        ? "Indonesia"
                                        : tr.language}{" "}
                                    · Model Whisper {tr.model}
                                  </p>
                                </div>
                                <span className={STATUS_BADGE[tr.status]}>
                                  {STATUS_LABEL[tr.status]}
                                </span>
                              </div>
                              {tr.status === "failed" && tr.error && (
                                <p
                                  className="mt-2 break-words"
                                  style={{ color: "var(--err-text)" }}
                                >
                                  Gagal: {tr.error}
                                </p>
                              )}
                              {tr.status === "done" && tr.text && (
                                <div className="mt-2">
                                  <p
                                    className="break-words whitespace-pre-wrap"
                                    style={{ color: "var(--muted)" }}
                                  >
                                    {shown}
                                  </p>
                                  {preview.length > 300 && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setExpandedTranscriptionId(expanded ? null : tr.id)
                                      }
                                      className="btn-secondary mt-2"
                                    >
                                      {expanded ? "Tutup" : "Lihat selengkapnya"}
                                    </button>
                                  )}
                                  {expanded && tr.segments && tr.segments.length > 0 && (
                                    <ol
                                      className="mt-3 space-y-1 text-xs"
                                      style={{ color: "var(--faint)" }}
                                    >
                                      {tr.segments.map((seg, i) => (
                                        <li key={i}>
                                          [{formatSrtTime(seg.start)} → {formatSrtTime(seg.end)}]{" "}
                                          {seg.text.trim()}
                                        </li>
                                      ))}
                                    </ol>
                                  )}
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleCopyTranscription(tr.id, tr.text ?? "")
                                      }
                                      className="btn-secondary"
                                    >
                                      {copiedTranscriptionId === tr.id
                                        ? "✓ Disalin"
                                        : "📋 Salin teks"}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        downloadTextFile(
                                          `${baseName}.txt`,
                                          tr.text ?? "",
                                          "text/plain",
                                        )
                                      }
                                      className="btn-secondary"
                                    >
                                      ⬇️ Unduh .txt
                                    </button>
                                    <button
                                      type="button"
                                      disabled={!tr.segments || tr.segments.length === 0}
                                      onClick={() =>
                                        downloadTextFile(
                                          `${baseName}.srt`,
                                          buildSrt(tr.segments ?? []),
                                          "text/plain",
                                        )
                                      }
                                      className="btn-secondary disabled:opacity-50"
                                    >
                                      ⬇️ Unduh .srt
                                    </button>
                                  </div>
                                </div>
                              )}
                              <button
                                type="button"
                                onClick={() => handleDeleteTranscription(tr.id)}
                                disabled={deletingTranscriptionId === tr.id}
                                className="btn-danger-text mt-2 disabled:opacity-50"
                              >
                                {deletingTranscriptionId === tr.id
                                  ? "Menghapus…"
                                  : "Hapus transkripsi"}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </section>
          </div>

          {/* ==================== KOLOM KANAN: hasil ==================== */}
          <div className="min-w-0 space-y-6">
            {/* Hasil Sintesis Audio */}
            <section className="card p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">🔊 Hasil Sintesis Audio</h2>
                {latestJob && (
                  <span className={STATUS_BADGE[latestJob.status]}>
                    {STATUS_LABEL[latestJob.status]}
                  </span>
                )}
              </div>

              {!latestJob ? (
                <p className="mt-3 text-sm" style={{ color: "var(--muted)" }}>
                  {loadingJobs
                    ? "Memuat hasil…"
                    : "Belum ada hasil. Buat VO pertama Anda di panel Studio — hasilnya muncul di sini begitu worker selesai."}
                </p>
              ) : (
                <div className="mt-3">
                  {/* Waveform dekoratif */}
                  <div
                    className="flex h-16 items-center justify-between gap-[3px] overflow-hidden rounded-lg border px-3"
                    style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
                    aria-hidden
                  >
                    {WAVE_BARS.map((h, i) => (
                      <span
                        key={i}
                        className={latestJobBusy ? "wave-bar" : undefined}
                        style={{
                          display: "block",
                          width: 4,
                          height: `${h}px`,
                          borderRadius: 2,
                          background: "var(--accent)",
                          opacity: latestJob.status === "done" ? 0.9 : 0.45,
                          animationDelay: `${(i % 8) * 0.12}s`,
                        }}
                      />
                    ))}
                  </div>
                  <p className="mt-3 text-sm font-medium break-words">
                    {latestJob.voices?.name ?? "Suara"} · {formatDate(latestJob.created_at)}
                  </p>
                  <p className="mt-1 text-sm break-words" style={{ color: "var(--muted)" }}>
                    {latestJob.text}
                  </p>
                  <p className="mt-2 text-xs" style={{ color: "var(--faint)" }}>
                    Status:{" "}
                    {latestJob.status === "done"
                      ? "Selesai — putar atau unduh di bawah."
                      : latestJob.status === "failed"
                        ? `Gagal: ${latestJob.error ?? "tidak ada pesan error."}`
                        : latestJob.status === "processing"
                          ? "Diproses worker VoxCPM2…"
                          : "Antre — menunggu giliran worker."}
                  </p>
                  {latestJobBusy && (
                    <div
                      className="mt-3 h-2 overflow-hidden rounded-full"
                      style={{ background: "var(--surface-3)" }}
                      role="progressbar"
                      aria-label="Job sedang diproses"
                    >
                      <div
                        className="progress-indeterminate h-full w-2/5 rounded-full"
                        style={{ background: "var(--accent)" }}
                      />
                    </div>
                  )}
                  {latestJob.status === "done" && latestJobUrl && (
                    <div className="mt-3 space-y-2">
                      <audio controls src={latestJobUrl} className="w-full" preload="metadata" />
                      <a
                        href={latestJobUrl}
                        download={`vo-${latestJob.id}.wav`}
                        className="btn-primary inline-block"
                      >
                        ⬇️ Unduh Audio (WAV)
                      </a>
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* Parameter Karakter Vokal Aktif */}
            <section className="card p-5">
              <h2 className="text-base font-semibold">⚙️ Parameter Karakter Vokal Aktif</h2>
              <ul className="mt-3 space-y-1.5 text-sm" style={{ color: "var(--muted)" }}>
                <li>• Mode: {mode === "clone" ? "Voice Clone" : mode === "design" ? "Voice Design" : mode === "story" ? "Cerita" : "Transkrip"}</li>
                <li>• Suara referensi: {selectedVoice ? selectedVoice.name : "— belum dipilih —"}</li>
                {mode === "design" && (
                  <>
                    <li>• Jenis Kelamin: {designSummary(designGender, DESIGN_GENDERS)}</li>
                    <li>• Rentang Usia: {designSummary(designAge, DESIGN_AGES)}</li>
                    <li>• Nada Suara (Pitch): {designSummary(designPitch, DESIGN_PITCHES)}</li>
                    <li>• Gaya Vokal (Style): {designSummary(designStyle, DESIGN_STYLES)}</li>
                    <li>• Dialek / Aksen: {designSummary(designDialect, DESIGN_DIALECTS)}</li>
                    <li>• Kecepatan Bicara: {designSpeed.toFixed(2)}x</li>
                  </>
                )}
                <li>• Bahasa Utama: Indonesian</li>
                <li>• Diffusion Steps: 10 langkah · cfg 2.0 · seed 42</li>
                <li>• Output: WAV 48 kHz · normalisasi −14 LUFS</li>
                <li>• Engine: VoxCPM2 (worker terpisah, bukan Vercel)</li>
              </ul>
            </section>

            {/* Hasil (semua job) */}
            <section className="card p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">📂 Hasil ({jobs.length})</h2>
                <button
                  type="button"
                  onClick={loadJobs}
                  disabled={!configured}
                  className="btn-secondary"
                >
                  Muat ulang
                </button>
              </div>
              {loadingJobs ? (
                <p className="mt-3 text-sm" style={{ color: "var(--muted)" }}>
                  Memuat hasil…
                </p>
              ) : jobs.length === 0 ? (
                <p className="mt-3 text-sm" style={{ color: "var(--muted)" }}>
                  Belum ada job VO. Buat VO pertama Anda di panel Studio.
                </p>
              ) : (
                <ul className="mt-4 space-y-3">
                  {jobs.map((job) => {
                    const url = publicOutputUrl(job.output_path);
                    return (
                      <li
                        key={job.id}
                        className="rounded-lg border p-3 text-sm"
                        style={{ borderColor: "var(--border)" }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium">
                              {job.voices?.name ?? "Suara"} · {formatDate(job.created_at)}
                            </p>
                            <p className="mt-1 break-words" style={{ color: "var(--muted)" }}>
                              {job.text}
                            </p>
                            {job.status === "failed" && job.error && (
                              <p className="mt-1 break-words" style={{ color: "var(--err-text)" }}>
                                Gagal: {job.error}
                              </p>
                            )}
                          </div>
                          <span className={STATUS_BADGE[job.status]}>
                            {STATUS_LABEL[job.status]}
                          </span>
                        </div>
                        {job.status === "done" && url && (
                          <div className="mt-3 space-y-2">
                            <audio controls src={url} className="w-full" preload="metadata" />
                            <a
                              href={url}
                              download={`vo-${job.id}.wav`}
                              className="btn-primary inline-block"
                            >
                              Download WAV
                            </a>
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => handleDeleteJob(job.id)}
                          disabled={deletingJobId === job.id}
                          className="btn-danger-text mt-2 disabled:opacity-50"
                        >
                          {deletingJobId === job.id ? "Menghapus…" : "Hapus job"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        </div>

        <footer className="mt-8 text-center text-xs" style={{ color: "var(--faint)" }}>
          VO Studio · Kloning suara VoxCPM2 · Sintesis berjalan di worker
          terpisah (bukan di Vercel) · Semua data tersimpan di Supabase.
        </footer>
      </div>
    </main>
  );
}
