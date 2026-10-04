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
  shared.js           UCDFS runtime: identity, applet registry, first-run overlays, toasts
  dashboard.html      the homepage, at /
  login.html          the sign-in screen
  attendance.html     card-based applet
  comp.html           card-based applet
  profiles.html       card-based applet: the team directory
  flowcharts.html     card-based applet: the chart picker, at /flowcharts
  admin.html          card-based applet: roles, god mode, deleting accounts
                      (requires_role: admin)
  tracker.html        card-based applet: who's on what, who has gone quiet
                      (requires_role: admin)
  pt.html             full-screen canvas tool: draws any one chart, at /plan/<id>
  harness.html        full-screen canvas tool
migrations/           SQL, applied by hand in the Supabase SQL editor
scripts/              ops, not app code: seed-nonprod.sh, supabase-keepalive.sh
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

`APPLETS` in `main.py` is every *page* this site serves. It generates the page
routes *and* feeds `/api/applets`, which the dashboard renders. **Adding an
applet is one entry plus one file in `static/`. Never edit the dashboard to add
a tool.**

It is no longer the whole dashboard. **Off-site shortcut cards are rows in
`links`** (`migrations/010`), added from `/admin` at runtime. See "Hyperlink
cards" below for why the line falls there and not somewhere tidier.

```python
{"id": "inventory", "name": "Inventory", "icon": "📦",
 "route": "/inventory", "file": "inventory.html",
 "blurb": "…", "accent": "teal", "status": "live",
 "subteams": ["mech"]}
```

- `status`: `live` | `quiet` (dimmed, off-season) | `soon` (placeholder, not clickable)
- `accent`: a colour token from `shared.css`
- `external`: **not a registry field any more.** It is set by `_link_card()` on
  every row out of `links`. A card carrying it opens in a new tab with
  `rel="noopener"`; there is a test that every `_blank` card carries it.
- `subteams`: ids from `SUBTEAMS`, or `["all"]`. Drives the dashboard filter
  chips and nothing else. See "Subteams" below. Omitting it means everyone.
- `requires_role`: the permission field. `_may_open()` enforces it on both the
  page route and `/api/applets`, so a gated entry can never be visible on the
  dashboard but closed on click. Omitting it means everyone.
- `plan`: for a card that opens one specific chart: which chart. Only last
  season's plans use it now; the feed reads it to badge their ticks.
- `group`: which dashboard block the card sits in. Ids come from
  `dashboard_groups`; omitting it means the **first** block. See "Dashboard
  layout" below.

Current applet ids: `attendance`, `meetings`, `purchases`, `profiles`, `org`,
`flowcharts`, `comp`, `glossary` (under `reference`), `tracker`, `admin`, and
under `archive`: `harness`, `pt`. Link ids are whatever is in the table; the
seeded ones are `vcu`, `harnesshive`, `onshape`, `sharepoint`, `fsstats`,
`fswiki`, `fsae-reddit` and, under `archive`, `mech`.

The harness mapper is archived rather than deleted: HarnessHive does the job
now, but the tool still opens and `harness_doc` still holds the team's document.
Note that removing its registry entry would **not** remove the tool. The
`/harness/api/*` endpoints and the `/harness/ws` room are separate, and
`static/` is a public prefix, so the page shell keeps being served either way.

## Dashboard layout

The blocks are rows in `dashboard_groups` (`migrations/011`): an id, a heading
and a position, managed from `/admin`. `DEFAULT_GROUPS` in `main.py` is the
**fallback**, not the source. `_groups()` answers with it when the table is
missing *or empty*, and it carries the ids 011 seeds, so a site running ahead of
its migration still draws every card under a sensible heading instead of
collapsing six blocks into one.

Empty matters as much as missing: every card carries a group id, so with no
blocks at all there is nowhere for any of them to render, and a dashboard with
no cards looks exactly like one that failed to load.

Blocks are `apps`, `electronics`, `design`, `documents`, `reference`, `archive`.
The shortcuts are split by subject rather than lumped under one "Shortcuts"
heading. Sparse today, deliberately: the point of managing links from `/admin`
is that there will be more of them, and a heading to file a new one *under* is
what stops the twentieth landing at the bottom of an undifferentiated list.

**The first block is special twice over.** It is where a card with no `group`
of its own lands, and the dashboard draws it into the fixed grid under the
filter chips rather than under a generated heading. Reordering the blocks
changes both, which is why `/api/admin/groups/reorder` is not cosmetic the way
the links one is.

- **A block can only be deleted once it is empty, and the count includes
  applets.** Applets are code: an admin who deleted the block a registry entry
  names could not put it back from the UI, and the entry would render under a
  heading nobody chose. `_cards_by_group()` mirrors `appletGroup()` in
  `dashboard.html` exactly, fallback included, so the count is of where cards
  will actually be drawn.
- **The last block cannot be deleted at all.** `_groups()` falls back when the
  table is empty so the dashboard survives it, but then the admin screen and the
  site disagree about what exists, which is worse than refusing.
- **Only the heading is editable.** An id is what every card in a block points
  at, so changing one would empty the block and scatter its cards into the
  first. Ids are minted server-side (`grp_…`), like `link_…` and `chart_…`.
- There is **no foreign key** from `links.group_id`. Same call favourites make:
  a retired block should not need a migration to clean up after, and
  `appletGroup()` already falls back to the first block for an id naming
  nothing. That fallback is the safety net; the delete rail is the mechanism.

A block with nothing in it **renders nothing, heading included**. A heading over
empty space reads as a page that failed to load, and the subteam filter can
easily empty a block. `tests/suite-pages.js` covers the dashboard drawing clean;
the grouping logic is `render()` in `dashboard.html`. This is why an empty block
in the admin list is not a mistake: it is one nobody has filed anything under
yet, and it costs the dashboard nothing.

`UCDFS.applets()`, `UCDFS.appletGroups()` and `UCDFS.favourites()` share one
cached `/api/applets` response, so asking for all three is still a single
request.

### Hyperlink cards

`links` (`migrations/010`) holds the dashboard's off-site shortcuts: the VCU
repo, Onshape, SharePoint, HarnessHive, FS Stats, FSWiki, r/FSAE, last season's
Canva plan. They were registry entries until seven had accumulated, each one a
deploy to add a name and a url, and therefore each one something only a person
with a checkout could do. They are managed from `/admin` now.

**The split is not internal-vs-external for tidiness.** An `APPLETS` entry
carries a `file` and the loop under the registry turns it into a route, so a row
claiming to be a page the image does not contain is a 404 tile: adding one is a
deploy whatever an admin screen pretends. A hyperlink generates nothing and is
pure content. Only the second kind can honestly be data, and that is the whole
reason `APPLETS` did not go the way `PLANS` did.

`_link_card()` reshapes a row into the same dict an applet is, so `appletCard()`
draws it, the subteam chips filter it and the star pins it with no front-end
change at all. `_cards()` is applets **then** links within each block: the
team's own tools are what somebody opens the page to reach, and the outbound
shortcuts are reference.

- **The url check is the one that matters.** A url goes straight into an `href`,
  and escaping does nothing about the *protocol*: `javascript:…` escapes
  perfectly and still runs, on every dashboard, every time anyone loads the
  site. `_clean_link_url()` whitelists `http` and `https`. `tests/suite-links.js`
  leads with that check for a reason. Everything else in `_clean_link()` is
  tidiness by comparison.
- **Ids are minted server-side** (`link_…`, like `chart_…` and `sec_…`). An id
  in a create body is ignored, not honoured: a caller who picks the primary key
  can collide with an applet id and shadow a real page with an unauthenticated
  link.
- **Accent, group and status fall back; they do not 400.** They come from
  selects the server itself populated, so a bad value is a stale tab rather than
  a typo, and losing a colour beats losing the edit. An unknown *subteam* is
  dropped the same way `_clean_subteam()` drops one, and an empty list reads as
  `["all"]`: a card visible to nobody is never what anyone meant.
- **Gated on the admin role, deliberately not on the override.** The rest of
  `/api/admin/*` is gated because it reaches someone else's data. This reaches
  the shape of a shared page, which is the same kind of thing as making a chart,
  and that is not gated at all. Requiring the override to fix a typo in a url
  would mean an admin elevated all day, which is the problem god mode exists to
  solve.
- **Deleting echoes the name back**, the same rail as deleting an account or a
  chart, and for the same reason rather than because the stakes match: the admin
  list can be a minute stale, and the id under the button may no longer be the
  card the row is showing.
- **Nothing sweeps favourites when a link is deleted.** `_favourites_for()`
  filters against what exists on the way out, so the star closes behind it at
  the next dashboard load. A sweep would be a write to every account on the team
  to achieve what a filter already does.
- There is no `requires_role`. Gating a link would be theatre: the url is in the
  page for anyone who can see the card, and the far end does its own auth.
  Anything genuinely needing a gate is a page, and pages are registry entries.
- `scripts/seed-nonprod.sh` copies `links` with `created_by` stripped, by the
  same test it applies to `plans`: what the dashboard points at is about the
  team's tools, the name of whoever typed it is about a person.

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
- The sign-in page asks for a new password **twice** (signup, and the reset
  step) and compares them **on the page**; the server is sent one password.
  The second box exists to catch a typo, which is a fact about the person
  typing, not a validation rule. There is nothing for a server to check.
- `COMP_ADMIN_PASSWORD` is **gone**. Committee actions need the `committee`
  role or god mode, and roles are handed out from `/admin`. There is a way to
  grant access now that isn't a password everyone knows and nobody can revoke.

### Email links: confirming an address, resetting a password

Both work the same way. GoTrue sends an email, the link in it comes back to
**`/login` with a session in the URL fragment**, and the page hands that
session to one of two endpoints. The fragment never reaches a server, so the
hand-over has to be the browser's job, and `readLink()` strips it from the
address bar the moment it has read it: a session does not belong in history
or a screenshot.

- `type=recovery` in the fragment opens the **reset step**: new password,
  twice, then `POST /api/auth/reset` with the link's tokens. GoTrue does the
  work (`PUT /user` with that token) and refuses a token it did not issue for
  the purpose. Success sets the cookie with the same session, so choosing the
  password is the last step.
- Anything else with an `access_token` (a confirmation link, a magic link) goes
  straight to `POST /api/auth/session`, which sends the token back to GoTrue
  (`GET /user`) and sets the cookie only for a user GoTrue recognises. The
  refresh token is stored as given; a bad one fails at the first refresh, which
  is signed out, not signed in as somebody.
- `error_description` in the fragment (an expired link) is shown on the email
  step, and the person is one round of "forgot your password" from a new one.

"Forgot your password?" sits under the password box on the sign-in step, so
the address is already known and there is no form. `POST /api/auth/forgot`
calls GoTrue `/recover`; `POST /api/auth/resend` sends the confirmation link
again for a signup that lost it, and is where the page goes when sign-in is
refused with *Email not confirmed*.

**Whether addresses are confirmed at all is a dashboard toggle**, not code:
Authentication → Sign In / Providers → Email → *Confirm email*. `auth_signup`
answers both ways (a session, or `needs_confirmation` and the "check your
email" step), the suites read `mailer_autoconfirm` from `/auth/v1/settings`
and assert whichever is right, and `signUp()` in `tests/lib.js` creates its
accounts through the **admin API** so no suite depends on the setting or sends
an email. Turning it on needs two more dashboard changes or it does not work:

- **Custom SMTP** (Authentication → Emails → SMTP Settings). The built-in
  mailer allows a couple of emails an hour, project-wide. September
  recruitment is thirty signups in an afternoon, and every one after the
  second fails with *email rate limit exceeded*. Any transactional provider's
  free tier is plenty.
- **Redirect URLs** (Authentication → URL Configuration): the `/login` of every
  tier that sends email. GoTrue only honours a redirect on that list and
  replaces anything else with the Site URL, which is what makes deriving the
  redirect from the request's Host header safe. `SITE_URL` in the env file
  pins it per tier regardless.

Suite-login walks the whole reset path without an email: `generate_link` (the
admin API) hands back the token GoTrue would have mailed, following the verify
URL by hand gives the redirect with the session in the fragment, and the page
is opened on that. The same trick covers a confirmation link. The one email a
run can send is the single real signup in `suite-auth` and `suite-login`, and
only when confirmation is on.

### One connection, and who may not share it

`supabase` in `main.py` is a module-global client wrapping a **single HTTP/2
connection**. It is not something several threads can drive at once. When
`/api/dashboard` was first parallelised by handing that client to seven
threads, the server hung up mid-request:

```
[dashboard] tile failed: <ConnectionTerminated error_code:1, last_stream_id:9>
[auth] profile lookup failed: [Errno 104] Connection reset by peer
```

**The second line is the point.** That is not a dashboard tile, it is the auth
path on a *different* request, broken by connection loss on the client they
share. An admin was refused as a non-admin because a dashboard tile happened
to be read at the same moment, and CI failed on god mode with a 403 that had
nothing to do with god mode. One endpoint's optimisation reached out and broke
authentication for whatever else was in flight. Roughly one request in
thirty-six lost a tile or its feed.

So the dashboard tiles run on a bounded, dedicated pool, and **a thread that
runs tiles gets a client of its own**:

- **Tile code calls `sb()`, never `supabase`.** `sb()` hands back the global
  client unless `_tile` has marked the thread, so everything else — all 103
  other call sites, on the main thread and off it — is unchanged. It is opt-in
  deliberately: uvicorn runs sync endpoints in a threadpool of forty, and
  giving all of those their own client is a much larger change than this.
- **Adding a tile means using `sb()` in it and in everything it calls.** A tile
  that reaches the global client from a pool thread reintroduces exactly the
  failure above, and it will not look like a bug in your tile. It will look
  like somebody else's request failing to authenticate.
- The pool is bounded, so at most `_TILE_WORKERS` clients are ever built, once
  each and reused. Building one costs about 16ms.

**Find the call sites by walking the call graph, not by eye.** `_activity`
reaches `_pt_activity` and `_general_activity` by iterating over the functions
rather than naming them in a call, so an AST call-graph walk misses all three
of their queries. Missing them does not raise; the existing "a tile that fails
degrades, it does not blank" handling swallows it and the feed silently comes
back `[]`.

The serial version was accidentally load-bearing, which is worth remembering
before optimising anything else here: blocking the event loop meant only ever
one Supabase call in flight, and that is what had been keeping the shared
connection safe.

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

## The tracker

`/tracker` (`migrations/017`) answers two questions for whoever runs the team:
who is working on what, and who has gone quiet. **Admin-only for now**, and
built to open to the team later. The design and the reasoning against TODO.md's
"do not rebuild Jira" are in the Tracker section there.

It is gated on the **role, not the override**, like `/admin` and links: it is a
tool somebody reads all day, and needing to be elevated to read it would mean an
admin elevated all day. `requires_role` hides the card and the page; every
`/api/tracker/*` endpoint checks again through `_require_tracker()`, because
hiding a page is not a permission.

Two halves, deliberately unequal in what they ask of anybody:

- **Items** are Jira-lite and typed by an admin. A title is the only required
  field, because the Notion tracker died partly of form-filling. Continuous
  flow: `todo → doing → blocked → done`, no sprints, no estimates. Blocked
  requires saying what it is waiting on. `touched_at` is when it last *moved*
  (status, owner, blocked reason, an update), not `updated_at`, so fixing a
  typo cannot make a three-week-stale item look fresh. Updates only touch the
  fields in the body, so the one-click status buttons cannot overwrite an edit
  from another tab. Deleting echoes the title back, like links and charts.
- **People** is typed by nobody. Somebody's last sign is the newest of: a day
  logged in the workshop (today or earlier), a flowchart tick, a purchase
  request, anything they did to an item, an update somebody wrote on an item
  they own, or a note about them. Quiet is `tracker.quiet_days` **business**
  days without one (default 5, 0 = off for exams), edited from `/admin`.

What is deliberately **not** a sign:

- **Meetings and week notes.** Hardly anybody fills them in, so counting them
  would flag the honest majority and reward the few.
- **A status change somebody else made on your item.** An admin assigning work
  and clicking Start would otherwise reset the quiet flag on exactly the person
  the view exists to surface. A written update does count: somebody checked in,
  and that is what the flag was asking for.

Privacy, decided now so opening up is not a rewrite:

- `work_item_events.private` marks an update **admins only, forever**. A note
  written on the understanding that only admins read it must not become
  visible the day that stops being true. `_sees_private()` already filters on
  the way out even though only admins can call the endpoints yet.
- `person_notes` has no public version at all, and cascades with the account:
  they are notes about a named person. The page says to write them as if the
  person will read them, because under GDPR they can ask to.
- **The People view stays admin-only after the tracker opens**, for the reason
  the org chart's flags do: "so-and-so has gone quiet" is gossip to a member and
  actionable to an admin.
- **Nothing writes to the activity feed**, the one place this breaks "new
  applets call `log_activity()`". A feed line is on every member's dashboard,
  and "gave T-14 to Aoife" there would announce a tool the team cannot open.
  The quiet-days setting does not log either, unlike the € threshold beside it.

Opening up is three functions: `_require_tracker()` (who may read),
`_may_edit_item()` (who may change an item; it already takes the item so an
owner or a granted captain can be let in), and `_sees_private()`, which does not
change.

### Accounts on the name-keyed tables

`attendance` and `pt_done_log` key people by the name that was typed, which
predates accounts. 017 adds a nullable `profile_id` to both so the People view
never matches on spelling:

- **Backfilled only where the folded name matches exactly one account.** Two
  members with the same name stay null rather than one inheriting the other's
  history with nothing on screen to say so. `_profile_id_for_name()` follows the
  same rule for a row god mode writes on somebody's behalf.
- **Every new row is stamped**: your own attendance with your id, a tick with
  the caller's. Through `_write_stamped()`, which retries without the column if
  PostgREST says it is not there, so a forgotten 017 costs attribution and not
  the two busiest writes on the site.
- **What is left is listed in `/admin`** under "Names that match no account":
  typos, nicknames, the ambiguous, people who never signed up. Matching one
  stamps every still-unmatched row with that spelling. It never moves a row
  that already has an account, which also means a wrong match is a SQL fix,
  and the confirm says so.
- `_fold_name()` in Python and the `lower(btrim(regexp_replace(…)))` in 017 are
  the same fold and have to stay that way. Collapse first, trim second:
  `btrim` only strips spaces.

## Roles, permissions and god mode

Three things that look similar and are not:

| | what it is | enforced |
|---|---|---|
| `subteams` (registry) | relevance: what you see first | never; presentational |
| `requires_role` (registry) | permission: what you may open | `_may_open()`, page route + `/api/applets` |
| `profile_details.role_label` | what you call yourself on your profile | never; a display string |
| `profiles.role` | the real permission: member / committee / admin | `require_role()` |
| `profiles.god_mode` | is this admin currently elevated | `god_on()` |
| `captaincies` (migrations/014) | permission: who leads each division | `_captain_of()`, `_leads()` |

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
first-sign-in overlay, the tour) is styled from a `<style id="ucdfs-runtime-css">` block
inside that file, **not** from `shared.css`. The canvas tools (pt, harness) load
`shared.js` and deliberately not `shared.css`, so a rule that lives only in the
stylesheet renders as raw unstyled markup on exactly the two pages nobody thinks
to check. Colours are written `var(--token, literal)` so they pick up the design
system on a card page and still look right without it.

### Only one overlay at a time, and shared.js owns the queue

`shared.js` can put three different things on screen unprompted: the subteam
question, the onboarding-session question, and `UCDFS.tour()`. A brand-new
member's first sign-in triggers all three.

**They must not each decide for themselves when to appear.** Each waits on a
round trip before it knows whether it has anything to show, so left alone they
race on whichever response lands first, and the loser draws underneath a modal
that is already up. The order is fixed and deliberate: who you are (division),
what you are coming to (the session), then where things are (the tour).

**There is no "set up your profile" step any more.** It used to follow the
division question, and its button sent people to `/profiles` mid-sequence, so
they answered the session there and never saw the tour, which only runs on the
dashboard. The profile is the first thing on the Start here checklist, and the
tour stops on the checklist to say so. Do not put a step back between these
that navigates away.

`whenOnboardingIdle()` is the join point. It returns a promise that settles once
the subteam step and the session question are both done with the screen, and
**null means idle already** — the common case is a member who answered weeks
ago, and they should not wait on a promise to find that out. Anything added
later that wants the screen on load joins this queue rather than calling
`document.body.appendChild` and hoping.

This is not theoretical: with the gate removed, `tests/suite-pages.js` fails on
*"the tour does not stack on top of it"* — which is the whole reason that check
sits next to a positive control. On its own, "the tour did not open" passes just
as well when the tour is broken.

**`UCDFS.tour()` is the engine, and the steps stay with the page.** `pt.html`
declares its own five cards and hands over its own `?` button, because the
canvas tools style one to match their header. Everything else gets a `?`
injected into `.header-inner`. Folding every applet's steps into one portal tour
would make something nobody reaches the end of.

**A step can point at the page.** Given `el` (a selector, or a function that
returns an element), the page dims around it, the card sits beside it with an
arrow, and Next glides both to the next target. A step without one is a card in
the middle, which is all `pt.html` and `purchases.html` use.

- The dimming is one element's enormous `box-shadow`; the element itself is the
  hole. A centred step makes it a hole of no size in the middle, which is why
  the first move reads as an iris opening. CSS transitions do all the motion.
- `optional: true` drops a step whose element is not on screen **when the tour
  opens**, so "Step 2 of 7" cannot change mid-run. The checklist step uses it;
  it only exists for new accounts.
- It scrolls only when it has to, and it knows about sticky headers
  (`tourInset()`): a target tucked under the header is not on screen. That was
  a real bug: the grid step scrolled the chips row under the header, and the
  next step lit the header instead.
- The current target carries `.ucdfs-tour-target`, for a page to lift something
  that is deliberately faint the rest of the time. The dashboard's star uses it.
- No close on a click outside the card. The layer covers the whole page, and a
  tour dismissed by a stray tap is one nobody finds again. Skip and Escape.
- jsdom has no layout, so every target looks missing there. The suites check the
  queue and the count; whether the light lands in the right place was checked
  by screenshot, desktop and phone, and should be again after changing a step.

The portal tour starts from `boot()` **after** `reveal()`. Until then the page is
invisible, and a spotlight on something invisible is a dark screen with a hole
in it.

Seen-ness is `localStorage`, keyed `ucdfs_tour_<key>` and versioned by
convention, because it is a per-browser preference and not identity: getting it
wrong shows somebody a tour twice, which is not worth a column, a migration and
a round trip. **The accepted cost is that this records nothing about who has
been onboarded** — a new browser shows it again and none of it is auditable.
Correct for orientation, wrong the day any of it carries safety induction or
tools training. Those are records and want a column on the profile. Add that
separately rather than growing the tour into it.
### The loading ring is in shared.css, not shared.js

The other shared components (`onboard()`, the override banner, `tour()`) are
styled from `shared.js`'s runtime CSS, for the reason under **shared.js must
carry its own CSS** above. The loading ring is the one exception and goes in
`shared.css` instead.

**Because the dashboard draws it on the first frame**, before any script has
run: that page hides itself until `reveal()` lands, and the ring is what stands
in for it meanwhile. Runtime CSS is injected by JavaScript, so a ring that
depended on it would appear a beat late on the one page whose entire point is
that it does not.

The cost is real and worth knowing: the canvas tools (`pt`, `harness`) load
`shared.js` and deliberately not `shared.css`, so they cannot use `.ring`. If
one of them ever wants a loading indicator it needs its own, the same way it
has its own header and its own `?` button.

Two placements off the one class: `.ring` alone sits wherever it is put — the
dashboard drops it inside `#load-veil`, which is that page's own full-screen
treatment and not something every applet wants — and `.ring-block` adds the
padding to stand in for a list that has not arrived yet. `--ring-accent` tints
it, defaulting to indigo.

### New members: the session prompt, Start here, and the glossary

Three things aimed at an intake, all reading data the site already holds.

- **`ONBOARDING_SESSION`** in `main.py` is a one-off session (date, name,
  place) for anyone who signed up on or after `new_since`, plus every captain.
  **It is a day in the meetings picker**, not a page of its own: `/api/meetings`
  adds it to `days` with a `special` block (what it is, whether the caller is
  invited, and the whole invite list, so "yet to answer" can name people), and
  the page draws it purple with a "New members" badge. Answers are ordinary
  `meeting_responses` rows through the ordinary `/api/meetings/respond`, which
  refuses anyone not invited, so there is one write path and no migration. The
  one extra endpoint is `/api/onboarding-session/me`, which `shared.js` calls on
  every page load to ask invitees until they answer ("Ask me later" closes it
  for that page only). It queues after the subteam step and before any tour.
  After the date `/me` does no database work.
  - It is **kept out of everything about regular meetings**: `_meeting_dates()`
    stays Tuesday/Thursday so the dashboard tile never targets it, the history
    drops its rows (one used to move where a person's log ended, cutting off
    that week's Thursday), and the page hides the week note for it and never
    counts it as a missed session.
  - "Captains" here means `_captain_titles()`: granted captaincies plus anyone
    whose card says Captain, **Team Principal or Technical Director** (see
    *Who counts as a captain* below). Being *asked* is not a permission, so the
    self-set label is fine for it, and the list tags each with their title. It
    must not fall on a `MEETING_DAYS` weekday, since responses are one row per
    person per date.
- **Start here** (`/api/start-here`) is a checklist card on a new account's
  dashboard. Every counted step is ticked from data (division picked, photo,
  a prompt, the RSVP, a first attendance row), never from a click on the
  list, and things nothing can verify are links underneath instead of boxes.
  It disappears once every step is done or `START_HERE_DAYS` after signup.
- **Picking a division the first time** writes "X joined Mechanical" to the
  feed, once, so the team knows who to say hello to.
- **`/admin` → Who hasn't signed up?** takes a pasted list of addresses and
  splits it into joined and missing. Nothing pasted is stored. It is the only
  way to reach the people the prompt cannot, because they have no account.
- **`/glossary`** is rows in `glossary_terms` (`migrations/016`), edited on the
  page itself. Editing is `_may_edit_glossary()`: the admin or committee role,
  or a **granted** captaincy. Never the self-set label, because unlike being
  invited to a session this one is a permission. On the role and not the
  override, like links, because it is the wording of a shared page. Ids are
  minted server-side (`term_…`), and an id in the body means "edit this one",
  so a caller cannot name a row into existence. A term exists once whatever its
  capitalisation (checked, with a unique index behind it). Deleting echoes the
  term back, the links rail. Categories are `GLOSSARY_GROUPS` in code; a row
  naming one that is gone is drawn under the first. Edits stay out of the
  activity feed, because one person tidying twenty definitions would bury it,
  and `updated_by` answers who wrote what. Without 016 the page says the
  glossary is not set up rather than looking empty.

### Captaincy is granted, never claimed

There are two things called "captain" and only one of them grants anything.

`profile_details.role_label` is the job title people put on their own profile.
It arrives in the body of `/api/profile`, so **anyone can set themselves to
`captain`**, and 003 says it outright: *"Relevance, never permission."* Perfectly
fine for a directory.

**Who counts as a captain: the division captains, the Team Principal and the
Technical Director.** The team decided this on 2026-09-28, and it applies from
here on: anything built for "captains" includes the principal and the TD unless
it says otherwise. `CAPTAIN_LABELS` in `main.py` is that list, and
`_captain_titles()` reads it for the onboarding session's invites and tags.

What it can and cannot reach today is the whole point of this section. Division
captains have a **granted** source (`captaincies`, below). The principal and TD
do not: their only record is `role_label`, which anyone sets on their own card.
So they count wherever a label is enough (being invited, being tagged, being
drawn on the org chart) and nowhere a permission is decided, which today means
editing the glossary. Until there is a granted seat for them, those two get
permissions the ordinary way, through the committee or admin role in `/admin`.
The fix, when it is wanted, is the one the org chart section already names: a
migration alongside `captaincies` and a picker in `/admin`, not a rule that
trusts the label.

`captaincies` (migrations/014) is the permission. One row per division, assigned
from `/admin` by an admin the way roles are, and the reason it exists is that
the purchase-request design needs "the captain of the requester's department" to
mean something a member cannot award themselves. `tests/suite-admin.js` pins
exactly that: a member setting `role_label: 'captain'` still holds no captaincy.

Keyed by subteam rather than a column on profiles, because the primary key *is*
the rule — a division has one captain and the schema says so. **There is no
separate ops-captain flag**: the Ops Captain is the captain of the `ops`
subteam, which is what lets the fallthrough rule in `TODO.md` work without a
special case.

Two deliberate non-constraints. One person may hold two divisions, because a
thin year is a real situation and forbidding it would prevent tidiness rather
than an error. And no captaincy is required for a division to exist — a division
with an empty slot simply has nobody who can approve its spending, which is
information the `/admin` page shows rather than hides.

An unapplied 014 reads as **no captains**, so approvals stall rather than being
granted. That direction is the safe one and is why `_captains()` returns `{}` on
a failed lookup instead of raising.

### The org chart draws from two sources, and says which

`/org` is a read-only picture of the team built in `_org_chart()`. It grants
nothing and is checked by nothing. What matters is that its boxes come from two
sources with different standing, and the page never blurs them:

- **Captain boxes come from `captaincies`** and nowhere else. A captain box is
  the same fact that decides who may approve a purchase.
- **Team Principal, Technical Director and Vice Captain come from
  `profile_details.role_label`**, which anyone sets on their own card. There is
  no granted source for those seats yet. When one is wanted, it is a migration
  alongside `captaincies` and a picker in `/admin`, not a rule that trusts the
  label.

The shape is `ORG_REPORTS_TO`, beside `SUBTEAMS`: the Principal at the top, the
Technical Director and Operations below them, and Mechanical and Electrical
below the TD. It comes down to the page as `reports_to` on each division, so
`org.html` draws a hierarchy rather than knowing one — the whole tree is one CSS
rule (`.fan`) applied at each level. A division missing from the map hangs off
the Principal, so adding one to `SUBTEAMS` and forgetting the map puts it in the
wrong place rather than dropping it off the chart.

Placement rules, in order: retired members (`year = 'Alum'`) are off the chart;
a granted captain is drawn in their captain box whatever their card says; a
person who says `principal` or `td` sits in the top tier and not in a division;
`vice` goes under their division's captain; everyone else with a division is a
member chip; no division means the holding row at the bottom. One box per
person, except a granted captain who also claims a team seat, who appears in
both because both may be true.

Wherever the two sources disagree, `_org_chart()` records a flag against the
person: says Captain but holds no captaincy, holds one but the card says
member, holds one for a division the card does not put them in, two people
saying Team Principal. **Flags are sent only to admins.** A member seeing
"so-and-so says Captain but is not one" is gossip, not information they can act
on. `suite-org` checks both halves: a member gets an empty `flags`, an admin
gets the populated one.

Every box links to `/profiles#<id>`, which opens that card. That hash handling
lives in `profiles.html`, so any page can deep-link a person.

### Hiding a control is not a permission

`/api/log` and `/api/log/delete` took a name from the request body and wrote it.
The attendance page only drew edit buttons on your own row, so it *looked*
enforced, but any signed-in member could delete anybody's day with one fetch.
`_require_own_row()` now checks server-side, case-folded and
whitespace-collapsed (those rows predate accounts and were typed by hand), with
god mode as the only override.

**The Competition Hub had the same bug in three places, found 2026-09-01 while
designing the purchase-request applet.** Worth writing down because the first
fix did not generalise: it was applied where the bug was found and nowhere else,
and the shopping list had been sitting there the whole time.

- `/comp/api/requests` took the requester from the body, so a request could be
  filed in somebody else's name.
- `/comp/api/requests/edit` and `/delete` took a `name` and compared the row
  against it — passing the owner's name was the whole check.
- `/comp/api/requests/update` **had no check at all**, and that was the one that
  mattered: `price`, `status` and `bought_by` are the entire input to
  `/comp/api/expenses`, so any signed-in member could mark anything bought at
  any price in any name and mint a debt owed to themselves.

The gate on pricing is the **shop runner**, not an admin, because that is the
flow the page implements: somebody says "I'm going", shops, enters prices. A
committee account can always do it, for when whoever went never declared
themselves. `/comp/api/runner` needed the same treatment once it became the
gate — it also took a bare name, so naming somebody else was a way to hand
yourself the ability to write prices.

Note the shape of the fix: **forcing `bought_by` to the caller is not enough on
its own.** Self-attribution *is* the attack, because `bought_by` is the person
everyone else ends up owing. Stamping the field is right, but the control is
being the runner.

One clause exists purely to match what the page already draws: whoever is
recorded as the buyer can keep editing that row after standing down as runner,
because ↩️ is drawn for the buyer and clicking Done is the normal end of a shop
run. Without it, buying five things and tapping Done locks you out of correcting
any of them. It cannot invent a debt — the row already names you as who paid.
**Check the page before writing a gate**: here the UI had it right all along
(`isRunner` for the price row, `isBuyer` for undo) and the server simply was not
enforcing what the page was claiming.

`tests/suite-comp.js` pins all of it, negatives first, with one positive control
— a runner who *can* price a request. Without that, every negative passes just
as well on an endpoint that refuses everybody.

**Then the same fix was made to generalise, by audit rather than by eye.**
Walking every POST/PUT/PATCH/DELETE route for a person-shaped field read out of
the JSON body, and subtracting the ones that already guard, leaves a short list.
Everything on it was a false positive — `/api/auth/*` is pre-auth by definition,
and `name` on `/api/plans` and `/api/admin/links` is the *thing's* name — except
one:

`/pt/api/toggle` took `user_name` from the body and wrote it into `pt_done_log`,
which is append-only and is the audit trail the build plan is trusted on. Any
signed-in member could tick a task and sign it as somebody else. `_me_name()` is
the single helper all of this now goes through, which is why it sits next to
`current_profile()` rather than in whichever applet needed it first.

The lesson is the reason this section keeps growing: **fixing the instance is
not fixing the bug.** Attendance was fixed in 2026-07 and the identical hole sat
in the Comp Hub and the PT log for another month, because nobody swept for the
pattern. If you fix one of these, run the sweep.

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
- **Only one run at a time on this machine, and the script enforces it.** CI is
  a self-hosted runner on this same box running this same script, against a
  fixed container name on a fixed port that `start_test_container` `docker rm
  -f`s first. So a local run started while CI is going does not queue behind it,
  it deletes CI's container mid-suite — and the failure looks like a bug in
  whatever branch CI happened to be testing, not like a collision. That is what
  reddened PR #21, whose code was fine. `run.sh` now takes an flock on
  `/tmp/ucdfs-tests.lock` and waits; if it says it is waiting, that is CI or
  another terminal, and `lsof` on that file says which.

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
Whether a project confirms email addresses (`mailer_autoconfirm`) is a
dashboard toggle with no API, nothing in the schema says which way it is set,
and the app cannot see it. It used to present as the test suite crashing on
`signUp`; the app and the suites now work either way (see *Email links* under
Auth), but the two projects still want to agree, or a flow that passes on
stage is not the flow production runs. Check it with:

```bash
curl -s -H "apikey: $ANON_KEY" "$SUPABASE_URL/auth/v1/settings" | jq .mailer_autoconfirm
```

`true` means confirmation is **off**. Toggled at Authentication → Sign In /
Providers → Email → *Confirm email*, and turning it on needs custom SMTP and
the redirect allow-list, both in that section.

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

010 and 011 are gentler about it and still want the same order. `_link_rows()`
returns `[]` when the links table is missing, so a site running ahead of its
migration loses its shortcut cards rather than its dashboard, and `_groups()`
falls back to `DEFAULT_GROUPS` when the blocks table is missing, so the headings
still appear. Both are degraded, not broken, but that is still eight cards
missing from the homepage with nothing on screen to say why. Apply them first.

**Neither of 010 and 011 depends on the other having run**, so the order between
those two does not matter. There is no foreign key between them, each falls back
independently in `main.py`, and 011's rewrite of `links.group_id` sits behind a
`to_regclass('public.links')` guard. That guard is not defensive tidiness: a bare
`update` against a missing table is an error, and an error there would abandon
the blocks 011 exists to create, so the file would fail for a reason that has
nothing to do with what it does.

011 re-files the cards 010 seeded rather than 010 being edited to seed them
correctly. 010 shipped and was applied, which makes it a snapshot of what ran;
the block it used, `tools`, is not seeded by 011 at all, because it was never a
subject but "the main grid", and the *first* block is what that means now.

**017 is the tracker** (`work_items`, `work_item_events`, `person_notes`) and
adds `profile_id` to `attendance` and `pt_done_log`, backfilled where a name
matches exactly one account. It needs 015 (its quiet threshold is a row in
`settings`). Apply it first like the rest; if you do not, the tracker says it
is not set up, and attendance and ticks keep working unstamped, because both
writes go through `_write_stamped()`. Those rows then show up in `/admin` as
unmatched names to tidy.

**016 creates `glossary_terms` and seeds the 61 terms the page used to carry.**
Apply it before the code that reads it, like the others; without it `/glossary`
says it is not set up. Re-runnable: the seed skips anything already there, by
id or by name.

**009 turns on RLS for `plans`, which 007 created without it.** Every other
table-creating migration enables it in the same file; that one did not, so it
was the single table in the schema running with RLS off. The exposure was small,
because nothing hands the anon key to a browser, but "the browser never talks to
Supabase" is a property of today's code and RLS is what makes it a property of
the database. `plans` is also the whitelist `_plan_or_400()` reads, so a write
there names charts into existence.

### Seeding non-prod

`scripts/seed-nonprod.sh` copies the reference data down from production: the
charts and their graphs, the competition schedule, the harness document,
`comp_meta` and the glossary. It copies **nothing that is about a person**: no
profiles, attendance, roster, requests, `pt_done_log`, `activity_log` or the
tracker's three tables, all of which carry names, and no photos, which are files on disk in a per-tier
directory for exactly this reason. `glossary_terms.updated_by` is stripped too. `plans.created_by` is stripped on the way for the same reason: the
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

### Keeping the databases awake

A free-tier Supabase project pauses after seven days with no activity, and the
free tier does not let you schedule the restore — somebody opens the dashboard
and presses a button. Both projects are exposed to this. Prod looks safe because
the site gets used most weeks, but exam periods, the summer, and the gap between
one committee and the next are all longer than seven days. Non-prod is worse,
since dev and stage are only up when somebody is working on the site.

`scripts/supabase-keepalive.sh` queries `comp_meta` on both projects. It is
scheduled by a **user systemd timer on the homeserver**, daily, `Persistent=true`
so a run missed while the box is off fires when it comes back:

```bash
systemctl --user list-timers ucdfs-keepalive.timer
journalctl --user -u ucdfs-keepalive -n 30
```

The units are `~/.config/systemd/user/ucdfs-keepalive.{service,timer}` and are
**not in this repo** — they carry absolute paths and are specific to that
machine. Nothing in CI or `deploy.sh` runs this script.

**It uses the anon key, and expects to read nothing.** RLS is on with zero
policies everywhere, so `[]` is the pass condition and a row is the alarm — the
script fails the run if the anon key ever reads `comp_meta`, which makes it a
daily check on the property that makes that key safe to hold. The query still
counts as activity either way: RLS is enforced inside Postgres, so the SQL runs
whether or not a row survives it. Do not "fix" an empty result by reaching for
the service key. A credential that bypasses RLS has no business in a job that
runs unattended every day, and the empty array is the point.

A keepalive nobody looks at is worse than none, because it makes you believe you
are covered. So the unit carries `OnFailure=notify-failure@%n.service`, a
generic push notifier on the homeserver that any unit can point at, not
something this project owns. **It is inert until `~/.config/notify/ntfy.env`
exists** — until then a failure is only a red unit in the journal, and the
notifier logs that it had nothing to send. Setup is in the header of
`~/.local/bin/notify-failure`.

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
