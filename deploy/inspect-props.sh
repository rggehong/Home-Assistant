#!/usr/bin/env bash
set -euo pipefail

cd /opt/gree-ac-control
set -a
. ./.env
set +a

.venv/bin/python - <<'PY'
import asyncio
from app.main import registry

async def main():
    await registry.discover()
    for device in registry.devices.values():
        info = device.device_info
        if info.ip != "192.168.0.124":
            continue
        print("DEVICE", info.ip, getattr(info, "name", None), getattr(info, "model", None))
        for key, value in sorted(device.raw_properties.items()):
            print(f"{key}={value}")

asyncio.run(main())
PY
