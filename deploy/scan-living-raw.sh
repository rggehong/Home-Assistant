#!/usr/bin/env bash
set -euo pipefail

cd /opt/gree-ac-control
.venv/bin/python - <<'PY'
import json
import socket
from greeclimate.cipher import CipherV1

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.settimeout(5)
sock.sendto(b'{"t":"scan"}', ("192.168.0.124", 7000))
data, address = sock.recvfrom(65535)
packet = json.loads(data.decode("utf-8"))
print("FROM", address)
pack = packet.get("pack")
if isinstance(pack, str):
    pack = CipherV1().decrypt(pack)
print(json.dumps(pack or packet, ensure_ascii=False, indent=2))
PY
