import os
import json
import time
import uuid
import logging
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
from typing import Optional
from urllib.parse import quote

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from fastapi import FastAPI, Request, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
import httpx
from supabase import create_client, Client

# ── Config ────────────────────────────────────────────────────────────────────
SUPABASE_URL  = os.environ["SUPABASE_URL"]
SUPABASE_KEY  = os.environ["SUPABASE_KEY"]
# No default: a real password must never be a source-code fallback, or it ends
# up in version control and in every clone. Unset means the shared-password
# route is simply closed, and committee/admin roles are the only way in — which
# is where we want to end up anyway (see TODO.md).
COMP_ADMIN_PW = os.environ.get("COMP_ADMIN_PASSWORD") or None

# The service_role key bypasses RLS. Once migrations/001_auth_and_rls.sql PART 2
# has run, this is the ONLY key that can reach the data — the anon key is exactly
# what RLS is there to shut out. It must never be sent to a browser.
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

if not SUPABASE_SERVICE_KEY:
    logger.warning(
        "SUPABASE_SERVICE_KEY is not set — falling back to the anon key. "
        "This works only while RLS is still disabled. Set it before running "
        "PART 2 of the migration, or every query will start returning nothing."
    )

# Everything the backend does server-side goes through the service key.
supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY or SUPABASE_KEY)

# ── Auth config ───────────────────────────────────────────────────────────────
# Self-signup is restricted to UCD addresses; nobody who finds the URL can join.
ALLOWED_EMAIL_DOMAINS = {
    d.strip().lower()
    for d in os.environ.get("ALLOWED_EMAIL_DOMAINS", "ucdconnect.ie,ucd.ie").split(",")
    if d.strip()
}

GOTRUE = f"{SUPABASE_URL}/auth/v1"

# Two cookies, doing different jobs:
#   SESSION_COOKIE — httpOnly, holds the tokens. The actual credential. JS can
#                    never read it, so an XSS bug cannot exfiltrate the session.
#   PROFILE_COOKIE — readable by JS, holds display name + role only. Lets
#                    UCDFS.user() stay synchronous. NEVER trusted server-side.
SESSION_COOKIE = "ucdfs_session"
PROFILE_COOKIE = "ucdfs_profile"
COOKIE_MAX_AGE = 60 * 60 * 24 * 30          # 30 days
# Set COOKIE_SECURE=0 only for local http testing.
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "1") != "0"

# ── Season calendar ───────────────────────────────────────────────────────────
# Hand-edited once a season. The dashboard countdown reads this and nothing
# else, so changing the date here is the whole job.
#
# Times the team logs (attendance arrival/departure) are wall-clock Dublin, not
# UTC. COMP_TZ further down is Europe/London on purpose — that one is about
# where the competition physically is, not where we are.
TEAM_TZ = ZoneInfo("Europe/Dublin")

FSUK_NAME = "FSUK 2027"
# PROVISIONAL. IMechE had not published the 2027 dates when this was written;
# this follows the 2026 pattern (arrival was Tue 14 Jul 2026 — see
# SAME_DAY_SPECIAL_DATE). Change it the day they announce. A countdown the team
# finds out is wrong is worse than no countdown, so the dashboard says
# "provisional" out loud until this flag flips.
FSUK_DATE        = date(2027, 7, 13)
FSUK_PROVISIONAL = True

# (label, date) — design freeze, manufacturing deadline, first test day, …
# Empty is fine: the countdown then just shows the competition on its own.
SEASON_MILESTONES: list[tuple[str, date]] = []

app = FastAPI()

app.mount("/static", StaticFiles(directory="static"), name="static")


# ── Applet registry ───────────────────────────────────────────────────────────
# The single source of truth for what exists on the site. It generates the page
# routes AND feeds /api/applets, which the dashboard renders. Adding an applet
# is one entry here plus one file in static/ — the dashboard needs no edit.
#
#   status: "live"  — working, full brightness on the dashboard
#           "quiet" — real but dormant (off-season); dimmed, still clickable
#           "soon"  — placeholder card, not clickable
#   accent: a colour token from shared.css (indigo/purple/green/amber/teal/red)
#
# When auth lands, add e.g. "requires_role": "committee" here and gate in one
# place rather than in each page.
APPLETS = [
    {
        "id":     "attendance",
        "name":   "Attendance",
        "icon":   "📋",
        "route":  "/attendance",
        "file":   "attendance.html",
        "blurb":  "Log who's in the workshop and when",
        "accent": "indigo",
        "status": "live",
    },
    {
        "id":     "pt",
        "name":   "PT Manufacturing Plan",
        "icon":   "🏎️",
        "route":  "/pt",
        "file":   "pt.html",
        "blurb":  "Powertrain build tasks, dependencies and progress",
        "accent": "teal",
        "status": "live",
    },
    {
        "id":     "harness",
        "name":   "Wiring Harness Mapper",
        "icon":   "🔌",
        "route":  "/harness",
        "file":   "harness.html",
        "blurb":  "Connectors, pinouts and wire runs",
        "accent": "amber",
        "status": "live",
    },
    {
        "id":     "comp",
        "name":   "Competition Hub",
        "icon":   "🏁",
        "route":  "/comp",
        "file":   "comp.html",
        "blurb":  "Roster, shop runs and expense splitting",
        "accent": "purple",
        "status": "quiet",
    },
    {
        "id":     "mech",
        "name":   "Mech Manufacturing Plan",
        "icon":   "⚙️",
        "route":  "https://www.canva.com/design/DAHFgTx32zs/IXAWyUJbm15DIqgdsbRkTg/edit",
        "blurb":  "Chassis and mechanical build plan (Canva)",
        "accent": "green",
        "status": "live",
        "external": True,
    },
]

APPLETS_BY_ID = {a["id"]: a for a in APPLETS}


def _page_route(filename: str):
    """Build a handler that serves one static page (closure over the filename)."""
    async def _serve():
        return FileResponse(f"static/{filename}")
    return _serve


for _applet in APPLETS:
    if _applet.get("file") and not _applet.get("external"):
        app.add_api_route(
            _applet["route"], _page_route(_applet["file"]), methods=["GET"]
        )


@app.get("/api/applets")
async def api_applets():
    """What the dashboard renders. Public fields only — no file paths."""
    return {"applets": [
        {k: v for k, v in a.items() if k != "file"} for a in APPLETS
    ]}


# ══════════════════════════════════════════════════════════════════════════════
#  Auth
#
#  The browser never speaks to Supabase. It posts credentials here; this process
#  calls GoTrue and hands back an httpOnly cookie. The anon key stays server-side
#  and the session cannot be read by any script on the page.
#
#  Deliberately not using supabase.auth.* — that client keeps the signed-in
#  session as state on the client object, and this one client instance is shared
#  by every request in the process. One user signing in would change who the
#  next request is. The GoTrue REST API is stateless, so it is used directly.
# ══════════════════════════════════════════════════════════════════════════════

class AuthError(Exception):
    """A signup/login failure with a message safe to show the user."""
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status  = status


def _gotrue_headers(token: Optional[str] = None) -> dict:
    h = {"apikey": SUPABASE_KEY, "Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def _friendly_auth_error(payload: dict, fallback: str) -> str:
    raw = (payload.get("msg") or payload.get("error_description")
           or payload.get("message") or payload.get("error") or "")
    low = raw.lower()
    if "already registered" in low or "already exists" in low:
        return "There's already an account with that email — sign in instead."
    if "invalid login" in low or "invalid_grant" in low:
        return "That email and password don't match."
    if "password" in low and "least" in low:
        return "Password must be at least 8 characters."
    return raw or fallback


async def _gotrue(method: str, path: str, *, token: Optional[str] = None,
                  json_body: Optional[dict] = None, fallback: str = "Auth failed") -> dict:
    async with httpx.AsyncClient(timeout=12) as client:
        r = await client.request(method, f"{GOTRUE}{path}",
                                 headers=_gotrue_headers(token), json=json_body)
    if r.status_code >= 400:
        try:
            payload = r.json()
        except Exception:
            payload = {}
        raise AuthError(_friendly_auth_error(payload, fallback),
                        403 if r.status_code == 403 else 400)
    return r.json() if r.content else {}


# ── Token validation ──────────────────────────────────────────────────────────
# GoTrue is the authority on whether a token is real, but asking it on every
# request would put a network round-trip in front of every page load. Validated
# tokens are cached briefly instead. Cache hits are keyed by the token itself,
# so a revoked token stops working within TOKEN_CACHE_TTL at worst.
TOKEN_CACHE_TTL = 60
_token_cache: dict = {}


def _cache_get(token: str) -> Optional[dict]:
    hit = _token_cache.get(token)
    if not hit:
        return None
    user, expires = hit
    if expires < time.time():
        _token_cache.pop(token, None)
        return None
    return user


def _cache_put(token: str, user: dict):
    if len(_token_cache) > 500:          # tiny team; this is just a leak-stop
        _token_cache.clear()
    _token_cache[token] = (user, time.time() + TOKEN_CACHE_TTL)


async def _user_from_token(token: str) -> Optional[dict]:
    cached = _cache_get(token)
    if cached is not None:
        return cached
    try:
        user = await _gotrue("GET", "/user", token=token)
    except AuthError:
        return None
    if not user.get("id"):
        return None
    _cache_put(token, user)
    return user


async def _refresh(refresh_token: str) -> Optional[dict]:
    try:
        return await _gotrue("POST", "/token?grant_type=refresh_token",
                             json_body={"refresh_token": refresh_token})
    except AuthError:
        return None


# ── Profiles ──────────────────────────────────────────────────────────────────
def _get_profile(user_id: str) -> Optional[dict]:
    try:
        r = supabase.table("profiles").select("*").eq("id", user_id).execute()
        return r.data[0] if r.data else None
    except Exception as e:
        logger.error(f"[auth] profile lookup failed: {e}")
        return None


def _upsert_profile(user_id: str, first: str, last: str, email: str) -> dict:
    """
    Write the profile row, but never let a failure here sink the request.

    The auth account is created first, so raising at this point would leave the
    person with working credentials, no profile, and a 500 — unable to sign up
    again because the email is taken. resolve_from_cookies() rebuilds a missing
    profile on the next request, so degrading quietly is genuinely recoverable.
    """
    row = {"id": user_id, "first_name": first, "last_name": last, "email": email}
    try:
        supabase.table("profiles").upsert(row).execute()
    except Exception as e:
        logger.error(
            f"[auth] could not write profile for {email}: {e} — "
            "if this says 'row-level security', SUPABASE_SERVICE_KEY is missing."
        )
    return {**row, "role": "member"}


def _public_profile(profile: dict) -> dict:
    """What the browser is allowed to know about the signed-in user."""
    first = (profile.get("first_name") or "").strip()
    last  = (profile.get("last_name") or "").strip()
    return {
        "first": first,
        "last":  last,
        "name":  (first + " " + last).strip(),
        "email": profile.get("email") or "",
        "role":  profile.get("role") or "member",
    }


# ── Cookies ───────────────────────────────────────────────────────────────────
def _set_session(response: Response, tokens: dict, profile: dict):
    session = json.dumps({
        "access_token":  tokens.get("access_token"),
        "refresh_token": tokens.get("refresh_token"),
    })
    response.set_cookie(SESSION_COOKIE, session, max_age=COOKIE_MAX_AGE,
                        httponly=True, secure=COOKIE_SECURE, samesite="lax", path="/")
    # Readable by JS on purpose — display only, never an authorization input.
    response.set_cookie(PROFILE_COOKIE, quote(json.dumps(_public_profile(profile))),
                        max_age=COOKIE_MAX_AGE, httponly=False,
                        secure=COOKIE_SECURE, samesite="lax", path="/")


def _clear_session(response: Response):
    for name in (SESSION_COOKIE, PROFILE_COOKIE):
        response.delete_cookie(name, path="/")


def _read_session(request: Request) -> dict:
    raw = request.cookies.get(SESSION_COOKIE)
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {}


async def resolve_from_cookies(cookies: dict) -> tuple:
    """
    Identify a caller from their cookies, refreshing an expired access token if
    the refresh token is still good.

    Returns (profile, rotated_tokens); both are None when there is no valid
    session. Takes a plain cookie dict so WebSocket handshakes — which have
    cookies but no Request — can use the same path as HTTP.
    """
    raw = cookies.get(SESSION_COOKIE)
    if not raw:
        return None, None
    try:
        session = json.loads(raw)
    except Exception:
        return None, None

    access, refresh = session.get("access_token"), session.get("refresh_token")
    if not access:
        return None, None

    rotated = None
    user = await _user_from_token(access)

    if user is None and refresh:
        tokens = await _refresh(refresh)
        if tokens and tokens.get("access_token"):
            user = await _user_from_token(tokens["access_token"])
            if user:
                rotated = tokens

    if not user:
        return None, None

    profile = _get_profile(user["id"])
    if not profile:
        meta = user.get("user_metadata") or {}
        profile = _upsert_profile(
            user["id"],
            meta.get("first_name") or (user.get("email") or "there").split("@")[0],
            meta.get("last_name") or "",
            user.get("email") or "",
        )
    return profile, rotated


async def resolve_user(request: Request) -> Optional[dict]:
    """
    Identify the caller from their session cookie, refreshing an expired access
    token if the refresh token is still good. Returns the profile, or None.

    A rotated token is stashed on request.state so the middleware can write the
    new cookie onto whatever response comes back.
    """
    profile, rotated = await resolve_from_cookies(request.cookies)
    if rotated:
        request.state.rotated_tokens = rotated
    return profile


# ── Route protection ──────────────────────────────────────────────────────────
# Deny by default: anything not listed here needs a session, so a new endpoint
# is protected the day it is written rather than the day someone remembers.
PUBLIC_EXACT = {
    "/health", "/login",
    "/api/auth/signup", "/api/auth/login", "/api/auth/logout",
    "/api/auth/check", "/api/me", "/api/auth/config",
}
PUBLIC_PREFIXES = ("/static/",)
PAGE_ROUTES = {"/"} | {
    a["route"] for a in APPLETS if a.get("file") and not a.get("external")
}


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path

    if path in PUBLIC_EXACT or path.startswith(PUBLIC_PREFIXES):
        return await call_next(request)

    request.state.rotated_tokens = None
    profile = await resolve_user(request)
    request.state.profile = profile

    if profile is None:
        if path in PAGE_ROUTES:
            # Send them to the sign-in screen and back again afterwards.
            return RedirectResponse(f"/login?next={quote(path, safe='')}", status_code=302)
        return JSONResponse({"detail": "Not signed in"}, status_code=401)

    response = await call_next(request)

    rotated = getattr(request.state, "rotated_tokens", None)
    if rotated:
        _set_session(response, rotated, profile)
    return response


def current_profile(request: Request) -> dict:
    """The signed-in user inside a protected endpoint. The middleware guarantees
    this exists — reaching a 401 path without one is impossible."""
    profile = getattr(request.state, "profile", None)
    if not profile:
        raise HTTPException(401, "Not signed in")
    return profile


def require_role(request: Request, *roles: str) -> dict:
    profile = current_profile(request)
    if profile.get("role") not in roles:
        raise HTTPException(403, "You don't have access to that")
    return profile


# ── Auth endpoints ────────────────────────────────────────────────────────────
@app.get("/login")
async def login_page():
    return FileResponse("static/login.html")


@app.get("/api/auth/config")
async def auth_config():
    """Lets the sign-in screen name the domains it will accept."""
    return {"allowed_domains": sorted(ALLOWED_EMAIL_DOMAINS)}


def _check_email_domain(email: str) -> str:
    email = (email or "").strip().lower()
    if "@" not in email:
        raise AuthError("That doesn't look like an email address.")
    domain = email.rsplit("@", 1)[1]
    if ALLOWED_EMAIL_DOMAINS and domain not in ALLOWED_EMAIL_DOMAINS:
        allowed = " or ".join("@" + d for d in sorted(ALLOWED_EMAIL_DOMAINS))
        raise AuthError(f"Use your UCD email ({allowed}) to sign up.", 403)
    return email


@app.post("/api/auth/check")
async def auth_check(request: Request):
    """
    Does this email already have an account?

    The sign-in screen asks before showing a form, so a returning user on a new
    device gets the password field rather than being pushed through signup.
    Guessing from a name left in localStorage cannot work: that name is on one
    device and says nothing about whether an account exists.

    This reveals no more than /api/auth/signup already does — that returns
    "there's already an account with that email" for the same input — and the
    first name it returns is contained in the UCD address that was submitted.
    """
    b = await request.json()
    try:
        email = _check_email_domain(b.get("email"))
    except AuthError as e:
        raise HTTPException(e.status, e.message)

    try:
        r = supabase.table("profiles").select("first_name").ilike("email", email).execute()
        rows = r.data or []
    except Exception as e:
        logger.error(f"[auth] account check failed for {email}: {e}")
        # Fail towards sign-in: a wrong "no account" would send a returning
        # user into signup and dead-end them on "email already registered".
        return {"exists": True, "first_name": None, "uncertain": True}

    return {
        "exists":     bool(rows),
        "first_name": (rows[0].get("first_name") if rows else None),
    }


@app.post("/api/auth/signup")
async def auth_signup(request: Request):
    b = await request.json()
    first = (b.get("first_name") or "").strip()
    last  = (b.get("last_name") or "").strip()
    pw    = b.get("password") or ""

    try:
        email = _check_email_domain(b.get("email"))
        if not first:
            raise AuthError("We need your first name.")
        if len(pw) < 8:
            raise AuthError("Password must be at least 8 characters.")

        created = await _gotrue(
            "POST", "/signup",
            json_body={"email": email, "password": pw,
                       "data": {"first_name": first, "last_name": last}},
            fallback="Could not create that account.")
    except AuthError as e:
        raise HTTPException(e.status, e.message)

    user_id = (created.get("user") or created).get("id")
    if not user_id:
        raise HTTPException(400, "Could not create that account.")

    profile = _upsert_profile(user_id, first, last, email)

    # With email confirmation off, signup returns a session directly. If it is
    # ever switched on, there is no session yet and they must confirm first.
    if not created.get("access_token"):
        return JSONResponse({"ok": True, "needs_confirmation": True,
                             "message": "Check your email to confirm your account."})

    response = JSONResponse({"ok": True, "profile": _public_profile(profile)})
    _set_session(response, created, profile)
    return response


@app.post("/api/auth/login")
async def auth_login(request: Request):
    b = await request.json()
    email = (b.get("email") or "").strip().lower()
    pw    = b.get("password") or ""
    if not email or not pw:
        raise HTTPException(400, "Email and password required")

    try:
        tokens = await _gotrue("POST", "/token?grant_type=password",
                               json_body={"email": email, "password": pw},
                               fallback="That email and password don't match.")
    except AuthError as e:
        raise HTTPException(e.status, e.message)

    user = tokens.get("user") or {}
    profile = _get_profile(user.get("id")) if user.get("id") else None
    if not profile:
        meta = user.get("user_metadata") or {}
        profile = _upsert_profile(
            user["id"],
            meta.get("first_name") or email.split("@")[0],
            meta.get("last_name") or "", email)

    response = JSONResponse({"ok": True, "profile": _public_profile(profile)})
    _set_session(response, tokens, profile)
    return response


@app.post("/api/auth/logout")
async def auth_logout(request: Request):
    session = _read_session(request)
    if session.get("access_token"):
        try:
            await _gotrue("POST", "/logout", token=session["access_token"])
        except AuthError:
            pass          # already invalid server-side; clearing locally is enough
    response = JSONResponse({"ok": True})
    _clear_session(response)
    return response


@app.get("/api/me")
async def api_me(request: Request):
    """Public on purpose: the frontend uses the 401 to decide where to send you."""
    profile = await resolve_user(request)
    if not profile:
        return JSONResponse({"detail": "Not signed in"}, status_code=401)
    return {"profile": _public_profile(profile)}


# ── Supabase helpers ──────────────────────────────────────────────────────────
def upsert_attendance(name: str, target_date: str, status: str,
                      arrival_time: Optional[str],
                      departure_time: Optional[str] = None):
    logger.info(f"Upserting: {name} {target_date} {status} {arrival_time} → {departure_time}")
    result = supabase.table("attendance").upsert({
        "name":           name,
        "date":           target_date,
        "status":         status,
        "time":           arrival_time,
        "departure_time": departure_time,
    }, on_conflict="name,date").execute()
    logger.info(f"Upsert result: {result}")


def get_attendance_for_date(target_date: str) -> list:
    result = supabase.table("attendance") \
        .select("*") \
        .eq("date", target_date) \
        .execute()
    return result.data or []


def log_activity(applet: str, actor: str, verb: str, subject: str = "") -> None:
    """Append one line to the shared activity feed (see migrations/002).

    Deliberately silent on failure. Two reasons, both load-bearing:
      - a feed write must never fail the action it is describing;
      - the table doesn't exist until 002 is applied by hand, and the app has to
        keep working in the gap between deploying this and running the SQL.

    Subjects are stored as text, not as a foreign key, so a line still reads
    correctly after the thing it refers to is renamed or deleted. The feed is a
    record of what happened, not a live view of what exists.
    """
    try:
        supabase.table("activity_log").insert({
            "applet":  applet,
            "actor":   (actor or "Someone").strip(),
            "verb":    verb,
            "subject": (subject or "").strip(),
        }).execute()
    except Exception as e:
        logger.debug(f"[activity] not logged ({applet}/{verb}): {e}")


@app.get("/health")
async def health():
    return {"status": "ok"}


# ── Web UI endpoints ──────────────────────────────────────────────────────────
# Applet pages are registered from APPLETS above. Only the dashboard lives here,
# because it is the one page that isn't an applet.
@app.get("/")
async def index():
    return FileResponse("static/dashboard.html")


# ── PT: single state endpoint (nodes, edges, done, details, sections) ──────────
@app.get("/pt/api/state")
async def pt_state():
    nodes       = supabase.table("pt_nodes").select("*").execute()
    edges       = supabase.table("pt_edges").select("*").execute()
    done        = supabase.table("pt_done").select("node_id").execute()
    in_progress = supabase.table("pt_progress").select("node_id").execute()
    details     = supabase.table("pt_details").select("*").execute()
    sections    = supabase.table("pt_sections").select("*").execute()
    done_log    = supabase.table("pt_done_log").select("node_id,done,user_name,created_at") \
                      .order("created_at").execute()
    return {
        "nodes":       nodes.data or [],
        "edges":       edges.data or [],
        "done":        [r["node_id"] for r in (done.data or [])],
        "in_progress": [r["node_id"] for r in (in_progress.data or [])],
        "details":     {r["node_id"]: r.get("details")
                        for r in (details.data or []) if r.get("details")},
        "sections":    sections.data or [],
        "done_log":    done_log.data or [],
    }


@app.post("/pt/api/toggle")
async def pt_toggle(request: Request):
    b = await request.json()
    node_id   = (b.get("node_id")   or "").strip()
    user_name = (b.get("user_name") or "Unknown").strip()
    if not node_id:
        raise HTTPException(400, "node_id required")
    done = bool(b.get("done"))
    if done:
        supabase.table("pt_done").upsert({"node_id": node_id}).execute()
        supabase.table("pt_progress").delete().eq("node_id", node_id).execute()
    else:
        supabase.table("pt_done").delete().eq("node_id", node_id).execute()
    # Append-only audit log — never overwrite previous entries
    supabase.table("pt_done_log").insert({
        "node_id":   node_id,
        "done":      done,
        "user_name": user_name,
    }).execute()
    return {"ok": True}


@app.post("/pt/api/progress")
async def pt_progress_set(request: Request):
    b = await request.json()
    node_id = (b.get("node_id") or "").strip()
    if not node_id:
        raise HTTPException(400, "node_id required")
    if b.get("in_progress"):
        supabase.table("pt_progress").upsert({"node_id": node_id}).execute()
        supabase.table("pt_done").delete().eq("node_id", node_id).execute()
    else:
        supabase.table("pt_progress").delete().eq("node_id", node_id).execute()
    return {"ok": True}


# ── PT nodes ───────────────────────────────────────────────────────────────────
@app.post("/pt/api/nodes")
async def pt_nodes_add(request: Request):
    b = await request.json()
    label = (b.get("label") or "").strip()
    sec   = (b.get("sec")   or "").strip()
    typ   = (b.get("type")  or "m").strip()
    if not label or not sec:
        raise HTTPException(400, "label and sec required")
    if typ not in ("m", "a", "ms", "g", "c"):
        typ = "m"
    deps = [d for d in (b.get("deps") or []) if isinstance(d, str)]
    node = {
        "id":        "cust_" + uuid.uuid4().hex[:8],
        "label":     label,
        "sec":       sec,
        "type":      typ,
        "x":         b.get("x"),
        "y":         b.get("y"),
        "deps":      deps,
        "is_custom": True,
    }
    supabase.table("pt_nodes").insert(node).execute()
    # persist deps as edges so they survive across sessions
    for dep_id in deps:
        edge_id = f"{dep_id}__{node['id']}"
        supabase.table("pt_edges").upsert(
            {"id": edge_id, "f": dep_id, "t": node["id"], "is_cross": False}
        ).execute()
    return {"node": node}


@app.post("/pt/api/nodes/move")
async def pt_nodes_move(request: Request):
    b = await request.json()
    node_id = (b.get("id") or "").strip()
    if not node_id:
        raise HTTPException(400, "id required")
    supabase.table("pt_nodes").update(
        {"x": b.get("x"), "y": b.get("y")}
    ).eq("id", node_id).execute()
    return {"ok": True}


@app.post("/pt/api/nodes/rename")
async def pt_nodes_rename(request: Request):
    b = await request.json()
    node_id = (b.get("id") or "").strip()
    label   = (b.get("label") or "").strip()
    if not node_id or not label:
        raise HTTPException(400, "id and label required")
    update: dict = {"label": label}
    typ = (b.get("type") or "").strip()
    if typ in ("m", "a", "ms", "c"):
        update["type"] = typ
    supabase.table("pt_nodes").update(update).eq("id", node_id).execute()
    return {"ok": True}


@app.post("/pt/api/nodes/delete")
async def pt_nodes_delete(request: Request):
    b = await request.json()
    node_id = (b.get("id") or "").strip()
    if not node_id:
        raise HTTPException(400, "id required")
    supabase.table("pt_nodes").delete().eq("id", node_id).execute()
    supabase.table("pt_done").delete().eq("node_id", node_id).execute()
    supabase.table("pt_progress").delete().eq("node_id", node_id).execute()
    supabase.table("pt_details").delete().eq("node_id", node_id).execute()
    supabase.table("pt_edges").delete().eq("f", node_id).execute()
    supabase.table("pt_edges").delete().eq("t", node_id).execute()
    return {"ok": True}


# ── PT edges ───────────────────────────────────────────────────────────────────
@app.post("/pt/api/edges/add")
async def pt_edges_add(request: Request):
    b = await request.json()
    f = (b.get("f") or "").strip()
    t = (b.get("t") or "").strip()
    if not f or not t or f == t:
        raise HTTPException(400, "valid f and t required")
    supabase.table("pt_edges").upsert(
        {"id": f"{f}__{t}", "f": f, "t": t, "is_cross": False}
    ).execute()
    return {"ok": True}


@app.post("/pt/api/edges/remove")
async def pt_edges_remove(request: Request):
    b = await request.json()
    f = (b.get("f") or "").strip()
    t = (b.get("t") or "").strip()
    if not f or not t:
        raise HTTPException(400, "f and t required")
    supabase.table("pt_edges").delete().eq("f", f).eq("t", t).execute()
    return {"ok": True}


# ── PT details ─────────────────────────────────────────────────────────────────
@app.post("/pt/api/details")
async def pt_details_set(request: Request):
    b = await request.json()
    nid = (b.get("node_id") or "").strip()
    if not nid:
        raise HTTPException(400, "node_id required")
    text = (b.get("details") or "").strip()
    if text:
        supabase.table("pt_details").upsert({"node_id": nid, "details": text}).execute()
    else:
        supabase.table("pt_details").delete().eq("node_id", nid).execute()
    return {"ok": True}


# ── PT sections ────────────────────────────────────────────────────────────────
@app.post("/pt/api/sections")
async def pt_sections_set(request: Request):
    b = await request.json()
    sec = (b.get("sec") or "").strip()
    if not sec:
        raise HTTPException(400, "sec required")
    supabase.table("pt_sections").upsert(
        {"sec": sec, "w": b.get("w"), "h": b.get("h")}
    ).execute()
    return {"ok": True}


# ── PT live collaboration (presence, cursors, live sync) ────────────────────────
pt_clients: dict = {}  # WebSocket -> {id, name, color} | None

async def _pt_broadcast(payload: dict, exclude: Optional[WebSocket] = None):
    dead = []
    for c in list(pt_clients.keys()):
        if c is exclude:
            continue
        try:
            await c.send_json(payload)
        except Exception:
            dead.append(c)
    for d in dead:
        pt_clients.pop(d, None)

async def _pt_presence():
    users = [m for m in pt_clients.values() if m]
    await _pt_broadcast({"type": "presence", "users": users})

@app.websocket("/pt/ws")
async def pt_ws(ws: WebSocket):
    # HTTP middleware never sees a WebSocket scope, so the session is checked
    # here. Cookies ride along on the handshake, so it is the same check.
    profile, _ = await resolve_from_cookies(ws.cookies)
    if not profile:
        await ws.close(code=1008)      # policy violation
        return
    await ws.accept()
    pt_clients[ws] = None
    try:
        while True:
            data = await ws.receive_json()
            t = data.get("type")
            if t == "join":
                pt_clients[ws] = {
                    "id": data.get("id"), "name": data.get("name"), "color": data.get("color"),
                }
                await _pt_presence()
            else:
                # relay everything else (cursor, toggle, node_add/move/delete, section) to others
                await _pt_broadcast(data, exclude=ws)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        pt_clients.pop(ws, None)
        await _pt_presence()


# ── Wiring Harness Mapper ───────────────────────────────────────────────────────
# Single-document store: the whole harness design (connectors, wires, colour code)
# is persisted as one JSON blob. Requires a table:
#
#   create table if not exists harness_doc (
#     id text primary key,
#     doc jsonb,
#     updated_at timestamptz default now()
#   );
#
# The frontend also keeps a localStorage copy, so it degrades gracefully if the
# table does not exist yet.
HARNESS_DOC_ID = "main"


@app.get("/harness/api/load")
async def harness_load():
    try:
        r = supabase.table("harness_doc").select("doc") \
            .eq("id", HARNESS_DOC_ID).execute()
        doc = r.data[0]["doc"] if r.data else None
    except Exception as e:
        logger.error(f"[harness_load] {e}")
        doc = None
    return {"doc": doc}


@app.post("/harness/api/save")
async def harness_save(request: Request):
    b = await request.json()
    doc = b.get("doc")
    if doc is None:
        raise HTTPException(400, "doc required")
    supabase.table("harness_doc").upsert(
        {"id": HARNESS_DOC_ID, "doc": doc}
    ).execute()
    return {"ok": True}


# ── Harness live collaboration (presence, cursors, live sync) ───────────────────
harness_clients: dict = {}  # WebSocket -> {id, name, color} | None

async def _harness_broadcast(payload: dict, exclude: Optional[WebSocket] = None):
    dead = []
    for c in list(harness_clients.keys()):
        if c is exclude:
            continue
        try:
            await c.send_json(payload)
        except Exception:
            dead.append(c)
    for d in dead:
        harness_clients.pop(d, None)

async def _harness_presence():
    users = [m for m in harness_clients.values() if m]
    await _harness_broadcast({"type": "presence", "users": users})

@app.websocket("/harness/ws")
async def harness_ws(ws: WebSocket):
    # HTTP middleware never sees a WebSocket scope, so the session is checked
    # here. Cookies ride along on the handshake, so it is the same check.
    profile, _ = await resolve_from_cookies(ws.cookies)
    if not profile:
        await ws.close(code=1008)      # policy violation
        return
    await ws.accept()
    harness_clients[ws] = None
    try:
        while True:
            data = await ws.receive_json()
            t = data.get("type")
            if t == "join":
                harness_clients[ws] = {
                    "id": data.get("id"), "name": data.get("name"), "color": data.get("color"),
                }
                await _harness_presence()
            else:
                # relay everything else (cursor + connector/wire/meta sync) to others
                await _harness_broadcast(data, exclude=ws)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        harness_clients.pop(ws, None)
        await _harness_presence()


@app.get("/api/attendance")
async def get_attendance(target_date: Optional[str] = None):
    d = target_date or date.today().isoformat()
    rows = get_attendance_for_date(d)
    return {"date": d, "rows": rows}


@app.post("/api/log")
async def log_web(request: Request):
    import traceback
    body           = await request.json()
    first_name     = (body.get("first_name") or "").strip()
    last_name      = (body.get("last_name")  or "").strip()
    target_date    = (body.get("date")        or "").strip()
    status         = (body.get("status")      or "").strip()
    arrival_time   = body.get("arrival_time")   or None
    departure_time = body.get("departure_time") or None

    if not first_name or not last_name:
        raise HTTPException(status_code=400, detail="first_name and last_name required")
    if not target_date:
        raise HTTPException(status_code=400, detail="date required")
    if status not in ("arriving", "absent"):
        raise HTTPException(status_code=400, detail="status must be 'arriving' or 'absent'")

    name = f"{first_name} {last_name}"
    logger.info(f"[log_web] {name} | {target_date} | {status} | {arrival_time} → {departure_time}")
    try:
        upsert_attendance(name, target_date, status, arrival_time, departure_time)
        if status == "arriving":
            parts = [f"Logged {name} as coming in on {target_date}"]
            if arrival_time:   parts.append(f"arriving {arrival_time}")
            if departure_time: parts.append(f"leaving {departure_time}")
            reply = " · ".join(parts) + "."
        else:
            reply = f"Logged {name} as not coming in on {target_date}."
        return {"reply": reply}
    except Exception as e:
        logger.error(f"[log_web] Error: {e}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/log/delete")
async def delete_log(request: Request):
    body       = await request.json()
    first_name = (body.get("first_name") or "").strip()
    last_name  = (body.get("last_name")  or "").strip()
    target_date = (body.get("date")      or "").strip()
    if not first_name or not last_name or not target_date:
        raise HTTPException(status_code=400, detail="first_name, last_name and date required")
    name = f"{first_name} {last_name}"
    logger.info(f"[delete_log] {name} | {target_date}")
    supabase.table("attendance").delete().eq("name", name).eq("date", target_date).execute()
    return {"reply": f"Entry removed for {name} on {target_date}."}


# ── Competition Hub ───────────────────────────────────────────────────────────
COMP_TZ = ZoneInfo("Europe/London")
SHOP_CUTOFF_HOUR = 10  # requests in before 10am get same-day delivery; after, next day

# One-off: arrival day (Tue 14 Jul) has a later shop run, so the same-day
# cutoff extends to 14:00 instead of the usual 10:00.
SAME_DAY_SPECIAL_DATE        = date(2026, 7, 14)
SAME_DAY_SPECIAL_CUTOFF_HOUR = 14


def _active_cutoff_hour(now: datetime) -> int:
    if now.date() == SAME_DAY_SPECIAL_DATE:
        return SAME_DAY_SPECIAL_CUTOFF_HOUR
    return SHOP_CUTOFF_HOUR


def compute_shop_date(now: Optional[datetime] = None) -> str:
    """Requests in before the cutoff get same-day delivery; after, they push to
    the next day. SAME_DAY_SPECIAL_DATE gets an extended cutoff (see above)."""
    now = (now or datetime.now(COMP_TZ)).astimezone(COMP_TZ)
    days_ahead = 0 if now.hour < _active_cutoff_hour(now) else 1
    return (now.date() + timedelta(days=days_ahead)).isoformat()


@app.get("/comp/api/users")
async def comp_users():
    r = supabase.table("attendance").select("name").execute()
    names = sorted(set(row["name"] for row in (r.data or []) if row.get("name")))
    return {"users": names}

def _is_comp_admin(request: Request, password: Optional[str]) -> bool:
    """Committee/admin accounts get in on their role; everyone else still needs
    the shared password. Once roles are assigned, drop the password half."""
    profile = getattr(request.state, "profile", None) or {}
    if profile.get("role") in ("committee", "admin"):
        return True
    # Fail closed when no shared password is configured, rather than letting an
    # empty submission match an empty setting.
    if not COMP_ADMIN_PW:
        return False
    return password == COMP_ADMIN_PW


def _require_comp_admin(request: Request, password: Optional[str]):
    if not _is_comp_admin(request, password):
        raise HTTPException(403, "Wrong password")


@app.post("/comp/api/admin/verify")
async def comp_admin_verify(request: Request):
    b = await request.json()
    _require_comp_admin(request, b.get("password"))
    return {"ok": True, "by_role": (getattr(request.state, "profile", None) or {}).get("role") in ("committee", "admin")}

@app.get("/comp/api/roster")
async def comp_roster_get():
    r = supabase.table("comp_roster").select("*").execute()
    return {"roster": r.data or []}

@app.post("/comp/api/roster")
async def comp_roster_add(request: Request):
    b = await request.json()
    _require_comp_admin(request, b.get("password"))
    day  = b.get("day","").strip().lower()
    role = b.get("role","").strip()
    name = b.get("name","").strip()
    if not all([day, role, name]):
        raise HTTPException(400, "day, role, name required")
    supabase.table("comp_roster").upsert(
        {"day": day, "role": role, "person_name": name},
        on_conflict="day,role,person_name"
    ).execute()
    return {"ok": True}

@app.post("/comp/api/roster/delete")
async def comp_roster_delete(request: Request):
    b = await request.json()
    _require_comp_admin(request, b.get("password"))
    supabase.table("comp_roster").delete().eq("id", b["id"]).execute()
    return {"ok": True}

@app.get("/comp/api/requests")
async def comp_requests_get():
    r = supabase.table("comp_requests").select("*").order("created_at").execute()
    return {"requests": r.data or []}

def _parse_quantity(raw) -> int:
    try:
        qty = int(raw)
    except (TypeError, ValueError):
        return 1
    return qty if qty > 0 else 1


@app.post("/comp/api/requests")
async def comp_requests_add(request: Request):
    b = await request.json()
    name = b.get("name","").strip()
    item = b.get("item","").strip()
    if not name or not item:
        raise HTTPException(400, "name and item required")
    split = [s.strip() for s in (b.get("split_with") or []) if s.strip()]
    shop_date = compute_shop_date()
    qty = _parse_quantity(b.get("quantity"))
    supabase.table("comp_requests").insert({
        "requester": name, "item": item,
        "split_with": split, "status": "pending",
        "shop_date": shop_date, "quantity": qty,
    }).execute()
    log_activity("comp", name, "requested", f"{qty}× {item}" if qty > 1 else item)
    return {"ok": True, "shop_date": shop_date}


def _get_own_pending_request(req_id, name: str) -> dict:
    """Look up a request and confirm the caller owns it and it's still pending."""
    r = supabase.table("comp_requests").select("*").eq("id", req_id).execute()
    if not r.data:
        raise HTTPException(404, "Request not found")
    row = r.data[0]
    if row["requester"] != name:
        raise HTTPException(403, "You can only edit or remove your own requests")
    if row["status"] != "pending":
        raise HTTPException(400, "Already bought — can't change it now")
    return row


@app.post("/comp/api/requests/edit")
async def comp_requests_edit(request: Request):
    b = await request.json()
    name = (b.get("name") or "").strip()
    item = (b.get("item") or "").strip()
    if not name or not item:
        raise HTTPException(400, "name and item required")
    _get_own_pending_request(b.get("id"), name)
    split = [s.strip() for s in (b.get("split_with") or []) if s.strip()]
    supabase.table("comp_requests").update(
        {"item": item, "split_with": split, "quantity": _parse_quantity(b.get("quantity"))}
    ).eq("id", b["id"]).execute()
    return {"ok": True}


@app.post("/comp/api/requests/delete")
async def comp_requests_delete(request: Request):
    b = await request.json()
    name = (b.get("name") or "").strip()
    req_id = b.get("id")

    if not name:
        raise HTTPException(400, "name required")

    _get_own_pending_request(req_id, name)
    supabase.table("comp_requests").delete().eq("id", req_id).execute()
    return {"ok": True}

@app.post("/comp/api/requests/update")
async def comp_requests_update(request: Request):
    b = await request.json()
    update = {k: b[k] for k in ("price", "status", "bought_by") if k in b}
    if not update:
        raise HTTPException(400, "nothing to update")
    supabase.table("comp_requests").update(update).eq("id", b["id"]).execute()
    # Only a status change is feed-worthy. Price edits and re-assignments happen
    # repeatedly on the same request and would drown everything else out.
    if update.get("status") == "bought":
        row = (supabase.table("comp_requests").select("item,requester")
               .eq("id", b["id"]).execute().data or [{}])[0]
        log_activity("comp", update.get("bought_by") or "Someone",
                     "bought", row.get("item") or "")
    return {"ok": True}

@app.get("/comp/api/shop-cutoff")
async def comp_shop_cutoff():
    now = datetime.now(COMP_TZ)
    cutoff_hour = _active_cutoff_hour(now)
    target = compute_shop_date(now)
    return {
        "cutoff_hour": cutoff_hour,
        "now_iso": now.isoformat(),
        "target_shop_date": target,
        "is_same_day": target == now.date().isoformat(),
        "is_extended_cutoff": now.date() == SAME_DAY_SPECIAL_DATE,
    }


@app.get("/comp/api/runner")
async def comp_runner_get():
    r = supabase.table("comp_meta").select("value").eq("key", "runner").execute()
    val = r.data[0]["value"] if r.data else ""
    return {"runner": val or None}

@app.post("/comp/api/runner")
async def comp_runner_set(request: Request):
    b = await request.json()
    supabase.table("comp_meta").upsert(
        {"key": "runner", "value": (b.get("name") or "").strip()}
    ).execute()
    return {"ok": True}


# ── Schedule Events ────────────────────────────────────────────────────────────
@app.get("/comp/api/schedule/events")
async def schedule_events_get():
    r = supabase.table("schedule_events").select("*").order("day").order("sort_order").execute()
    return {"events": r.data or []}


@app.post("/comp/api/schedule/events")
async def schedule_events_add(request: Request):
    b = await request.json()
    _require_comp_admin(request, b.get("password"))
    day = (b.get("day") or "").strip()
    time = (b.get("time") or "").strip()
    name = (b.get("name") or "").strip()
    location = (b.get("location") or "").strip()
    if not all([day, time, name, location]):
        raise HTTPException(400, "day, time, name, location required")
    is_ucdfs = bool(b.get("is_ucdfs", False))
    sort_order = int(b.get("sort_order", 0))
    supabase.table("schedule_events").insert({
        "day": day, "time": time, "name": name, "location": location,
        "is_ucdfs": is_ucdfs, "sort_order": sort_order,
    }).execute()
    return {"ok": True}


@app.post("/comp/api/schedule/events/{event_id}")
async def schedule_events_update(event_id: int, request: Request):
    b = await request.json()
    _require_comp_admin(request, b.get("password"))
    update = {}
    for k in ("day", "time", "name", "location", "is_ucdfs", "sort_order"):
        if k in b:
            update[k] = b[k]
    if not update:
        raise HTTPException(400, "nothing to update")
    supabase.table("schedule_events").update(update).eq("id", event_id).execute()
    return {"ok": True}


@app.post("/comp/api/schedule/events/{event_id}/delete")
async def schedule_events_delete(event_id: int, request: Request):
    b = await request.json()
    _require_comp_admin(request, b.get("password"))
    supabase.table("schedule_events").delete().eq("id", event_id).execute()
    return {"ok": True}

# ── GBP→EUR rate (cached) ──────────────────────────────────────────────────────
_fx_cache: dict = {}

async def get_gbp_eur() -> float:
    import time
    if _fx_cache.get("expires_at", 0) > time.time():
        return _fx_cache["rate"]
    try:
        async with httpx.AsyncClient(timeout=8, follow_redirects=True) as client:
            r = await client.get("https://api.frankfurter.dev/v1/latest?base=GBP&symbols=EUR")
            r.raise_for_status()
            rate = float(r.json()["rates"]["EUR"])
            _fx_cache["rate"]       = rate
            _fx_cache["expires_at"] = time.time() + 6 * 3600
            return rate
    except Exception as e:
        logger.error(f"[fx] rate fetch failed: {e}")
        return _fx_cache.get("rate", 1.17)  # fallback


@app.get("/comp/api/expenses")
async def comp_expenses():
    rate = await get_gbp_eur()
    r = supabase.table("comp_requests").select("*").eq("status", "bought").execute()
    totals: dict = {}
    breakdown: dict = {}
    debts: dict = {}  # (debtor, creditor) -> gbp
    for row in (r.data or []):
        if row.get("price") is None:
            continue
        price  = float(row["price"])
        buyer  = row.get("bought_by")
        people = [row["requester"]] + list(row.get("split_with") or [])
        share  = round(price / len(people), 2)
        for p in people:
            totals[p] = round(totals.get(p, 0.0) + share, 2)
            breakdown.setdefault(p, []).append({
                "item": row["item"], "share": share, "shared": len(people) > 1,
            })
            if buyer and p != buyer:
                key = (p, buyer)
                debts[key] = round(debts.get(key, 0.0) + share, 2)
    expenses = [
        {"name": k, "total": totals[k], "items": breakdown[k]}
        for k in sorted(totals)
    ]
    debt_list = [
        {"debtor": d, "creditor": c, "gbp": amt, "eur": round(amt * rate, 2)}
        for (d, c), amt in sorted(debts.items())
    ]
    return {"rate": rate, "expenses": expenses, "debts": debt_list}


# ── Dashboard summary ─────────────────────────────────────────────────────────
# One call that fills every status tile on the homepage, keyed by applet id.
# Each tile is computed independently: a missing table or a failing query
# degrades that one tile to null rather than blanking the whole dashboard.
def _tile(fn):
    try:
        return fn()
    except Exception as e:
        logger.error(f"[dashboard] tile failed: {e}")
        return None


def _hm(t) -> Optional[str]:
    """Attendance times are wall-clock strings; Postgres hands them back as
    '09:00:00' but the <input type=time> that wrote them sent '09:00'. Trim to
    HH:MM so both shapes compare as plain zero-padded strings."""
    if not t:
        return None
    s = str(t).strip()
    return s[:5] if len(s) >= 5 else None


def _attendance_tile() -> dict:
    now      = datetime.now(TEAM_TZ)
    rows     = get_attendance_for_date(now.date().isoformat())
    arriving = [r for r in rows if r.get("status") == "arriving"]
    now_hm   = now.strftime("%H:%M")

    # In *now*, not merely in at some point today. Someone who logged no
    # departure time counts as still here: we genuinely don't know when they
    # leave, and wrongly showing a present person as gone is the worse error —
    # the whole point of this is answering "is anyone in the workshop?".
    here = []
    for r in arriving:
        arr = _hm(r.get("time"))
        dep = _hm(r.get("departure_time"))
        if arr and arr <= now_hm and (dep is None or now_hm < dep):
            here.append({"name": (r.get("name") or "").strip(), "until": dep})
    here.sort(key=lambda p: p["name"])

    # The last of them out — "until 17:00" means the workshop empties then.
    until = max([p["until"] for p in here if p["until"]], default=None)

    if here:
        detail = f"{len(here)} in now" + (f" · until {until}" if until else "")
    elif arriving:
        detail = f"{len(arriving)} in today"
    else:
        detail = "nobody logged in yet"

    return {
        "in":     len(arriving),
        "logged": len(rows),
        "now":    len(here),
        "here":   here,
        "until":  until,
        "detail": detail,
    }


def _pt_tile() -> dict:
    nodes = supabase.table("pt_nodes").select("id").execute().data or []
    done  = supabase.table("pt_done").select("node_id").execute().data or []
    prog  = supabase.table("pt_progress").select("node_id").execute().data or []
    total = len(nodes)
    pct   = round(100 * len(done) / total) if total else 0
    return {
        "done":        len(done),
        "total":       total,
        "in_progress": len(prog),
        "pct":         pct,
        "detail":      f"{pct}% done · {len(prog)} in progress" if total else "no tasks yet",
    }


def _harness_tile() -> dict:
    r = supabase.table("harness_doc").select("updated_at") \
        .eq("id", HARNESS_DOC_ID).execute()
    if not r.data:
        return {"updated_at": None, "detail": "not started"}
    ts = r.data[0].get("updated_at")
    return {"updated_at": ts, "detail": "last edited " + _ago(ts) if ts else "saved"}


def _comp_tile() -> dict:
    reqs   = supabase.table("comp_requests").select("status").execute().data or []
    events = supabase.table("schedule_events").select("id").execute().data or []
    pending = len([r for r in reqs if r.get("status") == "pending"])
    if pending:
        detail = f"{pending} request{'s' if pending != 1 else ''} pending"
    elif events:
        detail = f"{len(events)} events scheduled"
    else:
        detail = "nothing pending"
    return {"pending": pending, "events": len(events), "detail": detail}


def _ago(ts: str) -> str:
    """Rough relative time from an ISO timestamp, for tile subtitles."""
    try:
        then = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        secs = (datetime.now(then.tzinfo) - then).total_seconds()
    except Exception:
        return "recently"
    for limit, div, unit in ((3600, 60, "min"), (86400, 3600, "hr"), (2592000, 86400, "day")):
        if secs < limit:
            n = max(1, int(secs // div))
            return f"{n} {unit}{'s' if n != 1 else ''} ago"
    return "a while ago"


def _countdown() -> dict:
    """Days to the competition, plus the next season milestone behind it.

    Reads the season calendar at the top of this file and nothing else."""
    today = datetime.now(TEAM_TZ).date()
    days  = (FSUK_DATE - today).days

    upcoming = sorted((d, label) for label, d in SEASON_MILESTONES if d >= today)
    nxt = None
    if upcoming:
        d, label = upcoming[0]
        nxt = {"label": label, "date": d.isoformat(), "days": (d - today).days}

    return {
        "name":        FSUK_NAME,
        "date":        FSUK_DATE.isoformat(),
        "days":        days,
        # A past date means the calendar above needs updating, so say so rather
        # than counting down into negative numbers.
        "state":       "future" if days > 0 else ("today" if days == 0 else "past"),
        "provisional": FSUK_PROVISIONAL,
        "next":        nxt,
    }


# ── Activity feed ─────────────────────────────────────────────────────────────
# Two sources on purpose:
#
#   pt_done_log   the PT plan's own append-only audit log, which predates this
#                 feed and is still what pt.html reads. It is already exactly
#                 the right shape, so the feed adapts it rather than making the
#                 PT plan write every tick twice.
#   activity_log  the general table (migrations/002) that every *other* applet
#                 writes to via log_activity().
#
# Merging the two means the feed has history from day one and keeps working
# before 002 is applied. Attendance is deliberately not in here — twenty people
# logging a day each morning would bury everything else, and "who's in now"
# already covers it.
def _ts_key(ts) -> float:
    """Sort key for a feed row. Unparseable or missing timestamps sort oldest
    rather than blowing up the whole feed."""
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def _pt_activity(limit: int) -> list:
    rows = supabase.table("pt_done_log").select("node_id,done,user_name,created_at") \
        .order("created_at", desc=True).limit(limit).execute().data or []
    if not rows:
        return []
    labels = {n["id"]: n.get("label") for n in
              (supabase.table("pt_nodes").select("id,label").execute().data or [])}
    return [{
        "applet":     "pt",
        "actor":      r.get("user_name") or "Someone",
        "verb":       "ticked off" if r.get("done") else "un-ticked",
        # Falls back to the raw id for a node that has since been deleted.
        "subject":    labels.get(r.get("node_id")) or r.get("node_id") or "",
        "created_at": r.get("created_at"),
    } for r in rows]


def _general_activity(limit: int) -> list:
    rows = supabase.table("activity_log").select("applet,actor,verb,subject,created_at") \
        .order("created_at", desc=True).limit(limit).execute().data or []
    return [dict(r) for r in rows]


def _activity(limit: int = 8) -> list:
    items = []
    for source in (_pt_activity, _general_activity):
        try:
            items += source(limit)
        except Exception as e:
            # One dead source degrades to a shorter feed, never to no feed.
            logger.info(f"[activity] {source.__name__} unavailable: {e}")
    items.sort(key=lambda i: _ts_key(i.get("created_at")), reverse=True)
    for i in items:
        i["ago"] = _ago(i.get("created_at")) if i.get("created_at") else ""
    return items[:limit]


@app.get("/api/dashboard")
async def api_dashboard():
    return {
        # Dublin, not the container's clock — which is UTC, so date.today()
        # here would report yesterday between midnight and 1am in summer,
        # disagreeing with the day the tiles below are actually describing.
        "date":      datetime.now(TEAM_TZ).date().isoformat(),
        "countdown": _tile(_countdown),
        "activity":  _tile(_activity) or [],
        "tiles": {
            "attendance": _tile(_attendance_tile),
            "pt":         _tile(_pt_tile),
            "harness":    _tile(_harness_tile),
            "comp":       _tile(_comp_tile),
        },
    }

