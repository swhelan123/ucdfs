import os
import re
import asyncio
import threading
import json
import time
import uuid
import base64
import binascii
import logging
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
from typing import Optional
from urllib.parse import quote, urlparse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from fastapi import FastAPI, Request, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
import httpx
from supabase import create_client, Client
from concurrent.futures import ThreadPoolExecutor

# ── Config ────────────────────────────────────────────────────────────────────
SUPABASE_URL  = os.environ["SUPABASE_URL"]
SUPABASE_KEY  = os.environ["SUPABASE_KEY"]
# The service_role key bypasses RLS. Once migrations/001_auth_and_rls.sql PART 2
# has run, this is the ONLY key that can reach the data. The anon key is exactly
# what RLS is there to shut out. It must never be sent to a browser.
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

if not SUPABASE_SERVICE_KEY:
    logger.warning(
        "SUPABASE_SERVICE_KEY is not set, falling back to the anon key. "
        "This works only while RLS is still disabled. Set it before running "
        "PART 2 of the migration, or every query will start returning nothing."
    )

# Everything the backend does server-side goes through the service key.
supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY or SUPABASE_KEY)

# ── One Supabase connection per tile worker ─────────────────────────────────
# The client above wraps a single HTTP/2 connection, and it is not something
# several threads can drive at once. Doing that made the server hang up mid
# request:
#
#   [dashboard] tile failed: <ConnectionTerminated error_code:1, last_stream_id:9>
#   [auth] profile lookup failed: [Errno 104] Connection reset by peer
#
# The second line is why this matters more than one slow page. Losing the
# connection broke whatever else was using it, including authentication on
# unrelated requests, so a user was refused as a non-admin because a dashboard
# tile was being read at the same moment.
#
# So a thread that runs tiles gets a connection of its own and shares nothing.
# Building one costs about 16ms and _tile_pool is bounded, so at most
# _TILE_WORKERS of them are ever built, once each, and reused after that.
#
# Deliberately opt-in rather than "a client per thread". uvicorn runs sync
# endpoints in a threadpool of its own, and quietly giving all forty of those
# threads their own client is a much larger change than this one. `own` is set
# by _tile and nowhere else, so every other caller keeps the global exactly as
# before, on the main thread and off it.
_tile_local = threading.local()

_TILE_WORKERS = 8
_tile_pool = ThreadPoolExecutor(max_workers=_TILE_WORKERS, thread_name_prefix="tile")


def sb() -> Client:
    """The Supabase client this caller should use.

    The global one, unless the caller is a tile worker, which gets its own.
    """
    if not getattr(_tile_local, "own", False):
        return supabase
    client = getattr(_tile_local, "client", None)
    if client is None:
        client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY or SUPABASE_KEY)
        _tile_local.client = client
    return client

# ── Uploads ───────────────────────────────────────────────────────────────────
# Profile photos live on this server's disk, not in Supabase Storage. They are
# small, few, and only ever read by us. A bucket would add a second storage
# system, a second set of credentials and a second thing to back up, to hold a
# few megabytes we already have a machine for.
#
# Two rules this path has to satisfy, both learned from the shape of the deploy:
#   - it is NOT under static/. Dockerfile COPYs static/ into the image, so a
#     photo written there is wiped by the next rebuild and, worse, served by
#     StaticFiles to anyone who guesses the URL. Avatars go out through
#     /media/avatars/… instead, which sits behind the auth middleware.
#   - it is a mounted volume (see docker-compose.yml). Anything written inside
#     the container and not mounted out dies with the container.
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/app/uploads")
AVATAR_DIR = os.path.join(UPLOAD_DIR, "avatars")
try:
    os.makedirs(AVATAR_DIR, exist_ok=True)
except OSError as e:
    # Non-fatal on purpose: the whole site should not fail to boot because the
    # photo directory is unwritable. Uploads 503 and everything else works.
    logger.warning(f"[uploads] {AVATAR_DIR} is not writable: {e}. Photo upload will fail")

# Photos are resized in the browser before upload (see profiles.html), so this
# is a backstop against a crafted request, not the normal path.
MAX_AVATAR_BYTES = 2 * 1024 * 1024

# ── Auth config ───────────────────────────────────────────────────────────────
# Self-signup is restricted to UCD addresses; nobody who finds the URL can join.
ALLOWED_EMAIL_DOMAINS = {
    d.strip().lower()
    for d in os.environ.get("ALLOWED_EMAIL_DOMAINS", "ucdconnect.ie,ucd.ie").split(",")
    if d.strip()
}

GOTRUE = f"{SUPABASE_URL}/auth/v1"

# Two cookies, doing different jobs:
#   SESSION_COOKIE: httpOnly, holds the tokens. The actual credential. JS can
#                    never read it, so an XSS bug cannot exfiltrate the session.
#   PROFILE_COOKIE: readable by JS, holds display name + role only. Lets
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
# UTC. COMP_TZ further down is Europe/London on purpose. That one is about
# where the competition physically is, not where we are.
TEAM_TZ = ZoneInfo("Europe/Dublin")

FSUK_NAME = "FSUK 2027"
# PROVISIONAL. IMechE had not published the 2027 dates when this was written;
# this follows the 2026 pattern (arrival was Tue 14 Jul 2026, see
# SAME_DAY_SPECIAL_DATE). Change it the day they announce. A countdown the team
# finds out is wrong is worse than no countdown, so the dashboard says
# "provisional" out loud until this flag flips.
FSUK_DATE        = date(2027, 7, 13)
FSUK_PROVISIONAL = True

# (label, date): design freeze, manufacturing deadline, first test day, …
# Empty is fine: the countdown then just shows the competition on its own.
SEASON_MILESTONES: list[tuple[str, date]] = []

app = FastAPI()

app.mount("/static", StaticFiles(directory="static"), name="static")


# ── Subteams ──────────────────────────────────────────────────────────────────
# The team's three halves-of-a-whole. One list, read by the applet registry, the
# dashboard filter, the first-sign-in picker and the profiles directory, so the
# names and colours can never drift between them.
#
# These are RELEVANCE, not permission. An Operations member must still be able
# to open the PT plan. It just should not be the first thing they see. Anything
# that needs actually gating uses a role (see require_role); if the two ever get
# conflated we will lock someone out of something they need at 2am before a
# deadline. Keep them separate.
#
# A person's subteam may be null ("not sure yet"), which is a supported state
# during September recruitment and not a gap to be filled in.
SUBTEAMS = [
    # The id stays "pt" now that the division is called Electrical, and that is
    # deliberate rather than an oversight. The id is written into data: every
    # profiles.subteam on this division, the subteams_extra arrays beside them,
    # the registry tags below, activity_log.applet and the plans/pt_* tables.
    # Renaming it means a migration over all of that to change something no
    # member can see. Same split the override banner already makes: "god mode"
    # in the code and the schema, "Admin override" on screen.
    {"id": "pt",   "name": "Electrical", "icon": "🏎️", "accent": "teal"},
    {"id": "mech", "name": "Mechanical", "icon": "⚙️", "accent": "green"},
    {"id": "ops",  "name": "Operations", "icon": "📋", "accent": "purple"},
]

SUBTEAM_IDS = {s["id"] for s in SUBTEAMS}
SUBTEAMS_BY_ID = {s["id"]: s for s in SUBTEAMS}


def _clean_subteam(value) -> Optional[str]:
    """A subteam id, or None. Anything unrecognised becomes None rather than an
    error. A stale value from an old client should degrade to "not set", not
    reject the whole save."""
    v = (value or "").strip().lower()
    return v if v in SUBTEAM_IDS else None


@app.get("/api/subteams")
async def api_subteams():
    """The vocabulary, so no page has to hardcode the three names."""
    return {"subteams": SUBTEAMS}


# ── Applet registry ───────────────────────────────────────────────────────────
# Every page this site serves. It generates the page routes AND feeds
# /api/applets, which the dashboard renders. Adding an applet is one entry here
# plus one file in static/, and the dashboard needs no edit.
#
# It is no longer the whole dashboard. Hyperlink cards are rows in `links`
# (migrations/010), added and ordered from /admin at runtime. The split is not
# "internal vs external" for tidiness: an entry here carries a "file" and the
# loop below turns it into a route, so a card naming a page the image does not
# contain is a 404 tile and adding one is a deploy whatever any admin screen
# claims. A hyperlink generates nothing and is pure content. Only the second
# kind can honestly be data. See _links().
#
#   status:   "live"  is working, full brightness on the dashboard
#             "quiet" is real but dormant (off-season); dimmed, still clickable
#             "soon"  is a placeholder card, not clickable
#   accent:   a colour token from shared.css (indigo/purple/green/amber/teal/red)
#   subteams: who this is most relevant to. Ids from SUBTEAMS above, or ["all"].
#             Drives the dashboard filter chips and nothing else. Omitting it
#             means "all", so an entry that forgets the field stays visible to
#             everyone rather than quietly disappearing for most of the team.
#   requires_role: the PERMISSION field. A role name; the page route 403s and
#             /api/applets omits the entry for anyone without it. God mode
#             satisfies it. Omitting it means everyone, which is the right
#             default, since gating is the exception and should be written down.
#
# subteams and requires_role are not the same kind of thing and must never be
# conflated: one is what you'd rather see first, the other is what you may open.
# ── Flowcharts ────────────────────────────────────────────────────────────────
# There is no registry of charts. They are rows in `plans` (migrations/007), made
# and named from /flowcharts, and pt.html draws whichever one its URL names. That
# was the whole point of 005 → 006 → 007: a subteam that wants a build plan makes
# one, instead of asking for a deploy.
#
# The safety property the old PLANS dict provided is kept, only moved. A plan id
# reaches supabase.table() filters, so it is still checked before use, against
# this table now. Ids are minted here (`chart_…`), never accepted from a caller,
# so nobody can name a row into existence by asking for it.
LEGACY_PLAN = "pt"      # what an omitted plan means; see _plan_or_400
MAX_LIVE_PLANS = 60     # a bound on a create button, not a considered limit

# The dashboard's build-plan tile follows one chart: whichever the team is
# actually building right now. Point it at the new one at season rollover. A
# chart that has since been deleted just nulls the tile rather than 500ing the
# whole dashboard, which is what _tile() is for.
DASHBOARD_PLAN = "pt"


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
        "subteams": ["all"],
    },
    {
        "id":     "profiles",
        "name":   "Team Profiles",
        "icon":   "🧑‍🔧",
        "route":  "/profiles",
        "file":   "profiles.html",
        "blurb":  "Who's who, and who to ask about what",
        "accent": "red",
        "status": "live",
        "subteams": ["all"],
    },
    {
        "id":     "flowcharts",
        "name":   "Flowcharts",
        "icon":   "🗺️",
        "route":  "/flowcharts",
        "file":   "flowcharts.html",
        "blurb":  "Build plans and dependency charts: pick one or start a new one",
        "accent": "teal",
        "status": "live",
        # Tagged for everyone, not just Powertrain. It used to be the PT plan
        # and nothing else; now it is the tool any subteam draws a plan in.
        "subteams": ["all"],
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
        "subteams": ["ops"],
    },
    {
        "id":     "admin",
        "name":   "Admin",
        "icon":   "🔑",
        "route":  "/admin",
        "file":   "admin.html",
        "blurb":  "Roles, permissions and god mode",
        "accent": "red",
        "status": "live",
        "subteams": ["all"],
        # The only gated entry. Everyone else never sees the card at all,
        # /api/applets omits it rather than showing a tile that 403s.
        "requires_role": "admin",
    },
    # ── Archive ───────────────────────────────────────────────────────────
    # Finished or superseded, not broken. People still look things up in these,
    # so they get their own block at the foot of the dashboard rather than
    # being deleted or left competing for attention with what is in use now.
    # Last season's Mech plan is in this block too, as a row in `links`.
    {
        "id":     "harness",
        "name":   "Wiring Harness Mapper",
        "icon":   "🔌",
        "route":  "/harness",
        "file":   "harness.html",
        # The blurb carries the reason it is dimmed. A quiet card with no
        # explanation reads as broken, and this one is neither broken nor
        # off-season: HarnessHive does the job now.
        "blurb":  "Superseded by HarnessHive: connectors, pinouts and wire runs",
        "accent": "amber",
        "status": "quiet",
        "subteams": ["pt"],
        "group":  "archive",
    },
    {
        "id":     "pt",
        "name":   "PT Manufacturing Plan",
        "icon":   "🏎️",
        # No "file": the page is served by the /plan/{plan_id} route, which is
        # the only way in now that charts are rows rather than registry entries.
        "route":  "/plan/pt",
        "blurb":  "Last season's powertrain build, 25/26",
        "accent": "teal",
        "status": "quiet",
        "subteams": ["pt"],
        "group":  "archive",
        # Which chart this card opens, so the feed can badge its ticks.
        "plan":   "pt",
    },
]

# plan id → the applet that opens it, so a feed line from a charted plan can
# carry that card's icon. Anything else badges as the flowcharts tool, which is
# where it was drawn. See _pt_activity.
APPLET_BY_PLAN = {a["plan"]: a["id"] for a in APPLETS if a.get("plan")}

# Dashboard blocks, in order, with the heading each one gets. An entry with no
# "group" is a tool; the dashboard renders a block only if something is in it,
# so retiring the last archived card removes the heading with it rather than
# leaving "Last season" over an empty space.
# ── Dashboard blocks  (migrations/011) ────────────────────────────────────────
#
# The headings the dashboard is divided into, in order. Rows, not a list, for
# the same reason links are: what the site is *divided into* is a decision about
# how the team thinks about its own tools, and that changes more often than the
# code does.
#
# This list is the fallback, not the source. It is what _groups() answers with
# when the table is missing, and it carries the ids 011 seeds so a site running
# ahead of its migration still draws every card under a sensible heading rather
# than collapsing six blocks into one unlabelled grid.
#
# "apps" first is load-bearing: it is the block a card with no group of its own
# falls into, and the dashboard renders the first block into its existing grid
# without a heading of its own. Reordering the table changes which block that is.
DEFAULT_GROUPS = [
    {"id": "apps",        "label": "Apps",        "sort": 10},
    {"id": "electronics", "label": "Electronics", "sort": 20},
    {"id": "design",      "label": "Design",      "sort": 30},
    {"id": "documents",   "label": "Documents",   "sort": 40},
    {"id": "reference",   "label": "Reference",   "sort": 50},
    {"id": "archive",     "label": "Archive",     "sort": 60},
]

MAX_GROUPS      = 12   # a bound on an add button, not a considered limit
MAX_GROUP_LABEL = 24   # a heading, not a sentence


def _group_rows() -> list:
    """Every block, in dashboard order, or [] if 011 has not been applied."""
    try:
        r = (supabase.table("dashboard_groups").select("*")
             .order("sort").order("id").execute())
        return r.data or []
    except Exception as e:
        logger.error(f"[groups] could not read blocks (is 011 applied?): {e}")
        return []


def _groups() -> list:
    """The blocks the dashboard draws, always at least one.

    Falls back to DEFAULT_GROUPS when the table is missing *or empty*. Empty
    matters as much as missing: every card carries a group id, and with no
    blocks at all there is nowhere for any of them to render. A dashboard with
    no cards on it is indistinguishable from one that failed to load, so the
    honest failure is to draw the built-in headings and let somebody notice the
    admin screen disagrees.
    """
    rows = _group_rows()
    if not rows:
        return [dict(g) for g in DEFAULT_GROUPS]
    return [{"id": g["id"], "label": g.get("label") or g["id"],
             "sort": g.get("sort") or 0} for g in rows]


def _group_ids() -> set:
    return {g["id"] for g in _groups()}


def _first_group() -> str:
    """Where a card with no group of its own lands. Never empty; see _groups()."""
    return _groups()[0]["id"]


# ══════════════════════════════════════════════════════════════════════════════
#  Hyperlink cards  (migrations/010)
#
#  The dashboard's off-site shortcuts: the VCU repo, Onshape, SharePoint,
#  HarnessHive, FS Stats, FSWiki, r/FSAE, last season's Canva plan. They were
#  registry entries until seven of them had accumulated, each one a deploy to
#  add a name and a url, and each one therefore something only a person with a
#  checkout could do. Now they are rows, added and ordered from /admin.
#
#  Everything below exists because a row here is less trustworthy than a line of
#  Python. The registry is reviewed in a pull request; this table is typed into
#  a form by whoever is on committee this year. So each field is checked against
#  the same vocabulary the registry uses, in one place, on the way in:
#
#    url       http/https only. This is rendered straight into an href, and a
#              stored "javascript:" url is a script that runs on every
#              dashboard in the team, every time anyone opens the site. This is
#              the check that matters; the rest are tidiness.
#    accent    a shared.css token, or the card renders with a broken variable.
#    group     a dashboard_groups id, or the card lands in a block that is never
#              drawn and is invisible with no error anywhere.
#    subteams  SUBTEAM_IDS or "all". Relevance, never permission. An empty list
#              reads as "all" rather than hiding the card from everybody, which
#              is the same call the registry makes for a missing field.
#    status    live or quiet. Deliberately no "soon": a placeholder you cannot
#              click describes a tool being built, not a hyperlink, which either
#              exists or does not.
#
#  There is no requires_role here. Gating a link would be theatre: the url is in
#  the page for anyone who can see the card, and the thing it points at does its
#  own authorization. Anything that genuinely needs gating is a page, and pages
#  are registry entries.
# ══════════════════════════════════════════════════════════════════════════════

MAX_LINKS       = 40    # a bound on an add button, not a considered limit
MAX_LINK_NAME   = 40
MAX_LINK_ICON   = 8     # an emoji plus its variation selector, not a sentence
MAX_LINK_BLURB  = 90
MAX_LINK_URL    = 2000

LINK_ACCENTS  = {"indigo", "purple", "green", "amber", "teal", "red"}
LINK_STATUSES = {"live", "quiet"}
LINK_SCHEMES  = ("http", "https")


def _clean_link_url(value) -> str:
    """A url safe to put in an href, or a 400.

    The scheme check is the whole point of this function. Everything a card
    renders is escaped, but escaping does nothing about the *protocol*: an
    href of "javascript:fetch(...)" is escaped perfectly and still runs. A
    whitelist of two schemes is the only form of this check that stays correct
    as browsers add new ones.
    """
    raw = (value or "").strip()
    if not raw:
        raise HTTPException(400, "A link needs a web address")
    if len(raw) > MAX_LINK_URL:
        raise HTTPException(400, "That web address is too long")
    parsed = urlparse(raw)
    if parsed.scheme.lower() not in LINK_SCHEMES or not parsed.netloc:
        raise HTTPException(400, "Links must start with http:// or https://")
    return raw


def _clean_link_subteams(value) -> list:
    """Subteam ids, or ["all"]. Unknown ids are dropped, not rejected.

    Same call as _clean_subteam: a stale id from an old client should degrade,
    and dropping the lot back to "all" keeps the card visible rather than
    hiding it from everyone, which is the failure nobody notices.
    """
    if not isinstance(value, list):
        return ["all"]
    ids = [str(v).strip().lower() for v in value]
    if "all" in ids:
        return ["all"]
    keep = [i for i in ids if i in SUBTEAM_IDS]
    # De-duplicated but order-preserving, so the admin screen reads back what
    # was ticked rather than a re-sorted version of it.
    seen, out = set(), []
    for i in keep:
        if i not in seen:
            seen.add(i)
            out.append(i)
    return out or ["all"]


def _clean_link(body: dict) -> dict:
    """Validate one link's fields into the columns of `links`.

    Returns everything except id, created_at and created_by, which the caller
    owns: an id from a request body is how a caller names a row into existence.
    """
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "A link needs a name")
    if len(name) > MAX_LINK_NAME:
        raise HTTPException(400, f"Keep the name under {MAX_LINK_NAME} characters")

    blurb = (body.get("blurb") or "").strip()
    if len(blurb) > MAX_LINK_BLURB:
        raise HTTPException(400, f"Keep the description under {MAX_LINK_BLURB} characters")

    icon = (body.get("icon") or "").strip()[:MAX_LINK_ICON] or "🔗"

    accent = (body.get("accent") or "").strip().lower()
    status = (body.get("status") or "").strip().lower()
    group  = (body.get("group") or "").strip()

    return {
        "name":     name,
        "icon":     icon,
        "url":      _clean_link_url(body.get("url")),
        "blurb":    blurb,
        # Unrecognised values fall back rather than 400ing. These three come
        # from selects the server itself populated, so a bad one is a stale tab
        # rather than a typo, and losing the colour is a better outcome than
        # losing the edit.
        "accent":   accent if accent in LINK_ACCENTS else "indigo",
        "status":   status if status in LINK_STATUSES else "live",
        "group_id": group if group in _group_ids() else _first_group(),
        "subteams": _clean_link_subteams(body.get("subteams")),
    }


def _link_rows() -> list:
    """Every link row, in dashboard order.

    Returns [] when the table is missing, so a site running ahead of its
    migrations loses its shortcut cards rather than its dashboard. That is the
    same call _favourites_for and the activity feed make, and it is why 010 has
    to be applied before this code ships: the gap is degraded, not broken, but
    it is still a gap. See "Migrations" in CLAUDE.md.
    """
    try:
        r = (supabase.table("links").select("*")
             .order("group_id").order("sort").order("id").execute())
        return r.data or []
    except Exception as e:
        logger.error(f"[links] could not read links (is 010 applied?): {e}")
        return []


def _link_card(row: dict) -> dict:
    """One row, in the shape the dashboard already knows how to draw.

    The point of this function is that the dashboard learns nothing. A link is
    an applet-shaped dict with external set, so appletCard() renders it, the
    subteam chips filter it and the star pins it without a line of new
    front-end code.
    """
    return {
        "id":       row["id"],
        "name":     row.get("name") or row["id"],
        "icon":     row.get("icon") or "🔗",
        # "route", not "url": the dashboard reads route for every card, and
        # renaming it here would be a second shape for it to handle.
        "route":    row.get("url") or "",
        "blurb":    row.get("blurb") or "",
        "accent":   row.get("accent") or "indigo",
        "status":   row.get("status") or "live",
        "subteams": list(row.get("subteams") or ["all"]),
        "group":    row.get("group_id") or "tools",
        "external": True,
    }


def _cards() -> list:
    """Everything the dashboard could draw: applets first, then links.

    Applets before links within each block, deliberately. The team's own tools
    are what somebody opens this page to reach; the outbound shortcuts are
    reference. It also means the order of the registry keeps meaning what it
    says without every entry needing a sort column to defend its position.
    """
    return list(APPLETS) + [_link_card(r) for r in _link_rows()]


def _plan_row(pid: str) -> Optional[dict]:
    """One chart, or None. The whitelist lookup. See _plan_or_400."""
    if not pid:
        return None
    try:
        r = supabase.table("plans").select("*").eq("id", pid).limit(1).execute()
        return (r.data or [None])[0]
    except Exception as e:
        # 007 unapplied, or the database is down. Either way the honest answer
        # is "cannot say", and the caller turns that into a 400 rather than
        # letting an unchecked id reach a table filter.
        logger.error(f"[_plan_row] {e}")
        return None


def _plan_or_400(value) -> str:
    """Resolve a request's chart id, or refuse.

    Missing means the legacy chart. Every pre-multi-plan client (and curl
    muscle memory) says nothing and must keep meaning "pt". Unknown is a hard
    400: the id is only ever used as a filter value, but accepting one that
    names no chart would write rows no page can ever show.

    This reads the database on every plan-scoped write, which is one indexed
    primary-key lookup. Deliberately not cached: a stale whitelist is a bug
    that presents as "the chart I just made does not exist", and the traffic
    here is a handful of people dragging boxes around.
    """
    pid = (value or LEGACY_PLAN).strip()
    if not _plan_row(pid):
        raise HTTPException(400, "unknown chart")
    return pid


def _may_open(applet: dict, profile: Optional[dict]) -> bool:
    """Does this person satisfy the entry's requires_role? God mode always does.

    One function, used by both the page route and /api/applets, so a gated
    applet cannot end up visible on the dashboard but closed on click, or,
    worse, the other way round.
    """
    needed = applet.get("requires_role")
    if not needed:
        return True
    return god_on(profile) or (profile or {}).get("role") == needed


def _page_route(filename: str, applet: dict):
    """Build a handler that serves one static page (closure over the filename)."""
    async def _serve(request: Request):
        if not _may_open(applet, getattr(request.state, "profile", None)):
            raise HTTPException(403, "You don't have access to that")
        return FileResponse(f"static/{filename}")
    return _serve


# Every applet with a file gets a route. There is no "and not external" here
# any more: an off-site card is a row in `links` and never reaches this list, so
# the only thing an entry without a file can be is a card pointing at a route
# that something else defines, like the pt plan pointing at /plan/pt.
for _applet in APPLETS:
    if _applet.get("file"):
        app.add_api_route(
            _applet["route"], _page_route(_applet["file"], _applet), methods=["GET"]
        )


# The one way into a chart. Charts are rows, so there is no registry entry to
# generate a route from. This is a single dynamic route serving the same canvas
# for every chart.
@app.get("/plan/{plan_id}")
async def plan_page(plan_id: str):
    if not _plan_row(plan_id):
        # A 404 rather than the canvas: a chart that has been deleted, or a
        # database that has not had 007 applied yet, should say so here instead
        # of loading an editor that 400s on its first request.
        raise HTTPException(404, "No such chart")
    return FileResponse("static/pt.html")


# The address the legacy chart was bookmarked at, before charts had ids worth
# putting in a URL. It delegates rather than serving the file itself, so the two
# cannot drift into answering differently for the same missing chart.
@app.get("/pt")
async def pt_page_legacy():
    return await plan_page(LEGACY_PLAN)


MAX_FAVOURITES = 12   # a bound on a star button, not a considered limit


def _favourites_for(profile: Optional[dict], cards: Optional[list] = None) -> list:
    """Which cards this person has starred, as ids the dashboard can match.

    Filtered against what currently exists on the way out as well as on the way
    in, so a card that has since been retired quietly stops being a favourite
    rather than leaving a gap where a tile used to be. That now covers deleted
    links as well as retired applets, which is why deleting a link needs no
    cleanup pass over everybody's favourites: the hole closes itself the next
    time each person loads the dashboard.

    Missing table (008 not applied yet) reads as "no favourites", never as an
    error. This is a convenience on a page that has to render regardless.

    `cards` is passed in by callers that already have the list, so asking for
    the dashboard does not read `links` twice.
    """
    if not profile:
        return []
    known = {c["id"] for c in (cards if cards is not None else _cards())}
    stored = _get_details(profile["id"]).get("favourites") or []
    return [f for f in stored if f in known]


@app.get("/api/applets")
async def api_applets(request: Request):
    """What the dashboard renders. Public fields only, no file paths.

    Entries you may not open are omitted rather than dimmed: a tile that exists
    only to refuse you is worse than no tile.
    """
    profile = getattr(request.state, "profile", None)
    cards   = _cards()
    return {
        "applets": [
            # "group" rides along so the dashboard can lay out its blocks
            # without knowing which cards belong where. Applets and links are
            # already one shape by here, so the dashboard cannot tell which of
            # them came from code and does not need to.
            {k: v for k, v in a.items() if k != "file"}
            for a in cards if _may_open(a, profile)
        ],
        "groups": _groups(),
        # Sent with the cards rather than fetched separately: the dashboard
        # paints once, and a favourites list that arrived afterwards would
        # reorder the grid under the cursor.
        "favourites": _favourites_for(profile, cards),
    }


# ══════════════════════════════════════════════════════════════════════════════
#  Auth
#
#  The browser never speaks to Supabase. It posts credentials here; this process
#  calls GoTrue and hands back an httpOnly cookie. The anon key stays server-side
#  and the session cannot be read by any script on the page.
#
#  Deliberately not using supabase.auth.*. That client keeps the signed-in
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
        return "There's already an account with that email. Sign in instead."
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


async def _gotrue_admin(method: str, path: str, *, fallback: str = "Auth failed") -> dict:
    """The GoTrue *admin* API, which is a different credential to _gotrue().

    Everything above sends the anon key and, where there is one, the caller's own
    token. It acts as the user. This acts as the project, so it needs the
    service key, and the anon key would simply 401. Kept separate rather than
    bolted on as a flag so nothing reaches an /admin/ path by accident.
    """
    if not SUPABASE_SERVICE_KEY:
        raise AuthError("The server has no service key, so accounts can't be deleted here.", 503)
    headers = {"apikey": SUPABASE_SERVICE_KEY,
               "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
               "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.request(method, f"{GOTRUE}{path}", headers=headers)
    if r.status_code >= 400:
        try:
            payload = r.json()
        except Exception:
            payload = {}
        logger.error(f"[auth] admin {method} {path} → {r.status_code} {payload}")
        raise AuthError(_friendly_auth_error(payload, fallback), 503)
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


def _cache_forget_user(uid: str) -> None:
    """Drop every cached token belonging to one user.

    Only deleting an account needs this. GoTrue stops honouring their tokens the
    moment the user is gone, but this process would keep serving them from the
    cache for up to TOKEN_CACHE_TTL, so a deleted account could still load
    pages for a minute afterwards, which reads as "the delete didn't work"."""
    for token, (user, _) in list(_token_cache.items()):
        if (user or {}).get("id") == uid:
            _token_cache.pop(token, None)


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
    person with working credentials, no profile, and a 500, unable to sign up
    again because the email is taken. resolve_from_cookies() rebuilds a missing
    profile on the next request, so degrading quietly is genuinely recoverable.
    """
    row = {"id": user_id, "first_name": first, "last_name": last, "email": email}
    try:
        supabase.table("profiles").upsert(row).execute()
    except Exception as e:
        logger.error(
            f"[auth] could not write profile for {email}: {e}. "
            "if this says 'row-level security', SUPABASE_SERVICE_KEY is missing."
        )
    return {**row, "role": "member"}


def _public_profile(profile: dict, photo: Optional[str] = None) -> dict:
    """What the browser is allowed to know about the signed-in user.

    subteam and photo ride along so the dashboard can default its filter chips
    and draw your face without a round trip. UCDFS.user() has to stay
    synchronous. That is safe precisely because neither grants anything: they
    are presentational, and the server never reads them back off the cookie.
    Never put anything here that is checked.
    """
    first = (profile.get("first_name") or "").strip()
    last  = (profile.get("last_name") or "").strip()
    return {
        "first": first,
        "last":  last,
        "name":  (first + " " + last).strip(),
        "email": profile.get("email") or "",
        "role":  profile.get("role") or "member",
        "subteam": profile.get("subteam") or None,
        "photo": photo,
        # Display only, so the banner can say "god mode is on" without a fetch.
        # Every actual gate reads the database row, never this.
        "god_mode": bool(profile.get("god_mode")),
    }


# ── Cookies ───────────────────────────────────────────────────────────────────
def _set_session(response: Response, tokens: dict, profile: dict):
    session = json.dumps({
        "access_token":  tokens.get("access_token"),
        "refresh_token": tokens.get("refresh_token"),
    })
    response.set_cookie(SESSION_COOKIE, session, max_age=COOKIE_MAX_AGE,
                        httponly=True, secure=COOKIE_SECURE, samesite="lax", path="/")
    _set_profile_cookie(response, profile)


def _set_profile_cookie(response: Response, profile: dict):
    """Readable by JS on purpose: display only, never an authorization input.

    Split out from _set_session because editing your profile changes what this
    holds (your subteam, your photo) without touching the session. Rewriting it
    there and then is what stops the dashboard filter defaulting to a subteam
    you left ten seconds ago, or the header pill showing the photo you just
    replaced.

    The detail lookup costs one query, on sign-in and on save, not on every
    request, which is the whole reason this lives in a cookie at all.
    """
    photo = _avatar_url(profile.get("id"), _get_details(profile.get("id") or ""))
    # safe="" matters: the photo URL contains "/", which is NOT a legal raw
    # cookie character, so leaving it unencoded makes Starlette wrap the whole
    # value in double quotes. JSON.parse then reads that as a *string* rather
    # than an object, UCDFS.user() returns null, and the browser decides you are
    # signed out the moment you upload a photo. Encode everything.
    response.set_cookie(PROFILE_COOKIE,
                        quote(json.dumps(_public_profile(profile, photo)), safe=""),
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
    session. Takes a plain cookie dict so WebSocket handshakes (which have
    cookies but no Request) can use the same path as HTTP.
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
# "/" is the dashboard and "/pt" is the legacy chart alias. Both are listed by
# hand because neither is generated from APPLETS: the dashboard is not an applet,
# and the `pt` card deliberately has no "file". It points at /plan/pt, which the
# dynamic chart route serves. Miss one and that page answers a signed-out browser
# with JSON instead of sending it to sign in.
PAGE_ROUTES = {"/", "/pt"} | {
    a["route"] for a in APPLETS if a.get("file")
}
# Charts are rows, so their pages cannot be enumerated up front the way applet
# routes can. Anything under here is a page: signed out it redirects to the
# sign-in screen and comes back, rather than answering a bookmarked chart URL
# with a bare 401 the browser renders as JSON.
PAGE_PREFIXES = ("/plan/",)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path

    if path in PUBLIC_EXACT or path.startswith(PUBLIC_PREFIXES):
        return await call_next(request)

    request.state.rotated_tokens = None
    profile = await resolve_user(request)
    request.state.profile = profile

    if profile is None:
        if path in PAGE_ROUTES or path.startswith(PAGE_PREFIXES):
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
    this exists. Reaching a 401 path without one is impossible."""
    profile = getattr(request.state, "profile", None)
    if not profile:
        raise HTTPException(401, "Not signed in")
    return profile


def _me_name(request: Request) -> str:
    """The caller's own name, spelled the way the older tables spell names.

    attendance, comp_roster, comp_requests and pt_done_log all key people by
    typed-in full name because they predate accounts (see _photo_map). Anything
    that used to take that name from the request body takes it from here
    instead, so the name a write is attributed to is the name of whoever is
    signed in.

    Every page already sends exactly this. That is the point: the pages were
    never the problem, the endpoints were, and believing the body is how you get
    an audit log that records whoever the caller felt like naming.
    """
    return " ".join(_public_profile(current_profile(request)).get("name", "").split())


def _same_person(a: str, b: str) -> bool:
    """Case-folded, whitespace-collapsed name comparison. Same rule as
    _require_own_row: rows typed by hand before accounts existed spell people
    inconsistently, and "shane whelan" is "Shane  Whelan"."""
    return " ".join((a or "").split()).lower() == " ".join((b or "").split()).lower()


# ── God mode ──────────────────────────────────────────────────────────────────
# role == 'admin' is the capability: who is *allowed* to be elevated. god_mode is
# whether they currently *are*. See migrations/004 for why they are two things.
#
# Both are read from the profiles row the middleware already loaded, never from
# the cookie. The cookie carries god_mode too, but only so the UI can draw the
# banner. It is display, exactly like role, and the server never reads it back.

def is_admin(profile: Optional[dict]) -> bool:
    """Allowed to switch god mode on. Not the same as having it on."""
    return bool(profile) and profile.get("role") == "admin"


def god_on(profile: Optional[dict]) -> bool:
    """Currently elevated. This is what every gate should ask."""
    return is_admin(profile) and bool(profile.get("god_mode"))


def is_god(request: Request) -> bool:
    return god_on(getattr(request.state, "profile", None))


def require_role(request: Request, *roles: str) -> dict:
    """Gate an endpoint on role. God mode satisfies any requirement.

    An admin with god mode *off* deliberately does not pass. That is the point
    of the switch, and it is what lets an admin check what an ordinary member
    actually sees rather than guessing.
    """
    profile = current_profile(request)
    if god_on(profile) or profile.get("role") in roles:
        return profile
    raise HTTPException(403, "You don't have access to that")


def require_admin(request: Request) -> dict:
    """For the god-mode switch itself, which asks for the *capability*.

    Never gate this on god_on(): an admin who switched themselves off would have
    no way back in short of editing the database by hand.
    """
    profile = current_profile(request)
    if not is_admin(profile):
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

    This reveals no more than /api/auth/signup already does, which returns
    "there's already an account with that email" for the same input, and the
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
    photo = _avatar_url(profile.get("id"), _get_details(profile.get("id") or ""))
    return {"profile": _public_profile(profile, photo)}


# ══════════════════════════════════════════════════════════════════════════════
#  Admin  (migrations/004)
#
#  Two jobs: switching god mode on and off, and handing out roles. The second is
#  what lets COMP_ADMIN_PASSWORD stay dead. Promoting the committee used to
#  mean an UPDATE in the SQL editor, which is why nobody did it and everyone
#  kept typing the shared password instead.
# ══════════════════════════════════════════════════════════════════════════════

ASSIGNABLE_ROLES = ["member", "committee", "admin"]


@app.post("/api/admin/god-mode")
async def api_god_mode(request: Request):
    """Flip your own elevation.

    Gated on require_admin, NOT on god mode: an admin who switched themselves
    off has to be able to switch back on. Nobody can grant themselves the
    capability here. Only the role does that, and only another admin (or 004)
    can hand that out.
    """
    me = require_admin(request)
    b  = await request.json()
    on = bool(b.get("on"))

    try:
        supabase.table("profiles").update({"god_mode": on}).eq("id", me["id"]).execute()
    except Exception as e:
        logger.error(f"[admin] god mode toggle failed for {me['id']}: {e}")
        raise HTTPException(503, "Couldn't switch that. Has migration 004 been applied?")

    fresh = _get_profile(me["id"]) or {**me, "god_mode": on}
    response = JSONResponse({"ok": True, "god_mode": on,
                             "profile": _public_profile(fresh)})
    # The banner reads the cookie, so it has to move with the state.
    _set_profile_cookie(response, fresh)
    return response


@app.get("/api/admin/people")
async def api_admin_people(request: Request):
    """Everyone, with their role. Admin-only: this is the permission list."""
    require_role(request, "admin")
    try:
        rows = supabase.table("profiles").select(
            "id,first_name,last_name,email,role,god_mode,subteam").execute().data or []
    except Exception as e:
        logger.error(f"[admin] people query failed: {e}")
        raise HTTPException(503, "Couldn't load the team.")

    rows.sort(key=lambda r: (ASSIGNABLE_ROLES.index(r.get("role"))
                             if r.get("role") in ASSIGNABLE_ROLES else 9,
                             (r.get("first_name") or "").lower()))
    me = current_profile(request)
    return {
        "people": [{
            "id":    r.get("id"),
            "name":  ((r.get("first_name") or "") + " " + (r.get("last_name") or "")).strip(),
            "email": r.get("email") or "",
            "role":  r.get("role") or "member",
            "god_mode": bool(r.get("god_mode")),
            "is_me": r.get("id") == me.get("id"),
        } for r in rows],
        "roles": ASSIGNABLE_ROLES,
        "me": me.get("id"),
    }


@app.post("/api/admin/role")
async def api_admin_role(request: Request):
    """Set someone's role.

    The one guard that matters: you cannot remove the last admin. Locking every
    admin out of the app is unrecoverable from inside it. The way back is
    editing the database by hand, at which point the tool has failed.
    """
    me = require_role(request, "admin")
    b  = await request.json()
    target = (b.get("id") or "").strip()
    role   = (b.get("role") or "").strip()

    if role not in ASSIGNABLE_ROLES:
        raise HTTPException(400, "Not a role.")
    if not target:
        raise HTTPException(400, "Which person?")

    victim = _get_profile(target)
    if not victim:
        raise HTTPException(404, "No such account.")

    if victim.get("role") == "admin" and role != "admin":
        try:
            admins = supabase.table("profiles").select("id").eq("role", "admin").execute().data or []
        except Exception as e:
            logger.error(f"[admin] admin count failed: {e}")
            raise HTTPException(503, "Couldn't check that safely. Nothing changed.")
        if len(admins) <= 1:
            raise HTTPException(400, "That's the last admin. Promote someone else first.")

    updates = {"role": role}
    # Losing the capability has to take the elevation with it, or a demoted
    # admin keeps a god_mode flag that silently switches back on if they are
    # ever re-promoted.
    if role != "admin":
        updates["god_mode"] = False

    try:
        supabase.table("profiles").update(updates).eq("id", target).execute()
    except Exception as e:
        logger.error(f"[admin] role change failed for {target}: {e}")
        raise HTTPException(503, "Couldn't save that. Has migration 004 been applied?")

    name = ((victim.get("first_name") or "") + " " + (victim.get("last_name") or "")).strip()
    log_activity("admin", _public_profile(me).get("name"), "made", f"{name} {role}")

    response = JSONResponse({"ok": True})
    # Changing your own role changes what your own banner should say.
    if target == me.get("id"):
        _set_profile_cookie(response, _get_profile(target) or me)
    return response


# ── Deleting an account ───────────────────────────────────────────────────────
# The case this exists for: somebody signs up as @ucd.ie when the team is on
# @ucdconnect.ie, or fat-fingers the address, and there is now a second account
# for one person that nothing can merge. Demoting it doesn't help. It still
# sits in the directory, in the people list and in every name-keyed lookup.
#
# It goes through GoTrue rather than the profiles table, and that ordering is
# the whole trick: profiles.id is `references auth.users(id) on delete cascade`
# (migrations/000), and profile_details and profile_prompts cascade off profiles
# in turn, so removing the auth user takes all three with it. Deleting the
# profiles row on its own would leave the login intact, and auth_login()
# re-creates a missing profile from the token's metadata, so the account would
# walk back in at the next sign-in looking brand new.
#
# What deliberately survives: attendance rows, feed lines and pt_done_log
# entries. Those are keyed by the name that was typed, not by an account, and
# they record what happened rather than who exists, the same rule that keeps
# activity subjects as text. The feed's own delete below is how you tidy those.

@app.post("/api/admin/user/delete")
async def api_admin_delete_user(request: Request):
    """Erase an account: the login, the profile, the details, the photo.

    Three rails, because nothing inside the app can undo this:

      - **The override has to be on.** Every other cross-user write already asks
        for it, and this is the most destructive one on the site, an admin
        reading the people list with it off cannot delete anybody by mis-clicking.
      - **You cannot delete yourself.** It would erase the account holding the
        session making the request, and if you were the last admin nobody could
        ever reach /admin again.
      - **An admin must be demoted first.** Deleting an admin outright is one
        keystroke away from locking the team out, and the demotion path already
        refuses to remove the last one.

    On top of those the caller has to echo back the exact email address, so a
    stale id from a list rendered before somebody else changed something cannot
    delete the wrong person.
    """
    me = require_role(request, "admin")
    if not is_god(request):
        raise HTTPException(403, "Turn on admin override to delete an account")

    b       = await request.json()
    target  = (b.get("id") or "").strip()
    confirm = (b.get("confirm_email") or "").strip().lower()

    if not target:
        raise HTTPException(400, "Which person?")
    if target == me.get("id"):
        raise HTTPException(400, "You can't delete your own account. Ask another admin.")

    victim = _get_profile(target)
    if not victim:
        raise HTTPException(404, "No such account.")
    if victim.get("role") == "admin":
        raise HTTPException(400, "Demote them to member first. An admin can't be deleted outright.")

    email = (victim.get("email") or "").strip().lower()
    if confirm != email:
        raise HTTPException(400, "That email doesn't match the account you're deleting.")

    # Read the photo's extension before the row that records it cascades away,
    # afterwards nothing on this machine knows the file on disk is theirs.
    ext = (_get_details(target) or {}).get("photo_ext") or ""

    try:
        await _gotrue_admin("DELETE", f"/admin/users/{target}",
                            fallback="Couldn't delete that account.")
    except AuthError as e:
        # Nothing has been touched yet at this point, which is why the auth user
        # goes first: a failure here leaves the account exactly as it was.
        raise HTTPException(e.status, e.message)

    _cache_forget_user(target)

    # The cascade is schema, not something this file can see, so check rather
    # than assume, since an environment built before 000 could have the column
    # without the constraint, and a profile left behind is a ghost account that
    # still shows in the directory with no way to sign in.
    if _get_profile(target):
        try:
            supabase.table("profiles").delete().eq("id", target).execute()
        except Exception as e:
            logger.error(f"[admin] profile row survived deletion of {target}: {e}")
            raise HTTPException(503, "The login is gone but the profile isn't. Check the database.")

    if ext:
        try:
            os.remove(os.path.join(AVATAR_DIR, f"{target}.{ext}"))
        except OSError:
            pass        # already gone is the state we wanted anyway

    name = ((victim.get("first_name") or "") + " " + (victim.get("last_name") or "")).strip()
    # Logged by name, not by id: the id is about to mean nothing, and the point
    # of the line is that somebody can see this happened.
    log_activity("admin", _public_profile(me).get("name"), "deleted the account of",
                 name or email)

    return {"ok": True, "deleted": {"id": target, "name": name, "email": email}}


# ── Tidying the activity feed ─────────────────────────────────────────────────
# The feed is append-only in normal use (see migrations/002) and stays that way:
# this is the exception, for a line that is wrong, noisy, or names somebody who
# has just been deleted. A dict rather than an if/else because the source name
# reaches supabase.table(), so an unknown value has to be a 400 by construction,
# never "whatever the client sent".
FEED_SOURCES = {"activity_log": "id", "pt_done_log": "id"}


@app.post("/api/admin/activity/delete")
async def api_admin_activity_delete(request: Request):
    """Remove one line from the dashboard feed.

    Deleting a `pt_done_log` line removes the *record* of a tick, not the tick:
    pt_done is a separate table and the build plan is untouched. That is the
    intent: this tidies the feed, it does not edit the plan through the back
    door.

    Not itself logged to activity_log. A line saying a line was deleted is noise
    in the one place you were trying to clear, and it would be the top of the
    feed every time.
    """
    require_role(request, "admin")
    if not is_god(request):
        raise HTTPException(403, "Turn on admin override to delete feed entries")

    b      = await request.json()
    source = (b.get("source") or "").strip()
    if source not in FEED_SOURCES:
        raise HTTPException(400, "Not a feed source.")
    try:
        row_id = int(b.get("id"))
    except (TypeError, ValueError):
        raise HTTPException(400, "Which entry?")

    try:
        supabase.table(source).delete().eq(FEED_SOURCES[source], row_id).execute()
    except Exception as e:
        logger.error(f"[admin] feed delete failed for {source}#{row_id}: {e}")
        raise HTTPException(503, "Couldn't delete that entry.")

    return {"ok": True}


# ── Hyperlink cards, from /admin ──────────────────────────────────────────────
#
# Gated on the admin role and NOT on the override. /api/admin/* is gated because
# it reaches somebody else's data; this reaches the shape of a shared page, the
# same kind of thing as making a chart or a section, and neither of those is
# gated at all. The role is the line: adding a card everyone sees is a committee
# decision, but it is not the kind of thing that needs the seatbelt you put on
# before editing a person's profile. Demanding the override here would mean
# elevating to fix a typo in a url, and an admin who is elevated all day is the
# problem god mode exists to solve.


def _links_available() -> bool:
    """Has 010 been applied? Distinguishes "no links" from "no table"."""
    try:
        supabase.table("links").select("id").limit(1).execute()
        return True
    except Exception:
        return False


@app.get("/api/admin/links")
async def api_admin_links(request: Request):
    """The link rows, plus the vocabularies the editor renders itself from.

    Sent together so the admin page never hardcodes the accent names, the group
    ids or the subteam list. Those three exist once, at the top of this file,
    and drift the moment a second copy is written down.
    """
    require_role(request, "admin")
    return {
        "links":    _link_rows(),
        "groups":   _groups(),
        "subteams": SUBTEAMS,
        "accents":  sorted(LINK_ACCENTS),
        "statuses": sorted(LINK_STATUSES),
        "limits":   {"links": MAX_LINKS, "name": MAX_LINK_NAME,
                     "blurb": MAX_LINK_BLURB, "url": MAX_LINK_URL},
        # So the page can say "apply migration 010" rather than showing an empty
        # list that looks like a table with nothing in it.
        "ready":    _links_available(),
    }


@app.post("/api/admin/links")
async def api_admin_link_save(request: Request):
    """Create a link, or edit one. An id in the body means edit.

    The id is never taken from the body on create. It is minted here (link_…),
    like chart_… and sec_…, for the same reason: a caller who can choose the
    primary key can name a row into existence, and can also collide with an
    applet id and quietly shadow a real page on the dashboard.
    """
    me   = require_role(request, "admin")
    b    = await request.json()
    lid  = (b.get("id") or "").strip()
    row  = _clean_link(b)
    rows = _link_rows()
    who  = _public_profile(me).get("name")

    def _end_of(group_id: str, exclude: str = "") -> int:
        """The next sort value in a block. Spaced by ten to match the seed, so a
        card can later be dropped between two others without renumbering."""
        peers = [r for r in rows
                 if r.get("group_id") == group_id and r["id"] != exclude]
        return (max([r.get("sort") or 0 for r in peers]) + 10) if peers else 10

    if lid:
        existing = next((r for r in rows if r["id"] == lid), None)
        if not existing:
            raise HTTPException(404, "That link no longer exists")
        row["id"] = lid
        # Moving a card to another block has to give it a position in that
        # block. Left alone it keeps the sort it had in the old one and lands
        # somewhere arbitrary in the middle of its new neighbours, which reads
        # as the block being unordered rather than as this card being new to it.
        if (existing.get("group_id") or "tools") != row["group_id"]:
            row["sort"] = _end_of(row["group_id"], exclude=lid)
        verb = "edited the link"
    else:
        if len(rows) >= MAX_LINKS:
            raise HTTPException(400, f"That's the most links you can have ({MAX_LINKS})")
        row["id"]         = "link_" + uuid.uuid4().hex[:8]
        row["created_by"] = who
        row["sort"]       = _end_of(row["group_id"])
        verb = "added the link"

    try:
        supabase.table("links").upsert(row).execute()
    except Exception as e:
        logger.error(f"[admin] link save failed for {row['id']}: {e}")
        raise HTTPException(503, "Couldn't save that. Has migration 010 been applied?")

    log_activity("admin", who, verb, row["name"])
    return {"ok": True, "link": row}


@app.post("/api/admin/links/delete")
async def api_admin_link_delete(request: Request):
    """Remove one link. The caller has to echo the name back.

    The same rail as deleting an account or a chart, for the same reason rather
    than because the stakes match: the admin screen renders a list, somebody
    reorders or renames a card in another tab, and the id under the button you
    are about to press is no longer the card you are looking at. Echoing the
    name is what makes a stale list fail safely.

    Nothing cleans this id out of anyone's favourites, deliberately.
    _favourites_for filters against what exists on the way out, so the star
    disappears on its own at the next dashboard load. A sweep over
    profile_details would be a write to every account on the team to achieve
    what a filter already does.
    """
    me = require_role(request, "admin")
    b  = await request.json()
    lid = (b.get("id") or "").strip()

    row = next((r for r in _link_rows() if r["id"] == lid), None)
    if not row:
        raise HTTPException(404, "That link no longer exists")

    typed = (b.get("name") or "").strip()
    if typed != (row.get("name") or ""):
        raise HTTPException(400, "Type the link's name exactly to delete it")

    try:
        supabase.table("links").delete().eq("id", lid).execute()
    except Exception as e:
        logger.error(f"[admin] link delete failed for {lid}: {e}")
        raise HTTPException(503, "Couldn't delete that link.")

    log_activity("admin", _public_profile(me).get("name"), "removed the link", row.get("name") or lid)
    return {"ok": True}


@app.post("/api/admin/links/reorder")
async def api_admin_links_reorder(request: Request):
    """Rewrite the order of one block's links. Takes the ids, in the order wanted.

    Scoped to a single group because that is the only order the dashboard shows.
    Ids that are not in that block are ignored rather than moved into it: a
    reorder is a reorder, and a request that also relocates a card would be two
    actions wearing one name.
    """
    me    = require_role(request, "admin")
    b     = await request.json()
    group = (b.get("group") or "").strip()
    if group not in _group_ids():
        raise HTTPException(400, "Not a dashboard block")

    ids   = [str(i).strip() for i in (b.get("ids") or [])]
    mine  = {r["id"] for r in _link_rows() if r.get("group_id") == group}
    # dict.fromkeys de-duplicates while keeping order. Comparing lengths alone
    # would let ["a", "a"] stand in for {"a", "b"}: same count, and "b" keeps
    # whatever sort it had, interleaved with the new numbers.
    order = [i for i in dict.fromkeys(ids) if i in mine]
    if set(order) != mine:
        # A partial list would silently leave the omitted cards on their old
        # sort values, in an order nobody chose.
        raise HTTPException(400, "That list is out of date. Reload and try again.")

    try:
        for position, lid in enumerate(order, start=1):
            supabase.table("links").update({"sort": position * 10}).eq("id", lid).execute()
    except Exception as e:
        logger.error(f"[admin] link reorder failed for {group}: {e}")
        raise HTTPException(503, "Couldn't save that order.")

    log_activity("admin", _public_profile(me).get("name"), "reordered the links in", group)
    return {"ok": True, "ids": order}


# ── Dashboard blocks, from /admin ─────────────────────────────────────────────
#
# Same gate and the same reasoning as links: the admin role, not the override.
# A block is a heading over a grid, which is the shape of a shared page rather
# than anybody's data.


def _groups_available() -> bool:
    """Has 011 been applied? Distinguishes "the built-in blocks" from "the ones
    somebody set up", which the admin screen has to be able to say out loud:
    editing a block that is really a hardcoded fallback would look like it
    worked and change nothing."""
    try:
        supabase.table("dashboard_groups").select("id").limit(1).execute()
        return True
    except Exception:
        return False


def _cards_by_group() -> dict:
    """How many cards sit in each block, applets and links together.

    Mirrors appletGroup() in dashboard.html exactly, including the fallback: a
    card naming a block that does not exist counts against the first block,
    because that is where the dashboard will actually draw it.
    """
    first, ids, out = _first_group(), _group_ids(), {}
    for c in _cards():
        g = c.get("group") or first
        if g not in ids:
            g = first
        out[g] = out.get(g, 0) + 1
    return out


@app.get("/api/admin/groups")
async def api_admin_groups(request: Request):
    """The blocks, with how many cards are in each so the editor can say why a
    delete will be refused before somebody presses it."""
    require_role(request, "admin")
    counts = _cards_by_group()
    return {
        "groups": [{**g, "cards": counts.get(g["id"], 0)} for g in _groups()],
        "limits": {"groups": MAX_GROUPS, "label": MAX_GROUP_LABEL},
        "ready":  _groups_available(),
    }


def _clean_group_label(value) -> str:
    label = (value or "").strip()
    if not label:
        raise HTTPException(400, "A block needs a heading")
    if len(label) > MAX_GROUP_LABEL:
        raise HTTPException(400, f"Keep the heading under {MAX_GROUP_LABEL} characters")
    return label


@app.post("/api/admin/groups")
async def api_admin_group_save(request: Request):
    """Add a block, or rename one. An id in the body means rename.

    Only the label is editable. An id is what every card in the block points at,
    so changing one would silently empty the block and scatter its cards into
    the first one. Ids are minted here (grp_…) for the same reason they are for
    links and charts.
    """
    me   = require_role(request, "admin")
    b    = await request.json()
    gid  = (b.get("id") or "").strip()
    rows = _group_rows()
    who  = _public_profile(me).get("name")
    label = _clean_group_label(b.get("label"))

    if not _groups_available():
        raise HTTPException(503, "Blocks need migration 011. Apply it and reload.")

    if gid:
        if gid not in {r["id"] for r in rows}:
            raise HTTPException(404, "That block no longer exists")
        row, verb = {"id": gid, "label": label}, "renamed the block to"
    else:
        if len(rows) >= MAX_GROUPS:
            raise HTTPException(400, f"That's the most blocks you can have ({MAX_GROUPS})")
        row = {
            "id":         "grp_" + uuid.uuid4().hex[:8],
            "label":      label,
            "sort":       (max([r.get("sort") or 0 for r in rows]) + 10) if rows else 10,
            "created_by": who,
        }
        verb = "added the block"

    try:
        supabase.table("dashboard_groups").upsert(row).execute()
    except Exception as e:
        logger.error(f"[admin] block save failed for {row['id']}: {e}")
        raise HTTPException(503, "Couldn't save that block.")

    log_activity("admin", who, verb, label)
    return {"ok": True, "group": row}


@app.post("/api/admin/groups/delete")
async def api_admin_group_delete(request: Request):
    """Remove a block. Refused while anything is in it, and refused for the last.

    **Emptiness is the rail, and it counts applets as well as links.** Applets
    are code: an admin who deletes the block a registry entry names cannot put
    it back from the UI, and the entry would render under a heading nobody
    chose. Deleting a block that holds cards would also be the one action here
    with no undo, since the cards do not move anywhere, they just stop being
    where somebody filed them.

    The last block cannot go at all. _groups() falls back when the table is
    empty, so an empty table does not break the dashboard, but it does mean the
    admin screen and the site disagree about what exists, which is worse than
    refusing.
    """
    me  = require_role(request, "admin")
    b   = await request.json()
    gid = (b.get("id") or "").strip()

    rows = _group_rows()
    row  = next((r for r in rows if r["id"] == gid), None)
    if not row:
        raise HTTPException(404, "That block no longer exists")
    if len(rows) <= 1:
        raise HTTPException(400, "That's the only block left")

    typed = (b.get("label") or "").strip()
    if typed != (row.get("label") or ""):
        raise HTTPException(400, "Type the block's heading exactly to delete it")

    held = _cards_by_group().get(gid, 0)
    if held:
        raise HTTPException(
            400, f"Move the {held} card{'s' if held != 1 else ''} out of that block first")

    try:
        supabase.table("dashboard_groups").delete().eq("id", gid).execute()
    except Exception as e:
        logger.error(f"[admin] block delete failed for {gid}: {e}")
        raise HTTPException(503, "Couldn't delete that block.")

    log_activity("admin", _public_profile(me).get("name"),
                 "removed the block", row.get("label") or gid)
    return {"ok": True}


@app.post("/api/admin/groups/reorder")
async def api_admin_groups_reorder(request: Request):
    """Rewrite the order of the blocks. Takes every id, in the order wanted.

    Reordering is not cosmetic here the way it is for links: the first block is
    where a card with no group of its own lands, and the dashboard draws it
    without a heading. Moving a block to the top changes both.
    """
    me   = require_role(request, "admin")
    b    = await request.json()
    ids  = [str(i).strip() for i in (b.get("ids") or [])]
    mine = {r["id"] for r in _group_rows()}
    if not mine:
        raise HTTPException(503, "Blocks need migration 011. Apply it and reload.")

    order = [i for i in dict.fromkeys(ids) if i in mine]
    if set(order) != mine:
        raise HTTPException(400, "That list is out of date. Reload and try again.")

    try:
        for position, gid in enumerate(order, start=1):
            supabase.table("dashboard_groups").update({"sort": position * 10}).eq("id", gid).execute()
    except Exception as e:
        logger.error(f"[admin] block reorder failed: {e}")
        raise HTTPException(503, "Couldn't save that order.")

    log_activity("admin", _public_profile(me).get("name"), "reordered", "the dashboard blocks")
    return {"ok": True, "ids": order}


# ══════════════════════════════════════════════════════════════════════════════
#  Team profiles  (migrations/003)
#
#  A directory, not a social network. The prompts exist because free-text "write
#  a bio" fields produce empty profiles and picking from a list produces filled
#  ones, since choosing is easier than composing. The tags exist because they are the
#  reason to open this page in November: "who do I ask about CAN bus?".
#
#  Everything here degrades when 003 has not been applied yet. The page then
#  shows accounts with no detail rather than an error, which matters because
#  migrations are applied by hand and there is always a window.
# ══════════════════════════════════════════════════════════════════════════════

# Pick 3. Adding one here is the whole job: prompt_key is free text in the
# database precisely so this list can change without a migration. Retiring one
# does NOT delete anybody's answer; it just stops being offered.
PROMPTS = [
    {"key": "why-joined",       "label": "Why I joined UCDFS"},
    {"key": "best-memory",      "label": "Favourite team memory"},
    {"key": "proudest-part",    "label": "The part I'm proudest of"},
    {"key": "worst-moment",     "label": "My worst workshop moment"},
    {"key": "advice-first-year","label": "What I'd tell a first-year"},
    {"key": "essential-tool",   "label": "The tool I can't work without"},
    {"key": "dream-job",        "label": "Dream job after this"},
    {"key": "useless-skill",    "label": "Most useless skill I have"},
    {"key": "this-season",      "label": "What I'm working on this season"},
    {"key": "build-night-song", "label": "Song that gets me through a build night"},
    {"key": "ask-me-about",     "label": "Ask me about"},
    {"key": "learned-hard-way", "label": "Something I learned the hard way"},
    {"key": "pre-comp-ritual",  "label": "My pre-competition ritual"},
    {"key": "if-not-fs",        "label": "What I'd be doing if I wasn't here"},
    {"key": "best-purchase",    "label": "Best thing I've bought for the workshop"},
]
PROMPT_KEYS   = {p["key"] for p in PROMPTS}
PROMPTS_BY_KEY = {p["key"]: p for p in PROMPTS}

MAX_PROMPTS   = 3
MAX_TAGS      = 8
MAX_TAG_LEN   = 28
MAX_ANSWER    = 280

# Stored value / what it reads as. "Retired member" is here so people who have
# graduated stay in the directory as themselves rather than as a stale 4th year.
# They are usually the only ones who remember why a decision was made.
# No PhD: nobody on the team is one, and an option nobody picks is just noise.
YEARS = [
    {"value": "1st",  "label": "1st year"},
    {"value": "2nd",  "label": "2nd year"},
    {"value": "3rd",  "label": "3rd year"},
    {"value": "4th",  "label": "4th year"},
    {"value": "5th",  "label": "5th year"},
    {"value": "MSc",  "label": "MSc"},
    {"value": "Alum", "label": "Retired member"},
]
YEAR_VALUES = {y["value"] for y in YEARS}
YEAR_LABELS = {y["value"]: y["label"] for y in YEARS}

# Deliberately NOT profiles.role. That column is a permission ('member' |
# 'committee' | 'admin') and is checked by require_role. This one is what
# someone calls themselves on their profile card and is checked by nothing. Two
# fields because they answer two questions; merging them would mean editing your
# own profile could grant you access.
#
# scope is the bit that took a second pass to get right. Captains and members
# belong to a division; the Team Principal and Technical Director do not. They
# sit across all three. So a team-wide role makes the division optional instead
# of forcing someone to file themselves under a subteam they don't actually run.
ROLES = [
    {"value": "member",    "label": "Team member",        "scope": "division", "rank": 4},
    {"value": "vice",      "label": "Vice captain",       "scope": "division", "rank": 3},
    {"value": "captain",   "label": "Captain",            "scope": "division", "rank": 2},
    {"value": "td",        "label": "Technical Director",  "scope": "team",     "rank": 1},
    {"value": "principal", "label": "Team Principal",      "scope": "team",     "rank": 0},
]
ROLES_BY_VALUE = {r["value"]: r for r in ROLES}

# Age is deliberately absent. Year + course already says it, and this page can
# be opted into a public sponsor-facing view later. Easy to add if people ask.


def _clean_tags(raw) -> list:
    """Lowercased, trimmed, de-duplicated, capped. Case-folding is what makes
    'CAN bus' and 'can bus' the same filter chip instead of two."""
    if not isinstance(raw, list):
        return []
    out = []
    for t in raw:
        t = " ".join(str(t or "").split()).lower()[:MAX_TAG_LEN]
        if t and t not in out:
            out.append(t)
    return out[:MAX_TAGS]


def _clean_year(raw) -> str:
    v = (raw or "").strip()
    return v if v in YEAR_VALUES else ""


def _clean_role(raw) -> str:
    v = (raw or "").strip()
    return v if v in ROLES_BY_VALUE else ""


def _clean_joined(raw) -> Optional[int]:
    try:
        y = int(raw)
    except (TypeError, ValueError):
        return None
    this_year = datetime.now(TEAM_TZ).year
    # The team predates none of us by much; anything outside this is a typo.
    return y if 2000 <= y <= this_year + 1 else None


def _get_details(user_id: str) -> dict:
    try:
        r = supabase.table("profile_details").select("*").eq("id", user_id).execute()
        return (r.data or [{}])[0] if r.data else {}
    except Exception as e:
        logger.debug(f"[profiles] details unavailable (003 applied?): {e}")
        return {}


def _details_available() -> bool:
    """Is migration 003 actually applied?

    Everything on this page degrades when it is not, but the first-sign-in
    prompt is the one thing that must not appear. Asking someone to pick a
    subteam and then failing to save it is worse than not asking. So the
    dashboard checks this before showing the step at all.
    """
    try:
        supabase.table("profile_details").select("id").limit(1).execute()
        return True
    except Exception:
        return False


def _get_prompts(user_id: str) -> list:
    try:
        r = (supabase.table("profile_prompts").select("*")
             .eq("profile_id", user_id).order("position").execute())
        return r.data or []
    except Exception as e:
        logger.debug(f"[profiles] prompts unavailable (003 applied?): {e}")
        return []


def _avatar_url(user_id: str, details: dict) -> Optional[str]:
    """The URL, or None when there is no photo.

    ?v= is not decoration: photos overwrite in place at a stable path, so
    without the revision the browser keeps showing the one you just replaced.
    """
    ext = (details or {}).get("photo_ext") or ""
    if not ext:
        return None
    return f"/media/avatars/{user_id}.{ext}?v={(details or {}).get('photo_rev') or 0}"


def _person(profile: dict, details: dict, prompts: list) -> dict:
    """One directory entry: account + details + answers, flattened for the page."""
    first = (profile.get("first_name") or "").strip()
    last  = (profile.get("last_name") or "").strip()
    d = details or {}
    role = ROLES_BY_VALUE.get(d.get("role_label") or "")
    return {
        "id":       profile.get("id"),
        "first":    first,
        "last":     last,
        "name":     (first + " " + last).strip(),
        "email":    profile.get("email") or "",
        "subteam":  profile.get("subteam") or None,
        "subteams_extra": profile.get("subteams_extra") or [],
        "year":        d.get("year") or "",
        # Sent alongside the raw value so no page has to know that "Alum" reads
        # as "Retired member".
        "year_label":  YEAR_LABELS.get(d.get("year") or "", ""),
        "course":      d.get("course") or "",
        "joined_year": d.get("joined_year"),
        "role_label":  d.get("role_label") or "",
        "role_name":   (role or {}).get("label", ""),
        # 'team' means Team Principal / Technical Director: across all three
        # divisions rather than in one, so their card leads with the role.
        "role_scope":  (role or {}).get("scope", ""),
        "role_rank":   (role or {}).get("rank", 9),
        "tags":        d.get("tags") or [],
        "is_public":   bool(d.get("is_public")),
        "photo":       _avatar_url(profile.get("id"), d),
        "prompts": [
            {"key": p.get("prompt_key"),
             "label": (PROMPTS_BY_KEY.get(p.get("prompt_key")) or {}).get(
                 "label", p.get("prompt_key")),
             "answer": p.get("answer") or ""}
            for p in prompts if (p.get("answer") or "").strip()
        ],
    }


@app.get("/api/profiles")
async def api_profiles(request: Request):
    """The whole directory in one request.

    Sixty people with three prompts each is small enough that paginating it
    would cost more in complexity than it saves in bytes, and the page filters
    client-side so every chip is instant.
    """
    me = current_profile(request)

    try:
        rows = supabase.table("profiles").select("*").execute().data or []
    except Exception as e:
        logger.error(f"[profiles] roster query failed: {e}")
        rows = []

    # Two more queries rather than sixty: fetch the lot and group in memory.
    details_by_id: dict = {}
    prompts_by_id: dict = {}
    try:
        for d in (supabase.table("profile_details").select("*").execute().data or []):
            details_by_id[d.get("id")] = d
        for p in (supabase.table("profile_prompts").select("*")
                  .order("position").execute().data or []):
            prompts_by_id.setdefault(p.get("profile_id"), []).append(p)
    except Exception as e:
        # 003 not applied yet, most likely. Show the accounts we do have,
        # an empty directory reads as "broken", a bare one reads as "new".
        logger.debug(f"[profiles] detail tables unavailable: {e}")

    people = [_person(r, details_by_id.get(r.get("id")) or {},
                      prompts_by_id.get(r.get("id")) or [])
              for r in rows]
    # Filled profiles first so the grid looks populated on day one of
    # recruitment rather than like a wall of blank cards; then by role, so it
    # reads as a team: principal, technical director, captains, then everyone,
    # rather than as an alphabetical list.
    people.sort(key=lambda p: (0 if p["photo"] else 1,
                               0 if p["prompts"] else 1,
                               p["role_rank"],
                               p["name"].lower()))

    return {
        "people":   people,
        "me":       me.get("id"),
        "prompts":  PROMPTS,
        "subteams": SUBTEAMS,
        "years":    YEARS,
        "roles":    ROLES,
        "limits":   {"prompts": MAX_PROMPTS, "tags": MAX_TAGS,
                     "answer": MAX_ANSWER, "photo_bytes": MAX_AVATAR_BYTES},
    }


@app.post("/api/profile")
async def api_profile_save(request: Request):
    """Save the signed-in person's own profile.

    There is no id in the body and there never should be: the row written is
    always current_profile(request), so "edit someone else's profile" is not a
    request this endpoint can express. Editing another person is a different
    endpoint (/api/admin/profile) precisely so that the privileged path is
    somewhere explicit rather than a parameter on the ordinary one.
    """
    return await _save_profile(request, current_profile(request)["id"])


@app.post("/api/admin/profile")
async def api_admin_profile_save(request: Request):
    """Save somebody else's profile. Requires the override.

    Deliberately a separate route from the self-service one above: the check
    lives at the door rather than inside a branch, and every privileged write
    is one grep away.
    """
    b = await request.json()
    target = (b.get("id") or "").strip()
    if not target:
        raise HTTPException(400, "Which person?")
    if not is_god(request):
        raise HTTPException(403, "Turn on admin override to edit someone else's profile")
    if not _get_profile(target):
        raise HTTPException(404, "No such account.")

    me = current_profile(request)
    victim = _get_profile(target) or {}
    log_activity("admin", _public_profile(me).get("name"), "edited the profile of",
                 ((victim.get("first_name") or "") + " " + (victim.get("last_name") or "")).strip())
    return await _save_profile(request, target, body=b)


async def _save_profile(request: Request, uid: str, body: Optional[dict] = None):
    """The shared write. `uid` is decided by the caller, never by the payload."""
    me  = current_profile(request)
    b   = body if body is not None else await request.json()

    subteam = _clean_subteam(b.get("subteam"))
    extra   = [s for s in (_clean_subteam(x) for x in (b.get("subteams_extra") or []))
               if s and s != subteam]
    extra   = list(dict.fromkeys(extra))            # de-dupe, keep order

    try:
        supabase.table("profiles").update(
            {"subteam": subteam, "subteams_extra": extra}).eq("id", uid).execute()
    except Exception as e:
        logger.error(f"[profiles] subteam save failed for {uid}: {e}")
        raise HTTPException(503, "Couldn't save that. Has migration 003 been applied?")

    # Read before write, so the feed can tell "joined the directory" from the
    # fifteenth tweak to someone's tag list. Deliberately NOT keyed on
    # onboarded_at: the subteam picker sets that first, which would suppress the
    # line on the one save that actually deserves it.
    prev = _get_details(uid) or {}
    was_blank = not (prev.get("year") or prev.get("course") or prev.get("tags"))

    details = {
        "id":          uid,
        "year":        _clean_year(b.get("year")),
        "course":      " ".join((b.get("course") or "").split())[:80],
        "joined_year": _clean_joined(b.get("joined_year")),
        "role_label":  _clean_role(b.get("role_label")),
        "tags":        _clean_tags(b.get("tags")),
        "is_public":   bool(b.get("is_public")),
        "onboarded_at": datetime.now(TEAM_TZ).isoformat(),
        "updated_at":  datetime.now(TEAM_TZ).isoformat(),
    }
    try:
        supabase.table("profile_details").upsert(details).execute()
    except Exception as e:
        logger.error(f"[profiles] details save failed for {uid}: {e}")
        raise HTTPException(503, "Couldn't save that. Has migration 003 been applied?")

    # Prompts are replace-all for this person: whatever they submitted is now
    # the complete set. Simpler than diffing, and matches what the editor does.
    answers = b.get("prompts")
    if isinstance(answers, list):
        rows, keys = [], []
        for i, a in enumerate(answers[:MAX_PROMPTS]):
            key = (a or {}).get("key")
            ans = " ".join(((a or {}).get("answer") or "").split())[:MAX_ANSWER]
            if key in PROMPT_KEYS and ans:
                keys.append(key)
                rows.append({"profile_id": uid, "prompt_key": key, "answer": ans,
                             "position": i,
                             "updated_at": datetime.now(TEAM_TZ).isoformat()})
        try:
            if rows:
                supabase.table("profile_prompts").upsert(
                    rows, on_conflict="profile_id,prompt_key").execute()
            q = supabase.table("profile_prompts").delete().eq("profile_id", uid)
            if keys:
                # Clear the ones they removed, keep the ones they kept.
                q = q.not_.in_("prompt_key", keys)
            q.execute()
        except Exception as e:
            # The profile itself is already saved. Losing a prompt edit is worth
            # far less than telling someone their whole save failed when it did
            # not, so this degrades rather than raising.
            logger.error(f"[profiles] prompt save failed for {uid}: {e}")

    fresh = _get_profile(uid) or {**me, "subteam": subteam}
    mine  = uid == me.get("id")

    # Only the first time. Somebody joining the directory is news; somebody
    # rewording their answer about the 10mm socket is not, and a feed that
    # reports both is a feed people stop reading. Credited to whose profile it
    # is, not to whoever typed it. An admin filling in a gap on someone's
    # behalf should not read as that admin joining the directory.
    if was_blank and (details["year"] or details["course"] or details["tags"]):
        log_activity("profiles", _public_profile(fresh).get("name"),
                     "filled in their profile")

    response = JSONResponse({"ok": True, "profile": _public_profile(fresh)})
    # Only ever rewrite your OWN cookie. Doing this unconditionally would hand
    # an admin editing someone else that person's name, photo and subteam,
    # their own browser would quietly start displaying them as the person they
    # just edited.
    if mine:
        _set_profile_cookie(response, fresh)
    return response


@app.post("/api/profile/subteam")
async def api_profile_subteam(request: Request):
    """The first-sign-in question, on its own.

    Separate from the full save so the onboarding card can be three buttons and
    a fetch. "Not sure yet" posts null and still marks them onboarded. The flow
    must never block anyone, and during recruitment half of them genuinely do
    not know yet. Without recording that we asked, they would be asked again on
    every single page load.
    """
    me  = current_profile(request)
    uid = me["id"]
    b   = await request.json()
    subteam = _clean_subteam(b.get("subteam"))

    try:
        supabase.table("profiles").update({"subteam": subteam}).eq("id", uid).execute()
        supabase.table("profile_details").upsert({
            "id": uid,
            "onboarded_at": datetime.now(TEAM_TZ).isoformat(),
            "updated_at":   datetime.now(TEAM_TZ).isoformat(),
        }).execute()
    except Exception as e:
        logger.error(f"[profiles] subteam pick failed for {uid}: {e}")
        raise HTTPException(503, "Couldn't save that. Has migration 003 been applied?")

    fresh = _get_profile(uid) or {**me, "subteam": subteam}
    response = JSONResponse({"ok": True, "profile": _public_profile(fresh)})
    _set_profile_cookie(response, fresh)
    return response


@app.post("/api/profile/favourites")
async def api_profile_favourites(request: Request):
    """Star or unstar one card. Takes no id but its own. See /api/profile.

    A toggle rather than a whole list, so two tabs starring different cards do
    not overwrite each other with a stale array. Order is kept as clicked, which
    is the only ordering anybody could predict.
    """
    me  = current_profile(request)
    uid = me["id"]
    b   = await request.json()

    applet_id = (b.get("id") or "").strip()
    # Checked against what exists, not stored as sent: this array is read back
    # and rendered, and an id naming no card is junk that never cleans itself
    # up. "What exists" is applets plus links, since a hyperlink card carries a
    # star like any other and starring one must not 400.
    cards = {c["id"]: c for c in _cards()}
    if applet_id not in cards:
        raise HTTPException(400, "unknown applet")
    # You cannot favourite what you cannot open. The card is not on your
    # dashboard to star, so a request to star it did not come from the UI.
    if not _may_open(cards[applet_id], me):
        raise HTTPException(403, "You don't have access to that")

    current = [f for f in (_get_details(uid).get("favourites") or []) if f in cards]
    on = bool(b.get("on"))
    if on and applet_id not in current:
        if len(current) >= MAX_FAVOURITES:
            raise HTTPException(400, f"That's the most you can pin ({MAX_FAVOURITES})")
        current.append(applet_id)
    elif not on:
        current = [f for f in current if f != applet_id]

    try:
        supabase.table("profile_details").upsert({
            "id":         uid,
            "favourites": current,
            "updated_at": datetime.now(TEAM_TZ).isoformat(),
        }).execute()
    except Exception as e:
        logger.error(f"[profiles] favourite toggle failed for {uid}: {e}")
        raise HTTPException(503, "Couldn't save that. Has migration 008 been applied?")

    # Deliberately not written to the activity feed. Which tools someone likes
    # is nobody else's business and would bury the things that are.
    return {"ok": True, "favourites": current}


@app.get("/api/profile/me")
async def api_profile_me(request: Request):
    """Own profile plus the option lists the editor needs to render itself."""
    me = current_profile(request)
    uid = me["id"]
    details = _get_details(uid)
    return {
        "person":    _person(me, details, _get_prompts(uid)),
        "onboarded": bool(details.get("onboarded_at")),
        "ready":     _details_available(),
        "prompts":   PROMPTS,
        "subteams":  SUBTEAMS,
        "years":     YEARS,
        "roles":     ROLES,
        "limits":    {"prompts": MAX_PROMPTS, "tags": MAX_TAGS,
                      "answer": MAX_ANSWER, "photo_bytes": MAX_AVATAR_BYTES},
    }


# ── Profile photos ────────────────────────────────────────────────────────────
# Stored on this machine's disk under UPLOAD_DIR (a mounted volume), not in
# Supabase Storage. See the Uploads block at the top of this file for why.

# Sniffed from the bytes, never taken from the declared content type. The
# client controls that string and it proves nothing about what was sent.
_IMAGE_MAGIC = [
    (b"\xff\xd8\xff", "jpg"),
    (b"\x89PNG\r\n\x1a\n", "png"),
]


def _sniff_image(raw: bytes) -> Optional[str]:
    for magic, ext in _IMAGE_MAGIC:
        if raw.startswith(magic):
            return ext
    # WebP is RIFF....WEBP: the marker is at offset 8, not 0.
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp"
    return None


@app.post("/api/profile/photo")
async def api_profile_photo(request: Request):
    """Upload your own photo.

    Takes a base64 data URL in JSON rather than multipart. The browser already
    has to draw the image to a canvas to resize it (a 4 MB phone photo per
    person adds up fast, and there is no image library in this container to do
    it server-side), and a canvas hands back a data URL, so this shape costs
    one fetch and no new dependency, where multipart would need python-multipart
    added to requirements.txt for no gain at this size.
    """
    me  = current_profile(request)
    uid = me["id"]
    b   = await request.json()

    raw_url = (b.get("data") or "")
    if "," in raw_url:
        raw_url = raw_url.split(",", 1)[1]
    try:
        blob = base64.b64decode(raw_url, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "That file didn't arrive intact. Try again.")

    if not blob:
        raise HTTPException(400, "No image received.")
    if len(blob) > MAX_AVATAR_BYTES:
        raise HTTPException(413, "That photo is too big. Under 2 MB please.")

    ext = _sniff_image(blob)
    if not ext:
        raise HTTPException(400, "That doesn't look like a JPEG, PNG or WebP.")

    details = _get_details(uid)
    old_ext = details.get("photo_ext") or ""

    try:
        os.makedirs(AVATAR_DIR, exist_ok=True)
        with open(os.path.join(AVATAR_DIR, f"{uid}.{ext}"), "wb") as fh:
            fh.write(blob)
    except OSError as e:
        logger.error(f"[profiles] could not write avatar for {uid}: {e}")
        raise HTTPException(503, "Couldn't save that photo. Tell Shane.")

    # A re-upload in a different format would otherwise leave the old file
    # behind, still reachable at its own URL.
    if old_ext and old_ext != ext:
        try:
            os.remove(os.path.join(AVATAR_DIR, f"{uid}.{old_ext}"))
        except OSError:
            pass

    rev = int(details.get("photo_rev") or 0) + 1
    try:
        supabase.table("profile_details").upsert({
            "id": uid, "photo_ext": ext, "photo_rev": rev,
            "updated_at": datetime.now(TEAM_TZ).isoformat(),
        }).execute()
    except Exception as e:
        logger.error(f"[profiles] could not record avatar for {uid}: {e}")
        raise HTTPException(503, "Photo saved but not recorded. Has 003 been applied?")

    # Rewrite the cookie so the header pill and the "who's in now" bar pick the
    # new face up on the next page load rather than the next sign-in.
    response = JSONResponse({
        "ok": True,
        "photo": _avatar_url(uid, {"photo_ext": ext, "photo_rev": rev}),
    })
    _set_profile_cookie(response, _get_profile(uid) or me)
    return response


@app.post("/api/profile/photo/remove")
async def api_profile_photo_remove(request: Request):
    me  = current_profile(request)
    uid = me["id"]

    # Somebody else's, with the override on: the moderation case. Same shape as
    # the profile save: an explicit id, checked at the door.
    try:
        b = await request.json()
    except Exception:
        b = {}
    target = (b or {}).get("id")
    if target and target != uid:
        if not is_god(request):
            raise HTTPException(403, "Turn on admin override to remove someone else's photo")
        if not _get_profile(target):
            raise HTTPException(404, "No such account.")
        uid = target

    details = _get_details(uid)
    ext = details.get("photo_ext") or ""

    if ext:
        try:
            os.remove(os.path.join(AVATAR_DIR, f"{uid}.{ext}"))
        except OSError:
            pass        # already gone is the state we wanted anyway
    try:
        supabase.table("profile_details").upsert({
            "id": uid, "photo_ext": "",
            "updated_at": datetime.now(TEAM_TZ).isoformat(),
        }).execute()
    except Exception as e:
        logger.error(f"[profiles] could not clear avatar for {uid}: {e}")
        raise HTTPException(503, "Couldn't remove that photo.")

    response = JSONResponse({"ok": True})
    # Same rule as the profile save: never rewrite your own cookie with somebody
    # else's row just because you edited them.
    if uid == me["id"]:
        _set_profile_cookie(response, _get_profile(uid) or me)
    return response


def _photo_map() -> dict:
    """{lowercased full name: photo URL} for everyone who has one.

    Keyed by name because that is what the older tables have: attendance,
    comp_roster and comp_requests all key people by their typed-in full name,
    which predates accounts existing. The `profile_names` view was added in 001
    as the bridge for exactly this, and this is the same bridge for faces.

    A name that matches nobody just has no photo, never an error, and never a
    reason for a list of people to fail to render.
    """
    try:
        rows = sb().table("profiles").select("id,first_name,last_name").execute().data or []
        details = {d.get("id"): d for d in
                   (sb().table("profile_details").select("id,photo_ext,photo_rev")
                    .execute().data or [])}
    except Exception as e:
        logger.debug(f"[profiles] photo map unavailable: {e}")
        return {}

    out = {}
    for r in rows:
        url = _avatar_url(r.get("id"), details.get(r.get("id")) or {})
        if not url:
            continue
        name = ((r.get("first_name") or "") + " " + (r.get("last_name") or "")).strip()
        if name:
            out[name.lower()] = url
    return out


@app.get("/api/people/photos")
async def api_people_photos():
    """Faces for the name-keyed pages (attendance today, the nowbar).

    Its own endpoint rather than a field on each of those responses: one cached
    fetch per page load serves every list on it, and adding a face to a new list
    later needs no server change at all.
    """
    return {"photos": _photo_map()}


# Filenames are generated by this file, never by a user, so this pattern is an
# exact description of what is legitimately in that directory rather than a
# blocklist of what is not. A name that does not match is not a traversal
# attempt to sanitise. It is a request for a file we did not write.
_AVATAR_NAME = re.compile(r"^[0-9a-fA-F-]{36}\.(jpg|png|webp)$")


@app.get("/media/avatars/{filename}")
async def media_avatar(filename: str):
    """Serve a profile photo.

    Not under /static and not mounted through StaticFiles, which is the whole
    point: this path goes through the auth middleware, so photos are
    members-only by default with no extra code. When the public sponsor page
    lands it gets its own route that checks profile_details.is_public.
    """
    if not _AVATAR_NAME.match(filename):
        raise HTTPException(404, "No such photo")
    path = os.path.join(AVATAR_DIR, filename)
    if not os.path.isfile(path):
        raise HTTPException(404, "No such photo")
    # Immutable is safe because the URL carries ?v=<photo_rev>: a new photo is a
    # new URL, so nothing has to expire.
    return FileResponse(path, headers={"Cache-Control": "private, max-age=604800"})


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
    result = sb().table("attendance") \
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


# ── Charts ────────────────────────────────────────────────────────────────────
# What /flowcharts lists, and how a chart is made, renamed, archived or removed.
#
# None of this is role-gated, on purpose. A chart is a shared artifact like a
# task or a section, and every one of those is already something any member can
# add and edit. Gating charts alone would be inconsistent, and the friction
# lands on exactly the person we want drawing one. The rails here are structural
# instead: ids are minted server-side, archiving is reversible, and deleting is
# refused unless the chart is empty. Compare the /api/admin/* endpoints, which
# are gated because they act on *someone else's* data rather than shared work.
def _chart_actor(request: Request) -> str:
    """Who to credit a chart action to, as a display name.

    Same shape the rest of the feed uses (_public_profile's "name"), so a chart
    line reads like every other line rather than showing an email address.
    """
    profile = getattr(request.state, "profile", None) or {}
    return _public_profile(profile).get("name") or "Someone"


def _plan_counts() -> dict:
    """Task and tick counts per chart, for the picker's subtitles.

    Two queries for every chart rather than two per chart. The whole point is
    that this page stays cheap as the number of charts grows.
    """
    counts: dict = {}
    try:
        for r in (supabase.table("pt_nodes").select("plan_id").execute().data or []):
            c = counts.setdefault(r["plan_id"], {"tasks": 0, "done": 0})
            c["tasks"] += 1
        for r in (supabase.table("pt_done").select("plan_id").execute().data or []):
            c = counts.setdefault(r["plan_id"], {"tasks": 0, "done": 0})
            c["done"] += 1
    except Exception as e:
        logger.error(f"[_plan_counts] {e}")
    return counts


@app.get("/api/plans")
async def api_plans():
    try:
        rows = supabase.table("plans").select("*") \
            .order("archived").order("created_at").execute().data or []
    except Exception as e:
        # 007 unapplied. An empty list draws the picker's "no charts yet" state,
        # which beats a stack trace on the page that lists everything.
        logger.error(f"[api_plans] {e}")
        rows = []
    counts = _plan_counts()
    return {"plans": [{
        **r,
        "tasks": counts.get(r["id"], {}).get("tasks", 0),
        "done":  counts.get(r["id"], {}).get("done", 0),
    } for r in rows]}


@app.post("/api/plans")
async def api_plans_create(request: Request):
    b = await request.json()
    name = (b.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "name required")
    if len(name) > 80:
        raise HTTPException(400, "that name is too long")

    live = supabase.table("plans").select("id").eq("archived", False).execute().data or []
    if len(live) >= MAX_LIVE_PLANS:
        raise HTTPException(400, "Too many charts. Archive some first")

    row = {
        "id":         "chart_" + uuid.uuid4().hex[:8],
        "name":       name,
        "icon":       (b.get("icon") or "🗺️").strip()[:8] or "🗺️",
        "blurb":      (b.get("blurb") or "").strip()[:160] or None,
        "archived":   False,
        "created_by": _chart_actor(request),
    }
    supabase.table("plans").insert(row).execute()
    log_activity("flowcharts", row["created_by"], "created the chart", name)
    return {"plan": {**row, "tasks": 0, "done": 0}}


@app.post("/api/plans/update")
async def api_plans_update(request: Request):
    """Rename, re-icon, or archive/unarchive one chart."""
    b   = await request.json()
    pid = _plan_or_400(b.get("id"))
    row = _plan_row(pid) or {}

    patch: dict = {}
    name = (b.get("name") or "").strip()
    if name:
        if len(name) > 80:
            raise HTTPException(400, "that name is too long")
        patch["name"] = name
    if b.get("icon") is not None:
        patch["icon"] = (b.get("icon") or "").strip()[:8] or "🗺️"
    if b.get("blurb") is not None:
        patch["blurb"] = (b.get("blurb") or "").strip()[:160] or None
    if b.get("archived") is not None:
        patch["archived"] = bool(b.get("archived"))
    if not patch:
        raise HTTPException(400, "nothing to update")

    supabase.table("plans").update(patch).eq("id", pid).execute()

    who = _chart_actor(request)
    was = row.get("name") or pid
    if "archived" in patch:
        log_activity("flowcharts", who,
                     "archived the chart" if patch["archived"] else "un-archived the chart",
                     patch.get("name") or was)
    elif "name" in patch and patch["name"] != was:
        log_activity("flowcharts", who, "renamed a chart to", patch["name"])
    return {"ok": True}


@app.post("/api/plans/delete")
async def api_plans_delete(request: Request):
    """Delete an empty chart.

    Refused while it holds anything at all. There is no undo in this app and no
    backup a member can reach, so the only chart it will destroy is one with
    nothing in it: a mistyped name, a duplicate. For a chart with real work on
    it, archiving is the answer, and it is one click away in the same menu.
    """
    b   = await request.json()
    pid = _plan_or_400(b.get("id"))
    row = _plan_row(pid) or {}

    # Echo the name back, the same rail as deleting an account: a stale id from
    # a list rendered a minute ago cannot take out a chart someone has since
    # renamed or replaced.
    if (b.get("name") or "").strip() != (row.get("name") or ""):
        raise HTTPException(400, "Chart name does not match. Reload and try again")

    def _is_empty() -> bool:
        for table, field in (("pt_nodes", "id"), ("pt_sections", "sec")):
            if supabase.table(table).select(field) \
                    .eq("plan_id", pid).limit(1).execute().data:
                return False
        return True

    if not _is_empty():
        raise HTTPException(400, "This chart isn't empty. Archive it instead")

    # pt_nodes and pt_sections are never deleted from here, and that is the
    # point: this endpoint removes a chart that holds nothing, so if there were
    # rows in either it has no business running at all. Cascading them would
    # turn the check above into decoration and make a one-click way to destroy
    # a season's work.
    #
    # Everything below is keyed to a node id, so with no nodes there is nothing
    # meaningful in any of it. These deletes only sweep up rows a previous
    # delete could have stranded. The tick log is deliberately left alone, like
    # attendance rows and feed lines: it records what happened, not what exists.
    for table in ("pt_done", "pt_progress", "pt_details", "pt_edges"):
        supabase.table(table).delete().eq("plan_id", pid).execute()

    # Checked again immediately before the chart itself goes. There is no
    # transaction across these calls, so somebody adding a task during the sweep
    # above would otherwise leave it in a chart that no longer exists, and the
    # whitelist then makes it unreachable, so it could never be found or tidied.
    # Losing the race costs a few stray satellite rows; the task survives.
    if not _is_empty():
        raise HTTPException(400, "This chart isn't empty. Archive it instead")
    supabase.table("plans").delete().eq("id", pid).execute()

    log_activity("flowcharts", _chart_actor(request),
                 "deleted the empty chart", row.get("name") or pid)
    return {"ok": True}


# ── PT: single state endpoint (nodes, edges, done, details, sections) ──────────
# All /pt/api/* endpoints serve every chart, not just the original PT one:
# GET takes ?plan=, POSTs take "plan" in the body, and omitting it means the
# legacy chart so pre-multi-plan saves and clients keep working unchanged.
@app.get("/pt/api/state")
async def pt_state(plan: Optional[str] = None):
    pid = _plan_or_400(plan)
    nodes       = supabase.table("pt_nodes").select("*").eq("plan_id", pid).execute()
    edges       = supabase.table("pt_edges").select("*").eq("plan_id", pid).execute()
    done        = supabase.table("pt_done").select("node_id").eq("plan_id", pid).execute()
    in_progress = supabase.table("pt_progress").select("node_id").eq("plan_id", pid).execute()
    details     = supabase.table("pt_details").select("*").eq("plan_id", pid).execute()
    sections    = supabase.table("pt_sections").select("*").eq("plan_id", pid).execute()
    done_log    = supabase.table("pt_done_log").select("node_id,done,user_name,created_at") \
                      .eq("plan_id", pid).order("created_at").execute()
    # The chart's own row supplies its name and icon. _plan_or_400 already
    # proved it exists, so this is the same lookup rather than a second risk.
    row = _plan_row(pid) or {"id": pid, "name": "Chart"}
    return {
        # Name and icon only. The canvas draws itself from "sections" below,
        # which is data, so the page needs no second request and no idea which
        # chart it is looking at beyond the id it asked for.
        "plan":        {"id": pid, "name": row.get("name") or pid,
                        "icon": row.get("icon"), "archived": bool(row.get("archived"))},
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
    pid       = _plan_or_400(b.get("plan"))
    node_id   = (b.get("node_id")   or "").strip()
    # Not b["user_name"]. pt_done_log is the append-only audit trail the whole
    # build plan is trusted on, and taking the actor from the body meant any
    # signed-in member could tick a task and sign it with somebody else's name.
    # The page already sends this exact value; it was the endpoint that believed
    # whatever arrived. Same bug as attendance and the Comp Hub shopping list.
    user_name = _me_name(request) or "Unknown"
    if not node_id:
        raise HTTPException(400, "node_id required")
    done = bool(b.get("done"))
    if done:
        supabase.table("pt_done").upsert({"plan_id": pid, "node_id": node_id}).execute()
        supabase.table("pt_progress").delete().eq("plan_id", pid).eq("node_id", node_id).execute()
    else:
        supabase.table("pt_done").delete().eq("plan_id", pid).eq("node_id", node_id).execute()
    # Append-only audit log: never overwrite previous entries
    supabase.table("pt_done_log").insert({
        "plan_id":   pid,
        "node_id":   node_id,
        "done":      done,
        "user_name": user_name,
    }).execute()
    return {"ok": True}


@app.post("/pt/api/progress")
async def pt_progress_set(request: Request):
    b = await request.json()
    pid     = _plan_or_400(b.get("plan"))
    node_id = (b.get("node_id") or "").strip()
    if not node_id:
        raise HTTPException(400, "node_id required")
    if b.get("in_progress"):
        supabase.table("pt_progress").upsert({"plan_id": pid, "node_id": node_id}).execute()
        supabase.table("pt_done").delete().eq("plan_id", pid).eq("node_id", node_id).execute()
    else:
        supabase.table("pt_progress").delete().eq("plan_id", pid).eq("node_id", node_id).execute()
    return {"ok": True}


# ── PT nodes ───────────────────────────────────────────────────────────────────
@app.post("/pt/api/nodes")
async def pt_nodes_add(request: Request):
    b = await request.json()
    pid   = _plan_or_400(b.get("plan"))
    label = (b.get("label") or "").strip()
    sec   = (b.get("sec")   or "").strip()
    typ   = (b.get("type")  or "m").strip()
    if not label or not sec:
        raise HTTPException(400, "label and sec required")
    if typ not in ("m", "a", "ms", "g", "c"):
        typ = "m"
    deps = [d for d in (b.get("deps") or []) if isinstance(d, str)]
    node = {
        "plan_id":   pid,
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
            {"plan_id": pid, "id": edge_id, "f": dep_id, "t": node["id"], "is_cross": False}
        ).execute()
    return {"node": node}


@app.post("/pt/api/nodes/move")
async def pt_nodes_move(request: Request):
    b = await request.json()
    pid     = _plan_or_400(b.get("plan"))
    node_id = (b.get("id") or "").strip()
    if not node_id:
        raise HTTPException(400, "id required")
    supabase.table("pt_nodes").update(
        {"x": b.get("x"), "y": b.get("y")}
    ).eq("plan_id", pid).eq("id", node_id).execute()
    return {"ok": True}


@app.post("/pt/api/nodes/move-bulk")
async def pt_nodes_move_bulk(request: Request):
    """Move many nodes at once, which is what dragging a whole section does.

    Tasks hold absolute canvas coordinates, not an offset within their box, so
    moving a section has to carry its contents or they stay behind on the
    canvas while their box walks off. One request rather than one per task:
    a big section is thirty of them, and half-applied is worse than either.
    """
    b = await request.json()
    pid   = _plan_or_400(b.get("plan"))
    moves = b.get("moves") or []
    if not isinstance(moves, list):
        raise HTTPException(400, "moves must be a list")
    if len(moves) > 500:
        raise HTTPException(400, "too many moves")
    for m in moves:
        node_id = (str(m.get("id") or "")).strip()
        if not node_id:
            continue
        supabase.table("pt_nodes").update({"x": m.get("x"), "y": m.get("y")}) \
            .eq("plan_id", pid).eq("id", node_id).execute()
    return {"ok": True, "moved": len(moves)}


@app.post("/pt/api/nodes/rename")
async def pt_nodes_rename(request: Request):
    b = await request.json()
    pid     = _plan_or_400(b.get("plan"))
    node_id = (b.get("id") or "").strip()
    label   = (b.get("label") or "").strip()
    if not node_id or not label:
        raise HTTPException(400, "id and label required")
    update: dict = {"label": label}
    typ = (b.get("type") or "").strip()
    if typ in ("m", "a", "ms", "c"):
        update["type"] = typ
    supabase.table("pt_nodes").update(update).eq("plan_id", pid).eq("id", node_id).execute()
    return {"ok": True}


@app.post("/pt/api/nodes/delete")
async def pt_nodes_delete(request: Request):
    b = await request.json()
    pid     = _plan_or_400(b.get("plan"))
    node_id = (b.get("id") or "").strip()
    if not node_id:
        raise HTTPException(400, "id required")
    supabase.table("pt_nodes").delete().eq("plan_id", pid).eq("id", node_id).execute()
    supabase.table("pt_done").delete().eq("plan_id", pid).eq("node_id", node_id).execute()
    supabase.table("pt_progress").delete().eq("plan_id", pid).eq("node_id", node_id).execute()
    supabase.table("pt_details").delete().eq("plan_id", pid).eq("node_id", node_id).execute()
    supabase.table("pt_edges").delete().eq("plan_id", pid).eq("f", node_id).execute()
    supabase.table("pt_edges").delete().eq("plan_id", pid).eq("t", node_id).execute()
    return {"ok": True}


# ── PT edges ───────────────────────────────────────────────────────────────────
@app.post("/pt/api/edges/add")
async def pt_edges_add(request: Request):
    b = await request.json()
    pid = _plan_or_400(b.get("plan"))
    f = (b.get("f") or "").strip()
    t = (b.get("t") or "").strip()
    if not f or not t or f == t:
        raise HTTPException(400, "valid f and t required")
    supabase.table("pt_edges").upsert(
        {"plan_id": pid, "id": f"{f}__{t}", "f": f, "t": t, "is_cross": False}
    ).execute()
    return {"ok": True}


@app.post("/pt/api/edges/remove")
async def pt_edges_remove(request: Request):
    b = await request.json()
    pid = _plan_or_400(b.get("plan"))
    f = (b.get("f") or "").strip()
    t = (b.get("t") or "").strip()
    if not f or not t:
        raise HTTPException(400, "f and t required")
    supabase.table("pt_edges").delete().eq("plan_id", pid).eq("f", f).eq("t", t).execute()
    return {"ok": True}


# ── PT details ─────────────────────────────────────────────────────────────────
@app.post("/pt/api/details")
async def pt_details_set(request: Request):
    b = await request.json()
    pid = _plan_or_400(b.get("plan"))
    nid = (b.get("node_id") or "").strip()
    if not nid:
        raise HTTPException(400, "node_id required")
    text = (b.get("details") or "").strip()
    if text:
        supabase.table("pt_details").upsert(
            {"plan_id": pid, "node_id": nid, "details": text}
        ).execute()
    else:
        supabase.table("pt_details").delete().eq("plan_id", pid).eq("node_id", nid).execute()
    return {"ok": True}


# ── PT sections ────────────────────────────────────────────────────────────────
# Sections are rows, not registry entries (migrations/006): a plan starts empty
# and whoever owns it draws its own boxes. Ids are generated here rather than
# taken from the client. A node remembers which section it is in by that id,
# so a client-chosen id could collide with a section that already owns tasks.
SECTION_DEFAULT_W = 498.0
SECTION_DEFAULT_H = 523.0
SECTION_MIN_W     = 200.0
SECTION_MIN_H     = 150.0


def _float_or(value, fallback: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


@app.post("/pt/api/sections/add")
async def pt_sections_add(request: Request):
    b = await request.json()
    pid   = _plan_or_400(b.get("plan"))
    label = (b.get("label") or "").strip()
    if not label:
        raise HTTPException(400, "label required")
    row = {
        "plan_id": pid,
        "sec":     "sec_" + uuid.uuid4().hex[:8],
        "label":   label,
        "x":       _float_or(b.get("x"), 48.0),
        "y":       _float_or(b.get("y"), 543.0),
        "w":       max(SECTION_MIN_W, _float_or(b.get("w"), SECTION_DEFAULT_W)),
        "h":       max(SECTION_MIN_H, _float_or(b.get("h"), SECTION_DEFAULT_H)),
    }
    supabase.table("pt_sections").insert(row).execute()
    return {"section": row}


@app.post("/pt/api/sections")
async def pt_sections_set(request: Request):
    """Move, resize or rename one existing section.

    An update rather than an upsert: the only ids that may exist are ones
    /pt/api/sections/add minted, so a stale or invented id has to be a no-op
    instead of quietly creating a box nothing can find its way back to.
    """
    b = await request.json()
    pid = _plan_or_400(b.get("plan"))
    sec = (b.get("sec") or "").strip()
    if not sec:
        raise HTTPException(400, "sec required")

    patch: dict = {}
    for field, floor in (("x", None), ("y", None),
                         ("w", SECTION_MIN_W), ("h", SECTION_MIN_H)):
        if b.get(field) is not None:
            value = _float_or(b.get(field), 0.0)
            patch[field] = max(floor, value) if floor is not None else value
    label = (b.get("label") or "").strip()
    if label:
        patch["label"] = label
    if not patch:
        raise HTTPException(400, "nothing to update")

    supabase.table("pt_sections").update(patch) \
        .eq("plan_id", pid).eq("sec", sec).execute()
    return {"ok": True}


@app.post("/pt/api/sections/delete")
async def pt_sections_delete(request: Request):
    """Remove an empty section.

    Refused while it still holds tasks. Deleting the box would leave them
    pointing at a section that no longer exists, invisible, but still in the
    graph and still counted by the dashboard tile. Emptying it first is a
    deliberate act; cascading the delete would not be.
    """
    b = await request.json()
    pid = _plan_or_400(b.get("plan"))
    sec = (b.get("sec") or "").strip()
    if not sec:
        raise HTTPException(400, "sec required")
    held = supabase.table("pt_nodes").select("id") \
        .eq("plan_id", pid).eq("sec", sec).limit(1).execute().data or []
    if held:
        raise HTTPException(400, "Move or delete this section's tasks first")
    supabase.table("pt_sections").delete().eq("plan_id", pid).eq("sec", sec).execute()
    return {"ok": True}


# ── PT live collaboration (presence, cursors, live sync) ────────────────────────
# One socket endpoint, one room per plan: everything is scoped by the plan id
# the client joins with, or someone dragging a node on the 26/27 plan would
# move a phantom on every screen showing the 25/26 one.
pt_clients: dict = {}  # WebSocket -> {id, name, color, plan} | None

async def _pt_broadcast(payload: dict, plan: str, exclude: Optional[WebSocket] = None):
    dead = []
    for c, meta in list(pt_clients.items()):
        if c is exclude or not meta or meta.get("plan") != plan:
            continue
        try:
            await c.send_json(payload)
        except Exception:
            dead.append(c)
    for d in dead:
        pt_clients.pop(d, None)

async def _pt_presence(plan: str):
    users = [m for m in pt_clients.values() if m and m.get("plan") == plan]
    await _pt_broadcast({"type": "presence", "users": users}, plan)

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
                # The room name is checked against the charts that exist, same
                # as every HTTP write. Unchecked, a client could name any room
                # and be relayed the edits of whoever else guessed that name,
                # and an unknown room is a typo, so it falls back to the legacy
                # chart rather than closing the socket mid-session.
                plan = (data.get("plan") or "").strip()
                pt_clients[ws] = {
                    "id": data.get("id"), "name": data.get("name"), "color": data.get("color"),
                    "plan": plan if _plan_row(plan) else LEGACY_PLAN,
                }
                await _pt_presence(pt_clients[ws]["plan"])
            elif pt_clients.get(ws):
                # relay everything else (cursor, toggle, node_add/move/delete,
                # section) to the sender's plan only. Before join there is no
                # plan to scope to, so pre-join messages are dropped. .get, not
                # [ws]: a failed send during a broadcast evicts dead sockets,
                # and this one may already be gone by the time it speaks again.
                await _pt_broadcast(data, pt_clients[ws]["plan"], exclude=ws)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        meta = pt_clients.pop(ws, None)
        if meta:
            await _pt_presence(meta["plan"])


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


def _require_own_row(request: Request, name: str):
    """You may only write your own attendance. God mode may write anyone's.

    This used to live only in the page. The buttons were hidden for other
    people's rows, but the endpoint took whatever name it was given, so any
    signed-in member could delete anybody's entry with one fetch. Hiding a
    control is not a permission.

    Compared case-folded and whitespace-collapsed, because the name here comes
    from the account while the stored rows predate accounts and were typed by
    hand: "shane whelan" and "Shane  Whelan" are the same person, and treating
    them as different silently locks people out of their own history.
    """
    if is_god(request):
        return
    mine = " ".join(_public_profile(current_profile(request)).get("name", "").split()).lower()
    theirs = " ".join((name or "").split()).lower()
    if mine != theirs:
        raise HTTPException(403, "You can only change your own attendance")


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
    _require_own_row(request, name)
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
    _require_own_row(request, name)
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

def _is_comp_admin(request: Request) -> bool:
    """Committee accounts, and admins with god mode on.

    The shared COMP_ADMIN_PASSWORD used to sit alongside this as a fallback so
    nobody got locked out mid-switchover. It is gone: roles are assignable from
    /admin now, so there is a way to hand out access that isn't a password
    everyone knows and nobody can revoke.

    An admin with god mode *off* does not pass, deliberately. That is how you
    check what an ordinary member sees.
    """
    profile = getattr(request.state, "profile", None) or {}
    return profile.get("role") == "committee" or god_on(profile)


def _require_comp_admin(request: Request):
    if not _is_comp_admin(request):
        raise HTTPException(403, "That's a committee-only action")


def _current_runner() -> str:
    """Whoever declared themselves the shop runner, or ''."""
    try:
        r = supabase.table("comp_meta").select("value").eq("key", "runner").execute()
        return (r.data[0]["value"] if r.data else "") or ""
    except Exception as e:
        logger.error(f"[comp] runner lookup failed: {e}")
        return ""


@app.post("/comp/api/admin/verify")
async def comp_admin_verify(request: Request):
    _require_comp_admin(request)
    return {"ok": True, "by_role": True}

@app.get("/comp/api/roster")
async def comp_roster_get():
    r = supabase.table("comp_roster").select("*").execute()
    return {"roster": r.data or []}

@app.post("/comp/api/roster")
async def comp_roster_add(request: Request):
    b = await request.json()
    _require_comp_admin(request)
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
    _require_comp_admin(request)
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
    # Not b["name"]. Filing a request as somebody else put their name on a row
    # that later becomes a debt in the expenses split.
    name = _me_name(request)
    item = b.get("item","").strip()
    if not name or not item:
        raise HTTPException(400, "item required")
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


def _get_own_pending_request(request: Request, req_id) -> dict:
    """Look up a request and confirm the caller owns it and it's still pending.

    Ownership is decided here from the session, never from the body. It used to
    take a `name` argument that the caller supplied, which meant passing
    somebody else's name was enough to edit or delete their request: the same
    bug, and the same shape of bug, as the attendance one _require_own_row was
    written for. Hiding a control is not a permission.
    """
    r = supabase.table("comp_requests").select("*").eq("id", req_id).execute()
    if not r.data:
        raise HTTPException(404, "Request not found")
    row = r.data[0]
    if not is_god(request) and not _same_person(row["requester"], _me_name(request)):
        raise HTTPException(403, "You can only edit or remove your own requests")
    if row["status"] != "pending":
        raise HTTPException(400, "Already bought. Can't change it now")
    return row


@app.post("/comp/api/requests/edit")
async def comp_requests_edit(request: Request):
    b = await request.json()
    item = (b.get("item") or "").strip()
    if not item:
        raise HTTPException(400, "item required")
    _get_own_pending_request(request, b.get("id"))
    split = [s.strip() for s in (b.get("split_with") or []) if s.strip()]
    supabase.table("comp_requests").update(
        {"item": item, "split_with": split, "quantity": _parse_quantity(b.get("quantity"))}
    ).eq("id", b["id"]).execute()
    return {"ok": True}


@app.post("/comp/api/requests/delete")
async def comp_requests_delete(request: Request):
    b = await request.json()
    req_id = b.get("id")
    _get_own_pending_request(request, req_id)
    supabase.table("comp_requests").delete().eq("id", req_id).execute()
    return {"ok": True}

@app.post("/comp/api/requests/update")
async def comp_requests_update(request: Request):
    """Mark a request bought, price it, or put it back.

    This had NO permission check of any kind, which was the worst of the three:
    price, status and bought_by are the entire input to /comp/api/expenses, so
    any signed-in member could mark anything bought at any price in anyone's
    name and mint a debt owed to themselves.

    The gate is the shop runner, because that is the flow the page actually
    implements: somebody says "I'm going", shops, and enters prices when they
    get back. A committee account can always do it, for the case where whoever
    went shopping never declared themselves.

    Forcing bought_by to the caller is not enough on its own — self-attribution
    IS the attack, since bought_by is the person everyone else ends up owing.
    That is why it is gated on being the runner rather than just stamped.
    """
    b = await request.json()
    req_id = b.get("id")
    if req_id is None:
        # Was a KeyError and a 500 before. The permission check below reads the
        # row first, and a filter on a missing id is not a question worth asking.
        raise HTTPException(400, "id required")
    me  = _me_name(request)
    row = (supabase.table("comp_requests").select("bought_by")
           .eq("id", req_id).execute().data or [{}])[0]

    # The third clause is the undo button. The page draws ↩️ for whoever is
    # recorded as the buyer, and standing down as runner after a shop run is
    # the normal end of one — without this, marking five things bought and then
    # tapping Done locks you out of correcting any of them. It cannot be used to
    # invent a debt: the row already names you as the person who paid.
    if not (_is_comp_admin(request)
            or _same_person(_current_runner(), me)
            or _same_person(row.get("bought_by") or "", me)):
        raise HTTPException(
            403, "Only the shop runner can price a request. Tap \u201cI\u2019m going\u201d first")

    update = {k: b[k] for k in ("price", "status", "bought_by") if k in b}
    if not update:
        raise HTTPException(400, "nothing to update")
    # Never whoever the body names. A runner may price somebody else's request,
    # which is the whole job, but the buyer recorded is the buyer.
    # None is the undo path clearing the field, and must stay None.
    if update.get("bought_by") is not None:
        update["bought_by"] = me
    supabase.table("comp_requests").update(update).eq("id", req_id).execute()
    # Only a status change is feed-worthy. Price edits and re-assignments happen
    # repeatedly on the same request and would drown everything else out.
    if update.get("status") == "bought":
        row = (supabase.table("comp_requests").select("item,requester")
               .eq("id", req_id).execute().data or [{}])[0]
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
    """Declare yourself the shop runner, or stand down.

    Also took a bare name from the body, which mattered more once the runner
    became the gate on pricing above: naming somebody else was a way to hand
    yourself, or take from them, the ability to write prices.

    You may put yourself up and you may clear the slot. A committee account can
    clear anyone, which is what the Unassign button in the page is.
    """
    b = await request.json()
    want = (b.get("name") or "").strip()
    if want and not _is_comp_admin(request) and not _same_person(want, _me_name(request)):
        raise HTTPException(403, "You can only put yourself up as the shop runner")
    if not want and not _is_comp_admin(request):
        # Standing down is yours; unassigning somebody else is the committee's.
        current = _current_runner()
        if current and not _same_person(current, _me_name(request)):
            raise HTTPException(403, "Only the shop runner can stand themselves down")
    supabase.table("comp_meta").upsert({"key": "runner", "value": want}).execute()
    return {"ok": True}


# ── Schedule Events ────────────────────────────────────────────────────────────
@app.get("/comp/api/schedule/events")
async def schedule_events_get():
    r = supabase.table("schedule_events").select("*").order("day").order("sort_order").execute()
    return {"events": r.data or []}


@app.post("/comp/api/schedule/events")
async def schedule_events_add(request: Request):
    b = await request.json()
    _require_comp_admin(request)
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
    _require_comp_admin(request)
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
    _require_comp_admin(request)
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
    # Marks this thread as one that must not touch the shared connection. Set
    # here rather than at pool creation because it is the only thing that makes
    # sb() hand out a private client, and this is the only place that needs it.
    _tile_local.own = True
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
    # leave, and wrongly showing a present person as gone is the worse error,
    # the whole point of this is answering "is anyone in the workshop?".
    photos = _photo_map()
    here = []
    for r in arriving:
        arr = _hm(r.get("time"))
        dep = _hm(r.get("departure_time"))
        if arr and arr <= now_hm and (dep is None or now_hm < dep):
            name = (r.get("name") or "").strip()
            here.append({"name": name, "until": dep,
                         "photo": photos.get(name.lower())})
    here.sort(key=lambda p: p["name"])

    # The last of them out: "until 17:00" means the workshop empties then.
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


def _flowcharts_tile() -> dict:
    """How many charts are on the go. The card is a door to a list, not to one
    chart, so the useful number is the size of the list."""
    rows = sb().table("plans").select("id,archived").execute().data or []
    live = len([r for r in rows if not r.get("archived")])
    if not rows:
        return {"charts": 0, "detail": "no charts yet"}
    return {"charts": live,
            "detail": f"{live} chart{'' if live == 1 else 's'}" if live
                      else "all archived"}


def _pt_tile() -> dict:
    # One chart's numbers, not all charts mashed together. An empty
    # next-season plan would otherwise drag the live build's figure to nonsense.
    nodes = sb().table("pt_nodes").select("id").eq("plan_id", DASHBOARD_PLAN).execute().data or []
    done  = sb().table("pt_done").select("node_id").eq("plan_id", DASHBOARD_PLAN).execute().data or []
    prog  = sb().table("pt_progress").select("node_id").eq("plan_id", DASHBOARD_PLAN).execute().data or []
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
    r = sb().table("harness_doc").select("updated_at") \
        .eq("id", HARNESS_DOC_ID).execute()
    if not r.data:
        return {"updated_at": None, "detail": "not started"}
    ts = r.data[0].get("updated_at")
    return {"updated_at": ts, "detail": "last edited " + _ago(ts) if ts else "saved"}


def _comp_tile() -> dict:
    reqs   = sb().table("comp_requests").select("status").execute().data or []
    events = sb().table("schedule_events").select("id").execute().data or []
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
# before 002 is applied. Attendance is deliberately not in here: twenty people
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
    rows = sb().table("pt_done_log").select("id,plan_id,node_id,done,user_name,created_at") \
        .order("created_at", desc=True).limit(limit).execute().data or []
    if not rows:
        return []
    # Node ids are only unique within a plan, so the label lookup is keyed by
    # both, or a 26/27 node could borrow a 25/26 node's name in the feed.
    labels = {(n.get("plan_id"), n["id"]): n.get("label") for n in
              (sb().table("pt_nodes").select("plan_id,id,label").execute().data or [])}
    return [{
        # id + source are what the feed's delete needs to name one line out of
        # two merged tables. They are not secret, since every row is already on the
        # page, and nothing but an elevated admin can act on them.
        "id":         r.get("id"),
        "source":     "pt_done_log",
        # Credited to the card that opens this chart when one exists (last
        # season's plans have their own), and otherwise to the flowcharts tool,
        # which is where the chart was drawn.
        "applet":     APPLET_BY_PLAN.get(r.get("plan_id"), "flowcharts"),
        "actor":      r.get("user_name") or "Someone",
        "verb":       "ticked off" if r.get("done") else "un-ticked",
        # Falls back to the raw id for a node that has since been deleted.
        "subject":    labels.get((r.get("plan_id"), r.get("node_id"))) or r.get("node_id") or "",
        "created_at": r.get("created_at"),
    } for r in rows]


def _general_activity(limit: int) -> list:
    rows = sb().table("activity_log").select("id,applet,actor,verb,subject,created_at") \
        .order("created_at", desc=True).limit(limit).execute().data or []
    return [{**r, "source": "activity_log"} for r in rows]


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
    # Seven independent tiles, each a few blocking round trips. Run one after
    # another they came to about 700ms, which is most of the wait the dashboard
    # sits behind its veil for. Nothing here depends on anything else here.
    #
    # A bounded pool, not asyncio.to_thread, for two reasons. It caps how many
    # private clients exist at _TILE_WORKERS, and it keeps tile work off the
    # threadpool uvicorn runs sync endpoints in, so a slow dashboard cannot eat
    # the workers another request needs.
    #
    # Each call is still wrapped in _tile, so a tile that raises is still None
    # and the rest of the dashboard still draws. gather never sees an exception
    # and needs no return_exceptions.
    loop = asyncio.get_running_loop()
    countdown, activity, attendance, flowcharts, pt, harness, comp = await asyncio.gather(*(
        loop.run_in_executor(_tile_pool, _tile, fn)
        for fn in (_countdown, _activity, _attendance_tile, _flowcharts_tile,
                   _pt_tile, _harness_tile, _comp_tile)
    ))
    return {
        # Dublin, not the container's clock, which is UTC, so date.today()
        # here would report yesterday between midnight and 1am in summer,
        # disagreeing with the day the tiles below are actually describing.
        "date":      datetime.now(TEAM_TZ).date().isoformat(),
        "countdown": countdown,
        "activity":  activity or [],
        "tiles": {
            "attendance": attendance,
            "flowcharts": flowcharts,
            "pt":         pt,
            "harness":    harness,
            "comp":       comp,
        },
    }

