"use client";

import { useEffect } from "react";

/**
 * Registers the service worker.
 *
 * Without it the app is server-rendered only, so a refresh during an outage
 * shows the browser's offline page and the clinic stops — the leases and
 * outbox behind it are unreachable.
 */
export function RegisterSW() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // Registration is deliberately fire-and-forget: a failure here degrades
    // the app to online-only, which is the behaviour it had before.
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  return null;
}
