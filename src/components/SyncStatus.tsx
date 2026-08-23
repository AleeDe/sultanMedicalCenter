"use client";

import { useSync } from "@/lib/offline/sync";
import { IconCheck, IconCross } from "@/components/icons";

/*
  The offline status chip.

  Reception must never have to guess whether their work is saved. This sits
  in the nav permanently and answers that without being asked — quiet when
  everything is fine, loud only when it needs a decision.

  The number that matters during an outage is not "how many are pending" but
  "how many tokens can I still issue", so that is what gets the space.
*/
export function SyncStatus({ seriesIds }: { seriesIds: number[] }) {
  const s = useSync(seriesIds);

  // Order matters: the worst state wins the chip.
  if (!s.online && s.remaining === 0) {
    return (
      <Chip tone="danger" title="No connection and no token numbers left">
        <IconCross className="h-3.5 w-3.5" />
        Cannot issue tokens
      </Chip>
    );
  }

  if (!s.online) {
    return (
      <Chip
        tone={s.leaseLow ? "danger" : "warn"}
        title={
          s.leaseLow
            ? "Running out of reserved numbers — reconnect soon"
            : "Working offline. Tokens are saved and will sync automatically."
        }
      >
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
        </span>
        Offline · {s.remaining} left
        {s.pending > 0 && <span className="opacity-75">· {s.pending} queued</span>}
      </Chip>
    );
  }

  if (s.syncing || s.pending > 0) {
    return (
      <Chip tone="accent" title="Sending queued tokens to the server">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
        Syncing {s.pending > 0 ? s.pending : ""}
      </Chip>
    );
  }

  if (s.leaseLow) {
    // Online but low: harmless right now, and a warning worth acting on
    // before the connection drops rather than after.
    return (
      <Chip tone="warn" title="Reserving more token numbers">
        Topping up…
      </Chip>
    );
  }

  return (
    <Chip tone="ok" title="Connected. Everything is saved.">
      <IconCheck className="h-3.5 w-3.5" />
      Online
    </Chip>
  );
}

function Chip({
  tone,
  title,
  children,
}: {
  tone: "ok" | "warn" | "danger" | "accent";
  title: string;
  children: React.ReactNode;
}) {
  const tones = {
    ok: "bg-[var(--ok-soft)] text-[var(--ok)]",
    warn: "bg-[var(--gold-soft)] text-[var(--gold)]",
    danger: "bg-[var(--danger-soft)] text-[var(--danger)]",
    accent: "bg-[var(--accent-soft)] text-[var(--accent)]",
  };
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5
        text-xs font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
