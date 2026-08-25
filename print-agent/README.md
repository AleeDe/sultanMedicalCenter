# Print agent

Runs on the **reception PC** — the one the thermal printer is plugged into.

## Why it exists

The app is served from Vercel. That server is in a Mumbai data centre and has
no printer attached, so it cannot open a COM port. The printer is on the
reception PC. The browser is the only thing that can see both, so it posts the
slip to this agent over loopback and the agent writes it to the port.

```
Browser (Vercel page)  ──►  agent (127.0.0.1:3001)  ──►  COM port  ──►  printer
                                     reception PC
```

No token, patient or fee data crosses this boundary — the agent receives an
opaque array of ESC/POS bytes and writes them to a serial port.

## Running it

```bash
npm run print-agent
```

Expected output:

```
[print-agent] listening on http://127.0.0.1:3001
[print-agent] printer detected on COM7 @ 9600 baud
```

Leave it running while the clinic is open. Printing falls back to the browser
dialog whenever it is not.

## Starting it automatically

So reception never has to think about it:

1. Press `Win + R`, type `shell:startup`, press Enter.
2. Create `print-agent.bat` in that folder:

   ```bat
   @echo off
   cd /d "D:\BabulTech\TokenGenerator"
   node print-agent\agent.mjs
   ```

3. To keep the window out of the way, make a shortcut to the `.bat` and set
   **Run: Minimized** in its properties.

## Settings

Environment variables, all optional:

| Variable | Default | Use |
|---|---|---|
| `PRINT_AGENT_PORT` | `3001` | Change if 3001 is taken. Must match `AGENT_ORIGIN` in `src/lib/print-agent.ts` **and** `connect-src` in `next.config.ts`. |
| `PRINT_AGENT_COM` | auto-detect | Pin a specific port, e.g. `COM7`. Needed only when two USB serial devices are attached and the wrong one is picked. |
| `PRINT_AGENT_BAUD` | `9600` | Only if your printer needs a different rate. |

## Which printers work

Any **ESC/POS thermal printer** (58mm or 80mm POS) on a COM port. This is the
language POS printers speak; ordinary inkjet and laser printers do not
understand it and will print nothing or garbage.

The port number does not matter — the agent finds it. It deliberately skips
the "Standard Serial over Bluetooth link" ports Windows lists, because those
open successfully and silently swallow everything sent to them, which looks
exactly like a printer that prints nothing.

## When it does not print

The app shows the reason on screen. Common ones:

| Message | Cause |
|---|---|
| "The print agent is not running on this PC" | Start it. It is also normal on any PC that is not reception. |
| "No printer found on a COM port" | Printer off or unplugged. Check Device Manager → Ports. |
| "COM7 is already in use" | Another program holds the port — often a second copy of this agent. |

## Security

- Binds to `127.0.0.1`, never `0.0.0.0`, so nothing on the clinic wifi can
  reach it.
- Only accepts requests whose `Origin` is the deployed app or localhost. Add
  the clinic's own domain to `ALLOWED_ORIGINS` in `agent.mjs` if the app moves
  off `vercel.app`.
- Holds no session and touches no database.
