# Tests

```bash
./tests/run.sh                  # everything (~2 min)
./tests/run.sh static           # instant, no container needed
./tests/run.sh auth pages       # pick suites
./tests/run.sh --keep           # leave the test container up to poke at
```

First run does an `npm install` in `tests/` for jsdom and Puppeteer. Nothing
else to set up.

Puppeteer is there for visual work: jsdom has no layout, so anything about how
the canvas actually *looks* (bundle casings, dimensions, label tags) has to be
screenshotted and looked at rather than asserted. Drive it the same way
`suite-harness.js` does: stub `/harness/api/save` first.

## How it works

Runs are **serialised by a lock** (`/tmp/ucdfs-tests.lock`). CI runs on a
self-hosted runner on this same machine and uses this same script, so a local
run started while CI is going would otherwise `docker rm -f` CI's container out
from under it — and the failure looks like a bug in whatever branch CI was
testing, not like a collision. If a run says it is waiting, that is CI, or
another terminal; `lsof /tmp/ucdfs-tests.lock` says which.

A throwaway container is built from the working tree and served on **:3979**.
The live container on **:3978 is never touched**.

**The suites run against `ucdfs-nonprod`, not production.** `load_env` reads
`.env.nonprod` and refuses any file labelled `UCDFS_ENV=prod`. These tests sign
up accounts, write attendance and assert that deletion works, which against the
live database is real people's history. Overriding it takes both
`UCDFS_ENV_FILE` and `UCDFS_ALLOW_PROD_TESTS=1`, deliberately, because "just
this once against prod" is how somebody's attendance gets deleted by a test
proving that deletion works.

They did run against production until 2026-07-28, and the cleanup below was
load-bearing rather than a safety net. It is kept because a second line of
defence costs nothing:

Test accounts use the `ucdfs-test-` prefix and are deleted on exit via the
GoTrue admin API. Cleanup is guarded twice: the prefix filter, then a per-user
re-check. It reports what it removed and how many other accounts it left alone.

Feed lines are cleaned up too. `activity_log` stores the actor as text captured
at write time, on purpose, so a line still reads correctly after the account it
names is gone, which means deleting the test *accounts* would otherwise leave
their lines sitting on the dashboard, pushing real activity off the homepage.
`cleanup_activity_log()` removes rows written **during this run** by the known
test display names; both conditions are required. Add a name to `TEST_ACTORS` in
`lib.sh` if you add a `signUp()` with a new one.

## The suites

| suite | what it protects |
|---|---|
| `static` | Python + JS parse; every CSS class used is defined; no secrets in committed files |
| `auth` | signup, cookie flags, route protection, domain gate, a real write, login/logout |
| `pages` | every page loads and wires up without throwing; dashboard tiles populate |
| `login` | the sign-in screen picks the right form on any device |
| `comp` | the shared-CSS class rename held; all four tabs render |
| `harness` | the numbers people order parts from: nets, rule check, BOM, exports, reports |
| `profiles` | subteam tags stay honest and never hide a tool; profile saves are self-only; photos are members-only |
| `admin` | the permission boundary: what a member is refused, what an un-elevated admin is refused, and that god mode can always be switched back on |
| `plans` | charts as rows: the id whitelist, server-minted ids, and that a chart holding work cannot be deleted |
| `links` | admin-managed hyperlink cards and the blocks they sit in: above all that a url's scheme is whitelisted, since an href dispatches on protocol and escaping does not touch it, and that a block holding cards cannot be deleted |

## Regressions these exist to catch

Each of these was a real bug found during development, not a hypothetical:

- **Markup removed, JS left behind.** The attendance page's floating launcher was
  deleted but its event wiring stayed; the page threw on load. `pages` catches it.
- **The anon key could write to the database.** Before RLS, `POST /attendance`
  with the public key returned `201 Created`. `auth` asserts the lockdown holds.
- **Signing in on a second device pushed you through signup.** The login screen
  guessed "new user" from a per-device localStorage name. `login` covers all five
  device states.
- **The harness BOM ordered parts that don't fit.** DTM connectors emitted
  Deutsch DT part numbers (different series, size-16 vs size-20 contacts), and
  12 of 34 connector types produced no BOM lines at all, silently. `harness`
  covers both, and asserts every type yields a line.
- **A subteam tag that names nothing.** `"subteams": ["powertrain"]` instead of
  `["pt"]` removes an applet from every filter chip including its own, and
  nothing errors. The card simply stops appearing. `profiles` asserts every tag
  resolves and that every applet is reachable under some chip.
- **A filter that hid something.** Tags are relevance, not permission. `profiles`
  checks that an `all`-tagged tool survives every chip and that a member of one
  subteam can still open another's applet.
- **Hiding a control is not a permission.** `/api/log` and `/api/log/delete`
  took a name from the request body, so any signed-in member could delete
  anybody's attendance with one fetch. The page just didn't draw the button.
  `admin` asserts ownership is enforced server-side.
- **A one-way door out of your own admin rights.** God mode gates everything
  except its own toggle; if that endpoint ever starts requiring god mode, an
  admin who switches off cannot switch back on. `admin` asserts the way back.
- **A class rename left an unstyled page.** 187 class attributes changed when
  `comp.html` moved onto `shared.css`; a missed one renders as plain HTML that
  nothing else would flag. `static` and `comp` both check.

## Writing new ones

`lib.sh` (bash) and `lib.js` (jsdom) hold the shared helpers. Two things worth
knowing before you add a browser test:

- **Seed cookies before the page loads.** `beforeParse` runs *after* the response
  arrives, so a session set there is too late. The server has already redirected
  to `/login`. Pass raw `Set-Cookie` strings via `open({ setCookies })`; `signUp()`
  returns them ready to use.
- **Click the button, don't dispatch a `submit` event.** jsdom does not reliably
  run submit listeners for a hand-built `Event('submit')`. Use `submit(d)`.

A third, specific to `harness`: the page's top-level `let DOC` / `const wmap`
are global **lexical** bindings, not properties of `window`. Assigning
`w.DOC = …` silently creates an unrelated property and every later assertion
passes vacuously against the real document. Drive that page through `w.eval()`.
And never let it save: `/harness/api/save` overwrites the team's single live
harness; the suite stubs it and asserts the stub held.

Always assert you are on the page you think you are. A test that silently ends up
on `/login` will pass every check vacuously.
