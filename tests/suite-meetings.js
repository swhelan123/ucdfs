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

  // The one-off session rides along as an extra day (see the end of this
  // suite); everything about the regular window is about the others.
  const regular = days.filter(d => !d.special);
  check('every regular day is a Tuesday or a Thursday',
    regular.every(d => [TUE, THU].includes(new Date(d.date + 'T12:00:00').getDay())),
    regular.map(d => d.date).join(' '));
  check('three weeks of them, so last week is still answerable',
    regular.length === 6, String(regular.length));
  check('at most one extra day, and only the flagged kind',
    days.length - regular.length <= 1, days.map(d => d.date).join(' '));
  check('every week_start is a Monday',
    days.every(d => new Date(d.week_start + 'T12:00:00').getDay() === MON),
    days.map(d => d.week_start).join(' '));
  check('exactly one day is flagged today, or none',
    days.filter(d => d.is_today).length <= 1);

  const target  = regular.find(d => !d.past) || regular[regular.length - 1];
  const another = regular.find(d => d.date !== target.date && d.week_start === target.week_start);

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

  /* A no without a reason. The page disables its own button, which is why this
     is checked here: the rule only means something if the endpoint holds it
     when the form is bypassed. */
  const noReason = await post('/api/meetings/respond', me.setCookies,
                              { date: target.date, attending: false });
  check('a no needs a reason', noReason.status === 400, String(noReason.status));
  const blankReason = await post('/api/meetings/respond', me.setCookies,
                                 { date: target.date, attending: false, reason: '   ' });
  check('and whitespace does not count as one',
    blankReason.status === 400, String(blankReason.status));
  const yesNoReason = await post('/api/meetings/respond', me.setCookies,
                                 { date: target.date, attending: true });
  check('a yes still needs nothing', yesNoReason.ok, String(yesNoReason.status));
  /* Put it back. That yes overwrote the row, and the checks below assert this
     one is still the no with its reason — writing to a shared row and leaving
     it changed is how a passing check becomes somebody else's failing one. */
  await post('/api/meetings/respond', me.setCookies,
             { date: target.date, attending: false, reason: 'lab clashes with it' });

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

  /* ── The personal log ──────────────────────────────────────────────────
     Its own endpoint rather than a filter over /api/meetings, because that one
     only returns the three weeks you can still answer for. The check that
     matters is the last one: reusing the answering window would cap a term at
     a fortnight and nothing else here would notice. */
  console.log('\nyour own log');
  const log = await get('/api/meetings/history', me.setCookies);
  check('the log comes back', Array.isArray(log.weeks), JSON.stringify(log).slice(0, 80));
  check('it counts the sessions it has', log.totals && typeof log.totals.in === 'number',
    JSON.stringify(log.totals || null).slice(0, 90));

  const logged = (log.weeks || []).find(w => w.week_start === target.week_start);
  check('the week you answered for is in it', !!logged,
    (log.weeks || []).map(w => w.week_start).join(' ') || 'none');
  check('with both of that week\'s sessions, answered or not',
    logged && logged.sessions.length === 2, String(logged ? logged.sessions.length : 0));
  const sess = logged && logged.sessions.find(x => x.date === target.date);
  check('and your answer on the right one',
    sess && sess.answered === true && sess.attending === false,
    JSON.stringify(sess || null).slice(0, 90));
  check('the week note rides along', logged && logged.note &&
    logged.note.summary.length === 1000, JSON.stringify((logged || {}).note || null).slice(0, 60));

  /* created_at is what migration 013 adds, and the reason it exists: edit a
     typo and updated_at moves, so without it a log cannot say when somebody
     actually answered. Skipped rather than failed on a database that has 012
     but not 013, so this suite still passes mid-rollout. */
  if (sess && sess.created_at) {
    check('an answer carries when it was first given', !!sess.created_at);
    /* This row has been rewritten four times by the checks above, so `edited`
       being true is the flag working, not a fault. Asserting "fresh" on it was
       my mistake: it is the most-edited row in the suite. Both states are worth
       pinning, so a day nothing has touched yet supplies the other one. */
    check('a row that has been rewritten is marked edited',
      sess.edited === true, String(sess.edited));

    const untouched = regular.find(d => d.date !== target.date &&
                                        d.date !== (another || {}).date);
    if (untouched) {
      await post('/api/meetings/respond', me.setCookies,
                 { date: untouched.date, attending: true });
      const fresh = (await get('/api/meetings/history', me.setCookies)).weeks
        .flatMap(w => w.sessions).find(x => x.date === untouched.date);
      check('and one written once is not',
        fresh && fresh.edited === false && !!fresh.created_at,
        JSON.stringify(fresh || null).slice(0, 90));
      check('a first answer has both stamps equal',
        fresh && fresh.created_at === fresh.updated_at,
        fresh ? `${fresh.created_at} vs ${fresh.updated_at}` : 'missing');
    }
  } else {
    console.log('  ── no created_at; migration 013 not applied, timestamp checks skipped ──');
  }

  const nosey = await fetch(BASE + '/api/meetings/history?profile_id=' + mineId,
                            { headers: hdr(other.setCookies) });
  check('you cannot read somebody else\'s log', nosey.status === 403, String(nosey.status));

  const own = await get('/api/meetings/history', other.setCookies);
  check('and an account with nothing logged gets an empty one, not an error',
    Array.isArray(own.weeks) && own.weeks.length === 0, JSON.stringify(own).slice(0, 70));

  /* The one-off session (ONBOARDING_SESSION in main.py). Test accounts are
     always brand new, so they are always invited while one is coming up. Once
     its date has passed the suite checks the prompt has switched itself off
     instead. Answers go through the ordinary /api/meetings/respond. */
  console.log('\nthe onboarding session');
  const ask = await get('/api/onboarding-session/me', other.setCookies);
  if (!ask.session) {
    check('with no session coming up, nobody is asked', ask.ask === false, JSON.stringify(ask));
  } else {
    const say = (cs, body) => post('/api/meetings/respond', cs, { date: ask.session.date, ...body });
    check('a new account is asked', ask.ask === true, JSON.stringify(ask));
    check('about a day that is not a regular meeting day',
      ![TUE, THU].includes(new Date(ask.session.date + 'T12:00:00').getDay()), ask.session.date);

    const bare = await say(other.setCookies, { attending: false });
    check('a no without a reason is refused', bare.status === 400, String(bare.status));
    check('and refusing it still leaves them asked',
      (await get('/api/onboarding-session/me', other.setCookies)).ask === true);

    const ok = await say(other.setCookies, { attending: false, reason: 'Lab until six' });
    check('a no with a reason is accepted', ok.ok, String(ok.status));
    check('and once answered they are not asked again',
      (await get('/api/onboarding-session/me', other.setCookies)).ask === false);

    // In the picker whenever it falls inside the answering window.
    const listed = await get('/api/meetings', me.setCookies);
    const day = (listed.days || []).find(d => d.special);
    if (day) {
      check('the picker carries it as a day of its own', day.date === ask.session.date, day.date);
      check('saying what it is and who it is for',
        !!day.special.name && !!day.special.audience, JSON.stringify(day.special).slice(0, 90));
      check('a new account is invited', day.special.invited === true);
      check('and on the invite list, so "yet to answer" can name them',
        (day.special.people || []).some(p => p.profile_id === mineId));
      const them = (listed.responses || []).find(r => r.meeting_date === day.date &&
                                                      r.name === 'Meeting Other');
      check('the answer is on the list the team sees',
        them && them.attending === false && them.reason === 'Lab until six',
        JSON.stringify(them || null).slice(0, 90));
    } else {
      console.log('  (the session is outside the picker window; picker checks skipped)');
    }

    const spoof = await say(other.setCookies, { attending: true, profile_id: mineId });
    check('you cannot answer it for somebody else either', spoof.status === 403, String(spoof.status));

    /* The negative the rest leans on: without it, every check above passes just
       as well on a session that invites everybody. */
    const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
    if (SB && KEY) {
      const vet = await signUp('Meeting', 'Veteran');
      const vetId = (await get('/api/profile/me', vet.setCookies)).person.id;
      await fetch(`${SB}/rest/v1/profiles?id=eq.${vetId}`, { method: 'PATCH',
        headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ created_at: '2026-01-15T10:00:00Z' }) });
      check('someone who joined before the intake is not asked',
        (await get('/api/onboarding-session/me', vet.setCookies)).ask === false);
      const vsay = await say(vet.setCookies, { attending: true });
      check('and cannot answer for it', vsay.status === 403, String(vsay.status));
      if (day) {
        const vday = ((await get('/api/meetings', vet.setCookies)).days || []).find(d => d.special);
        check('though they can see it, marked as not theirs to answer',
          vday && vday.special.invited === false, JSON.stringify(vday && vday.special.invited));
        check('and are not on its list',
          vday && !(vday.special.people || []).some(p => p.profile_id === vetId));
      }
    }

    const hist = await get('/api/meetings/history', other.setCookies);
    check('and it does not turn up in the meetings log',
      !(hist.weeks || []).flatMap(w => w.sessions).some(s => s.date === ask.session.date));
    check('nor start one: answering only this leaves the log empty',
      (hist.weeks || []).length === 0, String((hist.weeks || []).length));
  }

  /* Start here (the new-member checklist) and the welcome line in the feed.
     They live here rather than in suite-profiles because both lean on the
     onboarding session above: the checklist carries its RSVP as a step. */
  console.log('\nstart here');
  const fresh = await signUp('Start', 'Here');
  let sh = await get('/api/start-here', fresh.setCookies);
  const step = id => (sh.steps || []).find(x => x.id === id) || {};
  check('a new account gets the checklist', sh.show === true, JSON.stringify(sh).slice(0, 90));
  check('with nothing ticked yet', (sh.steps || []).every(x => !x.done),
    (sh.steps || []).filter(x => x.done).map(x => x.id).join(' '));
  check('and the glossary among its links',
    (sh.links || []).some(l => l.href === '/glossary'));
  if (ask.session) {
    check('the session RSVP is one of the steps', !!step('session').label, JSON.stringify(sh.steps));
    check('and opens the meetings page on that day',
      step('session').href === '/meetings?day=' + ask.session.date, step('session').href);
  }

  const countJoined = async () => ((await get('/api/dashboard', fresh.setCookies)).activity || [])
    .filter(a => a.actor === 'Start Here' && a.verb === 'joined').length;
  await post('/api/profile/subteam', fresh.setCookies, { subteam: 'mech' });
  sh = await get('/api/start-here', fresh.setCookies);
  check('picking a division ticks that step off', step('division').done === true,
    JSON.stringify(step('division')));
  const feed = ((await get('/api/dashboard', fresh.setCookies)).activity || [])
    .find(a => a.actor === 'Start Here' && a.verb === 'joined');
  check('and says hello in the feed, naming the division',
    feed && feed.subject === 'Mechanical', JSON.stringify(feed || null));
  await post('/api/profile/subteam', fresh.setCookies, { subteam: 'ops' });
  check('but only the first time', (await countJoined()) === 1);

  process.exit(summary('meetings') ? 1 : 0);
})().catch(e => { console.error('  suite crashed:', e.message); process.exit(1); });
