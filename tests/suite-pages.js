/* Every page loads and wires itself up without throwing.
 *
 * Catches the class of bug that static checks miss: markup removed while the JS
 * that reaches for it stays behind. That is exactly how the old attendance
 * "plans launcher" broke — the element went, its event wiring did not, and the
 * page threw on load.
 */
const { BASE, check, summary, open, signUp } = require('./lib');

const PAGES = [
  { path: '/',           name: 'dashboard'  },
  { path: '/attendance', name: 'attendance' },
  { path: '/comp',       name: 'comp'       },
  { path: '/pt',         name: 'pt'         },
  { path: '/harness',    name: 'harness'    },
  { path: '/profiles',   name: 'profiles'   },
];

(async () => {
  const { setCookies } = await signUp('Page', 'Check');
  // Same session, as a request header — for the checks that hit the API directly
  // rather than through a page.
  const cookieHeader = setCookies.map(c => c.split(';')[0]).join('; ');

  console.log('signed-in page loads');
  for (const page of PAGES) {
    const { w, d, errors } = await open(page.path, { setCookies, failOnPrompt: true });

    if (typeof w.UCDFS === 'undefined') errors.push('UCDFS runtime not loaded');
    // Assert we are actually on the page under test. Without this a session
    // that failed to apply lands on /login and every check below passes
    // vacuously against the wrong document.
    if (w.location.pathname === '/login' || d.getElementById('auth-form')) {
      errors.push('redirected to /login — the test session did not apply');
    }
    const main = d.getElementById('main');
    if (main && main.style.display === 'none') errors.push('#main still hidden after gate');

    check(`${page.name} loads clean`, errors.length === 0, errors.slice(0, 3).join('; '));
    w.close();
  }

  console.log('\ndashboard content');
  {
    const { w, d, errors } = await open('/', { setCookies, failOnPrompt: true });
    const cards = d.querySelectorAll('#applet-grid .applet');
    check('renders a card per registry entry', cards.length >= 5, `${cards.length} cards`);
    // The grid is filtered by the subteam chips now. A fresh test account has no
    // subteam, so it must land on All and show everything — a default that hid
    // most of the site from a new member would be the worst possible first
    // impression. The filter's own behaviour is covered in suite-profiles.
    check('a new account sees the whole grid, unfiltered',
      cards.length === (await (await fetch(BASE + '/api/applets',
        { headers: { Cookie: cookieHeader } })).json()).applets.length,
      `${cards.length} cards shown`);
    check('greeting personalised', /Page/.test(d.getElementById('greet-hi').textContent),
      d.getElementById('greet-hi').textContent);
    const stats = [...d.querySelectorAll('.applet-stat')].map(e => e.textContent.trim());
    check('live tiles populated', stats.length >= 3 && stats.some(s => /%/.test(s)), stats.join(' | '));
    check('headline resolved', !/Loading/.test(d.getElementById('headline').textContent),
      d.getElementById('headline').textContent.replace(/\s+/g, ' ').trim());
    check('external applet opens in a new tab',
      [...cards].some(c => (c.getAttribute('href') || '').startsWith('http') &&
                            c.getAttribute('target') === '_blank'));
    check('no page errors', errors.length === 0, errors.join('; '));

    // ── Countdown ──
    const cd    = d.getElementById('countdown');
    const cdNum = cd.querySelector('.cd-num');
    check('countdown rendered', cd.style.display !== 'none' && !!cdNum,
      cd.textContent.replace(/\s+/g, ' ').trim());
    check('countdown shows a real number of days',
      !!cdNum && /^\d+$/.test(cdNum.textContent.trim()),
      cdNum ? cdNum.textContent.trim() : '(none)');

    // ── Who's in now ──
    // Data-dependent, so assert the invariant instead of a fixed value: the
    // nowbar and the headline must never both narrate the workshop, which is
    // the duplication the headline's !att.now guard exists to prevent.
    const nowbar   = d.getElementById('nowbar');
    const nowShown = nowbar.style.display !== 'none';
    check('nowbar consistent with its content',
      nowShown ? /in the workshop now/.test(nowbar.textContent) : nowbar.innerHTML === '',
      nowShown ? nowbar.textContent.replace(/\s+/g, ' ').trim() : 'hidden (nobody in)');
    check('workshop is narrated in one place only',
      !(nowShown && /in the workshop today/.test(d.getElementById('headline').textContent)));

    // ── Activity feed ──
    // A blank card means the fetch or the render broke; either a row or the
    // empty state is a pass.
    const feed = d.getElementById('feed');
    check('feed resolved to rows or an empty state',
      feed.querySelectorAll('.feed-item').length > 0 || !!feed.querySelector('.empty'),
      `${feed.querySelectorAll('.feed-item').length} rows`);
    w.close();
  }

  console.log('\ndashboard API');
  {
    const r = await fetch(BASE + '/api/dashboard', { headers: { Cookie: cookieHeader } });
    const j = await r.json();

    const cd = j.countdown;
    check('countdown in payload', !!cd && typeof cd.days === 'number',
      cd ? `${cd.days} days to ${cd.name}` : '(missing)');
    // Recompute independently — catches a wrong target date or a sign error
    // that a "looks like a number" check would sail past. One day of slack
    // because the server counts in Europe/Dublin and this runs in the host's
    // timezone; the two legitimately differ for an hour around midnight.
    const expected = Math.round(
      (Date.parse(cd.date + 'T00:00:00Z') - Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z'))
      / 86400000);
    check('countdown arithmetic agrees', Math.abs(cd.days - expected) <= 1,
      `${cd.days} vs ${expected}`);

    const att = j.tiles.attendance;
    check('attendance tile reports who is in now',
      att && typeof att.now === 'number' && Array.isArray(att.here) &&
      att.now === att.here.length && att.now <= att.in,
      att ? `${att.now} now of ${att.in} today` : '(missing)');

    check('activity feed is a list', Array.isArray(j.activity), `${(j.activity || []).length} items`);
    const bad = (j.activity || []).filter(i => !i.actor || !i.verb || !('created_at' in i));
    check('every feed item is complete', bad.length === 0, JSON.stringify(bad[0] || {}));
  }

  console.log('\nattendance behaviour');
  {
    const { w, d, errors } = await open('/attendance', { setCookies, failOnPrompt: true });
    check('day picker built',
      d.querySelectorAll('#day-picker .day-btn').length === 14,
      `${d.querySelectorAll('#day-picker .day-btn').length} buttons`);
    check('a day is selected', !!d.querySelector('#day-picker .day-btn.active'));
    check('list loaded', !/Loading/.test(d.getElementById('attendance-list').textContent));
    check('back-link present', d.querySelector('.back-link[href="/"]') !== null);
    check('no page errors', errors.length === 0, errors.join('; '));
    w.close();
  }

  console.log('\ncanvas tools resolve identity without prompting');
  for (const p of ['/pt', '/harness']) {
    const { w, errors } = await open(p, { setCookies, failOnPrompt: true });
    // viewerName is a top-level `let`, so it is a lexical global rather than a
    // window property and has to be read by evaluating in page scope.
    let viewer = null;
    try { viewer = w.eval('typeof viewerName !== "undefined" ? viewerName : null'); }
    catch (e) { errors.push('could not read viewerName: ' + e.message); }
    check(`${p} identity from session`, viewer === 'Page Check' && errors.length === 0,
      `viewer=${viewer} ${errors.join('; ')}`);
    w.close();
  }

  process.exit(summary('pages') ? 1 : 0);
})().catch(e => { console.error('  suite crashed:', e.message); process.exit(1); });
