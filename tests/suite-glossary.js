/* The glossary as rows (migrations/016): who may change it, what the server
 * does to what they send, and that the page draws a definition as text.
 *
 * Driven by fetch for the rules and by jsdom for the one check that needs a
 * page: a definition is typed by a person and rendered into innerHTML, so it
 * has to come out escaped.
 *
 * Terms made here are named with the test prefix so cleanup_glossary in lib.sh
 * finds them even after a crash, when the id the server minted was never seen.
 *
 * REQUIRES migration 016. Without it the first check says so and the suite
 * stops, rather than failing a dozen ways.
 */
const { BASE, check, summary, signUp, open } = require('./lib');

const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const PREFIX = 'ucdfs-test-';

const hdr  = cs => ({ 'Content-Type': 'application/json',
                      Cookie: cs.map(c => c.split(';')[0]).join('; ') });
const get  = (cs) => fetch(BASE + '/api/glossary', { headers: hdr(cs) }).then(r => r.json());
const post = (path, cs, body) => fetch(BASE + path,
  { method: 'POST', headers: hdr(cs), body: JSON.stringify(body) });
const detail = async r => `${r.status} ${((await r.json().catch(() => ({}))).detail) || ''}`;

(async () => {
  const member = await signUp('Glossary', 'Member');
  const editor = await signUp('Glossary', 'Editor');

  console.log('reading');
  const first = await get(member.setCookies);
  check('the glossary comes back', first.ready === true, JSON.stringify(first).slice(0, 90));
  if (!first.ready) { console.log('  ── not ready; is migration 016 applied? ──'); process.exit(summary('glossary') ? 1 : 0); }
  check('with its categories', (first.groups || []).length >= 1, JSON.stringify(first.groups));
  check('and the terms it was seeded with', (first.terms || []).length > 0,
    String((first.terms || []).length));
  check('every term sits in a category that exists',
    first.terms.every(t => first.groups.some(g => g.id === t.category)));
  check('a member is not offered editing', first.can_edit === false);

  console.log('\nwhat a member is refused');
  const name = PREFIX + 'TSAL-' + Date.now();
  check('a member cannot add a term',
    (await post('/api/glossary', member.setCookies,
      { term: name, definition: 'x', category: 'elec' })).status === 403);
  const anyId = first.terms[0].id;
  check('or change one',
    (await post('/api/glossary', member.setCookies,
      { id: anyId, term: first.terms[0].term, definition: 'vandalised' })).status === 403);
  check('or delete one',
    (await post('/api/glossary/delete', member.setCookies,
      { id: anyId, term: first.terms[0].term })).status === 403);
  /* Captaincy is granted, never claimed: the label on your own card is a job
     title, and editing here is a permission. */
  await post('/api/profile', member.setCookies,
    { role_label: 'captain', subteam: 'mech', year: '', course: '', tags: [], is_public: false });
  check('calling yourself captain on your profile does not change that',
    (await get(member.setCookies)).can_edit === false);

  if (!SB || !KEY) {
    console.log('  ── no service key in the environment; skipping the editor half ──');
    process.exit(summary('glossary') ? 1 : 0);
  }
  // Committee, not admin: the narrower of the roles that may edit.
  await fetch(`${SB}/rest/v1/profiles?email=eq.${encodeURIComponent(editor.email)}`, {
    method: 'PATCH',
    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'committee' }),
  });
  check('a committee member is offered editing', (await get(editor.setCookies)).can_edit === true);

  console.log('\nadding');
  /* An id in the body means "edit this one", so a caller cannot name a new
     row into existence by choosing its primary key: the id has to exist. */
  const chosen = await post('/api/glossary', editor.setCookies,
    { id: 'term_chosen_by_caller', term: name, definition: 'x', category: 'elec' });
  check('a caller cannot choose a new term\'s id', chosen.status === 404, await detail(chosen));
  const made = await post('/api/glossary', editor.setCookies, {
    term: '  ' + name + '  ', expansion: ' Tractive   System Active Light ',
    definition: 'The light on the hoop.\r\n\r\n\r\n\r\nCheck it first.  ', category: 'not-a-category',
  });
  check('a committee member can add a term', made.ok, made.ok ? '' : await detail(made));
  const madeId = made.ok ? (await made.json()).id : '';
  check('the id is minted by the server', /^term_[0-9a-f]{12}$/.test(madeId), madeId);

  let all = await get(editor.setCookies);
  let row = (all.terms || []).find(t => t.id === madeId) || {};
  check('whitespace in the name is collapsed', row.term === name, JSON.stringify(row.term));
  check('and in what it stands for', row.expansion === 'Tractive System Active Light',
    JSON.stringify(row.expansion));
  check('paragraph breaks survive, runs of them do not',
    row.definition === 'The light on the hoop.\n\nCheck it first.', JSON.stringify(row.definition));
  check('an unknown category falls back instead of refusing', row.category === all.groups[0].id,
    row.category);
  check('and it records who wrote it', row.updated_by === 'Glossary Editor', row.updated_by);

  console.log('\nwhat the server refuses');
  const dup = await post('/api/glossary', editor.setCookies,
    { term: name.toUpperCase(), definition: 'again', category: 'elec' });
  check('the same term twice, in any capitalisation', dup.status === 409, await detail(dup));
  check('a term with no name',
    (await post('/api/glossary', editor.setCookies, { term: '   ', definition: 'x' })).status === 400);
  check('a term with no meaning',
    (await post('/api/glossary', editor.setCookies, { term: name + '-b', definition: ' \n ' })).status === 400);
  check('an edit to an id that does not exist',
    (await post('/api/glossary', editor.setCookies,
      { id: 'term_nothere', term: name + '-c', definition: 'x' })).status === 404);

  console.log('\nediting');
  const payload = '<img src=x onerror="window.__pwned=1"> & <b>bold</b>';
  const edited = await post('/api/glossary', editor.setCookies,
    { id: madeId, term: name, definition: payload, category: 'elec' });
  check('an editor can change a definition', edited.ok, edited.ok ? '' : await detail(edited));
  all = await get(editor.setCookies);
  row = (all.terms || []).find(t => t.id === madeId) || {};
  check('the change is what comes back', row.definition === payload && row.category === 'elec',
    JSON.stringify(row).slice(0, 120));
  check('renaming onto a term that exists is refused too',
    (await post('/api/glossary', editor.setCookies,
      { id: madeId, term: first.terms[0].term, definition: 'x' })).status === 409);

  /* The page puts definitions into innerHTML, so this is the check that it
     escapes them. The markup has to arrive as text, and nothing in it may run. */
  {
    const { w, d } = await open('/glossary', { setCookies: editor.setCookies });
    const drawn = await new Promise(res => {
      const t0 = Date.now();
      (function poll() {
        const el = d.getElementById('t-' + madeId);
        if (el || Date.now() - t0 > 8000) return res(el);
        setTimeout(poll, 50);
      })();
    });
    const text = drawn && drawn.querySelector('.term-text');
    check('the page draws the term', !!drawn);
    check('a definition is drawn as text, markup and all',
      text && text.textContent === payload && !text.querySelector('img, b'),
      text ? text.innerHTML.slice(0, 80) : 'missing');
    check('and nothing in it ran', !w.__pwned);
    check('an editor gets an Edit button on it', !!(drawn && drawn.querySelector('.term-edit')));
    w.close();
  }

  console.log('\ndeleting');
  const stale = await post('/api/glossary/delete', editor.setCookies, { id: madeId, term: 'something else' });
  check('deleting needs the term echoed back, so a stale page cannot delete the wrong one',
    stale.status === 400, await detail(stale));
  const gone = await post('/api/glossary/delete', editor.setCookies, { id: madeId, term: name });
  check('with it, the term goes', gone.ok, gone.ok ? '' : await detail(gone));
  all = await get(editor.setCookies);
  check('and is no longer listed', !(all.terms || []).some(t => t.id === madeId));

  process.exit(summary('glossary') ? 1 : 0);
})().catch(e => { console.error('  suite crashed:', e.message); process.exit(1); });
