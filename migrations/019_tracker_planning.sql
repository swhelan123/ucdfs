-- ═══════════════════════════════════════════════════════════════════════════
--  UCDFS: planning fields on tracker items
--
--  017 made the tracker answer "who is on what". This lets it answer "what is
--  next, and are we going to make the design freeze": an area to sort the
--  board by, how long a job takes, what it waits on, and which deadline it is
--  for. Every one of them is optional. A title is still the only thing an item
--  needs (TODO.md, the Notion post-mortem), and an item with none of these
--  behaves exactly as it did before.
--
--  Deliberately absent: estimates in points, sprints, velocity. duration_days
--  is "about how many working days", for drawing a due date when nobody has
--  given one, not something the team is measured against.
--
--  The design freeze dates themselves are NOT here. They are two rows in
--  settings (015), milestone.design_freeze.pt and milestone.design_freeze.mech,
--  edited from /admin like tracker.quiet_days, so moving a freeze is not a
--  migration and not a deploy. main.py falls back to 19 November 2026 for a
--  division with no row.
--
--  Nullable, all of it, including the two with defaults: main.py reads a null
--  as "not set" everywhere, and keeps working against a database that has not
--  had this file yet (it retries a write without these columns, the way 017
--  and 018's writes do, and refuses only a write that actually sets one).
--
--  Safe to run on the live database at any time: additive, no backfill, no
--  rewrite of existing rows. Re-runnable.
-- ═══════════════════════════════════════════════════════════════════════════

-- Which part of the car, for the board's swimlanes and the card's colour.
-- Checked in main.py (TRACKER_AREAS), not here, like status and subteam: a new
-- area is a one-line change to a list, not a migration.
alter table public.work_items
  add column if not exists area text;

-- About how many BUSINESS days the job takes. With no due_date, main.py draws
-- one: the start plus this many weekdays, shown as "est." so nobody mistakes
-- it for a deadline somebody agreed to. An explicit due_date always wins.
alter table public.work_items
  add column if not exists duration_days integer;

-- When it can start, if that is known. Without it the derived due date starts
-- from the latest due date of whatever this waits on, or failing that, today.
alter table public.work_items
  add column if not exists starts_on date;

-- Ids of the items this one waits on: "can't route the loom until the
-- connector list is done". An array with no foreign key, the call 018 made for
-- owner_ids: a deleted item's id can linger, main.py ignores ids that name
-- nothing and the next save drops them. main.py refuses a save that would make
-- a loop, so the derived dates always terminate.
--
-- This is not blocked_reason. Blocked is "stuck on something outside the
-- board" and has to be said in words; waits_on is the order of the work, and
-- an item whose waits are all done shows as Ready without anybody moving it.
alter table public.work_items
  add column if not exists waits_on bigint[] default '{}';

-- On the critical path: late here makes the freeze late. A flag rather than
-- something computed from waits_on, because the team knows which jobs matter
-- better than a graph of a half-entered plan does.
alter table public.work_items
  add column if not exists critical boolean default false;

-- Which deadline this is for: a key main.py knows (design_freeze, or one of
-- SEASON_MILESTONES). design_freeze resolves to the item's OWN division's
-- date, from settings, so one key serves Electrical and Mechanical without
-- either having to know the other's date. An item in a division with no
-- freeze date shows none.
alter table public.work_items
  add column if not exists milestone text;

comment on column public.work_items.area is
  'Area of the car (TRACKER_AREAS in main.py), or null. 019.';
comment on column public.work_items.duration_days is
  'About how many business days the job takes. Used to derive a due date when none is set. 019.';
comment on column public.work_items.starts_on is
  'When it can start, if known. Start of the derived due date. 019.';
comment on column public.work_items.waits_on is
  'Ids of items this one waits on. No FK; unknown ids are ignored. Loops are refused in main.py. 019.';
comment on column public.work_items.critical is
  'On the critical path for its milestone. 019.';
comment on column public.work_items.milestone is
  'Milestone key (design_freeze resolves per division from settings). 019.';
