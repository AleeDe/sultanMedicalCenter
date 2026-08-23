"use client";

import { useState } from "react";
import { Alert, Badge, Button, Card } from "@/components/ui";
import { IconCheck, IconCross, IconPrinter } from "@/components/icons";
import { testSlipBytes } from "@/lib/receipts";
import { usePrinter } from "@/lib/use-printer";
import type { ClinicSetting } from "@/lib/types";

/*
  Printer setup, offering the two ways this app can reach paper.

  USB (recommended) — the browser claims the printer's USB interface and
  writes ESC/POS bytes to it. Windows is not involved, so a missing or broken
  Windows driver does not matter, and no print dialog exists to suppress.
  Connect once; the permission is remembered per origin.

  Browser printing (fallback) — window.print() through the Windows driver. A
  web page CANNOT suppress that dialog; only launching Chrome itself with
  --kiosk-printing hides it, which is a per-machine setting the app cannot
  apply for itself.
*/

export function PrintSetup({
  appUrl,
  clinic,
}: {
  appUrl: string;
  clinic: ClinicSetting;
}) {
  const printer = usePrinter();
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState<null | "ok" | "sent">(null);

  return (
    <div className="grid gap-4">
      {/* ------------------------------------------------ recommended: USB */}
      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <span
            className={`flex h-10 w-10 items-center justify-center rounded-[10px] ${
              printer.usbReady
                ? "bg-[var(--ok-soft)] text-[var(--ok)]"
                : "bg-sunken text-muted"
            }`}
            aria-hidden
          >
            <IconPrinter className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="font-bold">Connect the printer over USB</h2>
            <p className="text-sm text-muted">
              No Windows driver, no print dialog. Recommended.
            </p>
          </div>
          {printer.usbReady && (
            <Badge tone="ok">
              <IconCheck className="h-3.5 w-3.5" />
              Connected
            </Badge>
          )}
        </div>

        {printer.unsupported ? (
          <Alert>{printer.unsupported}</Alert>
        ) : (
          <>
            <Alert tone="info">
              This talks to the printer directly, so it works even when Windows
              says <strong>&ldquo;Driver is unavailable&rdquo;</strong>. You
              only have to do this once on each computer.
            </Alert>

            {printer.usbReady ? (
              <div className="mt-4">
                <p className="mb-3 text-sm">
                  Connected to <strong>{printer.usbName}</strong>. Slips now
                  print straight to paper.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="ok"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      const used = await printer.print(testSlipBytes(clinic));
                      setTested(used === "usb" ? "ok" : "sent");
                      setBusy(false);
                    }}
                  >
                    <IconPrinter className="h-[18px] w-[18px]" />
                    {busy ? "Printing…" : "Print a test slip"}
                  </Button>
                  <Button variant="danger" onClick={printer.disconnect}>
                    <IconCross className="h-[18px] w-[18px]" />
                    Disconnect
                  </Button>
                </div>
                {tested === "ok" && (
                  <p className="mt-3 text-sm font-semibold text-[var(--ok)]">
                    Sent to the printer. If paper came out, setup is complete.
                  </p>
                )}
              </div>
            ) : (
              <div className="mt-4">
                <Button
                  variant="primary"
                  size="lg"
                  onClick={printer.connect}
                  className="w-full sm:w-auto"
                >
                  <IconPrinter className="h-[18px] w-[18px]" />
                  Connect printer
                </Button>
                <p className="mt-2 text-xs text-muted">
                  A window will list the USB devices — pick the thermal printer.
                  Needs Chrome or Edge.
                </p>
              </div>
            )}

            {printer.error && (
              <div className="mt-3">
                <Alert>{printer.error}</Alert>
              </div>
            )}
          </>
        )}
      </Card>

      {/* -------------------------------------------- if USB does not work */}
      <Card className="p-5">
        <h2 className="font-bold">If the printer does not appear in the list</h2>
        <ol className="mt-2.5 grid gap-3 text-sm text-[var(--ink-2)]">
          <Li n={1}>
            <strong>Windows may be holding it.</strong> Go to Settings →
            Bluetooth &amp; devices → Printers &amp; scanners, remove every
            <strong> DPRINTER </strong> entry (including the one marked
            &ldquo;Driver is unavailable&rdquo;), then unplug the USB cable and
            plug it back in.
          </Li>
          <Li n={2}>
            <strong>Check the cable and power.</strong> The printer must be
            switched on with paper loaded before the browser can see it.
          </Li>
          <Li n={3}>
            <strong>Try a different USB port</strong> — preferably one directly
            on the machine rather than through a hub.
          </Li>
          <Li n={4}>
            <strong>Still nothing?</strong> Some boards need the WinUSB driver
            before a browser can claim them. The free tool{" "}
            <strong>Zadig</strong> switches the device over to WinUSB in about a
            minute. Do this only if the steps above fail.
          </Li>
        </ol>
      </Card>

      {/* ------------------------- printing through Windows, with no dialog */}
      <Card className="p-5">
        <h2 className="font-bold">Print straight to the default printer</h2>
        <p className="mt-1 text-sm text-muted">
          For printing through Windows instead of USB, with no dialog.
        </p>

        <div className="mt-3">
          <Alert tone="info">
            A web page cannot switch off the print dialog by itself — browsers
            block that deliberately, so no site can make paper appear without
            consent. It disappears only when Chrome is <strong>started</strong>{" "}
            with <code>--kiosk-printing</code>, which is what the file below
            sets up. One-time job per computer.
          </Alert>
        </div>

        <div className="mt-4">
          <Button
            variant="primary"
            size="lg"
            onClick={() => downloadBat(appUrl)}
            className="w-full sm:w-auto"
          >
            Download setup file
          </Button>
          <p className="mt-2 text-sm text-muted">
            Run it once. It creates the desktop shortcut, then offers to restart
            the browser so silent printing takes effect immediately.
          </p>
        </div>

        <div className="mt-4 rounded-[var(--r-sm)] border border-[var(--line)] bg-sunken p-3.5 text-sm">
          <p className="mb-1.5 font-semibold">
            Why the browser has to restart
          </p>
          <p className="text-[var(--ink-2)]">
            The flag only applies to a browser <em>started</em> with it. Opening
            the app in a window that is already running silently reuses that
            process, and the dialog comes back — which is why the setup file
            closes the browser for you rather than asking you to remember.
          </p>
          <p className="mt-2.5 text-[var(--ink-2)]">
            Afterwards, always open the app from the{" "}
            <strong>Token System</strong> shortcut.
          </p>
        </div>

        <div className="mt-3 rounded-[var(--r-sm)] border border-[var(--line)] bg-sunken p-3.5 text-sm">
          <p className="mb-1.5 font-semibold">Also check, once</p>
          <ul className="grid gap-1 text-[var(--ink-2)]">
            <li>
              The thermal printer is the Windows <strong>default</strong>, and
              &ldquo;Let Windows manage my default printer&rdquo; is{" "}
              <strong>off</strong> — it reverts to Print-to-PDF on its own
              otherwise, and slips become files instead of paper.
            </li>
            <li>
              <strong>Printing preferences</strong> is set to the{" "}
              {clinic.paper_width}mm roll, with <strong>cut after each job</strong>.
            </li>
          </ul>
        </div>
      </Card>
    </div>
  );
}

function Li({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full
          bg-[var(--accent-soft)] text-xs font-bold text-[var(--accent)]"
        aria-hidden
      >
        {n}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

/** A .bat is the only way to create a Windows shortcut carrying a CLI flag. */
function downloadBat(appUrl: string) {
  const bat = [
    "@echo off",
    "REM Creates a desktop shortcut that opens the token system with the",
    "REM browser print dialog disabled.",
    "setlocal",
    'set "URL=' + appUrl + '"',
    'set "SHORTCUT=%USERPROFILE%\\Desktop\\Token System.lnk"',
    "",
    "REM Any Chromium browser supports --kiosk-printing. Brave is checked",
    "REM first because it is what this clinic actually runs; falling back to",
    "REM a browser the user does not use means they never see the shortcut",
    "REM working.",
    'set "CHROME=%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"',
    'if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"',
    'if not exist "%CHROME%" set "CHROME=%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"',
    'if not exist "%CHROME%" set "CHROME=%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe"',
    'if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe"',
    'if not exist "%CHROME%" set "CHROME=%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe"',
    'if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'if not exist "%CHROME%" set "CHROME=%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'if not exist "%CHROME%" (',
    "  echo No Chromium browser found ^(Brave, Chrome or Edge^).",
    "  pause",
    "  exit /b 1",
    ")",
    "",
    "echo   Browser: %CHROME%",
    "",
    "REM A separate user-data-dir is what makes this reliable: without it",
    "REM Chrome hands the URL to an already-running process and the new",
    "REM window inherits that process's settings, flag and all.",
    'set "PROFILE=%LOCALAPPDATA%\\TokenSystem\\chrome-profile"',
    "",
    "powershell -NoProfile -Command ^",
    "  \"$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%SHORTCUT%');\" ^",
    "  \"$s.TargetPath='%CHROME%';\" ^",
    "  \"$s.Arguments='--kiosk-printing --user-data-dir=\\\"%PROFILE%\\\" --no-first-run --no-default-browser-check \\\"%URL%\\\"';\" ^",
    "  \"$s.IconLocation='%CHROME%,0';\" ^",
    '  "$s.Save()"',
    "",
    "echo   Shortcut created on the Desktop.",
    "echo.",
    "echo   Current default printer:",
    "REM Write-Host, not bare output: a returned string gets truncated by",
    "REM cmd's pipeline and prints as a couple of characters.",
    "powershell -NoProfile -Command ^",
    '  "$p=(Get-CimInstance Win32_Printer | Where-Object Default).Name;" ^',
    "  \"Write-Host ('     ' + $p)\"",
    "echo.",
    "echo   If that is not the thermal printer, set it in",
    "echo   Settings ^> Printers ^& scanners, and turn OFF",
    'echo   "Let Windows manage my default printer".',
    "echo.",
    "",
    "REM ------------------------------------------------------------------",
    "REM Launch it here rather than leaving the user to find the shortcut.",
    "REM",
    "REM The flag only takes effect in a browser process started WITH it.",
    "REM Chromium hands a URL to any already-running process, so opening the",
    "REM app from a normal window silently inherits that process and the",
    "REM dialog comes back. Closing the browser first is therefore not",
    "REM optional, and asking the user to remember it does not work.",
    "REM ------------------------------------------------------------------",
    "echo   The browser must restart for silent printing to take effect.",
    "echo   All open tabs will close. They reopen on next launch.",
    "echo.",
    "REM Default to launching. set /p leaves GO untouched when input is",
    "REM redirected or the prompt is skipped, so the test must be for an",
    "REM explicit 'n' — testing for 'y' would silently skip setup and leave",
    "REM the user believing it had completed.",
    'set "GO=y"',
    'set /p GO="   Close the browser and start now? [Y/n] "',
    'if /i "%GO%"=="n" goto :skip',
    'if /i "%GO%"=="no" goto :skip',
    "",
    "for %%B in (brave.exe chrome.exe msedge.exe) do (",
    '  taskkill /IM %%B /F >nul 2>&1',
    ")",
    "REM Chromium needs a moment to release its profile lock.",
    "timeout /t 3 /nobreak >nul",
    "",
    'start "" "%CHROME%" --kiosk-printing --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check "%URL%"',
    "echo.",
    "echo   Started. Printing now goes straight to the printer.",
    "echo   From now on, always open the app from the Desktop shortcut.",
    "goto :done",
    "",
    ":skip",
    "echo.",
    "echo   Skipped. Close every browser window, then open the app from the",
    'echo   "Token System" shortcut on your Desktop.',
    "",
    ":done",
    "echo.",
    "pause",
  ].join("\r\n");

  const blob = new Blob([bat], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "setup-silent-printing.bat";
  a.click();
  URL.revokeObjectURL(a.href);
}
