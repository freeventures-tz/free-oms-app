import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";

import { RegisterServiceWorker } from "@/components/pwa/register-service-worker";

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
  title: "Free Ventures OMS",
  description: "Orders, stock, payments and dispatch for Free Ventures.",
  applicationName: "Free Ventures",

  // `app/favicon.ico` is linked by Next automatically; these add the larger sizes a browser
  // prefers for bookmarks and home screens, and the one iOS asks for by name (docs/pwa.md §3).
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon-180.png", sizes: "180x180", type: "image/png" }],
  },

  appleWebApp: {
    capable: true,
    title: "Free Ventures",
    // "default" keeps dark status-bar text on a light bar, which stays readable over BOTH the
    // Deep Twilight entry screens and the light application shell. "black-translucent" would put
    // white text over whichever of the two happened to be underneath.
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  // Colours the Android system bars and the desktop title bar while the app is open. It matches
  // the entry-screen canvas and the manifest's `theme_color`.
  themeColor: "#000040",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();

  return (
    <html
      lang={locale}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
