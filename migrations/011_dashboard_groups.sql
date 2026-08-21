-- 011: the dashboard's blocks are data too.
--
-- 010 made hyperlink cards rows and left the blocks they sit in as a Python
-- list, which held for about as long as it took to want a second one. The same
-- argument applies: what the dashboard is *divided into* is a decision about
-- how the team thinks about its own tools, and that changes more often than the
-- code does. "Suppliers", "Rules", "Whoever we are sponsored by this year".
--
-- This table is deliberately thin. A block is an id, a label and a position.
-- There is no colour, no icon and no subteam: it is a heading over a grid, and
-- every attribute added here is one more thing to keep consistent with the
-- cards underneath it.
--
-- Applets carry a group too, and applets are still code. That is the one real
-- asymmetry: an admin can delete a block that a *registry entry* names, which
-- would leave that entry pointing at nothing. /api/admin/groups/delete refuses
-- a block that any card is in, counting applets as well as links, so the case
-- cannot arise from the UI. _card_group() falls back to the first block anyway,
-- because a card that renders nowhere is worse than a card in the wrong place:
-- one is a layout complaint, the other is a tool that exists on the server and
-- cannot be found on the page.

create table if not exists public.dashboard_groups (
  -- Readable ids for the seeded blocks, minted (grp_…) for anything added
  -- later, the same split as links: a caller cannot choose the primary key, but
  -- the rows that predate the feature keep names worth reading in a query.
  id         text        primary key,
  label      text        not null,
  -- Spaced by ten so a block can be dropped between two others without
  -- renumbering the column.
  sort       integer     not null default 0,
  created_at timestamptz not null default now(),
  created_by text
);

create index if not exists dashboard_groups_order_idx on public.dashboard_groups (sort, id);

-- Zero policies, like every other table. See 009 for what happens when this
-- line is forgotten.
alter table public.dashboard_groups enable row level security;

-- The blocks the dashboard starts with. Apps first: the team's own tools are
-- what somebody opens this page to reach, and it is the block a card with no
-- group of its own falls into.
--
-- The rest split the outbound shortcuts by subject rather than lumping them
-- under one "Shortcuts" heading. Sparse today, with three of the four holding
-- one or two cards. That is the intended trade: the point of managing links
-- from /admin is that there will be more of them, and a heading somebody can
-- file a new link *under* is what stops the twentieth one landing at the bottom
-- of an undifferentiated list.
insert into public.dashboard_groups (id, label, sort) values
  ('apps',        'Apps',        10),
  ('electronics', 'Electronics', 20),
  ('design',      'Design',      30),
  ('documents',   'Documents',   40),
  ('reference',   'Reference',   50),
  -- Last, and last on purpose: finished or superseded, still worth looking
  -- things up in, out of the way of what is in use now.
  ('archive',     'Archive',     60)
on conflict (id) do nothing;
