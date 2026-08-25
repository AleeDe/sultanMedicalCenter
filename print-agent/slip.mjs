// src/lib/escpos.ts
var ESC = 27;
var GS = 29;
var CHARS_PER_LINE = { 58: 32, 80: 48 };
var EscPos = class {
  constructor(paperWidth = 80) {
    this.parts = [];
    this.cols = CHARS_PER_LINE[paperWidth] ?? 48;
    this.parts.push(ESC, 64);
  }
  push(...bytes) {
    this.parts.push(...bytes);
    return this;
  }
  /**
   * Text is encoded as CP437, the default code page on these printers.
   * Anything outside it (curly quotes, ₨, em dashes) is transliterated rather
   * than sent raw, which would print as garbage.
   */
  text(s) {
    for (const ch of asciiFold(s)) {
      const c = ch.charCodeAt(0);
      this.parts.push(c < 128 ? c : 63);
    }
    return this;
  }
  line(s = "") {
    return this.text(s).push(10);
  }
  align(a) {
    return this.push(ESC, 97, a === "center" ? 1 : a === "right" ? 2 : 0);
  }
  bold(on) {
    return this.push(ESC, 69, on ? 1 : 0);
  }
  /** 1 = normal, 2 = double, up to 8. Used for the token number. */
  size(w, h = w) {
    const clamp = (n) => Math.max(1, Math.min(8, Math.round(n))) - 1;
    return this.push(GS, 33, clamp(w) << 4 | clamp(h));
  }
  /**
   * A row with a label on the left and a value flush right.
   *
   * If the pair cannot fit on one line the value moves to its own line,
   * right-aligned. Previously the gap was clamped to a single space, so an
   * overlong row printed as "DoctorDr. Sara Iqbal" — label and value welded
   * together — and then wrapped wherever the printer ran out of width.
   */
  row(left, right) {
    const l = asciiFold(left);
    const r = asciiFold(right);
    if (l.length + 1 + r.length <= this.cols) {
      const gap = this.cols - l.length - r.length;
      return this.line(l + " ".repeat(gap) + r);
    }
    this.line(l.slice(0, this.cols));
    const val = r.length > this.cols ? r.slice(0, this.cols) : r;
    return this.line(" ".repeat(this.cols - val.length) + val);
  }
  rule(char = "-") {
    return this.line(char.repeat(this.cols));
  }
  feed(lines = 1) {
    return this.push(ESC, 100, Math.max(0, Math.min(255, lines)));
  }
  /**
   * GS V — partial cut, the mode nearly all models support.
   *
   * The feed before it is not decoration: the print head sits several
   * millimetres behind the cutter, so without it the blade lands in the
   * middle of the last printed lines.
   */
  cut() {
    return this.feed(6).push(GS, 86, 66, 0);
  }
  /** ESC p — kick the cash drawer, if one is wired to the printer. */
  openDrawer() {
    return this.push(ESC, 112, 0, 25, 250);
  }
  build() {
    return new Uint8Array(this.parts);
  }
};
function asciiFold(s) {
  return s.replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/[  ]/g, " ").replace(/₨|₹/g, "Rs.").replace(/[·•]/g, "-").replace(/[★☆]/g, "*").replace(/[→]/g, "->").normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

// src/lib/receipts.ts
function box(p, text) {
  const inner = p.cols - 2;
  const t = text.slice(0, inner - 2);
  const pad = Math.max(0, Math.floor((inner - t.length) / 2));
  p.align("left");
  p.line("+" + "-".repeat(inner) + "+");
  p.line("|" + " ".repeat(pad) + t + " ".repeat(inner - pad - t.length) + "|");
  p.line("+" + "-".repeat(inner) + "+");
}
function spaced(s) {
  return s.toUpperCase().split("").join(" ");
}
function header(p, clinic) {
  p.feed(2);
  p.align("center").bold(true).size(1, 2).line(clinic.name.toUpperCase());
  p.feed(1);
  p.size(1).bold(false);
  if (clinic.address) p.line(clinic.address);
  if (clinic.phone) p.line(`Ph: ${clinic.phone}`);
  p.feed(1);
  p.align("left").rule("=");
}
function footer(p, clinic, uniqueId, keepLine) {
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
function tokenSlipBytes(receipt, clinic) {
  const p = new EscPos(clinic.paper_width === 58 ? 58 : 80);
  const issued = new Date(receipt.issued_at);
  header(p, clinic);
  p.feed(1).align("center").bold(true);
  p.line(
    receipt.is_emergency ? spaced("** EMERGENCY **") : spaced(receipt.series_label)
  );
  p.bold(false).feed(1);
  p.line("T O K E N   N U M B E R");
  p.feed(1);
  box(p, spaced(receipt.display_no));
  p.feed(1).rule();
  p.align("left");
  const fit = (label, value) => p.row(label, trim(value, p.cols - label.length - 1));
  fit("Name", receipt.patient_name);
  if (receipt.doctor_name) fit("Doctor", receipt.doctor_name);
  fit("MRN", receipt.mrn);
  fit(
    "Gender",
    title(receipt.gender) + (receipt.age_years != null ? ` / ${receipt.age_years}y` : "")
  );
  fit("Date", fmtDate(issued));
  fit("Time", fmtTime(issued));
  if (receipt.tier !== "NEW") fit("Patient", receipt.tier);
  if (receipt.wait_minutes) {
    p.feed(1).align("center");
    p.line(`Approx. wait  ${receipt.wait_minutes}-${receipt.wait_minutes + 10} min`);
    p.align("left");
  }
  if (receipt.doctor_room) {
    p.feed(1);
    box(p, spaced(receipt.doctor_room));
  }
  p.feed(1).rule();
  p.line("CHARGES");
  p.feed(1);
  for (const l of receipt.lines) {
    p.row(l.name, l.amount);
  }
  p.rule("=");
  p.bold(true).size(1).row("TOTAL PAID", `Rs. ${receipt.total}`).bold(false);
  p.rule();
  footer(p, clinic, receipt.unique_id, "Please keep this slip with you.");
  p.cut();
  return p.build();
}
function trim(s, max) {
  return s.length > max ? s.slice(0, Math.max(1, max - 1)) + "." : s;
}
function title(s) {
  return s.charAt(0) + s.slice(1).toLowerCase();
}
function fmtDate(d) {
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}
function fmtTime(d) {
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });
}
export {
  tokenSlipBytes
};
