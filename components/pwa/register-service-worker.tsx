"use client";

import { useEffect } from "react";

/**
 * Registers `/sw.js` so the browser will offer to install the app (docs/pwa.md).
 *
 * It renders nothing and registers after paint, so it never delays the first screen — on a phone
 * in a yard, sign-in appearing quickly matters more than installability being ready in the first
 * hundred milliseconds.
 *
 * Failure is deliberately silent. A refused registration — an insecure origin, a browser with
 * service workers switched off, a private window — costs the user nothing except the install
 * offer, and there is no action they could take about it, so there is nothing worth saying.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        // See above: nothing to tell the user, and nothing to retry.
      });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }

    window.addEventListener("load", register);
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
