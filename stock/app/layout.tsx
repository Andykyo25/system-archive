import type { Metadata } from "next";
import "./globals.css";
import { TabNav } from "./_components/TabNav";

export const metadata: Metadata = {
  title: "持股戰情室",
  description: "個人持股 + 模擬部位分析",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-TW" className="h-full antialiased">
      <body className="min-h-full bg-zinc-950 text-zinc-100">
        <header className="border-b border-zinc-800 bg-zinc-900">
          <div className="mx-auto max-w-6xl">
            <h1 className="px-4 pt-4 text-xl font-semibold">持股戰情室</h1>
            <TabNav />
          </div>
        </header>
        <main className="mx-auto max-w-6xl p-4">{children}</main>
      </body>
    </html>
  );
}
