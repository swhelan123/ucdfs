-- ═══════════════════════════════════════════════════════════════════════════
--  UCDFS: the tracker — who is working on what, and who has gone quiet
--
--  Admin-only for now (requires_role in the registry, and every /api/tracker/*
--  endpoint checks again). Built to open to the team later, which is why some
--  of what is below exists before anything reads it the second way: see
--  `private` on work_item_events.
--
--  Two halves, and only one of them asks anybody to type:
--
--    work items    a title and, usually, an owner. Continuous flow, no sprints:
--                  todo → doing → blocked → done. An append-only history per
--                  item, same idea as pt_done_log and purchase_events.
--    people        nothing to type at all. Derived from what people already
--                  leave behind: attendance, flowchart ticks, purchase
--                  requests, and updates on their items. person_notes is the
--                  one exception, and is admin-only forever.
--
--  TODO.md said "do not rebuild Jira", from the Notion post-mortem. Read the
--  Tracker section there for why this is not that: the Notion tracker asked the
--  whole team to fill in forms in a tool that was hard to use, and nothing
--  broke when they stopped. Half of this asks nobody for anything.
--
--  ALSO: attendance and pt_done_log gain a profile_id. Both key people by the
--  name that was typed, because they predate accounts, so "Cian OB" and "Cian
--  O'Brien" were two people to anything counting rows. The People view needs
--  to know whose row is whose without guessing from spelling, so the account is
--  stamped on the row: backfilled below where the name matches exactly one
--  account, and written by main.py on every new row. Whatever is left over is
--  listed in /admin to be matched by hand, once.
--
--  Needs 015 (the settings table) for the quiet threshold at the bottom.
--
--  Safe to run on the live database at any time: additive. The two ALTERs add
--  nullable columns, and the backfill only ever fills in a null.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Work items ─────────────────────────────────────────────────────────────
create table if not exists public.work_items (
  -- Shown as T-<id>. The row id rather than a counter, same call as PR-…:
  -- unique, never changes, and nothing for two creates to race over.
  id             bigserial   primary key,
  title          text        not null,
  description    text        not null default '',
  -- Nullable on purpose: "this needs doing, nobody has it yet" is a real state,
  -- and refusing it would push exactly those items out of the tracker.
  owner_id       uuid        references public.profiles(id) on delete set null,
  -- A SUBTEAMS id, or '' for none. Prefilled from the owner, editable, and
  -- copied rather than joined so moving division does not re-file history.
  subteam        text        not null default '',
  --   todo     not started
  --   doing    somebody is on it
  --   blocked  waiting on something; blocked_reason says what
  --   done
  -- Checked in main.py (TRACKER_STATUSES), not here, like every other status
  -- column in this schema.
  status         text        not null default 'todo',
  -- "Waiting on the M6 bolts." The single most common real state of a task,
  -- and the one TODO.md notes neither Notion nor the flowcharts can express.
  blocked_reason text        not null default '',
  due_date       date,
  -- An http(s) url: Onshape, SharePoint, a chart. Scheme-checked in main.py,
  -- because an href dispatches on protocol and escaping does not touch it.
  link           text        not null default '',
  created_by     uuid        references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- When it last MOVED: a status change, an update, a new owner. Not
  -- updated_at, which the trigger bumps on any write, so fixing a typo in the
  -- title would make a three-week-stale item look fresh. This is what "doing,
  -- no update in 8 days" is measured from.
  touched_at     timestamptz not null default now(),
  done_at        timestamptz
);

comment on table public.work_items is
  'Tracker items: who is doing what. Admin-only for now; see 017 and the Tracker section of TODO.md.';

create index if not exists work_items_status_idx on public.work_items (status, touched_at);
create index if not exists work_items_owner_idx  on public.work_items (owner_id, status);

drop trigger if exists work_items_updated_at on public.work_items;
create trigger work_items_updated_at
  before update on public.work_items
  for each row execute function public.update_updated_at();


-- ── An item's history ──────────────────────────────────────────────────────
-- Append-only. Same reasoning as purchase_events: the record survives the row
-- it describes being edited, and it is what makes the tracker trustworthy
-- rather than a list of current opinions.
create table if not exists public.work_item_events (
  id          bigserial   primary key,
  item_id     bigint      not null references public.work_items(id) on delete cascade,
  actor_id    uuid        references public.profiles(id) on delete set null,
  -- Denormalised, like activity_log and purchase_events: a line has to keep
  -- reading correctly after the account it names is gone.
  actor_name  text        not null default '',
  --   created   the item was made
  --   status    from_value → to_value
  --   assigned  from_value → to_value are account ids
  --   edited    body lists which fields changed
  --   note      an update; body is the text
  kind        text        not null,
  from_value  text        not null default '',
  to_value    text        not null default '',
  body        text        not null default '',
  -- Admins only, forever, including after the tracker opens to the team.
  -- Decided now rather than then: a note written today on the assumption that
  -- only admins read it must not become visible the day that stops being true.
  -- Status changes and ordinary updates are written with false.
  private     boolean     not null default false,
  created_at  timestamptz not null default now()
);

comment on table public.work_item_events is
  'Append-only history of one tracker item. private = admins only, even once the tracker is open to the team.';

create index if not exists work_item_events_item_idx  on public.work_item_events (item_id, created_at);
create index if not exists work_item_events_actor_idx on public.work_item_events (actor_id, created_at);
create index if not exists work_item_events_when_idx  on public.work_item_events (created_at desc);


-- ── Notes about a person ───────────────────────────────────────────────────
-- "Wants to move to aero." Not tied to any item. Admin-only forever: there is
-- no private flag because there is no public version of this table.
--
-- Cascades with the account. These are notes about a named person, so when the
-- person is deleted they go too. That is also the honest answer to a GDPR
-- request: anyone may ask what is held about them, which is the reason the
-- page says to write these as if the person will read them.
create table if not exists public.person_notes (
  id          bigserial   primary key,
  profile_id  uuid        not null references public.profiles(id) on delete cascade,
  author_id   uuid        references public.profiles(id) on delete set null,
  author_name text        not null default '',
  body        text        not null,
  created_at  timestamptz not null default now()
);

comment on table public.person_notes is
  'Admin-only notes about a member. Never shown to members, including the member it is about.';

create index if not exists person_notes_profile_idx on public.person_notes (profile_id, created_at desc);


-- ── Accounts on the name-keyed tables ──────────────────────────────────────
-- Nullable, and `on delete set null` rather than cascade: these rows record
-- what happened, not who exists (CLAUDE.md, "Deleting an account"), so they
-- outlive the account exactly as they did before this column existed.
alter table public.attendance  add column if not exists profile_id uuid
  references public.profiles(id) on delete set null;
alter table public.pt_done_log add column if not exists profile_id uuid
  references public.profiles(id) on delete set null;

create index if not exists attendance_profile_idx  on public.attendance  (profile_id, date desc);
create index if not exists pt_done_log_profile_idx on public.pt_done_log (profile_id, created_at desc);

-- Backfill. The fold is the one main.py uses everywhere (_fold_name): case
-- ignored, whitespace collapsed, so "shane  whelan" is "Shane Whelan". Collapse
-- first and trim second: btrim only strips spaces, so the other order would
-- leave a leading tab as a leading space, and Python's split() would not.
--
-- Only names that match EXACTLY ONE account are filled in. Two members called
-- the same thing is rare and real, and guessing between them would attribute
-- one person's history to the other with nothing on screen to say so. Those
-- rows stay null and are listed in /admin with everything else unmatched.
with folded as (
  select lower(btrim(regexp_replace(coalesce(first_name, '') || ' ' || coalesce(last_name, ''),
                              '\s+', ' ', 'g'))) as k,
         id
  from public.profiles
), unique_names as (
  select k, (array_agg(id))[1] as id
  from folded
  where k <> ''
  group by k
  having count(*) = 1
)
update public.attendance a
   set profile_id = u.id
  from unique_names u
 where a.profile_id is null
   and lower(btrim(regexp_replace(a.name, '\s+', ' ', 'g'))) = u.k;

with folded as (
  select lower(btrim(regexp_replace(coalesce(first_name, '') || ' ' || coalesce(last_name, ''),
                              '\s+', ' ', 'g'))) as k,
         id
  from public.profiles
), unique_names as (
  select k, (array_agg(id))[1] as id
  from folded
  where k <> ''
  group by k
  having count(*) = 1
)
update public.pt_done_log l
   set profile_id = u.id
  from unique_names u
 where l.profile_id is null
   and lower(btrim(regexp_replace(l.user_name, '\s+', ' ', 'g'))) = u.k;


-- ── The quiet threshold ────────────────────────────────────────────────────
-- Business days with no sign of somebody before the People view flags them.
-- 0 turns flags off, for exams and Christmas. Data rather than a constant for
-- the reason the €100 threshold is: it gets changed, and changing it must not
-- be a deploy. Edited from /admin.
insert into public.settings (key, value) values ('tracker.quiet_days', '5')
  on conflict (key) do nothing;


-- ── Close the door ─────────────────────────────────────────────────────────
-- Same posture as every other table: RLS on, zero policies. anon gets nothing,
-- service_role bypasses it, all authorization happens in FastAPI. See 001, and
-- 009 for what happens when this line is forgotten.
alter table public.work_items       enable row level security;
alter table public.work_item_events enable row level security;
alter table public.person_notes     enable row level security;
