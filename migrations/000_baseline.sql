-- ═══════════════════════════════════════════════════════════════════════════
--  UCDFS — baseline schema
--
--  The entire public schema as it stood in production on 2026-07-28, captured
--  by introspecting the live database. Read this file first; it is the only
--  one a brand-new environment needs.
--
--  Why it exists: 001–004 were written as this app grew, but twelve of the
--  seventeen tables were never in any of them. attendance, the seven pt_*
--  tables, the comp_* tables, harness_doc and schedule_events were created by
--  hand in the Supabase dashboard and existed *only* inside the production
--  database. Losing that project meant losing the schema, and there was no way
--  to stand up a second environment to test against — which is the whole
--  reason this file was written.
--
--  How to use it:
--
--    fresh environment (dev / stage / a restored prod)
--        run THIS FILE ONLY. It is the squashed sum of 001–004; running those
--        afterwards would be redundant, and 001 PART 2 in particular is written
--        to be run at a very specific moment that does not apply here.
--
--    the existing production database
--        already has all of this. Running it is a no-op — every statement is
--        guarded by "if not exists" or "or replace" — but there is no reason to.
--
--    from here on
--        schema changes are new numbered files (005_…, 006_…) applied to every
--        environment in order. This file is not edited again; it is a snapshot
--        of a moment, not a living document.
--
--  What is deliberately NOT here: data. No accounts, no attendance rows, no
--  profiles, no photos. A fresh environment starts empty and you sign up into
--  it. Reference data that makes the app navigable — the PT plan's nodes and
--  edges, the competition schedule — is seeded separately, because it is
--  content rather than structure and it changes on its own timetable.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── Shared trigger function ────────────────────────────────────────────────
-- Only attendance uses it today. The search_path pin is not decoration: an
-- unqualified function called from a trigger resolves against the caller's
-- search_path, which is what the Supabase linter flags as mutable.

create or replace function public.update_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

alter function public.update_updated_at() set search_path = public, pg_temp;


-- ── Accounts ───────────────────────────────────────────────────────────────
-- profiles is loaded by the auth middleware on EVERY request, which is why the
-- directory's detail columns live in profile_details rather than widening this
-- row. id is the auth.users id — the credential itself never leaves GoTrue.

create table if not exists public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  first_name     text        not null,
  last_name      text        not null default '',
  email          text        not null,
  -- 'member' | 'committee' | 'admin'. The real permission, checked by
  -- require_role(). Not to be confused with profile_details.role_label, which
  -- is what you call yourself on your profile and grants nothing.
  role           text        not null default 'member',
  created_at     timestamptz not null default now(),
  -- 'pt' | 'mech' | 'ops' | null. null is a real answer — "not sure yet" during
  -- September recruitment is not a gap.
  subteam        text,
  subteams_extra text[]      not null default '{}',
  -- The switch, not the capability. Meaningless unless role = 'admin'.
  god_mode       boolean     not null default false
);

comment on table public.profiles is
  'One row per account. Display name + role; the credential itself lives in auth.users.';
comment on column public.profiles.god_mode is
  'Is this admin currently elevated? Meaningless unless role = admin — the role is the capability, this is the switch.';

create index if not exists profiles_email_idx on public.profiles (lower(email));

-- The bridge from an account back to the older tables, which key people by
-- full name text (attendance.name, comp_roster.person_name,
-- comp_requests.requester) because they predate accounts.
create or replace view public.profile_names as
  select id,
         trim(first_name || ' ' || last_name) as full_name,
         email,
         role,
         subteam
  from public.profiles;


-- ── The team directory ─────────────────────────────────────────────────────

create table if not exists public.profile_details (
  id           uuid primary key references public.profiles(id) on delete cascade,
  year         text        not null default '',
  course       text        not null default '',
  joined_year  integer,
  -- What you call yourself: Captain, Technical Director, Team member. A display
  -- string. profiles.role is the permission; merging the two would mean editing
  -- your own profile could grant you access.
  role_label   text        not null default '',
  photo_ext    text        not null default '',
  -- Photos overwrite in place, so URLs carry ?v=photo_rev. Without it the
  -- browser keeps showing the old face.
  photo_rev    integer     not null default 0,
  -- Lowercased and de-duplicated on write, or "CAN bus" and "can bus" become
  -- two chips for one skill and the directory stops being searchable.
  tags         text[]      not null default '{}',
  is_public    boolean     not null default false,
  -- Records that we asked the subteam question, so nobody is asked twice.
  onboarded_at timestamptz,
  updated_at   timestamptz not null default now()
);

comment on table public.profile_details is
  'The bits of a person that are not their credential. One row per account, created lazily on first save.';

create index if not exists profile_details_tags_idx on public.profile_details using gin (tags);

create table if not exists public.profile_prompts (
  id         bigserial primary key,
  profile_id uuid        not null references public.profiles(id) on delete cascade,
  prompt_key text        not null,
  answer     text        not null default '',
  position   integer     not null default 0,
  updated_at timestamptz not null default now(),
  unique (profile_id, prompt_key)
);

comment on table public.profile_prompts is
  'Answers to the fixed prompt list. Three per person by convention, not enforced — the cap is a UI decision and will change.';

create index if not exists profile_prompts_profile_idx
  on public.profile_prompts (profile_id, position);


-- ── The activity feed ──────────────────────────────────────────────────────
-- Subjects are text captured at write time, not foreign keys, so a line still
-- reads correctly after the thing it names is renamed or deleted.

create table if not exists public.activity_log (
  id         bigserial   primary key,
  applet     text        not null,
  actor      text        not null default '',
  verb       text        not null,
  subject    text        not null default '',
  created_at timestamptz not null default now()
);

comment on table public.activity_log is
  'Append-only feed of team activity. Never updated or deleted in normal use.';

create index if not exists activity_log_created_idx
  on public.activity_log (created_at desc);


-- ── Attendance ─────────────────────────────────────────────────────────────
-- Keyed by name text, not by account: these rows predate accounts and were
-- typed by hand. Ownership checks fold case and collapse whitespace for the
-- same reason. A null time means we do not know, and someone who logged no
-- departure counts as still here — showing a present person as gone is the
-- worse error.

create table if not exists public.attendance (
  id             bigserial   primary key,
  name           text        not null,
  date           date        not null,
  status         text        not null,
  time           text,
  note           text,
  updated_at     timestamptz not null default now(),
  departure_time text,
  unique (name, date)
);

drop trigger if exists attendance_updated_at on public.attendance;
create trigger attendance_updated_at
  before update on public.attendance
  for each row execute function public.update_updated_at();


-- ── The PT manufacturing plan ──────────────────────────────────────────────
-- The applet that actually worked. Nodes and edges are the graph; pt_done is
-- the tick state and pt_done_log is its audit trail, which the dashboard feed
-- reads directly rather than duplicating.
--
-- pt_progress and pt_details are both single-column-ish leftovers. They are
-- reproduced exactly as production has them; tidying them up is a migration of
-- its own, not something to smuggle into a baseline.

create table if not exists public.pt_sections (
  sec text primary key,
  w   double precision,
  h   double precision
);

create table if not exists public.pt_nodes (
  id        text    primary key,
  label     text    not null,
  sec       text    not null,
  type      text    not null,
  x         double precision,
  y         double precision,
  deps      jsonb   default '[]'::jsonb,
  is_custom boolean not null default true
);

create table if not exists public.pt_edges (
  id       text    primary key,
  f        text    not null,
  t        text    not null,
  is_cross boolean not null default false
);

create table if not exists public.pt_done (
  node_id text primary key
);

create table if not exists public.pt_progress (
  node_id text primary key
);

create table if not exists public.pt_details (
  node_id text primary key,
  details text
);

create table if not exists public.pt_done_log (
  id         bigserial   primary key,
  node_id    text        not null,
  done       boolean     not null,
  user_name  text        not null default 'Unknown',
  created_at timestamptz not null default now()
);


-- ── The competition hub ────────────────────────────────────────────────────

create table if not exists public.comp_roster (
  id          bigserial primary key,
  day         text not null,
  role        text not null,
  person_name text not null,
  unique (day, role, person_name)
);

create table if not exists public.comp_requests (
  id         bigserial     primary key,
  requester  text          not null,
  item       text          not null,
  split_with jsonb         default '[]'::jsonb,
  status     text          default 'pending',
  price      numeric(8,2),
  created_at timestamptz   default now(),
  bought_by  text,
  shop_date  date,
  quantity   integer       not null default 1
);

create table if not exists public.comp_meta (
  key   text primary key,
  value text
);

-- Identity always, not bigserial: production has it as a generated identity
-- column and the difference shows up the first time something inserts an
-- explicit id.
create table if not exists public.schedule_events (
  id         bigint generated always as identity primary key,
  day        text        not null,
  time       text        not null,
  name       text        not null,
  location   text        not null,
  is_ucdfs   boolean     not null default false,
  sort_order integer     not null default 0,
  created_at timestamptz default now()
);


-- ── The wiring harness ─────────────────────────────────────────────────────
-- One row, id = 'main'. That single hardcoded id is the reason there can never
-- be both an LV and an HV harness — see the plan_id generalisation in TODO.md.

create table if not exists public.harness_doc (
  id         text primary key,
  doc        jsonb,
  updated_at timestamptz default now()
);


-- ── Close the door ─────────────────────────────────────────────────────────
-- RLS on, zero policies, on every table. That is the intended end state, not an
-- oversight: the browser never talks to Supabase, so anon and authenticated
-- should be able to reach nothing at all. service_role bypasses RLS entirely,
-- which is what keeps the backend working.
--
-- Do not add policies to "fix" this. If PostgREST starts returning rows to the
-- anon key, something is wrong.
--
-- Unlike 001, it is safe to run this here: a fresh database has no app pointed
-- at it yet, so there is no live deploy to cut off from its own data.

do $$
declare t text;
begin
  foreach t in array array[
    'profiles', 'profile_details', 'profile_prompts', 'activity_log',
    'attendance', 'comp_roster', 'comp_requests', 'comp_meta',
    'pt_nodes', 'pt_edges', 'pt_done', 'pt_done_log', 'pt_progress',
    'pt_details', 'pt_sections', 'harness_doc', 'schedule_events'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;


-- ── Your first admin ───────────────────────────────────────────────────────
-- Sign up in the app first — this updates a row that signup creates. Then run
-- it with the address you actually used.
--
-- role is the capability and god_mode is the switch. Both are set here because
-- an environment with an admin who has to hunt for the toggle before they can
-- do anything is an environment nobody finishes setting up.
--
--   update public.profiles
--      set role = 'admin', god_mode = true
--    where lower(email) = lower('YOUR_EMAIL@ucdconnect.ie');
--
-- Everyone after that gets promoted from /admin in the app, which is a normal
-- task rather than a migration. Who has what:
--
--   select email, first_name, last_name, role, god_mode from public.profiles
--    order by role, email;
