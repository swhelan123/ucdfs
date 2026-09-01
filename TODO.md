# UCDFS webapp: what to build next

Written 2026-07-28, a week after FSUK 2026. Target for most of this is the
**start of the 2026/27 season in September**.

---

## The rule for what belongs here

We already have Teams (chat + all our files on SharePoint) and Outlook. This app
should not compete with any of that. The dividing line that has held up so far:

> **Teams holds conversation and files. This app holds _state_: anything with a
> status, an owner, a dependency, or a deadline.**

Teams is bad at structured data and has no concept of "this task is blocked by
that one" or "47% done". That is the entire gap this app fills. Every applet
below is on the state side of that line. Anything that is really a document
belongs in Teams, linked from here.

## The lesson from the Notion tracker

The Notion tasks/epics build died in **March**: peak manufacturing crunch, the
month it should have been most useful. That timing is the whole diagnosis: it
wasn't a discipline problem, it was that the tool was never load-bearing. When
people got busy they routed around it, and nothing broke, so it stayed routed
around.

Meanwhile the **PT Manufacturing Plan is at 89% with a full audit log** and is
still being ticked off. Same team, same year, opposite outcome. The differences:

| Notion tasks DB | PT plan |
|---|---|
| generic, could hold anything | shaped like one real job |
| a list you must read | a picture you can see |
| creating a task = filling a form | ticking a node = one click |
| no shared view of "where are we" | the whole build at a glance |
| told you nothing was blocked | dependency arrows show it |

**So: do not rebuild Jira.** The pattern that works here is already in the repo.
Generalise it (see "Build Plans") rather than starting a generic task tracker
that will die next March for the same reasons.

---

## Near-term: cheap dashboard wins

Small things, mostly reusing data we already store. Worth doing before any new
applet because they make the homepage worth opening daily.

### 1. Days to competition (✅ done)
Navy/gold strip at the top of the dashboard. The season calendar
(`FSUK_DATE`, `SEASON_MILESTONES`) is one editable block at the top of `main.py`
and is the only input.

Two things still open:
- **The date is provisional**: `date(2027, 7, 13)`, extrapolated from the 2026
  pattern. The card says "provisional" until `FSUK_PROVISIONAL` is cleared.
  Update both the day IMechE announce.
- `SEASON_MILESTONES` is empty. The machinery renders "Next: design freeze in 42
  days" as soon as there are dates to put in it.

### 2. Activity feed (✅ done)
Bottom of the dashboard, newest eight. Merges two sources: `pt_done_log` (the PT
plan's existing audit log, adapted rather than duplicated) and the
`activity_log` table: `migrations/002`, **applied**, written to via
`log_activity()`. Profiles writes one line the first time someone fills theirs
in, and none for later edits.

Attendance deliberately doesn't write to it. Twenty people logging a day each
morning would bury everything else, and the nowbar covers it. Worth revisiting
when there are more applets writing: eight items is thin now and will be noisy
later, so the feed probably wants its own page and a "load more".

### 3. Who's in the workshop right now (✅ done)
*"4 in the workshop now: Shane, Aoife, Cian +1 · until 17:00"*, with real
profile photos where people have uploaded one, in a bar under the headline. Only rendered when someone actually is in; the
headline drops its own workshop line in that case so the two never duplicate.

Someone who logged no departure time counts as still here. We can't know, and
showing a present person as gone is the worse error.

Watch for: it's a snapshot at page load, not live. If people start leaving the
dashboard open on the workshop TV it wants a poll or the existing websocket.

### 4. Your own stuff (*small*)
"3 tasks assigned to you", "you owe Aoife £14.20". Personalises the homepage,
which is the single biggest driver of repeat visits.

---

## Tier 1: build these first

### Team Profiles  🧑‍🔧 (✅ built 2026-07-28, ship in September)
*The idea from the chat, and I think it's the right one to do first.*

**Shipped:** `/profiles`: directory grid, croppable photo, year/course/joined,
role, division badges, skill tags typed as bubbles, three prompts from a list of
fifteen, search, and filter chips for division and tag. `migrations/003`
(**applied**), `tests/suite-profiles.js` (83 checks). Photos are on this
server's disk under
`./data/uploads`, served through `/media/avatars/…` behind the auth middleware,
so profiles are members-only by default, and they show up in the header pill,
the "who's in now" bar and the attendance log, not just here. `is_public` is
stored per profile but nothing reads it yet; the sponsor page is deliberately
deferred, see below.

**Roles are the real ones:** Captain / Vice captain / Team member *per division*,
plus **Team Principal** and **Technical Director**, which are not in a division
at all and so hide the division picker rather than forcing a wrong answer. Year
runs 1st–5th and MSc plus **Retired member** for alumni; there is no PhD option
because nobody on the team is one.

**Still open:**
- The **public / sponsor page** the `is_public` toggle exists for. Separate
  audience, separate design; not what recruitment week needs.
- Three accounts exist with divisions picked but empty profiles. Worth a nudge
  before September so the grid doesn't look abandoned when 30 people first
  open it.
- The prompt list has never met a real user. Expect to swap two or three out
  after the first week. That costs one line in `PROMPTS`, no migration.

~~**Two rough edges in the first-run flow**~~ (✅ both fixed 2026-07-28):

- ~~A deep link skips the division question~~. The step moved out of
  `dashboard.html` into `shared.js`, which builds the overlay itself and raises
  it on whatever page you land on. It is idempotent: the dashboard also calls
  `UCDFS.onboard(cb)` to hear the answer and move its filter, and the second
  call only registers the callback.
- ~~Name spelling is load-bearing~~. Both the page and the new server-side
  ownership check fold case and collapse whitespace, so "shane whelan" and
  "Shane  Whelan" are the same person.

Not because it's the most useful, but because it's the only one with a **social**
reason to open the site. Adoption is the thing that killed the last attempt, and
a tool nobody opens in October is a tool nobody trusts in March. Ship this in
**September during recruitment** when 30 new people need to learn who everyone
is, and the platform gets a captive audience on day one.

The Hinge-style prompts are a genuinely good instinct. Free-text "write a bio"
fields produce empty profiles; picking from a list produces filled ones because
choosing is easier than composing.

**Fixed fields** (auto-fill name + email from their account):
- Photo
- Year (1st–5th / MSc / PhD) and course
- **Subteam**: Powertrain / Mechanical / Operations (see next section)
- Role (member / lead / committee)
- Joined (year)

**Chosen prompts**: pick any 3 from a list of ~15:
- Why I joined UCDFS
- Favourite team memory
- The part I'm proudest of
- My worst workshop moment
- What I'd tell a first-year
- The tool I can't work without
- Dream job after this
- Most useless skill I have
- What I'm working on this season
- Song that gets me through a build night

**The bit that makes it matter in November, not just September:** add
**skills/subsystem tags** and make the grid filterable. Then it stops being a
fun page and becomes *"who do I ask about CAN bus?"*, a directory. That's what
gives it a reason to exist after the novelty wears off.

Notes:
- Photos need **Supabase Storage**, the first time we'd use it. Bucket with the
  service key, same as the DB. Resize on upload; a 4 MB phone photo per person
  adds up fast.
- Privacy: members-only by default, with a per-profile "show on public page"
  toggle. That gives us a **recruitment / sponsor page** for free, a real
  external win, and a reason for the business side to care.
- I'd skip **age**. Year + course already says it, and some people won't want it
  on a page sponsors might see. Easy to add later if people ask.

**New tables:** `profile_details` (extends `profiles`), `profile_prompts`.

---

### Subteams: self-assignment + applet filtering  🏷️ (✅ done 2026-07-28)
People pick **Powertrain**, **Mechanical** or **Operations**, applets get tagged
with the same three, and the dashboard filters to what's relevant to you.

**Shipped as designed below:** `SUBTEAMS` in `main.py` is the single vocabulary,
every registry entry carries a `subteams` tag, the dashboard has filter chips
that remember your choice per device and default to your own subteam, and the
first-sign-in step asks the question with **Not sure yet** as a real answer.
Picking a subteam hands straight over to "set up your profile", one onboarding
sequence, as intended. The suite asserts both invariants: no applet is
unreachable under any chip, and a tag never gates a route.

Worth doing early because it's cross-cutting: it feeds Team Profiles, the applet
registry, the dashboard, Build Plans and Teams notification routing. Cheap now,
annoying to retrofit once there are ten applets.

**Where to ask.** Not on the signup form. That screen has one job and every extra
field costs completions, and during September recruitment half of them genuinely
don't know their subteam yet. Instead:

- A **one-time onboarding step on first sign-in**: three big cards, *"Which
  subteam are you on?"*, plus a **Not sure yet** option that doesn't block them.
- Editable afterwards from their profile, because people move around.

That also merges cleanly with the Team Profiles "finish your profile" flow,
one onboarding sequence, not two.

**Let people be on more than one.** Powertrain people do mechanical work all the
time. Store a **primary** subteam (drives defaults and filtering) plus optional
extras:

```sql
alter table profiles add column subteam       text,          -- 'pt' | 'mech' | 'ops' | null
                     add column subteams_extra text[] default '{}';
```

**Applet tagging**: one more field in the `APPLETS` registry, so it stays the
single source of truth:

```python
{"id": "pt", "name": "PT Manufacturing Plan", ...,
 "subteams": ["pt"]},          # omit or ["all"] = everyone
```

Current applets would map:

| applet | subteam |
|---|---|
| Attendance | all |
| Team Profiles | all |
| PT Manufacturing Plan | pt |
| Wiring Harness Mapper | pt |
| Mech Manufacturing Plan | mech |
| Competition Hub | ops |

**Filter, never hide.** Filter chips along the top of the dashboard,
*All · Powertrain · Mechanical · Operations*, defaulting to your subteam, with
`all`-tagged applets always shown. Nothing ever becomes unreachable; a filter
that hides something someone needs is worse than no filter at all. Remember the
last choice per device.

**Tags are not permissions.** Worth keeping these separate in our heads:

- `subteams`: *relevance*. Soft, user-facing, changeable, purely presentational.
- `requires_role`: *permission*. Hard, server-enforced, not a display concern.

An Operations member must still be able to open the PT plan; it just shouldn't be
the first thing they see. If we ever conflate the two we'll end up locking people
out of things they need at 2am before a deadline.

**Downstream wins once subteam exists:**
- Build Plans open your subteam's plan by default
- Teams notifications route to the right channel instead of spamming everyone
- Profiles filter by subteam: *"who's on Powertrain?"*
- Dashboard headline can prioritise your subteam's blockers

---

### Flowcharts  🗺️  *(done, was "generalise the PT plan")*
The replacement for the Notion tracker, built from the thing that already worked.

Landed in three steps, each one moving a layer out of code and into the database:

- **`migrations/005`: data belongs to a plan.** Every `pt_*` table carries a
  `plan_id`; one canvas serves any plan at `/plan/<id>`; `/pt` stays the legacy
  alias so nothing saved before the change moved.
- **`migrations/006`: sections are rows.** They spent one release as
  `cols`/`rows` definitions in code, which meant a new plan's *layout* was still
  a deploy. Now: `＋ Section`, drag the name to move it (tasks come with it),
  drag the top-right corner to resize, double-click to rename or delete.
- **`migrations/007`: charts are rows.** The last hardcoded thing was the list
  of plans itself. `/flowcharts` is the picker: every chart, task counts,
  `＋ New chart`, and rename / archive / delete per chart. Archiving is the
  reversible action; deleting only works on an empty chart.

**So the answer to "can Mech just make their own?" is yes, with no code at all.**
That was the whole objective and it is met. The Canva link stays on the dashboard
under *Last season* as a record of 25/26; when Mech want a real one they press
the button.

The dashboard now groups its cards (`APPLET_GROUPS`), which is what moved both
25/26 build plans into their own block at the foot of the page instead of leaving
them competing with what is being built now.

`pt.html` also carries a five-step first-run tour, with a `?` in the header to
reopen it, because a canvas with no instructions is a canvas people open once.

Still to do, roughly in order:

- Add per node:
  - **Assignee** (from `profiles`, we have accounts now)
  - **Due date**, so the countdown can flag what's late
  - **Blocked** flag distinct from not-started: "waiting on a part" is the
    single most common real state and neither Notion nor the current plan can
    express it
- Then the dashboard can say *"Chassis is 12% behind, 3 tasks blocked on
  parts"*, which is the sentence a team lead actually wants. (Today the tile
  follows one chart (`DASHBOARD_PLAN`), which is the right shape until there
  is per-chart data worth a sentence each.)
- **Duplicate a chart.** Rebuilding a 60-task plan by hand every September is
  the obvious next paper cut, and the graph is already chart-scoped: "copy this
  chart's sections and tasks into a new one, tick state cleared" is one endpoint
  and a menu item on `/flowcharts`. Probably the single highest-value thing left
  on this list, and it is what makes the September rollover a five-second job.
- At season rollover: archive last season's chart from the picker and point
  `DASHBOARD_PLAN` at the new one. The 25/26 data stays in the tables untouched,
  never wipe `pt_*` for a new season, `pt_done_log` is the feed's history.
- **Per-chart subteam tag**, so `/flowcharts` and the dashboard can put a
  Mechanical chart in front of Mechanical first. Same rule as everywhere else in
  here: relevance, never permission. Filter, don't hide.

---

### Favourites  ⭐ (✅ done)
Star any card and a copy appears in a Favourites block at the top of the
dashboard; the original stays where it is. Per account
(`profile_details.favourites`, `migrations/008`), not per browser. See the note
in CLAUDE.md for why that is the opposite call to the subteam chip.

Worth doing next, in rough order of value:

- **Favourite a chart, not just an applet.** Charts are rows now, so "star this
  build plan" is the same idea one level down and probably what people actually
  want once there are five charts. Needs a second column, or a `kind` on the
  existing one.
- **Reorder favourites by dragging.** The column is an ordered array already and
  the server keeps click order, so this is a UI change and one endpoint.

---

### `/api/dashboard` is a dozen round trips  🐌
Not urgent, but worth knowing about. Every tile does its own Supabase queries,
sequentially, and the endpoint now waits on roughly a dozen before it answers.
Independence is deliberate: one failing table nulls one tile instead of blanking
the page, but the calls are independent too, and nothing makes them wait for
each other.

This surfaced as a *test* failure rather than a complaint: `suite-pages` asserted
on the dashboard after a fixed 1.75s and started reading an undrawn page on a
busy runner. The suite waits for the page's own signal now (`waitFor` in
`tests/lib.js`), so it is honest either way, but the endpoint is genuinely slow
on a cold connection and the fix is small: gather the tiles concurrently
(`asyncio.to_thread` per tile, or one `Promise.all`-shaped batch) and keep the
per-tile isolation. Worth doing before the feed or the tiles grow again.

---

### Teams notifications  🔔
*Highest value per line of code on this list.*

Everything above assumes people visit the site. They won't, reliably, but they
are in Teams all day. An **Incoming Webhook** (or Power Automate) per channel and
the app can push:

- "🛒 Shop run closes in 1 hour: 3 requests pending"
- "🔴 Chassis task blocked: waiting on M6 bolts"
- "📋 Nobody has logged attendance for tomorrow"
- "✅ Aoife finished the accumulator container"
- Weekly Monday digest: what moved, what's late, who's in this week

This inverts the adoption problem. Instead of asking people to come to the app,
the app goes to where they already are, and every message is a deep link back.
It's one webhook URL in an env var and a small `notify()` helper.

---

## Purchase Requests & Reimbursements  🧾  *(designed 2026-09-01, not built)*

**Deliberately not a generalisation of `comp_requests`.** That table is a shop
run for a competition weekend: it splits one cost between several people and
computes who owes whom. This is the opposite shape — the club owes the buyer,
there is exactly one creditor, and nobody owes anybody. Sharing a table would
drag the split/debt logic into something that must never have it. The Tier 2
"Inventory & Orders" entry below claims `comp_requests` is 80% of this. It is
not; see the correction there.

### Two documents, not one

The mistake every homegrown version of this makes is merging them:

| | Purchase Request | Reimbursement Claim |
|---|---|---|
| asks | "may I buy this?" | "pay me back for this" |
| filed | *before* money moves | *after* money moves |
| by | the member who needs it | the person out of pocket |
| approval means | authority to commit funds | the spend was real |
| needs | a justification | a receipt |

**The requester and the claimant are usually different people** — a member asks
for a part, a captain buys it on their own card. That is the whole reason these
cannot be one record. The link is many-to-one: one Amazon order settles five
approved requests.

### Approval: dual authorisation, sequential

No budgets exist and none are agreed, so there are **no spend limits, no
thresholds and no tiered routing**. Approval is amount-independent. Every
request needs two approvals, in this order:

1. **Captain of the requester's department** — *does this team need it?*
2. **Ops Captain** — *should the club spend this?*

Department first, so the Ops Captain's queue only ever holds things a department
has already backed. Two different questions; neither approver can answer the
other's, which is why real systems separate line approval from finance approval.

**The fallthrough rule.** Both slots must be filled by two *distinct* people,
neither of them the requester. Where a slot would land on the requester, or on
whoever already filled the other slot, it falls through to any other captain.
One rule, no special cases, and it covers all three collapses: an Ops member's
request (both slots would be the Ops Captain), the Ops Captain's own request
(no slots), and a captain requesting for their own department.

### Captaincy has to become a real permission

There is no "captain of a department" in the schema, and `profile_details.role_label`
must not become one — 003 says it outright: *"Relevance, never permission."*
Someone typing "Captain" into their profile cannot gain approval rights.

So: a mapping of subteam → account, plus a flag for the ops-captain slot, both
editable from `/admin`. **Data, not code.** `SUBTEAMS` is a Python list in
main.py and captains change every September; handing over the role must not be
a deploy.

### Tables

    purchase_requests     PR-2627-014 · requester · item · why · qty ·
                          est. cost · supplier link · needed-by ·
                          subsystem · status
    purchase_events       append-only: actor, action, from → to status, at
    reimbursements        RC-2627-003 · claimant · total · currency ·
                          fx_rate_used · receipts · paid_at · paid_ref
    reimbursement_lines   line → purchase_request (nullable) · actual cost

`purchase_events` is the same call `activity_log` (002) made, and the audit log
is the specific thing this file already credits for why the PT plan survived and
the Notion tracker did not. Approvals are appended, never updated. An amount
changing after approval reopens it.

### What a member sees

Five fields, one screen: what, what for, how many and roughly how much, link,
needed by. Subsystem prefills from their subteam. Routing, the fallthrough rule
and the event log are all invisible to them.

Then the part that decides whether people keep filing requests: **a timeline
with names in it.** "Waiting on Alexandra" beats "Pending approval"; "Bought by
Cian, 14 Sep, €38.40, claim RC-003, unpaid" beats a status chip. The universal
complaint about corporate procurement is *where has my request gone*, and it is
the one thing worth beating Oracle at.

### Queue: batch approve

Dual approval on every request means two humans must act on a €6 bolt order.
That is the main way this stalls, so the queue takes a checkbox column and
approves several at once — **each still written as its own audited event**. One
click, three rows in `purchase_events`.

### Claims without a request

Allowed, and flagged. People buy an M6 bolt without filing a form; a system that
forbids it pushes the spend off-book rather than eliminating it. A claim line
with no linked request shows as unapproved spend and needs **the same two
approvals, applied after the fact** — same rule, same people, no new concept.

### Keep the subsystem tag even though there is no budget

One prefilled dropdown now is the entire input to the Budget applet and the **FS
Cost Event** submission later. Capture it from day one and both come free; skip
it and it is a season of receipts reconstructed by hand next June.

### Two things that decide whether this survives

**Receipts need a backup, not just a home.** `/app/uploads/receipts/` behind the
auth middleware, same mounted volume as avatars — but this repo already calls the
homeserver's SD card the least reliable component in the stack. Losing an avatar
is nothing; losing a season of receipts before the Cost Event is not. The
systemd timer + `notify-failure` plumbing from the keepalive work is already
there and a nightly backup slots straight into it.

**Without notification this dies in March**, for the exact reason the Notion
tracker did: an approval queue nobody is pinged about is a queue nobody clears,
and members go back to just buying things. Teams notifications is already ranked
above this in the order below, and for this applet it is a dependency rather
than a nice-to-have.

The other half is policy, not code, and it is free: **no reimbursement without a
claim in the system.** Say that once and the tool is load-bearing on day one —
which is precisely what the Notion tracker never was.

### Before any of this is built

`/comp/api/requests/update` (main.py) **has no permission check at all**. Any
signed-in member can set any request's `price`, `status` and `bought_by`, and
those three fields are the whole input to the expense and debt calculation, so
anyone can mint a debt in their own favour. `edit` and `delete` are weaker
still: they trust a `name` from the request body — the identical bug already
found and fixed in attendance, never applied here. Unrelated to the new applet,
but it is live, and it is money.

---

## Tier 2: once Tier 1 has stuck

### Inventory & Orders  📦
Extend the comp-hub shop-run idea to the whole year. Every FS team loses parts
and re-buys things it already owns.

- Request → approved → ordered → arrived → in stock
- Where it physically lives (shelf/bin)
- Link to the supplier order + tracking
- Low-stock flags for consumables

~~`comp_requests` is already 80% of the request half of this.~~ **Corrected
2026-09-01.** It is not, and the request half has since been designed as its own
applet — see "Purchase Requests & Reimbursements" above. `comp_requests` splits a
cost between people and computes who owes whom; that logic belongs to a
competition shop run and nowhere else. What is left for this entry is the half
that entry actually names: **where the thing physically lives** once it arrives,
and low-stock flags. Build it on top of the new tables, not on `comp_requests`.

### Budget  💷
Per-subsystem season budget vs spend-to-date. The treasurer needs it, and the
**FS Cost Event** requires the data anyway, so it's not overhead. It's a
deliverable we currently assemble by hand at the end.

~~`comp_expenses` already does splitting and GBP→EUR.~~ **Corrected 2026-09-01.**
There is no `comp_expenses` table. `/comp/api/expenses` derives it on every call
from `comp_requests` rows with `status = 'bought'`, and the splitting it does is
member-owes-member, not budget-vs-spend. The real input to this is
`reimbursement_lines.subsystem` from the applet above — which is why that tag is
captured from day one even though no budget exists yet.

### Scrutineering checklist  ✅
Very FS-specific and very deadline-driven. Teams fail at scrutineering, not at
design. A checklist built from the FSUK rules (we already keep
`fsuk-2026-rules-v1.pdf` in `circuits/`), tracking for each requirement:

- rule reference
- status: not started / in progress / evidence attached / signed off
- evidence link (photo, test result, Teams doc)
- who signed it off

EV items especially: TSAL, BSPD, IMD, shutdown circuit, precharge, accumulator,
which map directly onto the `circuits/` KiCad projects already in the repo.
Turning "we think we comply" into "here is the evidence" is worth real points.

---

## Tier 3: good ideas, no rush

- **Design decision log**: what we chose, what we rejected, why. Judges ask
  "why" at Design Event and we currently reconstruct it from memory in June.
  Lightweight: title, options, decision, rationale, date, who.
- **Testing log**: test sessions, what ran, faults found, links to attendance
  (who was there) and build plans (what it unblocks).
- ~~**Onboarding trail**~~ **promoted out of Tier 3, 2026-09-01** — "no rush" was
  wrong about the one item on this file with a deadline. A "start here" for
  September: safety induction, tools training, who's who, first task. Pairs
  naturally with Team Profiles, and extends `UCDFS.onboard()` rather than
  starting fresh. See step 3b in the order at the bottom.
- **Sponsor tracker**: contacted / in talks / signed, tier, deliverables owed
  (logo placement, social posts). Gives the business side a tool of their own.
- **Car status board**: one page aggregating subsystem readiness. "Is the car
  drivable this weekend?" answered without asking five people.

---

## Finish before starting

**The Wiring Harness Mapper: audited and fixed, 2026-07-28.** The "incomplete"
label was wrong, and worth correcting because it was steering the roadmap. The
tool is feature-complete (canvas, splices, nets, DRC, BOM, KiCad import, four
CSV/YAML exports, five print reports, live multiplayer, revisions, library).
What it had instead was **defects in the numbers people would have ordered from**:

- **DTM connectors emitted Deutsch DT part numbers.** DTM is the smaller
  sibling with its own housings, its own wedgelock and size-20 contacts.
  Ordering from that BOM got you parts that do not physically fit.
- **12 of 34 connector types produced no BOM lines at all**, silently,
  Superseal (all 6), AMPSEAL, Micro-Fit, stud, splice, header, custom. You'd
  have ordered wire and nothing to crimp it into.

Both fixed. `connParts()` now guarantees every connector yields at least one
line; where a part number can't be derived it emits `(specify)` and the rule
check lists it, rather than the connector vanishing. Two new rule-check
categories: **Contacts** (wire gauge vs the contact's crimp range) and
**Parts** (connectors with no number). `tests/suite-harness.js` (40 checks)
pins all of it.

**Topology model landed 2026-07-28.** The tool was wire-centric: a wire went
pin→pin and its bezier waypoints were decoration. Professional harness tools are
topology-centric, and that difference is what separates a drawing *of* the
design from the design itself. Added, additively:

- `nodes` (breakouts) and `segments` (runs between anchors); wires gain
  `route: [segmentId]` and are drawn *through* their segments.
- **Lengths are derived.** `wireLenMm()` sums the route; change a branch and
  every wire through it updates. `lenManual` pins a measured value. This is the
  correctness win: hand-typed lengths drift and produce wrong cut lists.
- BFS auto-router, plus **Build topology from wires** which gives an existing
  design a formboard in one action.
- Bundle casings that branch, drafting dimensions with terminators, wire label
  tags. Bundle ⌀ comes from the wires actually inside the segment.
- Unrouted wires behave exactly as before, so old documents load unchanged.

63 checks in `tests/suite-harness.js`. Puppeteer is now a tests/ dev dependency
so this stuff can be screenshot-verified rather than guessed at.

### Next on harness, in order

1. **Clips, sleeving and tape at a distance along a segment.** The model now has
   somewhere to attach them; the BOM already lists them as untargeted
   consumables. This is the cheapest remaining win.
2. **Connector face views**: the cavity diagram beside each connector. Half of
   it exists in `repPinout()` already.
3. **It still holds exactly one harness.** `HARNESS_DOC_ID="main"` is hardcoded,
   so there can never be an LV harness *and* an HV harness. Same `plan_id`
   generalisation as Build Plans. Do both at once.
4. **Versions out of the document.** Revisions live *inside* the doc JSON, so
   the blob grows without bound and every save rewrites the whole history. Wants
   an append-only `harness_version` table. (Supabase, not the homeserver, since the
   SD card is the least reliable component in the stack.)
5. **Library is `localStorage`**: templates never reach a teammate. This is the
   one thing Harness Hive genuinely has that we don't: a shared parts library.
6. **No cost field**, so the BOM can't total a spend (pairs with Budget, Tier 2).
7. **Docs viewer**: a document mode with live-embedded views of the BOM and
   drawing. The cleverest idea in Harness Hive: the embed is the live object,
   not a screenshot of one.

~~Also outstanding from the auth work~~ (✅ all three done 2026-07-28):
- ~~Assign `committee`/`admin` roles, then drop `COMP_ADMIN_PASSWORD`~~. The
  password is gone from the code, the config and the Comp Hub UI. Roles are
  handed out from **`/admin`**, so granting access no longer means an UPDATE in
  the SQL editor, which is why nobody did it.
- ~~Add `requires_role` to registry entries~~. `_may_open()` enforces it on the
  page route *and* `/api/applets`, so a gated applet is omitted rather than
  shown as a tile that refuses you. `/admin` is the first entry to use it.
- ~~Move the Supabase keys out of `docker-compose.yml`~~. Now `env_file: .env`,
  and `tests/suite-static.sh` asserts no key ever reappears inline.

**God mode** (`migrations/004`, applied). The site calls it **Admin override**;
"god mode" is the name in the code and schema. `profiles.role = 'admin'` is the
capability; `profiles.god_mode` is whether it is switched on. Elevated you can
edit anyone's profile, remove anyone's photo and write or delete anyone's
attendance row; switched off you are an ordinary member, which is the only way
to check what the team actually sees. A banner sits on every page while it is
on, with a one-click way out. `tests/suite-admin.js` has 48 checks, mostly
negatives.

**While wiring that up: attendance had no server-side ownership check at all.**
`/api/log` and `/api/log/delete` took a name from the request body and wrote it.
The page only drew edit buttons on your own row, so it looked enforced, but any
signed-in member could delete anybody's day with one fetch. Fixed, case-folded,
with god mode as the only override.

---

## Explicitly not building

- **Chat**: Teams.
- **File storage / wiki**: Teams and SharePoint. Link into them, don't mirror
  them. Mirrored files go stale and then actively mislead.
- **Calendar**: Outlook. A read-only "next 3 events" strip on the dashboard is
  fine; owning the calendar is not.
- **A generic task tracker**: see the Notion post-mortem above. Domain-shaped
  build plans instead.

---

## Suggested order

1. ~~Dashboard wins: countdown, activity feed, who's in now~~ ✅
   *(set the real FSUK date to finish)*
2. ~~**Subteams**: profile field + registry tags + dashboard filter~~ ✅
3. ~~**Team Profiles**: ship for September recruitment~~ ✅ built; the
   remaining work is content, not code. Seed a few real profiles before
   September so the grid isn't empty on day one
3b. **Onboarding walkthrough**: extend `UCDFS.onboard()` past the subteam and
   profile steps into a proper first-run trail  *(days)* — **do this first.**
   Added 2026-09-01. It is the only item on this list with an expiry date:
   September *is* the intake, and a walkthrough shipped in November is worth a
   fraction of one shipped in three weeks. Everything else is worth the same
   later as now. Seed a few real profiles alongside it, or it lands people on an
   empty directory.
   *Keep it unavoidable, not unskippable* — it returns until finished rather
   than trapping someone who opened the site to check a workshop time. The
   non-blocking rule at `api_profile_subteam` is deliberate and September is
   exactly when it earns out.

4. **Teams notifications**: make everything else visible  *(days)*
   *Profiles only pay off if people open the site, and this is what makes them.
   Also a hard dependency of Purchase Requests — see that section.*
5. ~~Finish the Wiring Harness Mapper~~ ✅ audited + BOM/rule-check defects fixed.
   Remaining: multiple harnesses, server-side library, cost
6. **Build Plans**: generalise PT, land it before the design phase ends so it's
   in place *before* the March crunch that killed the last one
7. **Purchase Requests & Reimbursements**: designed 2026-09-01, spec above.
   Wants Teams notifications (4) in place first, or the approval queue stalls.
8. Inventory & Orders (now just the *where does it live* half), then Budget
9. Scrutineering checklist: start it by January, not May

Out of band, whenever: **`/comp/api/requests/update` has no permission check.**
Small, live, and it is money. See the end of the Purchase Requests section.
