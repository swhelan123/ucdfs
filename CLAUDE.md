# CLAUDE.md

Internal tools site for UCD Formula Student. FastAPI + Supabase, server-rendered
static pages, no build step and no frontend framework.

Roadmap and design reasoning live in [TODO.md](TODO.md). Read it before starting
a new feature — it records *why* things are the way they are, which matters more
than the task list.

## Run it

```bash
docker compose up -d --build     # live, port 3978
./tests/run.sh                   # tests, throwaway container on 3979
```

Secrets are in `.env` (gitignored; `.env.example` is the template). There is no
local Python environment — `python3` here has no FastAPI and `venv` is
unavailable, so **everything runs in Docker**.

## Layout

```
main.py               all backend: routes, auth, applet registry, Supabase access
static/
  shared.css          design system — tokens + components for card-based pages
  shared.js           UCDFS runtime — identity, applet registry, toast helpers
  dashboard.html      the homepage, at /
  login.html          the sign-in screen
  attendance.html     card-based applet
  comp.html           card-based applet
  pt.html             full-screen canvas tool
  harness.html        full-screen canvas tool
migrations/           SQL, applied by hand in the Supabase SQL editor
tests/                see tests/README.md
```

## Two page families

**Card pages** (dashboard, login, attendance, comp) load `shared.css` and use its
components. Their own `<style>` block holds page-specific rules only, and sets
`--page-max` for content width.

**Canvas tools** (pt, harness) are full-screen editors with a deliberately
different visual language (`--ink`, `--mfg`, a fixed 52px `#hdr`). They share
`shared.js` for identity but **not** `shared.css`. Do not try to fold them into
the card system — it would be a rewrite, not a refactor.

When adding to a card page, check `shared.css` first. If a component is needed
twice, it belongs there, not duplicated.

## The applet registry

`APPLETS` in `main.py` is the single source of truth for what exists on the site.
It generates the page routes *and* feeds `/api/applets`, which the dashboard
renders. **Adding an applet is one entry plus one file in `static/` — never edit
the dashboard to add a tool.**

```python
{"id": "inventory", "name": "Inventory", "icon": "📦",
 "route": "/inventory", "file": "inventory.html",
 "blurb": "…", "accent": "teal", "status": "live"}
```

- `status`: `live` | `quiet` (dimmed, off-season) | `soon` (placeholder, not clickable)
- `accent`: a colour token from `shared.css`
- `external: True` with a URL in `route` for off-site links (e.g. the Canva mech plan)

Current ids: `attendance`, `pt`, `harness`, `comp`, `mech`.

## Auth and data access

The browser **never** talks to Supabase. Every request goes to FastAPI, which
holds the `service_role` key and does its own authorization. This is load-bearing:

- **RLS is enabled on all 14 tables with zero policies.** That is the intended end
  state, not an oversight. `anon` gets nothing; `service_role` bypasses RLS. Do
  not add policies to "fix" it, and do not use the anon key for data access — it
  is only there for the GoTrue `apikey` header.
- Sign-in sets two cookies: `ucdfs_session` (httpOnly, the actual credential) and
  `ucdfs_profile` (readable, display data only). **The profile cookie is never an
  authorization input** — the server re-checks the session on every request. There
  is a test asserting a forged profile cookie grants nothing; keep it passing.
- `UCDFS.user()` in `shared.js` reads the profile cookie and is synchronous.
- Signup is gated to `ALLOWED_EMAIL_DOMAINS`. A disallowed domain is **403**
  (authorization refusal); a malformed address is **400**.
- Page routes redirect to `/login` when signed out; API routes return 401. Public
  paths are listed in `PUBLIC_EXACT`.
- `COMP_ADMIN_PASSWORD` still works alongside the `admin` role, as a deliberate
  fallback so admins can't be locked out mid-switchover. It is due for removal.

### Identity is a seam

Everything reads identity through `UCDFS.user()` rather than touching cookies or
localStorage directly. That is what let the whole site move from localStorage
names to real accounts without editing a single applet. Keep it that way.

`UCDFS.legacyName()` exists **only** for the sign-in screen, to greet returning
users by the name their browser remembers from before accounts. It is not an
identity and grants nothing.

## Conventions

- **No frontend framework, no build step.** Plain HTML/CSS/JS served as files.
  Keep it that way; it's why this is maintainable by whoever inherits it.
- Match the surrounding style. `shared.js` is ES5-ish IIFE; page scripts are
  looser. Don't modernise files you're only passing through.
- Comments explain *why*, not *what*. Several in here record bugs that cost real
  time — leave them.
- Server-side failures should degrade, not blank the page. `/api/dashboard`
  computes each tile independently so one failing table nulls one tile.
- **Anything with a wall clock uses `TEAM_TZ`** (Europe/Dublin), not
  `datetime.now()`. The container runs on UTC, so a naive call is an hour out
  all summer — enough to show someone as gone while they're still in the
  workshop. `COMP_TZ` is Europe/London and is a different thing: where the
  competition physically is.

## The activity feed

The dashboard feed reads two sources, merged newest-first:

- `pt_done_log` — the PT plan's own audit log, which predates the feed and is
  still what `pt.html` reads. Already the right shape, so it's adapted rather
  than duplicated.
- `activity_log` — the general table (`migrations/002`) everything else writes
  to via `log_activity(applet, actor, verb, subject)`.

**New applets call `log_activity()`; they don't invent their own log.** It is
best-effort and never raises — a feed write must not fail the action it
describes, and the table doesn't exist until 002 is applied by hand.

Subjects are stored as text captured at write time, not as a foreign key, so a
line still reads correctly after the thing it names is renamed or deleted.
Attendance deliberately does not write to it: twenty people logging a day each
morning would bury everything else, and the "who's in now" bar covers it.

## The harness parts library

`connParts()` in `harness.html` has one invariant: **every connector returns at
least one BOM line.** A BOM that silently omits a connector is worse than one
that admits a gap — you find out when the box arrives with wire and nothing to
crimp it into. When a part number can't be derived, emit the line with an empty
`pn` (rendered `(specify)`); the Parts rule check then lists it. Never return an
empty array, and never invent a part number to fill the hole.

Contacts carry an `awg: [thickest, thinnest]` crimp range. The Contacts rule
check reads it, so adding a part extends the rule check for free.

Deutsch **DT and DTM are different series** — different housings, different
wedgelock, size-16 vs size-20 contacts. They are separate entries in `DEUTSCH`
for a reason; collapsing them orders parts that don't fit.

## The season calendar

`FSUK_DATE` / `FSUK_NAME` / `SEASON_MILESTONES` near the top of `main.py` are the
only inputs to the dashboard countdown — changing the date there is the whole
job. `FSUK_PROVISIONAL` makes the card say so out loud; clear it once IMechE
publish the real dates.

## Working on this safely

- **Never restart or rebuild the container on :3978 without asking.** It is in
  daily use by the team. Test on :3979 instead.
- **Migrations are applied by hand** in the Supabase SQL editor, in order, and
  the ordering matters — enabling RLS before the app has the service key takes
  the live site down. Check what is already applied before suggesting a re-run.
- Test accounts must use the `ucdfs-test-` prefix so cleanup can find them.
- Run `./tests/run.sh` before saying something works. The suite is fast and has
  caught real bugs that looked fine by inspection.

## Deployment

Single container, rebuilt in place:

```bash
docker compose up -d --build
```

`Dockerfile` copies `main.py` and `static/`, so new static files ship
automatically. Static assets are served from `/static` via `StaticFiles`.
