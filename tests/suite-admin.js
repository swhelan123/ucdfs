/* Roles, god mode and the permission boundary.
 *
 * This is the only suite covering code where being wrong means someone can do
 * something they shouldn't, so it leans on negatives: what an ordinary member
 * is refused, what an un-elevated admin is refused, and what cannot be done
 * even with god mode (locking every admin out of the app).
 *
 * The two things it exists to stop regressing:
 *
 *   1. **Hiding a control is not a permission.** /api/log and /api/log/delete
 *      took a name from the request body and wrote it, so any signed-in member
 *      could delete anybody's attendance with one fetch — the page just didn't
 *      draw the button. Ownership is enforced server-side now.
 *
 *   2. **The switch has to be re-flippable.** God mode gates everything except
 *      its own toggle. If that endpoint ever starts requiring god mode, an
 *      admin who switches off is locked out of switching back on, and the only
 *      way back is editing the database by hand.
 *
 * The elevated half promotes the suite's own throwaway account with the service
 * key rather than asking for a real admin's password, so it runs everywhere.
 * Note that its profile cookie still says "member" throughout — the checks
 * passing anyway is the proof that authorization comes from the database.
 */
const { BASE, check, summary, open, signUp, waitFor } = require('./lib');

const json = async (r) => { try { return await r.json(); } catch (e) { return {}; } };
const today = new Date().toISOString().slice(0, 10);

(async () => {
  const a = await signUp('Admin', 'Probe');
  const b = await signUp('Admin', 'Victim');
  // A third account that exists only to be erased, so account deletion can be
  // tested end to end without taking the victim out from under the checks that
  // come after it.
  const c = await signUp('Admin', 'Doomed');
  const hdrA = { Cookie: a.setCookies.map(c => c.split(';')[0]).join('; ') };
  const hdrB = { Cookie: b.setCookies.map(c => c.split(';')[0]).join('; ') };
  const hdrC = { Cookie: c.setCookies.map(x => x.split(';')[0]).join('; ') };
  const post = (path, body, hdr = hdrA) => fetch(BASE + path, {
    method: 'POST', headers: { ...hdr, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  console.log('an ordinary member is refused');
  for (const [label, path, body] of [
    ['the admin page',      '/admin',                null],
    ['the people list',     '/api/admin/people',     null],
    ['handing out roles',   '/api/admin/role',       { id: 'x', role: 'admin' }],
    ['switching god mode',  '/api/admin/god-mode',   { on: true }],
    ['deleting an account', '/api/admin/user/delete',
      { id: 'x', confirm_email: 'x@ucdconnect.ie' }],
    ['deleting a feed line','/api/admin/activity/delete',
      { source: 'activity_log', id: 1 }],
  ]) {
    const r = body === null && path.startsWith('/api')
      ? await fetch(BASE + path, { headers: hdrA })
      : body === null
        ? await fetch(BASE + path, { headers: hdrA, redirect: 'manual' })
        : await post(path, body);
    check(`${label} → 403`, r.status === 403, `${path} → ${r.status}`);
  }

  // Not a 401: they are signed in, they simply may not. Getting this wrong
  // bounces a legitimate member to /login in a loop.
  const anon = await fetch(BASE + '/api/admin/people', { redirect: 'manual' });
  check('signed out is 401, not 403', anon.status === 401, 'status ' + anon.status);

  // The privileged profile write. The self-service /api/profile has no id
  // parameter at all, so this is the only route that can name a target — and it
  // has to refuse anyone unelevated.
  const meB0 = (await json(await fetch(BASE + '/api/profile/me', { headers: hdrB }))).person;
  const steal = await post('/api/admin/profile',
    { id: meB0.id, course: 'INJECTED', tags: ['injected'] });
  check("a member cannot save someone else's profile", steal.status === 403,
    'status ' + steal.status);
  const stealPhoto = await post('/api/profile/photo/remove', { id: meB0.id });
  check("nor remove someone else's photo", stealPhoto.status === 403,
    'status ' + stealPhoto.status);
  const untouched = (await json(await fetch(BASE + '/api/profile/me', { headers: hdrB }))).person;
  check('and the target is unchanged', untouched.course !== 'INJECTED',
    JSON.stringify(untouched.course));

  console.log('\nattendance ownership is enforced, not just hidden');
  // Probe logs their own day — allowed.
  const own = await post('/api/log', {
    first_name: 'Admin', last_name: 'Probe', date: today,
    status: 'arriving', arrival_time: '09:00',
  });
  check('you can log your own attendance', own.status === 200, 'status ' + own.status);

  // The regression this suite was written for: writing somebody else's row.
  const other = await post('/api/log', {
    first_name: 'Admin', last_name: 'Victim', date: today,
    status: 'arriving', arrival_time: '23:00',
  });
  check("you cannot log someone else's", other.status === 403, 'status ' + other.status);

  const wipe = await post('/api/log/delete', {
    first_name: 'Admin', last_name: 'Victim', date: today,
  });
  check("you cannot delete someone else's", wipe.status === 403, 'status ' + wipe.status);

  // Case and spacing must not decide whether you own your own history: these
  // rows predate accounts and were typed by hand.
  const sloppy = await post('/api/log', {
    first_name: '  admin', last_name: 'PROBE  ', date: today,
    status: 'absent',
  });
  check('your own row is yours whatever the spelling', sloppy.status === 200,
    'status ' + sloppy.status);

  // Victim's row was never written, so nothing to clean up beyond Probe's.
  await post('/api/log/delete', { first_name: 'Admin', last_name: 'Probe', date: today });

  console.log('\nthe comp hub no longer takes a shared password');
  const comp = await post('/comp/api/admin/verify', { password: 'anything-at-all' });
  check('a password does not unlock committee actions', comp.status === 403,
    'status ' + comp.status);
  const roster = await post('/comp/api/roster',
    { day: 'Mon', role: 'runner', name: 'Nobody', password: 'anything-at-all' });
  check('nor does one let you write the roster', roster.status === 403,
    'status ' + roster.status);

  console.log('\nthe override banner');
  {
    const { w, d } = await open('/', { setCookies: a.setCookies, failOnPrompt: true });
    check('a member never sees it', !d.getElementById('ucdfs-override-bar'));
    // Both halves matter. "No card called Admin" is satisfied by a grid with
    // nothing in it, which is what an undrawn dashboard looks like — so the
    // cards have to be there before their absence means anything.
    await waitFor(() => w.eval('TILES_LOADED') === true);
    const memberCards = [...d.querySelectorAll('#applet-grid .applet, #applet-groups .applet')];
    check('and gets no admin card',
      memberCards.length > 0 && !memberCards.some(c => /Admin/.test(c.textContent)),
      `${memberCards.length} cards: ` +
      [...d.querySelectorAll('.applet-name')].map(e => e.textContent.trim()).join(' | '));
    w.close();
  }
  {
    // The banner is drawn from the cookie, so a forged one draws it — and must
    // still grant nothing. This is the same property the profile cookie has
    // had a test for since auth landed; god_mode must not be the exception.
    const forged = a.setCookies
      .filter(c => !c.startsWith('ucdfs_profile='))
      .concat(['ucdfs_profile=' + encodeURIComponent(JSON.stringify({
        first: 'Admin', last: 'Probe', name: 'Admin Probe',
        email: 'x@ucdconnect.ie', role: 'admin', god_mode: true,
      })) + '; Path=/']);
    const { w, d } = await open('/', { setCookies: forged, failOnPrompt: true });
    const bar = d.getElementById('ucdfs-override-bar');
    check('a forged cookie can draw the banner', !!bar);
    // It is drawn by shared.js, which the canvas tools load without shared.css.
    // Anything injected from there has to carry its own styles or it renders as
    // raw text on exactly the pages nobody thinks to check.
    check('and the banner carries its own stylesheet',
      !!d.getElementById('ucdfs-runtime-css') &&
      /\.ucdfs-bar\{/.test(d.getElementById('ucdfs-runtime-css').textContent || ''),
      d.getElementById('ucdfs-runtime-css') ? 'injected' : 'missing');
    w.close();

    // The regression this replaced: the banner was styled from shared.css, and
    // the canvas tools load shared.js WITHOUT shared.css by design. It rendered
    // as bare text with a default button on /pt and /harness, which is exactly
    // where nobody thinks to look.
    const { w: cw, d: cd } = await open('/harness', { setCookies: forged, failOnPrompt: true });
    check('and it is styled on a canvas tool, which has no shared.css',
      !!cd.getElementById('ucdfs-override-bar') && !!cd.getElementById('ucdfs-runtime-css') &&
      cd.querySelectorAll('link[href*="shared.css"]').length === 0,
      `bar=${!!cd.getElementById('ucdfs-override-bar')} ` +
      `css=${!!cd.getElementById('ucdfs-runtime-css')} ` +
      `sharedcss=${cd.querySelectorAll('link[href*="shared.css"]').length}`);
    cw.close();

    const hdrForged = { Cookie: forged.map(c => c.split(';')[0]).join('; ') };
    const r = await fetch(BASE + '/api/admin/people', { headers: hdrForged });
    check('but grants nothing — the server reads the database', r.status === 403,
      'status ' + r.status);
  }

  console.log('\nelevated');
  /* Promote our own throwaway account rather than asking for a real admin's
     password. run.sh exports the service key, and this is a ucdfs-test- account
     that cleanup deletes on the way out — so the elevated half runs on every
     machine instead of only where someone exported credentials.

     Note the profile cookie still says "member": it was written at signup. That
     is exactly right, and the checks below passing anyway is the proof that
     authorization is read from the database and never from the cookie. */
  const SB  = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;

  async function setRoleDirect(mail, role) {
    const r = await fetch(`${SB}/rest/v1/profiles?email=eq.${encodeURIComponent(mail)}`, {
      method: 'PATCH',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`,
                 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ role }),
    });
    return (await json(r)).length !== 0 || r.ok;
  }

  if (!SB || !KEY) {
    console.log('  ── no service key in the environment; skipping the elevated half ──');
    process.exit(summary('admin') ? 1 : 0);
  }

  check('the test account can be promoted', await setRoleDirect(a.email, 'admin'));

  const people = await json(await fetch(BASE + '/api/admin/people', { headers: hdrA }));
  check('an admin sees everyone even with a stale member cookie',
    (people.people || []).length >= 2, `${(people.people || []).length} accounts`);

  // Admin without god mode is deliberately NOT elevated: that is what lets an
  // admin check what an ordinary member actually sees.
  check('admin alone does not pass the committee gate',
    (await post('/comp/api/admin/verify', {})).status === 403);
  check('admin alone cannot write someone else\'s attendance',
    (await post('/api/log', { first_name: 'Admin', last_name: 'Victim',
      date: today, status: 'arriving', arrival_time: '10:00' })).status === 403);

  // Deleting is the most destructive thing on the site, so it asks for the
  // override as well as the role — the same rule as every other cross-user
  // write. An admin reading the people list with the switch off cannot erase
  // anybody by mis-clicking.
  const doomedRow = (await json(await fetch(BASE + '/api/admin/people', { headers: hdrA })))
    .people.find(x => /Doomed/.test(x.name)) || {};
  check('admin alone cannot delete an account',
    (await post('/api/admin/user/delete',
      { id: doomedRow.id, confirm_email: c.email })).status === 403);
  check('admin alone cannot delete a feed line',
    (await post('/api/admin/activity/delete',
      { source: 'activity_log', id: 1 })).status === 403);

  const on = await post('/api/admin/god-mode', { on: true });
  check('god mode switches on', on.status === 200, 'status ' + on.status);
  check('switching it on rewrites the cookie so the banner appears',
    (on.headers.getSetCookie ? on.headers.getSetCookie() : [])
      .some(c => c.startsWith('ucdfs_profile=') && /god_mode%22%3A%20true/i.test(c)),
    'cookie ' + ((on.headers.getSetCookie ? on.headers.getSetCookie() : [])
      .find(c => c.startsWith('ucdfs_profile=')) || '').slice(0, 60));

  const applets = (await json(await fetch(BASE + '/api/applets', { headers: hdrA }))).applets || [];
  check('an elevated admin sees the gated applet', applets.some(x => x.id === 'admin'),
    applets.map(x => x.id).join(' '));
  check('and can open the page',
    (await fetch(BASE + '/admin', { headers: hdrA, redirect: 'manual' })).status === 200);

  // The page as rendered, not just the API. Note the profile cookie still says
  // "member" — the delete buttons appear because the *people list* says the
  // override is on, which is the database row. Reading elevation from the
  // cookie here would draw them for a forged one.
  {
    const { w: aw, d: ad } = await open('/admin', { setCookies: a.setCookies });
    const rows = [...ad.querySelectorAll('.who')];
    const rowFor = (re) => rows.find(r => re.test(r.textContent)) || null;
    const doomedRow2 = rowFor(/Doomed/), meRow = rowFor(/You/);
    check('an elevated admin gets a delete button on someone else',
      !!(doomedRow2 && doomedRow2.querySelector('.who-del')),
      `${rows.length} rows drawn`);
    check('and never one on themselves',
      !!meRow && !meRow.querySelector('.who-del'),
      meRow ? 'button drawn on own row' : 'own row not found');
    aw.close();
  }

  // God mode over everything: writing a row that is not yours.
  const godWrite = await post('/api/log', {
    first_name: 'Admin', last_name: 'Victim', date: today,
    status: 'arriving', arrival_time: '10:00',
  });
  check("god mode can write anyone's attendance", godWrite.status === 200,
    'status ' + godWrite.status);
  await post('/api/log/delete', { first_name: 'Admin', last_name: 'Victim', date: today });

  check('god mode passes the committee gate',
    (await post('/comp/api/admin/verify', {})).status === 200);

  console.log('\nediting another profile');
  const victimRow = (people.people || []).find(x => /Victim/.test(x.name)) || {};
  const edited = await post('/api/admin/profile', {
    id: victimRow.id, subteam: 'mech', year: '2nd', course: 'Edited By Admin',
    role_label: 'member', tags: ['welding'], prompts: [],
  });
  check("the override can save someone else's profile", edited.status === 200,
    'status ' + edited.status);
  const theirs = (await json(await fetch(BASE + '/api/profile/me', { headers: hdrB }))).person;
  check('and the edit lands on them', theirs.course === 'Edited By Admin',
    JSON.stringify({ c: theirs.course, y: theirs.year }));

  // The bug this guards: writing the target's row into the *editor's* cookie,
  // so an admin's own browser starts displaying them as the person they edited.
  const leaked = (edited.headers.getSetCookie ? edited.headers.getSetCookie() : [])
    .find(c => c.startsWith('ucdfs_profile='));
  check('editing someone else does not rewrite your own identity cookie',
    !leaked, leaked ? 'cookie was rewritten' : 'untouched');
  const stillMe = (await json(await fetch(BASE + '/api/me', { headers: hdrA }))).profile;
  check('and you are still yourself afterwards', /Probe/.test(stillMe.name), stillMe.name);

  console.log('\nhanding out roles');
  const victim = (people.people || []).find(x => /Victim/.test(x.name)) || {};
  check('an admin can promote someone',
    (await post('/api/admin/role', { id: victim.id, role: 'committee' })).status === 200);
  const after = await json(await fetch(BASE + '/api/admin/people', { headers: hdrA }));
  check('the promotion sticks',
    ((after.people || []).find(x => x.id === victim.id) || {}).role === 'committee',
    JSON.stringify((after.people || []).find(x => x.id === victim.id) || {}));
  check('a committee account passes the comp gate without any password',
    (await post('/comp/api/admin/verify', {}, hdrB)).status === 200);
  check('but still cannot reach the admin page',
    (await fetch(BASE + '/api/admin/people', { headers: hdrB })).status === 403);
  check('a made-up role is refused',
    (await post('/api/admin/role', { id: victim.id, role: 'superuser' })).status === 400);

  console.log('\nerasing an account');
  /* The wrong-email signup: a duplicate nothing can merge, that demoting does
     not hide. Every rail is checked against the server — the page simply not
     drawing a button is what "hiding a control is not a permission" is about. */
  const doomed = ((await json(await fetch(BASE + '/api/admin/people', { headers: hdrA })))
    .people || []).find(x => /Doomed/.test(x.name)) || {};
  const probeId = ((people.people || []).find(x => x.is_me) || {}).id;

  check('a mistyped confirmation email is refused',
    (await post('/api/admin/user/delete',
      { id: doomed.id, confirm_email: 'not.them@ucdconnect.ie' })).status === 400);
  // Deleting yourself erases the account holding the session making the
  // request, and if you were the last admin nobody could reach /admin again.
  check('and you cannot delete yourself',
    (await post('/api/admin/user/delete',
      { id: probeId, confirm_email: a.email })).status === 400);

  // An admin has to be demoted first. Deleting one outright is a keystroke away
  // from locking the team out, and the demotion path already refuses to remove
  // the last admin — this keeps deletion behind that same rail rather than
  // giving it a second, weaker one of its own.
  await post('/api/admin/role', { id: doomed.id, role: 'admin' });
  check('an admin account cannot be deleted outright',
    (await post('/api/admin/user/delete',
      { id: doomed.id, confirm_email: c.email })).status === 400);
  await post('/api/admin/role', { id: doomed.id, role: 'member' });

  const erased = await post('/api/admin/user/delete',
    { id: doomed.id, confirm_email: c.email.toUpperCase() });   // matched case-folded
  check('the override can delete an account', erased.status === 200,
    'status ' + erased.status + ' ' + JSON.stringify(await json(erased)));

  check('and it leaves the people list',
    !(((await json(await fetch(BASE + '/api/admin/people', { headers: hdrA }))).people || [])
      .some(x => x.id === doomed.id)));

  const ghost = await json(await fetch(
    `${SB}/rest/v1/profiles?id=eq.${doomed.id}&select=id`,
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }));
  check('the profile row cascaded away with the login', ghost.length === 0,
    JSON.stringify(ghost));

  // The login itself, not just the profile. Leaving the auth user behind would
  // let them sign in again, and auth_login() re-creates a missing profile from
  // the token's metadata — the account would come back from the dead.
  const authGone = await fetch(`${SB}/auth/v1/admin/users/${doomed.id}`,
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  check('and the sign-in is gone from GoTrue', authGone.status === 404,
    'status ' + authGone.status);

  // Their live session dies with them rather than lasting out the token cache,
  // which would keep serving pages to a deleted account for up to a minute.
  const zombie = await fetch(BASE + '/api/me', { headers: hdrC });
  check('their existing session stops working immediately', zombie.status === 401,
    'status ' + zombie.status);

  console.log('\ntidying the feed');
  const dash = await json(await fetch(BASE + '/api/dashboard', { headers: hdrA }));
  const line = (dash.activity || [])
    .find(i => i.source === 'activity_log' && /Doomed/.test(i.subject || ''));
  check('the deletion is recorded in the feed', !!line,
    JSON.stringify((dash.activity || []).slice(0, 3)));

  if (line) {
    check('an elevated admin can delete a feed entry',
      (await post('/api/admin/activity/delete',
        { source: line.source, id: line.id })).status === 200);
    const after2 = await json(await fetch(BASE + '/api/dashboard', { headers: hdrA }));
    check('and it is gone from the feed',
      !(after2.activity || []).some(i => i.source === line.source && i.id === line.id),
      JSON.stringify((after2.activity || []).slice(0, 3)));
  }

  // The source name reaches supabase.table(), so anything not on the list has
  // to be refused before it gets there — not merely fail to match a row.
  check('an unknown feed source is refused',
    (await post('/api/admin/activity/delete', { source: 'profiles', id: 1 })).status === 400);
  check('and a non-numeric id is refused',
    (await post('/api/admin/activity/delete',
      { source: 'activity_log', id: 'all' })).status === 400);

  console.log('\nswitching off, and back on');
  // Removing somebody's photo is the moderation case and takes the same path.
  check('the override can clear someone else\'s photo',
    (await post('/api/profile/photo/remove', { id: victimRow.id })).status === 200);

  const off = await post('/api/admin/god-mode', { on: false });
  check('god mode switches off', off.status === 200, 'status ' + off.status);
  check('an un-elevated admin loses the committee gate',
    (await post('/comp/api/admin/verify', {})).status === 403);
  // But keeps the admin page. requires_role is satisfied by the *role*, not by
  // elevation — and it has to be, because the switch to turn god mode back on
  // lives on that page. Gate it on god mode and switching off becomes a
  // one-way door.
  check('but keeps the admin page, which is the way back in',
    ((await json(await fetch(BASE + '/api/applets', { headers: hdrA }))).applets || [])
      .some(x => x.id === 'admin'));
  check('and it still opens',
    (await fetch(BASE + '/admin', { headers: hdrA, redirect: 'manual' })).status === 200);

  // The one that matters most: the way back in. If this endpoint ever starts
  // asking for god mode instead of the role, switching off is a one-way door
  // and the only repair is editing the database by hand.
  const backOn = await post('/api/admin/god-mode', { on: true });
  check('but can always switch god mode back on', backOn.status === 200,
    'status ' + backOn.status);

  console.log('\nthe safety rails');
  // Promote the victim to admin FIRST, so demoting the probe below is not
  // demoting the last admin in the database.
  //
  // This used to be implicit: the suite ran against production, which always
  // contains a real admin, so there was always a second one and the demotion
  // simply worked. Against a fresh database the probe was the only admin, the
  // last-admin rail fired, and three checks failed — the app being right and
  // the test being coupled to ambient production data. Anything a suite needs
  // it has to create.
  check('a second admin can be appointed',
    (await post('/api/admin/role', { id: victim.id, role: 'admin' })).status === 200);

  // Losing the capability has to take the elevation with it, or a demoted admin
  // keeps a god_mode flag that silently switches back on the moment somebody
  // re-promotes them.
  const meId = ((people.people || []).find(x => x.is_me) || {}).id;
  const demote = await post('/api/admin/role', { id: meId, role: 'member' });
  check('an admin can be demoted', demote.status === 200, 'status ' + demote.status);
  check('a demoted admin is locked out at once, not at next sign-in',
    (await fetch(BASE + '/api/admin/people', { headers: hdrA })).status === 403);

  const row = await json(await fetch(
    `${SB}/rest/v1/profiles?id=eq.${meId}&select=role,god_mode`,
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }));
  check('demotion clears the elevation flag too',
    (row[0] || {}).role === 'member' && (row[0] || {}).god_mode === false,
    JSON.stringify(row[0] || {}));

  // ── The last admin cannot be demoted ─────────────────────────────────────
  // Never exercised before, because it can only fire on a database whose only
  // admin is one the suite is allowed to demote — which production, by
  // definition, is not. On the non-prod database the victim is now the sole
  // admin, so the rail is reachable for the first time.
  //
  // Still checked against the real count rather than assumed: if this ever runs
  // somewhere with other admins in it, the rail correctly will not fire, and a
  // test that asserted otherwise would be lying rather than failing.
  const admins = await json(await fetch(
    `${SB}/rest/v1/profiles?role=eq.admin&select=id`,
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }));

  if (admins.length === 1 && admins[0].id === victim.id) {
    // The victim has to do this to themselves: they are the only admin left,
    // and the probe was just demoted out of being able to.
    const suicide = await post('/api/admin/role', { id: victim.id, role: 'member' }, hdrB);
    check('the last admin cannot be demoted', suicide.status === 400,
      'status ' + suicide.status);
    const still = await json(await fetch(
      `${SB}/rest/v1/profiles?id=eq.${victim.id}&select=role`,
      { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }));
    check('and is still an admin afterwards', (still[0] || {}).role === 'admin',
      JSON.stringify(still[0] || {}));
  } else {
    console.log(`  (${admins.length} admins in this database — rail not reachable here)`);
  }

  process.exit(summary('admin') ? 1 : 0);
})().catch(e => { console.error('  suite crashed:', e.message); process.exit(1); });
