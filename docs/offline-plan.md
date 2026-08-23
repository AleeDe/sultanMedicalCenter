# Offline-first — Plan

## The constraint that shapes everything

WhatsApp can queue a message offline because a message has no number that can
collide. **A token does.** Two patients holding `NORM-00042` is a fight at
the counter, and no amount of clever syncing fixes it after the fact.

So the offline design is not "save locally and sync later" — it is
**"acquire the right to issue numbers before you need them."**

## Decisions taken by the user
- Reserve blocks of numbers ahead of time (patient never sees anything odd)
- One counter now, but the design must extend to several without a rewrite

---

## 1. How numbers survive an outage

While online, the app leases a block of sequence numbers per series:

```sql
create table token_lease (
  id            bigserial primary key,
  counter_id    text        not null,   -- which machine holds this lease
  series_id     bigint      not null references token_series(id),
  lease_date    date        not null,
  seq_from      integer     not null,
  seq_to        integer     not null,
  issued_upto   integer     not null,   -- highest actually used
  created_at    timestamptz not null default now(),
  released_at   timestamptz
);
```

Leasing advances the same `token_counter` the online path uses, so a leased
block is genuinely reserved — the server can never hand those numbers to
anyone else. That is what makes the guarantee hold rather than hope.

`counter_id` is why this extends to more counters later: each machine gets a
random id on first run and leases its own disjoint block. Nothing about the
one-counter case needs revisiting.

**Block size 50**, re-leased when 15 remain. At 50–150 tokens/day that is a
few hours of runway, refreshed whenever the connection is up.

### Gaps are the accepted cost

A leased-but-unused number is a gap. This is a deliberate trade: the existing
system guarantees *gapless* numbering, and offline leasing gives that up in
exchange for working without a connection.

Day-close reconciles them — unused leases are released and reported, so a gap
is explained rather than mysterious. Worth stating plainly to the clinic:
"token 47 was never issued, the internet was down" is fine; "we gave 42 to
two people" is not.

## 2. Local store

IndexedDB via a small wrapper. Three stores:

- `outbox` — writes not yet confirmed by the server, in order
- `cache` — doctors, services, series, clinic settings, today's queue
- `leases` — the number blocks this machine holds

Every write goes to IndexedDB **first**, then to the network. The UI reads
from IndexedDB always, so it behaves identically online and offline — no
separate "offline mode" code path to get wrong.

## 3. Sync

Each queued operation carries a **client-generated UUID**. The server upserts
on that id, so replaying the outbox after a flaky connection cannot create
duplicates. This is the property that makes retry safe.

Order matters — a token references a patient — so the outbox drains
**strictly in sequence**, stopping on the first failure rather than skipping
ahead.

**Conflict policy, stated deliberately:**
- Tokens: never conflict, because the number came from an owned lease
- Patients: server wins on demographics; a new patient created offline keeps
  its client UUID and gets its MRN assigned at sync
- Billing items: append-only, so they merge without conflict
- Prices/settings changed in Admin while offline: **server wins**, and the
  local copy is refreshed on reconnect

## 4. What reception sees

A single status chip in the nav, always visible:

- **Online** — quiet, no attention drawn
- **Offline · 34 tokens left** — amber, with the remaining lease count,
  because that number is the real constraint during an outage
- **Syncing 12…** — briefly, while the outbox drains
- **Lease low** — red, when fewer than 15 remain and there is no connection

Reception must never have to guess whether their work is saved. The chip
answers that without being asked.

## 5. What still cannot work offline

Stated honestly rather than discovered later:

- **Analytics** — needs the full history, which is not local
- **Admin** — price and prefix changes are disabled offline; letting two
  machines edit prices independently is how bills stop matching
- **Invoice numbers** — the annual series must stay strictly gapless for
  audit, so settlement requires a connection. Tokens and payments work
  offline; final invoicing waits.

## 6. Build order

1. IndexedDB wrapper + cache read path (UI reads local everywhere)
2. Lease table, server action, top-up on connect
3. Outbox + idempotent replay
4. Status chip
5. Offline token issue end to end
6. Disable Admin/Analytics/settlement offline, with a clear reason shown

## 7. Verification

- Pull the cable mid-shift: issue 3 tokens, reconnect, confirm all 3 land
  with the leased numbers and no duplicates
- Kill the browser mid-outage: outbox survives, drains on reopen
- Exhaust a lease offline: app refuses clearly rather than issuing a
  colliding number
- Two counters (simulated): leases are disjoint, no number issued twice
- Replay the same outbox twice: idempotency holds, nothing duplicated
