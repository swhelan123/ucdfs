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

-- ── Moving the cards 010 seeded into these blocks ────────────────────────────
--
-- 010 shipped before this file existed and put every shortcut in one block
-- called 'tools'. It has since been applied, so it is a snapshot of what ran
-- and is not editable: the work of re-filing those cards belongs here.
--
-- 'tools' is not seeded above, deliberately. It was never a subject, it was
-- "the main grid", which is what the *first* block is now. Anything still
-- pointing at it after this file has run is a card added by hand in the gap,
-- and _card_group() draws it under the first heading rather than nowhere.
--
-- Wrapped in a guard so this file does not care whether 010 has run yet. A bare
-- `update public.links` against a database without that table is an error, and
-- an error here would abandon the blocks this file exists to create, leaving a
-- half-applied migration whose failure has nothing to do with what it is for.
do $$
begin
  if to_regclass('public.links') is null then
    raise notice '010 not applied yet; blocks created, links left for it to seed';
    return;
  end if;

  -- Guarded on group_id = 'tools' so this only moves cards still where 010 left
  -- them. An admin who has already re-filed one from /admin keeps their choice,
  -- and the file stays re-runnable.
  update public.links set group_id = 'electronics' where group_id = 'tools' and id in ('vcu', 'harnesshive');
  update public.links set group_id = 'design'      where group_id = 'tools' and id = 'onshape';
  update public.links set group_id = 'documents'   where group_id = 'tools' and id = 'sharepoint';
  update public.links set group_id = 'reference'   where group_id = 'tools' and id in ('fsstats', 'fswiki', 'fsae-reddit');

  -- Sort is per block, and they arrived numbered 10..70 across a single one.
  -- Renumber within each so the up and down buttons in /admin start from
  -- something sane rather than from gaps that only made sense in one block.
  update public.links set sort = 10 where id in ('vcu', 'onshape', 'sharepoint', 'fsstats');
  update public.links set sort = 20 where id in ('harnesshive', 'fswiki');
  update public.links set sort = 30 where id = 'fsae-reddit';

  -- Anything added between 010 and this file, and anything added later, belongs
  -- in the first block rather than in a name that no longer means anything.
  execute 'alter table public.links alter column group_id set default ''apps''';
  update public.links set group_id = 'apps' where group_id = 'tools';
end $$;
