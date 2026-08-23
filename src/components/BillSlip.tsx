import type { ClinicSetting } from "@/lib/types";
import type { VisitLedger } from "@/app/actions/ledger";

/*
  Final settlement receipt.

  Same approach as TokenSlip and for the same reason: the printer driver
  discards CSS, so every line is a pre-padded string and the emphasis comes
  from ASCII rules and character-drawn boxes rather than from styling.

  Unlike the token slip this is a financial document, so it carries the
  invoice number, every line item at its snapshotted price, and any balance.
*/

const COLS = { 58: 32, 80: 48 } as const;

export function BillSlip({
  ledger,
  clinic,
}: {
  ledger: VisitLedger;
  clinic: ClinicSetting;
}) {
  const narrow = clinic.paper_width === 58;
  const widthMm = narrow ? 48 : 72;
  const cols = narrow ? COLS[58] : COLS[80];

  return (
    <div className="slip">
      <style>{`
        @page { size: ${clinic.paper_width}mm auto; margin: 0; }
        @media print { html, body { margin: 0; padding: 0; background: #fff; } }
        .slip {
          width: ${widthMm}mm; margin: 0; padding: 6mm 0 10mm;
          color: #000; background: #fff;
          font-family: "Courier New", Courier, monospace;
          font-size: ${(widthMm / (cols * 0.6)).toFixed(4)}mm;
          line-height: 1.5;
          -webkit-print-color-adjust: exact; print-color-adjust: exact;
        }
        .slip pre { margin: 0; font: inherit; white-space: pre; }
      `}</style>
      <pre>{buildBill(ledger, clinic, cols)}</pre>
    </div>
  );
}

/** Builds the whole bill as one padded string. Exported for tests. */
export function buildBill(
  ledger: VisitLedger,
  clinic: ClinicSetting,
  cols: number,
): string {
  const L: string[] = [];
  const now = new Date();

  const centre = (s: string) => {
    const t = ascii(s).slice(0, cols);
    return " ".repeat(Math.max(0, Math.floor((cols - t.length) / 2))) + t;
  };

  const row = (label: string, value: string) => {
    const l = ascii(label);
    const v = ascii(value);
    if (l.length + 2 + v.length <= cols) {
      return l + " ".repeat(cols - l.length - v.length) + v;
    }
    const cut = v.slice(0, cols);
    return l + "\n" + " ".repeat(Math.max(0, cols - cut.length)) + cut;
  };

  const rule = (ch = "-") => ch.repeat(cols);
  const spaced = (s: string) => ascii(s).toUpperCase().split("").join(" ");

  /* ------------------------------------------------------------ header */
  // Blank LINES, not CSS padding: the driver may ignore padding but always
  // advances the roll for text. The head also sits past the tear-off point,
  // and with no cut command the previous slip's footer is still under it.
  for (let i = 0; i < 8; i++) L.push("");
  L.push(centre(clinic.name.toUpperCase()));
  L.push("");
  if (clinic.address) L.push(centre(clinic.address));
  if (clinic.phone) L.push(centre(`Ph: ${clinic.phone}`));
  L.push("");
  L.push(rule("="));
  L.push("");
  L.push(
    centre(spaced(ledger.balance === "0.00" ? "PAID RECEIPT" : "BILL")),
  );
  L.push("");
  L.push(rule());

  /* -------------------------------------------------------------- head */
  L.push(row("Invoice", ledger.invoice_no ?? "-"));
  L.push(row("Token", ledger.display_no));
  L.push(row("Name", ledger.patient_name));
  L.push(row("MRN", ledger.mrn));
  L.push(row("Date", `${formatDate(now)} ${formatTime(now)}`));

  /* ------------------------------------------------------------- items */
  L.push("");
  L.push(rule());
  L.push("CHARGES");
  L.push("");
  for (const it of ledger.items) {
    // Name on its own line, the maths indented beneath it — a long test name
    // will not fit beside its amount on a 32-column roll.
    L.push(ascii(it.name_snapshot).slice(0, cols));
    const qty = `  ${it.qty} x ${Number(it.unit_price_snapshot).toFixed(2)}`;
    const less =
      Number(it.discount) > 0 ? ` less ${Number(it.discount).toFixed(2)}` : "";
    L.push(row(qty + less, Number(it.line_total).toFixed(2)));
  }

  /* ------------------------------------------------------------ totals */
  L.push(rule("="));
  L.push(row("TOTAL", `Rs. ${ledger.total}`));
  L.push(row("Paid", `Rs. ${ledger.paid}`));
  if (ledger.balance !== "0.00") {
    L.push(row("BALANCE DUE", `Rs. ${ledger.balance}`));
  }
  L.push(rule("="));

  /*
    ------------------------------------------------------------ footer

    Branding sits above the patient-facing lines, not at the very bottom.
    The head is several millimetres behind the tear-off point, so the last
    lines of a job surface at the top of the NEXT slip; anything placed there
    prints over the following receipt's header.
  */
  L.push("");
  L.push(centre(rule(".")));
  L.push(centre("Software by BabulTech"));
  L.push(centre(rule(".")));
  L.push("");

  if (clinic.footer_note) L.push(centre(clinic.footer_note));
  L.push("");
  L.push(centre(ledger.unique_id));

  // Sacrificial tail: whatever the head cannot reach before the job ends.
  for (let i = 0; i < 8; i++) L.push("");

  return L.join("\n");
}

/** Thermal printers are 1-byte CP437 devices; anything else prints garbage. */
function ascii(s: string): string {
  return s
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[  ]/g, " ")
    .replace(/[₨₹]/g, "Rs.")
    .replace(/[·•]/g, "-")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7E]/g, "");
}

function formatDate(d: Date) {
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatTime(d: Date) {
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}
