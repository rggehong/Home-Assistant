#!/usr/bin/env bash
set -euo pipefail

cd /opt/gree-ac-control
set -a
. ./.env
set +a

.venv/bin/python -c '
from pydantic import ValidationError
from app.main import Command
assert Command(target_temperature=25.5).target_temperature == 25.5
try:
    Command(target_temperature=25.3)
except ValidationError:
    pass
else:
    raise AssertionError("25.3 must be rejected")
print("HALF_DEGREE_SCHEMA_OK")
'

curl --fail --silent --show-error \
  -H "Authorization: Bearer ${GREE_API_TOKEN}" \
  "http://127.0.0.1:8765/api/devices?refresh=false" \
  | .venv/bin/python -c '
import json
import sys
devices = json.load(sys.stdin)
assert len(devices) == 3
living = next(device for device in devices if device["room"] == "客厅")
bedrooms = [device for device in devices if device["room"] != "客厅"]
assert living["capabilities"]["lower_outlet"] is True
assert all(device["capabilities"]["lower_outlet"] is False for device in bedrooms)
assert all(device["lower_outlet"] is None for device in bedrooms)
for device in sorted(devices, key=lambda item: item["room"]):
    print(
        device["room"],
        "model=", device["model"],
        "name=", device["name"],
        "firmware=", device.get("firmware"),
        "protocol=", device.get("protocol_version"),
        "target=", device["target_temperature"],
        "lower_outlet=", device["lower_outlet"],
        "capability=", device["capabilities"]["lower_outlet"],
    )
'

curl --fail --silent --show-error \
  --resolve home.gezhixin.cn:4430:127.0.0.1 \
  "https://home.gezhixin.cn:4430/" \
  | grep -q 'h5.css?v=6'

curl --fail --silent --show-error \
  --resolve home.gezhixin.cn:4430:127.0.0.1 \
  "https://home.gezhixin.cn:4430/desktop" \
  | grep -q 'styles.css?v=5'

echo "HTTPS_PAGES_V6_OK"
