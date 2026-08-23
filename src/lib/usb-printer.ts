/*
  Direct USB printing via WebUSB.

  The browser claims the printer's USB interface and writes raw ESC/POS bytes
  to its bulk-OUT endpoint. Windows is bypassed entirely, which is why this
  works when the Windows driver is missing or broken — the "Driver is
  unavailable" case — and why no print dialog can appear.

  Requirements the user must satisfy once:
   * Chrome or Edge (WebUSB is Chromium-only; Firefox and Safari do not ship it)
   * a secure context: https, or http://localhost during development
   * one click on "Connect printer" to grant permission for that device

  The grant is remembered per origin + device, so reception connects once and
  the printer is picked up automatically on every later visit.

  On Windows the printer must not be claimed by a class driver at the same
  time. If claiming fails, Zadig can rebind the device to WinUSB — the setup
  screen explains this.
*/

const STORAGE_KEY = "tokgen.usbPrinter";

/** Vendor IDs seen on the common 58/80mm thermal printers. */
const KNOWN_VENDORS = [
  0x0416, // Winbond — Xprinter, many generic POS-58/80
  0x0483, // STMicroelectronics — Gprinter and clones
  0x04b8, // Epson
  0x0519, // Star Micronics
  0x0dd4, // Custom / Bixolon
  0x1a86, // QinHeng CH34x — USB-serial style boards
  0x1fc9, // NXP
  0x6868, // Zjiang / Rongta
  0x0fe6, // ICS Advent — POS-X
  0x28e9, // Gprinter
  0x1cbe, // Luminary
];

export type UsbStatus =
  | { state: "unsupported"; reason: string }
  | { state: "disconnected" }
  | { state: "connected"; name: string };

export function isWebUsbSupported(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

/** Why WebUSB is unavailable, phrased for a non-technical reader. */
export function unsupportedReason(): string | null {
  if (typeof navigator === "undefined") return null;
  if (!("usb" in navigator)) {
    return "This browser cannot talk to USB devices. Use Google Chrome or Microsoft Edge.";
  }
  if (
    typeof window !== "undefined" &&
    !window.isSecureContext &&
    window.location.hostname !== "localhost"
  ) {
    return "USB printing needs a secure connection (https). Open the app over https, or use localhost during setup.";
  }
  return null;
}

export class UsbPrinter {
  private device: USBDevice | null = null;
  private endpoint = 0;
  private iface = 0;
  private restoring: Promise<boolean> | null = null;

  get connected() {
    return this.device?.opened === true;
  }

  get name() {
    if (!this.device) return "";
    return (
      this.device.productName ||
      `USB device ${hex(this.device.vendorId)}:${hex(this.device.productId)}`
    );
  }

  /** Reconnects silently to a printer the user already approved. */
  /**
   * Reconnects silently to a printer the user already approved.
   *
   * Safe to call repeatedly: every page navigation mounts a fresh hook, and
   * re-opening an already-open device throws. Without the early return the
   * reconnect failed and the UI fell back to asking for permission again on
   * every screen — the "I have to connect it every time" symptom.
   */
  async restore(): Promise<boolean> {
    if (this.connected) return true;
    if (!isWebUsbSupported()) return false;

    // A concurrent restore (two components mounting at once) must not open
    // the same device twice.
    if (this.restoring) return this.restoring;

    this.restoring = (async () => {
      try {
        const saved = readSaved();
        const devices = await navigator.usb.getDevices();
        const match =
          devices.find(
            (d) =>
              saved &&
              d.vendorId === saved.vendorId &&
              d.productId === saved.productId,
          ) ?? devices[0];

        if (!match) return false;
        await this.open(match);
        return true;
      } catch {
        return false;
      } finally {
        this.restoring = null;
      }
    })();

    return this.restoring;
  }

  /** Opens the browser's device chooser. Must be called from a user gesture. */
  async connect(): Promise<void> {
    if (!isWebUsbSupported()) {
      throw new Error(unsupportedReason() ?? "WebUSB is not available.");
    }
    // Class 7 is "Printer"; the vendor list catches boards that report
    // themselves as vendor-specific instead.
    const device = await navigator.usb.requestDevice({
      filters: [
        { classCode: 0x07 },
        ...KNOWN_VENDORS.map((vendorId) => ({ vendorId })),
      ],
    });
    await this.open(device);
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ vendorId: device.vendorId, productId: device.productId }),
    );
  }

  private async open(device: USBDevice) {
    // opened is true if another tab or an earlier mount already claimed it.
    if (!device.opened) await device.open();
    if (!device.configuration) await device.selectConfiguration(1);

    // Find an interface exposing a bulk OUT endpoint — that is where the
    // byte stream goes. Printer-class interfaces are preferred.
    const candidates = (device.configuration?.interfaces ?? []).flatMap((i) =>
      i.alternates.map((alt) => ({ number: i.interfaceNumber, alt })),
    );
    const chosen =
      candidates.find(
        (c) =>
          c.alt.interfaceClass === 0x07 &&
          c.alt.endpoints.some(
            (e) => e.direction === "out" && e.type === "bulk",
          ),
      ) ??
      candidates.find((c) =>
        c.alt.endpoints.some((e) => e.direction === "out" && e.type === "bulk"),
      );

    if (!chosen) {
      await device.close();
      throw new Error(
        "That device does not accept printer data. Pick the thermal printer, not a hub or adapter.",
      );
    }

    try {
      await device.claimInterface(chosen.number);
    } catch (e) {
      // Already claimed by this page is fine — that is a re-entrant restore,
      // not a conflict. Anything else means Windows still owns the device.
      const already = e instanceof Error && /already claimed/i.test(e.message);
      if (!already) {
        await device.close().catch(() => {});
        throw new Error(
          "Windows is holding this printer. Remove it from Settings → Printers & scanners, unplug and replug it, then connect again.",
        );
      }
    }

    this.device = device;
    this.iface = chosen.number;
    this.endpoint = chosen.alt.endpoints.find(
      (e) => e.direction === "out" && e.type === "bulk",
    )!.endpointNumber;
  }

  async print(bytes: Uint8Array): Promise<void> {
    if (!this.device?.opened) {
      throw new Error("Printer is not connected.");
    }
    // Chunked: some controllers stall on large single transfers.
    const CHUNK = 4096;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const slice = bytes.slice(i, i + CHUNK);
      const res = await this.device.transferOut(this.endpoint, slice);
      if (res.status !== "ok") {
        throw new Error(`Printer rejected the data (${res.status}).`);
      }
    }
  }

  async disconnect(): Promise<void> {
    if (!this.device) return;
    try {
      await this.device.releaseInterface(this.iface);
      await this.device.close();
    } catch {
      // Already gone — nothing to release.
    }
    this.device = null;
  }

  static forget() {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function readSaved(): { vendorId: number; productId: number } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function hex(n: number) {
  return `0x${n.toString(16).padStart(4, "0")}`;
}

/** One shared instance — the printer is a single physical resource. */
export const usbPrinter = new UsbPrinter();
