/* The tracker (migrations/017): admin-only, both halves, and the two things
 * 017 changed outside it.
 *
 * Mostly negatives first, because the tracker holds notes about named people:
 * a member must be refused the page, the card and every endpoint. Then the
 * admin half, with a positive control beside each rule, so a refusal passing
 * on an endpoint that refuses everybody cannot hide.
 *
 * The admin is promoted with the service key and never switches the override
 * on. The tracker is gated on the role, like /admin itself, and that is the
 * point of checking it this way round.
 *
 * Team meetings are the main signal during term: a "yes" counts, a "no, can't
 * make it" is on the timeline but does not. Workshop attendance is barely used
 * outside the build season, which is why meetings had to be added at all.
 *
 * An item can have several people on it (migrations/018). Without 018 that
 * part says so and is skipped; one person per item keeps working either way,
 * which is what the rest of the suite exercises.
 *
 * Outside the tracker, 017 added profile_id to attendance and pt_done_log.
 * This suite checks that a day logged through /api/log carries the account,
 * and that a typed name matching nobody is listed in /admin and can be
 * matched. suite-plans checks the same for a tick.
 *
 * Items are titled with the test prefix, so cleanup_tracker in lib.sh finds
 * them after a crash, when the ids were never seen. The quiet threshold is a
 * single shared setting; it is read first and put back at the end.
 *
 * REQUIRES migration 017. Without it the permission checks still run, then
 * the suite says so and stops.
 */
const { BASE, check, summary, signUp, open, waitFor } = require('./lib');

const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const PREFIX = 'ucdfs-test-';

const json = async r => { try { return await r.json(); } catch (e) { return {}; } };
const hdr  = cs => ({ 'Content-Type': 'application/json',
                      Cookie: cs.map(c => c.split(';')[0]).join('; ') });
const post = (path, cs, body) => fetch(BASE + path,
  { method: 'POST', headers: hdr(cs), body: JSON.stringify(body) });
const get  = (path, cs) => fetch(BASE + path, { headers: hdr(cs), redirect: 'manual' });
const detail = async r => `${r.status} ${((await json(r)).detail) || ''}`;

const iso = d => d.toISOString().slice(0, 10);
const today = iso(new Date());
const daysAgo = n => iso(new Date(Date.now() - n * 86400000));

(async () => {
  if (!SB || !KEY) {
    console.log('  ── no service key in the environment; skipping ──');
    process.exit(summary('tracker') ? 1 : 0);
  }
  const sbFetch = (path, method = 'GET', body) => fetch(`${SB}/rest/v1/${path}`, {
    method,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`,
               'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const idOf = async mail =>
    ((await json(await sbFetch(`profiles?email=eq.${encodeURIComponent(mail)}&select=id`)))[0] || {}).id;

  const member = await signUp('Tracker', 'Member');
  const boss   = await signUp('Tracker', 'Admin');
  const quiet  = await signUp('Tracker', 'Quiet');
  const ids = { member: await idOf(member.email), boss: await idOf(boss.email),
                quiet: await idOf(quiet.email) };
  check('the cast has accounts', Object.values(ids).every(Boolean), JSON.stringify(ids));

  // ── A member gets none of it ──────────────────────────────────────────
  console.log('a member is refused all of it');
  const page = await get('/tracker', member.setCookies);
  check('the page → 403', page.status === 403, String(page.status));
  for (const [label, path, body] of [
    ['the board',                 '/api/tracker/items',                  null],
    ['the People view',           '/api/tracker/people',                 null],
    ['one person',                '/api/tracker/person?id=' + ids.boss,  null],
    ["an item's history",         '/api/tracker/items/events?id=1',      null],
    ['the unmatched names',       '/api/admin/unmatched-names',          null],
    ['making an item',            '/api/tracker/items',                  { title: PREFIX + 'nope' }],
    ['changing an item',          '/api/tracker/items/update',           { id: 1, status: 'done' }],
    ['adding an update',          '/api/tracker/items/note',             { id: 1, body: 'x' }],
    ['deleting an item',          '/api/tracker/items/delete',           { id: 1, title: 'x' }],
    ['writing a note on someone', '/api/tracker/notes',                  { profile_id: ids.boss, body: 'x' }],
    ['deleting a note',           '/api/tracker/notes/delete',           { id: 1 }],
    ['matching a name',           '/api/admin/unmatched-names/assign',   { name: 'x', profile_id: ids.member }],
    ['changing the quiet days',   '/api/admin/settings',                 { quiet_days: 0 }],
  ]) {
    const r = body === null ? await get(path, member.setCookies) : await post(path, member.setCookies, body);
    check(`${label} → 403`, r.status === 403, `${path} → ${r.status}`);
  }
  const memberCards = (await json(await get('/api/applets', member.setCookies))).applets || [];
  check('and the card is not on their dashboard', !memberCards.some(a => a.id === 'tracker'));

  // ── An admin, override off ────────────────────────────────────────────
  await sbFetch(`profiles?id=eq.${ids.boss}`, 'PATCH', { role: 'admin', god_mode: false });
  console.log('\nan admin can, without switching the override on');
  check('the page → 200', (await get('/tracker', boss.setCookies)).status === 200);
  const bossCards = (await json(await get('/api/applets', boss.setCookies))).applets || [];
  check('the card is on their dashboard', bossCards.some(a => a.id === 'tracker'));
  const probe = await json(await get('/api/tracker/items', boss.setCookies));
  check('the board answers', Array.isArray(probe.items), JSON.stringify(probe).slice(0, 90));
  if (probe.ready === false) {
    console.log('  ── tracker tables missing; migration 017 not applied, stopping ──');
    process.exit(summary('tracker') ? 1 : 0);
  }

  const settingsBefore = await json(await get('/api/admin/settings', boss.setCookies));
  const restoreQuiet = () => post('/api/admin/settings', boss.setCookies,
    { quiet_days: settingsBefore.quiet_days === undefined ? 5 : settingsBefore.quiet_days });

  // ── The quiet threshold ───────────────────────────────────────────────
  console.log('\nthe quiet threshold');
  for (const [bad, why] of [[-1, 'a negative'], [2.5, 'a fraction'], ['five', 'a word'],
                            [true, 'a boolean'], [999, 'something absurd']]) {
    const r = await post('/api/admin/settings', boss.setCookies, { quiet_days: bad });
    check(`${why} is refused`, r.status === 400, await detail(r));
  }
  const set5 = await post('/api/admin/settings', boss.setCookies, { quiet_days: 5 });
  check('a whole number is saved', set5.ok, await detail(set5));
  const after5 = await json(await get('/api/admin/settings', boss.setCookies));
  check('and read back', after5.quiet_days === 5, JSON.stringify(after5));
  check('without touching the approval threshold',
    after5.threshold_eur === settingsBefore.threshold_eur,
    `${settingsBefore.threshold_eur} → ${after5.threshold_eur}`);

  // ── Making an item ────────────────────────────────────────────────────
  console.log('\nmaking an item');
  await sbFetch(`profiles?id=eq.${ids.member}`, 'PATCH', { subteam: 'mech' });
  const refused = [
    ['an item with no title',            { title: '   ' }],
    ['a javascript: link',               { title: PREFIX + 'x', link: 'javascript:alert(1)' }],
    ['blocked without saying on what',   { title: PREFIX + 'x', status: 'blocked' }],
    ['an owner who has no account',      { title: PREFIX + 'x', owner_id: '00000000-0000-0000-0000-000000000000' }],
    ['a due date that is not a date',    { title: PREFIX + 'x', due_date: 'next tuesday' }],
  ];
  for (const [label, body] of refused) {
    const r = await post('/api/tracker/items', boss.setCookies, body);
    check(`${label} is refused`, r.status === 400, await detail(r));
  }
  const title = PREFIX + 'upright CAD ' + Date.now();
  const madeR = await post('/api/tracker/items', boss.setCookies,
    { title: '  ' + title + '  ', owner_id: ids.member, id: 999999999 });
  const made  = (await json(madeR)).item || {};
  check('a title and an owner is enough', madeR.ok, String(madeR.status));
  check('the id comes from the database, not the body', made.id && made.id !== 999999999, String(made.id));
  check('and reads as T-<n>', /^T-\d+$/.test(made.key || ''), made.key);
  check('the title is trimmed', made.title === title, JSON.stringify(made.title));
  check('it starts as to do', made.status === 'todo', made.status);
  check("its division comes from the owner's", made.subteam === 'mech', made.subteam);

  // ── Moving it ─────────────────────────────────────────────────────────
  console.log('\nmoving it');
  const upd = body => post('/api/tracker/items/update', boss.setCookies, { id: made.id, ...body });
  const itemNow = async () =>
    ((await json(await get('/api/tracker/items', boss.setCookies))).items || []).find(i => i.id === made.id) || {};

  check('blocked needs to say on what', (await upd({ status: 'blocked' })).status === 400);
  check('a status that does not exist is refused, not guessed',
    (await upd({ status: 'nearly' })).status === 400);
  await upd({ description: 'keep me' });
  const blocked = await upd({ status: 'blocked', blocked_reason: '  the   M6 bolts ' });
  check('blocked with a reason goes through', blocked.ok, String(blocked.status));
  let it = await itemNow();
  check('and the reason is kept, tidied', it.status === 'blocked' && it.blocked_reason === 'the M6 bolts',
    `${it.status} / ${it.blocked_reason}`);
  await upd({ status: 'doing' });
  it = await itemNow();
  check('unblocking clears the reason', it.status === 'doing' && it.blocked_reason === '',
    `${it.status} / ${JSON.stringify(it.blocked_reason)}`);
  await upd({ status: 'done' });
  it = await itemNow();
  check('a status change leaves the other fields alone', it.description === 'keep me',
    JSON.stringify(it.description));
  check('done is stamped when it is done', it.status === 'done' && !!it.done_at, String(it.done_at));
  await upd({ status: 'doing' });

  // ── Updates, and which of them are private ────────────────────────────
  console.log('\nupdates and their privacy');
  check('an empty update is refused',
    (await post('/api/tracker/items/note', boss.setCookies, { id: made.id, body: '  ' })).status === 400);
  const priv = await post('/api/tracker/items/note', boss.setCookies,
    { id: made.id, body: 'talked to them, about 60%', private: true });
  check('a private update is saved', priv.ok, String(priv.status));
  /* "false" as a string is truthy. Only literal true makes a note private, so
     a note meant for the team never lands as private by accident, and one
     meant to be private is never published by a client that sent a string. */
  await post('/api/tracker/items/note', boss.setCookies,
    { id: made.id, body: 'parts ordered', private: 'false' });
  const ev = (await json(await get('/api/tracker/items/events?id=' + made.id, boss.setCookies))).events || [];
  const notes = ev.filter(e => e.kind === 'note');
  check('both updates are in the history', notes.length === 2, String(notes.length));
  check('the private one is marked private',
    notes.some(e => e.body === 'talked to them, about 60%' && e.private === true));
  check('a string "false" is not private',
    notes.some(e => e.body === 'parts ordered' && e.private === false));
  check('every status change is on the record',
    ev.filter(e => e.kind === 'status').map(e => e.to_value).join(',') === 'blocked,doing,done,doing',
    ev.filter(e => e.kind === 'status').map(e => e.to_value).join(','));
  check('and says who made it', ev.every(e => e.actor_name === 'Tracker Admin'),
    JSON.stringify([...new Set(ev.map(e => e.actor_name))]));

  // ── The People view ───────────────────────────────────────────────────
  console.log('\nthe People view');
  await sbFetch(`profiles?id=eq.${ids.quiet}`, 'PATCH', { created_at: daysAgo(60) + 'T09:00:00+00:00' });
  let people = (await json(await get('/api/tracker/people', boss.setCookies))).people || [];
  const row = id => people.find(p => p.id === id) || {};
  check('everyone is on it', [ids.member, ids.boss, ids.quiet].every(id => row(id).id),
    `${people.length} people`);
  /* The member has logged nothing, but an update on their item counts as a
     sign of them: somebody checked in. */
  check('an update on their item counts as a sign of them', row(ids.member).state === 'active',
    `${row(ids.member).state}: ${row(ids.member).last_what}`);
  check('and their open work is counted', (row(ids.member).items || {}).doing === 1,
    JSON.stringify(row(ids.member).items));
  check('someone with no sign in 90 days says so, not "quiet"', row(ids.quiet).state === 'none',
    row(ids.quiet).state);

  /* Giving somebody an item and clicking Start is the admin acting, not them.
     If it counted, assigning work would hide exactly the person this view is
     there to surface. Only a written update speaks for them. */
  const handed = (await json(await post('/api/tracker/items', boss.setCookies,
    { title: PREFIX + 'handed over ' + Date.now(), owner_id: ids.quiet }))).item || {};
  await post('/api/tracker/items/update', boss.setCookies, { id: handed.id, status: 'doing' });
  people = (await json(await get('/api/tracker/people', boss.setCookies))).people || [];
  check('starting their item for them is not a sign of them', row(ids.quiet).state === 'none',
    `${row(ids.quiet).state}: ${row(ids.quiet).last_what}`);
  await post('/api/tracker/items/delete', boss.setCookies, { id: handed.id, title: handed.title });

  /* Saying no to a meeting is not a sign of you: you still were not there. It
     is kept for the timeline, with the reason, because "exams" is worth seeing
     next to a quiet flag. Written with the service key: the meetings page only
     answers for the current fortnight, and this is about what the tracker
     reads, not about that page. */
  await sbFetch('meeting_responses', 'POST', { profile_id: ids.quiet, meeting_date: daysAgo(2),
                                               attending: false, reason: 'exams' });
  people = (await json(await get('/api/tracker/people', boss.setCookies))).people || [];
  check('saying no to a meeting is not a sign of them', row(ids.quiet).state === 'none',
    `${row(ids.quiet).state}: ${row(ids.quiet).last_what}`);
  check('but the reason is on their row, beside the flag it explains',
    /exams/.test((row(ids.quiet).said_no || {}).text || ''), JSON.stringify(row(ids.quiet).said_no));
  const missed = await json(await get('/api/tracker/person?id=' + ids.quiet, boss.setCookies));
  const missLine = (missed.timeline || []).find(t => t.kind === 'missed');
  check('but it is on their timeline, with the reason, marked as not counting',
    !!missLine && /exams/.test(missLine.text) && missLine.counts === false,
    JSON.stringify(missLine || null));
  check('and does not make them look active there either', (missed.person || {}).state === 'none',
    (missed.person || {}).state);

  // Thirty days ago is at least twenty business days, well past five.
  await sbFetch('attendance', 'POST', { name: 'Tracker Quiet', date: daysAgo(30),
                                        status: 'arriving', profile_id: ids.quiet });
  people = (await json(await get('/api/tracker/people', boss.setCookies))).people || [];
  check('last seen a month ago is quiet', row(ids.quiet).state === 'quiet' && row(ids.quiet).quiet_for >= 5,
    `${row(ids.quiet).state} ${row(ids.quiet).quiet_for}`);
  check('quiet people are listed first', people.findIndex(p => p.id === ids.quiet) <
    people.findIndex(p => p.id === ids.member));

  /* The positive control for the "no" above, and the reason this source
     exists: during term a meeting is most people's only sign. */
  const yes = (await json(await sbFetch('meeting_responses', 'POST',
    { profile_id: ids.quiet, meeting_date: daysAgo(1), attending: true })))[0] || {};
  people = (await json(await get('/api/tracker/people', boss.setCookies))).people || [];
  check('saying yes to a meeting is a sign of them', row(ids.quiet).state === 'active'
    && /Said yes/.test(row(ids.quiet).last_what), `${row(ids.quiet).state}: ${row(ids.quiet).last_what}`);
  check('and is counted on the People list', row(ids.quiet).meetings === 1,
    String(row(ids.quiet).meetings));
  await sbFetch(`meeting_responses?id=eq.${yes.id}`, 'DELETE');

  console.log('\nattendance carries the account (017)');
  const logged = await post('/api/log', quiet.setCookies, { first_name: 'Tracker', last_name: 'Quiet',
    date: today, status: 'arriving', arrival_time: '10:00' });
  check('they log a day the ordinary way', logged.ok, String(logged.status));
  const att = await json(await sbFetch(`attendance?name=eq.${encodeURIComponent('Tracker Quiet')}&date=eq.${today}&select=profile_id`));
  check('the row carries their account, not just their name',
    Array.isArray(att) && att[0] && att[0].profile_id === ids.quiet, JSON.stringify(att));
  people = (await json(await get('/api/tracker/people', boss.setCookies))).people || [];
  check('and it brings them back to active', row(ids.quiet).state === 'active',
    `${row(ids.quiet).state}: ${row(ids.quiet).last_what}`);

  await post('/api/admin/settings', boss.setCookies, { quiet_days: 0 });
  people = (await json(await get('/api/tracker/people', boss.setCookies))).people || [];
  check('0 turns the flags off', people.every(p => p.state === 'off'),
    [...new Set(people.map(p => p.state))].join(','));
  await post('/api/admin/settings', boss.setCookies, { quiet_days: 5 });

  /* Retired members are off it, like the org chart: otherwise every alum is
     flagged quiet every day, forever. */
  await post('/api/profile', quiet.setCookies,
    { year: 'Alum', subteam: 'pt', course: '', tags: [], is_public: false, role_label: '' });
  people = (await json(await get('/api/tracker/people', boss.setCookies))).people || [];
  check('a retired member is not on it', !row(ids.quiet).id);

  // ── Notes about a person ──────────────────────────────────────────────
  console.log('\nnotes about a person');
  check('an empty note is refused', (await post('/api/tracker/notes', boss.setCookies,
    { profile_id: ids.member, body: ' ' })).status === 400);
  check('a note about nobody is refused', (await post('/api/tracker/notes', boss.setCookies,
    { profile_id: '00000000-0000-0000-0000-000000000000', body: 'x' })).status === 404);
  const noteR = await post('/api/tracker/notes', boss.setCookies,
    { profile_id: ids.member, body: 'wants to move to aero' });
  const noteId = (await json(noteR)).id;
  check('a note is saved', noteR.ok && !!noteId, String(noteR.status));
  const person = await json(await get('/api/tracker/person?id=' + ids.member, boss.setCookies));
  const line = (person.timeline || []).find(s => s.note_id === noteId);
  check('it is on their timeline, marked private', !!line && line.private === true,
    JSON.stringify(line || null));
  check('beside their items', (person.items || []).some(i => i.id === made.id));
  check('it can be deleted', (await post('/api/tracker/notes/delete', boss.setCookies, { id: noteId })).ok);
  check('once', (await post('/api/tracker/notes/delete', boss.setCookies, { id: noteId })).status === 404);

  // ── Names that match no account ───────────────────────────────────────
  console.log('\nnames that match no account');
  const typed = PREFIX + 'Typo  Name';
  await sbFetch('attendance', 'POST', { name: typed, date: today, status: 'arriving' });
  const keyOf = s => s.split(/\s+/).join(' ').toLowerCase();
  let um = await json(await get('/api/admin/unmatched-names', boss.setCookies));
  check('a name nobody has is listed', (um.names || []).some(n => n.key === keyOf(typed)),
    JSON.stringify((um.names || []).slice(0, 3)));
  const assign = await post('/api/admin/unmatched-names/assign', boss.setCookies,
    { name: PREFIX + 'TYPO name', profile_id: ids.member });
  const assigned = await json(assign);
  check('it can be matched, whatever the case and spacing', assign.ok && assigned.attendance === 1,
    JSON.stringify(assigned));
  const fixed = await json(await sbFetch(`attendance?name=eq.${encodeURIComponent(typed)}&select=profile_id`));
  check('the row now carries that account', fixed[0] && fixed[0].profile_id === ids.member,
    JSON.stringify(fixed));
  um = await json(await get('/api/admin/unmatched-names', boss.setCookies));
  check('and it is off the list', !(um.names || []).some(n => n.key === keyOf(typed)));
  check('matching it again finds nothing to move', (await post('/api/admin/unmatched-names/assign',
    boss.setCookies, { name: typed, profile_id: ids.boss })).status === 404);

  // ── Several people on one item (migrations/018) ─────────────────────
  console.log('\nseveral people on one item');
  const pairTitle = PREFIX + 'pair job ' + Date.now();
  const pairR = await post('/api/tracker/items', boss.setCookies,
    { title: pairTitle, owner_ids: [ids.member, ids.boss, ids.member] });
  const pairText = await pairR.text();
  if (pairR.status === 503 && /018/.test(pairText)) {
    console.log('  ── owner_ids missing; migration 018 not applied, skipping this part ──');
  } else {
    const pair = (JSON.parse(pairText || '{}').item) || {};
    check('an item can have two people on it', pairR.ok && (pair.owner_ids || []).length === 2,
      pairText.slice(0, 120));
    check('in the order given, the duplicate dropped',
      (pair.owner_ids || [])[0] === ids.member && (pair.owner_ids || [])[1] === ids.boss,
      JSON.stringify(pair.owner_ids));
    check('with their names', (pair.owners || []).map(o => o.name).join(',') === 'Tracker Member,Tracker Admin',
      JSON.stringify(pair.owners));
    const ghost = await post('/api/tracker/items', boss.setCookies,
      { title: PREFIX + 'x', owner_ids: [ids.member, '00000000-0000-0000-0000-000000000000'] });
    check('one ghost in the list refuses the lot', ghost.status === 400, await detail(ghost));

    const onIt = async id => ((await json(await get('/api/tracker/person?id=' + id, boss.setCookies)))
      .items || []).some(i => i.id === pair.id);
    check("it is on the first person's list", await onIt(ids.member));
    check("and on the second person's", await onIt(ids.boss));

    /* An update speaks for everyone on the item except whoever wrote it. */
    await post('/api/tracker/items/note', boss.setCookies, { id: pair.id, body: 'pairing on it' });
    const mt = (await json(await get('/api/tracker/person?id=' + ids.member, boss.setCookies))).timeline || [];
    check('an update reaches everyone on it', mt.some(t => /pairing on it/.test(t.text)));

    const off = await post('/api/tracker/items/update', boss.setCookies, { id: pair.id, owner_ids: [ids.member] });
    check('someone can be taken off it', off.ok && ((((await json(off)).item || {}).owner_ids) || []).length === 1);
    const pev = (await json(await get('/api/tracker/items/events?id=' + pair.id, boss.setCookies))).events || [];
    const said = (pev.filter(e => e.kind === 'people').pop() || {}).body || '';
    check('and the history says who, by name', /took Tracker Admin off/i.test(said), said);
    check("and it is off their list", !(await onIt(ids.boss)));
    await post('/api/tracker/items/delete', boss.setCookies, { id: pair.id, title: pairTitle });
  }

  // ── The page ──────────────────────────────────────────────────────────
  console.log('\nthe page');
  const nasty = PREFIX + '<img src=x onerror="window.__pwned=1"> & <b>bold</b>';
  const nastyItem = (await json(await post('/api/tracker/items', boss.setCookies,
    { title: nasty, owner_id: ids.member }))).item || {};
  {
    const { w, d, errors } = await open('/tracker', { setCookies: boss.setCookies });
    check('it loads without errors', errors.length === 0, errors.join(' | '));
    check('the People view draws the member',
      await waitFor(() => d.getElementById('p-' + ids.member)));
    d.getElementById('tab-board').click();
    const card = await waitFor(() => d.getElementById('i-' + nastyItem.id)) && d.getElementById('i-' + nastyItem.id);
    check('the board draws the item', !!card);
    const t = card && card.querySelector('.item-title');
    check('a title is drawn as text, markup and all',
      !!t && t.textContent === nasty && !t.querySelector('img, b'), t ? t.innerHTML.slice(0, 80) : 'missing');
    check('and nothing in it ran', !w.__pwned);
    w.close();
  }

  // ── Deleting ──────────────────────────────────────────────────────────
  console.log('\ndeleting');
  const stale = await post('/api/tracker/items/delete', boss.setCookies, { id: made.id, title: 'something else' });
  check('deleting needs the title echoed back', stale.status === 400, await detail(stale));
  check('with it, the item goes',
    (await post('/api/tracker/items/delete', boss.setCookies, { id: made.id, title })).ok);
  check('and its history with it',
    ((await json(await get('/api/tracker/items/events?id=' + made.id, boss.setCookies))).events || []).length === 0);
  await post('/api/tracker/items/delete', boss.setCookies, { id: nastyItem.id, title: nasty });

  // ── Putting things back ───────────────────────────────────────────────
  await restoreQuiet();
  await sbFetch(`attendance?name=eq.${encodeURIComponent('Tracker Quiet')}`, 'DELETE');
  await sbFetch(`attendance?name=eq.${encodeURIComponent(typed)}`, 'DELETE');
  const back = await json(await get('/api/admin/settings', boss.setCookies));
  check('the quiet threshold is put back', back.quiet_days === (settingsBefore.quiet_days ?? 5),
    `${settingsBefore.quiet_days} → ${back.quiet_days}`);

  process.exit(summary('tracker') ? 1 : 0);
})().catch(e => { console.error('  suite crashed:', e.message); process.exit(1); });
