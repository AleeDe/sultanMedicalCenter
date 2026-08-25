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

## Running it

```bash
npm run print-agent
```

Expected output:

```
[print-agent] watching the queue every 2000ms
[print-agent] printer on COM7 @ 9600 baud
```

Leave it running while the clinic is open. Tokens issued while it is stopped
stay queued and print when it starts again — nothing is lost, it just waits.

## Starting it automatically

Double-click **`print-agent\install-startup.bat`** once on the reception PC.

It registers the agent to start with Windows and starts it immediately, so no
reboot is needed. From then on staff never type a command — the PC starts,
the agent starts.

It runs with no console window, deliberately: a visible one invites someone to
close it, and printing would stop silently.

To undo, press `Win + R`, type `shell:startup`, and delete
"TokenGenerator print agent.vbs" from the folder that opens.

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
