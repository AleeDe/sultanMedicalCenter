import "server-only";

/*
  Direct serial printing to a thermal printer on a COM port.

  This is the third print route, alongside WebUSB (src/lib/usb-printer.ts) and
  the browser dialog. It exists because a printer that enumerates as a USB CDC
  serial device — "USB Serial Device (COM7)", VID_0483 — is reachable from the
  machine running the server, but not from WebUSB without the user first
  granting the device through a chooser.

  The trade-off versus WebUSB: no permission click, ever, so reception clicks
  Print and paper comes out. The cost is that the printer must be attached to
  the machine running `next start`, not to the machine holding the browser. In
  a single-PC clinic those are the same box, which is the deployment this
  targets.

  Only one process may hold a COM port at a time, so the port is opened per
  job and closed in a finally. Concurrent jobs are serialised through a
  promise chain rather than racing for the handle — two receptionists printing
  at once would otherwise get "Access denied".
*/

/** Fallback when no port is configured or detected. */
const DEFAULT_BAUD = 9600;

/** Matches a USB-attached serial device rather than a Bluetooth phantom port.

    Windows lists paired-but-absent Bluetooth devices as "Standard Serial over
    Bluetooth link" COM ports. They open successfully and silently swallow
    every byte, so picking one looks exactly like a printer that prints
    nothing. Requiring a USB path keeps the auto-pick off them. */
const USB_SERIAL = /usb|ch340|cp210|ftdi|prolific|silicon/i;

export type SerialPortInfo = {
  path: string;
  label: string;
  /** True when this looks like a real USB device rather than Bluetooth. */
  likely: boolean;
};

export type SerialPrintResult =
  | { ok: true; port: string; bytes: number }
  | { ok: false; error: string; port?: string };

type PortModule = typeof import("serialport");

/**
 * Loads serialport lazily.
 *
 * It is a native addon: on a machine where the build did not run, importing it
 * at module scope would break every page that transitively imports this file,
 * not just printing. Failure here is reported as a printing problem instead.
 */
async function loadSerialPort(): Promise<PortModule | null> {
  try {
    return await import("serialport");
  } catch (cause) {
    console.error("[serial-printer] serialport failed to load:", cause);
    return null;
  }
}

/** Ports the server can see, for the setup screen's picker. */
export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  const mod = await loadSerialPort();
  if (!mod) return [];

  try {
    const ports = await mod.SerialPort.list();
    return ports.map((p) => {
      const haystack = `${p.manufacturer ?? ""} ${p.pnpId ?? ""} ${p.path}`;
      return {
        path: p.path,
        label: [p.path, p.manufacturer].filter(Boolean).join(" — "),
        likely: USB_SERIAL.test(haystack),
      };
    });
  } catch (cause) {
    // Logged rather than swallowed: an enumeration failure otherwise looks
    // identical to "no printer attached" and sends diagnosis the wrong way.
    console.error("[serial-printer] could not enumerate ports:", cause);
    return [];
  }
}

/** Picks the most printer-like port when the user has not chosen one. */
async function autoDetectPort(): Promise<string | null> {
  const ports = await listSerialPorts();
  return ports.find((p) => p.likely)?.path ?? null;
}

/*
  Serialises print jobs.

  Each job chains onto the previous one's completion, so the port is never
  opened twice concurrently. Errors are swallowed here so one failed job does
  not poison the chain for the next.
*/
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

/**
 * Writes raw ESC/POS bytes to the printer's COM port.
 *
 * `bytes` arrives as a plain number array: this is called across the server
 * action boundary, where a Uint8Array does not survive serialisation intact.
 */
export async function printBytesOverSerial(
  bytes: number[],
  options: { port?: string; baudRate?: number } = {},
): Promise<SerialPrintResult> {
  if (bytes.length === 0) {
    return { ok: false, error: "Nothing to print." };
  }

  const mod = await loadSerialPort();
  if (!mod) {
    return {
      ok: false,
      error:
        "Serial printing is unavailable on this server. It only works when the app runs on the machine the printer is plugged into.",
    };
  }

  const target = options.port ?? (await autoDetectPort());
  if (!target) {
    return {
      ok: false,
      error:
        "No printer found on a COM port. Check it is plugged in and switched on.",
    };
  }

  return enqueue(async () => {
    const port = new mod.SerialPort({
      path: target,
      baudRate: options.baudRate ?? DEFAULT_BAUD,
      dataBits: 8,
      parity: "none",
      stopBits: 1,
      autoOpen: false,
    });

    const open = () =>
      new Promise<void>((resolve, reject) =>
        port.open((err) => (err ? reject(err) : resolve())),
      );

    /* Write then drain. Closing the port with bytes still buffered truncates
       the slip — usually losing the cut, sometimes the last few lines. */
    const write = (buffer: Buffer) =>
      new Promise<void>((resolve, reject) =>
        port.write(buffer, (err) =>
          err ? reject(err) : port.drain((e) => (e ? reject(e) : resolve())),
        ),
      );

    try {
      await open();
      await write(Buffer.from(bytes));
      console.log(`[serial-printer] sent ${bytes.length} bytes to ${target}`);
      return { ok: true as const, port: target, bytes: bytes.length };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown printing error.";
      // "Access denied" is by far the most common failure and its cause is
      // never obvious, so it is translated rather than passed through raw.
      const friendly = /access denied/i.test(message)
        ? `${target} is already in use. Close any other program holding the port, then try again.`
        : message;
      return { ok: false as const, error: friendly, port: target };
    } finally {
      if (port.isOpen) {
        await new Promise((resolve) => port.close(() => resolve(null)));
      }
    }
  });
}
