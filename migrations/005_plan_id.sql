-- 005: one canvas, many plans.
--
-- The pt_* tables were hardcoded to a single plan (the 25/26 PT manufacturing
-- plan). Every table gains a plan_id, defaulting to 'pt' so every existing row
-- keeps meaning exactly what it meant. The legacy plan keeps its data without
-- a backfill step.
--
-- Primary keys become composite (plan_id, <old key>): node ids are generated
-- client-side per plan, so two plans could otherwise collide on the same id.
-- pt_done_log keeps its bigserial. It is an append-only log, not keyed data.
--
-- Which plans exist, and their section layouts, is NOT in the database. That
-- is the PLANS registry in main.py, same philosophy as APPLETS. The database
-- only ever holds rows for plan ids the backend accepted (unknown ids are 400).
--
-- Apply to ucdfs-nonprod BEFORE merging the code that filters on plan_id, then
-- to prod BEFORE deploying that image: the code selects/filters plan_id
-- unconditionally, so it 500s against a database without this migration.

alter table public.pt_sections add column if not exists plan_id text not null default 'pt';
alter table public.pt_nodes    add column if not exists plan_id text not null default 'pt';
alter table public.pt_edges    add column if not exists plan_id text not null default 'pt';
alter table public.pt_done     add column if not exists plan_id text not null default 'pt';
alter table public.pt_progress add column if not exists plan_id text not null default 'pt';
alter table public.pt_details  add column if not exists plan_id text not null default 'pt';
alter table public.pt_done_log add column if not exists plan_id text not null default 'pt';

alter table public.pt_sections drop constraint if exists pt_sections_pkey;
alter table public.pt_sections add primary key (plan_id, sec);

alter table public.pt_nodes drop constraint if exists pt_nodes_pkey;
alter table public.pt_nodes add primary key (plan_id, id);

alter table public.pt_edges drop constraint if exists pt_edges_pkey;
alter table public.pt_edges add primary key (plan_id, id);

alter table public.pt_done drop constraint if exists pt_done_pkey;
alter table public.pt_done add primary key (plan_id, node_id);

alter table public.pt_progress drop constraint if exists pt_progress_pkey;
alter table public.pt_progress add primary key (plan_id, node_id);

alter table public.pt_details drop constraint if exists pt_details_pkey;
alter table public.pt_details add primary key (plan_id, node_id);

-- The state endpoint reads one plan's log ordered by time; the feed reads the
-- newest N across all plans and already has created_at to work with.
create index if not exists pt_done_log_plan_created_idx
  on public.pt_done_log (plan_id, created_at);
