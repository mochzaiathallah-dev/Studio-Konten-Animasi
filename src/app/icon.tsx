import { ImageResponse } from "next/og";
import { PADI_LOGO_ICON } from "../lib/padi-logo";

// Favicon aplikasi: emblem PADI Tech Solutions (huruf P + padi + sirkuit)
// di atas putih, 512x512. Dibuat dari kode (bukan file .ico/.png) karena
// push snapshot GitHub hanya menerima file teks — lihat src/lib/padi-logo.ts.
// Sesuai panduan app-icons Next.js: icon.tsx + ImageResponse dari next/og;
// favicon.ico default sudah dihapus supaya route ini yang dipakai.
export const size = {
  width: 512,
  height: 512,
};
export const contentType = "image/png";

// Image generation
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          background: "white",
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <img src={PADI_LOGO_ICON} alt="" width={512} height={512} />
      </div>
    ),
    {
      ...size,
    },
  );
}
