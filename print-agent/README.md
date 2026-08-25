# Print agent

Runs on the **one PC the thermal printer is plugged into**. It watches the
token queue and prints every slip, whichever device created it.

```
Tablet   ─┐
Phone    ─┼──►  database  ◄──  print agent  ──►  COM port  ──►  slip
Reception─┘                   (reception PC)
```

## Why it works this way

A tablet has no COM port and never will, so a token issued on one could not
produce paper if each device printed its own slip. Routing every slip through
the machine that owns the printer means any device can issue tokens — and the
patient is handed their slip at the counter, which is where they are standing
anyway.

It also survives the app being served from Vercel: that server sits in a data
centre with no printer attached, so something inside the clinic has to do the
printing.

## What the clinic gets

One file: **`TokenPrinter.exe`**. Nothing else — no Node, no npm, no config
file, no terminal, and no copy of this repository.

Put it on the reception PC and double-click it once. It copies itself to
AppData, registers to start with Windows, finds the printer, and begins
printing. From then on it runs in the background with no window, and starts
again by itself whenever the PC does.

To stop it: end `TokenPrinter.exe` in Task Manager. To stop it permanently,
also delete "Token Printer.vbs" from the folder that opens with
`Win + R` -> `shell:startup`.

## Building that .exe

```bash
npm run build:exe        # -> dist/TokenPrinter.exe
```

The production `DATABASE_URL` is read from `.env.production.local` at build
time and baked into the binary, which is what lets the clinic configure
nothing. The build prints which database it used — check it says the
production host and not localhost, because an .exe built against the dev
database runs, connects, and never prints a real token.

**The credential is extractable from the .exe by anyone holding it.** That is
acceptable on the reception PC, whose staff already have access to the data.
It is not acceptable in email, chat, or anywhere public. If a copy leaks,
rotate the database password and rebuild.

`dist/` is gitignored for the same reason.

## Running from the repo instead

For development, with `DATABASE_URL` in `.env.local`:

```bash
npm run print-agent
```

This keeps the console window and does not install anything.

## After changing the slip layout

The agent bundles its own copy of the slip builder, compiled from
`src/lib/receipts.ts`. Rebuild it whenever that file or `src/lib/escpos.ts`
changes:

```bash
npm run build:slip
```

Skipping this means the agent goes on printing the old layout while the app
shows the new one.

## Settings

Environment variables, all optional:

| Variable | Default | Use |
|---|---|---|
| `PRINT_AGENT_COM` | auto-detect | Pin a port, e.g. `COM7`. Needed only when two USB serial devices are attached and the wrong one is picked. |
| `PRINT_AGENT_BAUD` | `9600` | Only if the printer needs a different rate. |
| `PRINT_AGENT_POLL_MS` | `2000` | How often to check for new tokens. |
| `PRINT_AGENT_BATCH` | `3` | Slips claimed per poll. |

## Which printers work

Any **ESC/POS thermal printer** (58mm or 80mm POS) on a COM port. That is the
language POS printers speak; ordinary inkjet and laser printers do not
understand it and will print nothing or garbage.

The port number does not matter — the agent finds it. It deliberately skips
the "Standard Serial over Bluetooth link" ports Windows lists, because those
open successfully and silently swallow everything sent to them, which looks
exactly like a printer that prints nothing.

## Two agents at once

Safe. Claims go through `claim_pending_prints()`, which uses
`for update skip locked`, so two agents take different tokens rather than both
printing the same one. A second counter with its own printer just works.

## When a slip does not appear

Tokens carry their own print state, so nothing disappears silently:

| State | Meaning |
|---|---|
| `PENDING` | Queued, waiting for an agent. Normal for a second or two; persistent means no agent is running. |
| `CLAIMED` | An agent has it. Stuck here means the agent died mid-job — it is released automatically after two minutes. |
| `PRINTED` | On paper. |
| `FAILED` | The printer refused it; `print_error` says why. |

```sql
select display_no, print_status, print_error
  from token
 where token_date = current_date
   and print_status <> 'PRINTED';
```

## Security

- Holds no HTTP port — it only reads the database and writes to a COM port.
  Nothing on the clinic network can reach it.
- Uses the same `DATABASE_URL` as the app.
