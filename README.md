# Sultan Medical Center — Token & Billing

Token generation and visit billing for a clinic OPD, Emergency department and
labs. Reception issues a printed token in seconds; charges accumulate against
the visit and settle into one final receipt.

## Running it

```bash
docker compose up -d     # local Postgres on port 5433
cp .env.example .env.local
npm install
npm run migrate          # applies supabase/migrations/*.sql
npm run dev              # http://localhost:3000
npm test                 # allocator concurrency + behaviour suites
npm run test:ui          # design-system checks (needs `npm run dev` running)
```

Set the clinic name, address and receipt paper width under **Admin → Clinic &
receipt** before the first real token.

## The four screens

| Screen | Purpose |
|---|---|
| **New Token** | The hot path. Phone lookup, patient details, visit type, fee, print. |
| **Billing** | The visit ledger — add lab tests and services, take payment, settle. |
| **Day Book** | Tokens issued, cash collected, outstanding balances for today. |
| **Admin** | Token prefixes, lab/service catalogue, receipt header, counter staff. |

## How the billing model works

The consultation fee is collected at the counter when the token is issued.
**Lab tests can be added right there too** — the step 3 picker on the New Token
screen — and they are billed and paid together with the visit fee, so the
patient pays once and the token slip doubles as a paid receipt listing every
charge.

Anything ordered *after* the consult is **appended to the same visit** as a
line item, each independently `PAID` or `PENDING`. The lab can therefore take
payment before drawing a sample without settling the whole visit, and one
**Settle & Print Bill** closes it with a consolidated receipt.

Both paths write to the same `visit_item` table, so the bill always shows
everything — OPD or Emergency fee, labs added at the counter, and labs added
later — in one list with one total.

This is deliberate. Billing everything upfront is impossible — nobody knows
what the doctor will order until after the consult. Billing everything at the
end breaks the lab and creates walk-away exposure.

A **Token** is a queue position: it resets daily and is disposable. A **Visit**
is the clinical and financial record and lives forever. They are separate
tables linked by `visit_id`, so the nightly token reset never collides with
billing history.

## Numbering

Two independent series, both gapless:

| | Format | Resets |
|---|---|---|
| Token | `NORM-00042`, internally `NORM-20082026-00042` | Daily |
| Invoice | `INV-2026-000871` | Annually |

Numbers come from counter tables via atomic upsert-returning
(`next_token_seq`, `next_invoice_seq` in `supabase/migrations/0002_allocators.sql`),
**not** Postgres sequences. Sequences are non-transactional, advance even on a
conflicting insert, and cannot be reset safely by cron — a midnight job runs
minutes late and hands out duplicate numbers. A gap in a hospital token series
reads as a lost patient or a deleted bill.

The daily reset is implicit in the counter's `(date, series)` key: there is no
scheduled job, so there is nothing that can fail to run.

### Renaming a prefix

Admin can rename `NORM` → `OPD` at any time. The counter keys on `series_id`,
never the prefix text, and issued tokens store their printed number, so a
rename affects only tokens issued from that moment. Today's count does not
restart and yesterday's slips still read the way they were printed.

## Printing

There are two paths, and the app picks whichever is available. Both are set up
from **Admin → Printer**.

### 1. Direct USB (recommended)

The browser claims the printer's USB interface via **WebUSB** and writes raw
**ESC/POS** bytes to it (`src/lib/escpos.ts`, `src/lib/usb-printer.ts`).
Windows is bypassed completely, which means:

- **No Windows driver is needed** — this works even when Printers & scanners
  says *"Driver is unavailable"*, which is the usual state of cheap thermal
  printers on Windows 11.
- **No print dialog exists to suppress**, because the browser's print
  subsystem is never involved.
- Auto-cut and the cash drawer become reachable; `window.print()` cannot touch
  either.

Requirements: Chrome or Edge (WebUSB is Chromium-only), an https origin (or
localhost), and one click on **Connect printer**. The permission is remembered
per origin, so reception connects once and it reattaches silently thereafter.

If the printer does not appear in the chooser, Windows is usually still
holding it — remove every entry for it under Printers & scanners, then unplug
and replug. Rarely, the board needs rebinding to WinUSB with Zadig.

### 2. Browser printing (fallback)

`window.print()` through the Windows driver, using the HTML slip templates.
Used automatically whenever no USB printer is connected, so a machine that was
never set up still works.

**A web page cannot suppress this dialog** — a deliberate browser security
boundary, so no site can make paper appear without consent. It disappears only
when Chrome itself is launched with `--kiosk-printing`; the Printer tab
generates a `.bat` that creates that desktop shortcut.

### Layout

Both paths produce the same slip: a **character grid** of 48 monospace columns
on 80mm paper, 32 on 58mm, pure black on white (thermal is 1-bit and dithers
greys badly). Non-ASCII characters are folded to ASCII before transmission, so
curly quotes and `₨` cannot print as garbage.

`npm run test:escpos` checks the byte stream — control codes, column widths,
and that nothing above 127 ever reaches the printer.

## Doctors

Every token records which doctor the patient is going to see; reception cannot
issue one without picking a doctor. The doctor and their room are printed on
the slip, so the patient knows where to go without asking again.

Fees stay driven by the visit type, not the doctor — deliberately, so that
changing the doctor can never silently change what the patient is charged.
Manage the list under **Admin → Doctors**.

## Analytics

**Admin → Analytics** answers "how is the clinic doing?" over a 7 / 30 / 90 /
365-day window, with every headline compared against the equivalent preceding
window — a bare revenue figure cannot be acted on, the question is always
"compared with what?".

Revenue, tokens, average per token, outstanding money, patients seen, new
patients, and emergency share; revenue trend by day; busiest hours for
rostering; and rankings by category, doctor, visit type, most-ordered test,
most frequent patient, and collecting staff member.

To see it with realistic data on a fresh install:

```bash
node --env-file=.env.local scripts/seed-demo.mjs 45   # development only
```

Before the clinic goes live, clear that demo history so it cannot mix with
real records — doctors, services, prices and settings are kept:

```bash
node --env-file=.env.local scripts/reset-demo.mjs --yes
```

## Admin PIN

Admin holds the settings that change money — fees, lab prices, token prefixes —
so it is locked behind a PIN and **auto-locks after 5 idle minutes**. This is
not authentication (the clinic runs on one shared login by choice); it is a
lock on the screens reception is not meant to touch.

The default PIN is **1234** and the app nags until it is changed, under
*Admin → Counter staff → Admin PIN*. The PIN is stored as a salted SHA-256
hash, and verification happens in the database so the code never becomes a
JavaScript string that could land in a log.

## Data integrity

- **Prices are snapshotted.** `visit_item` stores the name and unit price at
  the moment the item was added. Raising the X-ray price next month cannot
  rewrite last month's bills.
- **The audit log is append-only**, enforced by rules that make UPDATE and
  DELETE no-ops. With a single shared login this is the entire accountability
  story, so every token, payment, removal and price change is stamped with
  whoever was selected at the "Counter" picker.
- **Duplicate patients are guarded.** Issuing a token on a phone number that
  already exists surfaces the match instead of silently creating a second MRN,
  with an explicit "register a new patient" escape for families sharing a
  number.

## The design system

Everything visual comes from tokens in `src/app/globals.css`. Components read
them; they do not carry their own colours. This is enforced, not merely
intended — `npm run test:ui` asks the live DOM whether any element is still
painted with a literal hex.

That rule earns its keep in one place especially: **`[data-mode="emergency"]`
repaints the accent token, and with it the entire screen.** Twenty-eight
hardcoded blues meant that promise was quietly broken — the visit-type card
turned red and nothing else did. Now the step numbers, the field focus rings,
the slip preview and the primary button all follow.

| | |
|---|---|
| **Type** | Six steps, `--t-display` down to `--t-micro`. Three levels of hierarchy on any one screen is the working limit under time pressure; past that, size stops encoding rank and becomes decoration. |
| **Weight** | Four steps. Weight carries as much hierarchy as size, and costs no space — which matters on a dense screen. |
| **Space** | One 4px rhythm, `--s-1` to `--s-7`, so unrelated components still line up. |
| **Elevation** | Three rungs. Shadows are tinted with the ink colour; a neutral grey shadow reads as dirt against a blue-grey background. |
| **Motion** | `--dur-fast` / `--dur` on a single easing curve. All of it disabled under `prefers-reduced-motion`. |

Sizes are fixed rather than fluid. This runs on one known front-desk monitor,
and a `clamp()` that reflows between renders would undo the spatial constancy
the whole hot path depends on.

### Colour carries meaning, never decoration

Green and red mean good and bad, everywhere, without exception. The trap is a
metric where up is bad: outstanding money rising is a **red ▲**, because the
arrow reports direction and the colour reports judgement. Those are two
different facts and collapsing them into one signal is how a dashboard ends up
quietly lying. Screen readers get the judgement in words, since colour alone
is never the only channel.

## Design constraints

The receptionist runs the New Token screen hundreds of times a day from muscle
memory, so the UI optimises for **spatial constancy over minimal options**:

- No list ever reorders itself by "recent" or "most used" — a moving target
  destroys a memorised motor sequence.
- **Rarely-used controls fold away.** Going on a break happens twice a day on
  a screen whose job is calling the next patient; four panels each showing
  three idle Break buttons is noise, and noise is what makes the important
  control hard to find. Coming *back* stays visible — a doctor whose queue is
  frozen needs that button immediately.
- **Names are never truncated.** "Dr. Ahme…" on a four-doctor queue is a real
  ambiguity, not a cosmetic one. Badges wrap instead.
- **Identity is legible in peripheral vision.** Doctors carry their initials,
  not an identical stethoscope glyph that forces the eye down to the name on
  every row.
- Primary actions are ≥56px tall and bottom-anchored; all targets are ≥44px.
- Destructive actions are small, last, and far from the primary button.
- One screen, no wizard; fields chunked into three labelled groups.
- No blocking confirmation on the happy path — `F2` issues and prints.

## Going live on Supabase

```bash
supabase link --project-ref <ref>
supabase db push                      # applies supabase/migrations/*.sql
node --env-file=.env.production.local scripts/test-db.mjs
```

### Which pooler

Supabase offers two, and the right one depends on where the app runs. New
projects no longer publish a resolvable `db.<ref>.supabase.co` over IPv4, so
one of these *is* the connection.

| | Port | Use for | Limit |
|---|---|---|---|
| **Session** | 5432 | A long-lived server, migrations, scripts | ~15 client connections **per project, in total** |
| **Transaction** | 6543 | **Serverless (Vercel)** | Thousands of clients over a small backend pool |

On Vercel, session mode is the wrong choice: every warm lambda holds its own
pool, and a handful of instances exhausts the project's 15 connections. Use
transaction mode.

**Transaction pooling does not break gapless numbering.** A transaction is
pinned to one backend for its whole duration, so the row lock that serialises
token allocation still holds — verified against the live project: 50 parallel
`issue_token` calls through port 6543 produced exactly 1..50, no duplicates.
What it does break is *prepared statements*, because consecutive statements
outside a transaction may land on different backends. `src/lib/db.ts` detects
port 6543 and sets `prepare: false` automatically, so there is one thing to
get right in the environment rather than three.

### Which region

`vercel.json` pins the functions to **`bom1` (Mumbai)**, because the Supabase
project is in `ap-south-1` (Mumbai). They belong in the same region, and
which region matters far less than that they match.

Vercel defaults to `iad1` (Washington DC). On that default every query
crossed the Atlantic and the Indian Ocean — roughly 220-260ms per round
trip. Every page here is `force-dynamic` and issues several queries, and a
cold request pays four more round trips for TCP, TLS and Postgres auth
before the first query runs, so a single page load spent well over a second
purely on distance. Moving the functions next to the data removes that cost
rather than optimising around it.

`vercel.json` cannot carry comments — its schema rejects unknown keys,
including the `"//"` convention — which is why this is written here.

**If the Supabase project is ever moved, move this with it.**

### Two things that differ from a plain Postgres

Both were found by deploying, not by reading — and both fail *only* in
production, which is what makes them worth stating.

**pgcrypto lives in `extensions`, not `public`.** The PIN checks call
`digest()` and `gen_random_bytes()` directly, so they resolve on a laptop and
throw `function does not exist` on Supabase.

**The pooler silently drops connection startup parameters.** Everything set
via `connection: {}` in `src/lib/db.ts` — timezone included — is discarded,
leaving each session on UTC. For this app that is the most damaging default
available: `current_date` drives the daily token reset, so the series would
roll over at 05:00 local instead of midnight, mid-way through the morning
rush.

Migration `0013_session_defaults.sql` fixes both by pinning `timezone` and
`search_path` with `ALTER DATABASE`, which applies to every session however it
connects. The connection options stay in `db.ts` as well, so a self-hosted
Postgres is correct without the migration.

**Changing the clinic timezone means editing `0013` as well as
`CLINIC_TIMEZONE`** — the database default is the one the pooler honours.

`scripts/test-db.mjs` asserts the live session is actually in the clinic
timezone and that pgcrypto resolves, because "it connected" is not the same as
"it connected correctly".

## Deploying to Vercel

Two environment variables. That is the whole list — the app reads nothing
else at runtime.

| Variable | Value | Environments |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres` | Production, Preview, Development |
| `CLINIC_TIMEZONE` | `Asia/Karachi` | Production, Preview, Development |

Note the port: **6543**, transaction mode — see [Which pooler](#which-pooler).

Optional, and only if the defaults do not fit:

| Variable | Default | When to set it |
|---|---|---|
| `DB_POOL_MAX` | 3 on port 6543, 5 on 5432 | Raise only alongside the Supabase connection limit, never on its own. |

`ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` are **not** needed: they belong
to the demo-video scripts in `demo/`, which never run on the server.

### Before the first real token

1. **Set the clinic name.** Admin → Clinic & receipt. This is database
   content, not code, so deploying does not change it — and it is what prints
   at the top of every slip.
2. **Change the four doctor PINs and the admin PIN**, all of which ship as
   `1234`. `npm run test:db` warns while any remain.
3. **Clear the demo history** so it cannot mix with real records — doctors,
   services, prices and settings are kept:
   ```bash
   node --env-file=.env.production.local scripts/reset-demo.mjs --yes
   ```

### What will not work on Vercel

**Printing.** Both paths are browser-side and need the machine the printer is
plugged into: WebUSB requires a one-time permission grant per browser, and the
`--kiosk-printing` flag that suppresses the print dialog is a property of how
Chrome was launched. Deploying to Vercel serves the app; the front-desk
machine still has to be set up once from Admin → Printer.

**Offline token issue** works — the service worker and IndexedDB outbox are
client-side — but the lease has to be taken while the connection is up.

## Not built yet

Scoped out by choice: pharmacy stock tracking, and per-user logins beyond the
admin and doctor PINs. Screens refresh by polling rather than server-sent
events — at clinic scale the difference is not worth the reconnection
handling.

## Queue and wait times

**Queue** (reception) shows every doctor's line, tiled into columns so "who is
free, where is the backlog" is answerable in one look rather than by
scrolling; **Doctor** (`/doctor`) is the same board scoped to one signed-in
doctor, kept single-column because a second column on a tablet only shrinks
the targets; **Display** (`/display`) is the waiting-room TV.

The board **shows token numbers, never patient names** — a screen in a public
waiting room is a PHI disclosure surface, and the token is what the patient is
holding anyway. Its grid grows to fill the screen height, and the **digits are
weighted far heavier than the prefix**: every token on the board reads
`NORM-`, so the digits are the only part that distinguishes one patient from
another, and recognition at fifteen feet works on the differing part.

Both reception and the doctor can call the next patient — the clinic decides
who presses the button. `call_next` claims a row atomically, so two people
pressing at the same moment get two different patients, which is an ordinary
event when the doctor reaches for the tablet as reception calls a name.

**Calling the next patient auto-finishes the previous one.** Doctors forget to
press Done, and every consultation time depends on that timestamp. One button
instead of two keeps the data honest without asking anything extra.

### How the estimate works

```
per-doctor median of the last 20 consultations,
  shrunk toward a 5-minute prior:  w = n / (n + 10)

eta = remaining time of the consultation in progress
    + (patients ahead x typical)
    + (doctor on break ? time until they return : 0)

quoted = eta x 1.4        <- deliberate over-estimate
```

Three decisions worth knowing before changing any of it:

- **Median, not mean.** Consultation times are right-skewed; one 25-minute
  case would otherwise ruin the estimate for everyone behind it.
- **Deliberately over-promised.** Patients given a moderately overestimated
  wait report the highest satisfaction; an honest median produces no gain at
  all. Rolling averages additionally under-estimate — biased in exactly the
  direction patients react worst to. Hence the 1.4x.
- **A bad estimate is worse than none.** One RCT found zero benefit from
  showing wait times, because it showed *last month's mean* rather than live
  queue state. Accuracy is not optional here.

Seeded at 5 minutes from BMJ Open's 67-country study (28.5M consultations),
which puts Pakistani consultations at 1.79–4.0 min — set above that because a
private token clinic runs longer than the public settings measured, and
because biasing high is the point.

`predicted_wait_min` is stored on each token: it is what was printed on the
patient's slip, so comparing it with the actual wait is how the 1.4 gets tuned
against this clinic rather than guessed.

### Tuning the multiplier

**Admin -> Wait accuracy** compares what was quoted against
`started_at - issued_at`, per doctor, over 7 / 30 / 90 days.

The headline is **Ran over** — the share of patients who waited longer than
the slip promised — not mean error. An over-estimate costs nothing; an
under-estimate is the failure the whole design exists to avoid. **Around 10%
is healthy.** Much higher means the quotes are under-promising. Near zero
means they are so padded they have stopped being useful, which is the same
mistake in the other direction.

**Suggested x** is what the multiplier would have had to be for nine out of
ten of those patients to stay inside their quote. It is displayed, never
applied: a multiplier that drifts on its own makes every printed slip
unaccountable. Change it deliberately in `estimate_wait_minutes()`
(`supabase/migrations/0010_wait_estimate.sql`).

A doctor needs at least five finished consultations before they appear —
below that the median is noise. Consultations starting more than six hours
after the token was issued are excluded: that is a clinic that closed, not a
queue that ran long.

### Doctor sign-in

Each doctor has their own PIN (default **1234**, and the UI nags until it is
changed). Signs out after 30 minutes idle. The device remembers which doctor
uses it, never the PIN.

**Before going live, change all four.** A shared default is the same as no PIN
at all — any doctor can sign in as another, and the consultation timestamps
that every wait estimate depends on become worthless.

**Admin -> Doctors** lists whoever is still on the default and resets them.
That path deliberately does not ask for the current PIN: the administrator
does not know it, and this is the locked-out case. The reset is written to the
audit log, which under a shared admin login is the whole accountability story.
Resetting *to* 1234 is refused. Doctors change their own PIN from the doctor
screen, where the current one is required.

## Working offline

Reception can issue tokens with the connection down. This is not a nicety —
with an Emergency department on a cloud-hosted app, a dropped link otherwise
means a patient stands at the counter with no token.

The model is WhatsApp's: **write locally first, sync when the link returns.**

- Every screen is a PWA served by `public/sw.js`, so it loads with no network.
- Reception holds a **lease** on a block of token numbers per series
  (`token_lease`, migration `0007`). Offline tokens are numbered from that
  block, so they slot into the same gapless series rather than being renumbered
  on sync.
- Writes queue in an **IndexedDB outbox** (`src/lib/offline/db.ts`) and drain
  **in order**, stopping at the first failure — an out-of-order replay would
  reorder the queue.
- Every write carries a **client-generated UUID**. `issue_token` returns the
  existing row on replay instead of inserting a second one, so a retry after a
  timeout cannot double-issue. Partial unique indexes on `client_uuid` enforce
  it at the database rather than trusting the client.

Connectivity is judged by a **real request**, not `navigator.onLine`, which
reports true on a connected-but-dead network — the exact case this has to
survive.

```bash
npm run test:offline    # issues offline, reconnects, asserts no duplicates
```

The suite drains the outbox twice and asserts 5 tokens, not 10.
