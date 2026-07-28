/* Competition Hub.
 *
 * Guards the class rename done when comp.html moved onto shared.css: its
 * abbreviated names (.hi, .ht, .npill, .sc, .nr, .ti, .slabel, .srow, .ctabs,
 * .ctab) were replaced with the shared ones across 187 class attributes. A
 * missed rename shows up as an unstyled page, which nothing else would catch.
 */
const { check, summary, open, signUp } = require('./lib');

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
  // needs it — the last one in the static markup was the admin password box,
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
  process.exit(summary('comp') ? 1 : 0);
})().catch(e => { console.error('  suite crashed:', e.message); process.exit(1); });
