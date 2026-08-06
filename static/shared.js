/* ============================================================================
 * UCDFS shared runtime
 *
 *   <script src="/static/shared.js"></script>
 *
 * Owns the one thing every applet needs: who the user is.
 *
 * Identity now comes from the signed-in session. The server sets two cookies on
 * login: an httpOnly one holding the tokens (the actual credential, which this
 * script cannot read and therefore cannot leak), and a readable one holding
 * display name + role. UCDFS.user() reads the readable one, which keeps it
 * synchronous, so every call site written against the old localStorage version
 * still works unchanged.
 *
 * The profile cookie is display data, never authorization. The server re-checks
 * the session on every request and ignores it entirely.
 * ========================================================================== */
(function (window, document) {
  'use strict';

  var PROFILE_COOKIE = 'ucdfs_profile';

  /* Where people's names lived before accounts existed. Only the sign-in screen
     reads these now, to greet a returning user by name and pre-fill the signup
     form, so the move to accounts isn't a cold wall. */
  var LEGACY = [
    ['ucdfs_user', null],    // the shared-layer key
    ['att_fn',  'att_ln'],   // attendance.html, pt.html, harness.html
    ['comp_fn', 'comp_ln']   // comp.html
  ];

  var cachedUser = null;   // null = not yet read, false = read and absent
  var appletsPromise = null;
  var photosPromise = null;
  /* What the site calls it. "God mode" is our name for it in the code, the
     schema and the docs; the team sees something that describes what it does. */
  var OVERRIDE_NAME = 'Admin override';

  var obStarted = false;    // the subteam step is raised at most once per page
  var obCallbacks = [];     // pages that want to hear which one was picked

  // ── Identity ─────────────────────────────────────────────────────────────

  function build(first, last, extra) {
    first = (first || '').trim();
    last  = (last  || '').trim();
    if (!first && !last) return null;
    var name = (first + ' ' + last).trim();
    var u = { first: first, last: last, name: name, initials: initials(name) };
    if (extra) {
      u.email = extra.email || '';
      u.role  = extra.role  || 'member';
      /* Presentational only. It defaults the dashboard filter and nothing
         else. Null is a real value ("not sure yet"), so it stays null rather
         than being coerced to a subteam nobody picked. An older cookie written
         before subteams existed simply has no field, which lands in the same
         place. */
      u.subteam = extra.subteam || null;
      /* Your own face, so a page can draw it without waiting on a fetch. Null
         when you haven't uploaded one. Every caller falls back to initials. */
      u.photo = extra.photo || null;
      /* Drives the god-mode banner and nothing else. Display, like everything
         else here: forging it draws a banner and grants precisely nothing,
         because every gate is enforced server-side against the database row. */
      u.god_mode = !!extra.god_mode;
    }
    return u;
  }

  function readCookie(name) {
    var parts = ('; ' + document.cookie).split('; ' + name + '=');
    if (parts.length !== 2) return null;
    var raw = parts.pop().split(';').shift();
    /* A value containing a character that is not legal raw ("/" in a photo
       URL, say) comes back wrapped in double quotes. Strip them, or JSON.parse
       reads the payload as a string and identity silently vanishes. The server
       encodes to avoid this; this is the belt to that pair of braces, and it
       also rescues any cookie issued before that fix. */
    if (raw.length > 1 && raw.charAt(0) === '"' && raw.charAt(raw.length - 1) === '"') {
      raw = raw.slice(1, -1);
    }
    try { return decodeURIComponent(raw); } catch (e) { return raw; }
  }

  function readProfile() {
    var raw = readCookie(PROFILE_COOKIE);
    if (!raw) return null;
    try {
      var p = JSON.parse(raw);
      return build(p.first, p.last, p);
    } catch (e) { return null; }
  }

  /** The signed-in user, or null. Synchronous. */
  function user() {
    if (cachedUser === null) cachedUser = readProfile() || false;
    return cachedUser || null;
  }

  /**
   * Re-read the profile cookie, discarding the cache.
   *
   * Needed because the server rewrites that cookie when you edit your own
   * profile, picking a subteam, say. Without this, user() keeps handing back
   * the version from page load and the dashboard filter defaults to the subteam
   * you just left.
   */
  function refreshUser() {
    cachedUser = null;
    return user();
  }

  /**
   * The name this browser knew before accounts existed. Sign-in screen only,
   * it is not an identity and grants nothing.
   */
  function legacyName() {
    for (var i = 0; i < LEGACY.length; i++) {
      try {
        var a = LEGACY[i][0], b = LEGACY[i][1];
        if (b === null) {
          var raw = window.localStorage.getItem(a);
          if (raw) {
            var o = JSON.parse(raw);
            var u = build(o.first, o.last);
            if (u) return u;
          }
        } else {
          var found = build(window.localStorage.getItem(a),
                            window.localStorage.getItem(b));
          if (found) return found;
        }
      } catch (e) { /* try the next pair */ }
    }
    return null;
  }

  /** Sign out, then land on the sign-in screen. */
  function signOut() {
    return fetch('/api/auth/logout', { method: 'POST' })
      .catch(function () {})
      .then(function () {
        cachedUser = false;
        window.location.href = '/login';
      });
  }

  // ── Derived display helpers ──────────────────────────────────────────────

  function initials(s) {
    return (s || '').trim().split(/\s+/).map(function (w) { return w[0] || ''; })
      .slice(0, 2).join('').toUpperCase();
  }

  /** Stable hue per name, so a person keeps the same presence colour anywhere. */
  function hue(s) {
    var h = 0;
    s = s || '';
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  function colour(s) { return 'hsl(' + hue(s) + ',68%,48%)'; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ── Gates ────────────────────────────────────────────────────────────────

  /**
   * Reveal the page once we know who this is.
   *
   * The server already redirects unauthenticated requests for a page route to
   * /login, so by the time this runs there is normally a session. The redirect
   * here is the belt-and-braces case: a cookie that expired while the tab sat
   * open, or a page opened straight from cache.
   */
  function gate(onReady) {
    var u = user();
    var setup = document.getElementById('setup');
    var main  = document.getElementById('main');

    if (!u) {
      window.location.href = '/login?next=' +
        encodeURIComponent(window.location.pathname);
      return null;
    }
    if (setup) setup.style.display = 'none';
    if (main)  main.style.display  = '';
    if (onReady) onReady(u);
    return u;
  }

  /**
   * Canvas tools (pt, harness) need a display name synchronously at script-eval
   * time. Their page route is session-protected, so the profile cookie is
   * already there, with no prompt and no fallback identity.
   */
  function requireName() {
    var u = user();
    return u ? u.name : 'Guest';
  }

  /** Fill the standard header pill. Safe to call on pages without one. */
  function renderPill() {
    var u = user();
    if (!u) return;
    var av = document.getElementById('pill-avatar');
    var nm = document.getElementById('pill-name');
    if (av) {
      if (u.photo) {
        /* Set as a background rather than an <img> so the one element works
           either way and nothing reflows when a photo is added or removed. */
        av.textContent = '';
        av.style.backgroundImage = 'url("' + u.photo + '")';
        av.className = 'pill-avatar pill-avatar-photo';
      } else {
        av.textContent = u.initials;
        av.style.backgroundImage = '';
        av.className = 'pill-avatar';
      }
    }
    if (nm) nm.textContent = u.name;
  }

  /**
   * {lowercased full name: photo URL} for the whole team, fetched once.
   *
   * The name-keyed pages (attendance, the nowbar) predate accounts, so a face
   * has to be looked up by the name that was typed. Cached like applets(),
   * every list on a page shares one request.
   */
  function photos() {
    if (!photosPromise) {
      photosPromise = fetch('/api/people/photos')
        .then(function (r) { return r.json(); })
        .then(function (j) { return j.photos || {}; })
        .catch(function () { photosPromise = null; return {}; });
    }
    return photosPromise;
  }

  /** The photo for a name, or null. Takes the map from photos(). */
  function photoFor(map, name) {
    return (map && map[String(name || '').trim().toLowerCase()]) || null;
  }

  /**
   * One avatar, as a photo when there is one and initials when there isn't.
   * `cls` is the caller's own avatar class, so each page keeps its own sizing.
   */
  function avatar(name, photo, cls, style) {
    var extra = style ? ';' + style : '';
    if (photo) {
      return '<div class="' + cls + ' has-photo" style="background-image:url(\'' +
             esc(photo) + '\')' + extra + '" title="' + esc(name) + '"></div>';
    }
    return '<div class="' + cls + '" style="background:' + colour(name) + extra +
           '" title="' + esc(name) + '">' + esc(initials(name)) + '</div>';
  }

  // ── Applet registry ──────────────────────────────────────────────────────

  /**
   * Cached fetch of /api/applets. The server is the single source of truth.
   *
   * The cache holds the whole payload so the dashboard's layout groups arrive
   * on the same request as the cards. applets() still resolves to just the
   * array, which is what every caller wants.
   */
  function appletsPayload() {
    if (!appletsPromise) {
      appletsPromise = fetch('/api/applets')
        .then(function (r) { return r.json(); })
        .catch(function () { appletsPromise = null; return {}; });
    }
    return appletsPromise;
  }

  function applets() {
    return appletsPayload().then(function (j) { return (j && j.applets) || []; });
  }

  /** The dashboard's blocks, in order. Empty means "one grid, no headings". */
  function appletGroups() {
    return appletsPayload().then(function (j) { return (j && j.groups) || []; });
  }

  /** Applet ids this account has starred, in the order they were starred. */
  function favourites() {
    return appletsPayload().then(function (j) { return (j && j.favourites) || []; });
  }

  // ── Runtime styles ───────────────────────────────────────────────────────

  /**
   * Styles for the elements this file injects into pages.
   *
   * They cannot live in shared.css. The canvas tools (pt, harness) load
   * shared.js but deliberately NOT shared.css. They have their own visual
   * language, so anything appended to document.body from here would render as
   * raw unstyled markup on exactly the pages nobody would think to check. That
   * is what happened to the override banner the first time.
   *
   * Every colour is var(--token, literal): it picks up the design system on a
   * card page and still looks right on a canvas tool where those custom
   * properties were never defined.
   */
  var RUNTIME_CSS =
    '.ucdfs-bar{position:fixed;right:14px;bottom:14px;z-index:2000;' +
      'display:flex;align-items:center;gap:10px;padding:8px 10px 8px 14px;' +
      'border-radius:999px;background:var(--ucd-navy,#15386e);color:var(--ucd-gold,#f6ca45);' +
      'box-shadow:0 8px 24px rgba(0,0,0,.28);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'font-size:.72rem;font-weight:800;letter-spacing:.07em;text-transform:uppercase;' +
      'line-height:1;}' +
    '.ucdfs-bar-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;' +
      'background:var(--ucd-gold,#f6ca45);animation:ucdfsPulse 2s ease-in-out infinite;}' +
    '@keyframes ucdfsPulse{0%,100%{opacity:1}50%{opacity:.25}}' +
    '.ucdfs-bar-off{border:none;cursor:pointer;font-family:inherit;font-size:.7rem;' +
      'font-weight:800;letter-spacing:.04em;padding:6px 12px;border-radius:999px;' +
      'background:var(--ucd-gold,#f6ca45);color:var(--ucd-navy,#15386e);' +
      'text-transform:uppercase;line-height:1;}' +
    '.ucdfs-bar-off:disabled{opacity:.6;cursor:default;}' +
    '@media (max-width:520px){.ucdfs-bar{right:10px;bottom:10px;font-size:.66rem;}}' +

    '.ob-wrap{position:fixed;inset:0;z-index:2001;background:rgba(15,23,42,.55);' +
      '-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);' +
      'display:flex;align-items:center;justify-content:center;padding:22px;' +
      'overflow-y:auto;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}' +
    '.ob-card{background:var(--card,#fff);color:var(--text,#0f172a);border-radius:24px;' +
      'padding:30px 26px;box-shadow:0 12px 28px rgba(0,0,0,.25);' +
      'width:100%;max-width:460px;margin:auto;text-align:left;}' +
    '.ob-h{font-size:1.3rem;font-weight:800;letter-spacing:-.02em;}' +
    '.ob-p{color:var(--muted,#64748b);font-size:.85rem;line-height:1.55;margin:7px 0 20px;}' +
    '.ob-opts{display:grid;gap:10px;margin-bottom:14px;}' +
    '.ob-opt{display:flex;align-items:center;gap:13px;width:100%;padding:15px 16px;' +
      'text-align:left;cursor:pointer;background:var(--card,#fff);' +
      'border:2px solid var(--border,#e2e8f0);border-radius:16px;' +
      'font-family:inherit;color:var(--text,#0f172a);' +
      'transition:border-color .13s,transform .13s;}' +
    '.ob-opt:hover{border-color:var(--ob-accent,#4f46e5);transform:translateY(-2px);}' +
    '.ob-opt:disabled{opacity:.5;cursor:default;transform:none;}' +
    '.ob-icon{width:42px;height:42px;border-radius:12px;flex-shrink:0;display:flex;' +
      'align-items:center;justify-content:center;font-size:1.3rem;' +
      'background:var(--ob-accent-bg,#eef2ff);}' +
    '.ob-name{font-weight:700;font-size:.95rem;}' +
    '.ob-cta{display:block;width:100%;padding:14px;border:none;border-radius:14px;' +
      'background:var(--dark,#0f172a);color:#fff;font-family:inherit;font-size:.95rem;' +
      'font-weight:700;text-align:center;text-decoration:none;cursor:pointer;}' +
    '.ob-later{width:100%;padding:11px;background:none;border:none;font-family:inherit;' +
      'font-size:.8rem;color:var(--muted,#64748b);cursor:pointer;border-radius:10px;}' +
    '.ob-later:hover{background:var(--bg,#f1f5f9);color:var(--text,#0f172a);}';

  function ensureRuntimeStyles() {
    if (document.getElementById('ucdfs-runtime-css')) return;
    var el = document.createElement('style');
    el.id = 'ucdfs-runtime-css';
    el.textContent = RUNTIME_CSS;
    document.head.appendChild(el);
  }

  // ── First sign-in ────────────────────────────────────────────────────────

  var ACCENT_VARS = {
    indigo: ['var(--indigo)', 'var(--indigo-bg)'],
    purple: ['var(--purple)', 'var(--purple-bg)'],
    green:  ['var(--green)',  'var(--green-bg)'],
    amber:  ['var(--amber)',  'var(--amber-bg)'],
    teal:   ['var(--teal)',   'var(--teal-bg)'],
    red:    ['var(--red)',    'var(--red-bg)']
  };

  /**
   * Ask a brand-new account which division they're on, wherever they landed.
   *
   * This used to live on the dashboard, which meant someone who signed up from
   * a shared /harness link was never asked until they happened to open the
   * homepage. During recruitment the people arriving by shared link are exactly
   * the ones worth catching, so it moved here and the markup is built rather
   * than duplicated into six pages.
   *
   * onPicked(subteamId | null) fires after a successful save, so a page that
   * cares (the dashboard filter) can react.
   */
  function onboard(onPicked) {
    if (onPicked) obCallbacks.push(onPicked);
    if (!user() || window.location.pathname === '/login') return;
    /* Already answered. Never ask again, and skip the request entirely. */
    if (user().subteam) return;

    /* Called twice on the dashboard: once automatically for every page, once by
       the page itself to hear about the answer. Only the first call asks. The
       second just leaves its callback. Without this the overlay is built twice
       and the second one covers the first. */
    if (obStarted) return;
    obStarted = true;

    fetch('/api/profile/me')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (meta) {
        /* !ready means 003 isn't applied. Asking someone to pick and then
           failing to save it is worse than not asking. */
        if (!meta || !meta.ready || meta.onboarded) return;
        raise(meta.subteams || []);
      })
      .catch(function () { /* never block a page over this */ });
  }

  function raise(subteams) {
    ensureRuntimeStyles();
    var wrap = document.createElement('div');
    wrap.className = 'ob-wrap';
    wrap.id = 'onboard';
    wrap.innerHTML =
      '<div class="ob-card">' +
        '<div class="ob-h" id="ob-h">Which division are you on?</div>' +
        '<div class="ob-p" id="ob-p">You can change this any time.</div>' +
        '<div class="ob-opts" id="ob-opts"></div>' +
        '<button class="ob-later" id="ob-later" type="button">Not sure yet</button>' +
      '</div>';
    document.body.appendChild(wrap);

    var opts = wrap.querySelector('#ob-opts');
    opts.innerHTML = subteams.map(function (s) {
      var a = ACCENT_VARS[s.accent] || ACCENT_VARS.indigo;
      return '<button class="ob-opt" type="button" data-subteam="' + esc(s.id) + '"' +
             ' style="--ob-accent:' + a[0] + ';--ob-accent-bg:' + a[1] + '">' +
             '<div class="ob-icon">' + s.icon + '</div>' +
             '<div class="ob-name">' + esc(s.name) + '</div></button>';
    }).join('');

    var buttons = [].slice.call(wrap.querySelectorAll('.ob-opt'))
                    .concat([wrap.querySelector('#ob-later')]);

    function pick(id) {
      buttons.forEach(function (b) { b.disabled = true; });
      fetch('/api/profile/subteam', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subteam: id })
      }).then(function (r) {
        if (!r.ok) throw new Error('save failed');
        refreshUser();
        step2(wrap, subteams, id);
        obCallbacks.forEach(function (cb) {
          try { cb(id); } catch (e) { /* one page's handler must not stop another */ }
        });
      }).catch(function () {
        buttons.forEach(function (b) { b.disabled = false; });
        toast("Couldn't save that. Try again");
      });
    }

    wrap.querySelectorAll('.ob-opt').forEach(function (b) {
      b.addEventListener('click', function () { pick(b.dataset.subteam); });
    });
    /* "Not sure yet" posts null and still marks them onboarded. It is an
       answer, not a skip: half of September's intake genuinely don't know. */
    wrap.querySelector('#ob-later').addEventListener('click', function () { pick(null); });
  }

  /* Straight into "finish your profile" rather than dropping them back on the
     page. One sequence, so nobody is asked two unrelated questions on two
     different days. */
  function step2(wrap, subteams, picked) {
    var s = null;
    for (var i = 0; i < subteams.length; i++) if (subteams[i].id === picked) s = subteams[i];
    wrap.querySelector('#ob-h').textContent = s ? "You're on " + s.name + ' ' + s.icon : 'Nice one';
    wrap.querySelector('#ob-p').textContent =
      'Add a photo and pick three prompts so people know who you are.';
    /* Its own class, not .btn. The canvas tools have no shared.css to take
       that from, and this overlay can appear on them. */
    wrap.querySelector('#ob-opts').innerHTML =
      '<a class="ob-cta" href="/profiles?edit=1">Set up my profile</a>';
    var later = wrap.querySelector('#ob-later');
    later.disabled = false;
    later.textContent = 'Later';
    later.onclick = function () { wrap.remove(); };
  }

  // ── God mode ─────────────────────────────────────────────────────────────

  /**
   * A banner on every page while an admin is elevated, with a one-click way out.
   *
   * Being able to edit anyone's anything must never be a state you are in
   * without noticing. The flag comes from the profile cookie, which makes this
   * display only. Every actual gate is enforced server-side against the
   * database row, so a forged cookie draws a banner and grants nothing.
   */
  function godBar() {
    var existing = document.getElementById('ucdfs-override-bar');
    var u = user();
    if (!u || !u.god_mode) { if (existing) existing.remove(); return; }
    if (existing) return;

    ensureRuntimeStyles();
    var bar = document.createElement('div');
    bar.className = 'ucdfs-bar';
    bar.id = 'ucdfs-override-bar';
    bar.innerHTML = '<span class="ucdfs-bar-dot"></span><span>' + OVERRIDE_NAME + '</span>' +
                    '<button class="ucdfs-bar-off" id="ucdfs-override-off" type="button">Turn off</button>';
    document.body.appendChild(bar);

    bar.querySelector('#ucdfs-override-off').addEventListener('click', function () {
      var btn = bar.querySelector('#ucdfs-override-off');
      btn.disabled = true;
      btn.textContent = '…';
      fetch('/api/admin/god-mode', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: false })
      }).then(function (r) {
        if (!r.ok) throw new Error('failed');
        /* Reload rather than patch: half this page was rendered with elevated
           permissions, and leaving those controls on screen after dropping them
           is exactly the confusion the banner exists to prevent. */
        window.location.reload();
      }).catch(function () {
        btn.disabled = false;
        btn.textContent = 'Turn off';
        toast("Couldn't switch that off");
      });
    });
  }

  // ── Toast ────────────────────────────────────────────────────────────────

  var toastTimer = null;

  function toast(msg, ms) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, ms || 2600);
  }

  // ── Misc ─────────────────────────────────────────────────────────────────

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  /* Both run on every page that loads this file. The god bar has to be
     everywhere by definition, and the onboarding step is only useful if it
     catches you wherever you landed. Pages that want to react to a division
     being picked call UCDFS.onboard(cb) themselves; calling it twice is
     harmless because the second call sees a subteam and returns. */
  function autoStart() {
    try { godBar(); onboard(); } catch (e) { /* never break a page */ }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoStart);
  } else {
    autoStart();
  }

  window.UCDFS = {
    user: user,
    refreshUser: refreshUser,
    legacyName: legacyName,
    signOut: signOut,
    gate: gate,
    requireName: requireName,
    renderPill: renderPill,
    applets: applets,
    appletGroups: appletGroups,
    favourites: favourites,
    onboard: onboard,
    godBar: godBar,
    photos: photos,
    photoFor: photoFor,
    avatar: avatar,
    initials: initials,
    hue: hue,
    colour: colour,
    esc: esc,
    toast: toast,
    todayISO: todayISO
  };
})(window, document);
