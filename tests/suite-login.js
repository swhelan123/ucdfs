/* The sign-in screen has to pick the right form without guessing.
 *
 * Regression this locks down: the screen used to infer "new user" from a name
 * left in localStorage. That name is per-device, so opening the site on a phone
 * pushed an existing user through signup and dead-ended them on "email already
 * registered". It now asks the server instead.
 */
const { BASE, TEST_PASSWORD, check, summary, open, submit, settle, signUp, signIn } = require('./lib');

const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const admin = (path, body) => fetch(`${SB}/auth/v1${path}`, {
  method: 'POST',
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const api = (path, body) => fetch(BASE + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/* The link an email would carry, without the email. generate_link hands back
   the token GoTrue would have mailed; following the verify URL by hand gives
   the redirect the browser would land on, session in the fragment and all. */
async function linkFragment(type, email) {
  const g = await (await admin('/admin/generate_link', { type, email })).json();
  if (!g.hashed_token) throw new Error('generate_link gave no token: ' + JSON.stringify(g));
  const verify = `${SB}/auth/v1/verify?token=${g.hashed_token}&type=${type}` +
                 `&redirect_to=${encodeURIComponent(BASE + '/login')}`;
  const frag = await follow(verify);
  if (!/access_token=/.test(frag)) throw new Error('verify did not redirect with a session: ' + frag);
  return { frag, verify };
}
/* What is after the # on wherever a verify URL sends the browser. */
async function follow(verify) {
  const r = await fetch(verify, { redirect: 'manual' });
  return ((r.headers.get('location') || '').split('#')[1] || '') || ('status=' + r.status);
}

/* Watch what the page sends, and answer some of it locally. A test that
   clicks "resend" must not actually send: the built-in mailer allows a couple
   of emails an hour and the address does not exist anyway. The endpoints
   behind the stubs are covered in suite-auth. */
function tapFetch(w, stubs = {}) {
  const calls = [];
  const real = w.fetch;
  w.fetch = (u, o = {}) => {
    const path = new URL(u, BASE).pathname;
    let body = null;
    try { body = JSON.parse(o.body || 'null'); } catch (e) {}
    const entry = { path, body, status: null };
    calls.push(entry);
    if (stubs[path]) {
      entry.status = 200;
      return Promise.resolve({ ok: true, status: 200, json: async () => stubs[path], text: async () => JSON.stringify(stubs[path]) });
    }
    return real(u, o).then(res => { entry.status = res.status; return res; });
  };
  return calls;
}
const sent = (calls, path) => calls.filter(c => c.path === path);

(async () => {
  if (!SB || !KEY) {
    console.log('  ── no service key in the environment; skipping ──');
    process.exit(summary('login') ? 1 : 0);
  }
  // A real account to recognise, created fresh so the suite is self-contained.
  const { email: known } = await signUp('Shane', 'Whelan');

  console.log('sign-in screen');

  console.log('\n  a device with an old cached name, account already exists');
  {
    const { w, d, errors } = await open('/login', { storage: { att_fn: 'Shane', att_ln: 'Whelan' } });
    check('starts on the email step, not signup',
      d.getElementById('email-field').style.display !== 'none' &&
      d.getElementById('password-field').style.display === 'none');
    check('button says Continue', d.getElementById('submit-label').textContent === 'Continue');

    d.getElementById('email').value = known;
    await submit(d);

    check('recognises the account and offers SIGN IN',
      d.getElementById('submit-label').textContent === 'Sign in',
      `got "${d.getElementById('submit-label').textContent}"`);
    check('does not ask for the name again',
      d.getElementById('name-field').style.display === 'none');
    check('greets using the name on the account',
      /Welcome back, Shane/.test(d.getElementById('auth-title').textContent),
      d.getElementById('auth-title').textContent);
    check('shows which account is being signed into',
      d.getElementById('identity-mail').textContent === known);
    check('no page errors', errors.length === 0, errors.join('; '));
    w.close();
  }

  console.log('\n  a cached name with no account yet');
  {
    const { w, d, errors } = await open('/login', { storage: { att_fn: 'Aoife', att_ln: 'Byrne' } });
    d.getElementById('email').value = 'ucdfs-test-nobody@ucdconnect.ie';
    await submit(d);
    check('offers SIGN UP',
      d.getElementById('submit-label').textContent === 'Create my account',
      `got "${d.getElementById('submit-label').textContent}"`);
    check('greets using the cached name',
      /Hey Aoife/.test(d.getElementById('auth-title').textContent),
      d.getElementById('auth-title').textContent);
    check('name fields shown and pre-filled',
      d.getElementById('name-field').style.display !== 'none' &&
      d.getElementById('first').value === 'Aoife' &&
      d.getElementById('last').value === 'Byrne');
    check('no page errors', errors.length === 0, errors.join('; '));
    w.close();
  }

  console.log('\n  a brand-new person with nothing cached');
  {
    const { w, d, errors } = await open('/login');
    d.getElementById('email').value = 'ucdfs-test-fresh@ucdconnect.ie';
    await submit(d);
    check('offers SIGN UP', d.getElementById('submit-label').textContent === 'Create my account');
    check('no invented name',
      d.getElementById('auth-title').textContent === 'Create your account',
      d.getElementById('auth-title').textContent);
    check('name fields empty', d.getElementById('first').value === '');
    check('no page errors', errors.length === 0, errors.join('; '));
    w.close();
  }

  console.log('\n  a device that has signed in before');
  {
    const { w, d, errors } = await open('/login', { storage: { ucdfs_last_email: known } });
    check('skips the email step',
      d.getElementById('email-field').style.display === 'none' &&
      d.getElementById('password-field').style.display !== 'none');
    check('goes straight to Sign in', d.getElementById('submit-label').textContent === 'Sign in');
    check('greets by name', /Welcome back, Shane/.test(d.getElementById('auth-title').textContent));
    check('no page errors', errors.length === 0, errors.join('; '));
    w.close();
  }

  console.log('\n  switching account');
  {
    const { w, d } = await open('/login', { storage: { ucdfs_last_email: known } });
    d.getElementById('identity-swap').click();
    await new Promise(r => setTimeout(r, 300));
    check('back on the email step',
      d.getElementById('email-field').style.display !== 'none' &&
      d.getElementById('password-field').style.display === 'none');
    check('button back to Continue', d.getElementById('submit-label').textContent === 'Continue');
    w.close();
  }

  console.log('\n  domain gate');
  {
    const { w, d } = await open('/login');
    d.getElementById('email').value = 'someone@gmail.com';
    await submit(d);
    check('non-UCD address is refused',
      d.getElementById('auth-error').classList.contains('show'),
      d.getElementById('auth-error').textContent);
    check('stays on the email step',
      d.getElementById('email-field').style.display !== 'none');
    w.close();
  }


  // Whether the project confirms email addresses is a dashboard toggle. The
  // page has to do the right thing in both modes, and which is right is this.
  const settings = await (await fetch(`${SB}/auth/v1/settings`, { headers: { apikey: process.env.SUPABASE_KEY } })).json();
  const autoconfirm = settings.mailer_autoconfirm === true;

  const fresh = `ucdfs-test-${Date.now()}-twice@ucdconnect.ie`;
  console.log(`\n  typing the password twice (confirm email is ${autoconfirm ? 'off' : 'on'})`);
  {
    const { w, d, errors } = await open('/login');
    const calls = tapFetch(w);
    d.getElementById('email').value = fresh;
    await submit(d);
    check('the signup step asks for it twice',
      d.getElementById('confirm-field').style.display !== 'none');
    check('and does not offer "forgot" on a signup', d.getElementById('forgot-row').style.display === 'none');
    d.getElementById('first').value = 'Login'; d.getElementById('last').value = 'Twice';
    d.getElementById('password').value = TEST_PASSWORD;
    d.getElementById('confirm').value  = TEST_PASSWORD + 'x';
    await submit(d);
    check('a mismatch is refused', /don't match/.test(d.getElementById('auth-error').textContent),
      d.getElementById('auth-error').textContent);
    check('on the page, before anything is sent', sent(calls, '/api/auth/signup').length === 0);
    check('still on the signup step', d.getElementById('submit-label').textContent === 'Create my account');
    const before = await (await api('/api/auth/check', { email: fresh })).json();
    check('so no account was made', before.exists === false);

    d.getElementById('confirm').value = TEST_PASSWORD;
    await submit(d);
    const after = await (await api('/api/auth/check', { email: fresh })).json();
    check('matching, the account is created', after.exists === true);
    check('the error is gone', !d.getElementById('auth-error').classList.contains('show'));
    const req = sent(calls, '/api/auth/signup')[0];
    check('the server got one password, not two',
      req && 'password' in req.body && !('confirm' in req.body) && !('password_confirm' in req.body));
    const onSent = d.getElementById('submit-label').textContent === 'Resend the email';
    if (autoconfirm) {
      check('signed in on the spot, no "check your email" step', req.status === 200 && !onSent,
        `status=${req.status} label=${d.getElementById('submit-label').textContent}`);
    } else {
      check('told to check their email, with resend on the button', onSent &&
        d.getElementById('auth-ok').classList.contains('show'), d.getElementById('submit-label').textContent);
    }
    check('no page errors', errors.length === 0, errors.join('; '));
    w.close();
  }

  console.log('\n  forgot your password');
  {
    const { w, d, errors } = await open('/login', { storage: { ucdfs_last_email: known } });
    check('offered on the sign-in step', d.getElementById('forgot-row').style.display !== 'none');
    const calls = tapFetch(w, { '/api/auth/forgot': { ok: true, message: 'Check your email for a link.' } });
    d.getElementById('forgot-btn').click();
    await settle(d);
    const req = sent(calls, '/api/auth/forgot')[0];
    check('asks the server, for this account', req && req.body && req.body.email === known,
      JSON.stringify(req && req.body));
    check('says it has', d.getElementById('auth-ok').classList.contains('show') &&
      /link/.test(d.getElementById('auth-ok').textContent), d.getElementById('auth-ok').textContent);
    check('no page errors', errors.length === 0, errors.join('; '));
    w.close();
  }

  console.log('\n  the reset link, end to end, without the email');
  {
    const { frag, verify } = await linkFragment('recovery', known);
    const { w, d, errors } = await open('/login#' + frag);
    check('opens on choosing a new password',
      d.getElementById('auth-title').textContent === 'Choose a new password',
      d.getElementById('auth-title').textContent);
    check('with the password asked for twice',
      d.getElementById('password-field').style.display !== 'none' &&
      d.getElementById('confirm-field').style.display !== 'none');
    check('and nothing else', d.getElementById('email-field').style.display === 'none' &&
      d.getElementById('identity').style.display === 'none');
    check('the session is gone from the address bar', w.location.hash === '', w.location.hash);
    const calls = tapFetch(w);
    const NEW = 'ChangedPassword456!';
    d.getElementById('password').value = NEW;
    d.getElementById('confirm').value  = NEW + 'x';
    await submit(d);
    check('a mismatch is refused here too', /don't match/.test(d.getElementById('auth-error').textContent));
    check('before anything is sent', sent(calls, '/api/auth/reset').length === 0);
    d.getElementById('confirm').value = NEW;
    await submit(d);
    const req = sent(calls, '/api/auth/reset')[0];
    check('the new password goes up with the link\'s session',
      req && req.status === 200 && req.body.access_token && req.body.password === NEW,
      JSON.stringify(req && { status: req.status, keys: Object.keys(req.body || {}) }));
    check('no page errors', errors.length === 0, errors.join('; '));
    w.close();

    let ok = true;
    try { await signIn(known, NEW); } catch (e) { ok = false; }
    check('the new password signs in', ok);
    let old = false;
    try { await signIn(known, TEST_PASSWORD); old = true; } catch (e) {}
    check('the old one no longer does', !old);
    const again = await follow(verify);
    check('the link itself is one-shot', /error/.test(again) && !/access_token=/.test(again), again.slice(0, 80));
  }

  console.log('\n  the confirmation link');
  {
    const { frag } = await linkFragment('magiclink', known);
    const { w, d, errors } = await open('/login#' + frag);
    // The page hands the session over as it loads; by the time open() returns
    // the call has been made through the page's own fetch, before tapFetch
    // could see it. So the check is the effect: the same fragment, offered to
    // the endpoint the page uses, is a session that works.
    check('the session is gone from the address bar', w.location.hash === '');
    check('no page errors', errors.length === 0, errors.join('; '));
    w.close();
    const q = Object.fromEntries(new URLSearchParams(frag));
    const r = await api('/api/auth/session', { access_token: q.access_token, refresh_token: q.refresh_token });
    const cookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    check('the server turns it into a cookie', r.status === 200 && cookies.some(c => /^ucdfs_session=/.test(c)),
      String(r.status));
    const me = await fetch(BASE + '/api/me', { headers: { cookie: cookies.map(c => c.split(';')[0]).join('; ') } });
    check('that is signed in as them', me.status === 200 && /Shane/.test(await me.text()));
  }

  console.log('\n  a dead link');
  {
    const { w, d, errors } = await open('/login#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    check('says so', d.getElementById('auth-error').classList.contains('show') &&
      /expired/.test(d.getElementById('auth-error').textContent), d.getElementById('auth-error').textContent);
    check('on the email step, ready to try again', d.getElementById('email-field').style.display !== 'none');
    check('and the error is gone from the address bar', w.location.hash === '');
    check('no page errors', errors.length === 0, errors.join('; '));
    w.close();
  }

  console.log('\n  signed up, never opened the link');
  {
    const waiting = `ucdfs-test-${Date.now()}-waiting@ucdconnect.ie`;
    const made = await admin('/admin/users', { email: waiting, password: TEST_PASSWORD, email_confirm: false,
                                               user_metadata: { first_name: 'Login', last_name: 'Waiting' } });
    check('an unconfirmed account to try with', made.ok, String(made.status));
    // Signup writes the profile row before GoTrue has heard back about the
    // email, which is what lets the sign-in screen recognise the address and
    // offer a password box rather than signup. An admin-made user has no row,
    // so write the one signup would have; it goes when the account does.
    const uid = (await made.json()).id;
    const row = await fetch(`${SB}/rest/v1/profiles`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ id: uid, first_name: 'Login', last_name: 'Waiting', email: waiting }),
    });
    check('with the profile row signup would have written', row.ok, String(row.status));
    const { w, d, errors } = await open('/login');
    const calls = tapFetch(w, { '/api/auth/resend': { ok: true, message: 'Sent another link.' } });
    d.getElementById('email').value = waiting;
    await submit(d);
    d.getElementById('password').value = TEST_PASSWORD;
    await submit(d);
    check('signing in is refused with the reason',
      /confirm your email/i.test(d.getElementById('auth-error').textContent), d.getElementById('auth-error').textContent);
    check('and lands on the check-your-email step, where resend is',
      d.getElementById('submit-label').textContent === 'Resend the email', d.getElementById('submit-label').textContent);
    await submit(d);
    const req = sent(calls, '/api/auth/resend')[0];
    check('resend asks for this address', req && req.body && req.body.email === waiting);
    check('and says so', d.getElementById('auth-ok').classList.contains('show'));
    check('no page errors', errors.length === 0, errors.join('; '));
    w.close();
  }

  process.exit(summary('login') ? 1 : 0);
})().catch(e => { console.error('  suite crashed:', e.stack || e.message); process.exit(1); });
