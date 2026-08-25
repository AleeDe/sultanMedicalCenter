"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { signInDoctor, signOut as endSession } from "@/app/actions/auth";
import { Alert, Button, Card, DoctorAvatar } from "@/components/ui";
import { IconEye, IconEyeOff, IconLock, IconStethoscope } from "@/components/icons";
import { ThemeToggle } from "@/components/ThemeToggle";
import type { Doctor } from "@/lib/types";

const IDLE_MS = 30 * 60 * 1000;
const KEY = "tokgen.doctorId";

/*
  Doctor sign-in.

  Same shape as the admin PIN, and deliberately so: the clinic already knows
  how that works, and a second login mechanism would be a second thing to
  forget. The doctor picks their name, types a PIN, and stays signed in on
  that device.

  Auto-locks after 30 minutes idle — long enough not to interrupt a
  consultation, short enough that a tablet left in an empty room does not
  stay open. The choice of doctor is remembered so the next sign-in is one
  field, not two.
*/
export function DoctorGate({
  doctors,
  children,
}: {
  doctors: Doctor[];
  children: (doctor: Doctor) => React.ReactNode;
}) {
  const [signedIn, setSignedIn] = useState<Doctor | null>(null);
  /*
    Lazy initialiser rather than an effect: reading localStorage in an effect
    causes a second render before paint, and the saved doctor is available
    synchronously anyway. Guarded for the server render, where there is no
    localStorage at all.
  */
  const [picked, setPicked] = useState<number | null>(() => {
    if (typeof localStorage === "undefined") return null;
    const saved = localStorage.getItem(KEY);
    return saved ? Number(saved) : null;
  });
  const [pin, setPin] = useState("");
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnDefault, setWarnDefault] = useState(false);
  const [pending, start] = useTransition();
  const pinRef = useRef<HTMLInputElement>(null);

  const signOut = useCallback(() => {
    // Destroy the server session too, not just the local view — otherwise the
    // cookie would keep authorising actions after "sign out".
    void endSession();
    setSignedIn(null);
    setPin("");
    setError(null);
  }, []);

  useEffect(() => {
    if (picked !== null && !signedIn) pinRef.current?.focus();
  }, [picked, signedIn]);

  useEffect(() => {
    if (!signedIn) return;
    let timer = window.setTimeout(signOut, IDLE_MS);
    const bump = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(signOut, IDLE_MS);
    };
    const events = ["pointerdown", "keydown"] as const;
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, bump));
    };
  }, [signedIn, signOut]);

  function submit() {
    if (picked === null) return;
    setError(null);
    start(async () => {
      // Signing in now mints a SERVER session — the doctor's actions are
      // authorised by that cookie, not by this component's state. The old
      // path only flipped a boolean in the browser, which authorised nothing.
      const res = await signInDoctor(picked, pin);
      if (!res.ok) {
        setError(res.error);
        setPin("");
        pinRef.current?.focus();
        return;
      }
      localStorage.setItem(KEY, String(picked));
      setWarnDefault(res.isDefault);
      setSignedIn(doctors.find((d) => d.id === picked) ?? null);
      setPin("");
    });
  }

  if (signedIn) {
    return (
      <>
        {/*
          The doctor's own header, in place of the shared reception nav.

          This screen runs on a tablet in a consulting room, so it needs to
          answer "whose screen is this, and which room" at a glance — a
          doctor who walks up to the wrong tablet must see it immediately,
          because acting on it calls the wrong room's patient. The reception
          bar answered none of that and spent the width on destinations this
          machine never opens.
        */}
        <header
          className="no-print sticky top-0 z-20 border-b border-[var(--line)]
            bg-[var(--surface)]/90 backdrop-blur-md"
        >
          <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-2.5 sm:px-5">
            <DoctorAvatar name={signedIn.name} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-bold leading-tight">
                {signedIn.name}
              </p>
              <p className="truncate text-xs text-muted">
                {[signedIn.speciality, signedIn.room].filter(Boolean).join(" · ")}
              </p>
            </div>
            <ThemeToggle />
            {/*
              A real target, not a text link. This is pressed by someone
              standing up to leave, often without looking — Fitts' Law says
              make it big enough to hit in one motion.
            */}
            <Button
              onClick={signOut}
              className="h-11 px-4 text-sm"
              style={{ minHeight: 44 }}
            >
              Sign out
            </Button>
          </div>
        </header>
        {warnDefault && (
          <div className="mx-auto max-w-4xl px-5 pt-3">
            <Alert>
              Still using the default PIN <strong>1234</strong>. Ask reception
              to change it under Admin → Doctors.
            </Alert>
          </div>
        )}
        {children(signedIn)}
      </>
    );
  }

  return (
    <div className="mx-auto max-w-md px-4 py-8 sm:px-5 sm:py-12">
      <Card className="p-5 sm:p-6">
        <span
          className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl
            bg-gradient-to-br from-[var(--accent-2)] to-[var(--accent)] text-white
            shadow-[var(--glow)]"
          aria-hidden
        >
          <IconStethoscope className="h-8 w-8" />
        </span>
        <h1 className="text-center text-xl font-bold">Doctor sign in</h1>
        <p className="mt-1 text-center text-sm text-muted">
          Open your queue and start seeing patients.
        </p>

        <div className="mt-5 grid gap-2">
          {doctors.map((d) => (
            <button
              key={d.id}
              type="button"
              aria-pressed={picked === d.id}
              onClick={() => {
                setPicked(d.id);
                setError(null);
              }}
              className={`flex items-center gap-3 rounded-[var(--r)] border-2 p-3.5 text-left
                transition-all active:scale-[0.99] ${
                  picked === d.id
                    ? "border-[var(--accent)] bg-[var(--accent-soft)] shadow-[var(--shadow)]"
                    : "border-[var(--line)] hover:border-[var(--hover-line)] hover:bg-[var(--hover)]"
                }`}
            >
              <DoctorAvatar
                name={d.name}
                tone={picked === d.id ? "accent" : "soft"}
                className="h-11 w-11 text-sm"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-bold">{d.name}</span>
                <span className="block truncate text-xs text-muted">
                  {d.speciality}
                  {d.room ? ` · ${d.room}` : ""}
                </span>
              </span>
            </button>
          ))}
        </div>

        {picked !== null && (
          <>
            {/*
              Reveal, same as the other two gates. A doctor signing in on a
              tablet between patients cannot tell a mistyped digit from a wrong
              PIN, and the lockout treats them identically.
            */}
            <div className="relative mx-auto mt-5 w-full max-w-[280px]">
              <input
                ref={pinRef}
                type={shown ? "text" : "password"}
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={pin}
                aria-label="Doctor PIN"
                placeholder="••••"
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => e.key === "Enter" && pin.length >= 4 && submit()}
                className="tnum h-16 pr-12 text-center text-3xl font-bold tracking-[0.4em]"
              />
              <button
                type="button"
                onClick={() => setShown((v) => !v)}
                tabIndex={-1}
                aria-label={shown ? "Hide PIN" : "Show PIN"}
                aria-pressed={shown}
                title={shown ? "Hide PIN" : "Show PIN"}
                className="absolute right-1.5 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center
                  justify-center rounded-[var(--r-sm)] text-muted transition-colors
                  hover:bg-[var(--hover)] hover:text-[var(--ink-2)]"
              >
                {shown ? (
                  <IconEyeOff className="h-5 w-5" />
                ) : (
                  <IconEye className="h-5 w-5" />
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
              className="mt-4 w-full"
              disabled={pending || pin.length < 4}
              onClick={submit}
            >
              {pending ? "Checking…" : "Sign in"}
            </Button>
          </>
        )}

        <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted">
          <IconLock className="h-3.5 w-3.5" />
          Signs out after 30 minutes of inactivity
        </p>
      </Card>
    </div>
  );
}
