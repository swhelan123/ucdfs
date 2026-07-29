/* Build plans — one canvas, many plans.
 *
 * Guards the multi-plan seam (migrations/005 + the PLANS registry): the plan
 * id whitelist, the legacy default (no plan means "pt", so pre-multi-plan
 * clients keep working), and above all isolation — a node created, ticked or
 * deleted on one plan must never appear on another. The isolation checks are
 * the ones that would have caught the classic failure: a forgotten .eq() on
 * one endpoint quietly acting across every plan at once.
 *
 * Writes go only to the pt-2627 plan and are removed afterwards; its
 * pt_done_log lines are tidied by cleanup_pt_done_log in lib.sh, keyed on the
 * "Plans Check" actor in TEST_ACTORS.
 */
const { BASE, check, summary, signUp } = require('./lib');

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
  const legacySecs = (legacy.plan.sections || []).map(s => s.id);
  // Saved 25/26 nodes are stored against these ids; losing one orphans them.
  check('legacy section ids intact',
    ['lv', 'tdp', 'tsac', 'cc', 'bp', 'sw', 'hv'].every(id => legacySecs.includes(id)),
    legacySecs.join(','));

  console.log('\nthe 26/27 plan');
  const next = await state('pt-2627');
  check('state serves it with sections', next.plan && next.plan.id === 'pt-2627' &&
    (next.plan.sections || []).length >= 1);
  const page = await fetch(BASE + '/plan/pt-2627', { headers: hdr, redirect: 'manual' });
  const body = page.status === 200 ? await page.text() : '';
  check('/plan/pt-2627 serves the canvas signed in',
    page.status === 200 && body.includes('id="canvas"'), 'status ' + page.status);
  const anon = await fetch(BASE + '/plan/pt-2627', { redirect: 'manual' });
  check('signed out it redirects to login',
    anon.status >= 300 && anon.status < 400 &&
    /\/login/.test(anon.headers.get('location') || ''),
    'status ' + anon.status);

  console.log('\nisolation between plans');
  const sec = next.plan.sections[0].id;
  const made = await (await post('/pt/api/nodes',
    { plan: 'pt-2627', label: 'ucdfs-test task', sec, type: 'm', x: 200, y: 900 })).json();
  const nid = made.node && made.node.id;
  check('node created on pt-2627', !!nid, JSON.stringify(made).slice(0, 60));

  let s27 = await state('pt-2627');
  let sPt = await state();
  check('node visible on its own plan', s27.nodes.some(n => n.id === nid));
  check('node absent from the legacy plan', !sPt.nodes.some(n => n.id === nid));

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

  // Un-tick, then delete — the suite leaves the plan as it found it (the
  // done_log lines this wrote are removed by cleanup_pt_done_log).
  await post('/pt/api/toggle',
    { plan: 'pt-2627', node_id: nid, done: false, user_name: 'Plans Check' });
  const del = await post('/pt/api/nodes/delete', { plan: 'pt-2627', id: nid });
  check('cleanup: node deleted', del.ok);
  s27 = await state('pt-2627');
  check('cleanup: plan state clear of it',
    !s27.nodes.some(n => n.id === nid) && !s27.done.includes(nid));

  process.exit(summary('plans') ? 1 : 0);
})().catch(e => { console.error('  suite crashed:', e.message); process.exit(1); });
