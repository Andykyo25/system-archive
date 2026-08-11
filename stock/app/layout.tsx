import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import "./globals.css";
import { Sidebar } from "./_components/Sidebar";
import { TopBar } from "./_components/TopBar";

export const metadata: Metadata = {
  title: "持股戰情室",
  description: "個人持股 + 多因子分析",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-TW"
      className={`h-full antialiased ${GeistSans.variable}`}
    >
      {/* bg 由 globals.css body 漸層負責,body 不掛 bg utility */}
      <body className="min-h-full font-sans text-zinc-100">
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="flex min-w-0 flex-1 flex-col pb-20 md:pb-0">
            <TopBar />
            <main className="flex-1 px-4 py-5 sm:px-6 md:px-8 md:py-7 xl:px-10">
              <div className="mx-auto w-full max-w-[1480px]">{children}</div>
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
