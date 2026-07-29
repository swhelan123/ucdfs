-- 007: charts are data too.
--
-- The last of three steps. 005 made every pt_* row belong to a plan, 006 made
-- a plan's sections rows instead of registry entries, and this makes the plans
-- themselves rows. The PLANS dict in main.py goes away entirely: what charts
-- exist is now something the team decides at runtime, from /flowcharts, rather
-- than something that needs a code change and a deploy.
--
-- That is what turns "the PT plan and the Mech plan" into "the flowchart tool",
-- and it is why Mech can finally have a real build plan without waiting on
-- anyone: they make one.
--
-- The whitelist property that PLANS provided is kept, just moved. A plan id
-- still reaches supabase.table() filters, so it is still validated before use —
-- against this table rather than against a literal dict. Ids are minted
-- server-side (chart_…), never taken from the client, so a caller cannot name
-- a row into existence.

create table if not exists public.plans (
  id         text        primary key,
  name       text        not null,
  icon       text,
  blurb      text,
  -- Archived is the soft, reversible action: last season's plan stops being in
  -- the way without anybody having to decide whether to destroy it. Deleting is
  -- refused unless the plan is empty, so the destructive path cannot be taken
  -- by accident — see /api/plans/delete.
  archived   boolean     not null default false,
  created_at timestamptz not null default now(),
  -- The name that was typed, captured at write time, like activity subjects and
  -- for the same reason: it still reads correctly after that account is gone.
  created_by text
);

-- The two plans that existed as PLANS entries. 'pt' is last season's — the
-- 25/26 build, finished — so it arrives archived, which is what puts it under
-- "Last season" on the dashboard and in the picker rather than at the top of
-- both. 'pt-2627' was created as an empty 26/27 starter and is the live one.
insert into public.plans (id, name, icon, blurb, archived) values
  ('pt',      'PT Manufacturing Plan', '🏎️',
              'Powertrain build tasks, dependencies and progress', true),
  ('pt-2627', 'PT Plan 26/27',         '🏎️',
              'Powertrain build plan for the 26/27 season',        false)
on conflict (id) do nothing;

-- Anything that already has rows but no plan of its own. There should be
-- nothing here, but a plan id that exists only in pt_nodes would be a chart
-- holding real work that the picker cannot list and the whitelist now rejects —
-- silently unreachable, which is the worst of the options. Adopt it instead.
insert into public.plans (id, name, icon, blurb, archived)
select distinct plan_id, plan_id, '📋', 'Adopted by migration 007', false
from (
  select plan_id from public.pt_nodes
  union select plan_id from public.pt_sections
  union select plan_id from public.pt_done_log
) used
on conflict (id) do nothing;
