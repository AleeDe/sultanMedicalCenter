"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import {
  addItem,
  findVisit,
  getLedger,
  markItemPaid,
  removeItem,
  settleVisit,
  type LedgerItem,
  type ServiceRow,
  type VisitLedger,
} from "@/app/actions/ledger";
import { BillSlip } from "@/components/BillSlip";
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  GroupLabel,
} from "@/components/ui";
import {
  IconAmbulance,
  IconArrowLeft,
  IconCheck,
  IconCross,
  IconPrinter,
  IconSearch,
  IconStar,
} from "@/components/icons";
import { TIER_LABEL } from "@/lib/loyalty";
import { billSlipBytes } from "@/lib/receipts";
import { usePrinter } from "@/lib/use-printer";
import type { ClinicSetting, Staff } from "@/lib/types";

type OpenVisit = {
  visit_id: number;
  display_no: string;
  patient_name: string;
  mrn: string;
  is_emergency: boolean;
  balance: string;
};

/*
  THE VISIT LEDGER — the answer to "bill upfront or bill at the end?".

  Neither: the consultation fee is collected at the counter, then every lab
  test or procedure is APPENDED here as the visit progresses. Each line is
  independently PAID or PENDING, so the lab can take payment before drawing a
  sample without forcing a whole-visit settlement. One final receipt closes it.

  The screen is a running tab, and it is shaped like one: the catalogue to add
  from on the left, the bill itself on the right, always visible, always
  totalling. The receptionist never has to hold a number in her head.
*/
export function BillingScreen({
  services,
  openVisits,
  clinic,
  staff,
}: {
  services: ServiceRow[];
  openVisits: OpenVisit[];
  clinic: ClinicSetting;
  staff: Staff[];
}) {
  const [ledger, setLedger] = useState<VisitLedger | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [staffId, setStaffId] = useState<number | null>(staff[0]?.id ?? null);
  const [printing, setPrinting] = useState(false);
  const [pending, start] = useTransition();
  const searchRef = useRef<HTMLInputElement>(null);

  const stopPrinting = useCallback(() => setPrinting(false), []);

  useEffect(() => {
    if (!ledger) searchRef.current?.focus();
  }, [ledger]);

  function search(q: string) {
    setError(null);
    start(async () => {
      const found = await findVisit(q);
      if (!found) {
        setError(`No visit found for “${q}”.`);
        return;
      }
      setLedger(found);
      setQuery("");
    });
  }

  function open(visitId: number) {
    setError(null);
    start(async () => setLedger(await getLedger(visitId)));
  }

  function apply(res: Awaited<ReturnType<typeof addItem>>) {
    if (res.ok) {
      setLedger(res.data);
      setError(null);
    } else setError(res.error);
  }

  /* ------------------------------------------------------ visit picker */
  if (!ledger) {
    return (
      <div className="mx-auto max-w-4xl px-5 py-5">
        <Header title="Billing" staff={staff} staffId={staffId} onStaff={setStaffId} />

        <Card className="mb-5 p-4">
          <label
            htmlFor="tok"
            className="mb-1.5 block text-[13px] font-medium text-[var(--ink-2)]"
          >
            Open a visit by token number
          </label>
          <div className="flex gap-2">
            <input
              id="tok"
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && search(query)}
              placeholder="NORM-00042"
              className="tnum h-12 text-lg font-semibold tracking-wide"
            />
            <Button
              variant="primary"
              size="lg"
              onClick={() => search(query)}
              disabled={pending || !query.trim()}
              className="shrink-0"
            >
              <IconSearch className="h-[18px] w-[18px]" />
              Open
            </Button>
          </div>
          {error && (
            <div className="mt-2.5">
              <Alert>{error}</Alert>
            </div>
          )}
        </Card>

        <GroupLabel hint={`${openVisits.length} waiting`}>
          Today&apos;s open visits
        </GroupLabel>
        <Card className="overflow-hidden">
          {openVisits.length === 0 ? (
            <Empty>
              No open visits yet today. Issue a token to start one.
            </Empty>
          ) : (
            <ul>
              {openVisits.map((v) => (
                <li key={v.visit_id} className="border-b border-[var(--line)] last:border-0">
                  <button
                    onClick={() => open(v.visit_id)}
                    className="flex w-full items-center gap-3.5 px-4 py-3 text-left
                      transition-colors hover:bg-[var(--hover)]"
                  >
                    <TokenChip no={v.display_no} emergency={v.is_emergency} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">
                        {v.patient_name}
                      </span>
                      <span className="tnum text-xs text-muted">{v.mrn}</span>
                    </span>
                    {Number(v.balance) > 0 ? (
                      <Badge tone="danger">
                        Rs. {Number(v.balance).toFixed(0)} due
                      </Badge>
                    ) : (
                      <Badge tone="ok">Settled up</Badge>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    );
  }

  /* --------------------------------------------------------- the ledger */
  const closed = ledger.status === "CLOSED";
  const due = Number(ledger.balance);

  return (
    <div
      data-mode={ledger.is_emergency ? "emergency" : "normal"}
      className="mx-auto max-w-6xl px-5 py-5"
    >
      <Header
        title="Billing"
        staff={staff}
        staffId={staffId}
        onStaff={setStaffId}
        onBack={() => {
          setLedger(null);
          setError(null);
        }}
      />

      {/* Who am I billing — always the first thing on screen. */}
      <Card className="mb-4 flex flex-wrap items-center gap-4 p-4">
        <TokenChip no={ledger.display_no} emergency={ledger.is_emergency} large />
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-bold">{ledger.patient_name}</p>
          <p className="tnum truncate text-sm text-muted">
            {ledger.mrn} · {titleCase(ledger.gender)}
            {ledger.age_years != null ? ` · ${ledger.age_years}y` : ""}
            {ledger.phone ? ` · ${ledger.phone}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {ledger.tier !== "NEW" && (
            <Badge tone="gold">
              <IconStar className="h-3 w-3" />
              {TIER_LABEL[ledger.tier]}
            </Badge>
          )}
          {closed && (
            <Badge tone="ok">
              <IconCheck className="h-3.5 w-3.5" />
              Settled · {ledger.invoice_no}
            </Badge>
          )}
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
        {/* catalogue */}
        <div>
          {closed ? (
            <Card>
              <Empty>
                This visit is settled. Reopen is not possible — issue a new
                token if the patient returns.
              </Empty>
            </Card>
          ) : (
            <AddItemPanel
              services={services}
              disabled={pending}
              onAdd={(payload) =>
                start(async () =>
                  apply(await addItem({ ...payload, visitId: ledger.visit_id, staffId })),
                )
              }
            />
          )}
        </div>

        {/* the bill itself, sticky so the total is never scrolled away */}
        <aside className="lg:sticky lg:top-[76px] lg:self-start">
          <GroupLabel>The bill</GroupLabel>
          <Card className="overflow-hidden">
            <ItemList
              items={ledger.items}
              closed={closed}
              onPay={(id) =>
                start(async () =>
                  apply(await markItemPaid(id, ledger.visit_id, staffId)),
                )
              }
              onRemove={(id) =>
                start(async () =>
                  apply(await removeItem(id, ledger.visit_id, staffId)),
                )
              }
            />

            <div className="border-t border-[var(--line)] bg-sunken p-4">
              <div className="mb-1 flex items-baseline justify-between text-sm text-muted">
                <span>Paid</span>
                <span className="tnum font-medium">Rs. {ledger.paid}</span>
              </div>
              {due > 0 && (
                <div className="mb-1 flex items-baseline justify-between text-sm font-semibold text-[var(--danger)]">
                  <span>Outstanding</span>
                  <span className="tnum">Rs. {ledger.balance}</span>
                </div>
              )}
              <div className="mt-2 flex items-baseline justify-between border-t border-[var(--line)] pt-2.5">
                <span className="font-semibold">Total</span>
                <span className="tnum text-[26px] font-bold leading-none">
                  Rs. {ledger.total}
                </span>
              </div>

              <div className="mt-3.5">
                {closed ? (
                  <Button
                    variant="primary"
                    size="lg"
                    className="w-full"
                    onClick={() => setPrinting(true)}
                  >
                    <IconPrinter className="h-[18px] w-[18px]" />
                    Print Receipt
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="primary"
                      size="xl"
                      className="w-full"
                      disabled={pending || ledger.items.length === 0}
                      onClick={() =>
                        start(async () => {
                          const res = await settleVisit(ledger.visit_id, staffId);
                          if (res.ok) {
                            setLedger(res.data);
                            setPrinting(true);
                          } else setError(res.error);
                        })
                      }
                    >
                      {pending ? "Working…" : "Settle & Print Bill"}
                    </Button>
                    {due > 0 && (
                      <p className="mt-2 text-center text-xs text-muted">
                        Collect Rs. {ledger.balance} before settling
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </Card>

          {error && (
            <div className="mt-3">
              <Alert>{error}</Alert>
            </div>
          )}
        </aside>
      </div>

      {printing && (
        <PrintPortal ledger={ledger} clinic={clinic} onDone={stopPrinting} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ catalogue */

function AddItemPanel({
  services,
  disabled,
  onAdd,
}: {
  services: ServiceRow[];
  disabled: boolean;
  onAdd: (p: {
    serviceId: number | null;
    name: string;
    price: number;
    qty: number;
    discount: number;
    payNow: boolean;
  }) => void;
}) {
  const categories = Array.from(new Set(services.map((s) => s.category)));
  const [tab, setTab] = useState(categories[0] ?? "LAB");
  const [q, setQ] = useState("");

  // Search spans every category, because the receptionist knows the test name,
  // not which bucket it was filed under.
  const visible = q.trim()
    ? services.filter((s) =>
        (s.name + " " + s.code).toLowerCase().includes(q.trim().toLowerCase()),
      )
    : services.filter((s) => s.category === tab);

  return (
    <div>
      <GroupLabel>Add to the bill</GroupLabel>
      <Card className="overflow-hidden">
        <div className="border-b border-[var(--line)] p-3">
          <div className="relative">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-muted" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search all tests and services…"
              className="!pl-10"
            />
          </div>

          {!q.trim() && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {categories.map((c) => (
                <button
                  key={c}
                  onClick={() => setTab(c)}
                  aria-pressed={tab === c}
                  className={`h-9 rounded-full px-3.5 text-[13px] font-semibold
                    transition-colors ${
                      tab === c
                        ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                        : "bg-sunken text-muted hover:text-[var(--ink-2)]"
                    }`}
                  style={{ minHeight: 44 }}
                >
                  {titleCase(c)}
                </button>
              ))}
            </div>
          )}
        </div>

        {visible.length === 0 ? (
          <Empty>No matching test or service.</Empty>
        ) : (
          <ul className="max-h-[520px] overflow-y-auto">
            {visible.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-3 border-b border-[var(--line)]
                  px-4 py-2.5 last:border-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {s.name}
                  </span>
                  <span className="tnum text-xs text-muted">
                    {s.code}
                    {q.trim() ? ` · ${titleCase(s.category)}` : ""}
                  </span>
                </span>
                <span className="tnum shrink-0 text-sm font-bold">
                  Rs. {Number(s.price).toFixed(0)}
                </span>
                {/* Two buttons rather than a checkbox and a submit: "will they
                    pay now?" is the real decision, made once, in place. */}
                <Button
                  variant="ok"
                  disabled={disabled}
                  onClick={() =>
                    onAdd({
                      serviceId: s.id,
                      name: s.name,
                      price: Number(s.price),
                      qty: 1,
                      discount: 0,
                      payNow: true,
                    })
                  }
                  className="shrink-0"
                >
                  Paid
                </Button>
                <Button
                  disabled={disabled}
                  onClick={() =>
                    onAdd({
                      serviceId: s.id,
                      name: s.name,
                      price: Number(s.price),
                      qty: 1,
                      discount: 0,
                      payNow: false,
                    })
                  }
                  className="shrink-0"
                >
                  Later
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/* ----------------------------------------------------------- bill lines */

function ItemList({
  items,
  closed,
  onPay,
  onRemove,
}: {
  items: LedgerItem[];
  closed: boolean;
  onPay: (id: number) => void;
  onRemove: (id: number) => void;
}) {
  if (items.length === 0) {
    return <Empty>Nothing billed yet. Add a test or service.</Empty>;
  }

  return (
    <ul className="max-h-[420px] overflow-y-auto">
      {items.map((it) => (
        <li
          key={it.id}
          className="flex items-center gap-2.5 border-b border-[var(--line)] px-4 py-2.5 last:border-0"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">
              {it.name_snapshot}
            </span>
            <span className="tnum text-xs text-muted">
              {it.qty} × {Number(it.unit_price_snapshot).toFixed(0)}
              {Number(it.discount) > 0 &&
                ` · less ${Number(it.discount).toFixed(0)}`}
            </span>
          </span>

          <span className="tnum shrink-0 text-sm font-bold">
            {Number(it.line_total).toFixed(0)}
          </span>

          {it.status === "PAID" ? (
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full
                bg-[var(--ok-soft)] text-[var(--ok)]"
              title="Paid"
            >
              <IconCheck className="h-4 w-4" />
            </span>
          ) : closed ? null : (
            <Button
              variant="ok"
              onClick={() => onPay(it.id)}
              className="h-9 shrink-0 px-3 text-xs"
              style={{ minHeight: 44 }}
            >
              Take payment
            </Button>
          )}

          {/* Destructive: small, last, visually quiet, and confirmed. Fitts's
              Law used deliberately against accidental clicks. */}
          {!closed && (
            <button
              onClick={() => {
                if (confirm(`Remove “${it.name_snapshot}” from this bill?`))
                  onRemove(it.id);
              }}
              aria-label={`Remove ${it.name_snapshot}`}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--r-sm)]
                text-muted transition-colors hover:bg-[var(--danger-soft)]
                hover:text-[var(--danger)]"
              style={{ minHeight: 44 }}
            >
              <IconCross className="h-4 w-4" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/* --------------------------------------------------------------- pieces */

function TokenChip({
  no,
  emergency,
  large,
}: {
  no: string;
  emergency: boolean;
  large?: boolean;
}) {
  return (
    <span
      className={`tnum inline-flex shrink-0 items-center gap-1.5 rounded-[10px] font-mono
        font-bold ${large ? "px-3 py-2 text-lg" : "px-2.5 py-1.5 text-sm"} ${
          emergency
            ? "bg-[var(--danger-soft)] text-[var(--danger)]"
            : "bg-[var(--accent-soft)] text-[var(--accent)]"
        }`}
    >
      {emergency && <IconAmbulance className={large ? "h-5 w-5" : "h-4 w-4"} />}
      {no}
    </span>
  );
}

function PrintPortal({
  ledger,
  clinic,
  onDone,
}: {
  ledger: VisitLedger;
  clinic: ClinicSetting;
  onDone: () => void;
}) {
  const printer = usePrinter();

  /*
    Same two traps as the token slip: `printer` is a fresh object each render,
    and Strict Mode double-mounts effects in development. Cancelling on
    cleanup, or latching a plain "fired" ref, both ended up printing nothing.
  */
  const { print } = printer;
  const printedFor = useRef<number | null>(null);

  useEffect(() => {
    const done = () => onDone();
    window.addEventListener("afterprint", done);

    if (printedFor.current !== ledger.visit_id) {
      printedFor.current = ledger.visit_id;
      void (async () => {
        // USB first — no driver, no dialog. Only the browser path needs the
        // afterprint handshake, so USB closes the portal itself.
        const used = await print(billSlipBytes(ledger, clinic), () =>
          window.print(),
        );
        if (used === "usb") onDone();
      })();
    }

    return () => window.removeEventListener("afterprint", done);
  }, [ledger, clinic, onDone, print]);

  return createPortal(
    <div id="print-root">
      <BillSlip ledger={ledger} clinic={clinic} />
    </div>,
    document.body,
  );
}

function Header({
  title,
  staff,
  staffId,
  onStaff,
  onBack,
}: {
  title: string;
  staff: Staff[];
  staffId: number | null;
  onStaff: (id: number) => void;
  onBack?: () => void;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        {onBack && (
          <Button onClick={onBack} aria-label="Back to visit list">
            <IconArrowLeft className="h-[18px] w-[18px]" />
            Back
          </Button>
        )}
        <h1 className="text-[22px] font-bold tracking-tight">{title}</h1>
      </div>
      <label className="flex shrink-0 items-center gap-2 text-sm text-muted">
        <span className="hidden sm:inline">Counter</span>
        <select
          value={staffId ?? ""}
          onChange={(e) => onStaff(Number(e.target.value))}
          className="h-10 w-auto min-w-[130px] font-medium"
        >
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function titleCase(s: string) {
  return s.charAt(0) + s.slice(1).toLowerCase();
}
