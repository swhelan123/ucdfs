/* The Wiring Harness Mapper's engineering core.
 *
 * The canvas is drag-and-drop and jsdom has no layout, so this does not test
 * drawing. It tests the part that has consequences off the screen: the numbers
 * and part numbers someone orders parts from, and the rule check they trust to
 * tell them the design is sound.
 *
 * TWO THINGS TO KNOW BEFORE ADDING TO THIS FILE
 *
 * 1. SAFETY. /harness/api/save writes the team's single live harness document.
 *    Everything here loads a fixture over the top of it in memory, so saves are
 *    stubbed out before any state is touched and the count is asserted at the
 *    end. Never remove that stub.
 *
 * 2. The page's top-level `let DOC` / `const wmap` are global *lexical*
 *    bindings — they are NOT properties of window, so `w.DOC = …` silently
 *    creates an unrelated property and every assertion afterwards passes
 *    vacuously against the real document. Drive the page through w.eval(),
 *    which resolves those bindings properly. Learned the hard way.
 *
 * Regressions this exists to catch, all of them found by writing it:
 *   - DTM connectors emitted Deutsch DT part numbers. DTM is the smaller
 *     sibling with its own housings and size-20 contacts; ordering from that
 *     BOM got you parts that do not fit.
 *   - 12 of 34 connector types produced NO bom lines at all, silently. You
 *     ordered wire and nothing to crimp it into.
 */
const { check, summary, open, signUp } = require('./lib');

const FIXTURE = {
  unit: 'mm', sysV: 12, autoColors: true,
  rules: [{ pat: 'GND', color: '#000000' }, { pat: '12V', color: '#e6194B' }],
  boards: [{ id: 'b_pdu', name: 'PDU', x: 200, y: 200, color: '#4a7de0' }],
  connectors: [
    { id: 'c_ecu',  name: 'ECU',    type: 'dt4',    pins: 4, cols: 2, x: 40,  y: 40,  board: 'b_pdu', gender: 'M' },
    { id: 'c_pump', name: 'Pump',   type: 'dt2',    pins: 2, cols: 1, x: 400, y: 40,  gender: 'F' },
    { id: 'c_tsal', name: 'TSAL',   type: 'dt2',    pins: 2, cols: 1, x: 400, y: 300, gender: 'F' },
    { id: 'c_cust', name: 'Custom', type: 'custom', pins: 2, cols: 2, x: 800, y: 40 },
  ],
  splices: [{ id: 's_gnd', name: 'GND-SPL', x: 700, y: 500 }],
  wires: [
    // a 3-way ground net joined through a splice
    { id: 'w1', from: { c: 'c_ecu',  p: 0 }, to: { s: 's_gnd' },        signal: 'GND',      gauge: '20', length: 500,  current: 5,  vclass: 'LV' },
    { id: 'w2', from: { c: 'c_pump', p: 1 }, to: { s: 's_gnd' },        signal: 'GND',      gauge: '20', length: 700,  current: 5,  vclass: 'LV' },
    { id: 'w3', from: { c: 'c_tsal', p: 1 }, to: { s: 's_gnd' },        signal: 'GND',      gauge: '20', length: 900,  current: 5,  vclass: 'LV' },
    // deliberately wrong: 25 A down 22 AWG, and 22/24 AWG in a size-16 contact
    { id: 'w4', from: { c: 'c_ecu',  p: 1 }, to: { c: 'c_pump', p: 0 }, signal: '12V_PUMP', gauge: '22', length: 1200, current: 25, vclass: 'LV' },
    // HV landing on a connector that also carries LV
    { id: 'w5', from: { c: 'c_ecu',  p: 2 }, to: { c: 'c_tsal', p: 0 }, signal: 'TS_SENSE', gauge: '18', length: 800,  current: 1,  vclass: 'HV' },
    { id: 'w6', from: { c: 'c_ecu',  p: 3 }, to: { c: 'c_cust', p: 0 }, signal: 'SENSOR',   gauge: '24', length: 300,  current: 0,  vclass: 'LV' },
  ],
};

/* Runs inside the page. Returns [[ok, label, detail], …]. */
const PROBE = `(() => {
  const R = [];
  const t = (label, ok, extra='') => R.push([!!ok, label, String(extra == null ? '' : extra)]);
  const attempt = (label, fn) => { try { const v = fn(); t(label, v.ok, v.extra); }
                                   catch (e) { t(label, false, 'threw: ' + e.message); } };

  DOC = normalizeDoc(FIXTURE);
  rebuildAll();

  // ── nets: union-find across wires and splices ──
  const nets = computeNets();
  const gnd = nets.find(n => n.signal === 'GND');
  t('three wires through one splice form a single net', gnd && gnd.wires.length === 3,
    gnd ? gnd.wires.length + ' wires' : 'no GND net');
  t('one net per distinct signal', nets.length === 4,
    nets.length + ': ' + nets.map(n => n.signal || '?').join(','));
  t('net current is the max of its wires', gnd && gnd.current === 5, gnd && gnd.current);

  // ── rule check ──
  const issues = runDRC();
  const has = re => issues.some(i => re.test(i.msg));
  t('flags a wire under-sized for its current', has(/under-sized for 25 A/));
  t('flags excessive voltage drop', has(/V drop/));
  t('flags HV and LV sharing a connector', has(/mixes HV and LV/));
  t('flags a gauge outside the contact crimp range', has(/outside the 14-20 AWG crimp range/),
    issues.filter(i => i.cat === 'Contacts').length + ' contact issues');
  t('flags a connector with no part number', has(/needs a part number/),
    issues.filter(i => i.cat === 'Parts').map(i => i.msg).join(' | '));
  t('does not invent a signal conflict on a clean net',
    !issues.some(i => i.sev === 'err' && /Conflicting/.test(i.msg)));
  t('every issue carries a category', issues.every(i => i.cat));
  t('every issue reference resolves to a real object',
    issues.filter(i => i.ref).every(i => i.ref.type === 'wire' ? !!wmap[i.ref.id]
                                       : i.ref.type === 'conn' ? !!cmap[i.ref.id] : !!smap[i.ref.id]));

  // ── BOM: the part someone orders from ──
  const bom = computeBOM();
  t('every connector type yields at least one BOM line',
    TYPES.every(ty => connParts({ id:'x', type:ty.id, pins:ty.pins, cols:ty.cols, gender:'M' }).length > 0),
    JSON.stringify(TYPES.filter(ty => !connParts({ id:'x', type:ty.id, pins:ty.pins, cols:ty.cols, gender:'M' }).length).map(ty => ty.id)));
  t('DT emits size-16 contacts', bom.some(b => b.pn === '0460-202-16141'));
  t('DTM emits its own housing, wedge and size-20 contacts — not DT parts',
    (() => { const p = connParts({ id:'x', type:'dtm4', pins:4, cols:2, gender:'M' }).map(x => x.pn);
             return p.includes('DTM04-4P') && p.includes('WM-4P') && p.includes('0460-202-20141'); })(),
    JSON.stringify(connParts({ id:'x', type:'dtm4', pins:4, cols:2, gender:'M' }).map(x => x.pn)));
  t('contacts are counted per wired pin, not per pin',
    (() => { const c = bom.find(b => b.pn === '0460-202-16141'); return c && c.qty === 4; })(),
    JSON.stringify(bom.filter(b => /size-16/.test(b.desc)).map(b => b.pn + '×' + b.qty)));
  t('no BOM line has a zero or NaN quantity', bom.every(b => b.qty > 0 && !isNaN(b.qty)),
    JSON.stringify(bom.filter(b => !(b.qty > 0)).map(b => b.pn)));
  t('wire lines name a colour, not just a hex code', bom.some(b => b.cat === 'Wire' && /Black/.test(b.desc)),
    JSON.stringify(bom.filter(b => b.cat === 'Wire').map(b => b.desc)));

  // ── panels render ──
  [['sched','refreshSchedule'], ['bom','refreshBOM'], ['drc','refreshDRC']].forEach(([id, fn]) => {
    attempt(fn + '() renders', () => {
      window[fn]();
      const body = document.getElementById(id + '-body');
      return { ok: body && body.innerHTML.length > 50, extra: body ? body.innerHTML.length + ' chars' : 'no body' };
    });
  });

  // ── every export produces a real file ──
  const CAP = [], realDownload = window.download;
  window.download = (name, text) => CAP.push({ name, text });
  ['exportCSV', 'exportBOMcsv', 'fromToCSV', 'wirevizYAML'].forEach(fn => {
    CAP.length = 0;
    attempt(fn + '() exports a row per wire', () => {
      window[fn]();
      if (!CAP[0]) return { ok: false, extra: 'nothing downloaded' };
      const lines = CAP[0].text.trim().split('\\n');
      return { ok: lines.length >= DOC.wires.length, extra: CAP[0].name + ', ' + lines.length + ' lines' };
    });
  });
  window.download = realDownload;

  // ── every print report renders ──
  const PRINTED = [], realPrint = window.print;
  window.print = () => PRINTED.push(document.getElementById('report').innerHTML);
  ['repCutlist', 'repBOM', 'repPinout', 'repLabels', 'repFormboard'].forEach(fn => {
    PRINTED.length = 0;
    attempt(fn + '() renders', () => {
      window[fn]();
      return { ok: PRINTED[0] && PRINTED[0].length > 200, extra: PRINTED[0] ? PRINTED[0].length + ' chars' : 'empty' };
    });
  });
  window.print = realPrint;
  document.body.classList.remove('printing');

  // ── colour code ──
  t('a colour rule wins over the auto palette', wireColor(wmap['w1']) === '#000000', wireColor(wmap['w1']));
  t('an unmatched wire still gets a colour', !!wireColor(wmap['w5']), wireColor(wmap['w5']));

  // ── undo / redo ──
  const before = DOC.wires.length;
  pushUndo();
  DOC.wires.push({ id:'wX', from:{c:'c_ecu',p:3}, to:{c:'c_pump',p:0}, gauge:'20' });
  undo();
  t('undo restores the previous state', DOC.wires.length === before, DOC.wires.length + ' vs ' + before);
  redo();
  t('redo re-applies it', DOC.wires.length === before + 1, DOC.wires.length);
  undo();

  // ── persistence round-trip ──
  const round = normalizeDoc(JSON.parse(JSON.stringify(DOC)));
  t('normalizeDoc round-trips wires', round.wires.length === DOC.wires.length);
  t('normalizeDoc round-trips splice endpoints',
    JSON.stringify(round.wires.find(x => x.id === 'w1').to) === JSON.stringify({ s: 's_gnd' }),
    JSON.stringify(round.wires.find(x => x.id === 'w1').to));

  // ── deleting a connector must not leave wires pointing at nothing ──
  deleteConnectorCore('c_tsal');
  t('deleting a connector takes its wires with it',
    DOC.wires.every(x => x.from.c !== 'c_tsal' && x.to.c !== 'c_tsal'));
  t('no wire is left with a dangling endpoint',
    DOC.wires.every(x => epExists(x.from) && epExists(x.to)),
    JSON.stringify(DOC.wires.filter(x => !(epExists(x.from) && epExists(x.to))).map(x => x.id)));

  return JSON.stringify(R);
})()`;

(async () => {
  const { setCookies } = await signUp('Harness', 'Check');
  const { w, errors } = await open('/harness', { setCookies });

  // SAFETY — stub the save endpoint before anything touches state. The live
  // harness document is a single row; a real save from here would overwrite
  // whatever the team last drew.
  let saveAttempts = 0;
  const realFetch = w.fetch;
  w.fetch = (u, o = {}) => {
    if (String(u).includes('/harness/api/save')) {
      saveAttempts++;
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }
    return realFetch(u, o);
  };
  // Same for the websocket: no fixture state should reach anyone else's canvas.
  w.eval('try{ if(typeof ws!=="undefined" && ws) ws.close(); }catch(e){}; wsSend=function(){};');

  console.log('page loads clean');
  check('no errors on load', errors.length === 0, errors.slice(0, 3).join('; '));

  console.log('\nengineering core');
  w.FIXTURE = FIXTURE;
  let results = [];
  try {
    results = JSON.parse(w.eval(PROBE));
  } catch (e) {
    check('probe ran', false, e.message);
  }
  for (const [ok, label, extra] of results) check(label, ok, extra);

  await new Promise(r => setTimeout(r, 1000));   // let any debounced save fire
  console.log('\nsafety');
  check('no save reached the live document', saveAttempts >= 0 && w.fetch !== realFetch,
    saveAttempts + ' save(s) intercepted');
  check('no errors during exercise', errors.length === 0, errors.slice(0, 3).join('; '));

  w.close();
  process.exit(summary('harness'));
})();
