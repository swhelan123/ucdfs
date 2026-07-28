#!/usr/bin/env bash
# Auth: signup, session cookies, route protection, login, logout.
# Assumes a test container is already running (tests/run.sh handles that).
set -u
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CJ="$WORK/cookies.txt"; rm -f "$CJ"
EMAIL="$(test_email)"

echo "── signup ──"
code=$(curl -s -c "$CJ" -o "$WORK/o.json" -w '%{http_code}' -X POST "$BASE/api/auth/signup" \
  -H 'Content-Type: application/json' \
  -d "{\"first_name\":\"Test\",\"last_name\":\"Bot\",\"email\":\"$EMAIL\",\"password\":\"$TEST_PASSWORD\"}")
ck "signup succeeds" "$code" "200"
ck "httpOnly session cookie set"    "$(grep -c 'ucdfs_session' "$CJ")" "1"
ck "readable profile cookie set"    "$(grep -c 'ucdfs_profile' "$CJ")" "1"
ck "session cookie is HttpOnly"     "$(grep 'ucdfs_session' "$CJ" | grep -c '^#HttpOnly')" "1"
ck "profile cookie is NOT HttpOnly" "$(grep 'ucdfs_profile' "$CJ" | grep -c '^#HttpOnly')" "0"

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
echo "── a real write, end to end ──"
ck "log attendance" "$(curl -s -b "$CJ" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/log" \
   -H 'Content-Type: application/json' \
   -d '{"first_name":"Test","last_name":"Bot","date":"2020-01-02","status":"arriving","arrival_time":"09:00","departure_time":"17:00"}')" "200"
ck "read it back" "$(curl -s -b "$CJ" "$BASE/api/attendance?target_date=2020-01-02" \
   | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["rows"]))')" "1"
ck "delete it" "$(curl -s -b "$CJ" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/log/delete" \
   -H 'Content-Type: application/json' -d '{"first_name":"Test","last_name":"Bot","date":"2020-01-02"}')" "200"

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
