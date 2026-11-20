# finance-sync

Server side of `finance.html`. It turns exports you download yourself into the monthly summary the page shows. Tracking and reporting only, not advice.

No bank or Vanguard logins are used, stored or automated. This folder is code only. All financial data stays on the EC2 server under `~ec2-user/finance` (mode 700):

| Path | What |
|---|---|
| `.secrets/finance_secret` | The worker's `FINANCE_SECRET` (bearer for `/agent/finance/*`) |
| `.secrets/upload_key.pem` | RSA-3072 private key. The page encrypts uploads to its public key, so Cloudflare only holds ciphertext |
| `data/raw/` | Decrypted exports (mode 600). Everything is rebuilt from these |
| `data/finance.db` | SQLite: transactions, balances, category rules, budgets, email state |

## Flow

1. You upload exports on `finance.html`. The browser encrypts them, and the worker keeps the ciphertext for up to 14 days.
2. Every 15 minutes, `finance-sync.timer` runs `python -m fin.sync` under flock. It reads `/agent/finance/inbox`, decrypts new files, rebuilds from all raw files, refreshes category suggestions and `PUT`s the summary.
3. The summary holds monthly totals only: balances, contributions, growth inputs and spending by category. No transactions or account numbers.
4. Emails go through `gh workflow run email-me.yml -R sh4unn/book-register` with fixed wording and no figures:
   - summary updated;
   - a budget was exceeded;
   - exports due, sent on the 7th if nothing has arrived that month.

## What to download (monthly)

| Account | Export | Parsed as |
|---|---|---|
| Macquarie (each offset account and the home loan) | **Transaction Listing Report** PDF | Transactions and running balance. Same-day lines may come out of order or with the date after the description; the parser handles both |
| Vanguard Personal Investor | **Account Performance Report** PDF for last month | Opening, net deposits and withdrawals, closing |
| Vanguard Super | **account activity** CSV (`Date, Description, Type, Amount`) | Contributions, fees, insurance, roll-ins. It has no balance |
| Vanguard Super | A statement PDF with the balance (layout not seen yet) | Opening and closing balance |

## Macquarie via Redbark (optional)

If `~/finance/.secrets/redbark_token` exists (a Redbark API key, mode 600), `fin/redbark.py` pulls posted Macquarie transactions and balances from Redbark's v2 API every 6 hours. That replaces the Transaction Listing PDFs. Each account is kept as `data/raw/rb-<hash>.json`.

- From an account's first Redbark transaction onwards, Redbark is treated as correct and overlapping PDF rows are dropped.
- Accounts are matched by the last 4 digits of the account number.
- Earlier daily balances are worked back from the current balance.
- Run `python -m fin.sync --redbark` to fetch now.
- The consent is read-only and lapses after at most 12 months, so renew it in Redbark.

## Categories

- Card merchants are matched first by the built-in rules in `fin/categorise.py`.
- Anything left gets a suggestion from `claude -p` (Haiku). Claude sees **merchant names only**: no amounts, dates, people's names or account numbers.
- Payments to and from people are never sent to Claude. You choose their category on the page.
- Transfers between your own accounts and loan repayments are not counted as spending.

## Install or update (as root, via SSM)

```bash
bash /home/ec2-user/finance/app/server/finance/setup.sh main   # after the first clone
```

On the first install, fetch `setup.sh` from the repo, or clone the repo as ec2-user first.

## Useful commands (as ec2-user, in `~/finance/app/server/finance`)

```bash
../../../.venv/bin/python -m fin.sync --rebuild   # re-read every raw file after a parser change
../../../.venv/bin/python -m fin.sync --dry-run   # no network or email; prints the summary's shape, no figures
journalctl -u finance-sync -n 50                  # counts only
```
