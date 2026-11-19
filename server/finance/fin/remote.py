"""The worker (api.shaunzen.com/agent/finance/*), the upload envelope, and email.

Envelope "SZF1" (made by finance.html in the browser):
  magic(4) | wrapped-key length u16 BE | RSA-OAEP(SHA-256) wrapped AES-256 key | iv(12) | AES-GCM ciphertext
  plaintext = meta length u32 BE | meta JSON {name,type,size,at} | file bytes
"""

from __future__ import annotations

import json
import os
import shutil
import struct
import subprocess
import sys
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from . import config

KEY_FILE = config.SECRETS / "upload_key.pem"


def call(method: str, path: str, body: bytes | str | dict | None = None, raw: bool = False):
    data = json.dumps(body).encode() if isinstance(body, (dict, list)) else body.encode() if isinstance(body, str) else body
    req = urllib.request.Request(f"{config.API}/agent/finance{path}", method=method, data=data, headers={
        "Authorization": f"Bearer {config.secret()}", "Content-Type": "application/json", "User-Agent": "finance-sync"})
    with urllib.request.urlopen(req, timeout=60) as r:
        out = r.read()
    return out if raw else json.loads(out or b"{}")


# ---------- keys ----------
def private_key():
    return serialization.load_pem_private_key(KEY_FILE.read_bytes(), password=None)


def make_key() -> bool:
    """Create the upload key pair once. Returns True if a new key was made."""
    if KEY_FILE.exists():
        return False
    key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    fd = os.open(KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(pem)
    return True


def public_pem() -> str:
    return private_key().public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode().strip()


def decrypt(env: bytes) -> tuple[dict, bytes]:
    if env[:4] != b"SZF1":
        raise ValueError("not an SZF1 envelope")
    (wl,) = struct.unpack(">H", env[4:6])
    wrapped, iv, ct = env[6:6 + wl], env[6 + wl:18 + wl], env[18 + wl:]
    aes = private_key().decrypt(wrapped, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    inner = AESGCM(aes).decrypt(iv, ct, None)
    (ml,) = struct.unpack(">I", inner[:4])
    return json.loads(inner[4:4 + ml]), inner[4 + ml:]


# ---------- email (fixed wording only: never figures, categories, merchants or file names) ----------
def email(subject: str, body: str) -> bool:
    if os.environ.get("FIN_NO_EMAIL"):
        print(f"(email skipped) {subject}")
        return True
    gh = shutil.which("gh") or "/usr/bin/gh"
    r = subprocess.run([gh, "workflow", "run", "email-me.yml", "-R", "sh4unn/book-register",
                        "-f", f"subject={subject}", "-f", f"body={body}"], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        print(f"email failed (gh exit {r.returncode})", file=sys.stderr)
    return r.returncode == 0
