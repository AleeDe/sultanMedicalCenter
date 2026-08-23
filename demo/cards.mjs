/*
  Renders the title and end cards.

  Built as HTML in the same browser that records the walkthrough, so they
  inherit the product's own typography and palette rather than looking like
  something bolted on in an editor. Each card is captured as a PNG; build.mjs
  turns the stills into timed clips with a slow push-in.

  Usage: node demo/cards.mjs   (writes demo/out/card-*.png)
*/
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "demo", "out");
mkdirSync(OUT, { recursive: true });

const CLINIC = process.env.DEMO_CLINIC ?? "Shifa Medical Centre";
const W = 1440;
const H = 900;

const shell = (body, extra = "") => `<!doctype html>
<html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    width:${W}px; height:${H}px; display:grid; place-items:center;
    font-family:Inter,system-ui,sans-serif; color:#0b1524;
    background:
      radial-gradient(900px 620px at 22% 12%, #e8f1fa 0%, transparent 62%),
      radial-gradient(760px 560px at 84% 88%, #eaf3ec 0%, transparent 60%),
      #f4f7fa;
  }
  .wrap { text-align:center; }
  .mark {
    width:74px; height:74px; margin:0 auto 26px; border-radius:20px;
    background:#0b5fa5; display:grid; place-items:center;
    box-shadow:0 16px 40px -12px rgba(11,95,165,.55);
  }
  .mark svg { width:36px; height:36px; fill:#fff; }
  h1 { font-size:56px; font-weight:800; letter-spacing:-1.6px; line-height:1.05; }
  h2 { font-size:26px; font-weight:600; color:#33415c; margin-top:14px; }
  .sub { font-size:17px; color:#64748b; margin-top:20px; }
  .rule { width:56px; height:4px; background:#0b5fa5; border-radius:2px;
          margin:26px auto 0; }
  .chips { display:flex; gap:10px; justify-content:center; margin-top:30px;
           flex-wrap:wrap; }
  .chip { padding:9px 18px; border-radius:999px; background:#fff;
          border:1px solid #dde3ea; font-size:15px; font-weight:600;
          color:#33415c; box-shadow:0 2px 8px rgba(11,21,36,.05); }
  ${extra}
</style></head><body>${body}</body></html>`;

const MARK = `<div class="mark"><svg viewBox="0 0 24 24">
  <path d="M9.5 2h5v5.5H20v5h-5.5V18h-5v-5.5H4v-5h5.5z"/></svg></div>`;

const CARDS = {
  "card-intro": shell(`<div class="wrap">
    ${MARK}
    <h1>${CLINIC}</h1>
    <h2>Token &amp; Billing System</h2>
    <div class="rule"></div>
    <p class="sub">Reception &middot; Labs &middot; Billing &middot; Reports</p>
  </div>`),

  "card-outro": shell(`<div class="wrap">
    ${MARK}
    <h1>Tayyar hai</h1>
    <h2>Aap ke clinic ke liye</h2>
    <div class="chips">
      <span class="chip">Tez token</span>
      <span class="chip">Ek hi bill</span>
      <span class="chip">Poora hisaab</span>
    </div>
    <p class="sub" style="margin-top:34px">${CLINIC}</p>
  </div>`),
};

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
});

for (const [name, html] of Object.entries(CARDS)) {
  await page.setContent(html, { waitUntil: "networkidle" });
  // Give the webfont a moment; a card captured mid-swap looks amateurish.
  await page.waitForTimeout(700);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  ${name}.png`);
}

await browser.close();
