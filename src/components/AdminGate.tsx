"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { signInAdmin, signOut } from "@/app/actions/auth";
import { Alert, Button, Card } from "@/components/ui";
import { IconEye, IconEyeOff, IconLock } from "@/components/icons";

const IDLE_MS = 5 * 60 * 1000;

/**
 * PIN gate for the settings that change money.
 *
 * The clinic runs on one shared login, so this is not authentication — it is
 * a lock on fees, prices and token prefixes that reception is not meant to
 * touch. It auto-locks after five idle minutes, because the realistic failure
 * is a manager walking away from an open screen rather than someone guessing
 * the code.
 *
 * The unlock lives in component state only: it does not survive a reload or a
 * new tab, which is the behaviour people expect from a lock.
 */
export function AdminGate({ children }: { children?: React.ReactNode }) {
  const router = useRouter();
  const [unlocked, setUnlocked] = useState(false);
  const [pin, setPin] = useState("");
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnDefault, setWarnDefault] = useState(false);
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const lock = useCallback(() => {
    // Ending the admin session drops back to the reception role, so the
    // money-changing actions are locked again on the server, not just hidden.
    void signOut();
    setUnlocked(false);
    setPin("");
    setError(null);
    router.refresh();
  }, [router]);

  useEffect(() => {
    if (!unlocked) inputRef.current?.focus();
  }, [unlocked]);

  // Idle auto-lock. Any real interaction restarts the clock.
  useEffect(() => {
    if (!unlocked) return;
    let timer = window.setTimeout(lock, IDLE_MS);
    const bump = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(lock, IDLE_MS);
    };
    const events = ["pointerdown", "keydown", "wheel"] as const;
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, bump));
    };
  }, [unlocked, lock]);

  function submit() {
    setError(null);
    start(async () => {
      // Admin sign-in mints a server session with the ADMIN role; the
      // settings actions check for it. Unlocking used to be browser-only.
      const res = await signInAdmin(pin);
      if (res.ok) {
        setUnlocked(true);
        setWarnDefault(res.isDefault);
        setPin("");
        // The admin page fetches its data only once the session holds the
        // ADMIN role, so re-run the server render now that it does.
        router.refresh();
      } else {
        setError(res.error);
        setPin("");
        inputRef.current?.focus();
      }
    });
  }

  if (unlocked) {
    return (
      <>
        {warnDefault && (
          <div className="mx-auto max-w-6xl px-5 pt-5">
            <Alert>
              This clinic is still using the default PIN <strong>1234</strong>.
              Change it under Counter staff → Admin PIN.
            </Alert>
          </div>
        )}
        <div className="mx-auto flex max-w-6xl justify-end px-5 pt-4">
          <Button onClick={lock}>
            <IconLock className="h-[18px] w-[18px]" />
            Lock admin
          </Button>
        </div>
        {children}
      </>
    );
  }

  return (
    <div className="mx-auto max-w-md px-5 py-16">
      <Card className="p-6 text-center">
        <span
          className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full
            bg-sunken text-muted"
          aria-hidden
        >
          <IconLock className="h-7 w-7" />
        </span>

        <h1 className="text-lg font-bold">Admin is locked</h1>
        <p className="mt-1 text-sm text-muted">
          These settings change fees, prices and token numbers. Enter the PIN to
          continue.
        </p>

        {/*
          Centred and wide, unlike the two sign-in screens: this card is
          itself centred, and a left-aligned field with a leading icon would
          sit oddly in it. The reveal is still needed — a mistyped digit is
          otherwise indistinguishable from a wrong PIN, and the lockout counts
          both the same.
        */}
        <div className="relative mx-auto mt-5 w-full max-w-[260px]">
          <input
            ref={inputRef}
            type={shown ? "text" : "password"}
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={pin}
            aria-label="Admin PIN"
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && pin.length >= 4 && submit()}
            className="tnum h-14 pr-12 text-center text-2xl font-bold tracking-[0.4em]"
            placeholder="••••"
          />
          <button
            type="button"
            onClick={() => setShown((v) => !v)}
            tabIndex={-1}
            aria-label={shown ? "Hide PIN" : "Show PIN"}
            aria-pressed={shown}
            title={shown ? "Hide PIN" : "Show PIN"}
            className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center
              justify-center rounded-[var(--r-sm)] text-muted transition-colors
              hover:bg-[var(--hover)] hover:text-[var(--ink-2)]"
          >
            {shown ? (
              <IconEyeOff className="h-[18px] w-[18px]" />
            ) : (
              <IconEye className="h-[18px] w-[18px]" />
            )}
          </button>
        </div>

        {error && (
          <div className="mt-3">
            <Alert>{error}</Alert>
          </div>
        )}

        <Button
          variant="primary"
          size="lg"
          onClick={submit}
          disabled={pending || pin.length < 4}
          className="mt-4 w-full"
        >
          {pending ? "Checking…" : "Unlock"}
        </Button>

        <p className="mt-3 text-xs text-muted">
          Locks itself again after 5 minutes of inactivity.
        </p>
      </Card>
    </div>
  );
}
