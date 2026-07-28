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
  profiles.html       card-based applet — the team directory
  admin.html          card-based applet — roles + god mode (requires_role: admin)
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
 "blurb": "…", "accent": "teal", "status": "live",
 "subteams": ["mech"]}
```

- `status`: `live` | `quiet` (dimmed, off-season) | `soon` (placeholder, not clickable)
- `accent`: a colour token from `shared.css`
- `external: True` with a URL in `route` for off-site links (e.g. the Canva mech plan)
- `subteams`: ids from `SUBTEAMS`, or `["all"]`. Drives the dashboard filter
  chips and nothing else — see "Subteams" below. Omitting it means everyone.
- `requires_role`: the permission field. `_may_open()` enforces it on both the
  page route and `/api/applets`, so a gated entry can never be visible on the
  dashboard but closed on click. Omitting it means everyone.

Current ids: `attendance`, `profiles`, `pt`, `harness`, `comp`, `mech`, `admin`.

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
- `COMP_ADMIN_PASSWORD` is **gone**. Committee actions need the `committee`
  role or god mode, and roles are handed out from `/admin` — there is a way to
  grant access now that isn't a password everyone knows and nobody can revoke.

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

## Roles, permissions and god mode

Three things that look similar and are not:

| | what it is | enforced |
|---|---|---|
| `subteams` (registry) | relevance — what you see first | never; presentational |
| `requires_role` (registry) | permission — what you may open | `_may_open()`, page route + `/api/applets` |
| `profile_details.role_label` | what you call yourself on your profile | never; a display string |
| `profiles.role` | the real permission: member / committee / admin | `require_role()` |
| `profiles.god_mode` | is this admin currently elevated | `god_on()` |

**`role` is the capability, `god_mode` is the switch** (`migrations/004`). An
admin who is permanently elevated cannot see what the team sees, and every
accidental click lands on someone else's data — so god mode is something you
turn on, and `shared.js` draws a banner on every page while it is.

**The site calls it "Admin override".** `god_mode` is the name in the code, the
schema and these docs; the team sees a phrase that describes what it does. Don't
rename the column to match the label.

Elevated, you can edit anyone's profile, remove anyone's photo, and write or
delete anyone's attendance row. Each of those is a **separate endpoint** rather
than an `id` parameter on the ordinary one — `/api/admin/profile` beside
`/api/profile`, so the self-service route cannot express "edit someone else" at
all and every privileged write is one grep away.

Two traps in that shared write path, both with tests: **never rewrite your own
profile cookie with the target's row** (your browser starts displaying you as
the person you just edited), and credit the activity-feed line to whose profile
it is rather than to whoever typed it.

Two rules that keep it recoverable, both with tests:

- **`require_role()` lets god mode through; `require_admin()` does not.** The
  god-mode toggle itself uses `require_admin`, so an admin who switches off can
  always switch back on. Gate that endpoint on god mode and it becomes a
  one-way door out of your own admin rights.
- **`/admin` is gated on the role, not on elevation** — for the same reason.
  Turning god mode off must not hide the page holding the switch.
- Demoting an admin clears `god_mode` too, or the flag lies dormant and
  reactivates the moment somebody re-promotes them. The last admin cannot be
  demoted at all: locking everyone out is unrecoverable from inside the app.

`god_mode` rides in the profile cookie for the banner only. Like `role` and
`subteam` before it, forging it draws UI and grants nothing — every gate reads
the database row the middleware already loaded.

### shared.js must carry its own CSS

Anything `shared.js` injects into the page — the override banner, the
first-sign-in overlay — is styled from a `<style id="ucdfs-runtime-css">` block
inside that file, **not** from `shared.css`. The canvas tools (pt, harness) load
`shared.js` and deliberately not `shared.css`, so a rule that lives only in the
stylesheet renders as raw unstyled markup on exactly the two pages nobody thinks
to check. Colours are written `var(--token, literal)` so they pick up the design
system on a card page and still look right without it.

### Hiding a control is not a permission

`/api/log` and `/api/log/delete` took a name from the request body and wrote it.
The attendance page only drew edit buttons on your own row, so it *looked*
enforced — but any signed-in member could delete anybody's day with one fetch.
`_require_own_row()` now checks server-side, case-folded and
whitespace-collapsed (those rows predate accounts and were typed by hand), with
god mode as the only override.

## Subteams

`SUBTEAMS` in `main.py` (Powertrain / Mechanical / Operations) is the vocabulary
for the whole site: the registry's `subteams` tags, the dashboard filter chips,
the first-sign-in picker and the profiles directory all read it, so the names and
colours cannot drift apart.

Two rules, both load-bearing:

- **Tags are relevance; roles are permission.** `subteams` is soft, cosmetic and
  user-facing. `requires_role` (still to be added) is server-enforced. An
  Operations member must still be able to open the PT plan — it just isn't the
  first thing they see. Conflating them locks someone out of something they need
  at 2am before a deadline. `tests/suite-profiles.js` asserts this.
- **Filter, never hide.** `all`-tagged applets show under every chip, clearing
  the filter always restores everything, and an applet with no `subteams` field
  defaults to visible rather than vanishing. A filter that permanently hides
  something is worse than no filter.

A person's subteam may be **null** — "not sure yet" is a real answer during
September recruitment, not a gap. `profile_details.onboarded_at` records that we
asked, so nobody is asked twice. The subteam rides in the profile cookie purely
so `UCDFS.user()` can stay synchronous; like everything else in that cookie it
is never an authorization input.

## Team profiles

The directory (`migrations/003`): `profile_details` extends `profiles` 1:1, and
`profile_prompts` holds up to three answers each. `profiles` is loaded by the
auth middleware on *every* request, which is why the detail columns live in their
own table rather than widening the hot row.

- **Prompts are picked, not written.** Free-text "write a bio" fields produce
  empty profiles. `PROMPTS` in `main.py` is free text in the database on purpose:
  adding one is a one-line change with no migration, and retiring one never
  deletes anybody's answer.
- **Tags are the reason it still matters in November.** Lowercased and
  de-duplicated on write, or "CAN bus" and "can bus" become two chips for one
  skill and the directory stops being searchable.
- `profile_details.role_label` is **not** `profiles.role`. One is what you call
  yourself, the other is a permission. Merging them would mean editing your own
  profile could grant you access.
- **Roles carry a `scope`.** Captain / Vice captain / Team member belong to a
  division; **Team Principal and Technical Director do not** — they sit across
  all three, so a team-wide role hides the division picker entirely and their
  card leads with the role rather than a subteam badge. `role_rank` orders the
  directory so it reads as a team rather than an alphabet.
- `YEARS` carries `value` + `label`, and the API sends `year_label` alongside
  `year` so no page has to know that `Alum` reads as "Retired member". There is
  no PhD option — nobody on the team is one.
- `POST /api/profile` takes **no id** and writes only the caller's row. Keep it
  that way — an id parameter would need an authorization check nothing else in
  the file needs.

### Photos are on this machine's disk

Not Supabase Storage. They live under `UPLOAD_DIR` (`/app/uploads`), which
`docker-compose.yml` mounts from `./data/uploads` — **the mount is required**,
since the image is rebuilt in place and anything unmounted dies with the
container.

Deliberately **not** under `static/`: the Dockerfile copies that directory into
the image, so photos there would be wiped on deploy *and* served by `StaticFiles`
to anyone with the URL. They go out through `GET /media/avatars/{file}`, which
sits behind the auth middleware — that is what makes profiles members-only for
free. The public sponsor page, when it lands, gets its own route that checks
`is_public`.

You crop before uploading: a square canvas you drag and zoom, rendered to 512px
and posted as a base64 data URL in JSON. Doing it client-side is what avoids both
an image library in the container and `python-multipart` in requirements for a
40 KB payload. The stored type is sniffed from the bytes, never from the declared
content type. URLs carry `?v=photo_rev` because photos overwrite in place —
without it the browser keeps showing the old one.

**The photo URL is in the profile cookie, and that cookie must stay
percent-encoded** (`quote(..., safe="")`). A `/` is not a legal raw cookie
character, so leaving it unencoded makes Starlette wrap the whole value in
quotes; `JSON.parse` then reads it as a string, `UCDFS.user()` returns null, and
every page decides you are signed out the moment you upload a photo. `readCookie`
in `shared.js` strips surrounding quotes as a second line of defence, and
`suite-profiles` asserts both.

Faces reach three places, by two different routes. Your own comes from the
cookie, so `renderPill()` stays synchronous. Everyone else's comes from
`GET /api/people/photos`, a name-keyed map — attendance and the nowbar identify
people by the name they typed, which predates accounts, and `UCDFS.avatar()`
falls back to initials for any name it can't match.

## The harness topology model

`harness.html` holds two models, and keeping them apart is load-bearing:

- **Electrical** — wires between *pins*. What is connected to what.
- **Physical** — `nodes` and `segments`. What runs where. A wire gains
  `route: [segmentId]` and then travels *through* segments instead of flying
  point-to-point.

**A routed wire's length is derived**: `wireLenMm()` sums its segments, so
changing one branch updates every wire through it. Read length through that
accessor, never `w.length` directly — the raw field is only the manual override,
pinned by `w.lenManual` when someone types a measured value. Hand-typed lengths
drift the moment routing changes, and that is the usual cause of a wrong cut list.

Segment endpoints anchor to a connector *body*, a splice or a breakout node —
never a pin. A **breakout node is not a splice**: nothing is electrically joined
there, the run just divides. Conflating them invents phantom nets.

Everything else falls out of the segment graph: bundle diameter from the wires
actually inside it, dimensions annotating a real length, and (next) clips at a
distance along a run.

Unrouted wires keep the old point-to-point behaviour exactly, so documents saved
before any of this load unchanged. If you change routing, call `redrawAllWires()`
— `refreshFormboard()` alone redraws the casings but leaves the wires where they
were.

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
