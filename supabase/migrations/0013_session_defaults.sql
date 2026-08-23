/*
  Pin the timezone and search_path on the DATABASE, not the connection.

  Both were being set as connection startup parameters. That works against a
  direct Postgres connection and is SILENTLY DROPPED by Supabase's connection
  pooler, which leaves every session on UTC.

  For this app that is the most damaging default available: current_date
  drives the daily token reset, so on UTC the series would roll over at 05:00
  local time instead of midnight — tokens issued in the early morning would
  continue yesterday's numbering, and the "reset" would land in the middle of
  the morning rush. It would also only ever happen in production, which is
  where it is hardest to notice and most expensive to debug.

  ALTER DATABASE applies to every new session regardless of how it connects,
  so it survives the pooler, psql, a migration run, and any future client.
  The connection options stay in src/lib/db.ts as well: they cost nothing and
  they keep a self-hosted Postgres correct without this migration.

  Changing the clinic's timezone means changing it here too — it is recorded
  in the README next to CLINIC_TIMEZONE.
*/

do $$
begin
  execute format(
    'alter database %I set timezone to %L',
    current_database(), 'Asia/Karachi');
  execute format(
    'alter database %I set search_path to %s',
    current_database(), 'public, extensions');
end;
$$;
