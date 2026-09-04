#!/usr/bin/env bash
# Static checks: no container needed, run first because they are instant.
#   - Python parses
#   - every inline <script> parses
#   - every CSS class used in markup or JS is defined somewhere
set -u
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# Nothing in here reads input, so nothing in here should hold a handle on it.
# A child that inherits an open stdin can sit on it forever, and a suite that
# hangs is worse than one that fails: CI waits out its whole timeout and the log
# stops mid-run with no reason given.
exec </dev/null

# Every page this suite knows about. One list, so adding a page is one edit.
PAGES="dashboard login attendance meetings purchases comp pt harness profiles admin flowcharts"

# The node checks are written to files and handed their inputs as argv rather
# than interpolated into `node -e "…"`.
#
# macOS ships bash 3.2, which splits a multi-line "$(node -e "…\"…\"")" into
# several arguments. ck then received five and compared two empty strings, so ten
# of these checks printed ok having never run: green here, red on the bash 5
# runner, with nothing on screen to say which. A heredoc with a quoted delimiter
# does no interpolation at all, so both shells see identical bytes. ck also
# refuses a wrong argument count now, so the same mistake cannot be silent twice.
JS_DIR="$(mktemp -d)"
trap 'rm -rf "$JS_DIR"' EXIT INT TERM

cat > "$JS_DIR/parse-inline.js" <<'JS'
const fs = require('fs'), vm = require('vm');
const [file, label] = process.argv.slice(2);
const src = fs.readFileSync(file, 'utf8');
const blocks = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1]);
try {
  blocks.forEach((b, i) => new vm.Script(b, { filename: label + '#' + i }));
  console.log('ok');
} catch (e) { console.log(e.message); }
JS

cat > "$JS_DIR/css-classes.js" <<'JS'
// Every class used in markup or JS has to be defined somewhere. Definitions are
// scanned from the whole file, not just its <style> block, because some are
// built inside JS template strings.
const fs = require('fs');
const [root, ...pages] = process.argv.slice(2);
const defsIn = t => new Set([...t.matchAll(/\.([A-Za-z][\w-]*)/g)].map(m => m[1]));
const sharedDefs = defsIn(fs.readFileSync(root + '/static/shared.css', 'utf8'));
const bad = [];
for (const p of pages) {
  const src = fs.readFileSync(root + '/static/' + p + '.html', 'utf8');
  const defs = new Set([...defsIn(src),
    ...(src.includes('/static/shared.css') ? sharedDefs : [])]);
  const used = new Set();
  for (const m of src.matchAll(/class="([^"{}]*)"/g))
    m[1].split(/\s+/).forEach(c => c && used.add(c));
  for (const m of src.matchAll(/classList\.(?:add|remove|toggle)\('([\w-]+)'/g))
    used.add(m[1]);
  for (const u of used) if (!defs.has(u) && !u.startsWith('${')) bad.push(p + ':' + u);
}
console.log(bad.length ? bad.join(' ') : 'none');
JS

cat > "$JS_DIR/avatar-photo.js" <<'JS'
/* UCDFS.avatar() must put the photo's sizing in the inline style attribute.
 *
 * It used to rely on .has-photo in shared.css for background-size:cover. That
 * broke every list avatar on /attendance and /meetings: their colour classes
 * (.av-in, .av-yes, …) used the `background:` shorthand, which resets
 * background-size to auto and background-position to 0% 0%, and a page <style>
 * block loads after shared.css so it won the cascade. Photos rendered at
 * natural size in a 34px circle. Inline wins over every stylesheet rule
 * whatever the order, so keeping it inline is what makes that unrepeatable.
 *
 * jsdom cannot judge a cascade, but it parses a style attribute exactly, and
 * the attribute is the whole invariant here. */
const fs = require('fs');
// This file is written to a mktemp dir, so a bare require('jsdom') resolves
// from there and finds nothing. Point at the suite's own node_modules.
const { JSDOM } = require(process.argv[2] + '/tests/node_modules/jsdom');
const [root] = process.argv.slice(2);
const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
dom.window.eval(fs.readFileSync(root + '/static/shared.js', 'utf8'));
const bad = [];
const html = dom.window.UCDFS.avatar('Ada Byron', '/photo.jpg', 'avatar av-yes');
dom.window.document.body.innerHTML = html;
const el = dom.window.document.body.firstElementChild;
if (!el) bad.push('no-element');
else {
  if (el.style.backgroundSize !== 'cover') bad.push('size=' + (el.style.backgroundSize || 'unset'));
  if (el.style.backgroundPosition !== 'center') bad.push('position=' + (el.style.backgroundPosition || 'unset'));
  if (!el.classList.contains('av-yes')) bad.push('lost-caller-class');
  // A caller-supplied style still comes last, so it can still override sizing
  // deliberately. What it must not do is get dropped.
  const withStyle = dom.window.UCDFS.avatar('Ada Byron', '/p.jpg', 'avatar', 'width:28px');
  dom.window.document.body.innerHTML = withStyle;
  const el2 = dom.window.document.body.firstElementChild;
  if (el2.style.width !== '28px') bad.push('dropped-caller-style');
  if (el2.style.backgroundSize !== 'cover') bad.push('caller-style-lost-size');
}
console.log(bad.length ? bad.join(' ') : 'none');
JS

echo "── syntax ──"
ck "main.py parses" \
   "$(python3 -c "import ast;ast.parse(open('$ROOT/main.py').read());print('ok')" 2>/dev/null)" "ok"

ck "shared.js parses" \
   "$(node -e "new (require('vm').Script)(require('fs').readFileSync('$ROOT/static/shared.js','utf8'));console.log('ok')" 2>/dev/null)" "ok"

for f in $PAGES; do
  ck "$f.html inline scripts parse" \
     "$(node "$JS_DIR/parse-inline.js" "$ROOT/static/$f.html" "$f" 2>/dev/null)" "ok"
done

echo
echo "── CSS classes used vs defined ──"
ck "no undefined classes" \
   "$(node "$JS_DIR/css-classes.js" "$ROOT" $PAGES 2>/dev/null)" "none"

# A colour class that uses the `background:` shorthand resets background-size,
# so it must never be the thing a photo avatar depends on. avatar() sizes
# inline now, which makes that safe, but the shorthand is still the wrong
# declaration for a rule that only means to set a colour.
ck "avatar sizes the photo inline" \
   "$(node "$JS_DIR/avatar-photo.js" "$ROOT" 2>/dev/null)" "none"

ck "no background shorthand on .av- classes" \
   "$(grep -hE '^\.av-[a-z]+ *\{ *background:' "$ROOT/static/shared.css" "$ROOT"/static/*.html | wc -l | tr -d ' ')" "0"

echo
echo "── secrets ──"
ck ".env is gitignored"       "$(grep -cx '\.env' "$ROOT/.gitignore")" "1"
ck ".env.example has no keys" "$(grep -cE '^(SUPABASE_KEY|SUPABASE_SERVICE_KEY)=.+' "$ROOT/.env.example")" "0"
ck "compose has no inline keys" "$(grep -c 'eyJhbGci' "$ROOT/docker-compose.yml")" "0"

# ── Nothing internal in files that could go public ──
# Every tier has a real hostname now, so a hardcoded LAN address is both wrong
# and a detail of the house this happens to run in. The addresses themselves are
# RFC 1918 and route nowhere from outside, but this repo may be made public and
# "it is only a private IP" is a judgement better not made in a hurry each time.
# Checked against tracked files only, so it never trips on local scratch.
# tr strips the padding macOS wc puts before the count, which otherwise fails
# the string comparison in ck on a Mac while passing on the Linux runner.
ips=$(git -C "$ROOT" grep -lE '\b(192\.168\.[0-9]{1,3}|10\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3})\.[0-9]{1,3}\b' \
        -- . ':(exclude)tests/suite-static.sh' 2>/dev/null | wc -l | tr -d ' ')
ck "no private IPs in tracked files" "$ips" "0"

summary "static"
