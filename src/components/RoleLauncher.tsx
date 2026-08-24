"use client";

import Link from "next/link";
import { IconChevron, IconDisplay, IconStethoscope } from "@/components/icons";

/*
  The two screens that run somewhere other than this desk.

  These exist because a doctor picking up their own tablet, or a staff member
  setting up the waiting-room TV, previously had to be TOLD a URL. That is a
  recall task, and recall is the thing interfaces are supposed to remove:
  put the destination on screen and it becomes recognition instead.

  Deliberately at the bottom of the reception screen and visually quieter
  than the token form. Reception uses this once a day at most; making it
  compete with the primary task would be a worse trade than the one it fixes.

  Painted in NEUTRAL ink rather than the accent, and that is load-bearing:
  this block sits outside the [data-mode] wrapper, so an accent-coloured card
  here would stay blue while the rest of the screen turned red for an
  emergency — reading as a component that had failed to repaint. It is not
  part of the visit-type task, so it takes no colour from it.
*/
export function RoleLauncher() {
  const items = [
    {
      href: "/doctor",
      Icon: IconStethoscope,
      title: "Doctor console",
      body: "Sign in with a PIN to run your own queue from a phone or tablet.",
      newTab: false,
    },
    {
      href: "/display",
      Icon: IconDisplay,
      title: "Waiting-room screen",
      body: "The full-screen board with the spoken call. Open on the TV.",
      newTab: true,
    },
  ];

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em] text-muted">
        Other screens
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {items.map(({ href, Icon, title, body, newTab }) => (
          <Link
            key={href}
            href={href}
            // The TV opens in its own tab so the desk does not lose the
            // token form it was in the middle of.
            target={newTab ? "_blank" : undefined}
            rel={newTab ? "noreferrer" : undefined}
            className="group flex items-center gap-4 rounded-[var(--r-lg)] border border-[var(--line)]
              bg-[var(--surface)] p-4 shadow-[var(--shadow)] transition-all
              hover:-translate-y-0.5 hover:border-[var(--line-strong)] hover:shadow-[var(--shadow-md)]"
          >
            <span
              aria-hidden
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px]
                bg-sunken text-[var(--ink-2)] transition-colors
                group-hover:bg-[var(--ink-2)] group-hover:text-[var(--surface)]"
            >
              <Icon className="h-[22px] w-[22px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-bold">{title}</span>
              <span className="block text-sm text-muted">{body}</span>
            </span>
            <IconChevron
              className="h-5 w-5 shrink-0 text-muted transition-transform group-hover:translate-x-0.5"
            />
          </Link>
        ))}
      </div>
    </section>
  );
}
