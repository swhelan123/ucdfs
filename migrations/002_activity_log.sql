-- ═══════════════════════════════════════════════════════════════════════════
--  UCDFS — activity_log
--
--  One append-only table every applet writes a line to, so the dashboard can
--  show a live pulse of the team's work without each applet inventing its own
--  log. Written to by log_activity() in main.py.
--
--  Safe to run on the live database at any time: purely additive, touches no
--  existing table, and the app already works without it (log_activity swallows
--  the failure, and the dashboard feed falls back to pt_done_log alone).
--
--  Unlike 001 this is a single part. RLS goes on immediately because the app is
--  already deployed with the service key by the time you're reading this — the
--  ordering trap 001 warns about only applied to the first lockdown.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.activity_log (
  id         bigserial   primary key,
  -- Matches an id in the APPLETS registry in main.py ('pt', 'comp', …). Kept as
  -- free text rather than an enum so adding an applet stays a one-line change
  -- there and needs no migration here.
  applet     text        not null,
  actor      text        not null default '',
  verb       text        not null,
  -- Denormalised on purpose: the text of what was acted on, captured at write
  -- time. A feed line has to keep reading correctly after the thing it names is
  -- renamed or deleted — it records what happened, not what currently exists.
  subject    text        not null default '',
  created_at timestamptz not null default now()
);

comment on table public.activity_log is
  'Append-only feed of team activity. Never updated or deleted in normal use.';

-- The only query this table serves: newest N.
create index if not exists activity_log_created_idx
  on public.activity_log (created_at desc);

-- Same posture as every other table: RLS on, zero policies. anon gets nothing,
-- service_role bypasses it. See 001 for why that is the intended end state.
alter table public.activity_log enable row level security;
