"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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

const LINKS = [
  { href: "/", label: "New Token", Icon: IconTicket },
  { href: "/queue", label: "Queue", Icon: IconStethoscope },
  { href: "/billing", label: "Billing", Icon: IconReceipt },
  { href: "/day-book", label: "Day Book", Icon: IconBook },
  { href: "/admin", label: "Admin", Icon: IconGear },
];

export function Nav({ seriesIds = [] }: { seriesIds?: number[] }) {
  const path = usePathname();
  const { usbReady } = usePrinter();

  // The waiting-room board is unattended and full-screen; navigation there
  // would only take space away from the token numbers.
  if (path.startsWith("/display")) return null;

  return (
    <nav className="no-print sticky top-0 z-20 border-b border-[var(--line)] bg-surface/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center gap-0.5 px-5">
        <span className="mr-5 hidden select-none items-center gap-2 py-3 text-[15px] font-bold tracking-tight sm:flex">
          <span
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--accent)] text-white"
            aria-hidden
          >
            <IconMedical className="h-4 w-4" />
          </span>
          Reception
        </span>

        {LINKS.map(({ href, label, Icon }) => {
          const active = href === "/" ? path === "/" : path.startsWith(href);
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

        {/* Status chips, always visible and grouped right. Reception should
            never have to guess whether their work is saved or whether a slip
            will actually reach paper. */}
        <span className="ml-auto flex items-center gap-2">
        <SyncStatus seriesIds={seriesIds} />
        <Link
          href="/admin"
          title={
            usbReady
              ? "Printer connected — slips print directly"
              : "No USB printer — the browser print dialog will open. Click to set up."
          }
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5
            text-xs font-semibold transition-colors ${
              usbReady
                ? "bg-[var(--ok-soft)] text-[var(--ok)]"
                : "bg-sunken text-muted hover:bg-[var(--hover)]"
            }`}
        >
          <IconPrinter className="h-4 w-4" />
          <span className="hidden sm:inline">
            {usbReady ? "Printer ready" : "Printer not set up"}
          </span>
        </Link>
        </span>
      </div>
    </nav>
  );
}
