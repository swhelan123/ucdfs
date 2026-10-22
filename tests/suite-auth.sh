#!/usr/bin/env bash
# Auth: signup, session cookies, route protection, login, logout.
# Assumes a test container is already running (tests/run.sh handles that).
set -u
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CJ="$WORK/cookies.txt"; rm -f "$CJ"
EMAIL="$(test_email)"
# Letters, not digits: signup refuses a name matching an existing member's
# with everything but letters stripped, and other suites' "Test Bot"s are
# alive while this runs. Feed cleanup does not need it in TEST_ACTORS, because
# nothing this suite does writes a feed line.
LAST="Bot$(python3 -c 'import random,string;print("".join(random.choice(string.ascii_lowercase) for _ in range(8)))')"

# Whether the project confirms email addresses is a dashboard toggle the app
# cannot see and the suite must not assume. Signup answers differently in each
# mode and both answers are right, so the checks below follow the setting.
AUTOCONFIRM=$(curl -s -H "apikey: $SUPABASE_KEY" "$SUPABASE_URL/auth/v1/settings" \
  | python3 -c 'import json,sys;print(str(json.load(sys.stdin).get("mailer_autoconfirm")).lower())' 2>/dev/null)

echo "── signup (confirm email is $([ "$AUTOCONFIRM" = "true" ] && echo off || echo on)) ──"
code=$(curl -s -c "$CJ" -o "$WORK/o.json" -w '%{http_code}' -X POST "$BASE/api/auth/signup" \
  -H 'Content-Type: application/json' \
  -d "{\"first_name\":\"Test\",\"last_name\":\"$LAST\",\"email\":\"$EMAIL\",\"password\":\"$TEST_PASSWORD\"}")
ck "signup succeeds" "$code" "200"
if [ "$AUTOCONFIRM" = "true" ]; then
  ck "httpOnly session cookie set"    "$(grep -c 'ucdfs_session' "$CJ")" "1"
  ck "readable profile cookie set"    "$(grep -c 'ucdfs_profile' "$CJ")" "1"
  ck "session cookie is HttpOnly"     "$(grep 'ucdfs_session' "$CJ" | grep -c '^#HttpOnly')" "1"
  ck "profile cookie is NOT HttpOnly" "$(grep 'ucdfs_profile' "$CJ" | grep -c '^#HttpOnly')" "0"
else
  ck "no session until the email is confirmed" "$(grep -c 'ucdfs_session' "$CJ")" "0"
  ck "and the page is told so" \
     "$(python3 -c 'import json;print(json.load(open("'"$WORK/o.json"'")).get("needs_confirmation"))')" "True"
  ck "signing in before confirming is refused" \
     "$(curl -s -o "$WORK/o.json" -w '%{http_code}' -X POST "$BASE/api/auth/login" \
        -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$TEST_PASSWORD\"}")" "400"
  ck "with the reason" "$(grep -c -i 'confirm your email' "$WORK/o.json")" "1"
  # Confirm it the way the link would, minus the email: through the admin API.
  # The rest of this suite needs a signed-in cookie jar either way.
  python3 - "$SUPABASE_URL" "$SUPABASE_SERVICE_KEY" "$EMAIL" <<'PY2'
import json, sys, urllib.request
url, key, email = sys.argv[1:4]
hdr = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"}
def call(method, path, body=None):
    req = urllib.request.Request(url + path, headers=hdr, method=method,
                                 data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = r.read(); return json.loads(raw) if raw else {}
users = call("GET", "/auth/v1/admin/users?per_page=1000").get("users", [])
uid = next((u["id"] for u in users if u.get("email") == email), None)
if uid: call("PUT", "/auth/v1/admin/users/" + uid, {"email_confirm": True})
PY2
  ck "confirmed, signing in works" \
     "$(curl -s -c "$CJ" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" \
        -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$TEST_PASSWORD\"}")" "200"
  ck "session cookie is HttpOnly"     "$(grep 'ucdfs_session' "$CJ" | grep -c '^#HttpOnly')" "1"
  ck "profile cookie is NOT HttpOnly" "$(grep 'ucdfs_profile' "$CJ" | grep -c '^#HttpOnly')" "0"
fi

echo
echo "── signed-in access ──"
ck "/api/me" "$(curl -s -b "$CJ" -o /dev/null -w '%{http_code}' "$BASE/api/me")" "200"
for p in / /attendance /pt /comp /harness; do
  ck "page $p" "$(curl -s -b "$CJ" -o /dev/null -w '%{http_code}' "$BASE$p")" "200"
done
for p in /api/applets /api/dashboard /api/attendance /pt/api/state \
         /comp/api/roster /comp/api/requests /comp/api/expenses \
         /harness/api/load /comp/api/schedule/events; do
  ck "api $p" "$(curl -s -b "$CJ" -o /dev/null -w '%{http_code}' "$BASE$p")" "200"
done

echo
echo "── signed out ──"
for p in / /attendance /pt /comp /harness; do
  ck "page $p redirects" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$p")" "302"
done
for p in /api/dashboard /api/attendance /pt/api/state; do
  ck "api $p blocked" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$p")" "401"
done
for p in /login /api/auth/config; do
  ck "public $p" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$p")" "200"
done

echo
echo "── the profile cookie is display data, never authorization ──"
FORGED=$(python3 -c "import urllib.parse,json;print(urllib.parse.quote(json.dumps({'first':'Mallory','last':'X','email':'m@x.com','role':'admin'})))")
ck "forged profile cookie grants nothing" \
   "$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: ucdfs_profile=$FORGED" "$BASE/api/dashboard")" "401"
ck "garbage session token rejected" \
   "$(curl -s -o /dev/null -w '%{http_code}' -H 'Cookie: ucdfs_session={"access_token":"forged.jwt.here"}' "$BASE/api/dashboard")" "401"

echo
echo "── signup gate ──"
# 403, not 400: a disallowed domain is an authorization refusal, not a
# malformed request. A genuinely malformed address is the 400 case below.
ck "non-UCD email rejected" \
   "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/signup" -H 'Content-Type: application/json' \
      -d '{"first_name":"A","last_name":"B","email":"someone@gmail.com","password":"'"$TEST_PASSWORD"'"}')" "403"
ck "malformed email rejected" \
   "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/signup" -H 'Content-Type: application/json' \
      -d '{"first_name":"A","last_name":"B","email":"notanemail","password":"'"$TEST_PASSWORD"'"}')" "400"
ck "account check: known email"   "$(curl -s -X POST "$BASE/api/auth/check" -H 'Content-Type: application/json' \
      -d "{\"email\":\"$EMAIL\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["exists"])')" "True"
ck "account check: unknown email" "$(curl -s -X POST "$BASE/api/auth/check" -H 'Content-Type: application/json' \
      -d '{"email":"ucdfs-test-nobody@ucdconnect.ie"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["exists"])')" "False"
ck "account check: non-UCD blocked" \
   "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/check" -H 'Content-Type: application/json' \
      -d '{"email":"victim@gmail.com"}')" "403"

echo
echo "── a name that would pass for somebody else's ──"
# Refused before GoTrue is asked, so none of these makes an account or sends
# an email. Each uses a fresh address, so "email taken" cannot be the reason.
for variant in "Test|$LAST" "test|  ${LAST^^} " "Test.|$LAST" "Test|${LAST}2"; do
  f="${variant%%|*}"; l="${variant#*|}"
  code=$(curl -s -o "$WORK/o.json" -w '%{http_code}' -X POST "$BASE/api/auth/signup" \
    -H 'Content-Type: application/json' \
    -d "{\"first_name\":\"$f\",\"last_name\":\"$l\",\"email\":\"$(test_email)\",\"password\":\"$TEST_PASSWORD\"}")
  ck "signup as '$f $l' is refused" "$code" "409"
done
ck "  and says who it clashes with" "$(grep -c "Test $LAST" "$WORK/o.json")" "1"
# The page reads "already" as "this email has an account" and skips to the
# password step, which is the wrong place for somebody whose name is taken.
ck "  without the word the page reads as 'email taken'" "$(grep -ci 'already' "$WORK/o.json")" "0"

echo
echo "── rate limits, per address ──"
# The app believes X-Real-IP from a private peer, which this container's
# caller is, so each check gets an address of its own from TEST-NET-3 and
# cannot spend the bucket every other suite signs in through.
NET="203.0.113.$((RANDOM % 200 + 20))"
for i in $(seq 1 10); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" -H "X-Real-IP: $NET" \
    -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"wrong-password-$i\"}")
  [ "$code" = "400" ] || break
done
ck "ten wrong passwords are just wrong" "$code" "400"
ck "the eleventh attempt is refused" \
   "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" -H "X-Real-IP: $NET" \
      -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"wrong\"}")" "429"
ck "  even with the right password, from there" \
   "$(curl -s -D "$WORK/h.txt" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" -H "X-Real-IP: $NET" \
      -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$TEST_PASSWORD\"}")" "429"
ck "  and says when to come back" "$(grep -ci '^retry-after:' "$WORK/h.txt")" "1"
ck "the owner signs in fine from anywhere else" \
   "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" -H "X-Real-IP: 203.0.113.250" \
      -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$TEST_PASSWORD\"}")" "200"
NET2="198.51.100.$((RANDOM % 200 + 20))"
for i in $(seq 1 6); do
  curl -s -o /dev/null -X POST "$BASE/api/auth/forgot" -H "X-Real-IP: $NET2" \
    -H 'Content-Type: application/json' -d '{"email":"ucdfs-test-nobody@ucdconnect.ie"}'
done
ck "emails asked for in a burst are capped" \
   "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/resend" -H "X-Real-IP: $NET2" \
      -H 'Content-Type: application/json' -d '{"email":"ucdfs-test-nobody@ucdconnect.ie"}')" "429"
ck "a malformed X-Real-IP falls back to the peer instead of failing" \
   "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/check" -H 'X-Real-IP: not-an-address' \
      -H 'Content-Type: application/json' -d '{"email":"ucdfs-test-nobody@ucdconnect.ie"}')" "200"

echo
echo "── the email-link endpoints ──"
# None of these sends an email: the addresses have no account, or the tokens
# are junk. What is checked is the contract the sign-in page relies on, and
# that a made-up token buys nothing. Sending is one GoTrue call each, and the
# whole round trip from link to new password is in suite-login, without email.
for p in /api/auth/forgot /api/auth/resend /api/auth/session /api/auth/reset; do
  ck "public $p (no 401 for the signed-out)" \
     "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE$p" -H 'Content-Type: application/json' -d '{}' | sed 's/^401$/BLOCKED/')" \
     "400"
done
ck "forgot: unknown address is still a calm 200" \
   "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/forgot" -H 'Content-Type: application/json' \
      -d '{"email":"ucdfs-test-nobody@ucdconnect.ie"}')" "200"
ck "forgot: non-UCD address is 403, like check" \
   "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/forgot" -H 'Content-Type: application/json' \
      -d '{"email":"victim@gmail.com"}')" "403"
ck "resend: unknown address is a calm 200" \
   "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/resend" -H 'Content-Type: application/json' \
      -d '{"email":"ucdfs-test-nobody@ucdconnect.ie"}')" "200"
ck "session: a forged token gets no cookie" \
   "$(curl -s -c "$WORK/forged.txt" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/session" -H 'Content-Type: application/json' \
      -d '{"access_token":"forged.jwt.here","refresh_token":"x"}')" "400"
ck "  and none was set" "$(grep -c 'ucdfs_session' "$WORK/forged.txt")" "0"
ck "reset: a forged token sets nothing" \
   "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/reset" -H 'Content-Type: application/json' \
      -d '{"access_token":"forged.jwt.here","password":"AnotherPassword1!"}')" "400"
ck "reset: a short password is refused before GoTrue is asked" \
   "$(curl -s -X POST "$BASE/api/auth/reset" -H 'Content-Type: application/json' \
      -d '{"access_token":"forged.jwt.here","password":"short"}' | grep -c 'at least 8')" "1"

echo
echo "── a real write, end to end ──"
ck "log attendance" "$(curl -s -b "$CJ" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/log" \
   -H 'Content-Type: application/json' \
   -d '{"first_name":"Test","last_name":"'"$LAST"'","date":"2020-01-02","status":"arriving","arrival_time":"09:00","departure_time":"17:00"}')" "200"
ck "read it back" "$(curl -s -b "$CJ" "$BASE/api/attendance?target_date=2020-01-02" \
   | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["rows"]))')" "1"
ck "delete it" "$(curl -s -b "$CJ" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/log/delete" \
   -H 'Content-Type: application/json' -d '{"first_name":"Test","last_name":"'"$LAST"'","date":"2020-01-02"}')" "200"

echo
echo "── login / logout ──"
CJ2="$WORK/cookies2.txt"; rm -f "$CJ2"
ck "login" "$(curl -s -c "$CJ2" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" \
   -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$TEST_PASSWORD\"}")" "200"
ck "login session works" "$(curl -s -b "$CJ2" -o /dev/null -w '%{http_code}' "$BASE/api/me")" "200"
ck "wrong password" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" \
   -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"wrong-password\"}")" "400"
ck "logout" "$(curl -s -b "$CJ2" -c "$CJ2" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/logout")" "200"
ck "session dead after logout" "$(curl -s -b "$CJ2" -o /dev/null -w '%{http_code}' "$BASE/api/dashboard")" "401"

summary "auth"
