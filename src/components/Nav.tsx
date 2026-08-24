"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  IconBook,
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
  Navigation, scoped to who is actually standing in front of the screen.

  This used to be one bar of seven destinations shown on every route, and it
  was wrong in a way that got worse the busier the clinic got. Three separate
  problems, all from treating one app as one audience:

    1. HICK'S LAW. Reception's job at the token screen is "make a token".
       Putting seven equal-weight choices above that one task charges a
       decision on every glance, all day, for a decision that was already
       made when they walked to the desk.

    2. WRONG AUDIENCE. /doctor and /display were in reception's bar, but
       neither is ever opened from the reception desk — the doctor's screen
       runs on a tablet in a consulting room and the board runs on a wall TV.
       They were listed where they could not be used and absent where they
       could.

    3. NO SENSE OF PLACE. A doctor signing in saw the same chrome as the
       billing clerk, so nothing on screen said whose machine this was.

  So the bar now asks who is here, and shows only that:

    DESK    Token, Queue, Billing, Day Book — reception's day, in order.
            Admin is a single icon: needed rarely, and never mid-task.
    ROOM    The doctor's own screen. No desk links at all; a doctor with a
            patient in front of them has no use for Day Book.
    BOARD   Nothing. The waiting-room TV is unattended and full-screen.

  The screens that are not on the bar are reachable from Admin, which is
  where "set up another screen" belongs — a setup task, done once, not a
  destination reception navigates to hourly.
*/

/** Reception's day, in the order they actually do it. */
const DESK = [
  { href: "/", label: "New Token", Icon: IconTicket },
  { href: "/queue", label: "Queue", Icon: IconStethoscope },
  { href: "/billing", label: "Billing", Icon: IconReceipt },
  { href: "/day-book", label: "Day Book", Icon: IconBook },
];

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path.startsWith(href);
}

export function Nav({ seriesIds = [] }: { seriesIds?: number[] }) {
  const path = usePathname();
  const { usbReady } = usePrinter();
  const [open, setOpen] = useState(false);

  /*
    The board and the doctor's screen own their own chrome.

    Both are single-purpose screens on their own hardware, and both render a
    header that says where you are — see DoctorHeader in the doctor route.
    A shared bar here would only take space from the thing each screen
    exists to show.
  */
  if (path.startsWith("/display") || path.startsWith("/doctor")) return null;

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
            four tabs plus status chips cannot fit a phone without becoming
            targets too small to hit. */}
        <div className="hidden items-center gap-0.5 md:flex">
          {DESK.map(({ href, label, Icon }) => {
            const active = isActive(path, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
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
            // A real target, not a decorative chip: it is a link to printer
            // setup, and on a tablet a 28px-tall control is a miss waiting to
            // happen.
            style={{ minHeight: 44 }}
            className={`hidden items-center gap-1.5 rounded-full px-3
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

          {/*
            Admin as an icon, not a tab.

            It is a settings destination — visited when something needs
            configuring, never as part of serving a patient. Giving it equal
            weight to Queue implied it was part of the daily loop.
          */}
          <Link
            href="/admin"
            title="Settings"
            aria-label="Settings"
            aria-current={isActive(path, "/admin") ? "page" : undefined}
            className={`hidden h-11 w-11 items-center justify-center rounded-[10px]
              transition-colors md:inline-flex ${
                isActive(path, "/admin")
                  ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "text-muted hover:bg-[var(--hover)] hover:text-[var(--accent)]"
              }`}
          >
            <IconGear className="h-[18px] w-[18px]" />
          </Link>

          <ThemeToggle />

          {/* Menu button — phone only. */}
          <button
            type="button"
            aria-expanded={open}
            aria-label="Menu"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex h-11 w-11 items-center justify-center rounded-[10px]
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
            {[...DESK, { href: "/admin", label: "Settings", Icon: IconGear }].map(
              ({ href, label, Icon }) => {
                const active = isActive(path, href);
                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => setOpen(false)}
                    aria-current={active ? "page" : undefined}
                    // min-height rather than padding alone: a nav row on a
                    // phone is a thumb target, and Fitts' Law is unforgiving
                    // about the ones people hit in a hurry.
                    className={`flex min-h-[48px] items-center gap-3 rounded-[var(--r)] px-3 py-3
                    text-base font-semibold transition-colors ${
                      active
                        ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                        : "text-[var(--ink-2)] hover:bg-[var(--hover)]"
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                    {label}
                  </Link>
                );
              },
            )}
          </div>
          <div className="mt-3 border-t border-[var(--line)] pt-3">
            <SyncStatus seriesIds={seriesIds} />
          </div>
        </div>
      )}
    </nav>
  );
}
