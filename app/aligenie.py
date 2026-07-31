from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


PUBLIC_BASE_URL = os.getenv(
    "GREE_PUBLIC_URL",
    "https://home.gezhixin.cn:4430",
).rstrip("/")
CLIENT_ID = os.getenv("ALIGENIE_CLIENT_ID", "").strip()
CLIENT_SECRET = os.getenv("ALIGENIE_CLIENT_SECRET", "").strip()
ALLOWED_REDIRECT_HOSTS = {"open.bot.tmall.com", "open.aligenie.com"}


class AliGenieOAuth:
    def __init__(self) -> None:
        data_dir = Path(
            os.getenv(
                "GREE_DATA_DIR",
                str(Path(__file__).resolve().parent.parent / "data"),
            )
        )
        self.path = data_dir / "aligenie.json"

    @staticmethod
    def _digest(value: str) -> str:
        return hashlib.sha256(value.encode()).hexdigest()

    def _load(self) -> dict[str, Any]:
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, TypeError):
            return {}
        return value if isinstance(value, dict) else {}

    def _save(self, value: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(value, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        temporary.replace(self.path)
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    @property
    def configured(self) -> bool:
        return bool(CLIENT_ID and CLIENT_SECRET)

    def setup(self, include_secret: bool = False) -> dict[str, Any]:
        result = {
            "configured": self.configured,
            "client_id": CLIENT_ID or None,
            "client_secret_configured": bool(CLIENT_SECRET),
            "authorize_url": f"{PUBLIC_BASE_URL}/aligenie/oauth/authorize",
            "token_url": f"{PUBLIC_BASE_URL}/aligenie/oauth/token",
            "gateway_url": f"{PUBLIC_BASE_URL}/aligenie/gateway",
            "developer_url": "https://open.bot.tmall.com/",
        }
        if include_secret:
            result["client_secret"] = CLIENT_SECRET or None
        return result

    @staticmethod
    def valid_redirect_uri(redirect_uri: str) -> bool:
        parsed = urlparse(redirect_uri)
        return (
            parsed.scheme == "https"
            and parsed.hostname in ALLOWED_REDIRECT_HOSTS
            and bool(parsed.path)
        )

    def valid_client(self, client_id: str, client_secret: str | None = None) -> bool:
        if not self.configured or not hmac.compare_digest(client_id, CLIENT_ID):
            return False
        return client_secret is None or hmac.compare_digest(client_secret, CLIENT_SECRET)

    def issue_code(self, client_id: str, redirect_uri: str) -> str:
        if not self.valid_client(client_id) or not self.valid_redirect_uri(redirect_uri):
            raise ValueError("invalid OAuth client or redirect URI")
        code = secrets.token_urlsafe(32)
        data = self._load()
        data["authorization_code"] = {
            "hash": self._digest(code),
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "expires_at": int(time.time()) + 300,
        }
        self._save(data)
        return code

    def exchange(
        self,
        *,
        grant_type: str,
        client_id: str,
        client_secret: str,
        code: str = "",
        refresh_token: str = "",
        redirect_uri: str = "",
    ) -> dict[str, Any]:
        if not self.valid_client(client_id, client_secret):
            return {
                "error": "invalid_client",
                "error_description": "client authentication failed",
            }
        data = self._load()
        now = int(time.time())
        if grant_type == "authorization_code":
            stored = data.get("authorization_code") or {}
            valid = (
                stored.get("expires_at", 0) >= now
                and hmac.compare_digest(str(stored.get("hash") or ""), self._digest(code))
                and hmac.compare_digest(str(stored.get("client_id") or ""), client_id)
                and hmac.compare_digest(str(stored.get("redirect_uri") or ""), redirect_uri)
            )
            if not valid:
                return {
                    "error": "invalid_grant",
                    "error_description": "authorization code is invalid or expired",
                }
        elif grant_type == "refresh_token":
            stored_hash = str(data.get("refresh_token_hash") or "")
            valid = (
                data.get("refresh_expires_at", 0) >= now
                and stored_hash
                and hmac.compare_digest(stored_hash, self._digest(refresh_token))
            )
            if not valid:
                return {
                    "error": "invalid_grant",
                    "error_description": "refresh token is invalid or expired",
                }
        else:
            return {
                "error": "unsupported_grant_type",
                "error_description": "grant type is not supported",
            }

        access_token = secrets.token_urlsafe(48)
        new_refresh_token = secrets.token_urlsafe(48)
        data.pop("authorization_code", None)
        data.update(
            {
                "access_token_hash": self._digest(access_token),
                "access_expires_at": now + 259200,
                "refresh_token_hash": self._digest(new_refresh_token),
                "refresh_expires_at": now + 31536000,
                "updated_at": now,
            }
        )
        self._save(data)
        return {
            "access_token": access_token,
            "refresh_token": new_refresh_token,
            "expires_in": 259200,
            "token_type": "bearer",
        }

    def valid_access_token(self, token: str) -> bool:
        if not token:
            return False
        data = self._load()
        stored_hash = str(data.get("access_token_hash") or "")
        return (
            data.get("access_expires_at", 0) >= int(time.time())
            and bool(stored_hash)
            and hmac.compare_digest(stored_hash, self._digest(token))
        )


def response_header(namespace: str, name: str, message_id: str) -> dict[str, Any]:
    return {
        "namespace": namespace,
        "name": name,
        "messageId": message_id,
        "payLoadVersion": 1,
    }


def error_response(
    namespace: str,
    message_id: str,
    device_id: str,
    error_code: str,
    message: str,
) -> dict[str, Any]:
    return {
        "header": response_header(namespace, "ErrorResponse", message_id),
        "payload": {
            "deviceId": device_id,
            "errorCode": error_code,
            "message": message,
        },
    }


aligenie_oauth = AliGenieOAuth()
