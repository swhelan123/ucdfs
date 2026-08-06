-- 006: sections are data, not code.
--
-- 005 made the plan graph multi-plan but left the *sections* (the labelled
-- boxes tasks sit in) defined in the PLANS registry in main.py, with
-- pt_sections holding nothing but a size override. That made a new plan's
-- layout a code change and a deploy, which is exactly the thing a subteam
-- wanting their own flowchart cannot do for themselves.
--
-- Now pt_sections is the whole truth: label, position and size, created and
-- moved from the canvas like anything else. PLANS keeps only the plan's name
-- and stays the whitelist of which plan ids may exist.
--
-- Four steps, in this order, and the order matters: seed the legacy plan,
-- complete any half-populated row, adopt any section that exists only because
-- a task still points at it, and only then declare the label mandatory.

alter table public.pt_sections add column if not exists label text;
alter table public.pt_sections add column if not exists x     double precision;
alter table public.pt_sections add column if not exists y     double precision;


-- 1. The legacy PT plan's seven sections were only ever in Python. Write them
-- in at exactly the geometry the old hardcoded layout computed. Get this
-- wrong and the 25/26 plan opens with its tasks scattered outside their boxes,
-- so these are derived, not eyeballed:
--
--   w = cols * 150 + 48      (CW=150, SP=24 each side)
--   h = rows *  95 + 48      (CH=95)
--   y = 1066 - h             (SBOT=1066: every box's bottom was pinned there)
--   x = running sum, 48 + Σ(previous w + 52)   (SG=52 gap)
--
-- A row already here is a size someone dragged. Those win: keep the larger of
-- the two and re-derive y from it, because the old canvas grew a box upward
-- from that same fixed bottom edge. The coalesce is belt and braces: Postgres
-- greatest() ignores nulls rather than propagating them, unlike most dialects,
-- and this is not the file to make a reader look that up.
insert into public.pt_sections (plan_id, sec, label, x, y, w, h) values
  ('pt', 'lv',   'Low Voltage Wiring',   48, 1066 - 998, 498, 998),
  ('pt', 'tdp',  '3D Prints',           598, 1066 - 333, 648, 333),
  ('pt', 'tsac', 'TSAC Assembly',      1298, 1066 - 808, 798, 808),
  ('pt', 'cc',   'Charging Cart',      2148, 1066 - 428, 498, 428),
  ('pt', 'bp',   'Back Packaging',     2698, 1066 - 523, 948, 523),
  ('pt', 'sw',   'Software',           3698, 1066 - 333, 648, 333),
  ('pt', 'hv',   'HV Wiring',          4398, 1066 - 523, 798, 523)
on conflict (plan_id, sec) do update set
  label = excluded.label,
  x     = excluded.x,
  w     = greatest(coalesce(pt_sections.w, 0), excluded.w),
  h     = greatest(coalesce(pt_sections.h, 0), excluded.h),
  y     = 1066 - greatest(coalesce(pt_sections.h, 0), excluded.h);


-- 2. Rows for any *other* plan can only have come from someone resizing a
-- registry-defined section before this migration: an id and a size, nothing
-- else. Give them a label and somewhere to stand rather than dropping them: a
-- deleted box takes its tasks' home with it, and these are trivially draggable.
-- The 550 step is the default width plus the gap, so defaults land side by
-- side; a hand-dragged width may overlap its neighbour slightly.
with stragglers as (
  select plan_id, sec,
         coalesce(w, 498) as w2,
         coalesce(h, 523) as h2,
         row_number() over (partition by plan_id order by sec) as n
  from public.pt_sections
  where x is null or y is null or label is null
)
update public.pt_sections s set
  label = coalesce(s.label, st.sec),
  w     = st.w2,
  h     = st.h2,
  x     = coalesce(s.x, 48 + (st.n - 1) * 550),
  y     = coalesce(s.y, 1066 - st.h2)
from stragglers st
where s.plan_id = st.plan_id and s.sec = st.sec;


-- 3. A section the registry used to supply, that nobody ever resized, has no
-- row at all, but tasks still name it. Without this they would load into a
-- plan with no box to sit in: still on the canvas, still counted, but outside
-- everything and impossible to tidy, since the app only ever deletes an empty
-- section. Draw the box around where those tasks already are, so nothing
-- appears to move. A task is 128 wide by 48 tall and is positioned by its
-- centre, hence the 88/72 margins.
with orphan as (
  select n.plan_id, n.sec,
         min(n.x) as minx, max(n.x) as maxx,
         min(n.y) as miny, max(n.y) as maxy
  from public.pt_nodes n
  left join public.pt_sections s on s.plan_id = n.plan_id and s.sec = n.sec
  where s.sec is null
  group by n.plan_id, n.sec
)
insert into public.pt_sections (plan_id, sec, label, x, y, w, h)
select plan_id, sec, sec,
       coalesce(minx, 48)  - 88,
       coalesce(miny, 543) - 72,
       greatest(200, coalesce(maxx - minx, 0) + 176),
       greatest(150, coalesce(maxy - miny, 0) + 144)
from orphan
on conflict (plan_id, sec) do nothing;


-- 4. An unlabelled box is confusing rather than broken, but after the three
-- statements above there should be none, so say so out loud.
alter table public.pt_sections alter column label set not null;
