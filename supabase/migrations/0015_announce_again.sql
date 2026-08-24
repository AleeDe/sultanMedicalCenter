/*
  Announcing a called patient a second time.

  A patient who is in the toilet, outside on the phone, or simply not
  listening misses their number. Until now the doctor's only options were to
  wait or to skip them — and skipping is a real cost to the patient, who then
  loses their place, when all that actually went wrong is that nobody heard
  the call.

  The board already supports this: the announcement key it de-duplicates on
  is `token_id:recall_count`, precisely so that a deliberate re-call is a
  different key and announces again while the five-second poll re-rendering
  the same state does not. Nothing incremented that counter, so the
  capability existed and was unreachable.

  Deliberately NOT reusing recall_token(): that function puts a SKIPPED or
  NO_SHOW patient back into the queue, which is a different thing that
  happens at a different moment. Overloading it would mean one button whose
  meaning depends on state the doctor cannot see.
*/

/** Announces an already-called patient again, without moving their place. */
create or replace function announce_again(p_token_id bigint)
returns void
language sql
as $fn$
  update token
     set recall_count = coalesce(recall_count, 0) + 1,
         /*
           called_at is bumped too, so the board treats this as a fresh
           summons. Without it the re-announcement inherits the original
           timestamp and is discarded by the staleness rule that stops a
           newly-opened board shouting calls from earlier in the day.
         */
         called_at = now()
   where id = p_token_id
     -- Only a patient who is actually being called. Re-announcing someone
     -- already in the consulting room would send them back to the waiting
     -- area.
     and status = 'CALLED';
$fn$;
