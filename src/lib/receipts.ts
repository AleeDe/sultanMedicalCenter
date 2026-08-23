import { EscPos } from "./escpos";
import type { ClinicSetting, TokenReceipt } from "./types";
import type { VisitLedger } from "@/app/actions/ledger";

/*
  The same two receipts the HTML templates produce, expressed as ESC/POS byte
  streams for direct USB printing.

  Both layouts are kept deliberately identical to TokenSlip.tsx and
  BillSlip.tsx so a clinic can switch between browser printing and USB
  printing without the paper changing.
*/

/** A box drawn from characters, matching the HTML slip exactly. */
function box(p: EscPos, text: string) {
  const inner = p.cols - 2;
  const t = text.slice(0, inner - 2);
  const pad = Math.max(0, Math.floor((inner - t.length) / 2));
  p.align("left");
  p.line("+" + "-".repeat(inner) + "+");
  p.line("|" + " ".repeat(pad) + t + " ".repeat(inner - pad - t.length) + "|");
  p.line("+" + "-".repeat(inner) + "+");
}

/** "ROOM 2" -> "R O O M   2" */
function spaced(s: string) {
  return s.toUpperCase().split("").join(" ");
}

function header(p: EscPos, clinic: ClinicSetting) {
  // Feed first: the head sits a few millimetres past the tear-off point, so
  // without this the first line or two is clipped on a fresh roll.
  p.feed(2);
  // Double-height for the clinic name: on a thermal head this is a real size
  // change, not a synthesised bold, so it stays crisp.
  p.align("center").bold(true).size(1, 2).line(clinic.name.toUpperCase());
  p.feed(1);
  p.size(1).bold(false);
  if (clinic.address) p.line(clinic.address);
  if (clinic.phone) p.line(`Ph: ${clinic.phone}`);
  p.feed(1);
  p.align("left").rule("=");
}

function footer(
  p: EscPos,
  clinic: ClinicSetting,
  uniqueId: string,
  keepLine?: string,
) {
  /*
    Branding first, patient lines after.

    The USB path does send a cut command, but the head still trails the
    cutter, so the very last lines are the ones at risk. Keeping the maker's
    mark above the disposable lines means it prints on THIS slip rather than
    surfacing on the next one — the same ordering as the HTML slips.
  */
  p.align("center").feed(1);
  p.line(".".repeat(p.cols));
  p.line("Software by BabulTech");
  p.line(".".repeat(p.cols));
  p.feed(1);

  if (clinic.footer_note) p.line(clinic.footer_note);
  if (keepLine) p.line(keepLine);
  p.feed(1);
  p.line(uniqueId);
}

export function tokenSlipBytes(
  receipt: TokenReceipt,
  clinic: ClinicSetting,
): Uint8Array {
  const p = new EscPos((clinic.paper_width === 58 ? 58 : 80) as 58 | 80);
  const issued = new Date(receipt.issued_at);

  header(p, clinic);

  // Visit type. Emphasis comes from letter-spacing and the box below, not
  // from colour, which thermal paper does not have.
  p.feed(1).align("center").bold(true);
  p.line(
    receipt.is_emergency
      ? spaced("** EMERGENCY **")
      : spaced(receipt.series_label),
  );
  p.bold(false).feed(1);
  p.line("T O K E N   N U M B E R");
  p.feed(1);

  // The number: the one thing that must read across a counter. Boxed rather
  // than merely enlarged, so it stands out even at a single character size.
  box(p, spaced(receipt.display_no));
  p.feed(1).rule();

  /*
    Values are trimmed against the space actually left after the label, not a
    fixed guess. On a 32-column roll a long doctor name otherwise overflowed
    and the printer wrapped it mid-word.
  */
  p.align("left");
  const fit = (label: string, value: string) =>
    p.row(label, trim(value, p.cols - label.length - 1));

  fit("Name", receipt.patient_name);
  if (receipt.doctor_name) fit("Doctor", receipt.doctor_name);
  fit("MRN", receipt.mrn);
  fit(
    "Gender",
    title(receipt.gender) +
      (receipt.age_years != null ? ` / ${receipt.age_years}y` : ""),
  );
  fit("Date", fmtDate(issued));
  fit("Time", fmtTime(issued));
  if (receipt.tier !== "NEW") fit("Patient", receipt.tier);

  // A range, not a point estimate: the upper bound is what we are committing
  // to, and false precision invites the patient to time us.
  if (receipt.wait_minutes) {
    p.feed(1).align("center");
    p.line(`Approx. wait  ${receipt.wait_minutes}-${receipt.wait_minutes + 10} min`);
    p.align("left");
  }

  // Where to go next: the one line a patient re-reads in the corridor.
  if (receipt.doctor_room) {
    p.feed(1);
    box(p, spaced(receipt.doctor_room));
  }

  p.feed(1).rule();
  p.line("CHARGES");
  p.feed(1);
  for (const l of receipt.lines) {
    // A long test name gets its own line with the amount right-aligned
    // beneath — row() already does this, but only once it cannot fit.
    p.row(l.name, l.amount);
  }
  p.rule("=");
  p.bold(true).size(1).row("TOTAL PAID", `Rs. ${receipt.total}`).bold(false);
  p.rule();

  footer(p, clinic, receipt.unique_id, "Please keep this slip with you.");
  p.cut();

  return p.build();
}

export function billSlipBytes(
  ledger: VisitLedger,
  clinic: ClinicSetting,
): Uint8Array {
  const p = new EscPos((clinic.paper_width === 58 ? 58 : 80) as 58 | 80);
  const now = new Date();

  header(p, clinic);
  p.align("center").bold(true);
  p.line(ledger.balance === "0.00" ? "PAID RECEIPT" : "BILL");
  p.bold(false).rule();

  p.align("left");
  const fit = (label: string, value: string) =>
    p.row(label, trim(value, p.cols - label.length - 1));

  fit("Invoice", ledger.invoice_no ?? "-");
  fit("Token", ledger.display_no);
  fit("Name", ledger.patient_name);
  fit("MRN", ledger.mrn);
  fit("Date", `${fmtDate(now)} ${fmtTime(now)}`);
  p.rule("=");

  for (const it of ledger.items) {
    p.line(trim(it.name_snapshot, p.cols));
    const qty = `${it.qty} x ${Number(it.unit_price_snapshot).toFixed(2)}`;
    const less =
      Number(it.discount) > 0 ? `  less ${Number(it.discount).toFixed(2)}` : "";
    const total = Number(it.line_total).toFixed(2);
    p.row(trim(`  ${qty}${less}`, p.cols - total.length - 1), total);
  }

  p.rule("=");
  p.bold(true).row("TOTAL", `Rs. ${ledger.total}`).bold(false);
  p.row("Paid", `Rs. ${ledger.paid}`);
  if (ledger.balance !== "0.00") {
    p.bold(true).row("BALANCE DUE", `Rs. ${ledger.balance}`).bold(false);
  }
  p.rule();

  footer(p, clinic, ledger.unique_id);
  p.cut();

  return p.build();
}

/** A self-contained slip for the setup screen's test button. */
export function testSlipBytes(clinic: ClinicSetting): Uint8Array {
  const p = new EscPos((clinic.paper_width === 58 ? 58 : 80) as 58 | 80);
  p.align("center").bold(true).line("PRINT TEST").bold(false).rule();
  p.size(3).bold(true).line("TEST-001").size(1).bold(false);
  p.rule();
  p.line("Printed directly over USB.");
  p.line("No Windows driver, no dialog.");
  p.line(`${p.cols} characters per line`);
  p.line(new Date().toLocaleString("en-GB"));
  p.cut();
  return p.build();
}

function trim(s: string, max: number) {
  return s.length > max ? s.slice(0, Math.max(1, max - 1)) + "." : s;
}

function title(s: string) {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

function fmtDate(d: Date) {
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function fmtTime(d: Date) {
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}
