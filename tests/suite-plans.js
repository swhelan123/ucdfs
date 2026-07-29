/* Build plans — one canvas, many plans, sections drawn by whoever owns them.
 *
 * Guards two seams:
 *
 *   the plan seam (migrations/005 + the PLANS registry) — the id whitelist,
 *   the legacy default (no plan means "pt", so pre-multi-plan clients keep
 *   working), and above all isolation: a node created, ticked or deleted on
 *   one plan must never appear on another. That is what would catch the
 *   classic failure, a forgotten .eq() quietly acting across every plan.
 *
 *   the section seam (migrations/006) — sections are rows now, so the legacy
 *   plan's seven boxes have to survive the move out of Python with their
 *   geometry intact, and the create/rename/move/delete cycle has to hold. The
 *   refusal to delete a section that still holds tasks is the one that matters:
 *   nothing in the app can put an orphaned task back in a box.
 *
 * Writes go only to the pt-2627 plan and are removed afterwards; the
 * pt_done_log lines are tidied by cleanup_pt_done_log in lib.sh, keyed on the
 * "Plans Check" actor in TEST_ACTORS.
 */
const { BASE, check, summary, signUp } = require('./lib');

const LEGACY_SECTIONS = ['lv', 'tdp', 'tsac', 'cc', 'bp', 'sw', 'hv'];

(async () => {
  const a = await signUp('Plans', 'Check');
  const hdr = { Cookie: a.setCookies.map(c => c.split(';')[0]).join('; ') };
  const post = (path, body) => fetch(BASE + path, {
    method: 'POST', headers: { ...hdr, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const state = async (plan) => {
    const q = plan ? '?plan=' + encodeURIComponent(plan) : '';
    return (await fetch(BASE + '/pt/api/state' + q, { headers: hdr })).json();
  };

  console.log('the plan whitelist');
  const bogus = await fetch(BASE + '/pt/api/state?plan=not-a-plan', { headers: hdr });
  check('unknown plan is a 400', bogus.status === 400, 'got ' + bogus.status);
  const bogusWrite = await post('/pt/api/nodes',
    { plan: 'not-a-plan', label: 'x', sec: 'y' });
  check('unknown plan cannot be written to', bogusWrite.status === 400,
    'got ' + bogusWrite.status);

  console.log('\nthe legacy default');
  const legacy = await state();
  check('plan omitted means the legacy plan',
    legacy.plan && legacy.plan.id === 'pt',
    JSON.stringify(legacy.plan || null).slice(0, 60));
  // Sections moved from PLANS into the database in 006. The 25/26 tasks are
  // stored against these ids, so losing one orphans everything in that box.
  const secIds = (legacy.sections || []).map(s => s.sec);
  check('legacy sections survived the move to the database',
    LEGACY_SECTIONS.every(id => secIds.includes(id)), secIds.join(','));
  const lv = (legacy.sections || []).find(s => s.sec === 'lv');
  check('and carry a label and real geometry',
    !!lv && lv.label === 'Low Voltage Wiring' &&
    typeof lv.x === 'number' && typeof lv.y === 'number' &&
    lv.w > 0 && lv.h > 0,
    JSON.stringify(lv || null));
  check('plan meta no longer carries sections',
    legacy.plan && legacy.plan.sections === undefined);

  console.log('\nthe 26/27 plan');
  const next = await state('pt-2627');
  check('state serves it', next.plan && next.plan.id === 'pt-2627');
  const page = await fetch(BASE + '/plan/pt-2627', { headers: hdr, redirect: 'manual' });
  const body = page.status === 200 ? await page.text() : '';
  check('/plan/pt-2627 serves the canvas signed in',
    page.status === 200 && body.includes('id="canvas"'), 'status ' + page.status);
  const anon = await fetch(BASE + '/plan/pt-2627', { redirect: 'manual' });
  check('signed out it redirects to login',
    anon.status >= 300 && anon.status < 400 &&
    /\/login/.test(anon.headers.get('location') || ''),
    'status ' + anon.status);

  console.log('\nsections are made from the canvas');
  const noLabel = await post('/pt/api/sections/add', { plan: 'pt-2627', label: '  ' });
  check('a section needs a label', noLabel.status === 400, 'got ' + noLabel.status);

  const made = await (await post('/pt/api/sections/add',
    { plan: 'pt-2627', label: 'ucdfs-test section', x: 48, y: 543, w: 498, h: 523 })).json();
  const sec = made.section && made.section.sec;
  check('section created', !!sec, JSON.stringify(made).slice(0, 80));
  check('with a server-minted id', /^sec_/.test(sec || ''), sec);

  let s27 = await state('pt-2627');
  let sPt = await state();
  check('it shows on its own plan', (s27.sections || []).some(s => s.sec === sec));
  check('and not on the legacy plan', !(sPt.sections || []).some(s => s.sec === sec));

  await post('/pt/api/sections', { plan: 'pt-2627', sec, label: 'ucdfs-test renamed' });
  await post('/pt/api/sections', { plan: 'pt-2627', sec, x: 300, y: 400, w: 600, h: 620 });
  s27 = await state('pt-2627');
  const moved = (s27.sections || []).find(s => s.sec === sec);
  check('rename, move and resize all persist',
    !!moved && moved.label === 'ucdfs-test renamed' &&
    moved.x === 300 && moved.y === 400 && moved.w === 600 && moved.h === 620,
    JSON.stringify(moved || null));

  // A box is a floor, not a suggestion: below the minimum the tasks inside
  // stop fitting and the resize handle becomes unreachable.
  await post('/pt/api/sections', { plan: 'pt-2627', sec, w: 10, h: 10 });
  s27 = await state('pt-2627');
  const floored = (s27.sections || []).find(s => s.sec === sec);
  check('a section cannot be shrunk below its minimum',
    !!floored && floored.w >= 200 && floored.h >= 150,
    JSON.stringify(floored || null));

  const phantom = await post('/pt/api/sections',
    { plan: 'pt-2627', sec: 'sec_nope', label: 'phantom' });
  s27 = await state('pt-2627');
  check('updating an unknown section creates nothing',
    phantom.ok && !(s27.sections || []).some(s => s.sec === 'sec_nope'));

  console.log('\nisolation between plans');
  const node = await (await post('/pt/api/nodes',
    { plan: 'pt-2627', label: 'ucdfs-test task', sec, type: 'm', x: 200, y: 900 })).json();
  const nid = node.node && node.node.id;
  check('task created on pt-2627', !!nid, JSON.stringify(node).slice(0, 60));

  s27 = await state('pt-2627');
  sPt = await state();
  check('task visible on its own plan', s27.nodes.some(n => n.id === nid));
  check('task absent from the legacy plan', !sPt.nodes.some(n => n.id === nid));

  await post('/pt/api/toggle',
    { plan: 'pt-2627', node_id: nid, done: true, user_name: 'Plans Check' });
  s27 = await state('pt-2627');
  sPt = await state();
  check('tick lands on its own plan', s27.done.includes(nid));
  check('tick absent from the legacy plan', !sPt.done.includes(nid));
  check('tick logged on its own plan',
    s27.done_log.some(l => l.node_id === nid && l.done));
  check('log line absent from the legacy plan',
    !sPt.done_log.some(l => l.node_id === nid));

  console.log('\na section holding tasks cannot be deleted');
  const refused = await post('/pt/api/sections/delete', { plan: 'pt-2627', sec });
  check('delete refused while a task is inside', refused.status === 400,
    'got ' + refused.status);
  s27 = await state('pt-2627');
  check('and the section is still there', (s27.sections || []).some(s => s.sec === sec));

  // Untick, delete the task, then the box — leaving the plan as it was found.
  await post('/pt/api/toggle',
    { plan: 'pt-2627', node_id: nid, done: false, user_name: 'Plans Check' });
  check('cleanup: task deleted',
    (await post('/pt/api/nodes/delete', { plan: 'pt-2627', id: nid })).ok);
  check('cleanup: empty section deleted',
    (await post('/pt/api/sections/delete', { plan: 'pt-2627', sec })).ok);
  s27 = await state('pt-2627');
  check('cleanup: plan state clear of both',
    !s27.nodes.some(n => n.id === nid) &&
    !(s27.sections || []).some(s => s.sec === sec) &&
    !s27.done.includes(nid));

  process.exit(summary('plans') ? 1 : 0);
})().catch(e => { console.error('  suite crashed:', e.message); process.exit(1); });
