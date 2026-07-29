#!/usr/bin/env bash
# Static checks — no container needed, run first because they are instant.
#   - Python parses
#   - every inline <script> parses
#   - every CSS class used in markup or JS is defined somewhere
set -u
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

echo "── syntax ──"
ck "main.py parses" \
   "$(python3 -c "import ast;ast.parse(open('$ROOT/main.py').read());print('ok')" 2>/dev/null)" "ok"

ck "shared.js parses" \
   "$(node -e "new (require('vm').Script)(require('fs').readFileSync('$ROOT/static/shared.js','utf8'));console.log('ok')" 2>/dev/null)" "ok"

for f in dashboard login attendance comp pt harness profiles admin flowcharts; do
  ck "$f.html inline scripts parse" \
     "$(node -e "
       const fs=require('fs'),vm=require('vm');
       const s=fs.readFileSync('$ROOT/static/$f.html','utf8');
       const b=[...s.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
       try{ b.forEach((x,i)=>new vm.Script(x,{filename:'$f#'+i})); console.log('ok'); }
       catch(e){ console.log(e.message); }" 2>/dev/null)" "ok"
done

echo
echo "── CSS classes used vs defined ──"
# Classes defined inside JS-built <style> strings count too, so the whole file is
# scanned for definitions rather than just its <style> block.
ck "no undefined classes" "$(node -e "
const fs=require('fs');
const shared=fs.readFileSync('$ROOT/static/shared.css','utf8');
const defsIn=t=>new Set([...t.matchAll(/\.([A-Za-z][\w-]*)/g)].map(m=>m[1]));
const sharedDefs=defsIn(shared);
let bad=[];
for(const p of ['dashboard','login','attendance','comp','pt','harness','profiles','admin','flowcharts']){
  const s=fs.readFileSync('$ROOT/static/'+p+'.html','utf8');
  const defs=new Set([...defsIn(s), ...(s.includes('/static/shared.css')?sharedDefs:[])]);
  const used=new Set();
  for(const m of s.matchAll(/class=\"([^\"{}]*)\"/g)) m[1].split(/\s+/).forEach(c=>c&&used.add(c));
  for(const m of s.matchAll(/classList\.(?:add|remove|toggle)\('([\w-]+)'/g)) used.add(m[1]);
  for(const u of used) if(!defs.has(u)&&!u.startsWith('\${')) bad.push(p+':'+u);
}
console.log(bad.length?bad.join(' '):'none');" 2>/dev/null)" "none"

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
