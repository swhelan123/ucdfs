/* Flowcharts — many charts, one canvas, sections drawn by whoever owns them.
 *
 * Guards three seams, oldest first:
 *
 *   the chart seam (migrations/007) — charts are rows, so the whitelist that
 *   used to be a literal dict is now "does this row exist". A chart id reaches
 *   supabase.table() filters, so an id naming no chart has to be refused, and
 *   ids have to be minted server-side. Plus the two rails on destroying one:
 *   deleting is refused unless the chart is empty, and the caller has to echo
 *   the name back so a stale list cannot delete the wrong chart.
 *
 *   the plan seam (migrations/005) — isolation. A task created, ticked or
 *   deleted on one chart must never appear on another. That is what catches the
 *   classic failure: a forgotten .eq() quietly acting across every chart.
 *
 *   the section seam (migrations/006) — sections are rows, so the legacy plan's
 *   seven boxes have to survive the move out of Python with their geometry
 *   intact, and create/rename/move/delete has to hold. The refusal to delete a
 *   section that still holds tasks matters most: nothing in the app can put an
 *   orphaned task back in a box.
 *
 * Everything is created and removed inside a throwaway chart, so a crash
 * mid-run leaves one obviously-named chart behind on non-prod and nothing else.
 * Its pt_done_log lines are tidied by cleanup_pt_done_log in lib.sh, keyed on
 * the "Plans Check" actor in TEST_ACTORS.
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
  const get   = path => fetch(BASE + path, { headers: hdr }).then(r => r.json());
  const state = plan => get('/pt/api/state' + (plan ? '?plan=' + encodeURIComponent(plan) : ''));

  let chart = null;   // the throwaway chart every write below goes into

  try {
    console.log('charts are rows');
    const listed = await get('/api/plans');
    check('/api/plans lists charts', Array.isArray(listed.plans) && listed.plans.length >= 1,
      JSON.stringify(listed).slice(0, 80));
    const legacyRow = (listed.plans || []).find(p => p.id === 'pt');
    check('the 25/26 plan is there and archived',
      !!legacyRow && legacyRow.archived === true,
      JSON.stringify(legacyRow || null).slice(0, 80));
    check('and reports its task counts',
      !!legacyRow && typeof legacyRow.tasks === 'number' && legacyRow.tasks > 0,
      legacyRow ? String(legacyRow.tasks) : '');

    const noName = await post('/api/plans', { name: '   ' });
    check('a chart needs a name', noName.status === 400, 'got ' + noName.status);

    const made = await (await post('/api/plans',
      { name: 'ucdfs-test chart', icon: '🧪', blurb: 'made by the test suite' })).json();
    chart = made.plan && made.plan.id;
    check('chart created', !!chart, JSON.stringify(made).slice(0, 80));
    check('with a server-minted id', /^chart_/.test(chart || ''), chart);
    check('and starts empty',
      made.plan && made.plan.tasks === 0 && made.plan.archived === false);

    console.log('\nthe whitelist');
    const bogus = await fetch(BASE + '/pt/api/state?plan=not-a-chart', { headers: hdr });
    check('unknown chart is a 400 on read', bogus.status === 400, 'got ' + bogus.status);
    const bogusWrite = await post('/pt/api/nodes',
      { plan: 'not-a-chart', label: 'x', sec: 'y' });
    check('unknown chart cannot be written to', bogusWrite.status === 400,
      'got ' + bogusWrite.status);
    const bogusPage = await fetch(BASE + '/plan/not-a-chart',
      { headers: hdr, redirect: 'manual' });
    check('and its page is a 404, not an editor', bogusPage.status === 404,
      'got ' + bogusPage.status);

    console.log('\nthe legacy default');
    const legacy = await state();
    check('plan omitted still means the 25/26 chart',
      legacy.plan && legacy.plan.id === 'pt',
      JSON.stringify(legacy.plan || null).slice(0, 60));
    check('its name comes from its row',
      legacy.plan && legacy.plan.name === 'PT Manufacturing Plan', legacy.plan.name);
    // Sections moved from PLANS into the database in 006. The 25/26 tasks are
    // stored against these ids, so losing one orphans everything in that box.
    const secIds = (legacy.sections || []).map(s => s.sec);
    check('legacy sections survived the move to the database',
      LEGACY_SECTIONS.every(id => secIds.includes(id)), secIds.join(','));
    const lv = (legacy.sections || []).find(s => s.sec === 'lv');
    check('and carry a label and real geometry',
      !!lv && lv.label === 'Low Voltage Wiring' &&
      typeof lv.x === 'number' && typeof lv.y === 'number' && lv.w > 0 && lv.h > 0,
      JSON.stringify(lv || null));

    console.log('\nthe new chart serves its own canvas');
    const page = await fetch(BASE + '/plan/' + chart, { headers: hdr, redirect: 'manual' });
    const body = page.status === 200 ? await page.text() : '';
    check('signed in it serves the canvas',
      page.status === 200 && body.includes('id="canvas"'), 'status ' + page.status);
    const anon = await fetch(BASE + '/plan/' + chart, { redirect: 'manual' });
    check('signed out it redirects to login',
      anon.status >= 300 && anon.status < 400 &&
      /\/login/.test(anon.headers.get('location') || ''), 'status ' + anon.status);
    const fresh = await state(chart);
    check('and it starts with no sections',
      (fresh.sections || []).length === 0 && (fresh.nodes || []).length === 0);

    console.log('\nsections are made from the canvas');
    const noLabel = await post('/pt/api/sections/add', { plan: chart, label: '  ' });
    check('a section needs a label', noLabel.status === 400, 'got ' + noLabel.status);

    const madeSec = await (await post('/pt/api/sections/add',
      { plan: chart, label: 'ucdfs-test section', x: 48, y: 543, w: 498, h: 523 })).json();
    const sec = madeSec.section && madeSec.section.sec;
    check('section created', !!sec, JSON.stringify(madeSec).slice(0, 80));
    check('with a server-minted id', /^sec_/.test(sec || ''), sec);

    let mine = await state(chart);
    let sPt  = await state();
    check('it shows on its own chart', (mine.sections || []).some(s => s.sec === sec));
    check('and not on the legacy chart', !(sPt.sections || []).some(s => s.sec === sec));

    await post('/pt/api/sections', { plan: chart, sec, label: 'ucdfs-test renamed' });
    await post('/pt/api/sections', { plan: chart, sec, x: 300, y: 400, w: 600, h: 620 });
    mine = await state(chart);
    const moved = (mine.sections || []).find(s => s.sec === sec);
    check('rename, move and resize all persist',
      !!moved && moved.label === 'ucdfs-test renamed' &&
      moved.x === 300 && moved.y === 400 && moved.w === 600 && moved.h === 620,
      JSON.stringify(moved || null));

    // A box is a floor, not a suggestion: below the minimum the tasks inside
    // stop fitting and the resize handle becomes unreachable.
    await post('/pt/api/sections', { plan: chart, sec, w: 10, h: 10 });
    mine = await state(chart);
    const floored = (mine.sections || []).find(s => s.sec === sec);
    check('a section cannot be shrunk below its minimum',
      !!floored && floored.w >= 200 && floored.h >= 150,
      JSON.stringify(floored || null));

    const phantom = await post('/pt/api/sections',
      { plan: chart, sec: 'sec_nope', label: 'phantom' });
    mine = await state(chart);
    check('updating an unknown section creates nothing',
      phantom.ok && !(mine.sections || []).some(s => s.sec === 'sec_nope'));

    console.log('\nisolation between charts');
    const node = await (await post('/pt/api/nodes',
      { plan: chart, label: 'ucdfs-test task', sec, type: 'm', x: 200, y: 900 })).json();
    const nid = node.node && node.node.id;
    check('task created on the test chart', !!nid, JSON.stringify(node).slice(0, 60));

    mine = await state(chart);
    sPt  = await state();
    check('task visible on its own chart', mine.nodes.some(n => n.id === nid));
    check('task absent from the legacy chart', !sPt.nodes.some(n => n.id === nid));

    await post('/pt/api/toggle',
      { plan: chart, node_id: nid, done: true, user_name: 'Plans Check' });
    mine = await state(chart);
    sPt  = await state();
    check('tick lands on its own chart', mine.done.includes(nid));
    check('tick absent from the legacy chart', !sPt.done.includes(nid));
    check('tick logged on its own chart',
      mine.done_log.some(l => l.node_id === nid && l.done));
    check('log line absent from the legacy chart',
      !sPt.done_log.some(l => l.node_id === nid));

    console.log('\nwhat cannot be destroyed by accident');
    const secBusy = await post('/pt/api/sections/delete', { plan: chart, sec });
    check('a section holding tasks cannot be deleted', secBusy.status === 400,
      'got ' + secBusy.status);

    const chartBusy = await post('/api/plans/delete',
      { id: chart, name: 'ucdfs-test chart' });
    check('a chart holding work cannot be deleted', chartBusy.status === 400,
      'got ' + chartBusy.status);

    const wrongName = await post('/api/plans/delete', { id: chart, name: 'not the name' });
    check('and the name has to match to try', wrongName.status === 400,
      'got ' + wrongName.status);

    // A refused delete must not have taken the work with it on the way out.
    // The endpoint sweeps satellite tables before removing the chart, so a
    // refusal that had already swept would lose the tick state of a chart it
    // then left in place.
    const survived = await state(chart);
    check('a refused delete leaves the chart intact',
      survived.nodes.some(n => n.id === nid) &&
      (survived.sections || []).some(s => s.sec === sec) &&
      survived.done.includes(nid),
      `${survived.nodes.length} tasks, ${(survived.sections || []).length} sections, ` +
      `${survived.done.length} ticked`);

    console.log('\narchiving is the reversible one');
    await post('/api/plans/update', { id: chart, archived: true });
    let plans = (await get('/api/plans')).plans || [];
    check('archived shows in the list, flagged',
      (plans.find(p => p.id === chart) || {}).archived === true);
    await post('/api/plans/update', { id: chart, archived: false, name: 'ucdfs-test renamed chart' });
    plans = (await get('/api/plans')).plans || [];
    const back = plans.find(p => p.id === chart) || {};
    check('un-archiving and renaming both work',
      back.archived === false && back.name === 'ucdfs-test renamed chart',
      JSON.stringify(back).slice(0, 80));

    console.log('\ncleanup');
    await post('/pt/api/toggle',
      { plan: chart, node_id: nid, done: false, user_name: 'Plans Check' });
    check('task deleted', (await post('/pt/api/nodes/delete', { plan: chart, id: nid })).ok);
    check('empty section deleted',
      (await post('/pt/api/sections/delete', { plan: chart, sec })).ok);
    const deletedId = chart;
    const gone = await post('/api/plans/delete',
      { id: chart, name: 'ucdfs-test renamed chart' });
    check('now-empty chart deleted', gone.ok, 'status ' + gone.status);
    if (gone.ok) chart = null;   // nothing left for the finally block to tidy
    plans = (await get('/api/plans')).plans || [];
    // Against deletedId, not chart — chart is null by now, and `p.id === null`
    // is a check that can only ever pass.
    check('and it is out of the list', !plans.some(p => p.id === deletedId));
  } finally {
    // A failed assertion above must not leave the chart behind for the next run
    // to trip over. Best effort: it can only succeed once the chart is empty,
    // and if it does not, the name says whose mess it is.
    if (chart) {
      const row = ((await get('/api/plans')).plans || []).find(p => p.id === chart);
      if (row) await post('/api/plans/delete', { id: chart, name: row.name });
    }
  }

  process.exit(summary('plans') ? 1 : 0);
})().catch(e => { console.error('  suite crashed:', e.message); process.exit(1); });
