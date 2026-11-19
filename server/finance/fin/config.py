"""Paths and settings. Everything private lives under ~/finance on the server, never in the repo.

~/finance/app        this repo (sparse checkout of server/finance), pulled before each run
~/finance/.secrets   finance_secret (the worker's FINANCE_SECRET), upload_key.pem (RSA private key). Mode 700/600.
~/finance/data       raw/ (decrypted exports, mode 600), finance.db (SQLite), .lock
"""

from __future__ import annotations

import os
from pathlib import Path

HOME = Path(os.environ.get("FIN_HOME", Path.home() / "finance"))
SECRETS = HOME / ".secrets"
DATA = HOME / "data"
RAW = DATA / "raw"
DB = DATA / "finance.db"
API = os.environ.get("FIN_API", "https://api.shaunzen.com")
SITE = os.environ.get("FIN_SITE", "https://shaunzen.com")
PAGE = f"{SITE}/finance.html"
MODEL = os.environ.get("FIN_MODEL", "claude-haiku-5-5")
MONTHS_SHOWN = 24
TZ = "Australia/Brisbane"
REMINDER_DAY = 7          # export reminder if nothing has arrived since the 1st by this day

# Spending categories shown on the page, in this order. The non-spending ones are kept out of the totals.
SPEND_CATEGORIES = ["Housing", "Groceries", "Dining out", "Transport", "Utilities", "Health & fitness",
                    "Shopping", "Entertainment", "Travel", "Gifts & donations", "Other"]
INCOME, TRANSFER = "Income", "Transfer"
ALL_CATEGORIES = SPEND_CATEGORIES + [INCOME, TRANSFER]


def secret() -> str:
    v = os.environ.get("FIN_SECRET")
    if v:
        return v.strip()
    p = SECRETS / "finance_secret"
    if not p.exists():
        raise RuntimeError("no ~/finance/.secrets/finance_secret")
    return p.read_text().strip()


def ensure_dirs() -> None:
    for d, mode in ((HOME, 0o700), (SECRETS, 0o700), (DATA, 0o700), (RAW, 0o700)):
        d.mkdir(parents=True, exist_ok=True)
        os.chmod(d, mode)
