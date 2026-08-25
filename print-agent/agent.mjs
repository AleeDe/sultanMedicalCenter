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

/*
  The database, from whichever source applies.

  PRINT_AGENT_BAKED_DB is substituted at build time by print-agent/build-exe.mjs
  and is how the packaged .exe knows where to connect — the clinic's PC has no
  .env file and nobody there should have to make one. DATABASE_URL still wins
  when set, so running from the repo during development behaves as before.
*/
const url = process.env.DATABASE_URL || process.env.PRINT_AGENT_BAKED_DB;
if (!url) {
  console.error(
    "No database configured.\n" +
      "From the repo: set DATABASE_URL in .env.local.\n" +
      "This is a bug if you are seeing it from the packaged .exe.",
  );
  process.exit(1);
}

/** True when running as the packaged .exe rather than from the repo. Used to
    decide whether to offer installation and hold the window open — behaviour
    that would only get in the way during development. */
const PACKAGED = Boolean(process.pkg) || /TokenPrinter/i.test(process.execPath);

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

      /*
        Write, drain, then WAIT before closing.

        drain() only promises the bytes left the OS buffer — not that the
        printer consumed them. At 9600 baud a full slip is a little over a
        second on the wire, and closing the port underneath it truncated the
        job: short test slips printed fine while real ones came out blank,
        which is exactly the shape of "it worked before, now it doesn't".

        The wait is computed from the actual byte count rather than fixed, so
        a long slip gets the time it needs and a short one is not delayed.
        10 bits per byte covers the start and stop bits, and 250ms of slack
        covers the printer's own buffering.
      */
      const wireMs = Math.ceil((bytes.length * 10 * 1000) / BAUD) + 250;

      port.write(Buffer.from(bytes), (writeErr) => {
        if (writeErr) {
          port.close(() => resolve({ ok: false, error: writeErr.message }));
          return;
        }
        port.drain((drainErr) => {
          if (drainErr) {
            port.close(() => resolve({ ok: false, error: drainErr.message }));
            return;
          }
          setTimeout(() => {
            port.close(() => resolve({ ok: true }));
          }, wireMs);
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
  if (!rows[0]) return null;

  /*
    Paper width belongs to the printer, not the database.

    clinic_setting.paper_width is one value shared by every device, but the
    roll is a property of the machine this agent is standing next to — a
    second counter may well have the other size. When they disagree the slip
    does not fail, it silently prints an 80-column layout onto 58mm paper and
    every line wraps: "NORM-00518" comes out as "NORM-0051" then "8".

    So the width can be fixed to this printer: PRINT_AGENT_BAKED_PAPER is set
    when the .exe is built (the clinic has no environment to set), and
    PRINT_AGENT_PAPER overrides it when running from the repo.
  */
  const override = Number(
    process.env.PRINT_AGENT_PAPER || process.env.PRINT_AGENT_BAKED_PAPER,
  );
  if (override === 58 || override === 80) {
    return { ...rows[0], paper_width: override };
  }
  return rows[0];
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

/*
  Register the .exe to start with Windows, and copy it somewhere stable.

  Run from Downloads, the shortcut would break the moment someone tidied that
  folder up — so the executable is copied to the user's AppData first and the
  shortcut points there. Both steps are per-user, needing no administrator
  rights, which matters on a clinic PC where staff rarely have them.

  Idempotent: running it a second time refreshes both rather than complaining.
*/
async function installToStartup() {
  const { copyFile, mkdir, writeFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");

  const home = path.join(os.homedir(), "AppData", "Local", "TokenPrinter");
  const installed = path.join(home, "TokenPrinter.exe");
  const startup = path.join(
    os.homedir(),
    "AppData", "Roaming", "Microsoft", "Windows",
    "Start Menu", "Programs", "Startup",
  );

  await mkdir(home, { recursive: true });

  /*
    Copy in, unless already running from there — which is every boot after the
    first.

    A copy already running holds a lock on the file, so installing a newer .exe
    over it fails with EBUSY and the startup entry is then pointing at a
    half-replaced binary that will not launch. Stopping the old one first is
    what makes "double-click the new version" work the way anyone would expect.
  */
  if (path.resolve(process.execPath) !== path.resolve(installed)) {
    try {
      await copyFile(process.execPath, installed);
    } catch (error) {
      if (error.code !== "EBUSY" && error.code !== "EPERM") throw error;

      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile);

      console.log("   An older copy is running. Stopping it first...");
      /*
        By PID, never by image name: this process is also TokenPrinter.exe, so
        `taskkill /IM` would kill the installer along with the thing it is
        replacing, leaving the copy half-done and nothing running.
      */
      // PowerShell rather than wmic, which is deprecated and absent from
      // recent Windows 11 installs.
      const { stdout } = await run("powershell", [
        "-NoProfile", "-Command",
        "Get-Process TokenPrinter -ErrorAction SilentlyContinue | " +
          "Select-Object -ExpandProperty Id",
      ]).catch(() => ({ stdout: "" }));

      for (const line of stdout.split(/\r?\n/)) {
        const pid = Number(line.trim());
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
          await run("taskkill", ["/F", "/PID", String(pid)]).catch(() => {});
        }
      }
      // Windows releases the lock a moment after the process goes.
      await new Promise((r) => setTimeout(r, 1500));
      await copyFile(process.execPath, installed);
    }
  }

  if (!existsSync(startup)) return { installed, shortcut: null };

  /*
    A .vbs launcher rather than a shortcut to the .exe directly: it starts the
    agent with no console window at all. A visible window invites someone to
    close it, and printing would stop with no sign of why.
  */
  const vbs = path.join(startup, "Token Printer.vbs");
  await writeFile(
    vbs,
    'Set sh = CreateObject("WScript.Shell")\r\n' +
      `sh.Run """${installed}"" --service", 0, False\r\n`,
    "utf8",
  );

  return { installed, shortcut: vbs };
}

async function main() {
  /*
    Double-clicked, the .exe installs itself and says so. Started by Windows it
    passes --service and goes straight to work.

    The clinic's whole setup is therefore: put this file on the reception PC,
    double-click it once.
  */
  if (PACKAGED && !process.argv.includes("--service")) {
    console.log("");
    console.log("   Token Printer");
    console.log("   =============");
    console.log("");
    try {
      const { installed, shortcut } = await installToStartup();
      console.log(`   Installed to: ${installed}`);
      console.log(
        shortcut
          ? "   It will now start automatically whenever this PC starts."
          : "   Could not find the Startup folder; it will not auto-start.",
      );
    } catch (error) {
      console.log(`   Could not install for auto-start: ${error.message}`);
      console.log("   It will still print for as long as this window is open.");
    }
    console.log("");
    console.log("   Checking the printer...");
    console.log("");
  }

  const clinic = await loadClinic();
  if (!clinic) {
    // Phrased for whoever is standing at the PC, not for a developer: they
    // cannot run a migration and should be told who can.
    await fail("The clinic's settings could not be read from the database.");
  }

  const port = await detectPort();

  if (PACKAGED && !process.argv.includes("--service")) {
    console.log(
      port
        ? `   Printer found on ${port}. Ready.`
        : "   No printer found yet.\n" +
            "   Check it is plugged in and switched on - it will be picked up\n" +
            "   automatically as soon as it is.",
    );
    console.log("");
    console.log("   You can close this window. Printing continues in the");
    console.log("   background, and starts again by itself when the PC does.");
    console.log("");
    await hold(12);
  } else {
    console.log(`[print-agent] watching the queue every ${POLL_MS}ms`);
    console.log(
      port
        ? `[print-agent] printer on ${port} @ ${BAUD} baud`
        : "[print-agent] no printer detected yet — it will be picked up when plugged in",
    );
  }

  setInterval(() => void tick(clinic), POLL_MS);
  void tick(clinic);
}

/** Keeps a double-clicked window on screen long enough to be read. Windows
    closes it the instant the process ends, taking the message with it. */
function hold(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** Reports a fatal problem in words the clinic can act on, then waits so the
    window does not vanish before anyone reads it. */
async function fail(message) {
  console.error("");
  console.error(`   ${message}`);
  console.error("");
  console.error("   Please send this message to whoever set up the system.");
  console.error("");
  if (PACKAGED) await hold(30);
  process.exit(1);
}

/*
  Stay alive through anything that is not a deliberate stop.

  Without these, a single unhandled rejection ends the process — and because it
  runs windowless, nobody sees it go. Printing simply stops, tokens queue up,
  and the next person to notice is a patient who never got a slip. The clinic
  is open all day; a dropped database connection or a printer unplugged at the
  wrong moment must cost one poll, not the rest of the shift.

  Deliberate stops (Ctrl+C, taskkill, an upgrade) still exit below.
*/
process.on("unhandledRejection", (reason) => {
  console.error("[print-agent] unhandled rejection (continuing):", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[print-agent] uncaught error (continuing):", error?.message);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    console.log("\n[print-agent] stopping");
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(0);
  });
}

main().catch(async (error) => {
  // A network failure is the one the clinic can actually fix themselves, so
  // it gets its own words rather than a driver-level message.
  const message = /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|getaddrinfo/i.test(
    String(error.message),
  )
    ? "Could not reach the clinic's database. Check this PC is online."
    : `Could not start: ${error.message}`;
  await fail(message);
});
