-- ═══════════════════════════════════════════════════════════════════════════
--  UCDFS — accounts + row-level security
--
--  Run PART 1 first, deploy the app with SUPABASE_SERVICE_KEY set, confirm
--  you can sign in, and only then run PART 2. Doing PART 2 first would cut
--  the running app off from its own data.
--
--  Why this shape: the browser never talks to Supabase directly — every query
--  goes through FastAPI, which holds the service_role key and enforces its own
--  authorization. So the correct policy set for the anon/authenticated roles is
--  *no policies at all*: RLS on, nothing granted, PostgREST returns nothing.
--  service_role bypasses RLS, so the backend keeps working untouched.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── PART 1 — accounts ──────────────────────────────────────────────────────
-- Safe to run on a live database: purely additive, touches no existing table.

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  first_name  text        not null,
  last_name   text        not null default '',
  email       text        not null,
  -- 'member' | 'committee' | 'admin'. Replaces COMP_ADMIN_PASSWORD, and is what
  -- the APPLETS registry will check once applets carry a requires_role field.
  role        text        not null default 'member',
  created_at  timestamptz not null default now()
);

comment on table public.profiles is
  'One row per account. Display name + role; the credential itself lives in auth.users.';

create index if not exists profiles_email_idx on public.profiles (lower(email));

-- The existing tables key people by full name text (attendance.name,
-- comp_roster.person_name, comp_requests.requester). This view is the bridge
-- from an account back to those rows — no data migration required.
create or replace view public.profile_names as
  select id,
         trim(first_name || ' ' || last_name) as full_name,
         email,
         role
  from public.profiles;

-- NOTE: RLS on profiles is deliberately NOT enabled here — it belongs with the
-- rest of the lockdown in PART 2. Enabling it before the app has the service key
-- makes signup fail on the profile write, which is exactly the trap PART 2 warns
-- about. PART 1 stays runnable at any time, with or without the key.


-- ── PART 2 — close the door ────────────────────────────────────────────────
-- ⚠️  Only run this once the app is deployed with SUPABASE_SERVICE_KEY set and
--     you have signed in successfully. It revokes all anon-key access, which is
--     the entire point — but it is also what breaks a mis-configured deploy.
--
--     To undo: ALTER TABLE <name> DISABLE ROW LEVEL SECURITY;

alter table public.profiles        enable row level security;
alter table public.attendance      enable row level security;
alter table public.comp_roster     enable row level security;
alter table public.comp_requests   enable row level security;
alter table public.comp_meta       enable row level security;
alter table public.pt_nodes        enable row level security;
alter table public.pt_edges        enable row level security;
alter table public.pt_done         enable row level security;
alter table public.pt_done_log     enable row level security;
alter table public.pt_progress     enable row level security;
alter table public.pt_details      enable row level security;
alter table public.pt_sections     enable row level security;
alter table public.harness_doc     enable row level security;
alter table public.schedule_events enable row level security;

-- Deliberately no CREATE POLICY statements. With RLS enabled and zero policies,
-- anon and authenticated get nothing; service_role bypasses RLS entirely.


-- ── PART 3 — make yourself admin ───────────────────────────────────────────
-- Run AFTER you have signed up, with the address you actually signed up with.
-- Roles are 'member' | 'committee' | 'admin'. committee and admin both satisfy
-- the Competition Hub gate, so they get in without the shared password.

update public.profiles
   set role = 'admin'
 where lower(email) = lower('YOUR_EMAIL@ucdconnect.ie');

-- Promote others the same way as people join:
--   update public.profiles set role = 'committee'
--    where lower(email) = lower('them@ucdconnect.ie');

-- Who has what:
--   select email, first_name, last_name, role from public.profiles order by role, email;


-- ── PART 4 — tidy-up (optional) ────────────────────────────────────────────
-- Clears the "function search_path mutable" warning in the Supabase linter.

alter function public.update_updated_at() set search_path = public, pg_temp;
