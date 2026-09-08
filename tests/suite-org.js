/* The org chart: who is drawn where, and from which source.
 *
 * The chart grants nothing, so this is not a permissions suite. What it guards
 * is the placement rules in _org_chart() and, more importantly, the line
 * between the two sources the boxes come from:
 *
 *   captaincies                  granted in /admin. A captain box is a fact.
 *   profile_details.role_label   self-declared. Principal, TD and vice are
 *                                drawn from it, and it is what a joker edits.
 *
 * The checks that matter most are the pair around "says Captain": somebody who
 * sets role_label = captain without a captaincy must NOT get the captain box
 * (they are a member with a flag), and the person who holds the captaincy must
 * get it even when their own card says member. Each has its positive control.
 *
 * The other line is who sees the flags. Only an admin is sent them; a member
 * seeing "so-and-so says Captain but is not one" is gossip. Checked both ways.
 *
 * Captaincies are one row per division, so this borrows the Electrical one
 * with the service key and gives it back on every exit, the same way
 * suite-purchases does. Same hazard: the test accounts are deleted on the way
 * out and the row cascades with them.
 */
const { BASE, check, summary, signUp, open, waitFor } = require('./lib');

const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const json = async r => { try { return await r.json(); } catch (e) { return {}; } };
const hdr  = cs => ({ 'Content-Type': 'application/json',
                      Cookie: cs.map(c => c.split(';')[0]).join('; ') });
const post = (path, cs, body) => fetch(BASE + path,
  { method: 'POST', headers: hdr(cs), body: JSON.stringify(body) });
const get  = (path, cs) => fetch(BASE + path, { headers: hdr(cs) }).then(json);

/* Hoisted so the crash handler at the bottom can reach it. A suite that throws
   halfway is exactly the run that would otherwise walk off with the captaincy. */
let restoreCaptains = async () => {};

(async () => {
  if (!SB || !KEY) {
    console.log('  ── no service key in the environment; skipping ──');
    process.exit(summary('org') ? 1 : 0);
  }

  const sbFetch = (path, method, body) => fetch(`${SB}/rest/v1/${path}`, {
    method,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`,
               'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const idOf = async mail =>
    ((await json(await sbFetch(`profiles?email=eq.${encodeURIComponent(mail)}&select=id`, 'GET')))[0] || {}).id;
  const setRole = (id, role) => sbFetch(`profiles?id=eq.${id}`, 'PATCH', { role });
  const setCaptain = (subteam, profile_id) =>
    sbFetch('captaincies', 'POST', { subteam, profile_id })
      .then(async r => r.ok ? r : sbFetch(`captaincies?subteam=eq.${subteam}`, 'PATCH', { profile_id }));

  // ── Cast ────────────────────────────────────────────────────────────────
  // Every placement rule has one person whose only job is to exercise it.
  const principal = await signUp('Org', 'Principal'); // says principal, division mech
  const captain   = await signUp('Org', 'Captain');   // granted pt captain, card says member
  const claimer   = await signUp('Org', 'Claimer');   // says captain of pt, holds nothing
  const vice      = await signUp('Org', 'Vice');      // says vice, pt
  const member    = await signUp('Org', 'Member');    // pt, with mech as an extra
  const alum      = await signUp('Org', 'Alum');      // pt, retired
  const fresh     = await signUp('Org', 'Fresh');     // no division at all
  const viewer    = await signUp('Org', 'Viewer');    // promoted to admin below

  const ids = {};
  for (const [k, a] of Object.entries({ principal, captain, claimer, vice, member, alum, fresh, viewer })) {
    ids[k] = await idOf(a.email);
  }
  check('the cast has accounts', Object.values(ids).every(Boolean), JSON.stringify(ids));
  if (!Object.values(ids).every(Boolean)) process.exit(summary('org') ? 1 : 0);

  // Profiles go through the real endpoint, so what the chart reads is exactly
  // what a person can put on their own card.
  await post('/api/profile', principal.setCookies, { subteam: 'mech', role_label: 'principal', year: '4th' });
  await post('/api/profile', captain.setCookies,   { subteam: 'pt',   role_label: 'member',    year: '3rd' });
  await post('/api/profile', claimer.setCookies,   { subteam: 'pt',   role_label: 'captain',   year: '2nd' });
  await post('/api/profile', vice.setCookies,      { subteam: 'pt',   role_label: 'vice',      year: '3rd' });
  await post('/api/profile', member.setCookies,    { subteam: 'pt',   subteams_extra: ['mech'], year: '1st' });
  await post('/api/profile', alum.setCookies,      { subteam: 'pt',   role_label: 'member',    year: 'Alum' });
  // fresh: never saves a profile, so no division and no details row at all.

  /* Borrow the Electrical captaincy. Every exit from here on gives it back. */
  const capsBefore = await json(await sbFetch('captaincies?select=subteam,profile_id', 'GET'));
  restoreCaptains = async () => {
    await sbFetch('captaincies?subteam=eq.pt', 'DELETE');
    for (const c of (Array.isArray(capsBefore) ? capsBefore : [])) {
      if (c.subteam === 'pt') await sbFetch('captaincies', 'POST', c);
    }
  };
  if (Array.isArray(capsBefore) && capsBefore.some(c => c.subteam === 'pt')) {
    console.log('  ── borrowing the pt captaincy for this run ──');
  }
  const bail = async (why) => {
    console.log('  ── ' + why + ' ──');
    await restoreCaptains();
    process.exit(summary('org') ? 1 : 0);
  };

  const capRes = await setCaptain('pt', ids.captain);
  if (!capRes.ok) await bail('captaincies table missing; migration 014 not applied, skipping');

  const promoted = await setRole(ids.viewer, 'admin');
  check('the viewer can be made an admin', promoted.ok, String(promoted.status));

  const names = list => (list || []).map(p => p.name);
  const has   = (list, name) => names(list).includes(name);
  const div   = (o, id) => (o.divisions || []).find(d => d.id === id) || { captain: null, vices: [], members: [] };

  // ── As a member ─────────────────────────────────────────────────────────
  console.log('\nas a member');
  const asMember = await get('/api/org', member.setCookies);
  check('the chart loads', Array.isArray(asMember.divisions) && asMember.divisions.length === 3,
        JSON.stringify(Object.keys(asMember)));
  const pt   = div(asMember, 'pt');
  const mech = div(asMember, 'mech');

  console.log('\nthe top tier');
  check('someone who says Team Principal is at the top', has(asMember.principal, 'Org Principal'));
  check('and not in their division as well',
        !has(mech.members, 'Org Principal') && !has(mech.vices, 'Org Principal'),
        JSON.stringify(names(mech.members)));

  console.log('\nthe shape');
  // Who hangs off whom is the server's answer, so it is asserted here rather
  // than left to the page to know. The TD carries the two engineering
  // divisions; Operations sits beside the TD, under the principal.
  check('Electrical answers to the Technical Director', pt.reports_to === 'td', pt.reports_to);
  check('so does Mechanical', mech.reports_to === 'td', mech.reports_to);
  check('Operations answers to the Team Principal',
        div(asMember, 'ops').reports_to === 'principal', div(asMember, 'ops').reports_to);
  check('every division is placed somewhere',
        (asMember.divisions || []).every(x => ['td', 'principal'].includes(x.reports_to)),
        JSON.stringify((asMember.divisions || []).map(x => [x.id, x.reports_to])));

  console.log('\nthe captain box');
  check('the granted captain gets the box, though their card says member',
        pt.captain && pt.captain.name === 'Org Captain', JSON.stringify(pt.captain));
  check('and is not also listed as a member', !has(pt.members, 'Org Captain'));
  check('saying Captain on your card does not get you the box',
        !(pt.captain && pt.captain.name === 'Org Claimer'));
  check('it makes you a member', has(pt.members, 'Org Claimer'), JSON.stringify(names(pt.members)));

  console.log('\nunder the captain');
  check('a vice captain is drawn as one', has(pt.vices, 'Org Vice'));
  check('and not as a member as well', !has(pt.members, 'Org Vice'));
  check('a member is a member', has(pt.members, 'Org Member'));
  check('under their primary division only', !has(mech.members, 'Org Member'),
        JSON.stringify(names(mech.members)));

  console.log('\nwho is not there');
  const everywhere = [
    ...(asMember.principal || []), ...(asMember.td || []), ...(asMember.unassigned || []),
    ...(asMember.divisions || []).flatMap(d => [d.captain, ...d.vices, ...d.members].filter(Boolean)),
  ];
  check('a retired member is off the chart', !has(everywhere, 'Org Alum'));
  check('someone with no division is in the holding row', has(asMember.unassigned, 'Org Fresh'));
  check('and nowhere else',
        everywhere.filter(p => p.name === 'Org Fresh').length === 1);
  check('the headcount excludes the retired',
        asMember.people === everywhere.filter((p, i, a) => a.findIndex(q => q.id === p.id) === i).length,
        `people=${asMember.people} drawn=${everywhere.length}`);
  check('email is not on the chart', everywhere.every(p => !('email' in p)));

  console.log('\nflags');
  check('a member is not sent any flags',
        asMember.admin === false && Object.keys(asMember.flags || {}).length === 0,
        JSON.stringify(asMember.flags));

  // ── As an admin ─────────────────────────────────────────────────────────
  console.log('\nas an admin');
  const asAdmin = await get('/api/org', viewer.setCookies);
  const flags = asAdmin.flags || {};
  check('an admin is sent the flags', asAdmin.admin === true && Object.keys(flags).length > 0,
        JSON.stringify(flags));
  check('the claimer is flagged', (flags[ids.claimer] || []).some(t => /says captain/i.test(t)),
        JSON.stringify(flags[ids.claimer]));
  check('the real captain is flagged for a card that says member',
        (flags[ids.captain] || []).some(t => /profile says/i.test(t)),
        JSON.stringify(flags[ids.captain]));
  check('a plain member is not flagged', !flags[ids.member]);
  check('the chart itself is the same for both',
        JSON.stringify(div(asAdmin, 'pt').members.map(p => p.id)) ===
        JSON.stringify(pt.members.map(p => p.id)));

  // ── The page ────────────────────────────────────────────────────────────
  console.log('\nthe page');
  {
    const { w, d, errors } = await open('/org', { setCookies: member.setCookies, failOnPrompt: true });
    await waitFor(() => !d.getElementById('chart').hidden, 8000);
    check('it renders without throwing', errors.length === 0, errors.join(' | '));
    check('the ring is gone once the chart is up', d.getElementById('loading').hidden);
    const capBox = d.querySelector(`.division[data-subteam="pt"] .box[data-id="${ids.captain}"]`);
    check('the captain has a box', !!capBox);
    check('it links to their profile card',
          capBox && capBox.getAttribute('href') === '/profiles#' + ids.captain,
          capBox && capBox.getAttribute('href'));
    check('the claimer is a chip, not a box',
          !!d.querySelector(`.chip-person[data-id="${ids.claimer}"]`) &&
          !d.querySelector(`.box[data-id="${ids.claimer}"]`));
    check('you are marked as you', !!d.querySelector(`.is-me[data-id="${ids.member}"]`));
    check('the engineering divisions are drawn under the TD',
          !!d.querySelector('.branch[data-branch="td"] .division[data-subteam="pt"]') &&
          !!d.querySelector('.branch[data-branch="td"] .division[data-subteam="mech"]'));
    check('with the TD seat above them', !!d.querySelector('.branch[data-branch="td"] .seat .box'));
    check('Operations is drawn beside the TD, not under',
          !!d.querySelector('.division[data-subteam="ops"]') &&
          !d.querySelector('.branch[data-branch="td"] .division[data-subteam="ops"]'));
    check('a member sees no flags', d.querySelectorAll('.flag').length === 0);
    check('nor the tidy-up list', !d.getElementById('tidy'));
    check('no tour, so no ? in the header', !d.getElementById('ucdfs-help'));
    w.close();
  }
  {
    const { w, d } = await open('/org', { setCookies: viewer.setCookies, failOnPrompt: true });
    await waitFor(() => !d.getElementById('chart').hidden, 8000);
    check('an admin sees the flags', d.querySelectorAll('.flag').length >= 2,
          String(d.querySelectorAll('.flag').length));
    check('and the tidy-up list', !!d.getElementById('tidy'));
    w.close();
  }
  {
    // The deep link the boxes use. Lands on the person, not the grid.
    const { w, d } = await open('/profiles#' + ids.captain, { setCookies: member.setCookies, failOnPrompt: true });
    const opened = await waitFor(() => {
      const v = d.getElementById('viewer');
      return v && v.style.display !== 'none' && /Org Captain/.test(v.textContent);
    }, 8000);
    check('/profiles#<id> opens that card', opened);
    w.close();
  }

  await restoreCaptains();
  process.exit(summary('org') ? 1 : 0);
})().catch(async e => {
  console.log('  FAIL suite crashed: ' + (e && e.stack || e));
  await restoreCaptains();
  process.exit(1);
});
