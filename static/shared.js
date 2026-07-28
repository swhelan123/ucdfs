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
 * synchronous — so every call site written against the old localStorage version
 * still works unchanged.
 *
 * The profile cookie is display data, never authorization. The server re-checks
 * the session on every request and ignores it entirely.
 * ========================================================================== */
(function (window, document) {
  'use strict';

  var PROFILE_COOKIE = 'ucdfs_profile';

  /* Where people's names lived before accounts existed. Only the sign-in screen
     reads these now — to greet a returning user by name and pre-fill the signup
     form, so the move to accounts isn't a cold wall. */
  var LEGACY = [
    ['ucdfs_user', null],    // the shared-layer key
    ['att_fn',  'att_ln'],   // attendance.html, pt.html, harness.html
    ['comp_fn', 'comp_ln']   // comp.html
  ];

  var cachedUser = null;   // null = not yet read, false = read and absent
  var appletsPromise = null;
  var photosPromise = null;

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
      /* Presentational only — it defaults the dashboard filter and nothing
         else. Null is a real value ("not sure yet"), so it stays null rather
         than being coerced to a subteam nobody picked. An older cookie written
         before subteams existed simply has no field, which lands in the same
         place. */
      u.subteam = extra.subteam || null;
      /* Your own face, so a page can draw it without waiting on a fetch. Null
         when you haven't uploaded one — every caller falls back to initials. */
      u.photo = extra.photo || null;
    }
    return u;
  }

  function readCookie(name) {
    var parts = ('; ' + document.cookie).split('; ' + name + '=');
    if (parts.length !== 2) return null;
    var raw = parts.pop().split(';').shift();
    /* A value containing a character that is not legal raw — "/" in a photo
       URL, say — comes back wrapped in double quotes. Strip them, or JSON.parse
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
   * profile — picking a subteam, say. Without this, user() keeps handing back
   * the version from page load and the dashboard filter defaults to the subteam
   * you just left.
   */
  function refreshUser() {
    cachedUser = null;
    return user();
  }

  /**
   * The name this browser knew before accounts existed. Sign-in screen only —
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
   * already there — no prompt, no fallback identity.
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
   * has to be looked up by the name that was typed. Cached like applets() —
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

  /** Cached fetch of /api/applets — the server is the single source of truth. */
  function applets() {
    if (!appletsPromise) {
      appletsPromise = fetch('/api/applets')
        .then(function (r) { return r.json(); })
        .then(function (j) { return j.applets || []; })
        .catch(function () { appletsPromise = null; return []; });
    }
    return appletsPromise;
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

  window.UCDFS = {
    user: user,
    refreshUser: refreshUser,
    legacyName: legacyName,
    signOut: signOut,
    gate: gate,
    requireName: requireName,
    renderPill: renderPill,
    applets: applets,
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
