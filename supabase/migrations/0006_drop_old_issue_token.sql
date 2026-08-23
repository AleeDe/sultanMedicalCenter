-- Migration 0005 added a 4-argument issue_token (with p_doctor_id) but the
-- original 3-argument version was left in place, because `create or replace`
-- treats a different argument list as a NEW function rather than a
-- replacement. Postgres then cannot resolve a 3-argument call:
--
--     function issue_token(unknown, unknown, unknown) is not unique
--
-- Anything still calling the old signature — scripts, psql, a future caller
-- that omits the doctor — fails. Drop the stale overload so exactly one
-- definition exists.

drop function if exists issue_token(bigint, bigint, bigint);
