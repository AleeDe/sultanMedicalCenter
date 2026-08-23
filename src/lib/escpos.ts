/*
  ESC/POS command builder.

  Thermal printers do not speak HTML — they take a byte stream of text mixed
  with escape sequences. Building that stream ourselves means the browser talks
  to the printer directly over USB, so:

    * no Windows driver is needed (this is the fix for "Driver is unavailable")
    * no print dialog, ever — nothing to suppress, because the browser's print
      subsystem is not involved at all
    * auto-cut and the cash drawer become available, which window.print()
      cannot reach

  Commands follow the Epson ESC/POS standard that essentially every 58/80mm
  POS printer implements.
*/

const ESC = 0x1b;
const GS = 0x1d;

export const CHARS_PER_LINE = { 58: 32, 80: 48 } as const;

export type Align = "left" | "center" | "right";

export class EscPos {
  private parts: number[] = [];
  readonly cols: number;

  constructor(paperWidth: 58 | 80 = 80) {
    this.cols = CHARS_PER_LINE[paperWidth] ?? 48;
    // ESC @ — reset to a known state. Without this the job inherits whatever
    // formatting the previous one left behind.
    this.parts.push(ESC, 0x40);
  }

  private push(...bytes: number[]) {
    this.parts.push(...bytes);
    return this;
  }

  /**
   * Text is encoded as CP437, the default code page on these printers.
   * Anything outside it (curly quotes, ₨, em dashes) is transliterated rather
   * than sent raw, which would print as garbage.
   */
  text(s: string) {
    for (const ch of asciiFold(s)) {
      const c = ch.charCodeAt(0);
      this.parts.push(c < 128 ? c : 0x3f); // '?' for anything left over
    }
    return this;
  }

  line(s = "") {
    return this.text(s).push(0x0a);
  }

  align(a: Align) {
    return this.push(ESC, 0x61, a === "center" ? 1 : a === "right" ? 2 : 0);
  }

  bold(on: boolean) {
    return this.push(ESC, 0x45, on ? 1 : 0);
  }

  /** 1 = normal, 2 = double, up to 8. Used for the token number. */
  size(w: number, h = w) {
    const clamp = (n: number) => Math.max(1, Math.min(8, Math.round(n))) - 1;
    return this.push(GS, 0x21, (clamp(w) << 4) | clamp(h));
  }

  /**
   * A row with a label on the left and a value flush right.
   *
   * If the pair cannot fit on one line the value moves to its own line,
   * right-aligned. Previously the gap was clamped to a single space, so an
   * overlong row printed as "DoctorDr. Sara Iqbal" — label and value welded
   * together — and then wrapped wherever the printer ran out of width.
   */
  row(left: string, right: string) {
    const l = asciiFold(left);
    const r = asciiFold(right);

    if (l.length + 1 + r.length <= this.cols) {
      const gap = this.cols - l.length - r.length;
      return this.line(l + " ".repeat(gap) + r);
    }

    // Too wide: label on its own line, value right-aligned beneath it.
    this.line(l.slice(0, this.cols));
    const val = r.length > this.cols ? r.slice(0, this.cols) : r;
    return this.line(" ".repeat(this.cols - val.length) + val);
  }

  rule(char = "-") {
    return this.line(char.repeat(this.cols));
  }

  feed(lines = 1) {
    return this.push(ESC, 0x64, Math.max(0, Math.min(255, lines)));
  }

  /**
   * GS V — partial cut, the mode nearly all models support.
   *
   * The feed before it is not decoration: the print head sits several
   * millimetres behind the cutter, so without it the blade lands in the
   * middle of the last printed lines.
   */
  cut() {
    return this.feed(6).push(GS, 0x56, 0x42, 0x00);
  }

  /** ESC p — kick the cash drawer, if one is wired to the printer. */
  openDrawer() {
    return this.push(ESC, 0x70, 0x00, 0x19, 0xfa);
  }

  build(): Uint8Array {
    return new Uint8Array(this.parts);
  }
}

/**
 * Folds the typographic characters our UI uses into plain ASCII, so a slip
 * never prints "â€™" where an apostrophe belongs.
 */
function asciiFold(s: string): string {
  return s
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[  ]/g, " ")
    .replace(/₨|₹/g, "Rs.")
    .replace(/[·•]/g, "-")
    .replace(/[★☆]/g, "*")
    .replace(/[→]/g, "->")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
}
