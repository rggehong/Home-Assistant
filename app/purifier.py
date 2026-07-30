from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field


PURIFIER_IP = os.getenv("AOS_PURIFIER_IP", "192.168.0.138")
PURIFIER_MODEL = "DR1600HF2"
PURIFIER_NAME = "A.O.史密斯净水机"
AILINK_BASE_URL = os.getenv(
    "AILINK_BASE_URL",
    "https://ailink-api.hotwater.com.cn/AiLinkService",
).rstrip("/")
AILINK_BODY_SECRET = "AILink_2021#"
AILINK_SIGN_SECRET = "ng957stzh4zy3dts"


class PurifierError(RuntimeError):
    pass


class PurifierCaptchaRequest(BaseModel):
    mobile: str = Field(pattern=r"^1\d{10}$")


class PurifierSmsRequest(PurifierCaptchaRequest):
    ticket: str = Field(min_length=8, max_length=4096)
    randstr: str = Field(min_length=2, max_length=256)


class PurifierLoginRequest(PurifierCaptchaRequest):
    captcha: str = Field(min_length=4, max_length=8)


def _md5(value: str) -> str:
    return hashlib.md5(value.encode("utf-8")).hexdigest()


def _string_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


class PurifierController:
    def __init__(self) -> None:
        data_dir = Path(
            os.getenv(
                "GREE_DATA_DIR",
                str(Path(__file__).resolve().parent.parent / "data"),
            )
        )
        self.path = data_dir / "purifier.json"
        self.lock = asyncio.Lock()

    def _load_config(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, TypeError):
            return {}
        return data if isinstance(data, dict) else {}

    def _save_config(self, config: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(config, ensure_ascii=False, indent=2),
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

    @staticmethod
    def _response_message(data: dict[str, Any]) -> str:
        return str(
            data.get("msg")
            or data.get("message")
            or data.get("Message")
            or data.get("error")
            or ""
        )

    @staticmethod
    def _is_success(data: dict[str, Any]) -> bool:
        status = data.get("status", data.get("code", data.get("Status")))
        if status is None:
            return True
        return status in (0, 1, 200, "0", "1", "200", "success", "SUCCESS")

    @staticmethod
    def _result(data: dict[str, Any]) -> dict[str, Any]:
        for key in ("result", "data", "Result", "Data"):
            value = data.get(key)
            if isinstance(value, dict):
                merged = dict(data)
                merged.update(value)
                return merged
        return data

    @staticmethod
    def _normalise_key(value: str) -> str:
        return "".join(character for character in value.lower() if character.isalnum())

    @classmethod
    def _find_value(cls, data: Any, *aliases: str) -> str:
        wanted = {cls._normalise_key(alias) for alias in aliases}
        stack: list[Any] = [data]
        while stack:
            item = stack.pop()
            if isinstance(item, dict):
                for key, value in item.items():
                    if cls._normalise_key(str(key)) in wanted and value not in (None, ""):
                        if isinstance(value, (str, int, float)):
                            return str(value)
                    if isinstance(value, (dict, list)):
                        stack.append(value)
                    elif isinstance(value, str) and value[:1] in ("{", "["):
                        try:
                            stack.append(json.loads(value))
                        except json.JSONDecodeError:
                            pass
            elif isinstance(item, list):
                stack.extend(item)
        return ""

    def _request_sync(
        self,
        path: str,
        params: dict[str, Any],
        config: dict[str, Any] | None = None,
    ) -> tuple[dict[str, Any], str]:
        config = config or {}
        timestamp = str(int(time.time() * 1000))
        nonce = uuid4().hex

        # The Android client calculates anti-replay MD5 from the original map,
        # then serialises a case-insensitively sorted TreeMap with an encode field.
        md5data = _md5("".join(_string_value(value) for value in params.values()))
        sign = _md5(md5data + timestamp + nonce + AILINK_SIGN_SECRET)
        ordered = {
            key: params[key]
            for key in sorted(params, key=lambda item: (item.lower(), item))
        }
        encoded_values = "".join(_string_value(value) for value in ordered.values())
        ordered["encode"] = _md5(encoded_values + AILINK_BODY_SECRET)

        body = json.dumps(
            ordered,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        headers = {
            "Content-Type": "application/json;charset=UTF-8",
            "Accept": "application/json",
            "User-Agent": "AI-LiNK/2.1.8 Android",
            "traceId": uuid4().hex,
            "Authorization": str(config.get("token") or ""),
            "userId": str(config.get("user_id") or ""),
            "familyId": str(config.get("family_id") or ""),
            "familyUk": str(config.get("uk") or ""),
            "version": "V1.0.1",
            "source": "Android",
            "timestamp": timestamp,
            "nonce": nonce,
            "md5data": md5data,
            "sign": sign,
        }
        request = urllib.request.Request(
            AILINK_BASE_URL + path,
            data=body,
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                raw = response.read().decode("utf-8", errors="replace")
                token = response.headers.get("Authorization", "")
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                detail = self._response_message(json.loads(raw))
            except (json.JSONDecodeError, TypeError):
                detail = raw[:180]
            raise PurifierError(detail or f"AI-LiNK 请求失败（{exc.code}）") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise PurifierError(f"无法连接 AI-LiNK 云服务：{exc}") from exc
        try:
            result = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise PurifierError("AI-LiNK 返回了无法识别的数据") from exc
        if not isinstance(result, dict):
            raise PurifierError("AI-LiNK 返回格式不正确")
        return result, token

    async def _request(
        self,
        path: str,
        params: dict[str, Any],
        config: dict[str, Any] | None = None,
    ) -> tuple[dict[str, Any], str]:
        return await asyncio.to_thread(self._request_sync, path, params, config)

    async def send_captcha(self, payload: PurifierSmsRequest) -> dict[str, Any]:
        data, _ = await self._request(
            "/user/getTXCaptcha",
            {
                "mobile": payload.mobile,
                "type": "1",
                "ticket": payload.ticket,
                "randstr": payload.randstr,
            },
        )
        if not self._is_success(data):
            raise PurifierError(self._response_message(data) or "验证码发送失败")
        return {"sent": True, "message": self._response_message(data) or "验证码已发送"}

    async def login(self, payload: PurifierLoginRequest) -> dict[str, Any]:
        params = {
            "mobile": payload.mobile,
            "latitude": "",
            "longitude": "",
            "address": "",
            "province": "",
            "city": "",
            "district": "",
            "street": "",
            "streetNum": "",
            "adCode": "",
            "country": "",
            "captcha": payload.captcha,
        }
        async with self.lock:
            data, token = await self._request("/user/login", params)
            if not self._is_success(data):
                raise PurifierError(self._response_message(data) or "AI-LiNK 登录失败")
            token = token or self._find_value(
                data,
                "Authorization",
                "token",
                "accessToken",
                "access_token",
            )
            config = {
                "mobile": payload.mobile,
                "token": token,
                "user_id": self._find_value(
                    data,
                    "User_Id",
                    "userId",
                    "UserID",
                    "uid",
                ),
                "family_id": self._find_value(
                    data,
                    "Family_Id",
                    "familyId",
                    "FamilyID",
                ),
                "family_name": self._find_value(
                    data,
                    "Family_Name",
                    "familyName",
                ),
                "uk": self._find_value(data, "uk", "familyUk", "family_uk"),
                "bound_at": int(time.time()),
            }
            if not config["token"]:
                raise PurifierError("AI-LiNK 已登录，但服务端未返回登录令牌")
            # Newer AI-LiNK versions may not return family metadata in the
            # login response. Keep the valid token and let the device-list
            # request complete the binding instead of forcing another SMS login.
            self._save_config(config)
            return await self.status(refresh=True)

    @staticmethod
    def _device_list(data: dict[str, Any]) -> list[dict[str, Any]]:
        candidates: list[Any] = []
        stack: list[Any] = [data]
        while stack:
            item = stack.pop()
            if isinstance(item, dict):
                for key, value in item.items():
                    if key in ("newDevices", "devices", "deviceList", "list") and isinstance(value, list):
                        candidates.extend(value)
                    elif isinstance(value, (dict, list)):
                        stack.append(value)
            elif isinstance(item, list):
                stack.extend(item)
        return [item for item in candidates if isinstance(item, dict)]

    @staticmethod
    def _select_purifier(devices: list[dict[str, Any]]) -> dict[str, Any] | None:
        for device in devices:
            text = json.dumps(device, ensure_ascii=False).lower()
            if PURIFIER_MODEL.lower() in text:
                return device
        for device in devices:
            text = json.dumps(device, ensure_ascii=False).lower()
            if "净水" in text or "waterpurifier" in text or "water purifier" in text:
                return device
        return None

    @staticmethod
    def _online(device: dict[str, Any]) -> bool | None:
        for key in ("dev_Status", "Connect_Status", "Wifi_ConnectStatus", "online"):
            if key not in device:
                continue
            value = device[key]
            if isinstance(value, bool):
                return value
            return str(value).lower() in ("1", "true", "online", "connected")
        return None

    async def status(self, refresh: bool = True) -> dict[str, Any]:
        config = self._load_config()
        base: dict[str, Any] = {
            "id": "aosmith-water-purifier",
            "name": PURIFIER_NAME,
            "model": PURIFIER_MODEL,
            "ip": PURIFIER_IP,
            "configured": bool(config.get("token")),
            "online": None,
            "cloud": "AI-LiNK",
            "metrics": [],
        }
        if not base["configured"] or not refresh:
            return base
        try:
            data, token = await self._request(
                "/tsData/getDeviceList_V2",
                {
                    "Family_Id": config.get("family_id", ""),
                    "User_Id": config.get("user_id", ""),
                },
                config,
            )
            if token and token != config.get("token"):
                config["token"] = token
                self._save_config(config)
            if not self._is_success(data):
                message = self._response_message(data) or "读取设备列表失败"
                if str(data.get("status")) == "401":
                    message = "AI-LiNK 授权已过期，请重新连接"
                raise PurifierError(message)
            changed = False
            for key, aliases in (
                ("user_id", ("User_Id", "userId", "UserID", "uid")),
                ("family_id", ("Family_Id", "familyId", "FamilyID")),
                ("family_name", ("Family_Name", "familyName")),
                ("uk", ("uk", "familyUk", "family_uk")),
            ):
                if not config.get(key):
                    value = self._find_value(data, *aliases)
                    if value:
                        config[key] = value
                        changed = True
            if changed:
                self._save_config(config)
            devices = self._device_list(data)
            device = self._select_purifier(devices)
            if device is None:
                base["error"] = (
                    "AI-LiNK 家庭中未找到 DR1600HF2"
                    if devices
                    else "AI-LiNK 暂未返回设备"
                )
                return base
            base.update(
                {
                    "online": self._online(device),
                    "device_id": str(device.get("Device_Id") or device.get("deviceId") or ""),
                    "device_name": str(device.get("Product_Name") or device.get("name") or PURIFIER_NAME),
                    "room": str(device.get("Room_Name") or device.get("roomName") or ""),
                    "product_type": str(device.get("Product_Type") or device.get("productType") or ""),
                }
            )
            url = str(device.get("url") or "")
            if url.startswith(("https://", "http://")):
                base["detail_url"] = url
            return base
        except PurifierError as exc:
            message = str(exc)
            if message.strip().lower() == "resource not found":
                message = "AI-LiNK 授权已保存，设备数据接口仍在适配"
                base["authorization_saved"] = True
            base["error"] = message
            return base


purifier = PurifierController()
