-- ═══════════════════════════════════════════════════════════════════════════
--  UCDFS: when a meeting answer was first given, as distinct from last changed
--
--  012 gave both tables an updated_at and a trigger that moves it on every
--  write. That is the right column for "is this stale", and the wrong one for a
--  log: fix a typo in last Tuesday's reason and the only timestamp on the row
--  jumps to today, so the record of when you actually answered is destroyed by
--  editing it.
--
--  The distinction is the point of the personal log. Answering on the Monday
--  before a session and answering on the Friday after it are different things,
--  and with one timestamp that can be edited they are indistinguishable.
--
--  Additive and safe to run at any time. Existing rows backfill from
--  updated_at rather than now(), which is exactly right for rows that have
--  never been edited (the two are equal) and the closest available truth for
--  any that have.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.meeting_responses
  add column if not exists created_at timestamptz;
alter table public.week_notes
  add column if not exists created_at timestamptz;

update public.meeting_responses set created_at = updated_at where created_at is null;
update public.week_notes        set created_at = updated_at where created_at is null;

-- Defaulted and NOT NULL only after the backfill, so the constraint is added to
-- a table that already satisfies it. The other order fails on any existing row.
alter table public.meeting_responses
  alter column created_at set default now(),
  alter column created_at set not null;
alter table public.week_notes
  alter column created_at set default now(),
  alter column created_at set not null;

comment on column public.meeting_responses.created_at is
  'When this answer was first given. updated_at moves on every edit; this does not.';
comment on column public.week_notes.created_at is
  'When this week note was first written. updated_at moves on every edit; this does not.';

-- The personal log reads one account''s rows newest-first, across a whole term
-- rather than the three-week answering window. Without these it is a scan.
create index if not exists meeting_responses_profile_created_idx
  on public.meeting_responses (profile_id, meeting_date desc);
create index if not exists week_notes_profile_week_idx
  on public.week_notes (profile_id, week_start desc);

-- RLS is already enabled on both from 012 and stays that way: adding a column
-- does not change the posture, and there are still zero policies.
