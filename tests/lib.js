/* Shared jsdom harness for the browser-side suites.
 *
 * jsdom has no fetch and no layout, so a few things have to be supplied before
 * any page script runs. These are gaps in the test environment, not in the app:
 *   - fetch            jsdom ships none at all
 *   - scrollIntoView   needs layout, which jsdom does not implement
 * Anything else that throws is a real bug and must surface.
 */
const { JSDOM, VirtualConsole, CookieJar } = require('jsdom');

const BASE = process.env.TEST_BASE || 'http://localhost:3979';

let pass = 0, fail = 0;

function check(label, ok, extra = '') {
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !extra ? '' : ': ' + extra}`);
}

function summary(name) {
  console.log(fail ? `\n  ${name}: ${pass} passed, ${fail} FAILED`
                   : `\n  ${name}: ${pass} passed`);
  return fail;
}

/**
 * Load a page and wait for it to settle.
 *
 * @param {string}  path            e.g. '/login'
 * @param {object}  opts.storage    localStorage seed, applied before scripts run
 * @param {string[]} opts.setCookies raw Set-Cookie headers, e.g. from signUp()
 * @param {boolean} opts.failOnPrompt  treat window.prompt() as a test failure
 */
async function open(path, opts = {}) {
  const errors = [];
  // Set by the close() wrapper below, read by the fetch shim. See the note
  // there: a request that lands after the window is gone must not be delivered.
  let closed = false;
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    if (/Not implemented|Could not parse CSS/i.test(e.message)) return;
    errors.push(e.message.split('\n')[0]);
  });
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

  // Cookies must be in the jar BEFORE fromURL fetches the page: beforeParse
  // runs after the response has arrived, so seeding there is too late and the
  // server would have already redirected an "authenticated" request to /login.
  //
  // Raw Set-Cookie strings go in verbatim. The session cookie is a quoted value
  // containing escaped quotes; splitting it apart and re-encoding corrupts it,
  // so let tough-cookie do the parsing it already knows how to do.
  const jar = new CookieJar();
  for (const raw of opts.setCookies || []) {
    try { jar.setCookieSync(raw, BASE); } catch (e) { errors.push('bad cookie: ' + e.message); }
  }

  const dom = await JSDOM.fromURL(BASE + path, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    cookieJar: jar,
    beforeParse(w) {
      // jsdom's fetch does not share the cookie jar, so pass the session on.
      const cookieHeader = jar.getCookieStringSync(BASE);
      // Nothing is delivered to a closed window. jsdom's own fetch is tied to
      // the window lifecycle; this one is node's, swapped in for the cookie jar
      // above, and it does not care that the page it belongs to is gone. So a
      // suite that closes a page with a request still in flight would run the
      // page's own .then() against a torn-down document, where `document` is
      // undefined. That throws from a callback nobody is awaiting, which is an
      // uncaught rejection, which takes the whole suite process down — not one
      // failed check, every check after it, never run.
      //
      // That is what broke CI on the #13 merge: suite-admin closes the
      // dashboard after reading the override banner, boot() was still awaiting
      // its four API calls, and its `finally { reveal() }` landed after the
      // close. It passes on a fast machine and fails on a loaded runner, which
      // is the same slower-runner story waitFor() below was written for.
      //
      // A promise that never settles is the right shape: the page's await
      // simply never resumes, so no page code runs after its window closed.
      // Rejecting instead would be wrong, because a rejection still resumes the
      // page — straight into whatever catch or finally it wrote, which for the
      // dashboard is the `finally { reveal() }` that started all this.
      //
      // **Guarding fetch() alone is not enough**, which is the trap this fell
      // into the first time. Reading a response is two promises, and the app
      // writes both: `.then(r => r.json())` in shared.js. Guarding only the
      // outer one leaves the window between the headers arriving and the body
      // being parsed, and a close landing in there still reaches page code. So
      // the response is handed back wrapped, with every body-reading method
      // guarded the same way.
      const dead = () => new Promise(() => {});
      const guard = p => p.then(
        v => (closed ? dead() : v),
        e => (closed ? dead() : Promise.reject(e)),
      );
      // A plain object, not a subclass or a Proxy over the real Response:
      // Response's accessors are brand-checked, so anything that inherits from
      // one and is not one throws on .status. Nothing in this app asks whether
      // a response `instanceof Response`; it reads these fields and calls one
      // of these methods.
      const wrap = res => ({
        ok: res.ok, status: res.status, statusText: res.statusText,
        headers: res.headers, url: res.url, redirected: res.redirected,
        type: res.type, bodyUsed: res.bodyUsed,
        json: () => guard(res.json()),
        text: () => guard(res.text()),
        blob: () => guard(res.blob()),
        arrayBuffer: () => guard(res.arrayBuffer()),
        formData: () => guard(res.formData()),
        clone: () => wrap(res.clone()),
      });
      w.fetch = (u, o = {}) => guard(fetch(new URL(u, BASE).href, {
        ...o,
        headers: { ...(o.headers || {}), ...(cookieHeader ? { cookie: cookieHeader } : {}) },
      })).then(res => (closed ? dead() : wrap(res)));
      w.Element.prototype.scrollIntoView = function () {};
      w.confirm = () => false;
      w.alert = () => {};
      w.prompt = () => {
        if (opts.failOnPrompt) errors.push('page called prompt() unexpectedly');
        return 'Test User';
      };
      for (const [k, v] of Object.entries(opts.storage || {})) {
        w.localStorage.setItem(k, v);
      }
    },
  });

  const w = dom.window;

  // The flag has to be set before jsdom tears the window down, so that a
  // response arriving during the teardown is already on the dead path.
  const closeWindow = w.close.bind(w);
  w.close = () => { closed = true; closeWindow(); };

  await new Promise(r => w.addEventListener('load', r, { once: true }));
  await settle(w.document);
  return { dom, w, d: w.document, errors };
}

/** Wait for in-flight work: no spinner in the submit button, plus a grace period. */
async function settle(d, ms = 1500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
    const label = d.getElementById('submit-label');
    if (label && !label.querySelector('.spinner')) break;
  }
  await new Promise(r => setTimeout(r, 250));
}

/**
 * Poll until a condition holds, or give up. Returns whether it held.
 *
 * For anything that waits on a network round trip, use this rather than
 * settle()'s fixed window. The dashboard is the cautionary tale: it draws after
 * four API calls, one of which fans out into a dozen Supabase queries, and
 * settle() returns after 1.75s, shorter than the page's own 2.5s reveal
 * fallback. So the suite asserted on a page that had not finished drawing and
 * failed with "0 cards", intermittently, on a runner slightly slower than the
 * last one. A fixed sleep in a test is a deadline the code has to beat, and it
 * gets tighter every time the app grows a query.
 *
 * The predicate throwing counts as "not yet": an element the page has not
 * created is the ordinary case while waiting for it.
 */
async function waitFor(predicate, ms = 8000, step = 50) {
  const deadline = Date.now() + ms;
  for (;;) {
    try { if (predicate()) return true; } catch (e) { /* not yet */ }
    if (Date.now() >= deadline) return false;
    await new Promise(r => setTimeout(r, step));
  }
}

/**
 * Click the submit button and wait for the request to finish.
 *
 * Note: dispatching a synthetic Event('submit') does not reliably run listeners
 * in jsdom. Clicking the type=submit button drives the real path, as a user
 * would. Learned the hard way.
 */
async function submit(d) {
  d.getElementById('submit-btn').click();
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (!d.getElementById('submit-label').querySelector('.spinner')) break;
  }
  await new Promise(r => setTimeout(r, 200));
}

/**
 * Create a throwaway account and return its raw Set-Cookie headers, ready to
 * hand to open({ setCookies }). Accounts use the ucdfs-test- prefix so the
 * runner's cleanup can delete them safely.
 */
async function signUp(first = 'Test', last = 'Bot') {
  const email = `ucdfs-test-${Date.now()}-${Math.floor(Math.random() * 1e5)}@ucdconnect.ie`;
  let r, body = '';
  /* Supabase caps sign-ups per hour per IP, and a full run is close to that cap
     on its own: about two dozen accounts across the suites. CI runs on this
     same machine, so a local run and the CI run that follows it share one
     ceiling, and the second one starts failing partway through.
     
     The retry is for a short burst rather than that hour-long window, which no
     amount of waiting inside one run will clear. What it mostly buys is the
     message below: three suites crashing on "signup failed: 400" reads as a
     code fault, and this says what it actually is. */
  for (let attempt = 0; attempt < 4; attempt++) {
    r = await fetch(BASE + '/api/auth/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ first_name: first, last_name: last, email, password: 'TestPassword123!' }),
    });
    if (r.ok) break;
    body = await r.text();
    if (!/rate limit/i.test(body)) break;
    await new Promise(res => setTimeout(res, 2000 * Math.pow(2, attempt)));
  }
  if (!r.ok && /rate limit/i.test(body)) {
    throw new Error(
      'signup rate-limited by Supabase. A full run creates about two dozen ' +
      'accounts and the cap is per hour per IP, which CI shares with this ' +
      'machine. Wait for the window, or run fewer suites.');
  }
  if (!r.ok) throw new Error('signup failed: ' + r.status + ' ' + body);
  const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (!setCookies.length) throw new Error('signup returned no Set-Cookie headers');
  return { email, setCookies };
}

module.exports = { BASE, check, summary, open, submit, settle, signUp, waitFor };
