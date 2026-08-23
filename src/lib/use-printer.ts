"use client";

import { useCallback, useEffect, useState } from "react";
import { UsbPrinter, usbPrinter, unsupportedReason } from "./usb-printer";

/*
  One decision point for "how do we print?".

  USB is preferred whenever a printer has been connected: it needs no Windows
  driver and shows no dialog. If none is connected the caller falls back to
  window.print(), so the app still works on a machine that was never set up.
*/

export type PrintMode = "usb" | "browser";

export function usePrinter() {
  const [usbReady, setUsbReady] = useState(false);
  const [usbName, setUsbName] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Silently reattach to a printer the user already approved. No prompt: the
  // permission is remembered per origin, so reception never re-approves.
  useEffect(() => {
    let cancelled = false;
    usbPrinter.restore().then((ok) => {
      if (cancelled || !ok) return;
      setUsbReady(true);
      setUsbName(usbPrinter.name);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    try {
      await usbPrinter.connect();
      setUsbReady(true);
      setUsbName(usbPrinter.name);
      return true;
    } catch (e) {
      // A cancelled chooser is a normal outcome, not a failure to report.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/No device selected|cancell?ed/i.test(msg)) setError(msg);
      return false;
    }
  }, []);

  const disconnect = useCallback(async () => {
    await usbPrinter.disconnect();
    UsbPrinter.forget();
    setUsbReady(false);
    setUsbName("");
  }, []);

  /**
   * Sends bytes to the USB printer, or runs `fallback` (normally
   * window.print()) when no printer is connected.
   *
   * Stable across renders: callers fire this from a mount-only effect, and a
   * changing identity there would re-run the effect (or, worse, be captured
   * stale). Connection state is read from the printer itself rather than from
   * React state, so no dependency is needed.
   */
  const print = useCallback(
    async (bytes: Uint8Array, fallback?: () => void) => {
      if (usbPrinter.connected) {
        try {
          await usbPrinter.print(bytes);
          return "usb" as PrintMode;
        } catch (e) {
          // The cable was pulled, or the printer powered off mid-shift.
          setUsbReady(false);
          setError(
            e instanceof Error
              ? `${e.message} Falling back to the browser dialog.`
              : "Printer error.",
          );
        }
      }
      fallback?.();
      return "browser" as PrintMode;
    },
    [],
  );

  return {
    usbReady,
    usbName,
    error,
    unsupported: unsupportedReason(),
    connect,
    disconnect,
    print,
    clearError: () => setError(null),
  };
}
