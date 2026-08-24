"use client";

import { forwardRef } from "react";

/* Shared primitives. Sizing here encodes the Fitts's Law rules once so no
   screen has to remember them. */

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "ok" | "danger";
  size?: "md" | "lg" | "xl";
};

/*
  Hover has to be visible across a lit reception counter, so every variant
  moves BOTH colour and elevation — a 2% tint alone reads as nothing.
*/
const VARIANT: Record<NonNullable<BtnProps["variant"]>, string> = {
  primary:
    "bg-[var(--accent)] text-[var(--accent-ink)] border border-transparent shadow-sm hover:brightness-[1.15] hover:shadow-[var(--shadow-lg)] active:brightness-95",
  secondary:
    "bg-[var(--surface)] text-ink border border-[var(--line-strong)] hover:bg-[var(--hover)] hover:border-[var(--hover-line)] hover:shadow-[var(--shadow)] active:bg-[var(--line)]",
  ghost:
    "bg-transparent text-[var(--ink-2)] border border-transparent hover:bg-[var(--hover)] hover:text-[var(--ink)]",
  ok: "bg-[var(--ok)] text-[var(--accent-ink)] border border-transparent shadow-sm hover:brightness-[1.2] hover:shadow-[var(--shadow-lg)] active:brightness-95",
  danger:
    "bg-[var(--surface)] text-[var(--danger)] border border-[var(--line-strong)] hover:bg-[var(--danger-soft)] hover:border-[var(--danger)] hover:shadow-[var(--shadow)]",
};

const SIZE: Record<NonNullable<BtnProps["size"]>, string> = {
  md: "h-11 px-4 text-sm rounded-[var(--r-sm)]",
  lg: "h-[52px] px-6 text-base rounded-[var(--r)]",
  xl: "h-[64px] px-8 text-lg rounded-[var(--r)]",
};

export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button(
  { variant = "secondary", size = "md", className = "", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      className={`inline-flex items-center justify-center gap-2 font-semibold
        transition-[filter,background-color,border-color,transform,box-shadow] duration-100
        active:translate-y-px disabled:active:translate-y-0
        disabled:!bg-[var(--line)] disabled:!text-[#94a1b0] disabled:!shadow-none
        disabled:!border-transparent disabled:hover:!brightness-100
        ${VARIANT[variant]} ${SIZE[size]} ${className}`}
    />
  );
});

export function Card({
  className = "",
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={`rounded-[var(--r-lg)] border border-[var(--line)] bg-surface
        shadow-[var(--shadow)] ${className}`}
    >
      {children}
    </div>
  );
}

/** Section label — quiet, uppercase, used to chunk a screen into groups. */
export function GroupLabel({
  step,
  children,
  hint,
}: {
  step?: number;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="mb-2.5 flex items-baseline gap-2">
      {step != null && (
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full
            bg-[var(--accent-soft)] text-[11px] font-bold text-[var(--accent)]"
        >
          {step}
        </span>
      )}
      <span className="text-[13px] font-semibold uppercase tracking-[0.06em] text-muted">
        {children}
      </span>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}

export function Field({
  label,
  hint,
  required,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1.5 flex items-baseline gap-1.5 text-[13px] font-medium text-[var(--ink-2)]"
      >
        {label}
        {required && <span className="text-[var(--danger)]">*</span>}
        {hint && <span className="ml-auto text-xs font-normal text-muted">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

/** Segmented control. Options never reorder — position is memorised. */
/*
  Segmented control.

  The selected pill is filled with the accent colour, not merely raised on a
  white background — an earlier version used white-on-grey and the selection
  was invisible against a white card, so an unselected control read as though
  a choice had already been made. Selection must never be conveyed by
  elevation alone.
*/
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
  size = "md",
}: {
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (v: T) => void;
  label: string;
  size?: "md" | "lg";
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-grid w-full gap-1 rounded-[var(--r-sm)] border border-[var(--line-strong)]
        bg-sunken p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0,1fr))` }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={`rounded-[6px] font-semibold transition-all duration-100
              ${size === "lg" ? "h-10 text-[15px]" : "h-9 text-sm"}
              ${
                on
                  ? "bg-[var(--accent)] text-[var(--accent-ink)] shadow-[var(--shadow)]"
                  : "text-[var(--ink-2)] hover:bg-[var(--surface)] hover:text-[var(--accent)] hover:shadow-[var(--shadow)] active:scale-[0.97]"
              }`}
            style={{ minHeight: size === "lg" ? 40 : 36 }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "ok" | "danger" | "gold" | "accent";
  children: React.ReactNode;
}) {
  const tones = {
    neutral: "bg-sunken text-[var(--ink-2)] border-[var(--line)]",
    ok: "bg-[var(--ok-soft)] text-[var(--ok)] border-transparent",
    danger: "bg-[var(--danger-soft)] text-[var(--danger)] border-transparent",
    gold: "bg-[var(--gold-soft)] text-[var(--gold)] border-transparent",
    accent: "bg-[var(--accent-soft)] text-[var(--accent)] border-transparent",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5
        text-xs font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Alert({
  tone = "danger",
  children,
}: {
  tone?: "danger" | "ok" | "info";
  children: React.ReactNode;
}) {
  const tones = {
    danger: "border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]",
    ok: "border-transparent bg-[var(--ok-soft)] text-[var(--ok)]",
    info: "border-[var(--line)] bg-sunken text-[var(--ink-2)]",
  };
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`animate-rise rounded-[var(--r-sm)] border px-3.5 py-2.5 text-sm
        font-medium ${tones[tone]}`}
    >
      {children}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-6 py-14 text-center text-sm text-muted">{children}</div>
  );
}

/**
 * A doctor's initials, used wherever a doctor is listed.
 *
 * Deliberately not a generic stethoscope icon: with four doctors on one
 * screen, an identical glyph on every row carries no information and the eye
 * has to fall through to the name every time. Initials are distinguishable in
 * peripheral vision, which is what makes a list scannable.
 */
export function DoctorAvatar({
  name,
  className = "",
  tone = "soft",
}: {
  name: string;
  className?: string;
  tone?: "soft" | "accent";
}) {
  const initials = name
    .replace(/^Dr\.?\s*/i, "")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-[10px] font-bold tracking-[0.02em] ${
        tone === "accent"
          ? "bg-[var(--accent)] text-[var(--accent-ink)]"
          : "bg-[var(--accent-soft)] text-[var(--accent)]"
      } ${className || "h-10 w-10 text-[13px]"}`}
    >
      {initials}
    </span>
  );
}
