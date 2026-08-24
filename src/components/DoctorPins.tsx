"use client";

import { useEffect, useState, useTransition } from "react";
import { getDefaultPinDoctors, resetDoctorPin } from "@/app/actions/queue";
import { Alert, Button, Card, Field } from "./ui";

/*
  Doctors ship on PIN 1234, and a shared default is the same as no PIN at
  all: any doctor can sign in as any other and their consultation timestamps
  become worthless.

  This panel exists to make that state visible rather than to nag quietly in
  a corner of the doctor's own screen, because the person who fixes it is the
  administrator, not the doctor who is locked out.

  Resetting deliberately does NOT ask for the current PIN — the admin does
  not know it, and this is the locked-out path. The audit log records who did
  it, which under a shared admin login is the whole accountability story.
*/

export function DoctorPins() {
  const [pending, setPending] = useState<{ id: number; name: string }[] | null>(
    null,
  );
  const [target, setTarget] = useState<{ id: number; name: string } | null>(
    null,
  );
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();

  const refresh = () =>
    start(async () => setPending(await getDefaultPinDoctors()));

  useEffect(refresh, []);

  const submit = () => {
    if (!target) return;
    if (pin !== confirm) {
      setMsg({ ok: false, text: "The two PINs do not match." });
      return;
    }
    start(async () => {
      const res = await resetDoctorPin(target.id, pin);
      if (res.ok) {
        setMsg({ ok: true, text: `${target.name} has a new PIN.` });
        setTarget(null);
        setPin("");
        setConfirm("");
        setPending(await getDefaultPinDoctors());
      } else {
        setMsg({ ok: false, text: res.error });
      }
    });
  };

  if (pending === null) return null;

  return (
    <div className="mt-5 grid gap-3">
      <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-muted">
        Doctor PINs
      </h3>

      {msg && <Alert tone={msg.ok ? "ok" : "danger"}>{msg.text}</Alert>}

      {pending.length === 0 ? (
        <Alert tone="ok">
          Every doctor has changed their PIN from the default.
        </Alert>
      ) : (
        <Alert tone="danger">
          {pending.length === 1
            ? "One doctor is still on the default PIN 1234"
            : `${pending.length} doctors are still on the default PIN 1234`}
          . Until this is fixed, any of them can sign in as another, and the
          consultation times they record cannot be trusted. Change these before
          going live.
        </Alert>
      )}

      {pending.length > 0 && (
        <Card className="overflow-hidden">
          <ul>
            {pending.map((d) => (
              <li
                key={d.id}
                className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-2.5 last:border-0"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                  {d.name}
                </span>
                <Button
                  onClick={() => {
                    setTarget(d);
                    setPin("");
                    setConfirm("");
                    setMsg(null);
                  }}
                  disabled={busy}
                  className="h-9 shrink-0 px-4 text-xs"
                  style={{ minHeight: 36 }}
                >
                  Set PIN
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {target && (
        <Card className="grid gap-3 p-4">
          <p className="text-sm font-semibold">New PIN for {target.name}</p>
          <p className="text-sm text-muted">
            Tell them in person, not over WhatsApp. They can change it
            themselves afterwards from the doctor screen.
          </p>
          <Field label="New PIN" htmlFor="newpin">
            <input
              id="newpin"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              maxLength={8}
              className="w-full rounded-[var(--r-sm)] border border-[var(--line-strong)]
                bg-surface px-3 py-2.5 text-base tracking-[0.3em]"
            />
          </Field>
          <Field label="Repeat it" htmlFor="newpin2">
            <input
              id="newpin2"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ""))}
              maxLength={8}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              className="w-full rounded-[var(--r-sm)] border border-[var(--line-strong)]
                bg-surface px-3 py-2.5 text-base tracking-[0.3em]"
            />
          </Field>
          <div className="flex gap-2">
            <Button onClick={submit} disabled={busy || pin.length < 4}>
              Save PIN
            </Button>
            <Button
              onClick={() => setTarget(null)}
              disabled={busy}
              className="bg-sunken text-[var(--ink-2)]"
            >
              Cancel
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
