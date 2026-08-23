import type { ClinicSetting, TokenReceipt } from "@/lib/types";
import { TIER_LABEL } from "@/lib/loyalty";

/*
  Thermal receipt, 58mm or 80mm.

  EVERY line is a pre-padded string in one <pre>. There is no CSS layout here
  at all — no text-align, no borders, no per-element font sizes.

  Two earlier attempts failed on real paper for the same underlying reason:
  the printer driver rasterises the page through its own text pipeline and
  discards most CSS. Flexbox rows collapsed, so labels welded to values
  ("DoctorDr. Sara Iqbal"). Replacing that with CSS centring and CSS borders
  looked perfect in the browser and printed flush-left with no boxes at all,
  and the footer ran into the header.

  So: centring is done with spaces, boxes are drawn with +--+ characters, and
  emphasis comes from ASCII (=== rules, [ brackets ], spaced C A P S) rather
  than from font size. What you see in the string is what the head prints.

  Constraints:
   * 80mm paper = 48 columns; 58mm = 32.
   * ASCII only — a multi-byte character prints as garbage.
   * @page height must be `auto`, or the printer ejects blank paper.
*/

const COLS = { 58: 32, 80: 48 } as const;

export function TokenSlip({
  receipt,
  clinic,
}: {
  receipt: TokenReceipt;
  clinic: ClinicSetting;
}) {
  const narrow = clinic.paper_width === 58;
  const widthMm = narrow ? 48 : 72;
  const cols = narrow ? COLS[58] : COLS[80];

  const out = buildSlip(receipt, clinic, cols);

  return (
    <div className="slip">
      <style>{`
        /* Margin stays on .slip, not here: @page margins interact badly with
           an auto-height page on roll printers and can add a blank page. */
        @page {
          size: ${clinic.paper_width}mm auto;
          margin: 0;
        }
        @media print {
          html, body { margin: 0; padding: 0; background: #fff; }
        }
        .slip {
          width: ${widthMm}mm;
          margin: 0;
          /* Generous top and bottom margins. The blank lines in the string
             do the real work when the driver ignores CSS, but on the drivers
             that honour padding this keeps the head off the first line. */
          padding: 6mm 0 10mm;
          color: #000;
          background: #fff;
          font-family: "Courier New", Courier, monospace;
          /* Courier advances 0.6em per character, so this makes exactly
             ${cols} characters span the printable width. */
          font-size: ${(widthMm / (cols * 0.6)).toFixed(4)}mm;
          /* Thermal heads bleed into the row above and below at 203 DPI;
             1.5 keeps lines separate once that bleed is accounted for. */
          line-height: 1.5;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .slip pre {
          margin: 0;
          font: inherit;
          white-space: pre;
        }
      `}</style>
      <pre>{out}</pre>
    </div>
  );
}

/** Builds the whole slip as one padded string. Exported for tests. */
export function buildSlip(
  receipt: TokenReceipt,
  clinic: ClinicSetting,
  cols: number,
): string {
  const L: string[] = [];

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

  /** A box drawn from characters, since CSS borders do not print. */
  const box = (text: string) => {
    const inner = cols - 2;
    const t = ascii(text).slice(0, inner - 2);
    const pad = Math.max(0, Math.floor((inner - t.length) / 2));
    const mid = "|" + " ".repeat(pad) + t + " ".repeat(inner - pad - t.length) + "|";
    return ["+" + "-".repeat(inner) + "+", mid, "+" + "-".repeat(inner) + "+"];
  };

  /** "ROOM 2" -> "R O O M   2": the only way to make text look big without
      relying on a font size the driver will ignore. */
  const spaced = (s: string) => ascii(s).toUpperCase().split("").join(" ");

  /*
    ------------------------------------------------------------ header

    The leading blank lines are the margin. CSS padding is unreliable here —
    the driver may or may not honour it — but blank LINES always advance the
    roll, because they are text.

    They matter twice over: the head sits several millimetres past the
    tear-off point, so the first lines of a job are physically under the
    cutter, and without a cut command (the browser path has none) the
    previous slip's footer is still there. Five lines is what it takes to
    clear both, and is why "Software by BabulTech" was landing on top of the
    next slip's clinic name.
  */
  for (let i = 0; i < 8; i++) L.push("");
  L.push(centre(clinic.name.toUpperCase()));
  L.push("");
  if (clinic.address) L.push(centre(clinic.address));
  if (clinic.phone) L.push(centre(`Ph: ${clinic.phone}`));
  L.push("");
  L.push(rule("="));

  /* -------------------------------------------------------- visit type */
  L.push("");
  L.push(
    centre(
      receipt.is_emergency
        ? spaced("** EMERGENCY **")
        : spaced(receipt.series_label),
    ),
  );
  L.push("");

  /* ------------------------------------------------------------- token */
  L.push(centre("T O K E N   N U M B E R"));
  L.push("");
  L.push(...box(spaced(receipt.display_no)));
  L.push("");
  L.push(rule());

  /* ----------------------------------------------------------- details */
  L.push(row("Name", receipt.patient_name));
  if (receipt.doctor_name) L.push(row("Doctor", receipt.doctor_name));
  L.push(row("MRN", receipt.mrn));
  L.push(
    row(
      "Gender",
      titleCase(receipt.gender) +
        (receipt.age_years != null ? ` / ${receipt.age_years}y` : ""),
    ),
  );
  const issued = new Date(receipt.issued_at);
  L.push(row("Date", formatDate(issued)));
  L.push(row("Time", formatTime(issued)));
  if (receipt.tier !== "NEW") {
    L.push(row("Patient", TIER_LABEL[receipt.tier].toUpperCase()));
  }

  /*
    -------------------------------------------------------- approx wait

    Shown as a RANGE whose upper bound is the real commitment. A single
    figure invites the patient to time you, and the quoted number is already
    a deliberate over-estimate — under-promising is the error patients react
    worst to, and it is the direction a naive average errs in.
  */
  if (receipt.wait_minutes) {
    L.push("");
    L.push(
      centre(`Approx. wait  ${receipt.wait_minutes}-${receipt.wait_minutes + 10} min`),
    );
  }

  /* -------------------------------------------------------------- room */
  if (receipt.doctor_room) {
    L.push("");
    L.push(...box(spaced(receipt.doctor_room)));
  }

  /* ----------------------------------------------------------- charges */
  L.push("");
  L.push(rule());
  L.push("CHARGES");
  L.push("");
  for (const l of receipt.lines) {
    const name = ascii(l.name);
    // A long test name gets its own line with the amount right-aligned
    // beneath, rather than being truncated to "Complete Blood Count (C."
    if (name.length + 2 + l.amount.length <= cols) {
      L.push(row(name, l.amount));
    } else {
      L.push(name.slice(0, cols));
      L.push(" ".repeat(cols - l.amount.length) + l.amount);
    }
  }
  L.push(rule("="));
  L.push(row("TOTAL PAID", `Rs. ${receipt.total}`));
  L.push(rule("="));

  /*
    ------------------------------------------------------------ footer

    Order matters here, and it is not the obvious one.

    The maker's mark sits ABOVE the patient-facing lines, not at the very
    bottom. The print head is several millimetres behind the tear-off point,
    so the last line or two of a job never reaches the paper before the job
    ends — they surface at the top of the NEXT slip instead. Putting the
    branding last meant it printed over the following slip's clinic name.

    So the bottom of the slip is deliberately sacrificial: blank lines and
    the unique id, none of which matter if they are clipped.
  */
  L.push("");
  L.push(centre(rule(".")));
  L.push(centre("Software by BabulTech"));
  L.push(centre(rule(".")));
  L.push("");

  if (clinic.footer_note) L.push(centre(clinic.footer_note));
  L.push(centre("Please keep this slip with you."));
  L.push("");
  L.push(centre(receipt.unique_id));

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
    .replace(/[★☆]/g, "*")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7E]/g, "");
}

function titleCase(s: string) {
  return s.charAt(0) + s.slice(1).toLowerCase();
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
