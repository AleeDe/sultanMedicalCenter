"use client";

import { useCallback, useEffect, useState } from "react";
import { UsbPrinter, usbPrinter, unsupportedReason } from "./usb-printer";
import { printSlipOverSerial } from "@/app/actions/print";

/*
  One decision point for "how do we print?".

  The slip is normally printed by print-agent/agent.mjs, on the one PC the
  printer is plugged into. It watches the token queue, so a token issued on a
  tablet or a phone still produces paper at the counter — those devices have
  no COM port and never will, and asking each device to print its own slip is
  what made them unusable for issuing at all.

  What remains here is for the device that IS at the printer:

   1. Server serial — the server owns the COM port. True when the app runs on
      the clinic's own PC, which is the development setup.
   2. WebUSB — the browser claims the printer directly. One permission click
      per machine, and disabled by default in Brave.
   3. window.print() — the browser dialog.

  A caller that leaves printing to the agent should not call print() at all.
*/

export type PrintMode = "serial" | "usb" | "browser";

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
      /*
        The server's own COM port. This only succeeds when the app runs on the
        machine the printer is plugged into — the development setup, and any
        clinic that later runs the app locally rather than from Vercel.

        A Uint8Array does not survive the server action boundary intact, so
        the bytes cross as a plain array.
      */
      let serialError: string | null = null;
      try {
        const result = await printSlipOverSerial(Array.from(bytes));
        if (result.ok) {
          setError(null);
          return "serial" as PrintMode;
        }
        serialError = result.error;
      } catch (e) {
        serialError = e instanceof Error ? e.message : String(e);
      }
      /*
        Surface why serial failed rather than swallowing it.

        This route falling back silently is exactly how a broken setup hides:
        the browser dialog opens, printing "works", and nobody learns the COM
        printer was never reached. Reception sees the reason and can say it
        out loud; the fallback still happens either way.
      */
      console.warn("[print] direct routes unavailable:", serialError);
      setError(serialError);

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
