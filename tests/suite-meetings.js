/* Team meetings: who is coming on a scheduled day, and what the people who are
 * not did that week (migrations/012).
 *
 * Driven by fetch rather than jsdom. Everything worth pinning here is about
 * which rows the server will accept and whose name ends up on them, and none of
 * that needs a DOM.
 *
 * REQUIRES migration 012. Without it every write 503s with a message saying so,
 * which is the first check below, so a run against a database that has not had
 * the SQL applied says that rather than failing eleven ways.
 *
 * No cleanup function. meeting_responses and week_notes key on profiles(id)
 * with `on delete cascade`, and profiles cascades from auth.users, so deleting
 * the test accounts takes their rows with them. comp_requests needed a sweep in
 * lib.sh precisely because it keys by typed-in name instead.
 */
const { BASE, check, summary, signUp } = require('./lib');

const hdr  = cs => ({ 'Content-Type': 'application/json',
                      Cookie: cs.map(c => c.split(';')[0]).join('; ') });
const post = (path, cs, body) => fetch(BASE + path,
  { method: 'POST', headers: hdr(cs), body: JSON.stringify(body) });
const get  = (path, cs) => fetch(BASE + path, { headers: hdr(cs) }).then(r => r.json());

const iso   = d => d.toISOString().split('T')[0];
const MON   = 1, TUE = 2, THU = 4;   // JS getDay(): Sunday = 0

(async () => {
  const me    = await signUp('Meeting', 'Check');
  const other = await signUp('Meeting', 'Other');

  console.log('the window');
  const first = await get('/api/meetings', me.setCookies);
  const days  = first.days || [];
  check('/api/meetings returns days', days.length > 0, JSON.stringify(first).slice(0, 90));
  if (!days.length) { console.log('  ── no days; is migration 012 applied? ──'); process.exit(summary('meetings') ? 1 : 0); }

  check('every day is a Tuesday or a Thursday',
    days.every(d => [TUE, THU].includes(new Date(d.date + 'T12:00:00').getDay())),
    days.map(d => d.date).join(' '));
  check('three weeks of them, so last week is still answerable',
    days.length === 6, String(days.length));
  check('every week_start is a Monday',
    days.every(d => new Date(d.week_start + 'T12:00:00').getDay() === MON),
    days.map(d => d.week_start).join(' '));
  check('exactly one day is flagged today, or none',
    days.filter(d => d.is_today).length <= 1);

  const target  = days.find(d => !d.past) || days[days.length - 1];
  const another = days.find(d => d.date !== target.date && d.week_start === target.week_start);

  console.log('\nanswering');
  const yes = await post('/api/meetings/respond', me.setCookies,
                         { date: target.date, attending: true });
  check('a yes is accepted', yes.ok,
    yes.ok ? '' : `${yes.status} ${(await yes.json().catch(() => ({}))).detail || ''}`);
  if (!yes.ok) { console.log('  ── writes are failing; is migration 012 applied? ──'); process.exit(summary('meetings') ? 1 : 0); }

  let state = await get('/api/meetings', me.setCookies);
  let mine  = (state.responses || []).find(r => r.meeting_date === target.date &&
                                                r.name === 'Meeting Check');
  check('it comes back against your name', !!mine && mine.attending === true,
    JSON.stringify(mine || null).slice(0, 80));
  check('and carries a photo field for the list to draw',
    !!mine && 'photo' in mine);

  const no = await post('/api/meetings/respond', me.setCookies,
    { date: target.date, attending: false, reason: 'lab clashes with it' });
  check('changing your mind is an update, not a second row', no.ok, String(no.status));
  state = await get('/api/meetings', me.setCookies);
  const rows = (state.responses || []).filter(r => r.meeting_date === target.date &&
                                                   r.name === 'Meeting Check');
  check('still one row for you on that day', rows.length === 1, String(rows.length));
  check('and it now says no, with the reason',
    rows[0] && rows[0].attending === false && rows[0].reason === 'lab clashes with it',
    JSON.stringify(rows[0] || null).slice(0, 90));

  console.log('\nwhat the server refuses');
  const monday = new Date(target.date + 'T12:00:00');
  monday.setDate(monday.getDate() - (monday.getDay() - MON));
  const notAMeetingDay = await post('/api/meetings/respond', me.setCookies,
                                    { date: iso(monday), attending: true });
  check('a day that is not a meeting day is refused',
    notAMeetingDay.status === 400, String(notAMeetingDay.status));

  const far = new Date(target.date + 'T12:00:00');
  far.setDate(far.getDate() + 42);
  const outOfWindow = await post('/api/meetings/respond', me.setCookies,
                                 { date: iso(far), attending: true });
  check('a meeting day outside the window is refused',
    outOfWindow.status === 400, String(outOfWindow.status));

  const notBool = await post('/api/meetings/respond', me.setCookies,
                             { date: target.date, attending: 'yes' });
  check('attending has to be a real boolean', notBool.status === 400, String(notBool.status));

  /* The ownership check. Everything else here would pass just as well on an
     endpoint that let anyone write anyone's row. */
  const mineId = (rows[0] || {}).profile_id;
  const forgery = await post('/api/meetings/respond', other.setCookies,
    { date: target.date, attending: true, profile_id: mineId });
  check('you cannot answer for somebody else',
    forgery.status === 403, String(forgery.status));
  state = await get('/api/meetings', other.setCookies);
  const untouched = (state.responses || []).find(r => r.profile_id === mineId &&
                                                      r.meeting_date === target.date);
  check('and the row they aimed at is untouched',
    untouched && untouched.attending === false,
    JSON.stringify(untouched || null).slice(0, 70));

  console.log('\none answer per week');
  const wed = new Date(target.week_start + 'T12:00:00');
  wed.setDate(wed.getDate() + 2);            // a Wednesday in the same week
  const w1 = await post('/api/meetings/week-note', me.setCookies,
    { week_start: iso(wed), summary: 'ucdfs-test finished the loom drawings' });
  check('a week note posted mid-week is accepted', w1.ok, String(w1.status));

  state = await get('/api/meetings', me.setCookies);
  let notes = (state.notes || []).filter(n => n.profile_id === mineId);
  check('it is filed under that week\'s Monday, not the day it was written',
    notes.length === 1 && notes[0].week_start === target.week_start,
    notes.map(n => n.week_start).join(' ') || 'none');

  /* The reason week_notes is its own table: miss both sessions and there is
     still one answer for the week, so the two cannot end up disagreeing. */
  await post('/api/meetings/respond', me.setCookies,
             { date: another ? another.date : target.date, attending: false, reason: 'away' });
  await post('/api/meetings/week-note', me.setCookies,
             { week_start: target.week_start, summary: 'ucdfs-test and ordered the contacts' });
  state = await get('/api/meetings', me.setCookies);
  notes = (state.notes || []).filter(n => n.profile_id === mineId &&
                                          n.week_start === target.week_start);
  check('missing both sessions still leaves one note for the week',
    notes.length === 1, String(notes.length));
  check('and it holds the latest answer',
    notes[0] && notes[0].summary === 'ucdfs-test and ordered the contacts',
    JSON.stringify(notes[0] || null).slice(0, 80));

  const longSummary = await post('/api/meetings/week-note', me.setCookies,
    { week_start: target.week_start, summary: 'x'.repeat(2000) });
  check('an overlong summary is trimmed rather than rejected', longSummary.ok,
    String(longSummary.status));
  state = await get('/api/meetings', me.setCookies);
  const trimmed = (state.notes || []).find(n => n.profile_id === mineId &&
                                                n.week_start === target.week_start);
  check('trimmed to the cap', trimmed && trimmed.summary.length === 1000,
    trimmed ? String(trimmed.summary.length) : 'missing');

  const otherWeek = await post('/api/meetings/week-note', me.setCookies,
    { week_start: '2020-01-06', summary: 'long ago' });
  check('a week outside the window is refused',
    otherWeek.status === 400, String(otherWeek.status));

  process.exit(summary('meetings') ? 1 : 0);
})().catch(e => { console.error('  suite crashed:', e.message); process.exit(1); });
