/* Subteams and team profiles.
 *
 * Two things this suite exists to protect, both of which fail silently:
 *
 *   1. "Filter, never hide." A subteam tag is presentational. A typo in one,
 *      "powertrain" instead of "pt", makes an applet vanish from every chip
 *      including its own, and nothing errors. The invariants below assert that
 *      every applet is reachable under some chip and that `all`-tagged ones are
 *      reachable under all of them.
 *
 *   2. "Tags are not permissions." An Operations member must still be able to
 *      open the PT plan. If subteams ever start gating routes, someone gets
 *      locked out of something they need at 2am before a deadline, so it is
 *      asserted here rather than left as a comment.
 *
 * Everything that needs migration 003 is gated on a probe: if it has not been
 * applied yet the suite says so loudly and skips those checks, rather than
 * reporting a schema gap as a code failure.
 */
const { BASE, check, summary, open, signUp, waitFor } = require('./lib');

/* A real 1×1 PNG. Used to prove the upload path accepts a genuine image and
   the sniffer is reading bytes rather than the declared content type. */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const json = async (r) => { try { return await r.json(); } catch (e) { return {}; } };

/* One second of slack: the container clock and this one are not the same. */
const STARTED = Date.now() - 1000;

(async () => {
  const a = await signUp('Profile', 'Alpha');
  const b = await signUp('Profile', 'Bravo');
  const hdrA = { Cookie: a.setCookies.map(c => c.split(';')[0]).join('; ') };
  const hdrB = { Cookie: b.setCookies.map(c => c.split(';')[0]).join('; ') };
  const post = (path, body, hdr = hdrA) => fetch(BASE + path, {
    method: 'POST',
    headers: { ...hdr, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  console.log('the subteam vocabulary');
  const subteams = (await json(await fetch(BASE + '/api/subteams', { headers: hdrA }))).subteams || [];
  const ids = subteams.map(s => s.id);
  check('three subteams, with ids', ids.length === 3 && ids.every(Boolean), ids.join(', '));
  check('every subteam has a name, icon and accent',
    subteams.every(s => s.name && s.icon && s.accent),
    JSON.stringify(subteams.map(s => s.name)));

  console.log('\nregistry tags');
  const applets = (await json(await fetch(BASE + '/api/applets', { headers: hdrA }))).applets || [];
  const tagsOf = x => (x.subteams && x.subteams.length) ? x.subteams : ['all'];

  const unknown = applets.flatMap(x => tagsOf(x)
    .filter(t => t !== 'all' && ids.indexOf(t) < 0)
    .map(t => `${x.id}:${t}`));
  // The silent one: a tag naming a subteam that does not exist puts the applet
  // behind a chip nobody can ever click.
  check('no applet tags a subteam that does not exist', unknown.length === 0, unknown.join(' '));

  check('every applet carries a subteam tag',
    applets.every(x => Array.isArray(x.subteams) && x.subteams.length),
    applets.filter(x => !x.subteams).map(x => x.id).join(' ') || 'all tagged');

  check('the profiles applet is registered',
    applets.some(x => x.id === 'profiles' && x.route === '/profiles'));

  // requires_role: a gated entry is omitted for people who may not open it,
  // rather than shown as a tile that exists only to refuse them.
  check('a member never sees the gated admin applet',
    !applets.some(x => x.id === 'admin'),
    applets.map(x => x.id).join(' '));
  const gatedPage = await fetch(BASE + '/admin', { headers: hdrA, redirect: 'manual' });
  check('and cannot open it directly either', gatedPage.status === 403,
    'GET /admin → ' + gatedPage.status);

  console.log('\nfilter, never hide');
  const visibleUnder = (x, f) => f === 'all' ||
    tagsOf(x).indexOf('all') >= 0 || tagsOf(x).indexOf(f) >= 0;

  const orphans = applets.filter(x => !['all'].concat(ids).some(f => visibleUnder(x, f)));
  check('every applet is reachable under some chip', orphans.length === 0,
    orphans.map(x => x.id).join(' '));

  const shared = applets.filter(x => tagsOf(x).indexOf('all') >= 0);
  check('all-tagged applets show under every subteam',
    shared.every(x => ids.every(f => visibleUnder(x, f))),
    `${shared.length} shared applets`);

  check('each subteam chip shows something',
    ids.every(f => applets.some(x => visibleUnder(x, f))),
    ids.map(f => `${f}:${applets.filter(x => visibleUnder(x, f)).length}`).join(' '));

  console.log('\ntags are not permissions');
  // Alpha is about to become Operations. The PT plan is tagged ["pt"], and must
  // stay open to them regardless. Relevance is not access.
  const ptPage = await fetch(BASE + '/pt', { headers: hdrA, redirect: 'manual' });
  check('an applet outside your subteam is still reachable', ptPage.status === 200,
    'GET /pt → ' + ptPage.status);

  console.log('\nmigration 003');
  const probe = await post('/api/profile/subteam', { subteam: 'ops' });
  const ready = probe.status === 200;
  check('profile tables are present', ready,
    ready ? 'applied' : `not applied: POST /api/profile/subteam → ${probe.status}`);

  if (!ready) {
    console.log('\n  ── migrations/003 has not been applied; skipping the rest ──');
    console.log('  Run it in the Supabase SQL editor, then re-run this suite.');
    process.exit(summary('profiles') ? 1 : 0);
  }

  console.log('\nthe first-sign-in question');
  const picked = await json(probe);
  check('picking a subteam is saved', picked.profile && picked.profile.subteam === 'ops',
    JSON.stringify(picked.profile || {}));
  // The dashboard filter reads the cookie, so the cookie has to move too.
  const reCookie = (probe.headers.getSetCookie ? probe.headers.getSetCookie() : [])
    .find(c => c.startsWith('ucdfs_profile='));
  check('the profile cookie is rewritten', !!reCookie && /ops/.test(decodeURIComponent(reCookie)),
    reCookie ? 'rewritten' : 'not set');

  // "Not sure yet" is an answer, not a skip: null subteam, but onboarded, so
  // nobody gets asked the same question every single page load.
  const unsure = await post('/api/profile/subteam', { subteam: null }, hdrB);
  const meB = await json(await fetch(BASE + '/api/profile/me', { headers: hdrB }));
  check('"not sure yet" saves as no subteam', unsure.status === 200 &&
    meB.person && meB.person.subteam === null, JSON.stringify(meB.person || {}));
  check('"not sure yet" still counts as onboarded', meB.onboarded === true,
    'onboarded=' + meB.onboarded);
  check('/api/profile/me reports the schema is ready', meB.ready === true);

  console.log('\nsaving a profile');
  const saved = await post('/api/profile', {
    subteam: 'pt',
    subteams_extra: ['mech', 'pt', 'nonsense'],
    year: '3rd', course: 'Mechanical Engineering', joined_year: 2024,
    role_label: 'captain', is_public: false,
    tags: ['CAN bus', 'can bus', ' Welding ', ''],
    prompts: [
      { key: 'why-joined',    answer: 'To build a car.' },
      { key: 'essential-tool', answer: 'A 10mm socket I keep losing.' },
      { key: 'not-a-real-prompt', answer: 'should be dropped' },
      { key: 'dream-job',     answer: 'Race engineer.' },
      { key: 'best-memory',   answer: 'Over the cap, should be dropped.' },
    ],
  });
  check('profile saves', saved.status === 200, 'status ' + saved.status);

  const me = await json(await fetch(BASE + '/api/profile/me', { headers: hdrA }));
  const p  = me.person || {};
  check('fields round-trip', p.year === '3rd' && p.course === 'Mechanical Engineering' &&
    p.joined_year === 2024 && p.role_label === 'captain',
    JSON.stringify({ y: p.year, c: p.course, j: p.joined_year, r: p.role_label }));
  // The page renders year_label directly, so "Alum" never leaks as a raw value.
  check('a year comes with its label', p.year_label === '3rd year', p.year_label);
  check('a division role reports its scope',
    p.role_name === 'Captain' && p.role_scope === 'division',
    `${p.role_name} / ${p.role_scope}`);

  // Case-folded and de-duplicated, or "CAN bus" and "can bus" become two chips
  // for the same skill and the directory stops being searchable.
  check('tags are folded and de-duplicated',
    JSON.stringify(p.tags) === JSON.stringify(['can bus', 'welding']),
    JSON.stringify(p.tags));

  check('your primary subteam is not also an extra',
    p.subteam === 'pt' && (p.subteams_extra || []).indexOf('pt') < 0,
    `${p.subteam} + [${p.subteams_extra}]`);
  check('an unrecognised extra subteam is dropped, not stored',
    (p.subteams_extra || []).indexOf('nonsense') < 0, JSON.stringify(p.subteams_extra));

  check('prompts are capped at three', (p.prompts || []).length <= 3,
    `${(p.prompts || []).length} stored`);
  check('an unknown prompt key is dropped',
    !(p.prompts || []).some(q => q.key === 'not-a-real-prompt'));
  check('answers keep their prompt label',
    (p.prompts || []).every(q => q.label && q.label !== q.key),
    JSON.stringify((p.prompts || []).map(q => q.label)));

  // Replace-all: saving two prompts must leave exactly two, not merge with the
  // three that were there before.
  const resaved = await post('/api/profile', { subteam: 'pt', role_label: 'captain',
    tags: ['can bus'],
    prompts: [{ key: 'why-joined', answer: 'Still to build a car.' }] });
  const after = await json(await fetch(BASE + '/api/profile/me', { headers: hdrA }));
  check('re-saving replaces prompts rather than appending',
    (after.person.prompts || []).length === 1,
    `${(after.person.prompts || []).length} left`);

  console.log('\nthe activity feed');
  // Joining the directory is news. Rewording your answer about the 10mm socket
  // is not, and 30 people editing during recruitment week would bury every
  // other applet's lines, which is the same reason attendance stays out.
  // Scoped to this run. activity_log is append-only and stores the actor as
  // text captured at write time, so lines written by *previous* runs survive
  // their accounts being deleted. Matching on the name alone would count them.
  const feed = (await json(await fetch(BASE + '/api/dashboard', { headers: hdrA }))).activity || [];
  const mine = feed.filter(i => i.applet === 'profiles' &&
                                /Alpha/.test(i.actor || '') &&
                                Date.parse(i.created_at) >= STARTED);
  check('filling in a profile writes exactly one feed line', mine.length === 1,
    `${mine.length} lines this run: ${mine.map(i => i.verb).join(' | ')}`);

  console.log('\nthe directory');
  const dir = await json(await fetch(BASE + '/api/profiles', { headers: hdrA }));
  check('directory lists people', Array.isArray(dir.people) && dir.people.length >= 2,
    `${(dir.people || []).length} people`);
  check('it says which one is me', dir.me && dir.people.some(x => x.id === dir.me));
  check('it ships the option lists the editor needs',
    (dir.prompts || []).length >= 10 && (dir.subteams || []).length === 3 &&
    (dir.years || []).length > 0 && (dir.roles || []).length > 0,
    `${(dir.prompts || []).length} prompts, ${(dir.years || []).length} years`);
  // Nobody on the team is a PhD, and graduates need somewhere to go.
  const yearVals = (dir.years || []).map(y => y.value);
  check('years offer a retired member and no PhD',
    yearVals.indexOf('Alum') >= 0 && yearVals.indexOf('PhD') < 0,
    yearVals.join(' '));
  check('retired members read as such',
    (dir.years || []).some(y => y.value === 'Alum' && y.label === 'Retired member'),
    JSON.stringify((dir.years || []).find(y => y.value === 'Alum')));
  // Captains and members belong to a division; the Team Principal and Technical
  // Director sit across all three, which is what scope records.
  const roleVals = (dir.roles || []).map(r => r.value);
  check('roles are captain / vice / member, plus the two team-wide ones',
    ['captain', 'vice', 'member', 'principal', 'td'].every(r => roleVals.indexOf(r) >= 0),
    roleVals.join(' '));
  check('exactly the two team-wide roles have no division',
    (dir.roles || []).filter(r => r.scope === 'team').map(r => r.value).sort().join(',')
      === 'principal,td',
    (dir.roles || []).filter(r => r.scope === 'team').map(r => r.value).join(' '));
  const alpha = (dir.people || []).find(x => x.id === dir.me) || {};
  check('my saved profile appears in the directory',
    alpha.subteam === 'pt' && (alpha.tags || []).indexOf('can bus') >= 0,
    JSON.stringify({ s: alpha.subteam, t: alpha.tags }));

  console.log('\nyou can only edit your own');
  // There is no id in the body by design. If one is ever honoured, this fails.
  const beforeB = (await json(await fetch(BASE + '/api/profile/me', { headers: hdrB }))).person;
  await post('/api/profile', { id: b.email, profile_id: beforeB.id,
    subteam: 'mech', course: 'INJECTED', tags: ['injected'] }, hdrA);
  const afterB = (await json(await fetch(BASE + '/api/profile/me', { headers: hdrB }))).person;
  check("another account's profile is untouched",
    afterB.course !== 'INJECTED' && (afterB.tags || []).indexOf('injected') < 0 &&
    afterB.subteam === null,
    JSON.stringify({ c: afterB.course, t: afterB.tags, s: afterB.subteam }));

  console.log('\nphotos');
  const up = await post('/api/profile/photo', { data: 'data:image/png;base64,' + PNG_1PX });
  const upJson = await json(up);
  check('a real image uploads', up.status === 200 && !!upJson.photo,
    up.status + ' ' + (upJson.photo || upJson.detail || ''));
  // Photos overwrite in place, so without ?v= the browser keeps showing the old
  // one after someone changes their picture.
  check('the URL is cache-busted', /\?v=\d+/.test(upJson.photo || ''), upJson.photo);

  const fetched = await fetch(BASE + upJson.photo, { headers: hdrA });
  check('the photo is served back', fetched.status === 200 &&
    (fetched.headers.get('content-type') || '').startsWith('image/'),
    fetched.status + ' ' + fetched.headers.get('content-type'));

  // Members-only by default. This is the entire reason avatars are served by a
  // route instead of being dropped in static/ where StaticFiles would hand them
  // to anyone with the URL.
  const anon = await fetch(BASE + upJson.photo, { redirect: 'manual' });
  check('a signed-out request gets nothing', anon.status === 401,
    'status ' + anon.status);

  const notImage = await post('/api/profile/photo',
    { data: 'data:image/png;base64,' + Buffer.from('hello world').toString('base64') });
  check('a non-image is refused whatever it claims to be', notImage.status === 400,
    'status ' + notImage.status);

  const traversal = await fetch(BASE + '/media/avatars/' +
    encodeURIComponent('../../main.py'), { headers: hdrA });
  check('a filename we did not write is a 404', traversal.status === 404,
    'status ' + traversal.status);

  // The header pill, the nowbar and the attendance list all draw faces. The
  // pill reads the cookie (so it stays synchronous), the other two read the map.
  // If either stops being written, faces silently revert to initials.
  const photoCookie = (up.headers.getSetCookie ? up.headers.getSetCookie() : [])
    .find(c => c.startsWith('ucdfs_profile='));
  check('uploading rewrites the profile cookie so the pill updates',
    !!photoCookie && /media\/avatars/.test(decodeURIComponent(photoCookie)),
    photoCookie ? 'rewritten' : 'not set');

  // A photo URL contains "/", which is not legal raw in a cookie value, so leave
  // it unencoded and the whole cookie comes back double-quoted, JSON.parse
  // reads it as a string, and every page decides you are signed out the moment
  // you upload a photo. This asserts the value is still readable as an object.
  const rawProfile = (photoCookie || '').split(';')[0].replace(/^ucdfs_profile=/, '');
  let parsedCookie = null;
  try { parsedCookie = JSON.parse(decodeURIComponent(rawProfile)); } catch (e) { /* stays null */ }
  check('the profile cookie survives holding a photo URL',
    !!parsedCookie && typeof parsedCookie === 'object' && parsedCookie.first === 'Profile',
    typeof parsedCookie + ': ' + rawProfile.slice(0, 40));
  check('it is not wrapped in quotes', !/^"/.test(rawProfile), rawProfile.slice(0, 20));

  const map = (await json(await fetch(BASE + '/api/people/photos', { headers: hdrA }))).photos || {};
  check('the name→photo map finds it', map['profile alpha'] === upJson.photo,
    map['profile alpha'] || '(missing)');
  check('the map is keyed lower-case, as the name-keyed pages look it up',
    Object.keys(map).every(k => k === k.toLowerCase()),
    Object.keys(map).slice(0, 3).join(' | '));

  console.log('\nteam-wide roles');
  // Bravo, not Alpha: the Team Principal and Technical Director are not in a
  // division, and Alpha has to stay a Powertrain captain for the page checks
  // below. Saving a team-wide role must not quietly leave them filed under
  // whichever subteam they last had.
  await post('/api/profile', { subteam: 'mech', role_label: 'principal',
                               year: 'Alum', tags: ['fundraising'] }, hdrB);
  const tp = (await json(await fetch(BASE + '/api/profile/me', { headers: hdrB }))).person;
  check('a team-wide role reports its scope',
    tp.role_label === 'principal' && tp.role_scope === 'team',
    JSON.stringify({ r: tp.role_label, s: tp.role_scope }));
  check('it reads as Team Principal', tp.role_name === 'Team Principal', tp.role_name);
  check('a retired member reads as one, not as a year',
    tp.year === 'Alum' && tp.year_label === 'Retired member', tp.year_label);

  // Directory order is a team, not an alphabet: principal, TD, captains, rest.
  const ranked = (await json(await fetch(BASE + '/api/profiles', { headers: hdrA }))).people || [];
  const filledRows = ranked.filter(x => x.photo || (x.prompts || []).length);
  check('filled profiles come out in role order',
    filledRows.every((x, i) => i === 0 || filledRows[i - 1].role_rank <= x.role_rank),
    filledRows.map(x => `${x.name}:${x.role_rank}`).slice(0, 4).join(' | '));

  console.log('\nthe pages');
  // The cookies handed back by signUp() predate every save above, so the profile
  // half of them still says "no subteam" and has no photo. Swap in the one the
  // photo upload rewrote: the most recent, and what the dashboard actually
  // reads. Using the stale pair would test a state no real browser is ever in.
  const freshProfileCookie = (up.headers.getSetCookie ? up.headers.getSetCookie() : [])
    .filter(c => c.startsWith('ucdfs_profile='));
  const cookiesA = a.setCookies.filter(c => !c.startsWith('ucdfs_profile='))
                               .concat(freshProfileCookie);
  check('a save hands back an updated profile cookie', freshProfileCookie.length === 1,
    `${freshProfileCookie.length} profile cookies returned`);

  /* What Alpha actually looks like now, for the assertions that have to agree
     with it rather than with a value written further up the file. */
  const alphaNow = (await json(await fetch(BASE + '/api/profile/me', { headers: hdrA }))).person;

  {
    const { w, d, errors } = await open('/profiles', { setCookies: cookiesA, failOnPrompt: true });
    check('profiles page loads clean', errors.length === 0, errors.slice(0, 3).join('; '));
    check('the grid renders a card per person',
      d.querySelectorAll('#grid .person').length >= 2,
      `${d.querySelectorAll('#grid .person').length} cards`);
    check('subteam chips are built', d.querySelectorAll('#team-chips .chip').length === 4,
      `${d.querySelectorAll('#team-chips .chip').length} chips`);
    check('tag chips come from what people actually wrote',
      d.querySelectorAll('#tag-chips .chip').length >= 1,
      d.getElementById('tag-chips').textContent.replace(/\s+/g, ' ').trim());
    check('my own card is marked', !!d.querySelector('#grid .person.me'));
    w.close();
  }
  {
    // ?edit=1 is how the dashboard's onboarding step hands over. If it stops
    // opening the editor, that flow dead-ends on a page with no obvious next
    // step, which is exactly the drop-off this feature exists to avoid.
    const { w, d } = await open('/profiles?edit=1', { setCookies: cookiesA, failOnPrompt: true });
    check('?edit=1 opens the editor', d.getElementById('sheet').style.display === 'flex',
      d.getElementById('sheet').style.display || '(hidden)');
    check('the editor offers every prompt',
      d.querySelectorAll('#slots select option').length >= 3 * 10,
      `${d.querySelectorAll('#slots select option').length} options across the slots`);
    check('members-only is the default the form shows',
      d.getElementById('f-public').checked === false);

    // Skills are bubbles you type and Enter, not a comma-separated string.
    check('skills are entered as bubbles', !!d.getElementById('tag-box') &&
      d.querySelectorAll('#tag-box .tag-bubble').length >= 1,
      `${d.querySelectorAll('#tag-box .tag-bubble').length} bubbles`);
    check('each bubble can be removed',
      d.querySelectorAll('#tag-box .tag-bubble .tag-x').length ===
      d.querySelectorAll('#tag-box .tag-bubble').length);

    const roleOpts = [...d.querySelectorAll('#f-role option')].map(o => o.textContent.trim());
    check('the role list is the real one',
      ['Team member', 'Vice captain', 'Captain', 'Technical Director', 'Team Principal']
        .every(r => roleOpts.indexOf(r) >= 0),
      roleOpts.join(' | '));
    check('a division role keeps the division picker',
      d.getElementById('team-field').style.display !== 'none',
      d.getElementById('team-field').style.display || '(shown)');

    const yearOpts = [...d.querySelectorAll('#f-year option')].map(o => o.textContent.trim());
    check('the year list retires people rather than offering a PhD',
      yearOpts.indexOf('Retired member') >= 0 && yearOpts.indexOf('PhD') < 0,
      yearOpts.join(' | '));

    check('the cropper is present but closed until a file is chosen',
      !!d.getElementById('crop-canvas') &&
      d.getElementById('cropper').style.display === 'none');
    // The cropper opens *from* the editor, and both are .sheet. Without a
    // higher z-index the tie goes to DOM order and the cropper opens behind the
    // form that launched it, invisible, with the page apparently frozen.
    // jsdom has no layout, so this reads the rule out of the served stylesheet.
    {
      const css = [...d.querySelectorAll('style')].map(s => s.textContent).join('\n');
      const sheetZ = +(css.match(/\.sheet\s*\{[^}]*z-index:\s*(\d+)/) || [])[1];
      const cropZ  = +(css.match(/#cropper\s*\{[^}]*z-index:\s*(\d+)/) || [])[1];
      check('the cropper stacks above the editor', cropZ > sheetZ,
        `#cropper ${cropZ} vs .sheet ${sheetZ}`);
    }
    w.close();
  }
  {
    const { w, d, errors } = await open('/', { setCookies: cookiesA, failOnPrompt: true });
    // Wait for the dashboard to have actually drawn before counting anything on
    // it: open()'s settle() window is shorter than /api/dashboard needs on a
    // busy runner, and every count below then reads zero. See waitFor in lib.js.
    check('the dashboard finishes drawing',
      await waitFor(() => w.eval('TILES_LOADED') === true), 'TILES_LOADED still false');
    const chips = [...d.querySelectorAll('#subteam-chips .chip')];
    check('dashboard has a chip per subteam plus All', chips.length === 4,
      `${chips.length} chips`);
    // Derived, not hard-coded: Alpha's subteam has moved a few times by now
    // (the self-only write check above posts as Alpha, so it changes Alpha).
    // What matters is that the chip agrees with the cookie, whatever it says.
    const expectTeam = (subteams.find(s => s.id === alphaNow.subteam) || {}).name;
    const activeChip = (d.querySelector('#subteam-chips .chip.active') || {}).textContent || '';
    check('the filter defaults to my subteam',
      !!expectTeam && activeChip.trim().startsWith(expectTeam),
      `${activeChip.trim()}, expected ${expectTeam}`);

    // Every card on the page, across both blocks. The dashboard groups them
    // now (Tools, then Last season), and "filter, never hide" is a claim about
    // the page, not about one container. Counting only #applet-grid would call
    // the archived cards missing.
    const shownCards = () =>
      [...d.querySelectorAll('#applet-grid .applet, #applet-groups .applet')];

    // Note this is not the full grid: the filter has already defaulted to
    // Powertrain, which is the point of the check above.
    const onLoad = shownCards().length;
    check('the default filter is already narrowing', onLoad < applets.length && onLoad > 0,
      `${onLoad} of ${applets.length} on load`);

    chips.find(c => c.dataset.filter === 'ops').click();
    const opsCards = shownCards();
    check('a chip narrows the grid', opsCards.length < applets.length && opsCards.length > 0,
      `${applets.length} → ${opsCards.length}`);
    // The load-bearing half of "filter, never hide": shared tools survive every
    // filter, so the dashboard can never be narrowed down to nothing useful.
    check('all-tagged tools survive the filter',
      opsCards.some(c => /Attendance/.test(c.textContent)) &&
      opsCards.some(c => /Team Profiles/.test(c.textContent)),
      opsCards.map(c => c.querySelector('.applet-name').textContent.trim()).join(' | '));

    // Nothing on this page can be made permanently unreachable by a chip.
    chips.find(c => c.dataset.filter === 'all').click();
    check('clearing the filter brings everything back',
      shownCards().length === applets.length,
      `${shownCards().length} of ${applets.length}`);

    // The overlay is built by shared.js only when it is needed, so "not asked"
    // now means the element was never created rather than created and hidden.
    check('someone already onboarded is not asked again',
      !d.getElementById('onboard'),
      d.getElementById('onboard') ? 'overlay present' : 'never raised');
    // Your own face in the header, drawn from the cookie so it needs no fetch.
    check('the header pill shows your photo when you have one',
      /media\/avatars/.test(d.getElementById('pill-avatar').style.backgroundImage || ''),
      d.getElementById('pill-avatar').style.backgroundImage || '(initials)');
    check('no page errors', errors.length === 0, errors.slice(0, 3).join('; '));
    w.close();
  }
  {
    // A brand-new account: never asked, so the step must appear. This is the
    // September recruitment path and the only chance to catch it.
    const fresh = await signUp('Profile', 'Fresh');
    const { w, d } = await open('/', { setCookies: fresh.setCookies, failOnPrompt: true });
    check('a new account gets the subteam question', !!d.getElementById('onboard'),
      d.getElementById('onboard') ? 'raised' : 'never raised');
    check('it offers all three plus "not sure yet"',
      d.querySelectorAll('#ob-opts .ob-opt').length === 3 &&
      /Not sure yet/.test((d.getElementById('ob-later') || {}).textContent || ''),
      `${d.querySelectorAll('#ob-opts .ob-opt').length} options`);
    w.close();
  }
  {
    // The point of moving it into shared.js: someone who signs up from a
    // bookmarked deep link used to reach that page unasked, and stayed unasked
    // until they happened to open the dashboard.
    const deep = await signUp('Profile', 'Deep');
    const { w, d } = await open('/attendance', { setCookies: deep.setCookies, failOnPrompt: true });
    check('and gets it on a deep link too, not just the dashboard',
      !!d.getElementById('onboard') &&
      d.querySelectorAll('#ob-opts .ob-opt').length === 3,
      d.getElementById('onboard') ? 'raised on /attendance' : 'never raised');
    w.close();
  }

  console.log('\nfavourite tools');
  {
    // Stored against the account, not the browser. That is the whole reason
    // this lives in profile_details and not in localStorage beside the subteam
    // chip. So the test reads it back from the API, not from a rendered page.
    const favs = async (hdr = hdrA) =>
      (await json(await fetch(BASE + '/api/applets', { headers: hdr }))).favourites;

    const start = await favs();
    check('/api/applets reports favourites', Array.isArray(start),
      JSON.stringify(start));

    const on = await post('/api/profile/favourites', { id: 'harness', on: true });
    const afterOn = await favs();
    check('a card can be starred', on.status === 200, 'status ' + on.status);
    check('and it comes back on the next load', afterOn.includes('harness'),
      JSON.stringify(afterOn));

    // The id is read back and rendered, so junk must never reach the column.
    const junk = await post('/api/profile/favourites', { id: 'not-an-applet', on: true });
    check('an unknown id is refused', junk.status === 400, 'got ' + junk.status);
    // A gated card is not on your dashboard to star, so a request to star one
    // did not come from the UI. Alpha is a member; admin requires the role.
    const gated = await post('/api/profile/favourites', { id: 'admin', on: true });
    check('a card you may not open is refused', gated.status === 403,
      'got ' + gated.status);
    const afterJunk = await favs();
    check('neither one landed in the column',
      !afterJunk.some(f => f === 'not-an-applet' || f === 'admin'),
      JSON.stringify(afterJunk));

    // Per account, not per browser: Bravo must not inherit Alpha's list.
    const bravoFavs = (await favs(hdrB)) || [];
    check("another account's list is its own", !bravoFavs.includes('harness'),
      JSON.stringify(bravoFavs));

    const off = await post('/api/profile/favourites', { id: 'harness', on: false });
    const afterOff = await favs();
    check('a card can be un-starred',
      off.status === 200 && !afterOff.includes('harness'), JSON.stringify(afterOff));
  }

  console.log('\nremoving a photo');
  // Last, because every page check above needs Alpha to still have one.
  const removed = await post('/api/profile/photo/remove', {});
  const afterRemove = await json(await fetch(BASE + '/api/profile/me', { headers: hdrA }));
  check('a photo can be removed', removed.status === 200 &&
    afterRemove.person.photo === null, JSON.stringify(afterRemove.person.photo));
  const goneMap = (await json(await fetch(BASE + '/api/people/photos', { headers: hdrA }))).photos || {};
  check('it leaves the name→photo map too', !goneMap['profile alpha'],
    goneMap['profile alpha'] || 'gone');

  process.exit(summary('profiles') ? 1 : 0);
})().catch(e => { console.error('  suite crashed:', e.message); process.exit(1); });
