-- Offline token leasing.
--
-- A token number cannot be invented on the client: two patients holding
-- NORM-00042 is a fight at the counter that no amount of later syncing
-- repairs. So instead of generating numbers offline, a counter ACQUIRES THE
-- RIGHT to a block of them while it still has a connection.
--
-- The lease advances the same token_counter the online path uses, so the
-- server can never hand a leased number to anyone else. That is what makes
-- the guarantee hold rather than merely hope.
--
-- The cost is gaps: a leased-but-unused number is never issued. That is a
-- deliberate trade against the gapless guarantee in 0002, and day-close
-- reports the gaps so they are explained rather than mysterious.

create table token_lease (
  id          bigint generated always as identity primary key,
  -- Random per-machine id, generated on first run. Present from day one so
  -- adding a lab or pharmacy counter later needs no schema change.
  counter_id  text        not null,
  series_id   bigint      not null references token_series(id),
  lease_date  date        not null,
  seq_from    integer     not null,
  seq_to      integer     not null,
  -- Highest number this counter actually issued from the block.
  issued_upto integer     not null default 0,
  created_at  timestamptz not null default now(),
  released_at timestamptz,
  constraint token_lease_range check (seq_to >= seq_from),
  constraint token_lease_issued check (
    issued_upto = 0 or (issued_upto >= seq_from and issued_upto <= seq_to)
  )
);

create index token_lease_active_idx
  on token_lease (counter_id, series_id, lease_date)
  where released_at is null;

create index token_lease_day_idx on token_lease (lease_date);

/*
  Leases a block of `p_size` numbers.

  Uses the same upsert-returning counter as next_token_seq, so a lease and an
  online issue can never collide: whichever runs first moves the counter, and
  the other continues from there.
*/
create or replace function lease_token_block(
  p_counter_id text,
  p_series_id  bigint,
  p_size       integer default 50
)
returns table (
  lease_id  bigint,
  seq_from  integer,
  seq_to    integer,
  code      text,
  for_date  date
)
language plpgsql
as $$
declare
  v_date date := current_date;
  v_to   integer;
  v_code text;
begin
  if p_size < 1 or p_size > 500 then
    raise exception 'lease size % out of range', p_size
      using errcode = 'check_violation';
  end if;

  select token_series.code into v_code
    from token_series where id = p_series_id and active;
  if v_code is null then
    raise exception 'Token series % is not active', p_series_id
      using errcode = 'check_violation';
  end if;

  -- Reserve the block by advancing the shared counter.
  insert into token_counter (counter_date, series_id, last_value)
  values (v_date, p_series_id, p_size)
  on conflict (counter_date, series_id)
  do update set last_value = token_counter.last_value + p_size
  returning last_value into v_to;

  return query
  insert into token_lease (counter_id, series_id, lease_date, seq_from, seq_to)
  values (p_counter_id, p_series_id, v_date, v_to - p_size + 1, v_to)
  returning token_lease.id, token_lease.seq_from, token_lease.seq_to,
            v_code, v_date;
end;
$$;

/*
  Records a token that was issued offline from a leased number.

  Idempotent on client_uuid: replaying an outbox after a flaky connection
  must not create duplicates, and retry-safety is the whole reason the
  offline path can be trusted.
*/
alter table token add column client_uuid uuid;
create unique index token_client_uuid_idx on token (client_uuid)
  where client_uuid is not null;

alter table visit add column client_uuid uuid;
create unique index visit_client_uuid_idx on visit (client_uuid)
  where client_uuid is not null;

alter table patient add column client_uuid uuid;
create unique index patient_client_uuid_idx on patient (client_uuid)
  where client_uuid is not null;

-- Marks how far a counter has consumed its block, so day-close can tell an
-- unused reservation from an issued number.
create or replace function mark_lease_used(
  p_lease_id bigint,
  p_seq      integer
)
returns void
language sql
as $$
  update token_lease
     set issued_upto = greatest(issued_upto, p_seq)
   where id = p_lease_id;
$$;

-- Releases the unused tail of a lease. Called at day close.
create or replace function release_lease(p_lease_id bigint)
returns integer
language plpgsql
as $$
declare
  v_unused integer;
begin
  update token_lease
     set released_at = now()
   where id = p_lease_id and released_at is null
  returning (seq_to - greatest(issued_upto, seq_from - 1)) into v_unused;

  return coalesce(v_unused, 0);
end;
$$;
