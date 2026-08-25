"use server";

import { requireReception } from "@/lib/auth";
import {
  listSerialPorts,
  printBytesOverSerial,
  type SerialPortInfo,
} from "@/lib/serial-printer";
import type { ActionResult } from "@/app/actions/tokens";

/*
  The server half of serial printing.

  The browser cannot open a COM port — serialport is a native Node module — so
  the slip bytes are built on the client (from the same receipts.ts used by the
  WebUSB path) and posted here to be written to the port.
*/

/**
 * Writes already-built ESC/POS bytes to the thermal printer.
 *
 * Bytes rather than a receipt object: the layout is shared with the WebUSB and
 * browser routes, so it is built once on the client and every route prints
 * exactly the same paper. Sending a receipt instead would mean two layout
 * code paths that could drift apart.
 *
 * Reception auth is still required — this writes to physical hardware, and an
 * unauthenticated caller should not be able to make the printer emit paper.
 */
export async function printSlipOverSerial(
  bytes: number[],
  options: { port?: string } = {},
): Promise<ActionResult<{ port: string; bytes: number }>> {
  await requireReception();

  // A slip is ~1KB; a whole roll's worth of bytes in one call is a bug or an
  // abuse, and either way should not tie up the port.
  if (bytes.length > 64_000) {
    return { ok: false, error: "Print job too large." };
  }

  const result = await printBytesOverSerial(bytes, options);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, data: { port: result.port, bytes: result.bytes } };
}

/** Ports the server can see, for the printer picker on the setup screen. */
export async function getSerialPorts(): Promise<SerialPortInfo[]> {
  await requireReception();
  return listSerialPorts();
}
