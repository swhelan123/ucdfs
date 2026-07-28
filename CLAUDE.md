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
