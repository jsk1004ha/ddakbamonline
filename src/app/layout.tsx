import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "딱밤소사이어티 | 2장 섯다",
  description:
    "돈 대신 딱밤으로 즐기는 2–4인 온라인 섯다. 받기와 올리기로 승부하고 계정별 딱밤 기록을 남겨보세요.",
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0d2925",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
