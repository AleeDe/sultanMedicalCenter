#!/usr/bin/env node
/*
  The clinic's local print agent.

  Why this exists: the app is served from Vercel, so the server that renders a
  token is in a Mumbai data centre and has no idea a printer exists. The
  printer is on a COM port of the reception PC. Something on that PC has to
  hold the port, and this is it.

  The flow:

      Browser (Vercel page)  ──►  this agent (localhost)  ──►  COM port
                                       reception PC

  The browser builds the ESC/POS bytes — the same src/lib/receipts.ts the
  other print routes use — and POSTs them here. Nothing about a token, a
  patient or a fee crosses this boundary: it receives an opaque byte array and
  writes it to a serial port. That keeps patient data off a second process
  entirely.

  Run it with:   node print-agent/agent.mjs
  Or install as a startup task — see print-agent/README.md.
*/

import { createServer } from "node:http";
import { SerialPort } from "serialport";

const PORT = Number(process.env.PRINT_AGENT_PORT ?? 3001);
const BAUD = Number(process.env.PRINT_AGENT_BAUD ?? 9600);
/** Set to pin a specific COM port; otherwise the likeliest one is detected. */
const FIXED_PORT = process.env.PRINT_AGENT_COM ?? null;

/*
  Origins allowed to print.

  A local HTTP server is reachable by any page the browser has open, so
  without this any site could make the clinic's printer emit paper. Only the
  deployed app and local development are permitted.

  Add the clinic's own domain here if the app moves off vercel.app.
*/
const ALLOWED_ORIGINS = new Set([
  "https://sultan-medical-center.vercel.app",
  "http://localhost:3000",
  "http://localhost:3001",
]);

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

/*
  One job at a time.

  Only one process may hold a COM port, and only one handle at a time within
  this process. Two tokens issued in the same second would otherwise race and
  one would fail with "Access denied".
*/
let queue = Promise.resolve();

function enqueue(job) {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

function writeToPrinter(bytes, path) {
  return enqueue(
    () =>
      new Promise((resolve) => {
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

          // Drain before closing: closing with bytes still buffered truncates
          // the slip, usually losing the cut and sometimes the last lines.
          port.write(Buffer.from(bytes), (writeErr) => {
            if (writeErr) {
              port.close(() => resolve({ ok: false, error: writeErr.message }));
              return;
            }
            port.drain((drainErr) => {
              port.close(() =>
                resolve(
                  drainErr
                    ? { ok: false, error: drainErr.message }
                    : { ok: true, port: path, bytes: bytes.length },
                ),
              );
            });
          });
        });
      }),
  );
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
    return true;
  }
  return false;
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const allowed = cors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(allowed ? 204 : 403).end();
    return;
  }

  if (!allowed) {
    // Refuse outright rather than printing for an unknown page.
    json(res, 403, { ok: false, error: "Origin not allowed." });
    return;
  }

  // Lets the app show "printer ready" without sending a job.
  if (req.method === "GET" && req.url === "/status") {
    const path = await detectPort();
    json(res, 200, { ok: true, ready: path !== null, port: path });
    return;
  }

  if (req.method !== "POST" || req.url !== "/print") {
    json(res, 404, { ok: false, error: "Not found." });
    return;
  }

  let raw = "";
  let tooBig = false;
  req.on("data", (chunk) => {
    raw += chunk;
    // A slip is ~1KB. Anything near a megabyte is a bug or an abuse, and
    // either way must not tie up the port or this process's memory.
    if (raw.length > 1_000_000) {
      tooBig = true;
      req.destroy();
    }
  });

  req.on("end", async () => {
    if (tooBig) return;
    try {
      const body = JSON.parse(raw);
      const bytes = body?.bytes;
      if (!Array.isArray(bytes) || bytes.length === 0) {
        json(res, 400, { ok: false, error: "No bytes to print." });
        return;
      }

      const path = body.port ?? (await detectPort());
      if (!path) {
        json(res, 200, {
          ok: false,
          error: "No printer found on a COM port. Check it is plugged in and on.",
        });
        return;
      }

      const result = await writeToPrinter(bytes, path);
      console.log(
        result.ok
          ? `[print-agent] sent ${result.bytes} bytes to ${result.port}`
          : `[print-agent] failed: ${result.error}`,
      );
      json(res, 200, result);
    } catch (error) {
      json(res, 400, { ok: false, error: `Bad request: ${error.message}` });
    }
  });
});

// Bind to loopback only. On 0.0.0.0 anyone on the clinic wifi could print.
server.listen(PORT, "127.0.0.1", async () => {
  const path = await detectPort();
  console.log(`[print-agent] listening on http://127.0.0.1:${PORT}`);
  console.log(
    path
      ? `[print-agent] printer detected on ${path} @ ${BAUD} baud`
      : "[print-agent] no printer detected yet — plug it in and it will be found on the next print",
  );
});
