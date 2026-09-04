-- ═══════════════════════════════════════════════════════════════════════════
--  UCDFS: purchase requests
--
--  "May I buy this?", asked before the money moves. The other half — "pay me
--  back for this", asked after — is reimbursements, and is deliberately not
--  here: the requester and the person out of pocket are usually different
--  people, which is the whole reason they cannot be one record. See the design
--  in TODO.md.
--
--  Also deliberately not comp_requests. That table is a shop run for a
--  competition weekend: it splits one cost between several people and works out
--  who owes whom. This is the opposite shape — the club owes one buyer and
--  nobody owes anybody — and sharing a table would drag that split logic into
--  something that must never have it.
--
--  Approval is a delegation of authority, not a budget, which is why it works
--  while no budget is agreed:
--
--      under the threshold   the captain of the requester's division, alone,
--                            and they may authorise their own spend
--      at or over it         that captain first, then the Ops Captain, who is
--                            always a second person
--
--  Captaincy is migrations/014. This migration is useless without it: with no
--  captains nothing can be approved, which is the safe direction.
--
--  Safe to run on the live database at any time: purely additive, touches no
--  existing table.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Settings ───────────────────────────────────────────────────────────────
-- The approval threshold is data, not a constant, for the reason links and
-- dashboard blocks are: it will be argued about, and changing it must not be a
-- deploy.
--
-- A general table rather than a finance-specific one, because the next setting
-- that wants to move out of code should not need its own migration. comp_meta
-- is the same shape and predates this; it is not being migrated here, and a new
-- setting should land in this one.
create table if not exists public.settings (
  key        text        primary key,
  value      text        not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid        references public.profiles(id) on delete set null
);

comment on table public.settings is
  'Site settings an admin can change without a deploy. Read through helpers that carry their own default, so a missing row is never a broken page.';

insert into public.settings (key, value) values ('finance.threshold_eur', '100')
  on conflict (key) do nothing;


-- ── The request ────────────────────────────────────────────────────────────
create table if not exists public.purchase_requests (
  id            bigserial   primary key,
  -- Keyed by account, like meeting_responses and unlike the older tables. There
  -- is no history here that predates accounts, so ownership is an id
  -- comparison with no name-spelling in it.
  requester_id  uuid        not null references public.profiles(id) on delete cascade,
  -- The requester's division AS IT WAS when they asked. Copied rather than
  -- joined: somebody moving from Mechanical to Electrical in March must not
  -- silently re-route every request they ever filed, or change who was supposed
  -- to have approved one.
  subteam       text        not null default '',

  item          text        not null,
  -- The justification. Required, because it is what makes an approval possible
  -- and it is Cost Event material besides.
  reason        text        not null default '',
  quantity      integer     not null default 1,
  -- Estimated, in euro. The actual lands on the reimbursement line later, and
  -- the threshold is checked against both — otherwise it is advisory: request
  -- €90, buy €300, claim it.
  est_eur       numeric(10,2),
  supplier_url  text        not null default '',
  needed_by     date,
  -- Cost coding. No budget exists to check it against; captured from day one
  -- anyway because it is the entire input to the Budget applet and the FS Cost
  -- Event later, and reconstructing it from receipts next June is not a plan.
  subsystem     text        not null default '',

  --   submitted      waiting on the division captain
  --   dept_approved  captain has signed, waiting on the Ops Captain
  --                  (only reachable at or over the threshold)
  --   approved       fully approved
  --   rejected       with a reason, which is not optional
  --   withdrawn      the requester changed their mind
  status        text        not null default 'submitted',
  -- Who filled each slot. Kept beside status rather than derived from the event
  -- log, because every approval question is "may I fill a slot that is still
  -- empty", and that should not need a scan of an append-only table.
  dept_by       uuid        references public.profiles(id) on delete set null,
  dept_at       timestamptz,
  ops_by        uuid        references public.profiles(id) on delete set null,
  ops_at        timestamptz,
  -- Frozen at submission. The threshold is data and will change; a request must
  -- keep being judged by the rule that applied when it was filed, or editing
  -- one number silently rewrites what every open request needed.
  threshold_eur numeric(10,2),
  decided_note  text        not null default '',

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.purchase_requests is
  'May I buy this, asked before the money moves. Reimbursements are the other half and are a separate record.';

create index if not exists purchase_requests_status_idx
  on public.purchase_requests (status, created_at desc);
create index if not exists purchase_requests_requester_idx
  on public.purchase_requests (requester_id, created_at desc);

drop trigger if exists purchase_requests_updated_at on public.purchase_requests;
create trigger purchase_requests_updated_at
  before update on public.purchase_requests
  for each row execute function public.update_updated_at();


-- ── The audit trail ────────────────────────────────────────────────────────
-- Append-only. Approvals are added, never updated, and this is the record that
-- survives somebody editing the row it describes. The PT plan's done-log is the
-- thing TODO.md credits for why that tool was trusted when the Notion tracker
-- was not; this is the same idea pointed at money.
create table if not exists public.purchase_events (
  id          bigserial   primary key,
  request_id  bigint      not null references public.purchase_requests(id) on delete cascade,
  actor_id    uuid        references public.profiles(id) on delete set null,
  -- Denormalised on purpose, exactly like activity_log: a line has to keep
  -- reading correctly after the account it names is deleted.
  actor_name  text        not null default '',
  action      text        not null,
  from_status text        not null default '',
  to_status   text        not null default '',
  note        text        not null default '',
  created_at  timestamptz not null default now()
);

comment on table public.purchase_events is
  'Append-only history of one purchase request. Never updated or deleted in normal use.';

create index if not exists purchase_events_request_idx
  on public.purchase_events (request_id, created_at);


-- ── Close the door ─────────────────────────────────────────────────────────
-- Same posture as every other table: RLS on, zero policies. anon gets nothing,
-- service_role bypasses it, all authorization happens in FastAPI. See 001 for
-- why that is the intended end state, and 009 for what happens when it is
-- forgotten.
alter table public.settings          enable row level security;
alter table public.purchase_requests enable row level security;
alter table public.purchase_events   enable row level security;
