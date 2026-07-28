-- ═══════════════════════════════════════════════════════════════════════════
--  UCDFS — subteams + team profiles
--
--  Two features in one migration because they are one feature in practice: the
--  first-sign-in flow asks for a subteam and a profile in the same sequence,
--  and splitting the SQL would mean applying half of it and having a flow that
--  works for one question but not the next.
--
--  Safe to run on the live database at any time. Every statement is additive:
--  two new tables and two new columns on profiles. Nothing existing is altered
--  or dropped, and the app works before it is applied — the profiles page and
--  the subteam picker degrade to "not set up yet" rather than erroring.
--
--  Run this AFTER 002. Nothing here depends on activity_log, but the by-hand
--  ordering convention is what stops a half-applied schema going unnoticed.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── Subteams on the account ────────────────────────────────────────────────
-- Lives on profiles, not in profile_details, because it is identity-adjacent:
-- the session cookie carries it so the dashboard can filter without a fetch,
-- and _public_profile() reads it straight off the row it already loaded.
--
-- Primary + extras rather than a single list. Powertrain people do mechanical
-- work constantly, so one value is a lie — but something has to drive defaults
-- and the filter, so the primary is what does that and the extras are for
-- "also find me under".
--
-- Null is a real, supported state: "not sure yet" during recruitment. It must
-- never block anyone, so nothing below is NOT NULL.
alter table public.profiles
  add column if not exists subteam        text,             -- 'pt' | 'mech' | 'ops' | null
  add column if not exists subteams_extra text[] not null default '{}';

comment on column public.profiles.subteam is
  'Primary subteam: pt | mech | ops, or null for "not sure yet". Relevance, never permission — see requires_role for that.';


-- The existing bridge view from an account to the name-keyed tables. Recreated
-- with subteam appended so "who is on Powertrain" is one query, not a join.
-- New columns go on the end: create or replace cannot reorder or remove.
create or replace view public.profile_names as
  select id,
         trim(first_name || ' ' || last_name) as full_name,
         email,
         role,
         subteam
  from public.profiles;


-- ── The profile itself ─────────────────────────────────────────────────────
-- Separate table rather than more columns on profiles. profiles is loaded on
-- every single request by the auth middleware; this is read by one page. Keep
-- the hot row narrow.
create table if not exists public.profile_details (
  id           uuid primary key references public.profiles(id) on delete cascade,

  year         text        not null default '',   -- '1st'…'5th' | 'MSc' | 'PhD'
  course       text        not null default '',
  joined_year  int,                               -- the season they started
  role_label   text        not null default '',   -- 'member' | 'lead' | 'committee'

  -- Just the extension: '<uuid>.jpg' under UPLOAD_DIR/avatars, or ''. The
  -- filename is derived from the account id, so this column is really a
  -- "has a photo" flag that also survives us changing the image format.
  photo_ext    text        not null default '',
  -- Bumped on every photo write. Photos overwrite in place at a stable URL, so
  -- without this the browser shows the old one until the cache expires.
  photo_rev    int         not null default 0,

  -- What this person can be asked about — 'can bus', 'welding', 'catia'. The
  -- reason this page still matters in November: it turns a fun grid into a
  -- directory you search when something breaks.
  tags         text[]      not null default '{}',

  -- Members-only by default. Opting in is what makes a recruitment/sponsor page
  -- possible later without asking anyone twice.
  is_public    boolean     not null default false,

  -- Set once the first-sign-in flow has been answered, including when the
  -- answer was "not sure yet". Without it, someone who legitimately has no
  -- subteam gets asked the same question every time they open the site.
  onboarded_at timestamptz,

  updated_at   timestamptz not null default now()
);

comment on table public.profile_details is
  'The bits of a person that are not their credential. One row per account, created lazily on first save.';

-- The directory's only filter that cannot be done in the browser cheaply.
create index if not exists profile_details_tags_idx
  on public.profile_details using gin (tags);


-- ── Prompts ────────────────────────────────────────────────────────────────
-- Pick 3 from a fixed list rather than "write a bio". Free text produces empty
-- profiles; choosing produces filled ones, because choosing is easier than
-- composing. That is the entire design of this table.
--
-- prompt_key is free text matching PROMPTS in main.py, not an enum or a foreign
-- key: adding a prompt should be a one-line change there and no migration here.
-- Retiring one must not delete anyone's answer, so nothing enforces membership.
create table if not exists public.profile_prompts (
  id         bigserial   primary key,
  profile_id uuid        not null references public.profiles(id) on delete cascade,
  prompt_key text        not null,
  answer     text        not null default '',
  -- Display order, so people can put their best one first.
  position   int         not null default 0,
  updated_at timestamptz not null default now(),

  -- One answer per prompt per person. The save path upserts on this.
  unique (profile_id, prompt_key)
);

comment on table public.profile_prompts is
  'Answers to the fixed prompt list. Three per person by convention, not enforced — the cap is a UI decision and will change.';

create index if not exists profile_prompts_profile_idx
  on public.profile_prompts (profile_id, position);


-- ── Lockdown ───────────────────────────────────────────────────────────────
-- Same posture as every other table: RLS on, zero policies. anon gets nothing,
-- service_role bypasses it, and all authorization happens in FastAPI. See 001
-- for why that is the intended end state rather than an unfinished job.
alter table public.profile_details enable row level security;
alter table public.profile_prompts enable row level security;


-- ── Backfill (optional) ────────────────────────────────────────────────────
-- Nothing needs it — profile_details rows are created lazily on first save and
-- every read copes with a missing one. Run this only if you would rather see
-- every existing member in the directory immediately, greyed out and empty,
-- instead of them appearing as they fill it in.
--
--   insert into public.profile_details (id)
--   select id from public.profiles
--   on conflict (id) do nothing;


-- ── Checks ─────────────────────────────────────────────────────────────────
--   select subteam, count(*) from public.profiles group by subteam;
--   select p.email, d.year, d.course, cardinality(d.tags) as tags
--     from public.profiles p join public.profile_details d using (id);
