"""SQLite store, rebuild from raw files, the balance model, and the summary the page reads.

The transaction tables are rebuilt from every raw file each time something changes, so improving a parser and
running `python -m fin.sync --rebuild` re-reads history. Rules (categories you confirmed), budgets and email state
are kept across rebuilds.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from calendar import monthrange
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta

from . import categorise, config, parsers

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, type TEXT, received TEXT, status TEXT, reason TEXT, rows INTEGER, ext TEXT, sha TEXT);
CREATE TABLE IF NOT EXISTS accounts (key TEXT PRIMARY KEY, label TEXT, kind TEXT);
CREATE TABLE IF NOT EXISTS txns (uid TEXT PRIMARY KEY, account TEXT, d TEXT, amount REAL, desc TEXT, kind TEXT, balance REAL, file TEXT);
CREATE TABLE IF NOT EXISTS points (account TEXT, d TEXT, balance REAL, PRIMARY KEY (account, d));
CREATE TABLE IF NOT EXISTS periods (account TEXT, start TEXT, end TEXT, opening REAL, net_in REAL, closing REAL, PRIMARY KEY (account, start, end));
CREATE TABLE IF NOT EXISTS rules (key TEXT PRIMARY KEY, id TEXT UNIQUE, category TEXT, source TEXT, confirmed INTEGER, seen INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS budgets (cat TEXT PRIMARY KEY, amount INTEGER);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS manual (id TEXT PRIMARY KEY, kind TEXT, d TEXT, amount REAL);   -- balances typed on the page
CREATE TABLE IF NOT EXISTS adjust (id TEXT PRIMARY KEY, m TEXT, from_cat TEXT, to_cat TEXT, amount REAL, note TEXT);   -- moves made on the page
"""


def connect() -> sqlite3.Connection:
    con = sqlite3.connect(config.DB)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    config.DB.chmod(0o600)
    return con


def kv_get(con, k, default=None):
    r = con.execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
    return json.loads(r[0]) if r else default


def kv_set(con, k, v):
    con.execute("INSERT INTO kv VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, json.dumps(v)))


def raw_path(file_id: str, ext: str):
    return config.RAW / f"{file_id}.{ext}"


# ---------- rebuild ----------
def rebuild(con) -> dict[str, tuple[str, str | None, int]]:
    """Re-read every stored raw file. Returns {file id: (status, reason, rows)}."""
    for t in ("txns", "points", "periods", "accounts"):   # all derived from the raw files
        con.execute(f"DELETE FROM {t}")
    results = {}
    redbark = []
    for f in con.execute("SELECT * FROM files ORDER BY received").fetchall():
        p = raw_path(f["id"], f["ext"])
        if not p.exists():
            continue
        try:
            parsed = parsers.parse(f["type"], p.read_bytes())
        except parsers.Unrecognised as e:
            results[f["id"]] = ("rejected", str(e), 0)
            continue
        except Exception as e:  # noqa: BLE001 – a parser bug must not stop the other files
            results[f["id"]] = ("rejected", f"parser error ({type(e).__name__})", 0)
            continue
        if f["type"] == "redbark":
            redbark.append((f["id"], parsed))
        else:
            store(con, f["id"], parsed)
        results[f["id"]] = ("processed", None, parsed.rows())
    # Open-banking data wins from its first transaction on: drop PDF/CSV rows for the same account from then.
    for fid, parsed in redbark:
        if parsed.txns:
            first = min(t.d for t in parsed.txns).isoformat()
            key = parsed.account[0]
            con.execute("DELETE FROM txns WHERE account=? AND d>=? AND file<>?", (key, first, fid))
            con.execute("DELETE FROM points WHERE account=? AND d>=?", (key, first))
        store(con, fid, parsed)
    # balances typed on the page (super has no balance in its CSV); a typed balance wins over a parsed one that day
    keys = {"super": (parsers.SUPER_KEY, "Vanguard Super"), "invest": (parsers.VPI_KEY, "Personal Investor")}
    for r in con.execute("SELECT kind, d, amount FROM manual ORDER BY d").fetchall():
        key, label = keys[r["kind"]]
        con.execute("INSERT OR IGNORE INTO accounts VALUES (?,?,?)", (key, label, r["kind"]))
        con.execute("INSERT INTO points VALUES (?,?,?) ON CONFLICT(account, d) DO UPDATE SET balance=excluded.balance", (key, r["d"], r["amount"]))
    for fid, (status, reason, rows) in results.items():
        con.execute("UPDATE files SET status=?, reason=?, rows=? WHERE id=?", (status, reason, rows, fid))
    con.commit()
    return results


def store(con, file_id: str, p: parsers.Parsed) -> None:
    key, label, kind = p.account
    con.execute("INSERT INTO accounts VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET label=excluded.label, kind=excluded.kind", (key, label, kind))
    seen = Counter()
    for t in p.txns:
        base = f"{key}|{t.d}|{t.amount:.2f}|{t.desc}|{'' if t.balance is None else f'{t.balance:.2f}'}"
        seen[base] += 1
        uid = hashlib.sha256(f"{base}|{seen[base]}".encode()).hexdigest()[:24]
        con.execute("INSERT OR IGNORE INTO txns VALUES (?,?,?,?,?,?,?,?)", (uid, key, t.d.isoformat(), t.amount, t.desc, t.kind, t.balance, file_id))
    for pt in p.points:
        con.execute("INSERT INTO points VALUES (?,?,?) ON CONFLICT(account, d) DO UPDATE SET balance=excluded.balance", (key, pt.d.isoformat(), pt.balance))
    for pr in p.periods:
        con.execute("INSERT OR REPLACE INTO periods VALUES (?,?,?,?,?,?)", (key, pr.start.isoformat(), pr.end.isoformat(), pr.opening, pr.net_in, pr.closing))


# ---------- months ----------
def month_key(d: date) -> str:
    return f"{d.year}-{d.month:02d}"


def month_end(m: str) -> date:
    y, mo = map(int, m.split("-"))
    return date(y, mo, monthrange(y, mo)[1])


def month_start(m: str) -> date:
    y, mo = map(int, m.split("-"))
    return date(y, mo, 1)


def month_range(first: date, last: date) -> list[str]:
    out, y, m = [], first.year, first.month
    while (y, m) <= (last.year, last.month):
        out.append(f"{y}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


# ---------- balance model ----------
class Account:
    """Month-end balance from known points, flows in between, and growth spread evenly between points."""

    def __init__(self, kind: str, points: list[tuple[date, float]], flows: list[tuple[date, float]], periods: list[tuple[date, date, float]]):
        self.kind = kind
        self.points = sorted(points)
        self.flows = sorted(flows)
        self.periods = periods          # (start, end, net_in): spread evenly over the days
        firsts = [p[0] for p in self.points] + [f[0] for f in self.flows] + [p[0] for p in periods]
        self.first = min(firsts) if firsts else None

    def flow(self, d0: date, d1: date) -> float:
        """Net money in during (d0, d1]."""
        if d1 <= d0:
            return -self.flow(d1, d0)
        total = sum(a for d, a in self.flows if d0 < d <= d1)
        for s, e, net in self.periods:
            days = (e - s).days + 1
            lo, hi = max(s, d0 + timedelta(days=1)), min(e, d1)
            if hi >= lo:
                total += net * ((hi - lo).days + 1) / days
        return total

    def balance(self, d: date) -> tuple[float | None, bool | str]:
        """(balance at end of d, how it's known): False = a real balance that day; 'between' = estimated between two
        known balances (growth spread evenly); 'flows' = only money in/out applied to one known balance, so the
        market growth in that stretch is unknown."""
        before = [p for p in self.points if p[0] <= d]
        after = [p for p in self.points if p[0] > d]
        if before and before[-1][0] == d:
            return before[-1][1], False
        if self.kind in ("bank", "loan"):
            return (before[-1][1], False) if before else (None, False)
        if before and after:
            (d0, b0), (d1, b1) = before[-1], after[0]
            growth = b1 - b0 - self.flow(d0, d1)
            return b0 + self.flow(d0, d) + growth * (d - d0).days / (d1 - d0).days, "between"
        if before:
            d0, b0 = before[-1]
            return b0 + self.flow(d0, d), "flows"
        if after and self.first and d >= self.first - timedelta(days=1):
            d1, b1 = after[0]
            return b1 - self.flow(d, d1), "flows"
        return None, False


def _account(con, key: str, kind: str, flow_kinds: tuple[str, ...] | None) -> Account:
    pts = [(date.fromisoformat(r["d"]), r["balance"]) for r in con.execute("SELECT d, balance FROM points WHERE account=?", (key,))]
    flows = []
    if flow_kinds:
        flows = [(date.fromisoformat(r["d"]), r["amount"]) for r in con.execute(
            f"SELECT d, amount FROM txns WHERE account=? AND kind IN ({','.join('?' * len(flow_kinds))})", (key, *flow_kinds))]
    pers = [(date.fromisoformat(r["start"]), date.fromisoformat(r["end"]), r["net_in"]) for r in con.execute("SELECT * FROM periods WHERE account=?", (key,))]
    if kind == "invest":
        flows += investing_from_bank(con, pers, flows)
    return Account(kind, pts, flows, pers)


def investing_from_bank(con, periods, own_flows) -> list[tuple[date, float]]:
    """Money into Personal Investor as seen from the bank side: Vanguard direct debits on the Macquarie accounts
    (out of the bank = into Vanguard). Used only for dates no Vanguard report or Vanguard CSV already covers,
    so a deposit is never counted twice. Super is a different Vanguard product but isn't paid from the bank."""
    covered = [(s, e) for s, e, _ in periods]
    if own_flows:
        covered.append((min(d for d, _ in own_flows), max(d for d, _ in own_flows)))
    out = []
    for r in con.execute("SELECT t.d, t.amount, t.desc FROM txns t JOIN accounts a ON a.key=t.account WHERE a.kind='bank'"):
        if "vanguard" not in r["desc"].lower() or "super" in r["desc"].lower():
            continue
        d = date.fromisoformat(r["d"])
        if not any(s <= d <= e for s, e in covered):
            out.append((d, -r["amount"]))        # −$200 in the bank = +$200 into Personal Investor
    return out


SUPER_FLOW = ("sg", "salsac", "personal", "rollin", "tax", "fees", "insurance", "other")


# ---------- summary ----------
def summary(con) -> dict:
    accts = [dict(r) for r in con.execute("SELECT * FROM accounts")]
    by_kind = defaultdict(list)
    for a in accts:
        by_kind[a["kind"]].append(a)
    dates = [date.fromisoformat(r[0]) for r in con.execute("SELECT d FROM txns UNION SELECT d FROM points UNION SELECT end FROM periods") if r[0]]
    if not dates:
        return {"months": [], "accounts": [], "categories": config.SPEND_CATEGORIES, "budgets": budgets(con), "review": review(con)}
    last = max(dates)
    # start at the first real activity, not at an opening-balance point the day before it
    starts = [date.fromisoformat(r[0]) for r in con.execute("SELECT min(d) FROM txns UNION SELECT min(start) FROM periods") if r[0]]
    first = max(min(starts) if starts else min(dates), date(last.year - 2, last.month, 1))
    months = month_range(first, last)[-config.MONTHS_SHOWN:]
    as_of = {}
    for kind, items in by_kind.items():
        keys = [a["key"] for a in items]
        q = ",".join("?" * len(keys))
        r = con.execute(f"SELECT max(d) FROM (SELECT d FROM txns WHERE account IN ({q}) UNION SELECT d FROM points WHERE account IN ({q}) UNION SELECT end AS d FROM periods WHERE account IN ({q}))", keys * 3).fetchone()
        as_of[kind] = r[0]

    def month_end_capped(m: str) -> date:
        return min(month_end(m), last)

    # --- super ---
    sup = []
    for a in by_kind.get("super", []):
        model = _account(con, a["key"], "super", SUPER_FLOW)
        for m in months:
            sums = defaultdict(float)
            for r in con.execute("SELECT kind, sum(amount) s FROM txns WHERE account=? AND substr(d,1,7)=? GROUP BY kind", (a["key"], m)):
                sums[r["kind"]] = r["s"]
            prev_end = month_start(m) - timedelta(days=1)
            o, oe = model.balance(prev_end)
            c, ce = model.balance(month_end_capped(m))
            sup.append({"m": m, "open": _r(o), "close": _r(c), "est": bool(oe or ce), "nogrowth": "flows" in (oe, ce),
                        "sg": _r(sums["sg"]), "salsac": _r(sums["salsac"]), "personal": _r(sums["personal"]), "rollin": _r(sums["rollin"]),
                        "tax": _r(-sums["tax"]), "fees": _r(-sums["fees"]), "insurance": _r(-sums["insurance"])})
        break   # one super account

    # --- personal investor ---
    inv = []
    for a in by_kind.get("invest", []):
        model = _account(con, a["key"], "invest", ("deposit", "withdrawal"))
        for m in months:
            prev_end = month_start(m) - timedelta(days=1)
            net = model.flow(prev_end, month_end_capped(m))
            dist = con.execute("SELECT coalesce(sum(amount),0) FROM txns WHERE account=? AND kind='distribution' AND substr(d,1,7)=?", (a["key"], m)).fetchone()[0]
            o, oe = model.balance(prev_end)
            c, ce = model.balance(month_end_capped(m))
            inv.append({"m": m, "open": _r(o), "close": _r(c), "est": bool(oe or ce), "nogrowth": "flows" in (oe, ce),
                        "deposits": _r(max(net, 0)), "withdrawals": _r(max(-net, 0)), "distributions": _r(dist)})
        break

    # --- home loan(s): balance is negative (owed) ---
    loan = []
    for m in months:
        row = {"m": m, "close": None, "drawn": 0.0, "repaid": 0.0, "interest": 0.0, "fees": 0.0}
        for a in by_kind.get("loan", []):
            c, _ = _account(con, a["key"], "loan", None).balance(month_end_capped(m))
            if c is not None:
                row["close"] = (row["close"] or 0) + c
            for r in con.execute("SELECT kind, sum(amount) s FROM txns WHERE account=? AND substr(d,1,7)=? GROUP BY kind", (a["key"], m)):
                k = {"drawdown": "drawn", "repayment": "repaid", "interest": "interest", "fee": "fees"}.get(r["kind"])
                if k:
                    row[k] += abs(r["s"])
        loan.append({k: _r(v) if isinstance(v, float) else v for k, v in row.items()})
    if not by_kind.get("loan"):
        loan = []

    # --- Macquarie offset/transaction accounts combined ---
    bank = []
    rules = categorise.load_rules(con)
    bank_keys = [a["key"] for a in by_kind.get("bank", [])]
    for m in months:
        row = {"m": m, "close": None, "income": 0.0, "spend": 0.0, "transfers": 0.0, "by": defaultdict(float)}
        for k in bank_keys:
            c, _ = _account(con, k, "bank", None).balance(month_end_capped(m))
            if c is not None:
                row["close"] = (row["close"] or 0) + c
            for t in con.execute("SELECT amount, desc FROM txns WHERE account=? AND substr(d,1,7)=?", (k, m)):
                cat = categorise.category(t["desc"], t["amount"], rules)
                if cat == config.INCOME:
                    row["income"] += t["amount"]
                elif cat == config.TRANSFER:
                    if t["amount"] < 0:
                        row["transfers"] -= t["amount"]
                else:
                    row["spend"] -= t["amount"]          # refunds (positive) reduce spending
                    row["by"][cat] -= t["amount"]
        apply_adjustments(con, m, row)
        row["by"] = {c: _r(v) for c, v in row["by"].items() if abs(v) >= 0.5}
        bank.append({k: _r(v) if isinstance(v, float) else v for k, v in row.items()})
    if not bank_keys:
        bank = []

    # --- net worth ---
    nw = []
    for i, m in enumerate(months):
        parts = {"super": sup[i]["close"] if sup else None, "invest": inv[i]["close"] if inv else None,
                 "bank": bank[i]["close"] if bank else None, "loan": loan[i]["close"] if loan else None}
        have = {k: v for k, v in parts.items() if v is not None}
        expected = [k for k, lst in (("super", sup), ("invest", inv), ("bank", bank), ("loan", loan)) if lst]
        nw.append({"m": m, **{k: _r(v) for k, v in parts.items()}, "total": _r(sum(have.values())) if have else None,
                   "partial": len(have) < len(expected)})

    labels = {a["kind"]: a["label"] for a in accts}
    return {
        "generated": datetime.now().astimezone().isoformat(timespec="seconds"),
        "months": months, "asOf": as_of,
        "accounts": [{"k": k, "label": {"bank": "Macquarie", "loan": "Home loan", "super": labels.get("super", "Super"),
                                        "invest": labels.get("invest", "Personal Investor")}[k]}
                     for k, lst in (("super", sup), ("invest", inv), ("bank", bank), ("loan", loan)) if lst],
        "networth": nw, "super": sup, "invest": inv, "loan": loan, "bank": bank,
        "categories": config.SPEND_CATEGORIES, "budgets": budgets(con), "review": review(con),
        "adjustments": [{"id": r["id"], "m": r["m"], "from": r["from_cat"], "to": r["to_cat"], "amount": r["amount"], "note": r["note"]}
                        for r in con.execute("SELECT * FROM adjust ORDER BY m, id") if r["m"] in months],
    }


def apply_adjustments(con, m: str, row: dict) -> None:
    """Moves you made on the page: part of a month's spending re-filed under another category.
    Moving to Transfer or Income takes it out of spending. To Income means "this payment was really my share of
    some income going back out" (e.g. splitting a car sale), so it lowers income rather than raising it."""
    for a in con.execute("SELECT * FROM adjust WHERE m=?", (m,)):
        amt, src, dst = a["amount"], a["from_cat"], a["to_cat"]
        row["by"][src] = row["by"].get(src, 0) - amt
        if dst in config.SPEND_CATEGORIES:
            row["by"][dst] = row["by"].get(dst, 0) + amt
        else:
            row["spend"] -= amt
            if dst == config.TRANSFER:
                row["transfers"] += amt
            else:
                row["income"] -= amt


def _r(v):
    return None if v is None else round(v, 2)


def budgets(con) -> dict:
    return {r["cat"]: r["amount"] for r in con.execute("SELECT * FROM budgets")}


def review(con) -> list[dict]:
    return [{"id": r["id"], "merchant": r["key"], "count": r["seen"], "suggested": r["category"]}
            for r in con.execute("SELECT * FROM rules WHERE confirmed=0 ORDER BY seen DESC, key LIMIT 40")]
