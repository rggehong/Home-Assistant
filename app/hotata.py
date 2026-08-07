"""Hotata smart clothes airer cloud integration.

Protocol/signing details are adapted for this non-commercial home project from
https://github.com/C3H3-AI/ha-hotata-airer (CC BY-NC 4.0, C3H3-AI/duola).
This implementation stores cloud tokens only; the user's password is never
written to disk or returned by the API.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Literal

from cryptography.hazmat.primitives import hashes, padding as sym_padding, serialization
from cryptography.hazmat.primitives.asymmetric import padding as asym_padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from pydantic import BaseModel, Field


HOTATA_IP = os.getenv("HOTATA_AIRER_IP", "192.168.0.107")
HOTATA_MAC = "40:2A:8F:56:45:28"
API_BASE = "https://saas.keyoo.com/app-api/v2.0"
API_LOGIN_PASSWORD = f"{API_BASE}/login/password"
API_REFRESH_TOKEN = f"{API_BASE}/login/spLogin/refreshToken"
API_DEVICE_LIST = f"{API_BASE}/sp/device/getSpDeviceList"
API_PROPERTY_GET = f"{API_BASE}/device/property/get"
API_PROPERTY_SET = f"{API_BASE}/device/property/set2"
API_ONLINE_STATUS = f"{API_BASE}/device/synOnlineStatus"

APP_KEY = "miniapp-hotata-prod"
APP_SECRET = "B322B40A-DBD2-26A2-F935-6E760917CB73"
APP_VERSION = "miniapp_4.4.6.1"
APP_VERSION_APP = "3.5.8"
IMEI = "Windows Unknown x64_w4.1.10.53_s3.16.1"
PHONE_MODEL = "microsoft"
SYS_VERSION = "Windows Unknown x64"
AES_KEY = b"SnqUuPDWy5wusGG7"
AES_IV = b"tvGjXli9WjpfOmNK"
ACCOUNT_PRIVATE_KEY = (
    "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCXAsmTBgCKxOZ3"
    "okMNkjw9h6X2BD5CJ8sQhNBGBoTEUf3USNbnLiN9gpYLCziK50M5BsOAIADqxbsN"
    "/K7cYwNMtoKFKiTqTajM4tAJ3LKL1MlpEZM7uPjS1EKi9WNXalnfaI+9VrnuHXi"
    "AZc9idZdx4oxeD4PwKHjKzqIFNHC9WrvoofUabZkzrfSjygiJKUSeWGHtyPB/YC+"
    "rt1lGFGMZcFY5BX4ww1EquWeulzoWQcOsKwjUDmU5KM5HwUt1z7fFtN1XXM4tTA"
    "owZ08mmMorDQso9icMX0jCbraRX0HL9q6eK8jjeFFhcMYDX2rcM2+8X9Zd/56SR"
    "GImjP+sdCs7AgMBAAECggEAHb4izZ5lBO/7JJ0E7+tZihTpjycOzCDiUgKWsvQdu"
    "j0b7W/bQ/VGcDYEL3CqVlFuYBEA+H9VLuh7Cyo1lpq5z6Yy1t+SHcPl91TE/OxH"
    "Dlt+v/8CLMUl3QCJj2cdhd4gjWwew4ANZuTPExr6Wb4ncfrZAr2zkt2lzOwd5UC"
    "K5ABpdKNozwC+Gpt7RV5nFw8dqL1ODH7q6zGVEEQWA9WG9LV6zrv1dfuP4X1X6x"
    "l1USdcWZbJql7Zw1acXC7DSpmd4pqRhp0Dn0iL8x3fRMgXMD1aEc7aTRqgkR02y"
    "8CdlX9vCpW6GYSImn3YbngL/GTzZIEaxnM/ejnd57iaEJ56wQKBgQDNKJUdMOSb"
    "pQ1SKMyxiCvophlF40r1kLPQ+JrIM2V7RuTSxUUJhk9xI5l9+RdpvRb4bhMvBsC"
    "wy+vHcDk4bhv55snkF0+R2wz2UsnvgIPOx8Aju4ojkfgOdW0pQh4sQGykbWjEQ"
    "767q7vfhHVCeHHpylT2RVLkcapLiy8RK+VpIwKBgQC8bwlS/E5DiidNBkLTDEpL"
    "tbVqYkq+hRMEyAg2ep2OX1kl6sWwC8Vj2sEqCY/9MplZ3DdcHocjNU2IkksUWgeB"
    "Vk0ushQsIcWjOQv+GUhjiuAs28CoP64dvzT1xNV8PIF2HpRv+SheHkuSFOtg3UW"
    "c7CmC5Ea/uwgyV1SxoaCzCQKBgQCvG0FSvgWRt2nMQ1ia+tAHbaXKmfrD6DMiXN"
    "63m+61LshmAcwwGfw6ZBlBhVbvgF5XwpQLImdbP2JKQsYEHS8xuEN/tEnNAztoD"
    "zeefYGC/8lGdm6sd41SwfVfLrjUKlTQbzXptqzYP/dGCyeOiYEo+/JSlM7wfvfM"
    "LMsKi/3uIwKBgQCPmyfGANc8jdtpzi27XhB5JqB91S8Vh6F48WGg802EJZJxXT0P"
    "78idUygHe4Yq9xb77uKZ6AIhiQvv214wwnQZ08W6oqjRAWP4Aw/qtSYABuTWCxw"
    "GnZF6xi/8Zeg1aH9Zn/CMbZygLgJ18E96YOgesbTpNkPc9xNGGlxHi+BG0QKBgC"
    "5CtDrJrzqBNlxjRBM9gKF3b/T2HotQEDOB5V6uwgWUq0m2E2XOPMFe7Qw2jp2Ki"
    "+a8Utz+6DRfcpAeFM+Dh0nf8Ue1UxPTYHPPN4pfKdODpcTNn0XIhQS6OwmD5sUA"
    "pF3D1ew1K1cECU1bjlT2F1Sws4xEH+OMGrhQadNNtG1z"
)
_RSA_PRIVATE_KEY = serialization.load_der_private_key(
    base64.b64decode(ACCOUNT_PRIVATE_KEY), password=None
)


class HotataError(RuntimeError):
    pass


class HotataLoginRequest(BaseModel):
    username: str = Field(pattern=r"^1\d{10}$")
    password: str = Field(min_length=4, max_length=128)


class HotataCommand(BaseModel):
    action: Literal["up", "down", "stop", "best_position", "light", "disinfection"]
    enabled: bool | None = None


class HotataSettings(BaseModel):
    best_position: int = Field(ge=0, le=100)
    full_travel_seconds: int = Field(ge=0, le=180)


def _encrypt_password(password: str) -> str:
    padder = sym_padding.PKCS7(128).padder()
    padded = padder.update(password.encode()) + padder.finalize()
    encryptor = Cipher(algorithms.AES(AES_KEY), modes.CBC(AES_IV)).encryptor()
    return base64.b64encode(encryptor.update(padded) + encryptor.finalize()).decode()


def _login_body(values: dict[str, Any]) -> dict[str, Any]:
    body = {
        **values,
        "appVersion": APP_VERSION_APP,
        "sysVersion": "android_15",
        "traceId": str(uuid.uuid4()),
        "imei": str(uuid.uuid4()),
        "phoneModel": "Home Assistant",
        "timestamp": int(time.time() * 1000),
    }
    plain = "&".join(
        f"{key}={value}"
        for key, value in sorted(body.items())
        if value is not None and not isinstance(value, (list, dict))
    )
    signature = _RSA_PRIVATE_KEY.sign(
        plain.encode(), asym_padding.PKCS1v15(), hashes.SHA256()
    )
    body["sign"] = base64.b64encode(signature).decode()
    return body


def _sign(payload: dict[str, Any]) -> str:
    values = []
    for key in sorted(payload):
        value = payload[key]
        if key == "sign" or value is None or value == "" or isinstance(value, (dict, list)):
            continue
        values.append(f"{key}={value}")
    return hashlib.md5(("&".join(values) + APP_SECRET).encode()).hexdigest()


class HotataController:
    def __init__(self) -> None:
        data_dir = Path(os.getenv("GREE_DATA_DIR", Path(__file__).parent.parent / "data"))
        self.path = data_dir / "hotata.json"
        self.lock = asyncio.Lock()
        self._position_task: asyncio.Task[None] | None = None

    def _load(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, TypeError):
            return {}
        return data if isinstance(data, dict) else {}

    def _save(self, config: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        temporary.replace(self.path)
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    @staticmethod
    def _post(url: str, payload: dict[str, Any], token: str = "") -> dict[str, Any]:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if token:
            headers["Authorization"] = token
        request = urllib.request.Request(
            url,
            data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            message = exc.read().decode("utf-8", errors="replace")
            try:
                return json.loads(message)
            except json.JSONDecodeError as parse_error:
                raise HotataError(f"好太太云端请求失败 ({exc.code})") from parse_error
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise HotataError(f"好太太云端连接失败：{exc}") from exc

    @staticmethod
    def _base_payload(user_id: str, iot_id: str = "") -> dict[str, Any]:
        timestamp = int(time.time() * 1000)
        payload: dict[str, Any] = {
            "userid": user_id,
            "userId": user_id,
            "appKey": APP_KEY,
            "appVersion": APP_VERSION,
            "timestamp": timestamp,
            "traceId": f"home_{timestamp}",
            "sysVersion": SYS_VERSION,
            "phoneModel": PHONE_MODEL,
            "imei": IMEI,
        }
        if iot_id:
            payload["iotId"] = iot_id
        return payload

    @staticmethod
    def _message(data: dict[str, Any]) -> str:
        return str(data.get("message") or data.get("msg") or "未知错误")

    def _refresh_sync(self, config: dict[str, Any]) -> bool:
        if not config.get("refresh_token"):
            return False
        timestamp = int(time.time() * 1000)
        payload = {
            "refreshToken": config["refresh_token"],
            "appKey": APP_KEY,
            "appVersion": APP_VERSION,
            "timestamp": timestamp,
            "traceId": f"refresh_{timestamp}",
            "sysVersion": SYS_VERSION,
            "phoneModel": PHONE_MODEL,
            "imei": IMEI,
        }
        payload["sign"] = _sign(payload)
        data = self._post(API_REFRESH_TOKEN, payload)
        if str(data.get("code")) != "000":
            return False
        result = data.get("data") or {}
        token_type = str(result.get("tokenType") or "bearer").strip()
        config["access_token"] = f"{token_type} {result.get('accessToken')}"
        config["refresh_token"] = result.get("refreshToken") or config["refresh_token"]
        config["expires_at"] = time.time() + int(result.get("expiresIn") or 2591999)
        self._save(config)
        return True

    def _request_configured_sync(
        self, url: str, payload: dict[str, Any], config: dict[str, Any]
    ) -> dict[str, Any]:
        if float(config.get("expires_at") or 0) < time.time() + 120:
            self._refresh_sync(config)
        data = self._post(url, payload, str(config.get("access_token") or ""))
        if str(data.get("code")) in {"401", "1073"} and self._refresh_sync(config):
            payload["timestamp"] = int(time.time() * 1000)
            payload["traceId"] = f"retry_{payload['timestamp']}"
            payload["sign"] = _sign(payload)
            data = self._post(url, payload, str(config.get("access_token") or ""))
        return data

    async def login(self, request: HotataLoginRequest) -> dict[str, Any]:
        async with self.lock:
            body = _login_body({
                "username": request.username.strip(),
                "registeredId": str(uuid.uuid4()),
                "password": _encrypt_password(request.password),
            })
            data = await asyncio.to_thread(self._post, API_LOGIN_PASSWORD, body)
            if str(data.get("code")) != "000":
                code = str(data.get("code") or "")
                messages = {
                    "1032": "该手机号尚未注册好太太账号",
                    "1035": "密码格式或密码不正确",
                }
                raise HotataError(messages.get(code) or self._message(data))
            result = data.get("data") or {}
            user_id = result.get("userId") or result.get("userid")
            access_token = result.get("accessToken")
            if not user_id or not access_token:
                raise HotataError("登录成功但未返回完整授权信息")
            token_type = str(result.get("tokenType") or "bearer").strip()
            config = {
                "username": request.username.strip(),
                "user_id": user_id,
                "access_token": f"{token_type} {access_token}",
                "refresh_token": result.get("refreshToken") or "",
                "expires_at": time.time() + int(result.get("expiresIn") or 2591999),
                "best_position": 50,
                "full_travel_seconds": 0,
                "simulated_position": 100,
            }
            devices = await asyncio.to_thread(self._devices_sync, config)
            if not devices:
                raise HotataError("账号已登录，但没有发现好太太晾衣机")
            device = next(
                (item for item in devices if self._normalise_mac(item.get("devicename")) == HOTATA_MAC.replace(":", "")),
                devices[0],
            )
            config["device"] = device
            self._save(config)
        return await self.status()

    @staticmethod
    def _normalise_mac(value: Any) -> str:
        return "".join(character for character in str(value or "").upper() if character in "0123456789ABCDEF")

    def _devices_sync(self, config: dict[str, Any]) -> list[dict[str, Any]]:
        payload = self._base_payload(str(config["user_id"]))
        payload["sign"] = _sign(payload)
        data = self._request_configured_sync(API_DEVICE_LIST, payload, config)
        devices = data.get("data") if str(data.get("code")) == "000" else []
        return devices if isinstance(devices, list) else []

    @staticmethod
    def _iot_id(config: dict[str, Any]) -> str:
        device = config.get("device") or {}
        return str(device.get("iotid") or device.get("iotId") or "")

    def _state_sync(self, config: dict[str, Any]) -> dict[str, Any]:
        iot_id = self._iot_id(config)
        payload = self._base_payload(str(config["user_id"]), iot_id)
        payload["sign"] = _sign(payload)
        properties = self._request_configured_sync(API_PROPERTY_GET, payload, config)
        state: dict[str, Any] = {}
        if str(properties.get("code")) == "000":
            for item in properties.get("data") or []:
                if isinstance(item, dict) and item.get("attribute"):
                    state[str(item["attribute"])] = item.get("value")

        online_payload = self._base_payload(str(config["user_id"]), iot_id)
        online_payload["sign"] = _sign(online_payload)
        online_result = self._request_configured_sync(API_ONLINE_STATUS, online_payload, config)
        online = False
        if str(online_result.get("code")) == "000":
            online = bool((online_result.get("data") or {}).get("onlineStatus"))
        return {"online": online, "properties": state}

    async def status(self) -> dict[str, Any]:
        config = self._load()
        base = {
            "configured": bool(config.get("access_token") and self._iot_id(config)),
            "ip": HOTATA_IP,
            "mac": HOTATA_MAC,
            "name": "好太太晾衣机",
            "online": False,
            "light": None,
            "disinfection": None,
            "motor_mode": None,
            "motor_text": "等待授权",
            "best_position": int(config.get("best_position") or 50),
            "full_travel_seconds": int(config.get("full_travel_seconds") or 0),
            "simulated_position": int(config.get("simulated_position") or 100),
        }
        if not base["configured"]:
            return base
        try:
            state = await asyncio.to_thread(self._state_sync, config)
        except HotataError as exc:
            return {**base, "error": str(exc)}
        props = state["properties"]
        try:
            motor_mode = int(float(props.get("MotorControlMode", 0)))
        except (TypeError, ValueError):
            motor_mode = None
        return {
            **base,
            "online": state["online"],
            "light": props.get("LightSwitch") in (True, 1, "1", "true"),
            "disinfection": props.get("DisinfectionSwitch") in (True, 1, "1", "true"),
            "motor_mode": motor_mode,
            "motor_text": {0: "已停止", 1: "上升中", 2: "下降中"}.get(motor_mode, "状态未知"),
            "raw_position": props.get("Position"),
        }

    async def _set_properties(self, config: dict[str, Any], values: dict[str, Any]) -> None:
        payload = self._base_payload(str(config["user_id"]), self._iot_id(config))
        payload["paramJson"] = json.dumps(values, separators=(",", ":"))
        payload["sign"] = _sign(payload)
        result = await asyncio.to_thread(
            self._request_configured_sync, API_PROPERTY_SET, payload, config
        )
        if str(result.get("code")) != "000":
            raise HotataError(self._message(result))

    async def _cancel_position_task(self) -> None:
        if self._position_task and not self._position_task.done():
            self._position_task.cancel()
            await asyncio.gather(self._position_task, return_exceptions=True)
        self._position_task = None

    async def _auto_stop(self, seconds: float, target: int) -> None:
        try:
            await asyncio.sleep(seconds)
            config = self._load()
            await self._set_properties(config, {"MotorControlMode": 0})
            config["simulated_position"] = target
            self._save(config)
        except asyncio.CancelledError:
            raise
        except Exception:
            # The device's own end stop remains the final mechanical safeguard.
            return

    async def command(self, request: HotataCommand) -> dict[str, Any]:
        async with self.lock:
            config = self._load()
            if not config.get("access_token") or not self._iot_id(config):
                raise HotataError("请先连接好太太账号")
            action = request.action
            if action in {"up", "down", "stop"}:
                await self._cancel_position_task()
                mode = {"stop": 0, "up": 1, "down": 2}[action]
                await self._set_properties(config, {"MotorControlMode": mode})
                if action == "up":
                    config["simulated_position"] = 100
                elif action == "down":
                    config["simulated_position"] = 0
                self._save(config)
            elif action == "light":
                if request.enabled is None:
                    raise HotataError("照明指令缺少开关状态")
                await self._set_properties(config, {"LightSwitch": int(request.enabled)})
            elif action == "disinfection":
                if request.enabled is None:
                    raise HotataError("除菌指令缺少开关状态")
                await self._set_properties(config, {"DisinfectionSwitch": int(request.enabled)})
            elif action == "best_position":
                travel = int(config.get("full_travel_seconds") or 0)
                target = int(config.get("best_position") or 50)
                current = int(config.get("simulated_position") or 100)
                if travel <= 0:
                    raise HotataError("请先校准完整升降耗时，再使用最佳收衣点")
                if target >= current:
                    raise HotataError("当前估算高度不低于收衣点，请先上升到顶后再定位")
                await self._cancel_position_task()
                await self._set_properties(config, {"MotorControlMode": 2})
                seconds = max(0.5, (current - target) / 100 * travel)
                self._position_task = asyncio.create_task(self._auto_stop(seconds, target))
        await asyncio.sleep(0.25)
        return await self.status()

    async def update_settings(self, request: HotataSettings) -> dict[str, Any]:
        async with self.lock:
            config = self._load()
            config["best_position"] = request.best_position
            config["full_travel_seconds"] = request.full_travel_seconds
            self._save(config)
        return await self.status()


hotata = HotataController()
