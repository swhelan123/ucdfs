/* The sign-in screen has to pick the right form without guessing.
 *
 * Regression this locks down: the screen used to infer "new user" from a name
 * left in localStorage. That name is per-device, so opening the site on a phone
 * pushed an existing user through signup and dead-ended them on "email already
 * registered". It now asks the server instead.
 */
const { check, summary, open, submit, signUp } = require('./lib');

(async () => {
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

  process.exit(summary('login') ? 1 : 0);
})().catch(e => { console.error('  suite crashed:', e.message); process.exit(1); });
