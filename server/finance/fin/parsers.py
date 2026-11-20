"""Turn one export into records. No network, no logging of contents: errors carry only a reason.

Every parser returns a Parsed with any of:
  txns    [Txn]     dated money movements (bank, loan, super flows)
  points  [Point]   a known balance at the END of a date (statement closing, running balance)
  periods [Period]  a date range with opening, net money in and closing (Personal Investor performance report)
  account (key, label, kind)  which account the file belongs to; kind is bank | loan | super | invest

Formats seen so far (Nov 2026):
  Macquarie   PDF "… Transaction Listing Report" (offset accounts and the offset home loan)
  Macquarie   CSV export (columns guessed: date, description/details, debit+credit or amount, balance)
  Vanguard PI PDF "Account Performance Report" (opening, net deposits and withdrawals, net earnings, closing)
  Vanguard Super CSV "account-activity-<from>-to-<to>.csv": Date, Description, Type, Amount (no balance)
  Vanguard Super PDF statement: generic opening/closing balance search until a real one is seen
"""

from __future__ import annotations

import csv
import hashlib
import io
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta


class Unrecognised(Exception):
    """The file isn't in a layout we know. The message is safe to log (no contents)."""


@dataclass
class Txn:
    d: date
    amount: float          # signed: + money into the account, − money out (loan: + borrowed more, − repaid)
    desc: str
    kind: str = ""         # super: sg/salsac/personal/rollin/tax/fees/insurance/other; loan: drawdown/interest/fee/repayment
    balance: float | None = None


@dataclass
class Point:
    d: date
    balance: float


@dataclass
class Period:
    start: date
    end: date
    opening: float
    net_in: float
    closing: float


@dataclass
class Parsed:
    account: tuple[str, str, str]            # (key, label, kind)
    txns: list[Txn] = field(default_factory=list)
    points: list[Point] = field(default_factory=list)
    periods: list[Period] = field(default_factory=list)

    def rows(self) -> int:
        return len(self.txns) + len(self.points) + len(self.periods)


MONTHS = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}
MONEY = r"-?\$?-?[\d,]+\.\d{2}"


def money(s: str) -> float:
    s = s.strip().replace("$", "").replace(",", "").replace(" ", "")
    neg = s.startswith("-") or s.endswith("-") or (s.startswith("(") and s.endswith(")"))
    s = s.strip("-()")
    if s.upper().endswith("CR"):
        s = s[:-2]
    elif s.upper().endswith("DR"):
        s, neg = s[:-2], True
    v = float(s)
    return -v if neg else v


def parse_date(s: str) -> date:
    s = s.strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d/%m/%y", "%d %b %Y", "%d %B %Y", "%d-%b-%Y", "%d-%m-%Y", "%Y/%m/%d", "%d %b %y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    raise ValueError("date")


def long_date(s: str) -> date:
    """'1 July 2026' / '19 November 2026'."""
    return datetime.strptime(re.sub(r"\s+", " ", s.strip()), "%d %B %Y").date()


def account_key(*parts: str) -> str:
    """Stable id for an account without keeping its number anywhere outside the database."""
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:12]


# ---------- PDF text ----------
def pdf_text(data: bytes) -> str:
    from pypdf import PdfReader
    try:
        r = PdfReader(io.BytesIO(data))
        return "\n".join(p.extract_text() or "" for p in r.pages)
    except Exception as e:  # noqa: BLE001 – pypdf raises many types; never echo contents
        raise Unrecognised(f"unreadable PDF ({type(e).__name__})") from None


# ---------- Macquarie transaction listing (PDF) ----------
TXN_START = re.compile(r"^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) (.*)$")
MONTH_HDR = re.compile(r"^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})$")
TXN_END = re.compile(r"^(.*?)\s*([\d,]+\.\d{2}) ([\d,]+\.\d{2})(?: (CR|DR))?$")
OPENING = re.compile(r"^Opening balance ([\d,]+\.\d{2})(?: (CR|DR))?$")
BOILER = re.compile(r"^(Account Name|Your transactions|Date (Transaction )?Description Debits Credits Balance|Please check each entry.*|away\.|Page \d+ of \d+|.*Transaction Listing Report|From \d{1,2} \w+ \d{4} to .*|Closing balance.*|BSB|Account No\.)$")


def _signed(v: str, crdr: str | None, loan: bool) -> float:
    x = money(v)
    if crdr == "DR" or (loan and crdr is None and x != 0):
        return -x
    return x


def macquarie_pdf(text: str) -> Parsed:
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    title = next((l for l in lines if l.endswith("Transaction Listing Report")), None)
    if not title:
        raise Unrecognised("not a Macquarie transaction listing")
    label = title.replace("Transaction Listing Report", "").strip() or "Macquarie"
    loan = "loan" in label.lower()
    try:
        i = lines.index("Account No.")
        acct = re.sub(r"\D", "", lines[i + 1])
        bsb = re.sub(r"\D", "", lines[lines.index("BSB") + 1]) if "BSB" in lines else ""
    except (ValueError, IndexError):
        raise Unrecognised("no account number found") from None
    # keyed by the last 4 digits, the only part open banking (Redbark) exposes, so both sources land on one account
    out = Parsed(account=(account_key("macquarie", acct[-4:]), label, "loan" if loan else "bank"))

    year = month = None
    prev_bal = None
    pending: list[str] | None = None
    pending_date = None
    group: list[tuple[date, float, str]] = []   # same-day lines printed without a running balance

    def guess_out(desc: str) -> bool:
        d = desc.lower()
        return any(w in d for w in ("purchase", "to ", "payment to", "withdrawal", "fee", "debit", "drawdown", "interest charged"))

    def settle(delta: float | None, bal: float | None, last: tuple[date, float, str] | None) -> None:
        """Give signs to the lines since the last balance so they add up to the balance change."""
        items = group + ([last] if last else [])
        signs = None
        if delta is not None and len(items) <= 14:
            fits = [c for c in range(1 << len(items))
                    if abs(sum(a if c >> k & 1 else -a for k, (_, a, _) in enumerate(items)) - delta) < 0.005]
            if fits:
                # several fits (rare): prefer the one closest to what the descriptions suggest
                want = sum((0 if guess_out(t[2]) else 1) << k for k, t in enumerate(items))
                c = min(fits, key=lambda c: bin(c ^ want).count("1"))
                signs = [1 if c >> k & 1 else -1 for k in range(len(items))]
        if signs is None:
            signs = [-1 if guess_out(t[2]) else 1 for t in items]
            if loan:
                signs = [-x for x in signs]
        for k, (d, a, desc) in enumerate(items):
            is_last = last is not None and k == len(items) - 1
            out.txns.append(Txn(d, round(signs[k] * a, 2), desc.strip(), loan_kind(desc) if loan else "", bal if is_last else None))
        group.clear()

    lone = re.compile(r"^(.*?)\s*([\d,]+\.\d{2})$")
    for l in lines:
        if m := MONTH_HDR.match(l):
            year, month = int(m.group(2)), MONTHS[m.group(1).lower()]
            continue
        if m := OPENING.match(l):
            if prev_bal is None:
                prev_bal = _signed(m.group(1), m.group(2), loan)
                if year:
                    out.points.append(Point(date(year, month, 1) - timedelta(days=1), prev_bal))
            continue
        if BOILER.match(l):
            continue
        start = TXN_START.match(l)
        if start and year:
            if pending:                       # previous line had an amount but no balance
                lm = lone.match(pending[-1])
                if lm:
                    pending[-1] = lm.group(1)
                    group.append((pending_date, money(lm.group(2)), " ".join(x for x in pending if x)))
            pending_date = date(year, MONTHS[start.group(1).lower()], int(start.group(2)))
            pending = []
            l = start.group(3)
        if pending is None:
            # Some lines come out of the PDF with the date after the description: "… Aug 12 34.50 1,234.56 CR".
            late = TXN_END.match(l)
            dm = late and year and re.search(r"\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})\b", late.group(1))
            if not dm:
                continue
            pending_date = date(year, MONTHS[dm.group(1).lower()], int(dm.group(2)))
            pending = []
            l = (late.group(1)[:dm.start()] + late.group(1)[dm.end():]).strip() + f" {late.group(2)} {late.group(3)}" + (f" {late.group(4)}" if late.group(4) else "")
        end = TXN_END.match(l)
        if end:
            if end.group(1):
                pending.append(end.group(1))
            amt, bal = money(end.group(2)), _signed(end.group(3), end.group(4), loan)
            settle(None if prev_bal is None else round(bal - prev_bal, 2), bal, (pending_date, amt, " ".join(pending)))
            out.points.append(Point(pending_date, bal))
            prev_bal, pending = bal, None
        else:
            pending.append(l)
    if group:
        settle(None, None, None)
    if not out.txns and not out.points:
        raise Unrecognised("no transactions found in the listing")
    return out


def loan_kind(desc: str) -> str:
    d = desc.lower()
    if "drawdown" in d:
        return "drawdown"
    if "interest" in d:
        return "interest"
    if "fee" in d:
        return "fee"
    return "repayment"


# ---------- generic CSV helpers ----------
def read_csv(data: bytes) -> tuple[list[str], list[list[str]]]:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("latin-1")
    rows = [r for r in csv.reader(io.StringIO(text)) if any(c.strip() for c in r)]
    for i, r in enumerate(rows[:15]):
        low = [c.strip().lower() for c in r]
        if any("date" in c for c in low) and len(r) >= 3:
            return low, rows[i + 1:]
    raise Unrecognised("no header row with a date column")


def col(header: list[str], *names: str) -> int | None:
    for n in names:
        for i, h in enumerate(header):
            if h == n:
                return i
    for n in names:
        for i, h in enumerate(header):
            if n in h:
                return i
    return None


def csv_txns(data: bytes) -> tuple[list[str], list[Txn]]:
    header, rows = read_csv(data)
    di = col(header, "transaction date", "date")
    de = col(header, "original description", "description", "details", "narrative", "transaction details", "transaction")
    am, db, cr = col(header, "amount", "net amount"), col(header, "debit", "debits", "withdrawal"), col(header, "credit", "credits", "deposit")
    ba = col(header, "balance")
    ty = col(header, "type", "transaction type")
    if di is None or (am is None and (db is None or cr is None)):
        raise Unrecognised(f"CSV columns not understood: {', '.join(h[:30] for h in header)}")
    out = []
    for r in rows:
        try:
            d = parse_date(r[di])
            if am is not None and r[am].strip():
                a = money(r[am])
            else:
                a = (money(r[cr]) if r[cr].strip() else 0.0) - (abs(money(r[db])) if r[db].strip() else 0.0)
            b = money(r[ba]) if ba is not None and ba < len(r) and r[ba].strip() else None
        except (ValueError, IndexError):
            continue
        desc = " ".join(x for x in ((r[de] if de is not None and de < len(r) else ""), (r[ty] if ty is not None and ty < len(r) else "")) if x).strip()
        out.append(Txn(d, a, desc, "", b))
    if not out:
        raise Unrecognised("CSV had a header but no rows with a date and amount")
    return header, out


# ---------- Macquarie CSV ----------
def macquarie_csv(data: bytes) -> Parsed:
    header, txns = csv_txns(data)
    out = Parsed(account=(account_key("macquarie", "csv"), "Macquarie", "bank"), txns=sorted(txns, key=lambda t: t.d))
    for t in out.txns:
        if t.balance is not None:
            out.points.append(Point(t.d, t.balance))
    return out


# ---------- Vanguard Super ----------
def super_kind(desc: str) -> str:
    d = desc.lower()
    if "salary sacrifice" in d or "sal sac" in d:
        return "salsac"
    if "tax" in d:
        return "tax"
    if "insurance" in d or "premium" in d:
        return "insurance"
    if "roll in" in d or "rollover" in d or "roll-in" in d or "transfer in" in d:
        return "rollin"
    if "employer" in d or "superannuation guarantee" in d:
        return "sg"
    if "personal" in d or "member contribution" in d or "after-tax" in d or "non-concessional" in d:
        return "personal"
    if "fee" in d or "admin" in d or "cost" in d:
        return "fees"
    if "investment" in d or "earning" in d or "return" in d:
        return "return"
    return "other"


SUPER_KEY = account_key("vanguard", "super")


def super_csv(data: bytes) -> Parsed:
    header, txns = csv_txns(data)
    out = Parsed(account=(SUPER_KEY, "Vanguard Super", "super"))
    for t in txns:
        t.kind = super_kind(t.desc)
        out.txns.append(t)
        if t.balance is not None:
            out.points.append(Point(t.d, t.balance))
    return out


def statement_pdf(text: str, key: str, label: str, kind: str) -> Parsed:
    """Generic statement: a 'from … to …' period and opening/closing balance figures."""
    flat = re.sub(r"\s+", " ", text)
    per = re.search(r"(?:From|for the period|period from)\s+(\d{1,2} \w+ \d{4}) (?:to|-|–) (\d{1,2} \w+ \d{4})", flat, re.I)
    asat = re.findall(r"(?:as at|balance at|balance on)\s+(\d{1,2} \w+ \d{4})", flat, re.I)
    close = re.search(r"(?:closing (?:account )?balance|total account balance|account balance|your balance)[^$\d]{0,40}(" + MONEY + ")", flat, re.I)
    opening = re.search(r"opening (?:account )?balance[^$\d]{0,40}(" + MONEY + ")", flat, re.I)
    out = Parsed(account=(key, label, kind))
    try:
        end = long_date(per.group(2)) if per else max(long_date(x) for x in asat) if asat else None
    except ValueError:
        end = None
    if not end or not close:
        raise Unrecognised("statement without a recognisable closing balance and date")
    out.points.append(Point(end, money(close.group(1))))
    if per and opening:
        try:
            out.points.append(Point(long_date(per.group(1)) - timedelta(days=1), money(opening.group(1))))
        except ValueError:
            pass
    return out


# ---------- Vanguard Personal Investor ----------
VPI_KEY = account_key("vanguard", "personal-investor")


def vpi_pdf(text: str) -> Parsed:
    if "Account Performance" not in text:
        return statement_pdf(text, VPI_KEY, "Personal Investor", "invest")
    flat = re.sub(r"\s+", " ", text)
    per = re.search(r"From (\d{1,2} \w+ \d{4}) to (\d{1,2} \w+ \d{4})", flat)
    summ = re.search(r"Opening balance Net deposits and withdrawals Net earnings Closing balance Net return\s+"
                     r"(" + MONEY + r")\s+(" + MONEY + r")\s+(" + MONEY + r")\s+(" + MONEY + r")", flat)
    if not per or not summ:
        raise Unrecognised("performance report without the summary table")
    start, end = long_date(per.group(1)), long_date(per.group(2))
    opening, net_in, _earn, closing = (money(summ.group(i)) for i in range(1, 5))
    out = Parsed(account=(VPI_KEY, "Personal Investor", "invest"))
    out.periods.append(Period(start, end, opening, net_in, closing))
    out.points += [Point(start - timedelta(days=1), opening), Point(end, closing)]
    return out


def vpi_csv(data: bytes) -> Parsed:
    header, txns = csv_txns(data)
    out = Parsed(account=(VPI_KEY, "Personal Investor", "invest"))
    for t in txns:
        d = t.desc.lower()
        t.kind = ("distribution" if any(w in d for w in ("distribution", "dividend", "interest")) else
                  "withdrawal" if any(w in d for w in ("withdraw", "transfer out", "payment to")) else
                  "deposit" if any(w in d for w in ("deposit", "bpay", "direct debit", "transfer in", "contribution")) else
                  "fee" if "fee" in d or "brokerage" in d else "trade")
        out.txns.append(t)
    return out


# ---------- dispatch ----------
def detect(data: bytes, text: str | None) -> str | None:
    """Recognise a file by its contents, so a wrong choice in the page's dropdown can't mislabel it."""
    if text is not None:
        if "Transaction Listing Report" in text:
            return "macquarie-pdf"
        if "Personal Investor" in text and "Account Performance" in text:
            return "vpi-pdf"
        if "Vanguard Super" in text or "superannuation" in text.lower():
            return "super-pdf"
        return None
    try:
        header, _ = read_csv(data)
    except Unrecognised:
        return None
    if header[:4] == ["date", "description", "type", "amount"]:
        return "super-csv"          # Vanguard Super account activity
    return None


def redbark_json(data: bytes) -> Parsed:
    """One account's file written by fin/redbark.py: account, current balance, posted transactions."""
    import json
    doc = json.loads(data)
    a = doc.get("account") or {}
    last4 = re.sub(r"\D", "", a.get("account_number") or "")[-4:]
    inst = (a.get("institution") or "").lower()
    if not last4:
        raise Unrecognised("Redbark account without a number")
    loan = a.get("type") == "loan" or "loan" in (a.get("name") or "").lower()
    key = account_key("macquarie", last4) if "macquarie" in inst else account_key(inst, last4)
    out = Parsed(account=(key, a.get("name") or "Bank account", "loan" if loan else "bank"))
    for t in (doc.get("transactions") or {}).values():
        d = date.fromisoformat(t.get("post_date") or t["date"])
        amt = (t.get("amount") or {}).get("amount")
        if amt is None:
            continue
        desc = t.get("description") or t.get("merchant_name") or ""
        out.txns.append(Txn(d, round(amt / 100, 2), desc, loan_kind(desc) if loan else "", None))
    out.txns.sort(key=lambda t: t.d)
    bal = doc.get("balance")
    if bal and out.txns:
        # Only today's balance is given: work back through the transactions for each earlier day's closing balance.
        seen = date.fromisoformat(bal["observed_at"][:10])
        running = bal["amount"] / 100
        days = sorted({t.d for t in out.txns if t.d <= seen}, reverse=True)
        by_day = {}
        for t in out.txns:
            by_day[t.d] = by_day.get(t.d, 0) + t.amount
        out.points.append(Point(seen, round(running, 2)))
        for d in days:
            out.points.append(Point(d, round(running, 2)))
            running -= by_day[d]
        if days:
            out.points.append(Point(days[-1] - timedelta(days=1), round(running, 2)))
    return out


def parse(file_type: str, data: bytes) -> Parsed:
    if file_type == "redbark":
        return redbark_json(data)
    is_pdf = data[:5] == b"%PDF-"
    text = pdf_text(data) if is_pdf else None
    file_type = detect(data, text) or file_type
    if file_type.startswith("macquarie"):
        return macquarie_pdf(text) if is_pdf else macquarie_csv(data)
    if file_type.startswith("vpi"):
        return vpi_pdf(text) if is_pdf else vpi_csv(data)
    if file_type.startswith("super"):
        return statement_pdf(text, SUPER_KEY, "Vanguard Super", "super") if is_pdf else super_csv(data)
    raise Unrecognised(f"unknown file type {file_type!r}")
