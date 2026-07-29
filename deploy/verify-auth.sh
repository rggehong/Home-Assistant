#!/usr/bin/env bash
set -euo pipefail

cd /opt/gree-ac-control
set -a
# shellcheck disable=SC1091
. ./.env
set +a

cookie_jar="$(mktemp)"
login_headers="$(mktemp)"
logout_headers="$(mktemp)"
trap 'rm -f "$cookie_jar" "$login_headers" "$logout_headers"' EXIT

base_url="https://home.gezhixin.cn:4430"
resolve_arg="home.gezhixin.cn:4430:127.0.0.1"

if [[ -z "${GREE_API_TOKEN:-}" ]]; then
  echo "GREE_API_TOKEN is not configured" >&2
  exit 1
fi

login_password="${GREE_WEB_PASSWORD:-$GREE_API_TOKEN}"
export login_password

python3 -c 'import json, os; print(json.dumps({"password": os.environ["login_password"]}))' |
  curl --fail --silent --show-error \
    --resolve "$resolve_arg" \
    --header "Content-Type: application/json" \
    --data-binary @- \
    --dump-header "$login_headers" \
    --cookie-jar "$cookie_jar" \
    "$base_url/api/auth/login" >/dev/null

grep -qi '^set-cookie: gree_home_session=' "$login_headers"
grep -qi 'httponly' "$login_headers"
grep -qi 'secure' "$login_headers"
grep -qi 'samesite=strict' "$login_headers"

curl --fail --silent --show-error \
  --resolve "$resolve_arg" \
  --cookie "$cookie_jar" \
  "$base_url/api/devices?refresh=false" >/dev/null

curl --fail --silent --show-error \
  --header "Authorization: Bearer $GREE_API_TOKEN" \
  "http://127.0.0.1:8765/api/devices?refresh=false" >/dev/null

curl --fail --silent --show-error \
  --resolve "$resolve_arg" \
  --cookie "$cookie_jar" \
  --cookie-jar "$cookie_jar" \
  --request POST \
  --dump-header "$logout_headers" \
  "$base_url/api/auth/logout" >/dev/null

status="$(
  curl --silent --output /dev/null --write-out '%{http_code}' \
    --resolve "$resolve_arg" \
    --cookie "$cookie_jar" \
    "$base_url/api/devices?refresh=false"
)"
test "$status" = "401"

echo "cookie_login=ok"
echo "cookie_flags=httponly,secure,samesite-strict"
echo "bearer_compatibility=ok"
echo "logout=ok"
