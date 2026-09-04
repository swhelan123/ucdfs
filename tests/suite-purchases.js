/* Purchase requests: who may approve what, and when.
 *
 * This is the second suite where being wrong means somebody can do something
 * they shouldn't, so it is mostly negatives. The rules under test come from the
 * design in TODO.md:
 *
 *   under the threshold   the captain of the requester's division, alone, and
 *                         they may authorise their own spend
 *   at or over it         that captain first, then the Ops Captain, who is
 *                         always a second person
 *
 * The fallthrough rule is the subtle half: where a slot's natural holder is the
 * requester, or is already filling the other slot, it falls through to any
 * other captain. That is what stops the Ops Captain's own large request, or a
 * captain's own large request, from being unapprovable or self-approvable.
 *
 * Captaincies are assigned with the service key rather than through /admin, so
 * this suite does not also depend on the admin page working.
 */
const { BASE, check, summary, signUp } = require('./lib');

const SB  = process.env.SUPABASE_URL;
const KEY 
  = process.env.SUPABASE_SERVICE_KEY;
const json = async r => { try { return await r.json(); } catch (e) { return {}; } };
const hdr  = cs => ({ 'Content-Type': 'application/json',
                      Cookie: cs.map(c => c.split(';')[0]).join('; ') });
const post = (path, cs, body) => fetch(BASE + path,
  { method: 'POST', headers: hdr(cs), body: JSON.stringify(body) });
const get  = (path, cs) => fetch(BASE + path, { headers: hdr(cs) }).then(json);

(async () => {
  if (!SB || !KEY) {
    console.log('  ── no service key in the environment; skipping ──');
    process.exit(summary('purchases') ? 1 : 0);
  }

  const sbFetch = (path, method, body) => fetch(`${SB}/rest/v1/${path}`, {
    method,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`,
               'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const idOf = async mail =>
    ((await json(await sbFetch(`profiles?email=eq.${encodeURIComponent(mail)}&select=id`, 'GET')))[0] || {}).id;
  const setSubteam = (id, subteam) => sbFetch(`profiles?id=eq.${id}`, 'PATCH', { subteam });
  const setCaptain = (subteam, profile_id) =>
    sbFetch('captaincies', 'POST', { subteam, profile_id })
      .then(async r => r.ok ? r : sbFetch(`captaincies?subteam=eq.${subteam}`, 'PATCH', { profile_id }));

  // ── Cast ────────────────────────────────────────────────────────────────
  const member  = await signUp('Purchase', 'Member');   // ordinary, Electrical
  const deptCap = await signUp('Purchase', 'Deptcap');  // captain of Electrical
  const opsCap  = await signUp('Purchase', 'Opscap');   // captain of Operations
  const bystand = await signUp('Purchase', 'Bystander'); // a member, no captaincy

  const ids = {};
  for (const [k, a] of Object.entries({ member, deptCap, opsCap, bystand })) {
    ids[k] = await idOf(a.email);
  }
  check('the cast has accounts', Object.values(ids).every(Boolean), JSON.stringify(ids));
  if (!Object.values(ids).every(Boolean)) process.exit(summary('purchases') ? 1 : 0);

  await setSubteam(ids.member,  'pt');
  await setSubteam(ids.deptCap, 'pt');
  await setSubteam(ids.opsCap,  'ops');
  await setSubteam(ids.bystand, 'pt');

  /* Captaincies are one row per division, shared with whoever really holds
     them. This borrows two of them, and has to give them back: the test
     accounts are deleted on the way out and the rows cascade with them, so
     without this a run would silently leave the team with no captains. Same
     hazard as the Competition Hub's single shop-runner row. */
  const capsBefore = await json(await sbFetch('captaincies?select=subteam,profile_id', 'GET'));
  const restoreCaptains = async () => {
    await sbFetch('captaincies?subteam=in.(pt,ops)', 'DELETE');
    for (const c of (Array.isArray(capsBefore) ? capsBefore : [])) {
      if (c.subteam === 'pt' || c.subteam === 'ops') {
        await sbFetch('captaincies', 'POST', c);
      }
    }
  };
  if (Array.isArray(capsBefore) && capsBefore.length) {
    console.log(`  ── borrowing the ${capsBefore.map(c => c.subteam).join(' and ')} captaincy for this run ──`);
  }

  /* Every exit from here on has to give them back. The first version of this
     skipped straight past the restore when migration 015 was missing, and the
     test accounts then cascaded the borrowed rows away on cleanup — leaving the
     team with no captains because a migration was not applied yet. */
  const bail = async (why) => {
    console.log('  \u2500\u2500 ' + why + ' \u2500\u2500');
    await restoreCaptains();
    process.exit(summary('purchases') ? 1 : 0);
  };

  const capRes = await setCaptain('pt', ids.deptCap);
  if (!capRes.ok) await bail('captaincies table missing; migration 014 not applied, skipping');
  await setCaptain('ops', ids.opsCap);

  const probe = await get('/api/purchases', member.setCookies);
  if (probe.ready === false) await bail('purchase tables missing; migration 015 not applied, skipping');
  const THRESHOLD = Number(probe.threshold || 100);
  check('the threshold is readable', THRESHOLD > 0, String(probe.threshold));

  const file = async (cs, est, item) =>
    json(await post('/api/purchases', cs,
      { item: item || `ucdfs-test bracket ${Date.now()}`, reason: 'for the rig', est_eur: est }));
  const rowOf = async (cs, id) =>
    ((await get('/api/purchases', cs)).requests || []).find(r => r.id === id);

  // ── What a request needs ────────────────────────────────────────────────
  console.log('a request has to say what and why');
  {
    const noItem = await post('/api/purchases', member.setCookies, { reason: 'x' });
    check('an item is required', noItem.status === 400, String(noItem.status));
    const noWhy = await post('/api/purchases', member.setCookies, { item: 'ucdfs-test thing' });
    check('a reason is required', noWhy.status === 400, String(noWhy.status));
    const made = await file(member.setCookies, 10);
    check('a complete one is filed', !!made.id, JSON.stringify(made).slice(0, 70));
    check('and gets a reference people can say out loud',
      /^PR-\d{4}-\d{3,}$/.test(made.ref || ''), made.ref);
  }

  // ── Under the threshold: one captain, and only the right one ────────────
  console.log('\nunder the threshold, the division captain decides alone');
  {
    const small = await file(member.setCookies, THRESHOLD - 1);
    const asBystander = await post('/api/purchases/decide', bystand.setCookies,
                                   { id: small.id, action: 'approve' });
    check('a member who is not a captain cannot approve',
      asBystander.status === 403, String(asBystander.status));

    const asRequester = await post('/api/purchases/decide', member.setCookies,
                                   { id: small.id, action: 'approve' });
    check('nor can the person who asked', asRequester.status === 403, String(asRequester.status));

    /* The Ops Captain is a captain, but not this slot's. Below the threshold
       there is no ops slot at all, and the department slot's natural holder is
       available, so nothing falls through to them. */
    const asOps = await post('/api/purchases/decide', opsCap.setCookies,
                             { id: small.id, action: 'approve' });
    check('nor the Ops Captain, whose slot this is not',
      asOps.status === 403, String(asOps.status));

    const asDept = await post('/api/purchases/decide', deptCap.setCookies,
                              { id: small.id, action: 'approve' });
    check('the division captain can', asDept.ok, String(asDept.status));
    const after = await rowOf(member.setCookies, small.id);
    check('and one signature is the whole of it',
      after && after.status === 'approved', (after || {}).status);
  }

  // ── At or over: two, in order ───────────────────────────────────────────
  console.log('\nat or over the threshold, Operations signs second');
  {
    const big = await file(member.setCookies, THRESHOLD + 50);
    const opsFirst = await post('/api/purchases/decide', opsCap.setCookies,
                                { id: big.id, action: 'approve' });
    check('Operations cannot go first', opsFirst.status === 403, String(opsFirst.status));

    const dept = await post('/api/purchases/decide', deptCap.setCookies,
                            { id: big.id, action: 'approve' });
    check('the division captain signs first', dept.ok, String(dept.status));
    let row = await rowOf(member.setCookies, big.id);
    check('and it is not approved yet',
      row && row.status === 'dept_approved', (row || {}).status);
    check('it now says it is waiting on Operations',
      row && row.awaiting.includes('Purchase Opscap'), JSON.stringify((row || {}).awaiting));

    const twice = await post('/api/purchases/decide', deptCap.setCookies,
                             { id: big.id, action: 'approve' });
    check('the same captain cannot also fill the second slot',
      twice.status === 403, String(twice.status));

    const ops = await post('/api/purchases/decide', opsCap.setCookies,
                           { id: big.id, action: 'approve' });
    check('Operations signs second', ops.ok, String(ops.status));
    row = await rowOf(member.setCookies, big.id);
    check('and now it is approved', row && row.status === 'approved', (row || {}).status);
  }

  // ── Self-approval, and where it stops ───────────────────────────────────
  console.log('\na captain may back their own small spend, and only that');
  {
    const own = await file(deptCap.setCookies, THRESHOLD - 1);
    const self = await post('/api/purchases/decide', deptCap.setCookies,
                            { id: own.id, action: 'approve' });
    check('a captain can approve their own request under the threshold',
      self.ok, String(self.status));

    const ownBig = await file(deptCap.setCookies, THRESHOLD + 1);
    const selfBig = await post('/api/purchases/decide', deptCap.setCookies,
                               { id: ownBig.id, action: 'approve' });
    check('but not their own over it', selfBig.status === 403, String(selfBig.status));

    /* Their own slot is blocked because they are the requester, so it falls
       through to any other captain — which here is the Ops Captain, filling the
       department slot rather than their own. */
    const other = await post('/api/purchases/decide', opsCap.setCookies,
                             { id: ownBig.id, action: 'approve' });
    check('and it falls through to another captain', other.ok, String(other.status));
    const row = await rowOf(member.setCookies, ownBig.id);
    check('who fills the division slot, leaving Operations still to sign',
      row && row.status === 'dept_approved', (row || {}).status);
    check('and cannot then fill both',
      (await post('/api/purchases/decide', opsCap.setCookies,
                  { id: ownBig.id, action: 'approve' })).status === 403);
  }

  // ── The Ops Captain's own large request ─────────────────────────────────
  console.log("\nthe Ops Captain's own large request still needs someone else");
  {
    const own = await file(opsCap.setCookies, THRESHOLD + 20);
    const self = await post('/api/purchases/decide', opsCap.setCookies,
                            { id: own.id, action: 'approve' });
    check('they cannot sign it themselves', self.status === 403, String(self.status));
    /* Both slots would land on them: the department slot because ops is their
       division, and the ops slot because they hold it. Both fall through. */
    const dept = await post('/api/purchases/decide', deptCap.setCookies,
                            { id: own.id, action: 'approve' });
    check('another captain takes the first slot', dept.ok, String(dept.status));
    const second = await post('/api/purchases/decide', deptCap.setCookies,
                              { id: own.id, action: 'approve' });
    check('and cannot take the second as well', second.status === 403, String(second.status));
  }

  // ── Turning one down ────────────────────────────────────────────────────
  console.log('\nturning one down');
  {
    const r = await file(member.setCookies, 5);
    const bare = await post('/api/purchases/decide', deptCap.setCookies,
                            { id: r.id, action: 'reject' });
    check('a rejection needs a reason', bare.status === 400, String(bare.status));
    const done = await post('/api/purchases/decide', deptCap.setCookies,
                            { id: r.id, action: 'reject', note: 'we already have two' });
    check('with one it goes through', done.ok, String(done.status));
    const row = await rowOf(member.setCookies, r.id);
    check('and the reason is on the record',
      row && row.status === 'rejected' && /already have two/.test(row.decided_note),
      JSON.stringify(row || null).slice(0, 90));
  }

  // ── Withdrawing ─────────────────────────────────────────────────────────
  console.log('\nwithdrawing');
  {
    const r = await file(member.setCookies, 5);
    const theirs = await post('/api/purchases/withdraw', bystand.setCookies, { id: r.id });
    check('you cannot withdraw somebody else\'s', theirs.status === 403, String(theirs.status));
    const mine = await post('/api/purchases/withdraw', member.setCookies, { id: r.id });
    check('you can withdraw your own', mine.ok, String(mine.status));
    const again = await post('/api/purchases/decide', deptCap.setCookies,
                             { id: r.id, action: 'approve' });
    check('and a withdrawn one cannot then be approved',
      again.status === 403, String(again.status));
  }

  // ── The threshold is frozen at submission ───────────────────────────────
  console.log('\nmoving the threshold does not rewrite open requests');
  {
    const r = await file(member.setCookies, THRESHOLD + 10);   // needs two, today
    await sbFetch('settings?key=eq.finance.threshold_eur', 'PATCH',
                  { value: String(THRESHOLD + 1000) });        // now it would need one
    const dept = await post('/api/purchases/decide', deptCap.setCookies,
                            { id: r.id, action: 'approve' });
    check('the division captain still signs first', dept.ok, String(dept.status));
    const row = await rowOf(member.setCookies, r.id);
    check('and it still waits on Operations, by the rule it was filed under',
      row && row.status === 'dept_approved', (row || {}).status);
    await sbFetch('settings?key=eq.finance.threshold_eur', 'PATCH',
                  { value: String(THRESHOLD) });
  }

  // ── The audit trail ─────────────────────────────────────────────────────
  console.log('\nthe history');
  {
    const r = await file(member.setCookies, 5);
    await post('/api/purchases/decide', deptCap.setCookies, { id: r.id, action: 'approve' });
    const ev = (await get('/api/purchases/events?id=' + r.id, member.setCookies)).events || [];
    check('filing and approving are both on the record', ev.length >= 2, String(ev.length));
    check('and the approval names who made it',
      ev.some(e => /approved/.test(e.action) && e.actor_name === 'Purchase Deptcap'),
      JSON.stringify(ev.map(e => e.action + ':' + e.actor_name)));
  }

  await restoreCaptains();
  const back = await json(await sbFetch('captaincies?select=subteam,profile_id', 'GET'));
  const wanted = (Array.isArray(capsBefore) ? capsBefore : []).filter(c => c.subteam === 'pt' || c.subteam === 'ops');
  check('the captaincies it borrowed are handed back',
    wanted.every(w => (Array.isArray(back) ? back : []).some(
      b => b.subteam === w.subteam && b.profile_id === w.profile_id)),
    JSON.stringify(back));

  process.exit(summary('purchases') ? 1 : 0);
})().catch(e => { console.error('  suite crashed:', e.message); process.exit(1); });
