"use client";

import { forwardRef, useState } from "react";
import { IconEye, IconEyeOff, IconLock } from "@/components/icons";

/*
  The PIN box, shared by all three sign-in screens.

  It exists because the three had drifted into three slightly different
  inputs, and a fix applied to one silently left the others wrong — which is
  exactly what happened to the icon overlap.

  The reveal toggle is not a convenience. These are shared counter machines
  with a keypad-sized PIN, typed under a queue; without a way to check what
  was entered, a mistyped digit is indistinguishable from a wrong PIN, and
  the lockout counts both the same.
*/
type Props = {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onEnter?: () => void;
  autoFocus?: boolean;
  maxLength?: number;
};

export const PinField = forwardRef<HTMLInputElement, Props>(function PinField(
  { id, label, value, onChange, onEnter, autoFocus, maxLength = 6 },
  ref,
) {
  const [shown, setShown] = useState(false);

  return (
    <>
      <label
        htmlFor={id}
        className="mb-2 block text-xs font-semibold uppercase tracking-wide text-muted"
      >
        {label}
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
          <IconLock className="h-[18px] w-[18px]" />
        </span>

        <input
          id={id}
          ref={ref}
          type={shown ? "text" : "password"}
          inputMode="numeric"
          autoComplete="off"
          autoFocus={autoFocus}
          maxLength={maxLength}
          value={value}
          placeholder="••••"
          onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") onEnter?.();
          }}
          /*
            pr-12 reserves the reveal button's column so the digits never run
            underneath it, the same way pl-10 reserves the lock's.
          */
          className="w-full rounded-[var(--r)] border-2 border-[var(--line)] bg-[var(--surface)]
            py-3 pl-10 pr-12 text-lg tracking-[0.3em] outline-none transition-colors
            focus:border-[var(--accent)]"
          style={{ minHeight: 48 }}
        />

        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          // Not a submit target: Enter belongs to the PIN, and a stray tap
          // here must never send a half-typed one.
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
    </>
  );
});
