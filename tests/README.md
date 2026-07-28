# Tests

```bash
./tests/run.sh                  # everything (~2 min)
./tests/run.sh static           # instant, no container needed
./tests/run.sh auth pages       # pick suites
./tests/run.sh --keep           # leave the test container up to poke at
```

First run does an `npm install` in `tests/` for jsdom. Nothing else to set up.

## How it works

A throwaway container is built from the working tree and served on **:3979**.
The live container on **:3978 is never touched** — you can run the tests against
production data while the team is using the site.

Test accounts are created against the real Supabase project (there is no
separate test project) using the `ucdfs-test-` prefix, and deleted on exit via
the GoTrue admin API. Cleanup is guarded twice: the prefix filter, then a
per-user re-check. It reports what it removed and how many real accounts it left
alone.

## The suites

| suite | what it protects |
|---|---|
| `static` | Python + JS parse; every CSS class used is defined; no secrets in committed files |
| `auth` | signup, cookie flags, route protection, domain gate, a real write, login/logout |
| `pages` | every page loads and wires up without throwing; dashboard tiles populate |
| `login` | the sign-in screen picks the right form on any device |
| `comp` | the shared-CSS class rename held; all four tabs render |
| `harness` | the numbers people order parts from: nets, rule check, BOM, exports, reports |

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
  12 of 34 connector types produced no BOM lines at all — silently. `harness`
  covers both, and asserts every type yields a line.
- **A class rename left an unstyled page.** 187 class attributes changed when
  `comp.html` moved onto `shared.css`; a missed one renders as plain HTML that
  nothing else would flag. `static` and `comp` both check.

## Writing new ones

`lib.sh` (bash) and `lib.js` (jsdom) hold the shared helpers. Two things worth
knowing before you add a browser test:

- **Seed cookies before the page loads.** `beforeParse` runs *after* the response
  arrives, so a session set there is too late — the server has already redirected
  to `/login`. Pass raw `Set-Cookie` strings via `open({ setCookies })`; `signUp()`
  returns them ready to use.
- **Click the button, don't dispatch a `submit` event.** jsdom does not reliably
  run submit listeners for a hand-built `Event('submit')`. Use `submit(d)`.

A third, specific to `harness`: the page's top-level `let DOC` / `const wmap`
are global **lexical** bindings, not properties of `window`. Assigning
`w.DOC = …` silently creates an unrelated property and every later assertion
passes vacuously against the real document. Drive that page through `w.eval()`.
And never let it save — `/harness/api/save` overwrites the team's single live
harness; the suite stubs it and asserts the stub held.

Always assert you are on the page you think you are. A test that silently ends up
on `/login` will pass every check vacuously.
