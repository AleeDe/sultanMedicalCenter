# Queue Management + Wait-Time Estimation — Plan

## Why this shape (the evidence that changed the design)

Three findings from the research overrode what I would have built by default:

1. **Deliberately over-promise.** Patients given a moderately overestimated
   wait (70th percentile) reported the highest satisfaction; those given an
   honest median showed *no gain at all*. And rolling averages are known to
   systematically UNDER-estimate — biased in exactly the direction that
   angers patients most. So the displayed number is the 70th percentile of
   the estimate, not the median.

2. **A bad estimate is worse than none.** A Saudi RCT (n=190) found zero
   satisfaction benefit (p=0.962) from showing wait times — because they
   showed last month's *mean*, not live queue state. That is a null result
   for stale central estimates, not for estimates done properly.

3. **Median, not mean.** Consultation times are lognormal / right-skewed.
   One 25-minute case must not move the estimate for everyone behind it.

Pakistan-specific seed: BMJ Open's 67-country study (28.5M consultations)
puts Pakistani consultations at 1.79–4.0 min. Seed at **5 min** — above the
literature, because private token clinics run longer than public ones and
because we want to bias high.

## Decisions taken by the user
- Slip carries the estimate **and** a waiting-room TV shows the live queue
- Both the doctor and reception can call the next patient
- Emergency always jumps the queue — with the reason shown on the TV

---

## 1. Schema

```sql
-- Queue state lives on the token; one token = one queue entry.
alter table token add column status text not null default 'WAITING';
alter table token add column priority smallint not null default 0;
alter table token add column called_at timestamptz;
alter table token add column started_at timestamptz;
alter table token add column ended_at timestamptz;
alter table token add column recall_count smallint not null default 0;
alter table token add column predicted_wait_min smallint;

-- Doctor availability, separate from patient state.
create table doctor_session (
  doctor_id bigint primary key references doctor(id),
  state text not null default 'AVAILABLE',   -- AVAILABLE|ON_BREAK|FINISHED
  expected_return_at timestamptz,
  updated_at timestamptz not null default now()
);
```

**Statuses:** `WAITING → CALLED → IN_CONSULTATION → DONE`, plus `SKIPPED`
(recoverable — patient stepped out) and `NO_SHOW` (terminal, after 2 failed
recalls) and `CANCELLED`.

`SKIPPED` must stay distinct from `NO_SHOW`. Merging them is the commonest
modelling mistake: a skipped patient went to the washroom and real clinics
recall them a few tokens later. Merge the two and reception ends up fighting
the software.

**Ordering** (copied from OpenMRS's deployed queue module):
`ORDER BY priority DESC, seq ASC` — priority is the emergency lever, token
number is the fair tiebreak.

Partial index on the hot path only — the table grows forever but the working
set is ~150 rows/day:
```sql
create index token_active_queue_idx on token (doctor_id, priority desc, seq)
  where status in ('WAITING','CALLED');
create index token_done_idx on token (doctor_id, ended_at desc)
  where status = 'DONE';
```

## 2. The estimator

```
per-doctor median of (ended_at - started_at) over the last 20 consultations,
Bayesian-shrunk toward a 5-minute prior:

    w = n / (n + 10)
    typical = w * observed_median + (1 - w) * 5 min

eta = remaining_time_of_current_consultation
    + (tokens_ahead * typical)
    + (doctor on break ? expected_return_at - now : 0)

displayed = round_to_5(eta * 1.4)     -- ~70th percentile of a lognormal
```

At n=0 it is the pure seed; n=10 is 50/50; n=40 is 80% observed. Each doctor
sees 20–40 patients/day here, so the estimate becomes trustworthy after
**one to two working days per doctor** — the cold-start problem is small.

The "remaining time of current consultation" term is the one usually
forgotten: if the doctor started 8 minutes ago and typical is 6, do not add
another full 6.

**Computed on read, never stored** — a stored ETA is wrong the instant a
doctor goes on break. But `predicted_wait_min` IS stored once at issue time,
immutably, because it is what we printed on the patient's slip and it lets us
measure our own accuracy later.

## 3. Screens

**New Token** — slip gains a line: `Approx. wait   25-35 min`, shown as a
range whose *upper* bound is the commitment. Rounded to 5-minute buckets;
"23 minutes" invites patients to time us.

**Queue** (new) — reception's live view per doctor: who is in, who is next,
Call / Start / Done / Skip / Recall buttons. Doctor state toggle
(Available / On break, with expected return).

**Display** (new, `/display`) — full-screen for the waiting-room TV:
NOW SERVING, the next few tokens, and each one's estimated minutes. Shows
**both** position and minutes: position is verifiable and proves fairness,
minutes is what lets someone step out for tea.

When an emergency jumps the queue the board must say so — *"Emergency case
being seen, normal queue resumes shortly."* An unexplained jump is the single
worst thing for perceived fairness; an explained one is accepted.

## 4. Live updates

SSE (`EventSource`), not WebSockets: the data flow is one-directional, and
SSE reconnects by itself, which is the deciding property on a flaky link.

**Each message carries the full queue snapshot, not a delta.** SSE silently
drops messages sent while disconnected — a board that reconnects and shows a
stale "NOW SERVING 23" is worse than a blank one. With whole-state messages a
missed one is self-healing. Heartbeat every 15s; if the board sees none for
30s it greys out and says "Reconnecting…" rather than showing stale numbers.

## 5. Build order

1. Schema + state machine (everything depends on it)
2. Estimator with the 5-min seed, shipped immediately
3. Estimate on the slip + the Queue screen
4. Display board + SSE
5. Emergency priority with the on-screen explanation
6. Accuracy tracking: log actual vs predicted, watch the **under-prediction
   rate** specifically (target <25%), tune the 1.4 multiplier from real data

## 6. Verification

- Concurrency: two receptionists calling "next" simultaneously must not hand
  the same patient to both doctors
- Emergency inserted mid-queue lands at position 1 and the reason shows
- Skip → recall returns the patient to the queue, not to the back
- Doctor break inflates every ETA in that queue and the board explains why
- Pull the network cable: board greys out within 30s, recovers on reconnect
- Estimate accuracy after a day of real data: under-prediction rate
