#!/usr/bin/env node
/*
  The clinic's print agent.

  Runs on the one PC the thermal printer is plugged into. It watches the token
  queue and prints whatever appears there, no matter which device created it.

      Tablet   ─┐
      Phone    ─┼──►  database  ◄──  this agent  ──►  COM port  ──►  slip
      Reception─┘                    (reception PC)

  Why this shape rather than each device printing its own slip: a tablet has
  no COM port and never will, so a token issued on one could not produce paper
  at all. Routing every slip through the machine that owns the printer means
  any device can issue, and the patient is handed their slip at the counter —
  which is where they are standing anyway.

  It is also what makes a second counter safe. Claims go through
  claim_pending_prints(), which uses `for update skip locked`, so two agents
  take different rows instead of both printing the same token twice.

  Run:  npm run print-agent
  See print-agent/README.md for installing it as a startup task.
*/

import { SerialPort } from "serialport";
import postgres from "postgres";

import { tokenSlipBytes } from "./slip.mjs";

const POLL_MS = Number(process.env.PRINT_AGENT_POLL_MS ?? 2000);
const BAUD = Number(process.env.PRINT_AGENT_BAUD ?? 9600);
/** Set to pin a specific COM port; otherwise the likeliest one is detected. */
const FIXED_PORT = process.env.PRINT_AGENT_COM ?? null;
/** How many slips to take per poll. Small: a claimed row that this agent then
    fails to print is stuck until requeue_stale_prints() releases it. */
const BATCH = Number(process.env.PRINT_AGENT_BATCH ?? 3);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "DATABASE_URL is not set.\n" +
      "Copy .env.example to .env.local and add the connection string, then run again.",
  );
  process.exit(1);
}

const sql = postgres(url, {
  max: 2,
  // The agent is long-lived and idles most of the day; a dropped connection
  // must not end the shift's printing.
  idle_timeout: 0,
  connect_timeout: 30,
  prepare: false,
  types: { bigint: postgres.BigInt },
});

/** Windows lists paired-but-absent Bluetooth devices as COM ports. They open
    happily and swallow every byte, which looks exactly like a printer that
    prints nothing — so the auto-pick requires a USB-ish device. */
const USB_SERIAL = /usb|ch340|cp210|ftdi|prolific|silicon/i;

async function detectPort() {
  if (FIXED_PORT) return FIXED_PORT;
  const ports = await SerialPort.list();
  const match = ports.find((p) =>
    USB_SERIAL.test(`${p.manufacturer ?? ""} ${p.pnpId ?? ""} ${p.path}`),
  );
  return match?.path ?? null;
}

function writeToPrinter(bytes, path) {
  return new Promise((resolve) => {
    const port = new SerialPort(
      { path, baudRate: BAUD, dataBits: 8, parity: "none", stopBits: 1, autoOpen: false },
    );

    port.open((openErr) => {
      if (openErr) {
        const msg = /access denied/i.test(openErr.message)
          ? `${path} is already in use. Close any other program holding it.`
          : openErr.message;
        resolve({ ok: false, error: msg });
        return;
      }

      // Drain before closing: closing with bytes still buffered truncates the
      // slip, usually losing the cut and sometimes the last printed lines.
      port.write(Buffer.from(bytes), (writeErr) => {
        if (writeErr) {
          port.close(() => resolve({ ok: false, error: writeErr.message }));
          return;
        }
        port.drain((drainErr) => {
          port.close(() =>
            resolve(drainErr ? { ok: false, error: drainErr.message } : { ok: true }),
          );
        });
      });
    });
  });
}

/** Everything the slip needs, read back from the database rather than passed
    from the issuing device — the tablet that created the token is long gone
    by the time this runs. print_receipt() returns the same shape
    issue_token_full() hands the app, so both print identical paper. */
async function loadReceipt(tokenId) {
  const rows = await sql`select print_receipt(${tokenId}) as receipt`;
  return rows[0]?.receipt ?? null;
}

async function loadClinic() {
  const rows = await sql`
    select mrn_prefix, name, address, phone, footer_note, paper_width
      from clinic_setting
     limit 1
  `;
  return rows[0] ?? null;
}

let printing = false;

async function tick(clinic) {
  // One pass at a time. A slow printer must not have a second poll stacking
  // claims behind it.
  if (printing) return;
  printing = true;

  try {
    // Release anything a crashed agent left claimed, so it is not lost.
    await sql`select requeue_stale_prints()`;

    const claimed = await sql`select * from claim_pending_prints(${BATCH})`;
    if (claimed.length === 0) return;

    const path = await detectPort();
    if (!path) {
      // Hand the rows back rather than failing them: the printer being off for
      // a minute should not mark a patient's slip permanently unprintable.
      for (const row of claimed) {
        await sql`
          update token set print_status = 'PENDING' where id = ${row.token_id}
        `;
      }
      console.warn("[print-agent] no printer found; returned claims to queue");
      return;
    }

    for (const row of claimed) {
      const receipt = await loadReceipt(row.token_id);
      if (!receipt) {
        await sql`select mark_print_result(${row.token_id}, false, ${"Token vanished before printing."})`;
        continue;
      }

      const bytes = tokenSlipBytes(receipt, clinic);
      const result = await writeToPrinter(bytes, path);

      await sql`
        select mark_print_result(
          ${row.token_id}, ${result.ok}, ${result.ok ? null : result.error}
        )
      `;
      console.log(
        result.ok
          ? `[print-agent] printed ${receipt.display_no} (${bytes.length} bytes) on ${path}`
          : `[print-agent] FAILED ${receipt.display_no}: ${result.error}`,
      );

      // Thermal heads need a beat between slips or the buffer overruns.
      if (claimed.length > 1) await new Promise((r) => setTimeout(r, 400));
    }
  } catch (error) {
    // Never let one bad poll end the loop — the clinic is open all day and a
    // dropped connection must recover on the next tick.
    console.error("[print-agent] poll failed:", error.message);
  } finally {
    printing = false;
  }
}

async function main() {
  const clinic = await loadClinic();
  if (!clinic) {
    console.error("No clinic_setting row found. Run the migrations first.");
    process.exit(1);
  }

  const path = await detectPort();
  console.log(`[print-agent] watching the queue every ${POLL_MS}ms`);
  console.log(
    path
      ? `[print-agent] printer on ${path} @ ${BAUD} baud`
      : "[print-agent] no printer detected yet — it will be picked up when plugged in",
  );

  setInterval(() => void tick(clinic), POLL_MS);
  void tick(clinic);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    console.log("\n[print-agent] stopping");
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("[print-agent] could not start:", error.message);
  process.exit(1);
});
