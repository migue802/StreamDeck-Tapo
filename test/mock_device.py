#!/usr/bin/env python3
"""A fake Tapo device speaking KLAP, used to test the plugin's client end to end.

The crypto here is transcribed from the reference tapo.py client, so it acts as an
independent implementation to test the TypeScript port against. Supports fault
injection so the client's recovery paths can be exercised:

    --expire-after N   accept N requests, then reject as if the session had lapsed
    --require-cookie   reject any request that omits the TP_SESSIONID cookie
"""

import argparse
import hashlib
import json
import os
import struct
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad


def sha1(d): return hashlib.sha1(d).digest()
def sha256(d): return hashlib.sha256(d).digest()


class Cipher:
    def __init__(self, local_seed, remote_seed, user_hash):
        lh = local_seed + remote_seed + user_hash
        self.key = sha256(b"lsk" + lh)[:16]
        ivf = sha256(b"iv" + lh)
        self.iv_base = ivf[:12]
        self.seq = struct.unpack(">i", ivf[-4:])[0]
        self.sig_key = sha256(b"ldk" + lh)[:28]

    def _iv(self, seq):
        return self.iv_base + struct.pack(">i", seq)

    def decrypt(self, payload, seq):
        return unpad(AES.new(self.key, AES.MODE_CBC, self._iv(seq)).decrypt(payload[32:]), 16)

    def encrypt(self, plaintext, seq):
        ct = AES.new(self.key, AES.MODE_CBC, self._iv(seq)).encrypt(pad(plaintext, 16))
        return sha256(self.sig_key + struct.pack(">i", seq) + ct) + ct


STATE = {
    "device_id": "MOCK0001",
    "model": "L900-5",
    "fw_ver": "1.0.9 Build 230609 Rel.153525",
    "nickname": "VGlyYSBMRUQ=",           # "Tira LED"
    "ssid": "TWlXaUZp",                    # "MiWiFi"
    "rssi": -46,
    "device_on": False,
    "brightness": 50,
    "hue": 0,
    "saturation": 100,
    "color_temp": 0,
    "color_temp_range": [2500, 9000],
    "lighting_effect": {"enable": 0, "name": ""},
}

SERVER = {
    "auth": None,
    "sessions": {},        # sid -> {"cipher":..., "local_seed":..., "remote_seed":...}
    "pending": {},         # sid -> handshake1 data awaiting handshake2
    "requests_served": 0,
    "served_by_sid": {},
    "expire_after": 0,
    "require_cookie": False,
    "next_sid": 1,
    "log": [],
}
LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _sid(self):
        cookie = self.headers.get("Cookie") or ""
        for part in cookie.split(";"):
            part = part.strip()
            if part.startswith("TP_SESSIONID="):
                return part.split("=", 1)[1]
        return None

    def _send(self, code, body=b"", cookie=None):
        self.send_response(code)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            self.send_header("Set-Cookie", f"TP_SESSIONID={cookie};TIMEOUT=1440")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_POST(self):
        path = urlparse(self.path).path
        qs = parse_qs(urlparse(self.path).query)
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))

        with LOCK:
            if path == "/app/handshake1":
                local_seed = body
                remote_seed = os.urandom(16)
                sid = str(SERVER["next_sid"])
                SERVER["next_sid"] += 1
                SERVER["pending"][sid] = (local_seed, remote_seed)
                SERVER["log"].append(("handshake1", sid))
                payload = remote_seed + sha256(local_seed + remote_seed + SERVER["auth"])
                return self._send(200, payload, cookie=sid)

            if path == "/app/handshake2":
                sid = self._sid()
                SERVER["log"].append(("handshake2", sid))
                if sid is None or sid not in SERVER["pending"]:
                    # Without the cookie the device cannot tell which handshake this is.
                    return self._send(403)
                local_seed, remote_seed = SERVER["pending"].pop(sid)
                if body != sha256(remote_seed + local_seed + SERVER["auth"]):
                    return self._send(403)
                SERVER["sessions"][sid] = Cipher(local_seed, remote_seed, SERVER["auth"])
                return self._send(200)

            if path == "/app/request":
                sid = self._sid()
                SERVER["log"].append(("request", sid))
                if SERVER["require_cookie"] and sid is None:
                    return self._send(403)
                if sid is None or sid not in SERVER["sessions"]:
                    return self._send(403)

                SERVER["requests_served"] += 1

                # Expiry is per session, as on a real device: the lapsed session stops
                # working, but a fresh handshake gets a working one. A global counter
                # would instead refuse everything forever, which no recovery can survive.
                SERVER["served_by_sid"][sid] = SERVER["served_by_sid"].get(sid, 0) + 1
                if SERVER["expire_after"] and SERVER["served_by_sid"][sid] > SERVER["expire_after"]:
                    SERVER["sessions"].pop(sid, None)
                    return self._send(403)

                cipher = SERVER["sessions"][sid]
                seq = int(qs["seq"][0])
                envelope = json.loads(cipher.decrypt(body, seq))
                method, params = envelope.get("method"), envelope.get("params")

                if method == "get_device_info":
                    result = {"error_code": 0, "result": dict(STATE)}
                elif method == "set_device_info":
                    for k, v in (params or {}).items():
                        STATE[k] = v
                    result = {"error_code": 0, "result": {}}
                else:
                    result = {"error_code": -1002, "result": {}}

                return self._send(200, cipher.encrypt(json.dumps(result).encode(), seq))

        self._send(404)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=9999)
    p.add_argument("--email", default="test@example.com")
    p.add_argument("--password", default="hunter2")
    p.add_argument("--expire-after", type=int, default=0)
    p.add_argument("--require-cookie", action="store_true")
    a = p.parse_args()

    SERVER["auth"] = sha256(sha1(a.email.encode()) + sha1(a.password.encode()))
    SERVER["expire_after"] = a.expire_after
    SERVER["require_cookie"] = a.require_cookie

    srv = HTTPServer(("127.0.0.1", a.port), Handler)
    print(f"mock device on 127.0.0.1:{a.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
