"""One run of finance-sync (systemd timer, every 15 minutes, under flock).

  1. Read the worker's inbox: queued encrypted uploads, budgets, confirmed categories (one KV read).
  2. Decrypt each upload, keep it in ~/finance/data/raw (mode 600), tell the worker processed/rejected.
  3. If anything changed: rebuild from all raw files, refresh category suggestions, publish the summary.
  4. Emails (fixed wording, no figures): summary ready, budget exceeded, export reminder.

Logs are counts only. Usage: python -m fin.sync [--rebuild] [--dry-run]
  --rebuild   re-read every raw file even if nothing new arrived (after a parser change)
  --dry-run   don't talk to the worker or send email; print the summary's shape (no figures)
  --setup     create the upload key if needed and publish its public key
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

from . import categorise, config, model, remote

EXT = {"csv": "csv", "pdf": "pdf"}


def now():
    return datetime.now(ZoneInfo(config.TZ))


def take_uploads(con, uploads: list[dict]) -> tuple[list[dict], int]:
    """Download, decrypt and store new uploads. Returns (done items for the worker, number stored)."""
    done, stored = [], 0
    for u in uploads:
        fid = u["id"]
        if con.execute("SELECT 1 FROM files WHERE id=?", (fid,)).fetchone():
            done.append({"id": fid, "status": "processed"})
            continue
        try:
            meta, data = remote.decrypt(remote.call("GET", f"/upload/{fid}", raw=True))
        except Exception as e:  # noqa: BLE001
            print(f"upload {fid}: could not decrypt ({type(e).__name__})")
            done.append({"id": fid, "status": "rejected"})
            continue
        ext = "pdf" if data[:5] == b"%PDF-" else "csv"
        path = model.raw_path(fid, ext)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        digest = hashlib.sha256(data).hexdigest()
        dup = con.execute("SELECT id FROM files WHERE sha=?", (digest,)).fetchone()
        con.execute("INSERT INTO files VALUES (?,?,?,?,?,?,?,?)", (fid, meta.get("type") or u.get("type"), u.get("at"), "new", None, 0, ext, digest))
        if dup:   # same file uploaded twice: keep one copy
            path.unlink()
            con.execute("UPDATE files SET status='processed', reason='duplicate' WHERE id=?", (fid,))
            done.append({"id": fid, "status": "processed", "rows": 0})
            continue
        done.append({"id": fid, "status": "processed"})   # final status/rows filled in after the rebuild
        stored += 1
    con.commit()
    return done, stored


def main(argv: list[str]) -> int:
    dry = "--dry-run" in argv
    config.ensure_dirs()
    if "--setup" in argv:
        made = remote.make_key()
        remote.call("PUT", "/pubkey", remote.public_pem())
        print("upload key created and published" if made else "upload key exists; public key re-published")
        return 0

    con = model.connect()
    inbox = {"uploads": [], "budgets": None, "categories": []} if dry else remote.call("GET", "/inbox")
    changed = "--rebuild" in argv

    # budgets and confirmed categories from the page
    if inbox.get("budgets") is not None:
        new = {k: int(v) for k, v in inbox["budgets"].items() if k in config.ALL_CATEGORIES}
        if new != model.budgets(con):
            con.execute("DELETE FROM budgets")
            con.executemany("INSERT INTO budgets VALUES (?,?)", new.items())
            con.commit()
            changed = True
    acked = categorise.apply_confirmed(con, inbox.get("categories") or [])
    changed |= bool(acked)

    done, stored = take_uploads(con, inbox.get("uploads") or [])
    changed |= stored > 0

    if changed:
        results = model.rebuild(con)
        new_suggestions = categorise.refresh(con)
        for d in done:
            if d["id"] in results:
                status, _reason, rows = results[d["id"]]
                d.update(status=status, rows=rows)
        for fid, (status, reason, rows) in results.items():
            if status == "rejected":
                print(f"file {fid}: rejected: {reason}")     # reason never contains file contents
        s = model.summary(con)
        print(f"rebuilt: {len(results)} files, {sum(r[2] for r in results.values())} rows, {len(s['months'])} months, "
              f"{len(s['review'])} to review, {new_suggestions} new suggestions")
        if dry:
            print(json.dumps(shape(s), indent=1))
        else:
            body = json.dumps(s, separators=(",", ":"))
            h = hashlib.sha256(body.encode()).hexdigest()
            if h != model.kv_get(con, "summary_hash"):
                remote.call("PUT", "/summary", body)
                model.kv_set(con, "summary_hash", h)
                con.commit()
                print("summary published")
    if not dry:
        if done:
            remote.call("POST", "/done", done)
            print(f"uploads: {sum(d['status'] == 'processed' for d in done)} processed, {sum(d['status'] == 'rejected' for d in done)} rejected")
        if acked:
            remote.call("POST", "/categories-ack", {"ids": acked})
            print(f"categories confirmed: {len(acked)}")
        emails(con, stored_now=stored > 0)
    return 0


def emails(con, stored_now: bool) -> None:
    t = now()
    month = t.strftime("%Y-%m")
    if stored_now:
        model.kv_set(con, "last_upload", t.isoformat())
        last = model.kv_get(con, "summary_mail")
        if not last or (t - datetime.fromisoformat(last)).total_seconds() > 6 * 3600:
            # wait one more run so a batch of uploads gives one email
            model.kv_set(con, "summary_mail_due", t.isoformat())
    due = model.kv_get(con, "summary_mail_due")
    if due and not stored_now and (t - datetime.fromisoformat(due)).total_seconds() >= 10 * 60:
        if remote.email("Finance: summary updated", f"Your new exports have been processed. Open {config.PAGE}"):
            model.kv_set(con, "summary_mail", t.isoformat())
            model.kv_set(con, "summary_mail_due", None)

    # budget exceeded this month (once per category per month; the email never says which or by how much)
    s_month = budget_overs(con, month)
    sent = set(model.kv_get(con, f"budget_mail:{month}", []))
    if s_month - sent:
        if remote.email("Finance: a budget was exceeded", f"A spending category went over its monthly budget. Open {config.PAGE}"):
            model.kv_set(con, f"budget_mail:{month}", sorted(s_month | sent))

    # export reminder: nothing uploaded since the 1st by REMINDER_DAY, once a month
    last = model.kv_get(con, "last_upload")
    if t.day >= config.REMINDER_DAY and model.kv_get(con, "reminder_month") != month and (not last or last[:7] < month):
        if remote.email("Finance: exports due", f"Time to download last month's exports and upload them at {config.PAGE}"):
            model.kv_set(con, "reminder_month", month)
    con.commit()


def budget_overs(con, month: str) -> set[str]:
    budgets = model.budgets(con)
    if not budgets:
        return set()
    rules = categorise.load_rules(con)
    spent: dict[str, float] = {}
    for t in con.execute("SELECT t.desc, t.amount FROM txns t JOIN accounts a ON a.key=t.account WHERE a.kind='bank' AND substr(t.d,1,7)=?", (month,)):
        cat = categorise.category(t["desc"], t["amount"], rules)
        if cat in budgets:
            spent[cat] = spent.get(cat, 0) - t["amount"]
    return {c for c, v in spent.items() if v > budgets[c]}


def shape(s: dict) -> dict:
    """The summary with every number replaced by its type, for --dry-run output."""
    if isinstance(s, dict):
        return {k: shape(v) for k, v in list(s.items())[:12]}
    if isinstance(s, list):
        return [shape(s[0]), f"... {len(s)} items"] if s else []
    if isinstance(s, (int, float)) and not isinstance(s, bool):
        return "#"
    return s if not isinstance(s, str) or len(s) < 12 else s[:4] + "…"


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
