"""Spending categories for Macquarie transactions.

Each description becomes a key:
  merchant  "WOOLWORTHS DRAYTON" (card purchases, BPAY billers): built-in rule, else Claude suggests, you confirm
  payee     "TO <name>" / "FROM <name>" (money to or from a person): never sent to Claude; you choose on the page
  transfer  between your own accounts, loan repayments: not spending
  income    interest and the like
Claude only ever sees merchant keys: no amounts, dates, balances, account numbers or people's names.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from . import config

SPEND = config.SPEND_CATEGORIES
BUILTIN = [  # (substring in the merchant key, category). Generic chains only.
    (("CASH WITHDRAWAL", "ATM "), "Cash withdrawals"),
    ((" ELEVEN ", "BAYWASH", "CAR WASH"), "Transport"),
    (("PYPL PAYIN", "ZIPPAY", "ZIPMONEY", "ZIP PAY", "AFTERPAY", "HUMM", "KLARNA"), "Buy now, pay later"),
    (("WOOLWORTHS", "COLES", "ALDI", "IGA ", "HARRIS FARM", "FOODWORKS", "FOODWO"), "Groceries"),
    (("UBER EATS", "UBER *EATS", "MENULOG", "DOORDASH", "GUZMAN", "GYG", "MCDONALD", "KFC", "SUBWAY", "HUNGRY JACK", "DOMINO",
      "CAFE", "COFFEE", "BAKERY", "ZARRAFFA", "STARBUCKS", "SUSHI", "PIZZA", "BURGER", "HJS", "HJ S"), "Dining out"),
    (("SHELL", "AMPOL", "CALTEX", "7-ELEVEN", "7 ELEVEN", "BP ", "UNITED PETROL", "TRANSLINK", "GO CARD", "LINKT", "UBER TRIP",
      "UBER *TRIP", "PARKING", "TESLA"), "Transport"),
    (("SPOTIFY", "NETFLIX", "STAN.COM", "DISNEY", "YOUTUBE", "APPLE.COM", "BINGE", "KAYO", "CINEMA", "EVENT ", "SEA LIFE"), "Entertainment"),
    (("CHEMIST", "PHARMACY", "PRICELINE", "PHYSIO", "DENTAL", "MEDICAL", "GYM", "FITNESS", "HYROX", "BARBER"), "Health & fitness"),
    (("KMART", "BUNNINGS", "JB HI", "AMAZON", "TARGET", "BIG W", "OFFICEWORKS", "IKEA", "SYDNEY TOOLS", "MYER", "DAVID JONES",
      "BIKES", "REBEL", "ANACONDA", "EBAY"), "Shopping"),
    (("ORIGIN", "AGL", "ENERGEX", "ENERGY", "TELSTRA", "OPTUS", "VODAFONE", "AUSSIE BROADBAND", "COUNCIL", "URBAN UTILITIES",
      "WATER", "INSURANCE", "BUPA", "MEDIBANK", "NRMA", "RACQ", "RATES", "DEFT", "SUPERLOOP", "STARLINK"), "Utilities"),
    (("QANTAS", "VIRGIN AUS", "JETSTAR", "AIRBNB", "BOOKING.COM", "HOTEL", "EXPEDIA"), "Travel"),
]
STATES = {"QL", "QLD", "NS", "NSW", "VI", "VIC", "SA", "WA", "TA", "TAS", "NT", "ACT", "AU", "AUS"}


def describe(desc: str) -> tuple[str, str]:
    """(key, kind) for a bank description. kind: merchant | payee | transfer | income."""
    d = re.sub(r"\s+", " ", desc).strip()
    low = d.lower()
    if any(w in low for w in ("linked account", "internal transfer", "home loan", "loan repayment", "to loan", "offset",
                              "direct debit to account", "vanguard")):
        return "TRANSFER", "transfer"      # own accounts: loan repayments, Personal Investor auto-invest
    if low.startswith("interest"):
        return "INTEREST", "income"
    if re.match(r"^(atm )?withdrawal", low):
        return "CASH WITHDRAWAL", "merchant"
    if m := re.match(r"^(?:recurring )+payment to (.+?)(?: - .*)?$", d, re.I):   # direct debits to billers
        words = [w for w in re.sub(r"[^A-Z&.' -]", " ", m.group(1).upper()).split() if w not in STATES]
        return " ".join(words[:3])[:40] or "UNKNOWN", "merchant"
    m = re.match(r"^(?:recurring )?(?:funds )?(?:transfer )?(to|from) (.+?)(?: - .*)?$", d, re.I)
    if m and not low.startswith(("purchase", "online purchase")):
        name = re.sub(r"[^A-Z ]", "", m.group(2).upper()).strip()
        name = re.sub(r"\s+", " ", name)[:40] or "UNKNOWN"
        return f"{m.group(1).upper()} {name}", "payee"
    body = re.sub(r"^(online purchase from|purchase (at|from)|debit card purchase|refund from|bpay( to)?|direct debit( to)?|eftpos)\s+", "", d, flags=re.I)
    body = re.sub(r"^(SQ|ZLR|PP|SP|LS|IZ|CKO|PAYPAL) ?\*", "", body.upper())
    words = [w for w in re.sub(r"[^A-Z&.' -]", " ", body).split() if w not in STATES]
    key = " ".join(words[:3]) or "UNKNOWN"
    return key[:40], "merchant"


def rule_id(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()[:12]


def builtin(key: str) -> str | None:
    k = f" {key} "
    for subs, cat in BUILTIN:
        if any(s in k for s in subs):
            return cat
    return None


def load_rules(con) -> dict[str, str]:
    return {r["key"]: r["category"] for r in con.execute("SELECT key, category FROM rules")}


def category(desc: str, amount: float, rules: dict[str, str]) -> str:
    key, kind = describe(desc)
    if kind == "transfer":
        return config.TRANSFER
    if kind == "income":
        return config.INCOME
    cat = rules.get(key) or (builtin(key) if kind == "merchant" else None)
    if amount > 0 and kind == "merchant":
        # money back from a merchant is a refund in that merchant's category; otherwise income
        return cat if desc.lower().startswith("refund") and cat in SPEND else config.INCOME
    if cat:
        return cat
    if kind == "payee":
        return config.INCOME if amount > 0 else "Other"
    return "Other"


def refresh(con) -> int:
    """Make sure every merchant/payee in the bank data has a rule. Returns how many new suggestions were made."""
    counts: dict[str, list] = {}
    for t in con.execute("SELECT t.desc, t.amount FROM txns t JOIN accounts a ON a.key=t.account WHERE a.kind='bank'"):
        key, kind = describe(t["desc"])
        if kind in ("merchant", "payee") and not (kind == "merchant" and t["amount"] > 0 and not t["desc"].lower().startswith("refund")):
            c = counts.setdefault(key, [kind, 0, t["amount"]])
            c[1] += 1
    existing = load_rules(con)
    new_merchants = []
    for key, (kind, n, amount) in counts.items():
        con.execute("UPDATE rules SET seen=? WHERE key=?", (n, key))
        b = builtin(key) if kind == "merchant" else None
        if key in existing:
            if b:   # a built-in rule beats an unconfirmed suggestion made before it existed
                con.execute("UPDATE rules SET category=?, source='builtin', confirmed=1 WHERE key=? AND confirmed=0", (b, key))
            continue
        if b:
            con.execute("INSERT INTO rules VALUES (?,?,?,?,?,?)", (key, rule_id(key), b, "builtin", 1, n))
        elif kind == "payee":
            con.execute("INSERT INTO rules VALUES (?,?,?,?,?,?)", (key, rule_id(key), config.INCOME if key.startswith("FROM ") else "Other", "auto", 0, n))
        else:
            new_merchants.append(key)
    suggestions = ask_claude(new_merchants) if new_merchants else {}
    for key in new_merchants:
        con.execute("INSERT INTO rules VALUES (?,?,?,?,?,?)", (key, rule_id(key), suggestions.get(key, "Other"),
                                                              "claude" if key in suggestions else "auto", 0, counts[key][1]))
    con.commit()
    return len(new_merchants)


def apply_confirmed(con, items: list[dict]) -> list[str]:
    """Confirmed categories from the page. Returns the ids applied (to acknowledge to the worker)."""
    done = []
    for it in items:
        cat = it.get("category")
        if cat not in config.ALL_CATEGORIES:
            done.append(it.get("id"))
            continue
        cur = con.execute("UPDATE rules SET category=?, source='user', confirmed=1 WHERE id=?", (cat, it.get("id")))
        if cur.rowcount == 0 and it.get("merchant"):
            key = str(it["merchant"])[:40]
            con.execute("INSERT INTO rules VALUES (?,?,?,?,?,0) ON CONFLICT(key) DO UPDATE SET category=excluded.category, source='user', confirmed=1",
                        (key, rule_id(key), cat, "user", 1))
        done.append(it.get("id"))
    con.commit()
    return done


SCHEMA = {"type": "object", "properties": {"items": {"type": "array", "items": {"type": "object", "properties": {
    "merchant": {"type": "string"}, "category": {"type": "string", "enum": SPEND}}, "required": ["merchant", "category"]}}},
    "required": ["items"]}


def ask_claude(keys: list[str]) -> dict[str, str]:
    """Suggest a category per merchant name. Sends merchant names only."""
    if os.environ.get("FIN_NO_CLAUDE") or not keys:
        return {}
    claude = os.environ.get("CLAUDE_BIN") or shutil.which("claude") or str(Path.home() / ".local/bin/claude")
    out: dict[str, str] = {}
    for i in range(0, len(keys), 80):
        batch = keys[i:i + 80]
        prompt = ("Australian card-statement merchant names (shortened, location removed). For each, pick the most likely "
                  f"spending category from: {', '.join(SPEND)}. Use Other if unsure.\n\n" + "\n".join(batch))
        cmd = [claude, "-p", "--output-format", "json", "--model", config.MODEL, "--tools", "", "--json-schema", json.dumps(SCHEMA),
               "--no-session-persistence", "--strict-mcp-config"]
        try:
            with tempfile.TemporaryDirectory() as cwd:
                r = subprocess.run(cmd, input=prompt, capture_output=True, text=True, cwd=cwd, timeout=300)
            d = json.loads(r.stdout)
            items = (d.get("structured_output") or {}).get("items") or json.loads(d.get("result") or "{}").get("items", [])
        except Exception as e:  # noqa: BLE001
            print(f"claude suggestions skipped ({type(e).__name__})")
            continue
        wanted = set(batch)
        for it in items:
            if it.get("merchant") in wanted and it.get("category") in SPEND:
                out[it["merchant"]] = it["category"]
    return out
