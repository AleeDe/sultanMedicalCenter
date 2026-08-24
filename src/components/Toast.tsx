"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { IconCheck, IconCross } from "@/components/icons";

/*
  Confirmation that something happened.

  Every action here used to report only its failures: "Call next patient"
  succeeded in silence, so the only evidence was a queue row quietly moving
  somewhere else on screen. On a busy desk that is indistinguishable from a
  press that did not register, and the honest response to that ambiguity is
  to press it again — which calls a second patient nobody is ready for.

  Norman's gulf of evaluation: after acting, a person has to work out whether
  the system did what they wanted. Closing that gap is what this is for, and
  it is why the message names the token rather than saying "Done" — "Called
  NORM-00042" is checkable against the screen and the slip; "Done" is not.

  Deliberately transient and non-blocking. A confirmation that must be
  dismissed is a second task handed to someone who has already moved on to
  the patient in front of them.
*/

type Tone = "ok" | "error";
type Toast = { id: number; text: string; tone: Tone };

const ToastContext = createContext<{
  show: (text: string, tone?: Tone) => void;
} | null>(null);

/** Long enough to read a token number, short enough not to linger. */
const OK_MS = 3200;
/*
  Errors stay longer. They usually require the person to do something, and a
  message that vanishes before it is read is worse than none — the action
  failed and nobody knows why.
*/
const ERROR_MS = 6000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback((text: string, tone: Tone = "ok") => {
    // Date.now() collides when two actions land in the same millisecond,
    // which is exactly what happens when a queue refresh triggers two.
    const id = Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    window.setTimeout(
      () => setToasts((t) => t.filter((x) => x.id !== id)),
      tone === "ok" ? OK_MS : ERROR_MS,
    );
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div
        /*
          aria-live rather than a dialog: this announces itself to a screen
          reader without stealing focus from the field someone is typing in.
          "polite" so it waits for a pause instead of interrupting.
        */
        role="status"
        aria-live="polite"
        className="no-print pointer-events-none fixed inset-x-0 bottom-0 z-50 flex
          flex-col items-center gap-2 p-4 sm:items-end sm:p-6"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`animate-rise pointer-events-auto flex max-w-sm items-center gap-2.5
              rounded-[var(--r)] px-4 py-3 text-sm font-semibold shadow-lg ${
                t.tone === "ok"
                  ? "bg-[var(--ok)] text-white"
                  : "bg-[var(--danger)] text-white"
              }`}
          >
            {t.tone === "ok" ? (
              <IconCheck className="h-[18px] w-[18px] shrink-0" />
            ) : (
              <IconCross className="h-[18px] w-[18px] shrink-0" />
            )}
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Shows a transient confirmation.
 *
 * Returns a no-op outside a provider rather than throwing: a missing toast is
 * a cosmetic loss, and taking down the queue screen over it would turn a
 * missing confirmation into a missing clinic.
 */
export function useToast() {
  const ctx = useContext(ToastContext);
  return ctx ?? { show: () => {} };
}

/**
 * Announces when the connection drops and when it returns.
 *
 * Reception needs to know the moment work stops reaching the server, because
 * what they do next depends on it — and the queue screen otherwise looks
 * identical whether it is live or frozen.
 */
export function ConnectionToasts() {
  const { show } = useToast();

  useEffect(() => {
    const offline = () => show("Offline — tokens are saved on this device", "error");
    const online = () => show("Back online");
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [show]);

  return null;
}
