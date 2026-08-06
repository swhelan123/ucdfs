# CLAUDE.md

Internal tools site for UCD Formula Student. FastAPI + Supabase, server-rendered
static pages, no build step and no frontend framework.

Roadmap and design reasoning live in [TODO.md](TODO.md). Read it before starting
a new feature. It records *why* things are the way they are, which matters more
than the task list.

## Run it

```bash
./deploy.sh dev                  # your working tree, :3980, non-prod database
./tests/run.sh                   # tests, throwaway container on :3979
./deploy.sh rollback             # what prod is on, and what it could go back to
```

Never `docker compose up` by hand. `deploy.sh` is what decides which database a
tier talks to, and it refuses the combinations that would point dev or stage at
production. See "Environments" below.

There is no local Python environment. `python3` here has no FastAPI and `venv`
is unavailable, so **everything runs in Docker**.

## Layout

```
main.py               all backend: routes, auth, applet registry, Supabase access
static/
  shared.css          design system: tokens + components for card-based pages
  shared.js           UCDFS runtime: identity, applet registry, toast helpers
  dashboard.html      the homepage, at /
  login.html          the sign-in screen
  attendance.html     card-based applet
  comp.html           card-based applet
  profiles.html       card-based applet: the team directory
  flowcharts.html     card-based applet: the chart picker, at /flowcharts
  admin.html          card-based applet: roles, god mode, deleting accounts
                      (requires_role: admin)
  pt.html             full-screen canvas tool: draws any one chart, at /plan/<id>
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
the card system. It would be a rewrite, not a refactor.

When adding to a card page, check `shared.css` first. If a component is needed
twice, it belongs there, not duplicated.

## The applet registry

`APPLETS` in `main.py` is the single source of truth for what exists on the site.
It generates the page routes *and* feeds `/api/applets`, which the dashboard
renders. **Adding an applet is one entry plus one file in `static/`. Never edit
the dashboard to add a tool.**

```python
{"id": "inventory", "name": "Inventory", "icon": "📦",
 "route": "/inventory", "file": "inventory.html",
 "blurb": "…", "accent": "teal", "status": "live",
 "subteams": ["mech"]}
```

- `status`: `live` | `quiet` (dimmed, off-season) | `soon` (placeholder, not clickable)
- `accent`: a colour token from `shared.css`
- `external: True` with a URL in `route` for off-site links: the VCU firmware
  repo on GitHub, last season's Canva mech plan. These open in a new tab with
  `rel="noopener"`; there is a test that every `_blank` card carries it.
- `subteams`: ids from `SUBTEAMS`, or `["all"]`. Drives the dashboard filter
  chips and nothing else. See "Subteams" below. Omitting it means everyone.
- `requires_role`: the permission field. `_may_open()` enforces it on both the
  page route and `/api/applets`, so a gated entry can never be visible on the
  dashboard but closed on click. Omitting it means everyone.
- `plan`: for a card that opens one specific chart: which chart. Only last
  season's plans use it now; the feed reads it to badge their ticks.
- `group`: which dashboard block the card sits in. Ids come from
  `APPLET_GROUPS`; omitting it means the main `tools` grid. See "Dashboard
  layout" below.

Current ids: `attendance`, `profiles`, `flowcharts`, `harness`, `vcu`, `comp`,
`admin`, and under `archive`: `pt`, `mech`.

## Dashboard layout

`APPLET_GROUPS` in `main.py` is the list of blocks and their headings, sent to
the dashboard with the cards. Cards carry a `group`; a card without one lands in
`tools`, so an entry that forgets to say goes where people are already looking
rather than into an archive nobody scrolls to.

A block with nothing in it **renders nothing, heading included**. A heading over
empty space reads as a page that failed to load, and the subteam filter can
easily empty a block. `tests/suite-pages.js` covers the dashboard drawing clean;
the grouping logic is `render()` in `dashboard.html`.

`UCDFS.applets()`, `UCDFS.appletGroups()` and `UCDFS.favourites()` share one
cached `/api/applets` response, so asking for all three is still a single
request.

### Favourites

A starred card is **copied** to a **Favourites** block at the top of the
dashboard and stays where it lives. Pinning something must not change the shape
of the site underneath you. Favourites is a shortcut, not somewhere cards
disappear to.

The block **keeps its heading when empty** and shows "nothing pinned yet"
instead. This is the one exception to the rule that an empty block renders
nothing: that empty state is the only thing on the page that says the star
exists, so collapsing it would hide the feature from exactly the people who have
not found it yet.

It is also **not filtered by the subteam chips**. You pinned these deliberately,
and a chip hiding your own shortcuts would be the single place on this page where
filtering costs you something. It keeps the empty state honest too: "nothing
pinned" then means that, rather than "nothing pinned that is also Operations".
Order is the order you starred them in, which is the only order anyone could
predict.

- **Stored per account** (`profile_details.favourites`, `migrations/008`), not
  in localStorage. That is the opposite call to the subteam chip and the
  flowchart tour, and deliberately: those are per-browser preferences, whereas
  "these are my tools" should be the same on the workshop PC and on a phone.
- Ids are checked against the registry on the way **in and out**, so a retired
  card stops being a favourite instead of leaving a hole, and junk can never
  accumulate in the column. Starring a card you may not open is a 403 from
  `_may_open()` again, since it was never on your dashboard to star.
- The star is a **sibling of the card, never a child**. A `<button>` inside an
  `<a>` is invalid and browsers split the anchor around it, so each card is
  wrapped in `.applet-slot` and the hover lift lives on the slot.
- It is drawn faint rather than revealed on hover: half the team opens this on
  a phone, and a control that only exists on hover does not exist on a touch
  screen.
- Toggling paints first and saves second, then takes the server's list back:
  the server owns the order and the cap, so a second tab settles here. A
  rejected save puts the card back and says why.
- Deliberately **not** written to the activity feed. Which tools somebody likes
  is nobody else's business and would bury the things that are.

## Flowcharts

`pt.html` is one canvas and it draws whichever chart its URL names. **There is no
registry of charts**. They are rows in `plans` (`migrations/007`), made and named
from `/flowcharts`, which is the picker. Making a chart is something the team
does at runtime; it needs no code change, no migration and no deploy. That is the
whole point of 005 → 006 → 007, and it is how Mech get a real build plan.

- `/flowcharts` lists them, `/plan/<id>` opens one. `/pt` is the legacy alias for
  chart `pt`, kept because bookmarks and pre-multi-plan clients omit the chart
  entirely and must keep meaning the 25/26 plan.
- Every `pt_*` table carries a `plan_id` (`migrations/005`), default `'pt'`.
  Composite PKs: node ids are only unique within a chart.
- **The whitelist moved, it did not go.** A chart id reaches `supabase.table()`
  filters, so `_plan_or_400()` checks it against the `plans` table on every
  plan-scoped write and refuses an id that names nothing. Deliberately uncached:
  a stale whitelist presents as "the chart I just made does not exist".
- **Ids are minted server-side** (`chart_…`, like `sec_…` and `cust_…`) so a
  caller cannot name a row into existence by asking for it.
- Chart CRUD is **not role-gated**, on purpose. A chart is shared work like a
  task or a section, and adding and editing those is already open to any member;
  gating charts alone would put the friction on exactly the person we want
  drawing one. The rails are structural instead. See below. Contrast
  `/api/admin/*`, which is gated because it acts on *someone else's* data.
- **Archiving is the reversible action; deleting is refused unless the chart is
  empty.** There is no undo in this app, so the only chart `/api/plans/delete`
  will destroy is one with nothing in it. It also makes the caller echo the
  name back, the same rail as deleting an account, so a stale list cannot take
  out a chart someone has since renamed. `pt_done_log` survives a delete. It
  records what happened, not what exists.
- That endpoint **never deletes from `pt_nodes` or `pt_sections`**, and must not
  start: cascading them would make the emptiness check decoration and turn one
  click into a lost season. It checks emptiness **twice**, before and after
  sweeping the satellite tables, because there is no transaction across those
  calls: a task added mid-sweep would otherwise end up in a chart that no
  longer exists, which the whitelist then makes permanently unreachable.
- Because a chart can be deleted, `/plan/<id>` **404s** on an unknown id rather
  than serving a canvas that 400s on its first request. `PAGE_PREFIXES` covers
  `/plan/` so a signed-out bookmark redirects to sign-in instead of answering
  with JSON.
- The live-collab WebSocket is one room per chart, and the room name in the
  `join` message is checked the same way. Never relay across charts.
- `DASHBOARD_PLAN` in `main.py` picks which chart the dashboard's build tile
  counts. Point it at the new one at season rollover.
- The feed badges a tick with the card that opens its chart when one exists
  (`APPLET_BY_PLAN`) and with `flowcharts` otherwise.

### First-run tour

`pt.html` shows a five-step tour the first time and never again, with a `?` in
the header to bring it back. A tutorial you can only ever see once is one people
dismiss by accident and then cannot find. "Seen" is a versioned localStorage key:
it is a per-browser preference, not identity, so it needs no column and no round
trip, and the worst failure is showing somebody the tour twice. Its CSS lives in
`pt.html` for the same reason `shared.js` carries its own. This page does not
load `shared.css`.

### Sections are data, not code

`pt_sections` (`migrations/006`) holds label, position and size. They were
`cols`/`rows` definitions in code for exactly one release; moving them into the
table is what makes "Mech want their own flowchart" a thing Mech can do instead
of a deploy. 006 seeds the legacy plan's seven boxes at the geometry the old
hardcoded layout computed. Those numbers are derived in a comment there, not
eyeballed, because getting them wrong scatters the 25/26 tasks outside their
boxes.

- **Section ids are permanent; labels are free.** A task stores its section id,
  so ids are minted server-side (`sec_…`) and never taken from the client.
- **Deleting a section that still holds tasks is refused**
  (`/pt/api/sections/delete`). Cascading would leave tasks pointing at a box
  that no longer exists, invisible on the canvas, still in the graph, still
  counted by the dashboard tile, and nothing in the app puts them back.
- `/pt/api/sections` **updates**, it does not upsert. An id that does not exist
  has to be a no-op, or a stale client invents boxes nobody can find.
- **Moving a section moves its tasks.** They hold absolute canvas coordinates,
  not offsets within a box, so the drag carries them and persists the lot
  through `/pt/api/nodes/move-bulk`. Skip that and the box walks off alone.
- The canvas has no fixed size: `recomputeCanvas()` derives it from where the
  sections actually are, after every move, resize, add and delete.

## Auth and data access

The browser **never** talks to Supabase. Every request goes to FastAPI, which
holds the `service_role` key and does its own authorization. This is load-bearing:

- **RLS is enabled on all 14 tables with zero policies.** That is the intended end
  state, not an oversight. `anon` gets nothing; `service_role` bypasses RLS. Do
  not add policies to "fix" it, and do not use the anon key for data access. It
  is only there for the GoTrue `apikey` header.
- Sign-in sets two cookies: `ucdfs_session` (httpOnly, the actual credential) and
  `ucdfs_profile` (readable, display data only). **The profile cookie is never an
  authorization input**. The server re-checks the session on every request. There
  is a test asserting a forged profile cookie grants nothing; keep it passing.
- `UCDFS.user()` in `shared.js` reads the profile cookie and is synchronous.
- Signup is gated to `ALLOWED_EMAIL_DOMAINS`. A disallowed domain is **403**
  (authorization refusal); a malformed address is **400**.
- Page routes redirect to `/login` when signed out; API routes return 401. Public
  paths are listed in `PUBLIC_EXACT`.
- `COMP_ADMIN_PASSWORD` is **gone**. Committee actions need the `committee`
  role or god mode, and roles are handed out from `/admin`. There is a way to
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
  time, so leave them.
- Server-side failures should degrade, not blank the page. `/api/dashboard`
  computes each tile independently so one failing table nulls one tile.
- **Anything with a wall clock uses `TEAM_TZ`** (Europe/Dublin), not
  `datetime.now()`. The container runs on UTC, so a naive call is an hour out
  all summer, enough to show someone as gone while they're still in the
  workshop. `COMP_TZ` is Europe/London and is a different thing: where the
  competition physically is.

## The activity feed

The dashboard feed reads two sources, merged newest-first:

- `pt_done_log`: the PT plan's own audit log, which predates the feed and is
  still what `pt.html` reads. Already the right shape, so it's adapted rather
  than duplicated.
- `activity_log`: the general table (`migrations/002`) everything else writes
  to via `log_activity(applet, actor, verb, subject)`.

**New applets call `log_activity()`; they don't invent their own log.** It is
best-effort and never raises. A feed write must not fail the action it
describes, and the table doesn't exist until 002 is applied by hand.

Subjects are stored as text captured at write time, not as a foreign key, so a
line still reads correctly after the thing it names is renamed or deleted.
Attendance deliberately does not write to it: twenty people logging a day each
morning would bury everything else, and the "who's in now" bar covers it.

The feed is append-only in normal use, with **one exception**: an elevated admin
can delete a single line from the dashboard, through
`POST /api/admin/activity/delete` (`{source, id}`). Feed rows therefore carry an
`id` and a `source`. The feed is two merged tables, so neither identifies a row
on its own. `FEED_SOURCES` in `main.py` is a whitelist because that source name
reaches `supabase.table()`; an unknown value has to be a 400 by construction,
never "whatever the client sent". Deleting a `pt_done_log` line removes the
**record** of a tick, not the tick. `pt_done` is a different table and the
build plan is untouched. The deletion is not itself logged: a line saying a line
was deleted is noise at the top of the one place you were trying to clear.

## Roles, permissions and god mode

Three things that look similar and are not:

| | what it is | enforced |
|---|---|---|
| `subteams` (registry) | relevance: what you see first | never; presentational |
| `requires_role` (registry) | permission: what you may open | `_may_open()`, page route + `/api/applets` |
| `profile_details.role_label` | what you call yourself on your profile | never; a display string |
| `profiles.role` | the real permission: member / committee / admin | `require_role()` |
| `profiles.god_mode` | is this admin currently elevated | `god_on()` |

**`role` is the capability, `god_mode` is the switch** (`migrations/004`). An
admin who is permanently elevated cannot see what the team sees, and every
accidental click lands on someone else's data, so god mode is something you
turn on, and `shared.js` draws a banner on every page while it is.

**The site calls it "Admin override".** `god_mode` is the name in the code, the
schema and these docs; the team sees a phrase that describes what it does. Don't
rename the column to match the label.

Elevated, you can edit anyone's profile, remove anyone's photo, and write or
delete anyone's attendance row. Each of those is a **separate endpoint** rather
than an `id` parameter on the ordinary one: `/api/admin/profile` beside
`/api/profile`, so the self-service route cannot express "edit someone else" at
all and every privileged write is one grep away.

Two traps in that shared write path, both with tests: **never rewrite your own
profile cookie with the target's row** (your browser starts displaying you as
the person you just edited), and credit the activity-feed line to whose profile
it is rather than to whoever typed it.

### Deleting an account

`POST /api/admin/user/delete` is for the signup with the wrong email address,
a duplicate nothing can merge and demoting does not hide. It deletes the
**GoTrue user**, not the `profiles` row, and that ordering is the whole trick:
`profiles.id references auth.users(id) on delete cascade`, with
`profile_details` and `profile_prompts` cascading off `profiles` in turn.
Removing the profile row alone would leave the login, and `auth_login()`
re-creates a missing profile from the token's metadata. The account walks back
in at the next sign-in looking new. It is the only caller of `_gotrue_admin()`,
which sends the **service key**; everything else in the auth block acts as the
user and sends the anon key.

Four rails, all with tests, because nothing in the app can undo it: the override
must be **on**, you cannot delete **yourself**, an **admin** must be demoted
first (which keeps deletion behind the existing last-admin rail rather than
giving it a weaker one of its own), and the caller has to **echo back the email
address**, so a stale id from a list rendered a minute ago cannot take out the
wrong person. Deleting also drops that user's cached tokens
(`_cache_forget_user`), or a deleted account keeps loading pages for up to
`TOKEN_CACHE_TTL`, which reads as the delete not having worked.

Attendance rows, feed lines and `pt_done_log` entries **survive** deliberately.
They are keyed by the name that was typed, not by an account, and they record
what happened rather than who exists, the same rule that keeps activity
subjects as text. The feed's own delete is how you tidy those.

Two rules that keep it recoverable, both with tests:

- **`require_role()` lets god mode through; `require_admin()` does not.** The
  god-mode toggle itself uses `require_admin`, so an admin who switches off can
  always switch back on. Gate that endpoint on god mode and it becomes a
  one-way door out of your own admin rights.
- **`/admin` is gated on the role, not on elevation**, for the same reason.
  Turning god mode off must not hide the page holding the switch.
- Demoting an admin clears `god_mode` too, or the flag lies dormant and
  reactivates the moment somebody re-promotes them. The last admin cannot be
  demoted at all: locking everyone out is unrecoverable from inside the app.

`god_mode` rides in the profile cookie for the banner only. Like `role` and
`subteam` before it, forging it draws UI and grants nothing. Every gate reads
the database row the middleware already loaded.

### shared.js must carry its own CSS

Anything `shared.js` injects into the page (the override banner, the
first-sign-in overlay) is styled from a `<style id="ucdfs-runtime-css">` block
inside that file, **not** from `shared.css`. The canvas tools (pt, harness) load
`shared.js` and deliberately not `shared.css`, so a rule that lives only in the
stylesheet renders as raw unstyled markup on exactly the two pages nobody thinks
to check. Colours are written `var(--token, literal)` so they pick up the design
system on a card page and still look right without it.

### Hiding a control is not a permission

`/api/log` and `/api/log/delete` took a name from the request body and wrote it.
The attendance page only drew edit buttons on your own row, so it *looked*
enforced, but any signed-in member could delete anybody's day with one fetch.
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
  Operations member must still be able to open the PT plan. It just isn't the
  first thing they see. Conflating them locks someone out of something they need
  at 2am before a deadline. `tests/suite-profiles.js` asserts this.
- **Filter, never hide.** `all`-tagged applets show under every chip, clearing
  the filter always restores everything, and an applet with no `subteams` field
  defaults to visible rather than vanishing. A filter that permanently hides
  something is worse than no filter.

A person's subteam may be **null**, since "not sure yet" is a real answer during
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
  division; **Team Principal and Technical Director do not**. They sit across
  all three, so a team-wide role hides the division picker entirely and their
  card leads with the role rather than a subteam badge. `role_rank` orders the
  directory so it reads as a team rather than an alphabet.
- `YEARS` carries `value` + `label`, and the API sends `year_label` alongside
  `year` so no page has to know that `Alum` reads as "Retired member". There is
  no PhD option: nobody on the team is one.
- `POST /api/profile` takes **no id** and writes only the caller's row. Keep it
  that way. An id parameter would need an authorization check nothing else in
  the file needs.

### Photos are on this machine's disk

Not Supabase Storage. They live under `UPLOAD_DIR` (`/app/uploads`), which
`docker-compose.yml` mounts from `./data/uploads`, and **the mount is required**,
since the image is rebuilt in place and anything unmounted dies with the
container.

Deliberately **not** under `static/`: the Dockerfile copies that directory into
the image, so photos there would be wiped on deploy *and* served by `StaticFiles`
to anyone with the URL. They go out through `GET /media/avatars/{file}`, which
sits behind the auth middleware. That is what makes profiles members-only for
free. The public sponsor page, when it lands, gets its own route that checks
`is_public`.

You crop before uploading: a square canvas you drag and zoom, rendered to 512px
and posted as a base64 data URL in JSON. Doing it client-side is what avoids both
an image library in the container and `python-multipart` in requirements for a
40 KB payload. The stored type is sniffed from the bytes, never from the declared
content type. URLs carry `?v=photo_rev` because photos overwrite in place,
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
`GET /api/people/photos`, a name-keyed map. Attendance and the nowbar identify
people by the name they typed, which predates accounts, and `UCDFS.avatar()`
falls back to initials for any name it can't match.

## The harness topology model

`harness.html` holds two models, and keeping them apart is load-bearing:

- **Electrical**: wires between *pins*. What is connected to what.
- **Physical**: `nodes` and `segments`. What runs where. A wire gains
  `route: [segmentId]` and then travels *through* segments instead of flying
  point-to-point.

**A routed wire's length is derived**: `wireLenMm()` sums its segments, so
changing one branch updates every wire through it. Read length through that
accessor, never `w.length` directly. The raw field is only the manual override,
pinned by `w.lenManual` when someone types a measured value. Hand-typed lengths
drift the moment routing changes, and that is the usual cause of a wrong cut list.

Segment endpoints anchor to a connector *body*, a splice or a breakout node,
never a pin. A **breakout node is not a splice**: nothing is electrically joined
there, the run just divides. Conflating them invents phantom nets.

Everything else falls out of the segment graph: bundle diameter from the wires
actually inside it, dimensions annotating a real length, and (next) clips at a
distance along a run.

Unrouted wires keep the old point-to-point behaviour exactly, so documents saved
before any of this load unchanged. If you change routing, call `redrawAllWires()`.
`refreshFormboard()` alone redraws the casings but leaves the wires where they
were.

## The harness parts library

`connParts()` in `harness.html` has one invariant: **every connector returns at
least one BOM line.** A BOM that silently omits a connector is worse than one
that admits a gap. You find out when the box arrives with wire and nothing to
crimp it into. When a part number can't be derived, emit the line with an empty
`pn` (rendered `(specify)`); the Parts rule check then lists it. Never return an
empty array, and never invent a part number to fill the hole.

Contacts carry an `awg: [thickest, thinnest]` crimp range. The Contacts rule
check reads it, so adding a part extends the rule check for free.

Deutsch **DT and DTM are different series**: different housings, different
wedgelock, size-16 vs size-20 contacts. They are separate entries in `DEUTSCH`
for a reason; collapsing them orders parts that don't fit.

## The season calendar

`FSUK_DATE` / `FSUK_NAME` / `SEASON_MILESTONES` near the top of `main.py` are the
only inputs to the dashboard countdown. Changing the date there is the whole
job. `FSUK_PROVISIONAL` makes the card say so out loud; clear it once IMechE
publish the real dates.

## Working on this safely

- **Never restart or rebuild :3978 without asking.** It is in daily use.
- **Nothing but production talks to the production database.** Dev, stage and
  the whole test suite are on `ucdfs-nonprod`. This is enforced, not just
  intended. See below.
- Test accounts must use the `ucdfs-test-` prefix so cleanup can find them.
- Run `./tests/run.sh` before saying something works. The suite is fast and has
  caught real bugs that looked fine by inspection.

## Environments

Two Supabase projects, three app tiers. **Which env file a tier loads is the
only thing that decides which database it talks to**, so that one line is the
most consequential in the repo.

| tier | url | port | database | env file | built from |
|---|---|---|---|---|---|
| prod | ucdfs.shane-whelan.ie | 3978 | `fs-attendance` | `.env` | a tagged image, manual approval |
| stage | stage.shane-whelan.ie | 3981 | `ucdfs-nonprod` | `.env.nonprod` | a tagged image, on merge to main |
| dev | dev.shane-whelan.ie | 3980 | `ucdfs-nonprod` | `.env.nonprod` | your working tree |
| tests | n/a | 3979 | `ucdfs-nonprod` | `.env.nonprod` | the working tree, throwaway |

All three go through nginx-proxy-manager, which targets a host and port rather
than a container name, so renaming a container is safe, and **nothing in this
repo should ever contain a LAN address**. `suite-static` fails on any RFC 1918
address in a tracked file: every tier has a real hostname, and this repo may be
made public.

Dev and stage share a database because the free tier allows two active projects
and production needs one of them. The difference that matters is that **stage
runs the built image from `main`** and dev runs whatever you are editing.

`deploy.sh` enforces the boundary rather than documenting it. Every env file
carries `UCDFS_ENV=prod|nonprod`, and the script refuses to start dev or stage
from a prod-labelled file, refuses to deploy a sha that is not an ancestor of
`origin/main` without `ALLOW_UNTRACKED_PROD=1`, and refuses to call a deploy
successful until `/health` answers. `tests/lib.sh` refuses a prod-labelled file
outright. The suites sign up accounts, write attendance and assert that
deletion works, which against production is somebody's real history.

**Data paths in `deploy.sh` are absolute on purpose.** CI runs it from the
runner's workspace, which is a different directory every job; a relative
`./data/uploads` there resolves to an empty folder, the mount succeeds, and the
team's profile photos vanish from a site that otherwise looks fine.

Each tier gets its own uploads directory. Staging must never hold real faces.

**Schema parity is not the whole story. The auth settings have to match too.**
A new Supabase project defaults to `mailer_autoconfirm: false`, so every signup
sends a confirmation email and the second one in an hour fails with *"email rate
limit exceeded"*. Production has it `true`. Nothing in the schema says so, the
app cannot see it, and it presents as the test suite crashing on `signUp` rather
than as a configuration difference. Check it with:

```bash
curl -s -H "apikey: $ANON_KEY" "$SUPABASE_URL/auth/v1/settings" | jq .mailer_autoconfirm
```

Both projects must say `true`. It is toggled at Authentication → Sign In /
Providers → Email → **Confirm email off**, and there is no API for it.

## Migrations

`migrations/000_baseline.sql` is the whole schema as production had it on
2026-07-28, captured by introspection and verified against the live database by
comparing a hash of all 91 column signatures. **A fresh environment runs that
file and nothing else.**

It exists because 001–004 covered five tables and the database had seventeen:
`attendance`, the seven `pt_*`, the `comp_*`, `harness_doc` and
`schedule_events` were made by hand in the dashboard and lived nowhere else. The
schema was not in git, so no second environment could be built and losing the
project meant losing the design.

From here: schema changes are new numbered files applied to non-prod first, then
to prod. Never edit `000_baseline.sql`. It is a snapshot of a moment, not a
living document.

**Apply a migration before deploying the code that needs it**, to each database
in turn. The flowchart work is the worked example: 005 adds `plan_id`, 006 turns
sections into rows, 007 turns charts into rows, and each one is filtered or read
unconditionally by the code that follows it, so non-prod gets the SQL, then CI
runs, then prod gets the SQL, then prod gets the image. The other order 500s
every chart endpoint.

### Seeding non-prod

`scripts/seed-nonprod.sh` copies the reference data down from production: the
charts and their graphs, the competition schedule, the harness document,
`comp_meta`. It copies **nothing that is about a person**: no profiles,
attendance, roster, requests, `pt_done_log` or `activity_log`, all of which carry
names, and no photos, which are files on disk in a per-tier directory for exactly
this reason. `plans.created_by` is stripped on the way for the same reason: the
chart is reference data, the name of whoever made it is not.

`plans` is copied **first**, for the same reason sections come before nodes: a
chart's rows are unreachable until the chart itself exists, since
`_plan_or_400()` reads that table.

The rule is not "is it sensitive" but "is it about a person", and there is no
flag that relaxes it. It reads from a `UCDFS_ENV=prod` file and writes only to a
`UCDFS_ENV=nonprod` one, refusing both the reverse and the case where the two
are the same project, so it cannot overwrite the live manufacturing plan with
whatever state staging had drifted into. Re-runnable
(`Prefer: resolution=merge-duplicates`).

## How a change reaches the site

`main` is protected: no direct pushes, no force-push, no deletion, and the
`test` check must pass before merge. Approvals are deliberately **not** required, because on a repo this size that would mean nobody can merge anything, since you
cannot approve your own PR.

```
branch  →  PR  →  test runs  →  label "deploy: dev" to see it on :3980
                             →  merge  →  auto-deploys to stage :3981
                             →  Run workflow  →  prod :3978, after approval
```

Labelling a PR **`deploy: dev`** builds that branch and puts it on the dev tier,
then swaps the label for `deployed: dev` so the PR says what is actually live.
Pushing new commits removes that label again rather than letting it go stale.
There is one dev container, so a second labelled PR replaces the first.

**There is no `deploy: prod` label, on purpose.** It would put unmerged code on
the site the team uses daily, and prod would then be running something that is
not on `main`. After the next merge, nobody could say what is actually live
without going and looking at the container. The need behind wanting one ("I want
to see this working on something real before merging") is what the dev label is.

In a genuine emergency the ruleset is at Settings → Rules → *protect main* and
can be flipped to Disabled in about fifteen seconds. That is deliberately a
visible, deliberate act rather than a silent admin bypass.

## Deployment

Built once, promoted, never built twice from the same source and hoped over.

```bash
./deploy.sh build $(git rev-parse --short HEAD)   # tag an image
./deploy.sh stage <tag>                           # try it on :3981
./deploy.sh prod  <tag>                           # ship that same image
./deploy.sh rollback                              # what you could go back to
```

CI (`.github/workflows/ci.yml`) does the first two on every merge to `main`.
**Production is never deployed by a push**. It is `workflow_dispatch`, gated on
a GitHub environment with a required reviewer, so shipping is a decision rather
than a side effect of merging.

Images are tagged `ucdfs:<sha>` and kept. `build: .` alone overwrote the image
in place, so the version running five minutes ago no longer existed and rollback
meant rebuilding an old commit and hoping; now it is `./deploy.sh prod <sha>`.

Everything runs on a **self-hosted runner on the homeserver**. There is no cloud
runner: the deploy target is behind NAT, and the secrets are already on that
machine. A hosted runner would mean copying the `service_role` key into GitHub
so it could hand it back to us. **No secret is stored in GitHub at all**; jobs
read `/home/shane/ucdfs/.env*` directly, which only works because the runner and
the deploy target are the same box.

The runner is `~/actions-runner`, labelled `ucdfs`, run by the **user** systemd
service `github-runner.service`, not a system one, because there is no
passwordless sudo here and lingering is already enabled for the account, so a
user service survives reboot without root.

```bash
systemctl --user status github-runner     # is CI alive
journalctl --user -u github-runner -f     # what it is doing
```

`Dockerfile` copies `main.py` and `static/`, so new static files ship
automatically.
