"""Macquarie transactions via Redbark (open banking, read-only consent) instead of PDF uploads.

API v2 (https://redbark.com/docs/api-reference/v2/overview): Bearer key + Redbark-Version header, token pagination via
next_page_url, money as integer minor units. The key lives in ~/finance/.secrets/redbark_token (mode 600); if it's
missing this module does nothing.

Each banking account is kept as one raw file, data/raw/rb-<account>.json (mode 600): the account, its last balance,
and every posted transaction seen so far (keyed by Redbark id). The normal rebuild parses these like any upload.
Nothing here is logged except counts.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

from . import config

API = os.environ.get("FIN_REDBARK_API", "https://api.redbark.com/v2")
VERSION = "2026-10-01.wattle"
TOKEN_FILE = config.SECRETS / "redbark_token"
EVERY_S = 6 * 3600            # fetch at most every 6 hours (transactions are cached up to 60 min anyway)
FIRST_DAYS = 730              # first fetch: two years back
OVERLAP_DAYS = 14             # later fetches re-read the last fortnight to catch late postings


def enabled() -> bool:
    return TOKEN_FILE.exists() and TOKEN_FILE.read_text().strip() != ""


def _get(url: str, params: dict | None = None) -> dict:
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    req = urllib.request.Request(url if url.startswith("http") else API + url, headers={
        "Authorization": f"Bearer {TOKEN_FILE.read_text().strip()}", "Redbark-Version": VERSION,
        "Accept": "application/json", "User-Agent": "finance-sync"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < 3:
                time.sleep(min(60, int(e.headers.get("Retry-After") or 10)))
                continue
            try:
                code = json.loads(e.read()).get("error", {}).get("code")
            except Exception:  # noqa: BLE001
                code = None
            raise RuntimeError(f"Redbark HTTP {e.code} ({code or 'no code'})") from None
    raise RuntimeError("Redbark: gave up after retries")


def _all(path: str, params: dict) -> list[dict]:
    out, page = [], _get(path, params)
    while True:
        out += page.get("data") or []
        nxt = page.get("next_page_url")
        if not nxt:
            return out
        page = _get(nxt)


def raw_path(acct_id: str):
    safe = hashlib.sha256(acct_id.encode()).hexdigest()[:16]
    return config.RAW / f"rb-{safe}.json"


def sync(con, force: bool = False) -> tuple[int, int]:
    """Fetch new posted transactions for every Redbark banking account. Returns (accounts, new transactions)."""
    from . import model
    if not enabled():
        return 0, 0
    last = model.kv_get(con, "redbark_at")
    if not force and last and time.time() - last < EVERY_S:
        return 0, 0
    accounts = [a for a in _all("/accounts", {"limit": 100}) if a.get("category") == "banking" and a.get("status") != "unavailable"]
    balances = {}
    if accounts:
        for b in _get("/balances", {"account": [a["id"] for a in accounts]}).get("data") or []:
            balances[b.get("account")] = b
    new_total = 0
    for a in accounts:
        p = raw_path(a["id"])
        doc = json.loads(p.read_text()) if p.exists() else {"transactions": {}}
        start = date.today() - timedelta(days=FIRST_DAYS)
        if doc["transactions"]:
            start = max(start, date.fromisoformat(max(t["date"] for t in doc["transactions"].values())) - timedelta(days=OVERLAP_DAYS))
        txns = _all("/transactions", {"account": a["id"], "from": start.isoformat(), "limit": 100})
        before = len(doc["transactions"])
        for t in txns:
            if t.get("status") == "posted":
                doc["transactions"][t["id"]] = {k: t.get(k) for k in ("date", "post_date", "description", "amount", "direction",
                                                                      "merchant_name", "payee", "payer", "provider_category")}
        new_total += len(doc["transactions"]) - before
        doc["account"] = {k: a.get(k) for k in ("id", "name", "type", "account_number", "currency")}
        doc["account"]["institution"] = (a.get("institution") or {}).get("name")
        b = balances.get(a["id"])
        if b and b.get("current") is not None:
            doc["balance"] = {"amount": b["current"]["amount"], "observed_at": b.get("observed_at") or datetime.now(timezone.utc).isoformat(),
                              "freshness": b.get("freshness")}
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(doc, f)
        fid = p.stem
        # registered like an upload so rebuild() reads it; 'received' sorts it after the PDFs it replaces
        con.execute("INSERT INTO files VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
                    (fid, "redbark", "9999-redbark", "new", None, 0, "json", None))
    model.kv_set(con, "redbark_at", time.time())
    con.commit()
    return len(accounts), new_total
