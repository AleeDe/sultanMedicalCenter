"use client";

import { useCallback, useEffect, useState } from "react";
import { UsbPrinter, usbPrinter, unsupportedReason } from "./usb-printer";
import { printSlipOverSerial } from "@/app/actions/print";
import { printViaAgent } from "./print-agent";

/*
  One decision point for "how do we print?".

  Four routes, tried in order:

   1. Local agent — print-agent/agent.mjs running on the reception PC, holding
      the COM port. This is the production route: the app is served from
      Vercel, so the server has no printer, but the browser can reach a
      service on the same PC as the printer.
   2. Server serial — the server itself owns the COM port. True only when the
      app runs on the clinic's own PC, which is the development setup.
   3. WebUSB — the browser claims the printer directly. Needs one permission
      click per machine, and is disabled by default in Brave.
   4. window.print() — the browser dialog, when none of the above is set up.

  Order is by how little the user has to do: agent and server serial need no
  click at all, WebUSB needs one per machine, the dialog needs one per slip.
*/

export type PrintMode = "agent" | "serial" | "usb" | "browser";

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
        The local agent first: it is the only route that reaches a COM port
        when the app is served from Vercel, and it needs no click ever.
      */
      const viaAgent = await printViaAgent(bytes);
      if (viaAgent.ok) {
        setError(null);
        return "agent" as PrintMode;
      }

      /*
        Then the server's own COM port. This only succeeds when the app runs
        on the machine the printer is plugged into — the development setup,
        and any clinic that later runs the app locally.

        A Uint8Array does not survive the server action boundary intact, so
        the bytes cross as a plain array.
      */
      let serialError: string | null = viaAgent.error;
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
