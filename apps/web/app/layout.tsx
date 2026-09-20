import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Vyaya — see what your LLM spend is actually buying",
  description:
    "Vyaya proxies your LLM traffic, finds the five ways tokens get wasted, and puts a dollar figure on each one.",
};

// Set the theme class before first paint so there's no flash.
const themeScript = `(function(){try{var t=localStorage.getItem("vyaya-theme");if(t==="dark"||(t!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches)){document.documentElement.classList.add("dark")}}catch(e){}})()`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body
        className={`${inter.variable} bg-bg font-sans text-body text-ink antialiased`}
      >
        <SiteHeader />
        <main className="mx-auto w-full max-w-6xl px-6 pb-20">{children}</main>
      </body>
    </html>
  );
}
