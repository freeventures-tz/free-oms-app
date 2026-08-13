import type { MetadataRoute } from "next";

/**
 * The web app manifest — what makes Free Ventures installable from a browser (docs/pwa.md).
 *
 * Served at `/manifest.webmanifest`. It must stay reachable WITHOUT a session: a person installs
 * the app before they sign in, and on Android the manifest and every icon in it are fetched by the
 * browser, not by the page. `proxy.ts` excludes this path for that reason.
 *
 * It is deliberately static. The application is bilingual, but "Free Ventures" is the business's
 * name in English and in Swahili alike, so the installed name reads correctly either way — and an
 * icon whose label changed when someone switched language would be worse than one that never does.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    // A stable identity. Changing this makes browsers treat it as a DIFFERENT application and
    // install a second copy alongside the first, so it must not be edited casually.
    id: "/",

    name: "Free Ventures OMS",
    short_name: "Free Ventures",
    description: "Orders, stock, payments and dispatch for Free Ventures.",

    start_url: "/",
    scope: "/",
    display: "standalone",

    // The entry screens are a Deep Twilight canvas, so the launch splash and the system bars
    // continue straight into the first thing a person sees rather than flashing white.
    background_color: "#000040",
    theme_color: "#000040",

    icons: [
      // `any` is the artwork as drawn — a light disc with transparent corners.
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // `maskable` is full-bleed on Deep Twilight with the artwork inside the 80% safe zone.
      // Android crops adaptive icons to a circle or a squircle and would clip the disc otherwise.
      {
        src: "/icons/icon-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
