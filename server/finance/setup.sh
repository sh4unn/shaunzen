#!/bin/bash
# Install or update finance-sync on the EC2 server. Run as root (via SSM). Safe to re-run.
#   bash setup.sh [branch]
# Needs: ~ec2-user/finance/.secrets/finance_secret (the worker's FINANCE_SECRET), Python 3.12 (already there
# for garmin-coach), gh logged in as ec2-user. Creates the upload key on first run and publishes its public key.
set -euo pipefail
BRANCH="${1:-main}"
command -v python3.12 >/dev/null || dnf install -y -q python3.12 python3.12-pip >/dev/null

sudo -iu ec2-user bash -s "$BRANCH" <<'USER'
set -euo pipefail
BRANCH="$1"
umask 077
install -d -m 700 ~/finance ~/finance/.secrets ~/finance/data ~/finance/data/raw
test -s ~/finance/.secrets/finance_secret || { echo "missing ~/finance/.secrets/finance_secret"; exit 1; }
chmod 600 ~/finance/.secrets/finance_secret
cd ~/finance
if [ ! -d app/.git ]; then
  gh repo clone sh4unn/shaunzen app -- -q --filter=blob:none --sparse
  git -C app sparse-checkout set server/finance
fi
git -C app fetch -q origin "$BRANCH"
git -C app checkout -q "$BRANCH"
git -C app pull -q --ff-only origin "$BRANCH"
[ -d .venv ] || python3.12 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r app/server/finance/requirements.txt
cd app/server/finance
../../../.venv/bin/python -m fin.sync --setup
echo "OK: branch $(git -C ~/finance/app branch --show-current) @ $(git -C ~/finance/app rev-parse --short HEAD)"
USER

install -m 644 /home/ec2-user/finance/app/server/finance/systemd/finance-sync.service /home/ec2-user/finance/app/server/finance/systemd/finance-sync.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now finance-sync.timer
systemctl list-timers finance-sync.timer --no-pager
