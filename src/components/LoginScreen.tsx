"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { signInReception } from "@/app/actions/auth";
import { Alert, Button, Card } from "@/components/ui";
import { IconLock, IconMedical } from "@/components/icons";
import { ThemeToggle } from "@/components/ThemeToggle";

/*
  Reception sign-in — the front door.

  Until now reception was open: anyone reaching the app landed straight on the
  token screen, and every action behind it ran unauthenticated. This is the
  gate that closes that, and it is a real one — the PIN is verified on the
  server, which then sets the session cookie every privileged action checks.

  Kept deliberately plain. It is the first thing staff see each morning and
  the thing they see again after every idle lock, so it opens fast and asks
  for exactly one thing.
*/
export function LoginScreen({ next }: { next: string }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  function submit() {
    if (pin.length < 4) return;
    setError(null);
    start(async () => {
      const res = await signInReception(pin);
      if (!res.ok) {
        setError(res.error);
        setPin("");
        inputRef.current?.focus();
        return;
      }
      // A full navigation, not a client push: the destination is a
      // server-rendered page whose data fetch is itself gated, so it must
      // re-run now that the session cookie is set.
      router.replace(next || "/");
      router.refresh();
    });
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <span
            className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl
              bg-gradient-to-br from-[var(--accent-2)] to-[var(--accent)] text-white
              shadow-[var(--glow)]"
            aria-hidden
          >
            <IconMedical className="h-8 w-8" />
          </span>
          <h1 className="text-2xl font-bold tracking-tight">Reception sign in</h1>
          <p className="mt-1.5 text-sm text-muted">
            Enter the reception PIN to open the desk.
          </p>
        </div>

        <Card className="p-5 sm:p-6">
          {error && (
            <div className="mb-4">
              <Alert>{error}</Alert>
            </div>
          )}

          <label
            htmlFor="reception-pin"
            className="mb-2 block text-xs font-semibold uppercase tracking-wide text-muted"
          >
            Reception PIN
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
              <IconLock className="h-[18px] w-[18px]" />
            </span>
            <input
              id="reception-pin"
              ref={inputRef}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              maxLength={6}
              value={pin}
              placeholder="••••"
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              // 48px tall — a primary field on a shared touchscreen.
              className="w-full rounded-[var(--r)] border-2 border-[var(--line)] bg-[var(--surface)]
                py-3 pl-10 pr-3 text-lg tracking-[0.3em] outline-none transition-colors
                focus:border-[var(--accent)]"
              style={{ minHeight: 48 }}
            />
          </div>

          <Button
            variant="primary"
            onClick={submit}
            disabled={pending || pin.length < 4}
            className="mt-4 w-full"
            style={{ minHeight: 48 }}
          >
            {pending ? "Signing in…" : "Sign in"}
          </Button>

          <p className="mt-4 text-center text-xs text-muted">
            Doctors sign in on the{" "}
            <a href="/doctor" className="font-semibold text-[var(--accent)] underline">
              doctor screen
            </a>
            .
          </p>
        </Card>
      </div>
    </div>
  );
}
