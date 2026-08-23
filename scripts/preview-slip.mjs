// Renders a token slip as plain text exactly as the printer will lay it out,
// so formatting can be checked without burning paper.
//
// Usage: node scripts/preview-slip.mjs [58|80]
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const width = Number(process.argv[2] ?? 58);
const dir = mkdtempSync(path.join(tmpdir(), "slip-"));

try {
  execSync(
    `npx tsc src/lib/escpos.ts --outDir "${dir}" --module esnext ` +
      `--target es2020 --moduleResolution bundler`,
    { stdio: "pipe" },
  );
  writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  const { EscPos } = await import("file://" + path.join(dir, "escpos.js"));

  // A deliberately awkward record: long doctor name, long test names, and
  // the widest realistic amounts.
  const p = new EscPos(width);
  p.align("center").bold(true).line("Shifa Medical Centre").bold(false);
  p.line("12-B, Main Boulevard, Lahore");
  p.line("Ph: 042-35700123");
  p.rule();
  p.bold(true).line("NORMAL OPD").bold(false);
  p.line("TOKEN NUMBER");
  p.size(3).bold(true).line("NORM-00043").size(1).bold(false);
  p.rule();

  p.align("left");
  const fit = (l, v) => p.row(l, v.length > width - l.length - 1
    ? v.slice(0, Math.max(1, p.cols - l.length - 2)) + "."
    : v);

  fit("Name", "Farah Hussain");
  fit("Doctor", "Dr. Sara Iqbal");
  fit("Room", "Room 2");
  fit("MRN", "MRN-000313");
  fit("Gender", "Female / 23y");
  fit("Date", "20 Aug 2026");
  fit("Time", "08:56 pm");

  p.rule();
  for (const [name, amt] of [
    ["Normal OPD Fee", "500.00"],
    ["General Consultation", "500.00"],
    ["Complete Blood Count (CBC)", "800.00"],
    ["Blood Sugar Random", "300.00"],
    ["Ultrasound Abdomen", "2500.00"],
    ["Dressing", "400.00"],
    ["Injection", "200.00"],
  ]) {
    p.row(name.slice(0, p.cols - amt.length - 1), amt);
  }
  p.rule("=");
  p.bold(true).row("TOTAL PAID", "Rs. 5200.00").bold(false);
  p.rule();
  p.align("center").line("NORM-20082026-00043");
  p.line("Get well soon.");

  // Strip control bytes so what prints is what you see.
  const text = Buffer.from(p.build())
    .toString("latin1")
    .replace(/\x1b@|\x1b[aE]./g, "")
    .replace(/\x1d!./g, "")
    .replace(/\x1b[dp]./g, "");

  const bar = "+" + "-".repeat(p.cols) + "+";
  console.log(`\n${width}mm — ${p.cols} columns\n`);
  console.log(bar);
  for (const line of text.split("\n")) {
    if (line === "" ) continue;
    const flag = line.length > p.cols ? "  <-- OVERFLOW" : "";
    console.log("|" + line.padEnd(p.cols) + "|" + flag);
  }
  console.log(bar + "\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
