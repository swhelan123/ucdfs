/* Every page loads and wires itself up without throwing.
 *
 * Catches the class of bug that static checks miss: markup removed while the JS
 * that reaches for it stays behind. That is exactly how the old attendance
 * "plans launcher" broke — the element went, its event wiring did not, and the
 * page threw on load.
 */
const { check, summary, open, signUp } = require('./lib');

const PAGES = [
  { path: '/',           name: 'dashboard'  },
  { path: '/attendance', name: 'attendance' },
  { path: '/comp',       name: 'comp'       },
  { path: '/pt',         name: 'pt'         },
  { path: '/harness',    name: 'harness'    },
];

(async () => {
  const { setCookies } = await signUp('Page', 'Check');

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
    w.close();
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
