/* Tracker planning (migrations/019): area, duration, starts_on, waits_on,
 * critical and milestone on an item; the design freeze dates in settings;
 * paste-to-create, the weekly message, and "what changed this week".
 *
 * Negatives first, as suite-tracker does: every new endpoint refuses a member,
 * and so does changing a freeze date. Then the rules, each beside a positive
 * control, so a refusal cannot pass on an endpoint that refuses everybody.
 *
 * Two things cannot be shown over HTTP against the shared non-prod database,
 * and are checked by driving main.py's own functions inside the test
 * container instead (`py()` below):
 *
 *   - the app running against a database WITHOUT 019. Non-prod has it, and
 *     dropping columns from a database stage also reads is not a test
 *     fixture. So sb() is swapped for a fake that answers the way PostgREST
 *     does about a column it does not know, and the real write path runs.
 *   - private lines kept out of /changes for a non-admin. Every tracker
 *     endpoint refuses non-admins today, so the only way to reach the filter
 *     as one is to call it.
 *
 * The freeze dates are shared settings rows. They are read first, deleted to
 * see the default, and put back at the end, exactly as they were.
 *
 * REQUIRES migrations 017, 018 and 019 on non-prod; says so and stops if not.
 */
const { execFileSync } = require('child_process');
const { BASE, check, summary, signUp, open, waitFor } = require('./lib');

const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const PREFIX = 'ucdfs-test-';
const CONTAINER = process.env.TEST_CONTAINER || 'ucdfs-test';
const DEFAULT_FREEZE = '2026-11-19';

const json = async r => { try { return await r.json(); } catch (e) { return {}; } };
const hdr  = cs => ({ 'Content-Type': 'application/json',
                      Cookie: cs.map(c => c.split(';')[0]).join('; ') });
const post = (path, cs, body) => fetch(BASE + path,
  { method: 'POST', headers: hdr(cs), body: JSON.stringify(body) });
const get  = (path, cs) => fetch(BASE + path, { headers: hdr(cs), redirect: 'manual' });
const detail = async r => `${r.status} ${((await json(r)).detail) || ''}`;

const iso = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
// Letters only: a pasted name has to look like a name to the parser.
const letters = n => Array.from({ length: n }, () => 'bcdfghjklmnpqrstvwxz'[Math.floor(Math.random() * 20)]).join('');
const cap = s => s[0].toUpperCase() + s.slice(1);

/* Run Python inside the test container, against the main.py it is serving,
   and hand back the JSON it prints last. */
function py(code) {
  const out = execFileSync('docker', ['exec', '-i', CONTAINER, 'python', '-'],
    { input: 'import sys, json\nsys.path.insert(0, "/app")\nimport main\n' + code,
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

(async () => {
  if (!SB || !KEY) {
    console.log('  ── no service key in the environment; skipping ──');
    process.exit(summary('planning') ? 1 : 0);
  }
  const sbFetch = (path, method = 'GET', body) => fetch(`${SB}/rest/v1/${path}`, {
    method,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`,
               'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const idOf = async mail =>
    ((await json(await sbFetch(`profiles?email=eq.${encodeURIComponent(mail)}&select=id`)))[0] || {}).id;

  const firstA = cap('pl' + letters(7)), firstB = cap('qu' + letters(7));
  const member = await signUp('Planning', 'Member');
  const boss   = await signUp('Planning', 'Admin');
  const ann    = await signUp(firstA, 'Tester');
  const ben    = await signUp(firstB, 'Tester');
  // The alias map says "Anrai" also means an account called Weeraphong.
  const alias  = await signUp('Weeraphong', cap(letters(8)));
  const ids = { member: await idOf(member.email), boss: await idOf(boss.email),
                ann: await idOf(ann.email), ben: await idOf(ben.email), alias: await idOf(alias.email) };
  check('the cast has accounts', Object.values(ids).every(Boolean), JSON.stringify(ids));

  // ── A member gets none of it ──────────────────────────────────────────
  console.log('a member is refused all of it');
  for (const [label, path, body] of [
    ['the paste parser',        '/api/tracker/items/parse', { text: 'x - y' }],
    ['saving a pasted list',    '/api/tracker/items/bulk',  { items: [{ title: PREFIX + 'nope' }] }],
    ['the weekly message',      '/api/tracker/message',     null],
    ['what changed this week',  '/api/tracker/changes',     null],
    ['reading the freeze dates', '/api/admin/settings',     null],
    ['changing a freeze date',  '/api/admin/settings',      { design_freeze: { pt: '2027-01-01' } }],
    ['making a planned item',   '/api/tracker/items',       { title: PREFIX + 'nope', area: 'motor' }],
  ]) {
    const r = body === null ? await get(path, member.setCookies) : await post(path, member.setCookies, body);
    check(`${label} → 403`, r.status === 403, `${path} → ${r.status}`);
  }

  // ── An admin ─────────────────────────────────────────────────────────
  await sbFetch(`profiles?id=eq.${ids.boss}`, 'PATCH', { role: 'admin', god_mode: false });
  await sbFetch(`profiles?id=eq.${ids.ann}`, 'PATCH', { subteam: 'pt' });
  await sbFetch(`profiles?id=eq.${ids.ben}`, 'PATCH', { subteam: 'mech' });
  const probe = await json(await get('/api/tracker/items', boss.setCookies));
  if (probe.ready === false || probe.planning_ready === false) {
    console.log('  ── tracker or planning columns missing; migrations 017-019 not applied, stopping ──');
    process.exit(summary('planning') ? 1 : 0);
  }
  check('the board says 019 is there', probe.planning_ready === true);
  check('and lists the areas', (probe.areas || []).map(a => a.id).join(',') ===
    'accumulator,circuits,software,motor,other', JSON.stringify((probe.areas || []).map(a => a.id)));

  const made = [];
  const mk = async body => {
    const r = await post('/api/tracker/items', boss.setCookies, { title: PREFIX + 'plan ' + letters(6), ...body });
    const it = (await json(r)).item || {};
    if (it.id) made.push(it);
    return { r, it };
  };
  const upd = (id, body) => post('/api/tracker/items/update', boss.setCookies, { id, ...body });
  const item = async id => ((await json(await get('/api/tracker/items', boss.setCookies))).items || [])
    .find(i => i.id === id) || {};

  // ── The design freeze dates ───────────────────────────────────────────
  console.log('\nthe design freeze dates');
  const keys = ['milestone.design_freeze.pt', 'milestone.design_freeze.mech'];
  const saved = await json(await sbFetch(`settings?key=in.(${keys.join(',')})&select=key,value`));
  await sbFetch(`settings?key=in.(${keys.join(',')})`, 'DELETE');
  let st = await json(await get('/api/admin/settings', boss.setCookies));
  check('with no settings rows, both default to 19 November 2026',
    (st.design_freeze || {}).pt === DEFAULT_FREEZE && (st.design_freeze || {}).mech === DEFAULT_FREEZE,
    JSON.stringify(st.design_freeze));
  const strip = (await json(await get('/api/tracker/items', boss.setCookies))).milestones || [];
  check('and the tracker draws the default too, one per division',
    strip.filter(m => m.key === 'design_freeze').map(m => `${m.subteam}=${m.date}`).join(',') ===
      `pt=${DEFAULT_FREEZE},mech=${DEFAULT_FREEZE}`, JSON.stringify(strip));

  for (const [bad, why] of [['2026-02-30', 'a day that does not exist'], ['next week', 'words'],
                            [20261119, 'a number'], ['0226-11-19', 'a year typed wrong'],
                            ['19/11/2026', 'the Irish way round']]) {
    const r = await post('/api/admin/settings', boss.setCookies, { design_freeze: { pt: bad } });
    check(`${why} is refused`, r.status === 400, await detail(r));
  }
  const ops = await post('/api/admin/settings', boss.setCookies, { design_freeze: { ops: '2027-01-01' } });
  check('a division with no freeze is refused', ops.status === 400, await detail(ops));
  const flat = await post('/api/admin/settings', boss.setCookies, { design_freeze: '2027-01-01' });
  check('a bare date with no division is refused', flat.status === 400, await detail(flat));
  st = await json(await get('/api/admin/settings', boss.setCookies));
  check('and none of those changed anything', st.design_freeze.pt === DEFAULT_FREEZE, st.design_freeze.pt);

  const ptSet = await post('/api/admin/settings', boss.setCookies, { design_freeze: { pt: '2026-12-03' } });
  check('Electrical\'s date saves', ptSet.ok, await detail(ptSet));
  st = await json(await get('/api/admin/settings', boss.setCookies));
  check('and reads back', st.design_freeze.pt === '2026-12-03', st.design_freeze.pt);
  check("without touching Mechanical's", st.design_freeze.mech === DEFAULT_FREEZE, st.design_freeze.mech);
  await post('/api/admin/settings', boss.setCookies, { design_freeze: { mech: '2026-11-26' } });
  st = await json(await get('/api/admin/settings', boss.setCookies));
  check("Mechanical's saves on its own", st.design_freeze.mech === '2026-11-26' &&
    st.design_freeze.pt === '2026-12-03', JSON.stringify(st.design_freeze));
  check('and nothing else in settings moved', st.quiet_days !== undefined && st.threshold_eur !== undefined);

  const { it: ptItem } = await mk({ subteam: 'pt', milestone: 'design_freeze', critical: true });
  const { it: mechItem } = await mk({ subteam: 'mech', milestone: 'design_freeze' });
  const { it: opsItem } = await mk({ subteam: 'ops', milestone: 'design_freeze' });
  check("design_freeze on an Electrical item is Electrical's date", ptItem.milestone_date === '2026-12-03',
    JSON.stringify([ptItem.milestone, ptItem.milestone_date]));
  check("on a Mechanical item, Mechanical's", mechItem.milestone_date === '2026-11-26', mechItem.milestone_date);
  check('on an Operations item, no date at all', opsItem.milestone_date === null && opsItem.milestone === 'design_freeze',
    JSON.stringify([opsItem.milestone, opsItem.milestone_date]));
  const ms = ((await json(await get('/api/tracker/items', boss.setCookies))).milestones || [])
    .find(m => m.key === 'design_freeze' && m.subteam === 'pt') || {};
  check('the strip counts what is open against it', ms.open >= 1 && ms.critical >= 1 && ms.date === '2026-12-03',
    JSON.stringify(ms));
  const badMs = await post('/api/tracker/items', boss.setCookies, { title: PREFIX + 'x', milestone: 'whenever' });
  check('a milestone that does not exist is refused', badMs.status === 400, await detail(badMs));

  // ── Fields and their checks ───────────────────────────────────────────
  console.log('\nthe fields, all optional');
  const { r: plainR, it: plain } = await mk({});
  check('a title is still all an item needs', plainR.ok && plain.area === '' && plain.duration_days === null &&
    plain.waits_on.length === 0 && plain.critical === false && plain.milestone === '', JSON.stringify(plain).slice(0, 160));
  for (const [label, body] of [
    ['an area that does not exist', { area: 'aero' }],
    ['a duration in words',         { duration_days: 'a week' }],
    ['a fractional duration',       { duration_days: 2.5 }],
    ['a negative duration',         { duration_days: -1 }],
    ['an absurd duration',          { duration_days: 999 }],
    ['a start that is not a date',  { starts_on: 'monday' }],
    ['waits_on that is not a list', { waits_on: 5 }],
  ]) {
    const r = await post('/api/tracker/items', boss.setCookies, { title: PREFIX + 'x', ...body });
    check(`${label} is refused`, r.status === 400, await detail(r));
  }
  const strCrit = await mk({ critical: 'true' });
  check('critical has to be literally true; a string is not', strCrit.it.critical === false);
  const touchedBefore = ((await json(await sbFetch(`work_items?id=eq.${plain.id}&select=touched_at`)))[0] || {}).touched_at;
  const planned = await upd(plain.id, { area: 'motor', duration_days: 4, critical: true, milestone: 'competition' });
  const after = (await json(planned)).item || {};
  check('an update sets them', planned.ok && after.area === 'motor' && after.duration_days === 4 &&
    after.critical === true && after.milestone === 'competition', JSON.stringify(after).slice(0, 200));
  const touchedAfter = ((await json(await sbFetch(`work_items?id=eq.${plain.id}&select=touched_at`)))[0] || {}).touched_at;
  check('planning is not the item moving: touched_at stays put', touchedBefore && touchedBefore === touchedAfter,
    `${touchedBefore} → ${touchedAfter}`);
  const ev = (await json(await get('/api/tracker/items/events?id=' + plain.id, boss.setCookies))).events || [];
  check('but it is in the history', ev.some(e => e.kind === 'edited' && /area/.test(e.body) && /duration/.test(e.body)),
    JSON.stringify(ev.map(e => e.body)));

  // ── Derived due dates ─────────────────────────────────────────────────
  console.log('\nderived due dates');
  // A Friday at least a week out, so nothing here is overdue by accident.
  let fri = addDays(new Date(), 7);
  while (fri.getUTCDay() !== 5) fri = addDays(fri, 1);
  const F = iso(fri), MON = iso(addDays(fri, 3)), TUE = iso(addDays(fri, 4)), WED = iso(addDays(fri, 5));
  const { it: oneDay } = await mk({ starts_on: F, duration_days: 1 });
  check('Friday plus one working day is Monday', oneDay.due === MON && oneDay.due_derived === true,
    `${F} + 1 → ${oneDay.due}`);
  const { it: threeDay } = await mk({ starts_on: F, duration_days: 3 });
  check('Friday plus three is Wednesday, not Monday', threeDay.due === WED, `${F} + 3 → ${threeDay.due}`);
  check('and due_date itself is left empty', threeDay.due_date === null, String(threeDay.due_date));

  const { it: first } = await mk({ due_date: F });
  const { it: second } = await mk({ duration_days: 2, waits_on: [first.id] });
  check('with no start, it starts when what it waits on is due', second.due === TUE && second.due_derived,
    `${F} + 2 → ${second.due}`);
  check('and says what it waits on', second.waits_on.length === 1 && second.waiting_on[0].key === first.key,
    JSON.stringify(second.waiting_on));
  await upd(second.id, { due_date: iso(addDays(fri, 10)) });
  const pinned = await item(second.id);
  check('an explicit due date always wins', pinned.due === iso(addDays(fri, 10)) && pinned.due_derived === false,
    JSON.stringify([pinned.due, pinned.due_derived]));
  await upd(second.id, { due_date: null });

  // ── Waits, loops and Ready ────────────────────────────────────────────
  console.log('\nwaits_on, loops and Ready');
  const loop = await upd(first.id, { waits_on: [second.id] });
  check('a wait that closes a loop is refused', loop.status === 400 && /loop/i.test((await json(loop)).detail || ''),
    String(loop.status));
  const { it: third } = await mk({ waits_on: [second.id] });
  const longLoop = await upd(first.id, { waits_on: [third.id] });
  check('a longer loop is refused too', longLoop.status === 400, await detail(longLoop));
  const selfW = await upd(first.id, { waits_on: [first.id] });
  check('an item cannot wait on itself', selfW.status === 400, await detail(selfW));
  const ghost = await upd(first.id, { waits_on: [999999999] });
  check('an id that names nothing is dropped, not refused',
    ghost.ok && (((await json(ghost)).item || {}).waits_on || []).length === 0, String(ghost.status));

  check('waiting on something not done is not Ready', (await item(second.id)).ready === false);
  await upd(first.id, { status: 'done' });
  check('once it is done, the item is Ready', (await item(second.id)).ready === true);
  check('an item that never waited on anything is just To do', (await item(plain.id)).ready === false);
  await upd(second.id, { status: 'doing' });
  check('and Ready goes once somebody starts it', (await item(second.id)).ready === false);

  // ── Overdue and days in status ────────────────────────────────────────
  console.log('\noverdue');
  const yesterday = iso(addDays(new Date(), -1));
  const { it: late } = await mk({ due_date: yesterday });
  check('a due date in the past, not done, is overdue', late.overdue === true);
  await upd(late.id, { status: 'done' });
  check('done is never overdue', (await item(late.id)).overdue === false);
  // Four days back plus one working day lands inside the last week and before
  // today whatever day of the week this runs on, which /changes relies on below.
  const { it: lateEst } = await mk({ starts_on: iso(addDays(new Date(), -4)), duration_days: 1 });
  check('a derived date can be overdue too, and says it is an estimate',
    lateEst.overdue === true && lateEst.due_derived === true, JSON.stringify([lateEst.due, lateEst.overdue]));
  check('days in status is reported', typeof late.days_in_status === 'number', String(late.days_in_status));

  // ── GitHub ───────────────────────────────────────────────────────────
  console.log('\nGitHub');
  const { r: ghR, it: gh } = await mk({ link: 'https://github.com/' + PREFIX + letters(10) + '/nothing/tree/main' });
  check('a GitHub link that leads nowhere saves', ghR.ok);
  const ghNow = await item(gh.id);
  check('and shows no commit date rather than an error', ghNow.id && !ghNow.last_commit, JSON.stringify(ghNow.last_commit));
  const targets = py(`print(json.dumps([main._github_target(u) for u in [
    "https://github.com/o/r", "https://github.com/o/r/tree/feat/x", "https://github.com/o/r/pull/12/files",
    "https://gitlab.com/o/r", "javascript:alert(1)"]]))`);
  check('a repo, a branch and a PR are told apart',
    targets[0].kind === 'repo' && targets[1].kind === 'branch' && targets[1].ref === 'feat/x' &&
    targets[2].kind === 'pr' && targets[2].ref === '12', JSON.stringify(targets.slice(0, 3)));
  check('and anything else is not GitHub', targets[3] === null && targets[4] === null);

  // ── Paste to create ───────────────────────────────────────────────────
  console.log('\npaste to create');
  const before = ((await json(await get('/api/tracker/items', boss.setCookies))).items || []).length;
  const tA = PREFIX + 'pair job ' + letters(5), tB = PREFIX + 'pair job two ' + letters(5);
  const tC = PREFIX + 'alias job ' + letters(5), tD = PREFIX + 'nobody job ' + letters(5);
  const tE = PREFIX + 'grabs job ' + letters(5);
  const text = [
    'This week:',
    `- ${firstA} + ${firstB} Tester - ${tA}; ${tB}`,
    `Anrai: ${tC}`,
    `Zzyzx${letters(4)}: ${tD}`,
    '',
    'Up for grabs:',
    tE,
  ].join('\n');
  const parsed = await json(await post('/api/tracker/items/parse', boss.setCookies, { text }));
  const p = t => (parsed.items || []).find(i => i.title === t) || {};
  check('it proposes one item per task', (parsed.items || []).length === 5,
    JSON.stringify((parsed.items || []).map(i => i.title)));
  check('saves nothing', ((await json(await get('/api/tracker/items', boss.setCookies))).items || []).length === before);
  check('a first name and a full name both match',
    JSON.stringify(p(tA).owner_ids) === JSON.stringify([ids.ann, ids.ben]), JSON.stringify(p(tA).names));
  check('";" makes two items for the same people',
    JSON.stringify(p(tB).owner_ids) === JSON.stringify([ids.ann, ids.ben]));
  const weeraphongs = await json(await sbFetch('profiles?first_name=ilike.weeraphong&select=id'));
  const anraiName = (p(tC).names || [])[0] || {};
  if (weeraphongs.length === 1) {
    check('the alias map: "Anrai" finds the account called Weeraphong',
      anraiName.status === 'matched' && p(tC).owner_ids[0] === ids.alias, JSON.stringify(anraiName));
  } else {
    check('the alias map: "Anrai" is offered the Weeraphong accounts, not guessed',
      anraiName.status === 'ambiguous' && p(tC).owner_ids.length === 0, JSON.stringify(anraiName));
  }
  check('a name nobody has comes back flagged, not guessed',
    (p(tD).names || [])[0] && p(tD).names[0].status === 'unmatched' && p(tD).owner_ids.length === 0 &&
    p(tD).warnings.some(w => /Nobody on the team/.test(w)), JSON.stringify(p(tD)));
  check('under "Up for grabs" it has nobody, and no warning', p(tE).owner_ids.length === 0 &&
    p(tE).warnings.length === 0, JSON.stringify(p(tE)));
  const tooMany = await post('/api/tracker/items/parse', boss.setCookies,
    { text: Array.from({ length: 101 }, (_, i) => 'line ' + i).join('\n') });
  check('a paste of more than a hundred lines is refused', tooMany.status === 400, await detail(tooMany));

  const badBulk = await post('/api/tracker/items/bulk', boss.setCookies,
    { items: [{ title: PREFIX + 'fine' }, { title: '   ' }] });
  check('one bad item refuses the whole list, and says which', badBulk.status === 400 &&
    /Item 2/.test((await json(badBulk)).detail || ''), String(badBulk.status));
  const bulkR = await post('/api/tracker/items/bulk', boss.setCookies, { items: [
    { title: tA, owner_ids: p(tA).owner_ids }, { title: tB, owner_ids: p(tB).owner_ids },
    { title: tC, owner_ids: [ids.alias] }, { title: tE, owner_ids: [] },
  ] });
  const bulk = (await json(bulkR)).items || [];
  made.push(...bulk);
  check('the confirmed list saves', bulkR.ok && bulk.length === 4, await detail(bulkR));
  check('with the people confirmed', JSON.stringify((bulk[0] || {}).owner_ids) === JSON.stringify([ids.ann, ids.ben]));
  const bev = (await json(await get('/api/tracker/items/events?id=' + (bulk[0] || {}).id, boss.setCookies))).events || [];
  check('each logged as created, like a typed one', bev.length === 1 && bev[0].kind === 'created' &&
    bev[0].actor_name === 'Planning Admin', JSON.stringify(bev));

  // ── The weekly message ────────────────────────────────────────────────
  console.log('\nthe weekly message');
  const msgR = await get('/api/tracker/message', boss.setCookies);
  const msg = await msgR.text();
  check('it is plain text', msgR.ok && /text\/plain/.test(msgR.headers.get('content-type') || ''),
    msgR.headers.get('content-type'));
  check('a pair is one line joined with +, their items with ;',
    msg.split('\n').some(l => l.startsWith(`${firstA} + ${firstB} - `) && l.includes(tA) && l.includes(tB)),
    msg.split('\n').filter(l => l.includes(tA)).join(' | '));
  check('unowned work is at the end, under Up for grabs',
    msg.indexOf('Up for grabs:') > -1 && msg.indexOf(tE) > msg.indexOf('Up for grabs:'));
  check('done items are left out', !msg.includes(late.title) && !msg.includes(first.title));
  const round = (await json(await post('/api/tracker/items/parse', boss.setCookies, { text: msg }))).items || [];
  const mine = [tA, tB, tC, tE].map(t => round.find(r => r.title === t) || {});
  check('pasting it back makes the same items with the same people',
    mine.every(Boolean) &&
    JSON.stringify(mine[0].owner_ids) === JSON.stringify([ids.ann, ids.ben]) &&
    JSON.stringify(mine[1].owner_ids) === JSON.stringify([ids.ann, ids.ben]) &&
    mine[3].owner_ids && mine[3].owner_ids.length === 0,
    JSON.stringify(mine.map(m => [m.title, m.owner_ids])));
  check('and recognises them as already on the board', mine.every(m => m.duplicate_of),
    JSON.stringify(mine.map(m => m.duplicate_of)));
  const ptMsg = await (await get('/api/tracker/message?subteam=mech', boss.setCookies)).text();
  check('a division narrows it', ptMsg.includes(mechItem.title) && !ptMsg.includes(ptItem.title));

  // ── What changed this week ────────────────────────────────────────────
  console.log('\nwhat changed this week');
  await post('/api/tracker/items/note', boss.setCookies, { id: plain.id, body: 'secret-ish ' + letters(5), private: true });
  await upd(third.id, { status: 'blocked', blocked_reason: 'the relays' });
  const ch = await json(await get('/api/tracker/changes?days=7', boss.setCookies));
  const has = (k, id) => (ch[k] || []).some(l => l.item_id === id);
  check('finished', has('finished', first.id) && has('finished', late.id));
  check('created', has('created', plain.id));
  check('newly blocked, with what on', (ch.blocked || []).some(l => l.item_id === third.id && l.body === 'the relays'));
  check('newly overdue, estimated ones marked', (ch.overdue || []).some(l => l.item_id === lateEst.id && l.derived));
  check('an admin sees a private update, marked private',
    (ch.updates || []).some(l => l.item_id === plain.id && l.private === true));
  for (const bad of ['0', '400', 'week']) {
    const r = await get('/api/tracker/changes?days=' + bad, boss.setCookies);
    check(`days=${bad} is refused`, r.status === 400, String(r.status));
  }
  /* The endpoint refuses members outright today, so the filter it applies for
     anybody _sees_private refuses is called directly, with the real events. */
  const filtered = py(`
from datetime import date, timedelta
events = main.sb().table("work_item_events").select("*").eq("item_id", ${plain.id}).execute().data
rows = main.sb().table("work_items").select("*").eq("id", ${plain.id}).execute().data
today = date.today()
member = main._tracker_changes({"id": "x", "role": "member"}, rows, events, today - timedelta(days=7), today)
admin  = main._tracker_changes({"id": "x", "role": "admin"},  rows, events, today - timedelta(days=7), today)
print(json.dumps({"member": len(member["updates"]), "admin": len(admin["updates"]),
                  "private_rows": sum(1 for e in events if e.get("private"))}))`);
  check('the private update is really stored private', filtered.private_rows === 1, JSON.stringify(filtered));
  check('and never reaches a non-admin through /changes', filtered.member === 0 && filtered.admin === 1,
    JSON.stringify(filtered));

  // ── The People view ───────────────────────────────────────────────────
  console.log('\nthe People view');
  const people = (await json(await get('/api/tracker/people', boss.setCookies))).people || [];
  const annRow = people.find(x => x.id === ids.ann) || {};
  check('counts open items per person', (annRow.items || {}).open === 2, JSON.stringify(annRow.items));
  const bossRow = people.find(x => x.id === ids.boss) || {};
  check('and says when somebody has nothing open', (bossRow.items || {}).open === 0, JSON.stringify(bossRow.items));
  await upd(bulk[0].id, { critical: true, due_date: yesterday });
  const annNow = ((await json(await get('/api/tracker/people', boss.setCookies))).people || [])
    .find(x => x.id === ids.ann) || {};
  check('critical and overdue are counted on their plate',
    (annNow.items || {}).critical === 1 && (annNow.items || {}).overdue === 1, JSON.stringify(annNow.items));

  // ── Without 019 ───────────────────────────────────────────────────────
  console.log('\nagainst a database without 019');
  /* PostgREST answers a write naming a column it does not have with PGRST204
     and the column's name. The fake says exactly that for any of 019's, so
     the real _insert_item and _write_planning decide what happens. */
  const old = py(`
class Q:
    def __init__(s, log): s.log = log
    def insert(s, row): s.row = row; return s
    def update(s, row): s.row = row; return s
    def eq(s, *a): return s
    def execute(s):
        bad = [c for c in main.PLANNING_COLUMNS if c in s.row]
        if bad:
            raise Exception("{'code': 'PGRST204', 'message': \\"Could not find the '%s' column of 'work_items' in the schema cache\\"}" % bad[0])
        s.log.append(s.row)
        class R: pass
        r = R(); r.data = [dict(s.row, id=7)]
        return r
class C:
    def __init__(s): s.log = []
    def table(s, name): return Q(s.log)
fake = C()
main.sb = lambda: fake
out = {}
base = {"title": "t", "status": "todo", "owner_ids": [], "owner_id": None}
out["plain"] = main._insert_item(dict(base)).get("id")
out["unset"] = main._insert_item(dict(base, waits_on=[], critical=False)).get("id")
out["unset_written"] = sorted(fake.log[-1].keys())
try:
    main._insert_item(dict(base, area="motor"))
    out["set"] = "saved"
except main.HTTPException as e:
    out["set"] = [e.status_code, e.detail]
from datetime import date
d = main._dress_item({"id": 7, "title": "old row", "status": "todo", "owner_id": None}, {}, date.today(), 5)
out["dressed"] = {k: d[k] for k in ("area", "duration_days", "waits_on", "ready", "critical", "milestone", "due", "due_derived")}
print(json.dumps(out))`);
  check('a plain create still saves', old.plain === 7, JSON.stringify(old));
  check('one carrying only unset planning fields is retried without them',
    old.unset === 7 && !old.unset_written.includes('waits_on') && !old.unset_written.includes('critical'),
    JSON.stringify(old.unset_written));
  check('one that actually sets a field says it needs 019 rather than dropping it',
    Array.isArray(old.set) && old.set[0] === 503 && /019/.test(old.set[1]), JSON.stringify(old.set));
  check('and a row from before 019 dresses as "not set"',
    old.dressed.area === '' && old.dressed.duration_days === null && old.dressed.waits_on.length === 0 &&
    old.dressed.critical === false && old.dressed.ready === false && old.dressed.due === null,
    JSON.stringify(old.dressed));

  // ── The pages ─────────────────────────────────────────────────────────
  console.log('\nthe pages');
  {
    const { w, d, errors } = await open('/tracker', { setCookies: boss.setCookies });
    check('the tracker loads without errors', errors.length === 0, errors.join(' | '));
    check('the strip shows both freezes when viewing everything',
      await waitFor(() => d.querySelectorAll('#ms-strip .ms').length === 2),
      String(d.querySelectorAll('#ms-strip .ms').length));
    d.getElementById('tab-board').click();
    await waitFor(() => d.getElementById('i-' + ptItem.id));
    const card = d.getElementById('i-' + ptItem.id);
    check('a critical item is marked on its card', !!card && !!card.querySelector('.badge-crit'));
    const unowned = d.getElementById('i-' + bulk[3].id);
    check('an unowned item is drawn differently', !!unowned && unowned.classList.contains('unowned'));
    const waiting = d.getElementById('i-' + third.id);
    check('"waiting on" links to the item', !!waiting &&
      !!waiting.querySelector(`[data-wait="${second.id}"]`));
    const chip = [...d.querySelectorAll('#board-chips .chip')].find(c => /Needs an owner/.test(c.textContent));
    chip.click();
    check('the needs-owner chip narrows the board to unowned work',
      !!d.getElementById('i-' + bulk[3].id) && !d.getElementById('i-' + bulk[0].id));
    chip.click();
    [...d.querySelectorAll('#board-chips .chip')].find(c => c.textContent === 'Mechanical').click();
    check('choosing a division narrows the strip to its freeze',
      d.querySelectorAll('#ms-strip .ms').length === 1 && /Mechanical/.test(d.getElementById('ms-strip').textContent));
    d.getElementById('view-table').click();
    check('the table view draws a row per item', !!d.querySelector('.tbl tr#i-' + mechItem.id));
    d.querySelector('[data-sort="title"]').click();
    check('and sorts by a column', d.querySelector('[data-sort="title"]').classList.contains('on'));
    d.getElementById('view-board').click();
    d.getElementById('group').value = 'area';
    d.getElementById('group').dispatchEvent(new w.Event('change'));
    check('grouping by area draws lanes', d.querySelectorAll('#board .lane').length >= 1);
    d.getElementById('tab-week').click();
    check('This week draws', await waitFor(() => d.querySelectorAll('#week .wk-line').length > 0));
    w.close();
  }
  {
    const { w, d, errors } = await open('/admin', { setCookies: boss.setCookies });
    check('/admin loads without errors', errors.length === 0, errors.join(' | '));
    check('with both freeze dates filled in', await waitFor(() =>
      d.getElementById('freeze-pt').value === '2026-12-03' && d.getElementById('freeze-mech').value === '2026-11-26'),
      `${d.getElementById('freeze-pt').value} / ${d.getElementById('freeze-mech').value}`);
    w.close();
  }

  // ── Putting things back ───────────────────────────────────────────────
  for (const it of made) {
    await post('/api/tracker/items/delete', boss.setCookies, { id: it.id, title: it.title });
  }
  await sbFetch(`settings?key=in.(${keys.join(',')})`, 'DELETE');
  for (const row of saved) await sbFetch('settings', 'POST', row);
  const back = await json(await sbFetch(`settings?key=in.(${keys.join(',')})&select=key,value`));
  check('the freeze dates are put back as they were',
    JSON.stringify(back.map(r => r.key + r.value).sort()) === JSON.stringify(saved.map(r => r.key + r.value).sort()),
    `${JSON.stringify(saved)} → ${JSON.stringify(back)}`);

  process.exit(summary('planning') ? 1 : 0);
})().catch(e => { console.error('  suite crashed:', e.message); process.exit(1); });
