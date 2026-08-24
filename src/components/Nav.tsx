"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  IconBook,
  IconDisplay,
  IconGear,
  IconMedical,
  IconPrinter,
  IconReceipt,
  IconStethoscope,
  IconTicket,
} from "@/components/icons";
import { usePrinter } from "@/lib/use-printer";
import { SyncStatus } from "@/components/SyncStatus";
import { ThemeToggle } from "@/components/ThemeToggle";

/*
  Navigation.

  Two groups, because they are two different jobs and mixing them made the
  bar read as one undifferentiated row of five:

    DESK    — what reception does all day, in the order they do it.
    ROOMS   — the two screens that run somewhere else in the building.

  /doctor and /display were previously reachable only by typing the URL,
  which meant nobody found them. Hick's Law cuts both ways: hiding a
  destination does not reduce choice, it just converts a decision into a
  memory test.
*/

const DESK = [
  { href: "/", label: "New Token", Icon: IconTicket },
  { href: "/queue", label: "Queue", Icon: IconStethoscope },
  { href: "/billing", label: "Billing", Icon: IconReceipt },
  { href: "/day-book", label: "Day Book", Icon: IconBook },
  { href: "/admin", label: "Admin", Icon: IconGear },
];

const ROOMS = [
  { href: "/doctor", label: "Doctor", Icon: IconStethoscope },
  { href: "/display", label: "Display", Icon: IconDisplay },
];

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path.startsWith(href);
}

export function Nav({ seriesIds = [] }: { seriesIds?: number[] }) {
  const path = usePathname();
  const { usbReady } = usePrinter();
  const [open, setOpen] = useState(false);

  // The waiting-room board is unattended and full-screen; navigation there
  // would only take space away from the token numbers.
  if (path.startsWith("/display")) return null;

  /*
    The doctor's screen keeps the nav but drops the desk links.

    A doctor on a phone in their room has no use for Billing or Day Book, and
    every extra target is one more thing between them and the queue. They get
    a way back to the desk and nothing else.
  */
  const doctorView = path.startsWith("/doctor");
  const links = doctorView ? ROOMS : [...DESK, ...ROOMS];

  return (
    <nav
      className="no-print sticky top-0 z-20 border-b border-[var(--line)]
        bg-[var(--surface)]/85 backdrop-blur-md"
    >
      <div className="mx-auto flex max-w-6xl items-center gap-0.5 px-4 sm:px-5">
        <Link
          href="/"
          className="mr-4 flex select-none items-center gap-2 py-3 text-[15px] font-bold tracking-tight"
        >
          <span
            className="flex h-8 w-8 items-center justify-center rounded-[10px]
              bg-gradient-to-br from-[var(--accent-2)] to-[var(--accent)] text-white
              shadow-[var(--glow)]"
            aria-hidden
          >
            <IconMedical className="h-[18px] w-[18px]" />
          </span>
          <span className="hidden sm:inline">Reception</span>
        </Link>

        {/* Desktop bar. Below `md` this collapses into the sheet below —
            five tabs plus status chips cannot fit a phone without becoming
            targets too small to hit. */}
        <div className="hidden items-center gap-0.5 md:flex">
          {links.map(({ href, label, Icon }) => {
            const active = isActive(path, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                target={href === "/display" ? "_blank" : undefined}
                className={`relative inline-flex items-center gap-2 rounded-t-[8px] px-3.5 py-3.5
                  text-sm font-semibold transition-colors ${
                    active
                      ? "text-[var(--accent)]"
                      : "text-muted hover:bg-[var(--hover)] hover:text-[var(--accent)]"
                  }`}
              >
                <Icon className="h-[18px] w-[18px]" />
                {label}
                {active && (
                  <span className="absolute inset-x-2 -bottom-px h-[3px] rounded-full bg-[var(--accent)]" />
                )}
              </Link>
            );
          })}
        </div>

        {/* Status chips, always visible and grouped right. Reception should
            never have to guess whether their work is saved or whether a slip
            will actually reach paper. */}
        <span className="ml-auto flex items-center gap-2">
          <span className="hidden sm:contents">
            <SyncStatus seriesIds={seriesIds} />
          </span>

          <Link
            href="/admin"
            title={
              usbReady
                ? "Printer connected — slips print directly"
                : "No USB printer — the browser print dialog will open. Click to set up."
            }
            className={`hidden items-center gap-1.5 rounded-full px-3 py-1.5
              text-xs font-semibold transition-colors sm:inline-flex ${
                usbReady
                  ? "bg-[var(--ok-soft)] text-[var(--ok)]"
                  : "bg-sunken text-muted hover:bg-[var(--hover)]"
              }`}
          >
            <IconPrinter className="h-4 w-4" />
            <span className="hidden lg:inline">
              {usbReady ? "Printer ready" : "Printer not set up"}
            </span>
          </Link>

          <ThemeToggle />

          {/* Menu button — phone only. */}
          <button
            type="button"
            aria-expanded={open}
            aria-label="Menu"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-[10px]
              border border-[var(--line-strong)] text-[var(--ink-2)] md:hidden"
          >
            <span aria-hidden className="text-lg leading-none">
              {open ? "✕" : "☰"}
            </span>
          </button>
        </span>
      </div>

      {open && (
        <div className="animate-rise border-t border-[var(--line)] bg-[var(--surface)] p-3 md:hidden">
          <div className="grid gap-1">
            {links.map(({ href, label, Icon }) => {
              const active = isActive(path, href);
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setOpen(false)}
                  target={href === "/display" ? "_blank" : undefined}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-3 rounded-[var(--r)] px-3 py-3 text-base
                    font-semibold transition-colors ${
                      active
                        ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                        : "text-[var(--ink-2)] hover:bg-[var(--hover)]"
                    }`}
                >
                  <Icon className="h-5 w-5" />
                  {label}
                </Link>
              );
            })}
          </div>
          <div className="mt-3 border-t border-[var(--line)] pt-3">
            <SyncStatus seriesIds={seriesIds} />
          </div>
        </div>
      )}
    </nav>
  );
}
