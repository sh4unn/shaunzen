#!/bin/bash
# Installs the shaunzen-agent on the EC2 claude-code-server (run as root via SSM).
# - heartbeat to api.shaunzen.com every minute (server/terminal/claude status)
# - pulls notes sent from the shaunzen.com capture box into ~ec2-user/inbox.md
# - adds iPhone home-screen tags to the ttyd terminal page
# The bearer secret is passed in AGENT_SECRET and stored root-only; it is never committed.
set -euo pipefail
: "${AGENT_SECRET:?set AGENT_SECRET}"

install -d -m 700 /etc/shaunzen-agent
( umask 077; printf '%s' "$AGENT_SECRET" > /etc/shaunzen-agent/secret )

cat > /usr/local/bin/shaunzen-agent <<'PY'
#!/usr/bin/env python3
"""Heartbeat + inbox pickup for api.shaunzen.com. Runs every minute (systemd timer)."""
import json, os, pwd, subprocess, urllib.request

API = "https://api.shaunzen.com/agent"
SECRET = open("/etc/shaunzen-agent/secret").read().strip()
INBOX = "/home/ec2-user/inbox.md"


def ok(cmd):
    return subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def call(path, body=None):
    req = urllib.request.Request(
        API + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + SECRET, "Content-Type": "application/json", "User-Agent": "shaunzen-agent"},
        method="GET" if body is None else "POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


call("/heartbeat", {
    "uptime_s": int(float(open("/proc/uptime").read().split()[0])),
    "load": " ".join(open("/proc/loadavg").read().split()[:3]),
    "ttyd": ok(["systemctl", "is-active", "-q", "ttyd"]),
    "tunnel": ok(["systemctl", "is-active", "-q", "cloudflared"]),
    "tmux": ok(["sudo", "-u", "ec2-user", "tmux", "has-session", "-t", "claude"]),
    "claude": ok(["pgrep", "-u", "ec2-user", "-x", "claude"]) or ok(["pgrep", "-u", "ec2-user", "-f", "/bin/claude"]),
})

items = call("/inbox")
if items:
    new = not os.path.exists(INBOX)
    with open(INBOX, "a") as f:
        if new:
            f.write("# Inbox\n\nQueued from shaunzen.com. Work through these, then tick them off or delete them.\n\n")
        for it in items:
            text = it["text"].replace("\n", "\n  ")
            f.write(f"- [ ] {it['at'][:16].replace('T', ' ')} UTC: {text}\n")
    u = pwd.getpwnam("ec2-user")
    os.chown(INBOX, u.pw_uid, u.pw_gid)
    call("/ack", {"ids": [it["id"] for it in items]})
PY
chmod 755 /usr/local/bin/shaunzen-agent

cat > /etc/systemd/system/shaunzen-agent.service <<'UNIT'
[Unit]
Description=shaunzen.com heartbeat + inbox pickup
After=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/shaunzen-agent
UNIT

cat > /etc/systemd/system/shaunzen-agent.timer <<'UNIT'
[Unit]
Description=Run shaunzen-agent every minute
[Timer]
OnBootSec=30
OnUnitActiveSec=60
AccuracySec=5
[Install]
WantedBy=timers.target
UNIT

# Tell Claude on the server about the inbox.
C=/home/ec2-user/.claude/CLAUDE.md
install -d -o ec2-user -g ec2-user /home/ec2-user/.claude
if ! grep -q 'shaunzen inbox' "$C" 2>/dev/null; then
  cat >> "$C" <<'MD'

## shaunzen inbox
Notes and tasks sent from the capture box on shaunzen.com land in `~/inbox.md` (checked every minute).
At the start of a session, or when asked to "check the inbox", read it, act on open items, and tick them off.
MD
fi
chown ec2-user:ec2-user "$C"

# iPhone home-screen tags for terminal.shaunzen.com: custom ttyd index with app meta tags.
install -d /etc/ttyd
ICON=$(python3 - <<'PY'
import base64, struct, zlib
w = h = 180
bg, fg = (0x2a, 0x5a, 0x6a), (0xf0, 0xf4, 0xf5)
rows = []
for y in range(h):
    row = bytearray([0])
    for x in range(w):
        # simple ">_" prompt glyph
        chev = 50 <= x <= 95 and abs((y - 90)) <= 30 and abs((x - 50) - (30 - abs(y - 90))) <= 6
        under = 100 <= x <= 135 and 112 <= y <= 122
        row += bytes(fg if (chev or under) else bg)
    rows.append(bytes(row))
def chunk(t, d):
    return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")
print(base64.b64encode(png).decode())
PY
)
curl -fsS -H 'Cf-Access-Authenticated-User-Email: local' http://127.0.0.1:7681/ > /tmp/ttyd-default.html
python3 - "$ICON" <<'PY'
import sys
icon = sys.argv[1]
html = open("/tmp/ttyd-default.html").read()
tags = (
    '<meta name="apple-mobile-web-app-capable" content="yes">'
    '<meta name="mobile-web-app-capable" content="yes">'
    '<meta name="apple-mobile-web-app-title" content="Terminal">'
    '<meta name="apple-mobile-web-app-status-bar-style" content="black">'
    '<meta name="theme-color" content="#1a2628">'
    f'<link rel="apple-touch-icon" href="data:image/png;base64,{icon}">'
    f'<link rel="icon" type="image/png" href="data:image/png;base64,{icon}">'
)
if "apple-mobile-web-app-capable" not in html:
    html = html.replace("<head>", "<head>" + tags, 1)
open("/etc/ttyd/index.html", "w").write(html)
PY
rm -f /tmp/ttyd-default.html
if ! grep -q -- '-I /etc/ttyd/index.html' /etc/systemd/system/ttyd.service; then
  sed -i 's|^ExecStart=/usr/local/bin/ttyd |ExecStart=/usr/local/bin/ttyd -I /etc/ttyd/index.html |' /etc/systemd/system/ttyd.service
fi

systemctl daemon-reload
systemctl restart ttyd
systemctl enable --now shaunzen-agent.timer
systemctl start shaunzen-agent.service && echo "agent run: ok" || journalctl -u shaunzen-agent -n 15 --no-pager
systemctl is-active ttyd
grep -c apple-mobile-web-app-capable <(curl -fsS -H 'Cf-Access-Authenticated-User-Email: local' http://127.0.0.1:7681/)
