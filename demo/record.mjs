/*
  Records the demo walkthrough as a video.

  Drives the real app in a real browser — no mockups — so what the client sees
  is what the software does. A synthetic cursor is drawn in, because a screen
  recording with no visible pointer is very hard to follow, and every action
  is deliberately paced for a human watching rather than a test runner.

  Usage:  node demo/record.mjs
  Output: demo/out/raw.webm  (muxed with narration by demo/build.mjs)
*/
import { chromium } from "playwright";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

const BASE = process.env.DEMO_URL ?? "http://localhost:3000";
const OUT = path.join(process.cwd(), "demo", "out");
const RAW = path.join(OUT, "video");
const W = 1440;
const H = 900;

rmSync(RAW, { recursive: true, force: true });
mkdirSync(RAW, { recursive: true });

const browser = await chromium.launch({
  channel: "msedge",
  headless: false,
  args: [`--window-size=${W},${H}`],
});

const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  recordVideo: { dir: RAW, size: { width: W, height: H } },
});

const page = await ctx.newPage();

// Printing must never actually fire during a recording.
await page.addInitScript(() => {
  window.print = () => {};
});

/* ----------------------------------------------------- synthetic cursor */

async function installCursor() {
  await page.evaluate(() => {
    if (document.getElementById("demo-cursor")) return;
    const c = document.createElement("div");
    c.id = "demo-cursor";
    c.style.cssText = `
      position:fixed; left:0; top:0; width:22px; height:22px; z-index:2147483647;
      pointer-events:none; transition:transform .04s linear;
      background:no-repeat center/contain url("data:image/svg+xml;utf8,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M5 2l14 8.5-6.2 1.3L16 19l-2.6 1.2-3.1-7L5 17z" fill="%23111" stroke="%23fff" stroke-width="1.4"/></svg>`,
      )}");
      filter: drop-shadow(0 2px 3px rgba(0,0,0,.35));
    `;
    document.body.appendChild(c);
    const ring = document.createElement("div");
    ring.id = "demo-ring";
    ring.style.cssText = `
      position:fixed; left:0; top:0; width:44px; height:44px; margin:-22px;
      border-radius:50%; border:3px solid #0b5fa5; opacity:0; z-index:2147483646;
      pointer-events:none; transition:opacity .18s, transform .18s;
    `;
    document.body.appendChild(ring);
    window.__moveCursor = (x, y) => {
      const el = document.getElementById("demo-cursor");
      const r = document.getElementById("demo-ring");
      if (el) el.style.transform = `translate(${x}px, ${y}px)`;
      if (r) r.style.transform = `translate(${x}px, ${y}px)`;
    };
    window.__clickRing = () => {
      const r = document.getElementById("demo-ring");
      if (!r) return;
      r.style.opacity = "1";
      r.style.transform += " scale(.55)";
      setTimeout(() => {
        r.style.opacity = "0";
      }, 260);
    };
  });
}

let cx = W / 2;
let cy = H / 2;

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Glides the pointer instead of teleporting, so the eye can follow it. */
async function moveTo(x, y, ms = 520) {
  const steps = Math.max(12, Math.round(ms / 16));
  const sx = cx;
  const sy = cy;
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    cx = sx + (x - sx) * t;
    cy = sy + (y - sy) * t;
    await page.evaluate(([a, b]) => window.__moveCursor?.(a, b), [cx, cy]);
    await page.waitForTimeout(16);
  }
}

async function moveToEl(locator, ms) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no box");
  await moveTo(box.x + box.width / 2, box.y + box.height / 2, ms);
  return box;
}

async function click(locator, { pause = 420 } = {}) {
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(160);
  await moveToEl(locator);
  await page.evaluate(() => window.__clickRing?.());
  await page.waitForTimeout(140);
  await locator.click();
  await page.waitForTimeout(pause);
}

/** Types at human speed — instant fills look fake on video. */
async function type(selector, text, { delay = 55 } = {}) {
  const el = page.locator(selector);
  await moveToEl(el);
  await page.evaluate(() => window.__clickRing?.());
  await el.click();
  await page.waitForTimeout(180);
  await el.type(text, { delay });
  await page.waitForTimeout(280);
}

async function beat(ms = 800) {
  await page.waitForTimeout(ms);
}

/*
  Scene pacing.

  The narration length for each scene is passed in from build.mjs. Rather
  than stretching the finished video uniformly — which slides every later
  scene out of sync with what is being said — each scene simply waits until
  its own narration would have finished. The picture then tracks the voice
  scene by scene, and no retiming is needed afterwards.
*/
const SCENE_MS = JSON.parse(process.env.DEMO_SCENES ?? "[]").map((s) =>
  Math.round(s * 1000),
);
let sceneIndex = -1;
let sceneStart = 0;

function beginScene(label) {
  sceneIndex++;
  sceneStart = Date.now();
  console.log(`  scene ${sceneIndex + 1}: ${label}`);
}

/** Holds until this scene has filled its narration slot. */
async function endScene() {
  const want = SCENE_MS[sceneIndex];
  if (!want) return;
  const spent = Date.now() - sceneStart;
  if (spent < want) await page.waitForTimeout(want - spent);
  else console.log(`    (ran ${spent - want}ms over)`);
}

async function goto(url) {
  await page.goto(url, { waitUntil: "networkidle" });
  await installCursor();
  await page.evaluate(([a, b]) => window.__moveCursor?.(a, b), [cx, cy]);
  await beat(500);
}

/* --------------------------------------------------------------- scenes */

const phone = process.env.DEMO_PHONE;
if (!phone) {
  console.error("DEMO_PHONE is not set — run demo/build.mjs, not this directly.");
  process.exit(1);
}

console.log("recording…");

/* 1 — opening: the clean New Token screen */
await goto(BASE);
beginScene("opening");
await beat(1500);
await endScene();

/* 2 — triage: the whole screen repaints for an emergency */
beginScene("emergency triage");
await click(page.getByRole("button", { name: /Emergency/ }), { pause: 2600 });
await click(page.getByRole("button", { name: /Normal OPD/ }), { pause: 800 });
await endScene();

/* 3 — returning patient recognised from the phone number alone */
beginScene("phone lookup");
await type("#phone", phone);
await page.keyboard.press("Enter");
await page.waitForSelector("text=Known patient", { timeout: 8000 }).catch(() => {});
await beat(1500);
await endScene();

/* 4 — doctor, with the room that will be printed on the slip */
beginScene("doctor");
await click(page.getByRole("button", { name: /Dr\. Sara Iqbal/ }), { pause: 1800 });
await endScene();

/* 5 — labs added at the counter, total adding itself up */
beginScene("labs");
await click(page.getByRole("button", { name: /Add lab tests or services/ }), {
  pause: 600,
});
await click(page.getByRole("button", { name: "Lab", exact: true }), { pause: 500 });
await click(page.getByRole("button", { name: /Complete Blood Count/ }), {
  pause: 800,
});
await click(page.getByRole("button", { name: "Radiology", exact: true }), {
  pause: 500,
});
await click(page.getByRole("button", { name: /X-Ray Chest/ }), { pause: 900 });
await page.getByText(/Total to collect/).scrollIntoViewIfNeeded();
await beat(1600);
await endScene();

/* 6 — issue, then hold on the printed slip itself */
beginScene("issue + slip");
await click(page.getByRole("button", { name: /Issue Token & Print/ }), {
  pause: 300,
});
await page.waitForSelector("text=Token issued", { timeout: 15000 });
await beat(1800);

// Bring the off-canvas print slip on screen — this is the actual artwork the
// printer receives, so showing it beats describing it.
await page.evaluate(() => {
  const root = document.getElementById("print-root");
  if (!root) return;
  root.style.cssText =
    "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%) scale(1.3);" +
    "visibility:visible;z-index:2147483000;background:#fff;padding:10px 16px;" +
    "box-shadow:0 24px 60px rgba(0,0,0,.35);border-radius:6px;";
});
await beat(2600);
await page.evaluate(() => {
  const root = document.getElementById("print-root");
  if (root) root.style.cssText = "position:fixed;left:-10000px;visibility:hidden;";
});
await endScene();

/* 7 — the running bill */
beginScene("billing ledger");
await goto(`${BASE}/billing`);
const firstVisit = page.locator("li button").first();
if (await firstVisit.count()) {
  await click(firstVisit, { pause: 1300 });
  await click(page.getByRole("button", { name: "Lab", exact: true }).first(), {
    pause: 600,
  });
  const later = page
    .locator("li", { hasText: "Liver Function Test" })
    .getByRole("button", { name: "Later" });
  if (await later.count()) await click(later, { pause: 1600 });
  await beat(1200);
}
await endScene();

/* 8 — the owner's dashboard */
beginScene("analytics");
await goto(`${BASE}/admin`);
await type('input[aria-label="Admin PIN"]', "1234", { delay: 200 });
await click(page.getByRole("button", { name: "Unlock" }), { pause: 800 });
await page.waitForSelector("text=Revenue collected", { timeout: 12000 });
await beat(2000);
for (const y of [400, 850, 1300]) {
  await page.mouse.wheel(0, y);
  await beat(1500);
}
await endScene();

/* 9 — close on the screen reception actually lives in */
beginScene("close");
await goto(BASE);
await beat(1500);
await endScene();

/* -------------------------------------------------------------- finish */

await ctx.close();
await browser.close();

const file = readdirSync(RAW).find((f) => f.endsWith(".webm"));
if (!file) {
  console.error("no video produced");
  process.exit(1);
}
const dest = path.join(OUT, "raw.webm");
rmSync(dest, { force: true });
renameSync(path.join(RAW, file), dest);
rmSync(RAW, { recursive: true, force: true });

console.log(`\nvideo: ${dest}\n`);
