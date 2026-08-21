/* Admin-managed hyperlink cards (migrations/010).
 *
 * This suite exists for one check above all the others: **a link's url is
 * rendered into an href, and the scheme is the only thing standing between a
 * committee member's typo and a stored script that runs on every dashboard in
 * the team.** Everything a card renders is escaped, and escaping does nothing
 * whatsoever about `javascript:`. If the scheme whitelist is ever loosened, or
 * moved somewhere a code path can skip, this is where it should go red.
 *
 * The rest is the boundary that comes with turning code into data. Registry
 * entries were reviewed in a pull request; rows are typed into a form. So:
 *
 *   - a member cannot add, edit, reorder or delete one, and the page never
 *     drawing the controls is not the reason;
 *   - an id in the body addresses an existing link, so naming an applet id is a
 *     404 and never a new row: a caller who could pick the primary key could
 *     put an unauthenticated url in front of a gated page;
 *   - unknown accents, groups and statuses fall back rather than 400, since
 *     those come from selects the server itself populated and losing a colour
 *     beats losing the edit;
 *   - a link can be starred, which is the regression the merge introduces: the
 *     favourites endpoint used to check ids against APPLETS_BY_ID alone, and a
 *     link id would have been a 400 for a card the dashboard had just drawn.
 *
 * It also covers the dashboard blocks those cards sit in (migrations/011),
 * which are rows with one rail links do not have: a block cannot be deleted
 * while anything is in it, counting applets as well as links. Applets are code,
 * so an admin who emptied a block a registry entry names could not put it back
 * from the UI.
 *
 * Every link and block it creates is named with the test prefix so the cleanup
 * helpers in lib.sh can find them even when this file crashes halfway. A
 * leftover row is not inert: it is a card, or a heading, on every dashboard in
 * the non-prod project.
 */
const { BASE, check, summary, signUp } = require('./lib');

const json = async (r) => { try { return await r.json(); } catch (e) { return {}; } };
const PREFIX = 'ucdfs-test-';

(async () => {
  const member = await signUp('Links', 'Member');
  const admin  = await signUp('Links', 'Boss');
  const hdrM = { Cookie: member.setCookies.map(c => c.split(';')[0]).join('; ') };
  const hdrA = { Cookie: admin.setCookies.map(c => c.split(';')[0]).join('; ') };

  const post = (path, body, hdr = hdrA) => fetch(BASE + path, {
    method: 'POST', headers: { ...hdr, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const get = (path, hdr = hdrA) => fetch(BASE + path, { headers: hdr });

  // Ids this run minted, so the finally block can take them back out even if a
  // check throws. cleanup_links is the backstop, not the plan.
  const mine = [];
  const blocksMade = [];

  try {
    console.log('a member is refused, and not by hiding the buttons');
    for (const [label, path, body] of [
      ['listing links',   '/api/admin/links',         null],
      ['adding one',      '/api/admin/links',         { name: 'x', url: 'https://e.com' }],
      ['deleting one',    '/api/admin/links/delete',  { id: 'vcu', name: 'VCU Firmware' }],
      ['reordering them', '/api/admin/links/reorder', { group: 'tools', ids: [] }],
    ]) {
      const r = body === null ? await get(path, hdrM) : await post(path, body, hdrM);
      check(`member: ${label}`, r.status === 403, String(r.status));
    }

    const anon = await fetch(BASE + '/api/admin/links', { redirect: 'manual' });
    check('signed out: listing links', anon.status === 401, String(anon.status));

    console.log('\npromoting the test account');
    const SB  = process.env.SUPABASE_URL;
    const KEY = process.env.SUPABASE_SERVICE_KEY;
    if (!SB || !KEY) {
      console.log('  ── no service key in the environment; skipping the elevated half ──');
      process.exit(summary('links') ? 1 : 0);
    }
    const promote = await fetch(
      `${SB}/rest/v1/profiles?email=eq.${encodeURIComponent(admin.email)}`, {
        method: 'PATCH',
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}`,
                   'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ role: 'admin' }),
      });
    check('the test account can be promoted', promote.ok, String(promote.status));

    const listed = await json(await get('/api/admin/links'));
    check('an admin can list links', Array.isArray(listed.links),
      typeof listed.links);
    check('the editor is sent its vocabularies',
      Array.isArray(listed.groups) && Array.isArray(listed.subteams) &&
      Array.isArray(listed.accents) && Array.isArray(listed.statuses),
      JSON.stringify(Object.keys(listed)));
    if (listed.ready === false) {
      console.log('  ── migration 010 is not applied; skipping the rest ──');
      process.exit(summary('links') ? 1 : 0);
    }

    console.log('\nthe url scheme is a whitelist, not a filter');
    /* The first two are the ones that matter. An href is not a string the
       browser reads, it is a protocol it dispatches on, and no amount of HTML
       escaping changes which protocol was named. */
    for (const bad of [
      'javascript:fetch("/api/admin/user/delete")',
      'JavaScript:alert(1)',            // scheme matching must be case-folded
      ' javascript:alert(1)',           // and must survive a leading space
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
      '//evil.example.com',             // scheme-relative: no scheme at all
      'evil.example.com',               // no scheme at all
      '',
    ]) {
      const r = await post('/api/admin/links', { name: PREFIX + 'scheme', url: bad });
      check(`refused: ${JSON.stringify(bad).slice(0, 42)}`, r.status === 400, String(r.status));
    }

    console.log('\nadding one');
    const made = await post('/api/admin/links', {
      name:     PREFIX + 'Reference',
      icon:     '📗',
      url:      'https://example.com/handbook',
      blurb:    'Something worth reading',
      accent:   'teal',
      status:   'live',
      group:    'tools',
      subteams: ['pt'],
    });
    const madeJ = await json(made);
    const id = madeJ.link && madeJ.link.id;
    if (id) mine.push(id);
    check('a link can be added', made.status === 200, String(made.status));
    check('its id is minted server-side', /^link_[0-9a-f]{8}$/.test(id || ''), String(id));

    /* A caller cannot choose the primary key. An id in the body addresses an
       existing link, so naming an applet id is a 404 rather than a row that
       shadows a real page: "admin" as a link would sit in front of a gated
       page with an unauthenticated url, and favourites key off these ids too. */
    for (const stolen of ['admin', 'attendance', 'pt']) {
      const r = await post('/api/admin/links',
        { id: stolen, name: PREFIX + 'Shadow', url: 'https://example.com/x' });
      check(`an applet id cannot be claimed: ${stolen}`, r.status === 404, String(r.status));
    }
    const shadow = await json(await get('/api/admin/links'));
    check('and none of them made a row',
      !(shadow.links || []).some(l => ['admin', 'attendance', 'pt'].includes(l.id)),
      (shadow.links || []).map(l => l.id).join(','));

    console.log('\nwhat gets refused, and what degrades');
    const noName = await post('/api/admin/links',
      { name: '   ', url: 'https://example.com' });
    check('a link with no name', noName.status === 400, String(noName.status));

    const longName = await post('/api/admin/links',
      { name: PREFIX + 'x'.repeat(80), url: 'https://example.com' });
    check('a name past the cap', longName.status === 400, String(longName.status));

    /* These three come from selects this server populated, so a bad value is a
       stale tab rather than a typo. Falling back keeps the edit; 400ing loses
       it and tells somebody to fix a field they never touched. */
    const sloppy = await json(await post('/api/admin/links', {
      name: PREFIX + 'Fallbacks', url: 'https://example.com/2',
      accent: 'chartreuse', status: 'banana', group: 'nowhere',
      subteams: ['pt', 'pt', 'not-a-subteam'],
    }));
    if (sloppy.link) mine.push(sloppy.link.id);
    check('an unknown accent falls back', sloppy.link && sloppy.link.accent === 'indigo',
      sloppy.link && sloppy.link.accent);
    check('an unknown status falls back', sloppy.link && sloppy.link.status === 'live',
      sloppy.link && sloppy.link.status);
    check('an unknown block falls back', sloppy.link && sloppy.link.group_id === 'tools',
      sloppy.link && sloppy.link.group_id);
    check('unknown subteams are dropped and duplicates collapsed',
      JSON.stringify(sloppy.link && sloppy.link.subteams) === '["pt"]',
      JSON.stringify(sloppy.link && sloppy.link.subteams));

    const empty = await json(await post('/api/admin/links', {
      name: PREFIX + 'Everyone', url: 'https://example.com/3', subteams: [],
    }));
    if (empty.link) mine.push(empty.link.id);
    check('no subteams means everyone, not nobody',
      JSON.stringify(empty.link && empty.link.subteams) === '["all"]',
      JSON.stringify(empty.link && empty.link.subteams));

    console.log('\nit reaches the dashboard as a card');
    const feed = await json(await get('/api/applets', hdrM));
    const card = (feed.applets || []).find(a => a.id === id);
    check('a member sees the new link', !!card, id);
    check('it is marked external', !!(card && card.external), JSON.stringify(card && card.external));
    check('its url arrives as route',
      !!(card && card.route === 'https://example.com/handbook'), card && card.route);
    check('it carries its block', !!(card && card.group === 'tools'), card && card.group);
    check('no file path leaks with it', !!(card && card.file === undefined),
      JSON.stringify(card && card.file));

    console.log('\na link can be starred like any other card');
    /* The regression this suite was written for. Favourites used to be checked
       against the applet registry alone, so every link on the dashboard would
       have been a 400 on the way in and filtered straight back out on the way
       out: a star that visibly did nothing. */
    const star = await post('/api/profile/favourites', { id, on: true }, hdrM);
    const starJ = await json(star);
    check('starring a link is accepted', star.status === 200, String(star.status));
    check('and it comes back', (starJ.favourites || []).includes(id),
      JSON.stringify(starJ.favourites));

    console.log('\nediting');
    const edited = await json(await post('/api/admin/links', {
      id, name: PREFIX + 'Renamed', url: 'https://example.com/handbook',
      accent: 'amber', status: 'quiet', group: 'archive', subteams: ['all'],
    }));
    check('an edit keeps the id', edited.link && edited.link.id === id, edited.link && edited.link.id);
    check('and moves the card', edited.link && edited.link.group_id === 'archive',
      edited.link && edited.link.group_id);

    const ghost = await post('/api/admin/links',
      { id: 'link_deadbeef', name: PREFIX + 'Ghost', url: 'https://example.com' });
    check('editing a link that does not exist', ghost.status === 404, String(ghost.status));

    console.log('\nreordering');
    const before = (await json(await get('/api/admin/links'))).links || [];
    const tools  = before.filter(l => l.group_id === 'tools').map(l => l.id);

    const partial = await post('/api/admin/links/reorder',
      { group: 'tools', ids: tools.slice(1) });
    check('a partial list is refused', partial.status === 400, String(partial.status));

    const badGroup = await post('/api/admin/links/reorder',
      { group: 'not-a-block', ids: [] });
    check('an unknown block is refused', badGroup.status === 400, String(badGroup.status));

    if (tools.length >= 2) {
      const flipped = [tools[1], tools[0], ...tools.slice(2)];
      const ro = await post('/api/admin/links/reorder', { group: 'tools', ids: flipped });
      check('a full list is accepted', ro.status === 200, String(ro.status));
      const after = ((await json(await get('/api/admin/links'))).links || [])
        .filter(l => l.group_id === 'tools').map(l => l.id);
      check('and the order sticks', JSON.stringify(after) === JSON.stringify(flipped),
        JSON.stringify(after));
      // Put it back, so a suite run is not a silent reshuffle of the real
      // dashboard's seeded cards.
      await post('/api/admin/links/reorder', { group: 'tools', ids: tools });
    } else {
      console.log('  ── fewer than two links in tools; skipping the order check ──');
    }

    console.log('\ndeleting');
    const wrongName = await post('/api/admin/links/delete', { id, name: 'not the name' });
    check('the name has to match', wrongName.status === 400, String(wrongName.status));

    const stillThere = ((await json(await get('/api/admin/links'))).links || [])
      .some(l => l.id === id);
    check('and a refused delete leaves it alone', stillThere, String(stillThere));

    const gone = await post('/api/admin/links/delete', { id, name: PREFIX + 'Renamed' });
    check('the right name deletes it', gone.status === 200, String(gone.status));
    if (gone.ok) mine.splice(mine.indexOf(id), 1);

    const twice = await post('/api/admin/links/delete', { id, name: PREFIX + 'Renamed' });
    check('deleting it again is a 404', twice.status === 404, String(twice.status));

    console.log('\nand the star closes behind it');
    /* Nothing sweeps profile_details when a link is deleted. _favourites_for
       filters on the way out, so the id stops being a favourite by itself. If
       that filter is ever narrowed back to the registry this goes red, and so
       does the starring check above. */
    const after = await json(await get('/api/applets', hdrM));
    check('the deleted link is not a favourite any more',
      !(after.favourites || []).includes(id), JSON.stringify(after.favourites));
    check('and it is not a card any more',
      !(after.applets || []).some(a => a.id === id), id);
    console.log('\ndashboard blocks');
    /* Blocks are rows too (migrations/011), and the rails differ from links in
       one way that matters: a block cannot be deleted while anything is in it,
       counting applets as well as links. Applets are code, so an admin who
       emptied a block that a registry entry names could not put it back. */
    const blocksR = await json(await get('/api/admin/groups'));
    check('an admin can list blocks', Array.isArray(blocksR.groups),
      typeof blocksR.groups);
    check('each block says how many cards are in it',
      (blocksR.groups || []).every(g => typeof g.cards === 'number'),
      JSON.stringify((blocksR.groups || []).map(g => [g.id, g.cards])));

    for (const [label, path, body] of [
      ['listing blocks',   '/api/admin/groups',          null],
      ['adding one',       '/api/admin/groups',          { label: 'x' }],
      ['deleting one',     '/api/admin/groups/delete',   { id: 'apps', label: 'Apps' }],
      ['reordering them',  '/api/admin/groups/reorder',  { ids: [] }],
    ]) {
      const r = body === null ? await get(path, hdrM) : await post(path, body, hdrM);
      check(`member: ${label}`, r.status === 403, String(r.status));
    }

    if (blocksR.ready === false) {
      console.log('  ── migration 011 is not applied; skipping the rest of the blocks ──');
    } else {
      const blocks = blocksR.groups || [];

      const noLabel = await post('/api/admin/groups', { label: '   ' });
      check('a block with no heading', noLabel.status === 400, String(noLabel.status));

      const addedR = await json(await post('/api/admin/groups',
        { label: PREFIX + 'Block' }));
      const gid = addedR.group && addedR.group.id;
      if (gid) blocksMade.push(gid);
      check('a block can be added', !!gid, String(gid));
      check('its id is minted server-side', /^grp_[0-9a-f]{8}$/.test(gid || ''), String(gid));

      const renamed = await json(await post('/api/admin/groups',
        { id: gid, label: PREFIX + 'Renamed' }));
      check('a block can be renamed',
        renamed.group && renamed.group.label === PREFIX + 'Renamed',
        renamed.group && renamed.group.label);

      /* The rail this whole section exists for. Every seeded block holds cards,
         so pick one that does and check it survives. */
      const held = (await json(await get('/api/admin/groups'))).groups
        .find(g => g.cards > 0);
      if (held) {
        const refused = await post('/api/admin/groups/delete',
          { id: held.id, label: held.label });
        check('a block holding cards cannot be deleted',
          refused.status === 400, String(refused.status));
        const survived = (await json(await get('/api/admin/groups'))).groups
          .some(g => g.id === held.id);
        check('and it is still there', survived, String(survived));
      } else {
        console.log('  ── no block holds cards; skipping the emptiness rail ──');
      }

      const wrongLabel = await post('/api/admin/groups/delete',
        { id: gid, label: 'not the heading' });
      check('the heading has to match', wrongLabel.status === 400, String(wrongLabel.status));

      const order = (await json(await get('/api/admin/groups'))).groups.map(g => g.id);
      const short = await post('/api/admin/groups/reorder', { ids: order.slice(1) });
      check('a partial block order is refused', short.status === 400, String(short.status));

      const goneG = await post('/api/admin/groups/delete',
        { id: gid, label: PREFIX + 'Renamed' });
      check('an empty block can be deleted', goneG.status === 200, String(goneG.status));
      if (goneG.ok) blocksMade.splice(blocksMade.indexOf(gid), 1);
    }

  } finally {
    for (const id of blocksMade) {
      const g = ((await json(await get('/api/admin/groups'))).groups || [])
        .find(x => x.id === id);
      if (g) await post('/api/admin/groups/delete', { id, label: g.label });
    }
    for (const id of mine) {
      const row = ((await json(await get('/api/admin/links'))).links || [])
        .find(l => l.id === id);
      if (row) {
        await post('/api/admin/links/delete', { id, name: row.name });
      }
    }
  }

  process.exit(summary('links') ? 1 : 0);
})();
