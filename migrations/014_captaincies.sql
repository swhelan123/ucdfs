-- ═══════════════════════════════════════════════════════════════════════════
--  UCDFS: captaincy, as a permission rather than a job title
--
--  The site has had two different ideas of "captain" and neither could gate
--  anything:
--
--    profile_details.role_label  is what you call yourself. It arrives in the
--                                body of /api/profile and 003 says outright,
--                                "Relevance, never permission." Anyone can set
--                                themselves to captain, which is fine for a
--                                directory and useless for an approval.
--    profiles.role               is the real permission, and it only knows
--                                member / committee / admin. It has no notion
--                                of *which division* somebody leads.
--
--  The purchase-request applet needs exactly that missing thing: "the captain
--  of the requester's department" approves under €100, and the Ops Captain is
--  the second signature above it. So captaincy becomes a row, assigned from
--  /admin the way roles already are, and never self-declared.
--
--  A table keyed by subteam rather than a column on profiles, because the
--  primary key is the rule: a division has exactly one captain, and the schema
--  says so rather than the code hoping so. It also makes "who leads Electrical"
--  a one-row lookup instead of a scan for whoever claims to.
--
--  There is no separate ops-captain flag. The Ops Captain is the captain of the
--  ops subteam, which is what makes the fallthrough rule in TODO.md work
--  without a special case: an Ops member's request would land both slots on the
--  same person, and falls through to any other captain.
--
--  Safe to run on the live database at any time: purely additive, touches no
--  existing table, and the app works without it (an unapplied migration reads
--  as "no captains", which refuses approvals rather than granting them).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.captaincies (
  -- One of the SUBTEAMS ids in main.py: 'pt' | 'mech' | 'ops'. Text and not a
  -- foreign key because subteams are code, not rows — see the note above
  -- SUBTEAMS. Validated against SUBTEAM_IDS before any write.
  subteam     text        primary key,
  profile_id  uuid        not null references public.profiles(id) on delete cascade,
  -- Who granted it and when. Not an audit log, just the two questions anybody
  -- looking at an unexpected captaincy actually asks.
  assigned_at timestamptz not null default now(),
  assigned_by uuid        references public.profiles(id) on delete set null
);

comment on table public.captaincies is
  'Which account leads each division. The permission behind purchase approvals; profile_details.role_label is the display string and grants nothing.';

-- One person could hold two divisions in a thin year. Deliberately allowed: the
-- alternative is a unique constraint that blocks a real situation to prevent a
-- tidiness problem. The fallthrough rule already handles both slots landing on
-- the same person.
create index if not exists captaincies_profile_idx on public.captaincies (profile_id);

-- Same posture as every other table: RLS on, zero policies. anon gets nothing,
-- service_role bypasses it, and all authorization happens in FastAPI. See 001
-- for why that is the intended end state, and 009 for what happens when this
-- line is forgotten.
alter table public.captaincies enable row level security;
