"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { checkDoctorPin } from "@/app/actions/queue";
import { Alert, Button, Card, DoctorAvatar } from "@/components/ui";
import { IconLock, IconStethoscope } from "@/components/icons";
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
  const [error, setError] = useState<string | null>(null);
  const [warnDefault, setWarnDefault] = useState(false);
  const [pending, start] = useTransition();
  const pinRef = useRef<HTMLInputElement>(null);

  const signOut = useCallback(() => {
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
      const res = await checkDoctorPin(picked, pin);
      if (!res.ok) {
        setError("Incorrect PIN.");
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
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2 px-4 pt-4 sm:px-5">
          <p className="flex items-center gap-2 text-sm text-muted">
            <span className="h-2 w-2 rounded-full bg-[var(--ok)]" aria-hidden />
            Signed in as <strong className="text-[var(--ink)]">{signedIn.name}</strong>
          </p>
          <Button onClick={signOut} className="h-9 px-3 text-xs" style={{ minHeight: 36 }}>
            Sign out
          </Button>
        </div>
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
            <input
              ref={pinRef}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              value={pin}
              aria-label="Doctor PIN"
              placeholder="••••"
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && pin.length >= 4 && submit()}
              className="tnum mx-auto mt-5 h-16 max-w-[240px] text-center text-3xl font-bold tracking-[0.4em]"
            />

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
