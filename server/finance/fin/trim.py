"""Harsh monthly trim review: where last month's money leaked, in plain words. Shown on the page (behind Access);
the email only says it's ready. Rule-based, no LLM: it reads the same summary rows and transactions the page uses.

Targets come from the plan agreed in Nov 2026 and can be overridden with env vars on the server.
"""

from __future__ import annotations

import os
from collections import Counter, defaultdict
from statistics import median

from . import categorise, config

LIVING_TARGET = float(os.environ.get("FIN_LIVING_TARGET", 1200))     # everyday spending per month
SAVE_TARGET = float(os.environ.get("FIN_SAVE_TARGET", 1000))         # into the offset per month
NOT_LIVING = {"Family", "Utilities", "Housing"}                       # committed, reviewed separately
DISCRETIONARY = {"Dining out", "Shopping", "Entertainment", "Travel", "Other", "Cash withdrawals", "Buy now, pay later"}
FAST_FOOD = ("MCDONALD", "KFC", "GUZMAN", "GYG", "UBER EATS", "SUSHI", "KEBAB", "BURGER", "HUNGRY", "DOMINO", "PIZZA",
             "SUBWAY", "RED ROOSTER", "MENULOG", "DOORDASH", "HJS")


def money(v: float) -> str:
    return f"${abs(v):,.0f}"


def review(con, s: dict) -> dict | None:
    """The review for the last full month in the summary (the current month is still running)."""
    bank = s.get("bank") or []
    if len(bank) < 2:
        return None
    row, prev = bank[-2], bank[-3] if len(bank) >= 3 else None
    m = row["m"]
    budgets = s.get("budgets") or {}
    rules = categorise.load_rules(con)
    items = []

    def add(level, title, detail):
        items.append({"level": level, "title": title, "detail": detail})

    # transactions in the month, with categories
    txns = [(t["d"], t["amount"], t["desc"], categorise.category(t["desc"], t["amount"], rules))
            for t in con.execute("SELECT t.d, t.amount, t.desc FROM txns t JOIN accounts a ON a.key=t.account "
                                 "WHERE a.kind='bank' AND substr(t.d,1,7)=?", (m,))]
    by = row["by"]

    # 1. the two habits that were meant to stop
    cash = by.get("Cash withdrawals", 0)
    if cash > 0:
        n = sum(1 for _, a, _, c in txns if c == "Cash withdrawals" and a < 0 and a <= -10)
        add("bad", f"Cash: {money(cash)} in {n} withdrawal{'s' if n != 1 else ''}. Budget: $0.",
            "Cash is spending you can't see. If it paid for something real, re-file it on the spending chart. If you can't say what it bought, that's the leak.")
    bnpl = by.get("Buy now, pay later", 0)
    if bnpl > 0:
        add("bad", f"Buy now, pay later: {money(bnpl)}.",
            "That's next month's pay already spent. Finish the instalments and close Zip and PayPal Pay in 4.")

    # 2. every budget blown
    for cat, b in sorted(budgets.items()):
        if cat in ("Cash withdrawals", "Buy now, pay later"):
            continue
        v = by.get(cat, 0)
        if b is not None and v > b:
            add("bad" if v > b * 1.2 else "warn", f"{cat}: {money(v)} against a {money(b)} budget, {money(v - b)} over.",
                "Either the budget is fantasy or the spending is. Pick one and fix it.")

    # 3. takeaway runs
    ff = [(a, d) for d, a, desc, c in txns if a < 0 and any(k in categorise.describe(desc)[0] for k in FAST_FOOD)]
    if len(ff) >= 4:
        add("warn", f"Takeaway: {len(ff)} runs, {money(-sum(a for a, _ in ff))}.",
            f"About one every {max(1, round(30 / len(ff)))} days. Each one feels small. Together they're a week of groceries.")

    # 4. everyday living vs the target
    living = sum(v for c, v in by.items() if c not in NOT_LIVING)
    if living > LIVING_TARGET:
        add("bad" if living > LIVING_TARGET * 1.25 else "warn", f"Everyday spending: {money(living)} against a {money(LIVING_TARGET)} target.",
            f"{money(living - LIVING_TARGET)} over. That's money that should have gone into the offset.")
    else:
        add("ok", f"Everyday spending: {money(living)}, inside the {money(LIVING_TARGET)} target.", "Good. Do it again.")

    # 5. did the offset actually grow?
    if prev and row.get("close") is not None and prev.get("close") is not None:
        grew = row["close"] - prev["close"]
        if grew < SAVE_TARGET:
            add("bad" if grew < 0 else "warn", f"Offset {'shrank' if grew < 0 else 'grew'} {money(grew)}; target was +{money(SAVE_TARGET)}.",
                "This is the only number that matters for the buffer. Everything above explains why it missed.")
        else:
            add("ok", f"Offset grew {money(grew)}, at or above the +{money(SAVE_TARGET)} target.", "On track.")

    # 6. subscriptions: the same merchant, a similar small amount, in 2 of the last 3 months
    months = [r["m"] for r in bank[-4:-1]]
    seen = defaultdict(lambda: defaultdict(list))
    for t in con.execute("SELECT t.d, t.amount, t.desc FROM txns t JOIN accounts a ON a.key=t.account WHERE a.kind='bank' AND t.amount<0 AND t.amount>-150"):
        if t["d"][:7] in months:
            k, kind = categorise.describe(t["desc"])
            if kind == "merchant" and not any(f in k for f in FAST_FOOD) and categorise.builtin(k) not in ("Cash withdrawals", "Buy now, pay later"):
                seen[k][t["d"][:7]].append(-t["amount"])
    subs = []
    for k, per in seen.items():
        if len(per) >= 2 and all(len(v) == 1 for v in per.values()):
            amts = [v[0] for v in per.values()]
            if max(amts) - min(amts) <= 0.1 * median(amts) + 0.5:
                subs.append((median(amts), k))
    if subs:
        subs.sort(reverse=True)
        add("warn", f"Subscriptions: {len(subs)} recurring, about {money(sum(a for a, _ in subs))} a month.",
            "; ".join(f"{k.title()} {money(a)}" for a, k in subs[:10]) + ". Anything you didn't use last month, cancel today.")

    # 7. biggest discretionary hits
    top = Counter()
    for d, a, desc, c in txns:
        if a < 0 and c in DISCRETIONARY and c not in ("Cash withdrawals", "Buy now, pay later") and categorise.describe(desc)[1] == "merchant":
            top[categorise.describe(desc)[0]] += -a
    if top:
        add("warn", "Biggest discretionary spends:", "; ".join(f"{k.title()} {money(v)}" for k, v in top.most_common(5)) + ". Were they worth it?")

    # 8. one-offs over $300 in shopping/other
    big = [(a, desc) for d, a, desc, c in txns if a <= -300 and c in ("Shopping", "Other", "Entertainment", "Travel")
           and categorise.describe(desc)[1] == "merchant"]
    if big:
        add("warn", f"{len(big)} one-off purchase{'s' if len(big) != 1 else ''} over $300.",
            "; ".join(f"{categorise.describe(desc)[0].title()} {money(a)}" for a, desc in sorted(big)[:5]) + ". Planned, or impulse?")

    # 9. unsorted spending hides leaks
    other = by.get("Other", 0)
    spend = row.get("spend") or 0
    if spend > 0 and other / spend > 0.2:
        add("warn", f"{round(100 * other / spend)}% of spending is still 'Other'.",
            "You can't trim what you can't see. Ten minutes in Check categories fixes most of it.")

    order = {"bad": 0, "warn": 1, "ok": 2}
    items.sort(key=lambda i: order[i["level"]])
    return {"month": m, "items": items, "bad": sum(i["level"] == "bad" for i in items), "warn": sum(i["level"] == "warn" for i in items),
            "living_target": LIVING_TARGET, "save_target": SAVE_TARGET}
