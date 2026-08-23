// Verifies the ESC/POS byte stream: correct control codes, correct line
// widths, and no characters the printer cannot render.
//
// Usage: node scripts/test-escpos.mjs
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The library is TypeScript; compile just it to plain JS for this check.
const dir = mkdtempSync(path.join(tmpdir(), "escpos-"));
try {
  execSync(
    `npx tsc src/lib/escpos.ts --outDir "${dir}" --module esnext ` +
      `--target es2020 --moduleResolution bundler`,
    { stdio: "pipe" },
  );
  writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');

  const { EscPos, CHARS_PER_LINE } = await import(
    "file://" + path.join(dir, "escpos.js")
  );

  let fail = 0;
  const check = (name, ok, detail = "") => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) fail++;
  };

  // --- init ------------------------------------------------------------
  const init = new EscPos(80).build();
  check("stream starts with ESC @ (reset)", init[0] === 0x1b && init[1] === 0x40);

  // --- widths ----------------------------------------------------------
  check("80mm is 48 columns", CHARS_PER_LINE[80] === 48);
  check("58mm is 32 columns", CHARS_PER_LINE[58] === 32);

  // Strips the leading ESC @ so the first text line can be measured; those
  // two bytes are control codes, not printed columns.
  const asText = (p) =>
    Buffer.from(p.build().slice(2)).toString("latin1");

  // --- row alignment ---------------------------------------------------
  for (const width of [58, 80]) {
    const p = new EscPos(width);
    p.row("Name", "Ayesha Khan");
    const line = asText(p).split("\n").find((l) => l.includes("Name")) ?? "";
    check(
      `${width}mm row fills exactly ${CHARS_PER_LINE[width]} columns`,
      line.length === CHARS_PER_LINE[width],
      `got ${line.length}`,
    );
    check(`${width}mm row is right-aligned`, line.endsWith("Ayesha Khan"));
  }

  /*
    Overlong rows.

    A real 58mm slip printed "DoctorDr. Sara Iqbal" — label and value welded
    together, then wrapped by the printer wherever it ran out of width. The
    old row() clamped the gap to one space instead of breaking the line, so
    no row may ever exceed the column count.
  */
  for (const width of [58, 80]) {
    const cols = CHARS_PER_LINE[width];
    const p2 = new EscPos(width);
    p2.row("Doctor", "Dr. Muhammad Abdul Rehman Qureshi");
    p2.row("A very long service description indeed", "1234.00");
    const lines = asText(p2).split("\n").filter(Boolean);
    const over = lines.filter((l) => l.length > cols);
    check(
      `${width}mm: no row exceeds ${cols} columns`,
      over.length === 0,
      over.length ? `"${over[0]}" is ${over[0].length}` : "",
    );
    check(
      `${width}mm: label and value never collide`,
      !lines.some((l) => /Doctor(?=\S)/.test(l)),
      lines.find((l) => /Doctor(?=\S)/.test(l)) ?? "",
    );
  }

  // --- rules -----------------------------------------------------------
  const p3 = new EscPos(80);
  p3.rule();
  const l3 = asText(p3).split("\n")[0];
  check("rule spans the full width", l3.length === 48, `got ${l3.length}`);

  // --- cut -------------------------------------------------------------
  const cut = new EscPos(80).cut().build();
  const tail = Array.from(cut.slice(-4));
  check(
    "cut ends with GS V B 0",
    tail[0] === 0x1d && tail[1] === 0x56 && tail[2] === 0x42 && tail[3] === 0x00,
    tail.map((b) => b.toString(16)).join(" "),
  );

  // --- bold / size toggles ---------------------------------------------
  const fmt = Array.from(new EscPos(80).bold(true).size(3).build());
  check("bold emits ESC E 1", fmt.includes(0x45));
  check("size emits GS !", fmt.includes(0x21));

  // --- non-ASCII must be folded, never emitted raw ----------------------
  const p4 = new EscPos(80);
  p4.line("Rs. 500 — “Dr. Zoë” · café ₨");
  const bytes = Array.from(p4.build());
  check("no byte above 127 reaches the printer",
        bytes.every((b) => b <= 127),
        `max ${Math.max(...bytes)}`);
  const folded = Buffer.from(p4.build()).toString("latin1");
  check("em dash folded to hyphen", folded.includes("-"));
  check("curly quotes folded", folded.includes('"Dr. Zoe"'));
  check("middot folded", !folded.includes("·"));

  console.log(fail ? `\n${fail} check(s) FAILED.\n` : "\nAll checks passed.\n");
  process.exitCode = fail ? 1 : 0;
} catch (err) {
  console.error("\nTest error:", err.message);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
