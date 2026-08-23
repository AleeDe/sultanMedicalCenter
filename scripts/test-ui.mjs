/*
  Checks on the design system itself, not on any one screen's copy.

  These exist because the failures they catch are invisible in review: a
  hardcoded colour still looks right until emergency mode is switched on, and
  a truncated name still looks tidy until two doctors share a first name.
*/
import { chromium } from "playwright";

const b = await chromium.launch({ channel: "msedge", headless: true });
let fail = 0;
const check = (n, ok, d = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};
const p = await b.newPage({ viewport: { width: 1512, height: 950 } });
p.on("pageerror", (e) => console.log("EXC:", e.message));

/* ------------------------------------------------ emergency repaints all -- */

await p.goto("http://localhost:3000/", { waitUntil: "networkidle" });
const normalAccent = await p.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
);
await p.getByRole("button", { name: /Emergency/ }).first().click();
await p.waitForTimeout(700);

const emergencyAccent = await p.evaluate(() => {
  const el = document.querySelector("[data-mode='emergency']") ?? document.documentElement;
  return getComputedStyle(el).getPropertyValue("--accent").trim();
});
check("emergency mode repaints the accent token",
      emergencyAccent !== normalAccent, `${normalAccent} -> ${emergencyAccent}`);

/*
  The real regression: components that hardcoded the blue never turned red.
  Ask the live DOM whether any painted element still carries the normal-mode
  blue while the screen is in emergency mode.
*/
const stragglers = await p.evaluate(() => {
  const bad = [];
  for (const el of document.querySelectorAll("main *")) {
    const cs = getComputedStyle(el);
    for (const prop of ["backgroundColor", "color", "borderTopColor"]) {
      // #0b5fa5
      if (cs[prop] === "rgb(11, 95, 165)") {
        bad.push(el.tagName.toLowerCase() + "." + (el.className || "").toString().slice(0, 40));
        break;
      }
    }
  }
  return bad.slice(0, 5);
});
check("no element is still painted with the hardcoded blue",
      stragglers.length === 0, stragglers.join(", ") || "none");

/* ----------------------------------------------------- queue at a glance -- */

await p.goto("http://localhost:3000/queue", { waitUntil: "networkidle" });
await p.waitForTimeout(1500);

const h = await p.evaluate(() => document.body.scrollHeight);
check("four doctors fit without an endless scroll", h < 1600, `${h}px`);

// A clipped doctor name is a genuine ambiguity on a four-doctor screen.
const clipped = await p.evaluate(() =>
  [...document.querySelectorAll("p")]
    .filter((el) => /^Dr\./.test(el.textContent ?? ""))
    .filter((el) => el.scrollWidth > el.clientWidth + 1)
    .map((el) => el.textContent),
);
check("no doctor name is truncated", clipped.length === 0,
      clipped.join(", ") || "none clipped");

check("doctors are told apart by their initials",
      (await p.getByText("AR", { exact: true }).count()) > 0 &&
      (await p.getByText("NK", { exact: true }).count()) > 0);

// Break controls are a twice-a-day action and must not compete with Call next.
check("break controls are folded away",
      (await p.getByRole("button", { name: "Break 10m" }).count()) === 0);
await p.getByText("Availability").first().click();
await p.waitForTimeout(400);
check("...but are one click away",
      (await p.getByRole("button", { name: "Break 10m" }).count()) > 0);

/* --------------------------------------------------------- display board -- */

await p.goto("http://localhost:3000/display", { waitUntil: "networkidle" });
await p.waitForTimeout(1500);

// A TV must not show everything in its top third.
const fill = await p.evaluate(() => {
  const cards = [...document.querySelectorAll("section")];
  if (!cards.length) return 0;
  const lowest = Math.max(...cards.map((c) => c.getBoundingClientRect().bottom));
  return lowest / window.innerHeight;
});
check("the board fills the screen", fill > 0.8, `${(fill * 100).toFixed(0)}% used`);

// The digits are what a patient matches against their slip.
const sizes = await p.evaluate(() => {
  const el = [...document.querySelectorAll("span")].find(
    (s) => /^\d{4,}$/.test((s.textContent ?? "").trim()),
  );
  if (!el) return null;
  const prefix = el.previousElementSibling?.previousElementSibling;
  return {
    digits: parseFloat(getComputedStyle(el).fontSize),
    prefix: prefix ? parseFloat(getComputedStyle(prefix).fontSize) : 0,
  };
});
check("the digits outweigh the prefix",
      sizes != null && sizes.digits > sizes.prefix * 1.5,
      sizes ? `${sizes.digits}px vs ${sizes.prefix}px` : "no token shown");

/* ------------------------------------------------------------ hit targets */

for (const [url, label] of [["/", "New Token"], ["/queue", "Queue"]]) {
  await p.goto("http://localhost:3000" + url, { waitUntil: "networkidle" });
  await p.waitForTimeout(1200);
  const small = await p.evaluate(() =>
    [...document.querySelectorAll("button:not([disabled])")]
      .map((el) => ({ r: el.getBoundingClientRect(), t: (el.textContent ?? "").trim().slice(0, 20) }))
      .filter(({ r }) => r.width > 0 && r.height > 0 && r.height < 36)
      .map(({ t, r }) => `${t || "?"}:${Math.round(r.height)}px`),
  );
  check(`${label}: every button clears the touch floor`,
        small.length === 0, small.slice(0, 3).join(", ") || "all >= 36px");
}

console.log(fail ? `\n${fail} FAILED` : "\nAll checks passed.");
await b.close();
process.exitCode = fail ? 1 : 0;
