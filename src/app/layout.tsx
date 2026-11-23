import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "VO Studio — Kloning Suara VoxCPM2",
  description:
    "Buat voice-over dengan suara referensi Anda sendiri (kloning suara VoxCPM2).",
};

/**
 * Script pra-paint tema (tanpa dependensi, tanpa secret).
 * Membaca pilihan tema yang tersimpan di localStorage
 * ("vo-studio-theme": "system" | "dark" | "light", default "system"),
 * lalu menulis data-theme="dark" | "light" di <html> SEBELUM halaman
 * pertama kali digambar — supaya tidak ada kedipan tema saat load.
 * Bila localStorage tidak tersedia / error, CSS di globals.css
 * mengambil alih lewat media query prefers-color-scheme.
 */
const THEME_INIT_SCRIPT = `(function(){try{var m=localStorage.getItem("vo-studio-theme")||"system";var dark=m==="dark"||(m==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.setAttribute("data-theme",dark?"dark":"light");}catch(e){}})();`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="id"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
