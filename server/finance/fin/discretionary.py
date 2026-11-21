"""Discretionary spending for the page: the money you chose to spend, as opposed to bills, family and the loan.

  months  per month: total, by category (after your re-filing moves), top merchants (name, amount, count)
  weeks   Monday-start weeks for the last ~10 weeks, so a blow-out shows mid-month
Moves made on the page (e.g. solar cash → Housing) are taken out of the weeks too, from that category's largest
weeks in the month first.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date, timedelta

import os

from . import categorise

DEFAULT_TARGET = float(os.environ.get("FIN_DISC_TARGET", 500))   # until budgets cover the discretionary categories
CATS = ["Dining out", "Shopping", "Entertainment", "Travel", "Cash withdrawals", "Buy now, pay later", "Other"]


def build(con, s: dict) -> dict | None:
    bank = s.get("bank") or []
    if not bank:
        return None
    rules = categorise.load_rules(con)
    adj = [dict(r) for r in con.execute("SELECT * FROM adjust")]
    rows = [(date.fromisoformat(t["d"]), t["amount"], t["desc"])
            for t in con.execute("SELECT t.d, t.amount, t.desc FROM txns t JOIN accounts a ON a.key=t.account WHERE a.kind='bank'")]
    tagged = [(d, a, desc, categorise.category(desc, a, rules)) for d, a, desc in rows]

    months = []
    for r in bank[-12:]:
        by = {c: round(r["by"].get(c, 0), 2) for c in CATS if abs(r["by"].get(c, 0)) >= 0.5}
        top, cnt = Counter(), Counter()
        for d, a, desc, c in tagged:
            if d.strftime("%Y-%m") == r["m"] and c in CATS and c not in ("Cash withdrawals", "Buy now, pay later") and a < 0:
                k, kind = categorise.describe(desc)
                if kind != "merchant":
                    continue          # people are categorised by you, not ranked as merchants
                words = []
                for w in k.title().split():
                    if not words or words[-1] != w:
                        words.append(w)
                name = " ".join(words)
                top[name] += -a
                cnt[name] += 1
        months.append({"m": r["m"], "total": round(sum(by.values()), 2), "by": by,
                       "top": [{"name": n, "amount": round(v, 2), "count": cnt[n]} for n, v in top.most_common(10)]})

    # weeks (Monday start), last 10 including the current one
    last = max(d for d, *_ in tagged) if tagged else date.today()
    start = last - timedelta(days=last.weekday()) - timedelta(weeks=9)
    buckets = defaultdict(lambda: defaultdict(float))     # week -> category -> spend
    for d, a, desc, c in tagged:
        if d >= start and c in CATS:
            wk = d - timedelta(days=d.weekday())
            buckets[wk][c] -= a
    for x in adj:   # moves out of a discretionary category: take them off that month's biggest weeks first
        if x["from_cat"] not in CATS or x["to_cat"] in CATS:
            continue
        left = x["amount"]
        weeks_in_month = sorted((wk for wk in buckets if wk.strftime("%Y-%m") == x["m"] or (wk + timedelta(days=6)).strftime("%Y-%m") == x["m"]),
                                key=lambda wk: -buckets[wk][x["from_cat"]])
        for wk in weeks_in_month:
            take = min(left, max(0.0, buckets[wk][x["from_cat"]]))
            buckets[wk][x["from_cat"]] -= take
            left -= take
            if left <= 0:
                break
    weeks = []
    for i in range(10):
        wk = start + timedelta(weeks=i)
        b = buckets.get(wk, {})
        weeks.append({"start": wk.isoformat(), "total": round(sum(b.values()), 2),
                      "by": {c: round(v, 2) for c, v in b.items() if v >= 0.5}, "partial": wk + timedelta(days=6) > last})
    budgets = s.get("budgets") or {}
    set_ = {c: b for c, b in budgets.items() if c in CATS and b is not None}
    target = sum(set_.values()) if len(set_) >= 3 else DEFAULT_TARGET
    return {"target": target, "target_from": "budgets" if len(set_) >= 3 else "default", "weekly_target": round(target * 12 / 52, 2),
            "categories": CATS, "months": months, "weeks": weeks}
