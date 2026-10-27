import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Terra ✳ — Интерактивная 3D-планета",
  description:
    "Фотореалистичная 3D-Земля: вращение, смена дня и ночи, сезоны, облака, огни городов, атмосфера и звёзды. Управляйте планетой в реальном времени.",
  keywords: ["3D Земля", "планета", "интерактив", "WebGL", "three.js", "Terra"],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Terra ✳ — Интерактивная 3D-планета",
    description: "Фотореалистичная 3D-Земля с управлением освещением, сезонами и слоями",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
