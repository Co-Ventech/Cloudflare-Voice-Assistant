import type { Metadata } from "next";
import "./globals.css";

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%2306100f'/%3E%3Crect x='42' y='24' width='16' height='38' rx='8' fill='%232dd4bf'/%3E%3Cpath d='M28 50a22 22 0 0 0 44 0' stroke='%235eead4' stroke-width='6' fill='none' stroke-linecap='round'/%3E%3Cline x1='50' y1='72' x2='50' y2='82' stroke='%235eead4' stroke-width='6' stroke-linecap='round'/%3E%3C/svg%3E";

export const metadata: Metadata = {
  title: "voice — a Workers AI voice agent",
  description: "Talk to an AI voice agent running entirely on Cloudflare Workers AI: Whisper, Llama, and Aura TTS.",
  icons: { icon: FAVICON },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
