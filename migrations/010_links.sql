-- 010: hyperlink cards are data.
--
-- The same move 005 → 006 → 007 made for charts, applied to the one part of
-- the applet registry that was never code in the first place.
--
-- APPLETS holds two different kinds of thing wearing one shape. An internal
-- applet carries a "file" and *generates its own page route* at import, so a
-- row naming a page the image does not contain is a 404 tile: adding one is a
-- deploy no matter what any admin screen pretends. An external card generates
-- nothing. It is a name, an emoji and a url. Pure content, and content that
-- kept arriving: the VCU repo, last season's Canva plan, then Onshape,
-- SharePoint, HarnessHive, then FS Stats, FSWiki and r/FSAE. Seven deploys to
-- add seven hyperlinks, each one a pull request that could only be opened by
-- somebody with a checkout.
--
-- So external cards move here and internal applets stay in code, which is the
-- line that actually holds rather than the one that is easiest to describe.
--
-- The whitelist property carries over from the chart work, because the same
-- risk does. A url from this table is rendered straight into an href, so the
-- scheme is checked on write: http and https only, or a stored "javascript:"
-- url is a script that runs on every dashboard in the team. Accent, group,
-- status and subteam ids are checked against the same vocabularies the
-- registry uses, so a typo cannot produce an invisible card or an orphan block.
-- None of that is enforced here as a constraint: it is enforced in _clean_link()
-- on the way in, in one place, next to the rules it is checking.

create table if not exists public.links (
  -- Not a serial. The seeded rows keep the ids they had as registry entries so
  -- that favourites, which store card ids, survive the move: somebody who has
  -- starred the VCU repo still has it starred afterwards. Ids for rows created
  -- through the admin screen are minted server-side (link_…), like chart_… and
  -- sec_…, so a caller cannot name a row into existence by asking for it.
  id         text        primary key,
  name       text        not null,
  icon       text        not null default '🔗',
  url        text        not null,
  blurb      text        not null default '',
  -- A colour token from shared.css, not a colour. The dashboard maps these to
  -- CSS variables and falls back to indigo for anything it does not recognise.
  accent     text        not null default 'indigo',
  -- live | quiet. There is no "soon": a placeholder that cannot be clicked
  -- makes sense for a tool being built and none at all for a hyperlink, which
  -- either exists or does not.
  status     text        not null default 'live',
  -- Subteam ids, or ["all"]. Relevance, never permission: this drives the
  -- dashboard filter chips and nothing else, and an empty array reads as "all"
  -- rather than hiding the card from everybody.
  subteams   text[]      not null default '{all}',
  -- Which dashboard block. Ids come from APPLET_GROUPS. Named group_id and not
  -- "group" because group is a reserved word in SQL and every reference to it
  -- would need quoting forever after.
  group_id   text        not null default 'tools',
  -- Order within the block. Spaced by ten so a card can be dropped between two
  -- others without renumbering the column.
  sort       integer     not null default 0,
  created_at timestamptz not null default now(),
  -- The name that was typed, captured at write time, like activity subjects
  -- and plans.created_by: it still reads correctly after that account is gone.
  created_by text
);

create index if not exists links_order_idx on public.links (group_id, sort, id);

-- Zero policies, like every other table. anon gets nothing, service_role
-- bypasses RLS, FastAPI does the authorization. See 009 for what happens when
-- this line is forgotten.
alter table public.links enable row level security;

-- ── The cards that were registry entries ─────────────────────────────────────
--
-- Ids preserved exactly, or every favourite pointing at one of these would be
-- filtered out as unknown on the next dashboard load and quietly disappear.
--
-- Sort values reproduce the order they had in APPLETS. vcu and harnesshive stay
-- adjacent: both are the electronics side of Powertrain, and someone tracing a
-- signal usually wants the firmware and the harness drawing open together.
insert into public.links (id, name, icon, url, blurb, accent, status, subteams, group_id, sort) values
  ('vcu',         'VCU Firmware', '🧠',
   'https://github.com/UCDFS/TEENSY',
   'Vehicle control unit code for the Teensy 4.1 (GitHub)',
   'indigo', 'live', '{pt}',        'tools',   10),

  ('harnesshive', 'HarnessHive',  '🐝',
   'https://app.harnesshive.com/',
   'Harness design and documentation (HarnessHive)',
   'teal',   'live', '{pt}',        'tools',   20),

  ('onshape',     'Onshape',      '📐',
   'https://ucdformula.onshape.com',
   'Every assembly, part and drawing (Onshape)',
   'green',  'live', '{mech,pt}',   'tools',   30),

  ('sharepoint',  'SharePoint',   '🗂️',
   'https://ucd.sharepoint.com/sites/UCDFS214/',
   'Shared team documents and files (SharePoint)',
   'purple', 'live', '{all}',       'tools',   40),

  -- ── Outside reference, new here ────────────────────────────────────────────
  -- Tagged all: none of these is any one subteam's, and the chips are
  -- relevance rather than permission.
  ('fsstats',     'FS Stats',     '📊',
   'https://www.fsstats.co.uk/team/2030',
   'Event results and scoring history (FS Stats)',
   'amber',  'live', '{all}',       'tools',   50),

  ('fswiki',      'FSWiki',       '📚',
   'https://fswiki.us/Fswiki',
   'Design writeups and reference from other teams (FSWiki)',
   'indigo', 'live', '{all}',       'tools',   60),

  ('fsae-reddit', 'r/FSAE',       '💬',
   'https://www.reddit.com/r/FSAE/',
   'Questions, builds and post-mortems (Reddit)',
   'red',    'live', '{all}',       'tools',   70),

  -- Last season's chassis build. Archived rather than deleted for the same
  -- reason the PT plan is: finished, not broken, still looked up.
  ('mech',        'Mech Manufacturing Plan', '⚙️',
   'https://www.canva.com/design/DAHFgTx32zs/IXAWyUJbm15DIqgdsbRkTg/edit',
   'Last season''s chassis build, 25/26, on Canva',
   'green',  'quiet', '{mech}',     'archive', 10)
on conflict (id) do nothing;
