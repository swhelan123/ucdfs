-- ═══════════════════════════════════════════════════════════════════════════
--  UCDFS: several people on one tracker item
--
--  017 gave a work item one owner. Real work is often two or three people on
--  one thing (a pair on the accumulator, a design review), and forcing it into
--  one name either hides who is actually on it or splits one job into copies
--  that drift apart. So an item holds a list.
--
--  An array rather than a join table, the same call favourites (008) and
--  subteams_extra (003) made: the list is small, it is always read with its
--  item, and order means something (the first person is who the item was
--  mostly made for, and whose division it defaults to). There is no foreign
--  key on the elements, so a deleted account's id can linger in a list;
--  main.py filters those out on the way out, the way favourites are filtered,
--  and the next save of the item drops them for good.
--
--  owner_id stays, and main.py keeps writing the first person into it. Nothing
--  in the new code reads it except as a fallback, but the image before this one
--  reads only owner_id, so a rollback (./deploy.sh prod <previous tag>) still
--  shows an owner on every item rather than nobody on all of them. It can be
--  dropped once rolling back past this change is no longer a thing anyone
--  would do.
--
--  Safe to run on the live database at any time: additive, and the backfill
--  only fills a list that is still empty. Re-runnable.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.work_items
  add column if not exists owner_ids uuid[] not null default '{}';

comment on column public.work_items.owner_ids is
  'Everyone on this item, in the order they were added. Supersedes owner_id, which main.py keeps as a copy of the first for rollback.';

-- Everything 017 assigned keeps its person.
update public.work_items
   set owner_ids = array[owner_id]
 where owner_id is not null
   and owner_ids = '{}';
