import { chromium } from "playwright";
const b = await chromium.launch({ channel: "msedge", headless: true });
let fail = 0;
const check = (n, ok, d = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};
const p = await b.newPage({ viewport: { width: 1512, height: 950 } });
p.on("pageerror", (e) => console.log("EXC:", e.message));

await p.goto("http://localhost:3000/admin", { waitUntil: "networkidle" });
await p.getByLabel(/PIN/i).first().fill("1234");
await p.getByRole("button", { name: /Unlock|Sign in|Enter/i }).first().click();
await p.waitForTimeout(3000);

const body = (await p.locator("body").textContent()) ?? "";
check("revenue is populated", /Rs\.\s*[1-9][\d,]{4,}/.test(body),
      (body.match(/Rs\.\s*[\d,]+/) ?? [""])[0]);
check("tokens issued is populated", /\b[1-9]\d{2,}\b/.test(body));
check("the trend chart has data",
      (await p.locator("svg path, svg polyline").count()) > 0);
// Bars are divs with an inline height, not SVG rects.
const bars = await p.evaluate(() =>
  [...document.querySelectorAll("div[title*='tokens'], div[title*='—']")]
    .filter((el) => parseFloat(el.style.height) > 3).length,
);
check("busiest hours has bars", bars > 3, `${bars} bars`);
check("doctors are ranked", (await p.getByText("Dr. Ahmed Raza").count()) > 0);
check("tests are ranked", /X-Ray|Ultrasound|Blood/.test(body));
check("frequent patients listed", /MRN-\d+/.test(body));

await p.screenshot({ path: process.argv[2] + "/14-analytics-seeded.png", fullPage: true });

// The accuracy tab needs finished consultations, which the seed does not create.
await p.getByRole("button", { name: "Wait accuracy" }).click();
await p.waitForTimeout(2500);
const acc = (await p.locator("body").textContent()) ?? "";
check("wait accuracy explains itself when empty",
      /Not enough finished consultations/i.test(acc));

console.log(fail ? `\n${fail} FAILED` : "\nAll checks passed.");
await b.close();
process.exitCode = fail ? 1 : 0;
