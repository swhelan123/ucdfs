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
      w.fetch = (u, o = {}) => fetch(new URL(u, BASE).href, {
        ...o,
        headers: { ...(o.headers || {}), ...(cookieHeader ? { cookie: cookieHeader } : {}) },
      });
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
  const r = await fetch(BASE + '/api/auth/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ first_name: first, last_name: last, email, password: 'TestPassword123!' }),
  });
  if (!r.ok) throw new Error('signup failed: ' + r.status + ' ' + await r.text());
  const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (!setCookies.length) throw new Error('signup returned no Set-Cookie headers');
  return { email, setCookies };
}

module.exports = { BASE, check, summary, open, submit, settle, signUp, waitFor };
