-- ═══════════════════════════════════════════════════════════════════════════
--  UCDFS: meeting responses + weekly notes
--
--  The team meets on scheduled days during term (Tuesdays and Thursdays as of
--  26/27). This records who is coming, and holds the people who are not to
--  account for the week.
--
--  Deliberately NOT part of `attendance`. That table answers "were you in the
--  workshop, and between what times", which is a different question that stays
--  useful year-round for work done outside the meetings. This one answers "are
--  you coming to the session, and if not, what did you do instead". Same team,
--  two questions, and merging them would mean one row that has to mean either
--  depending on the day of the week.
--
--  Safe to run on the live database at any time: purely additive, touches no
--  existing table.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── One row per person per meeting ─────────────────────────────────────────
create table if not exists public.meeting_responses (
  id           bigserial   primary key,
  -- Keyed by account, NOT by typed-in name.
  --
  -- attendance, comp_roster, comp_requests and pt_done_log all key people by
  -- full name because they predate accounts existing, and every one of them
  -- has since needed a case-folding, whitespace-collapsing comparison to work
  -- out whether a row is yours — three of which turned out to be missing, and
  -- were how somebody could edit somebody else's row. Nothing predates
  -- accounts here, so ownership is `profile_id = the session's id`: an integer
  -- comparison with no spelling in it.
  profile_id   uuid        not null references public.profiles(id) on delete cascade,
  -- The date of the meeting itself, always a scheduled meeting day. Stored
  -- rather than derived so a one-off session, or a change of meeting days
  -- mid-season, leaves the rows that came before it still meaning what they
  -- meant when they were written.
  meeting_date date        not null,
  attending    boolean     not null,
  -- Only meaningful when attending is false, and required there: the API
  -- refuses a no with an empty reason. Still nullable-in-effect at this level,
  -- because the rows that carry a yes legitimately have none and a check
  -- constraint would have to encode the whole rule to allow them.
  reason       text        not null default '',
  updated_at   timestamptz not null default now(),
  unique (profile_id, meeting_date)
);

comment on table public.meeting_responses is
  'Who is coming to each scheduled team meeting, and why not if not. One row per person per meeting.';

-- The two queries this serves: one meeting's responses, and one person's history.
create index if not exists meeting_responses_date_idx
  on public.meeting_responses (meeting_date desc);
create index if not exists meeting_responses_profile_idx
  on public.meeting_responses (profile_id, meeting_date desc);

drop trigger if exists meeting_responses_updated_at on public.meeting_responses;
create trigger meeting_responses_updated_at
  before update on public.meeting_responses
  for each row execute function public.update_updated_at();


-- ── One row per person per week ────────────────────────────────────────────
-- "What did you do that week?" is a weekly answer, and this is its own table
-- because of what happens otherwise. Miss both Tuesday and Thursday and a
-- per-row copy is written twice, the two can be edited apart, and the week ends
-- up with two different accounts of itself. There is one week, so there is one
-- row.
create table if not exists public.week_notes (
  id          bigserial   primary key,
  profile_id  uuid        not null references public.profiles(id) on delete cascade,
  -- The Monday of the week, always. Any date normalises to its Monday before
  -- it is written, so "the week of the 15th" cannot be two different rows
  -- depending on which day someone happened to fill it in on.
  week_start  date        not null,
  summary     text        not null default '',
  updated_at  timestamptz not null default now(),
  unique (profile_id, week_start)
);

comment on table public.week_notes is
  'What somebody did in a given week, when they could not make the meetings. One row per person per week, keyed on the Monday.';

create index if not exists week_notes_week_idx
  on public.week_notes (week_start desc);

drop trigger if exists week_notes_updated_at on public.week_notes;
create trigger week_notes_updated_at
  before update on public.week_notes
  for each row execute function public.update_updated_at();


-- ── Close the door ─────────────────────────────────────────────────────────
-- Same posture as every other table: RLS on, zero policies. anon gets nothing,
-- service_role bypasses it, and all authorization happens in FastAPI. See 001
-- for why that is the intended end state, and 009 for what happens when this
-- line is forgotten.
alter table public.meeting_responses enable row level security;
alter table public.week_notes        enable row level security;
