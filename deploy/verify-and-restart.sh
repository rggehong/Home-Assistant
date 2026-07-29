#!/usr/bin/env bash
set -euo pipefail

cd /opt/gree-ac-control
.venv/bin/python -m compileall -q app
node --check app/static/app.js
node --check app/static/h5.js
systemctl restart gree-ac-control
sleep 8
systemctl is-active gree-ac-control
curl --fail --silent --show-error http://127.0.0.1:8765/health
