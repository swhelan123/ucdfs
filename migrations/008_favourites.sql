-- 008: favourite tools.
--
-- Which cards someone wants at the top of their dashboard. A text[] of applet
-- ids on profile_details, which is where per-person detail already lives,
-- profiles is loaded by the auth middleware on every single request, so this
-- does not belong on that row.
--
-- Stored against the account rather than in localStorage, unlike the subteam
-- filter and the flowchart tour. Those two are per-browser preferences: which
-- chip you last tapped on this laptop, whether this browser has seen the tour.
-- Favourites are not that. They are "these are the tools I use", and somebody
-- who sets them on the workshop PC should find them on their phone. Getting it
-- wrong the other way is a feature that quietly forgets you.
--
-- Ids, not foreign keys: APPLETS is a Python list, not a table, and a card that
-- is retired should not require a migration to clean up after. An id naming
-- nothing is skipped when the dashboard renders, and the write path checks
-- against the live registry so junk cannot accumulate in the first place.

alter table public.profile_details
  add column if not exists favourites text[] not null default '{}';
