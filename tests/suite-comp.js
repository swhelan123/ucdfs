/* Competition Hub.
 *
 * Guards the class rename done when comp.html moved onto shared.css: its
 * abbreviated names (.hi, .ht, .npill, .sc, .nr, .ti, .slabel, .srow, .ctabs,
 * .ctab) were replaced with the shared ones across 187 class attributes. A
 * missed rename shows up as an unstyled page, which nothing else would catch.
 */
const { BASE, check, summary, open, signUp } = require('./lib');

const OLD_CLASSES = '.hi, .ht, .npill, .sc, .nr, .ti, .slabel, .srow, .ctabs, .ctab';

(async () => {
  const { setCookies } = await signUp('Comp', 'Check');
  const { w, d, errors } = await open('/comp', { setCookies, failOnPrompt: true });

  console.log('shared design system adopted');
  check('tabs use the shared .tab class',
    d.querySelectorAll('.tabs .tab').length === 4,
    `${d.querySelectorAll('.tabs .tab').length} found`);
  check('header uses .header-inner', !!d.querySelector('header .header-inner'));
  check('name pill renamed',         !!d.querySelector('.name-pill .pill-avatar'));
  // Source-level, not DOM-level. Every remaining input on this page is built
  // inside a JS template literal and only rendered for the tab and role that
  // needs it. The last one in the static markup was the admin password box,
  // which went when the shared password did. The check is about the class
  // rename holding, so it should look where the classes are written.
  check('inputs use .text-input',
    (d.documentElement.outerHTML.match(/class="text-input/g) || []).length >= 1,
    (d.documentElement.outerHTML.match(/class="text-input/g) || []).length + ' uses');
  check('no abbreviated classes left', !d.querySelector(OLD_CLASSES),
    d.querySelector(OLD_CLASSES) ? d.querySelector(OLD_CLASSES).className : '');
  check('back-link present', d.querySelector('.back-link[href="/"]') !== null);

  console.log('\ntabs render');
  for (const tab of ['shopping', 'expenses', 'schedule', 'roster']) {
    const before = errors.length;
    w.eval(`cTab('${tab}')`);
    await new Promise(r => setTimeout(r, 900));
    const panel = d.getElementById('tab-' + tab);
    const btn   = d.getElementById('ctab-' + tab);
    check(`"${tab}" shows, marks active, has content`,
      panel.style.display !== 'none' && btn.classList.contains('active') &&
      panel.textContent.trim().length > 0 && errors.length === before,
      errors.slice(before).join('; '));
  }

  check('no page errors overall', errors.length === 0, errors.join('; '));
  w.close();

  /* ── Who may write what ────────────────────────────────────────────────
     None of the shopping-list endpoints had a working ownership check. Two
     took a name straight from the request body and believed it; the third,
     /requests/update, had no check at all, and price + status + bought_by are
     the entire input to /comp/api/expenses. So any signed-in member could mark
     anything bought, at any price, in anyone's name, and mint a debt owed to
     themselves.

     Everything here is a negative, driven by fetch rather than the page,
     because the page was never the problem: it drew the right buttons for the
     right people the whole time. Hiding a control is not a permission. */
  const hdr = cs => ({ 'Content-Type': 'application/json',
                       Cookie: cs.map(c => c.split(';')[0]).join('; ') });
  const post = (path, cs, body) => fetch(BASE + path,
    { method: 'POST', headers: hdr(cs), body: JSON.stringify(body) });
  const requests = async cs =>
    (await (await fetch(BASE + '/comp/api/requests', { headers: hdr(cs) })).json()).requests || [];

  console.log('\nthe shopping list only takes your own name');
  {
    const mallory = await signUp('Mallory', 'Test');
    const victim  = await signUp('Victim',  'Test');
    /* Stamped per run. These rows are looked up by item name, and a previous
       run that crashed before tidying leaves one with the same name and the
       WRONG requester on it — which then matches here and fails a check about
       code that is working. Learned by doing exactly that. The ucdfs-test-
       prefix is what run.sh sweeps on, so it has to stay at the front. */
    const tag = `ucdfs-test-${Date.now()}`;
    const IMPERSONATED = `${tag}-impersonated`;
    const BOLTS        = `${tag}-victims-bolts`;

    // 1. Filing as somebody else.
    await post('/comp/api/requests', mallory.setCookies,
               { name: 'Victim Test', item: IMPERSONATED });
    let rows = await requests(mallory.setCookies);
    const forged = rows.find(r => r.item === IMPERSONATED);
    check('a request is filed under the account that filed it',
      !!forged && forged.requester === 'Mallory Test',
      forged ? `requester=${forged.requester}` : 'the request was not created at all');

    // 2. Editing and deleting somebody else's.
    const mine = await post('/comp/api/requests', victim.setCookies,
                            { item: BOLTS });
    check('a request can still be filed normally', mine.ok, String(mine.status));
    rows = await requests(victim.setCookies);
    const target = rows.find(r => r.item === BOLTS);
    /* Everything below dereferences this. Without the guard a regression that
       stops the request being created at all takes the process down on the next
       line, and every check after it — including the ones about money — never
       runs. Same lesson as the mid-flight close in suite-pages. */
    if (!target) {
      check('the rest of this block could run', false,
        'the request was never created, so nothing below was tested');
      process.exit(summary('comp') ? 1 : 0);
    }

    const edited = await post('/comp/api/requests/edit', mallory.setCookies,
                              { id: target.id, name: 'Victim Test', item: 'ucdfs-test-edited' });
    check('somebody else cannot edit your request', edited.status === 403, String(edited.status));

    const deleted = await post('/comp/api/requests/delete', mallory.setCookies,
                               { id: target.id, name: 'Victim Test' });
    check('somebody else cannot delete your request', deleted.status === 403, String(deleted.status));

    // 3. Pricing it. This is the one that turns into money.
    const priced = await post('/comp/api/requests/update', mallory.setCookies,
                              { id: target.id, price: 999, status: 'bought',
                                bought_by: 'Mallory Test' });
    check('a non-runner cannot mark anything bought', priced.status === 403, String(priced.status));

    const stillPending = (await requests(victim.setCookies))
      .find(r => r.id === target.id);
    check('and the row is untouched',
      stillPending && stillPending.status === 'pending' && stillPending.price === null,
      stillPending ? `status=${stillPending.status} price=${stillPending.price}` : 'row vanished');

    /* The runner is one shared row in comp_meta, not per-account, so this
       borrows it. Nonprod is shared by dev, stage and tests; prod is a separate
       project and is never touched. Restored below, and if somebody was
       genuinely mid-shop the run says so rather than silently taking it. */
    const runnerBefore = (await (await fetch(BASE + '/comp/api/runner',
      { headers: hdr(victim.setCookies) })).json()).runner || '';
    if (runnerBefore) {
      console.log(`  ── borrowing the shop-runner slot from "${runnerBefore}"; ` +
                  'it cannot be handed back automatically ──');
    }

    // 4. The runner slot is the gate, so it needs one too.
    const grabbed = await post('/comp/api/runner', mallory.setCookies, { name: 'Victim Test' });
    check('you cannot put somebody else up as shop runner',
      grabbed.status === 403, String(grabbed.status));

    // 5. The positive control. Without it every check above passes just as
    //    well on an endpoint that refuses everyone, including the shop runner
    //    it exists for.
    const declared = await post('/comp/api/runner', victim.setCookies, { name: 'Victim Test' });
    check('you can put yourself up as shop runner', declared.ok, String(declared.status));

    const bought = await post('/comp/api/requests/update', victim.setCookies,
                              { id: target.id, price: 12.5, status: 'bought',
                                bought_by: 'Mallory Test' });
    check('the runner can price a request', bought.ok, String(bought.status));
    const done = (await requests(victim.setCookies)).find(r => r.id === target.id);
    check('and the buyer recorded is the runner, not whoever the body named',
      done && done.bought_by === 'Victim Test',
      done ? `bought_by=${done.bought_by}` : 'row vanished');

    /* The undo button is drawn for the buyer, and standing down is the normal
       end of a shop run, so the two have to work together: buy, tap Done, then
       still be able to correct what you bought. */
    await post('/comp/api/runner', victim.setCookies, { name: '' });
    const undone = await post('/comp/api/requests/update', victim.setCookies,
                              { id: target.id, price: 13.0 });
    check('the buyer can still correct a price after standing down',
      undone.ok, String(undone.status));
    const outsider = await post('/comp/api/requests/update', mallory.setCookies,
                                { id: target.id, price: 999 });
    check('but a bystander still cannot', outsider.status === 403, String(outsider.status));
    await post('/comp/api/runner', victim.setCookies, { name: 'Victim Test' });

    const stoodDown = await post('/comp/api/runner', mallory.setCookies, { name: '' });
    check('somebody else cannot stand the runner down',
      stoodDown.status === 403, String(stoodDown.status));

    /* Cleanup, in an order the new rules actually permit: a bought request
       cannot be deleted, and standing down loses the right to un-buy it. So
       un-buy first, stand down second, delete last. Getting this backwards is
       how a test leaves rows behind in a shared table. */
    await post('/comp/api/requests/update', victim.setCookies,
               { id: target.id, status: 'pending', bought_by: null, price: null });
    await post('/comp/api/runner', victim.setCookies, { name: '' });
    for (const [cs, item] of [[victim.setCookies, BOLTS],
                              [mallory.setCookies, IMPERSONATED]]) {
      const row = (await requests(cs)).find(r => r.item === item);
      if (row) await post('/comp/api/requests/delete', cs, { id: row.id });
    }
    // Only this run's rows: older litter is run.sh's job to sweep, and
    // failing here over somebody else's mess helps nobody.
    const left = (await requests(victim.setCookies))
      .filter(r => r.item.startsWith(tag)).map(r => r.item);
    check('the run leaves no rows behind', left.length === 0, left.join(', '));
  }

  process.exit(summary('comp') ? 1 : 0);
})().catch(e => { console.error('  suite crashed:', e.message); process.exit(1); });
