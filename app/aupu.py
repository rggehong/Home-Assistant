from __future__ import annotations

import asyncio
import json
import os
import socket
import struct
import time
import hashlib
from pathlib import Path
from typing import Any

from Crypto.Cipher import AES
from pydantic import BaseModel, Field


AUPU_IP = os.getenv("AUPU_IP", "192.168.0.144")
AUPU_MAC = os.getenv("AUPU_MAC", "64:9e:31:3d:df:8b").lower()
AUPU_MODEL = "aupu.bhf_light.360ap"
AUPU_NAME = "奥普 Q360A-Pro"

MODE_LABELS = {
    0: "待机",
    1: "弱暖风",
    2: "强暖风",
    3: "吹风",
    4: "换气",
    5: "干燥",
    6: "杀菌除臭",
}
MODE_VALUES = {label: value for value, label in MODE_LABELS.items()}
PROPERTIES = {
    "light": {"did": "light:on", "siid": 2, "piid": 1},
    "mode": {"did": "ptc-bath-heater:mode", "siid": 4, "piid": 2},
    "external_light": {"did": "externlight:on", "siid": 6, "piid": 1},
}
MIIO_HELLO = bytes.fromhex(
    "21310020ffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
)


class AupuError(RuntimeError):
    pass


class AupuCommand(BaseModel):
    mode: int | None = Field(default=None, ge=0, le=6)
    light: bool | None = None
    external_light: bool | None = None


class AupuSetupRequest(BaseModel):
    username: str = Field(min_length=1, max_length=160)
    password: str = Field(min_length=1, max_length=256)
    locale: str = Field(default="cn", pattern=r"^(cn|de|us|ru|tw|sg|in|i2)$")


class AupuController:
    def __init__(self) -> None:
        data_dir = Path(
            os.getenv(
                "GREE_DATA_DIR",
                str(Path(__file__).resolve().parent.parent / "data"),
            )
        )
        self.path = data_dir / "aupu.json"
        self.lock = asyncio.Lock()

    def _load_config(self) -> dict[str, Any]:
        token = os.getenv("AUPU_MIIO_TOKEN", "").strip()
        if token:
            return {"token": token, "ip": AUPU_IP, "model": AUPU_MODEL}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, TypeError):
            return {}
        return data if isinstance(data, dict) else {}

    def _save_config(self, device: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "ip": AUPU_IP,
            "mac": AUPU_MAC,
            "model": AUPU_MODEL,
            "did": str(device.get("did") or ""),
            "token": str(device["token"]),
            "locale": str(device.get("locale") or "cn"),
            "bound_at": int(time.time()),
        }
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
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
    def _hello() -> bool:
        packet = bytes.fromhex("21310020ffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(1.2)
        try:
            sock.sendto(packet, (AUPU_IP, 54321))
            reply, _ = sock.recvfrom(64)
            return len(reply) >= 32 and reply[:2] == b"\x21\x31"
        except OSError:
            return False
        finally:
            sock.close()

    @staticmethod
    def _device_value(device: Any, key: str) -> Any:
        if isinstance(device, dict):
            return device.get(key)
        return getattr(device, key, None)

    def _cloud_bind(self, username: str, password: str, locale: str) -> dict[str, Any]:
        try:
            from micloud import MiCloud
        except ImportError as exc:
            raise AupuError("服务器缺少米家连接组件") from exc

        try:
            cloud = MiCloud(username, password)
            if not cloud.login():
                raise AupuError("米家登录失败，请检查账号、密码和地区")
            devices = cloud.get_devices(country=locale)
        except Exception as exc:
            if isinstance(exc, AupuError):
                raise
            raise AupuError("米家登录失败，请检查账号、密码和地区") from exc

        matches = []
        values = devices.values() if isinstance(devices, dict) else devices
        for device in values:
            item = {
                key: self._device_value(device, key)
                for key in ("did", "token", "mac", "name", "model", "localip", "ip")
            }
            item["locale"] = locale
            item["mac"] = str(item.get("mac") or "").lower()
            item["ip"] = item.get("localip") or item.get("ip")
            if (
                item.get("model") == AUPU_MODEL
                or item["mac"] == AUPU_MAC
                or item.get("ip") == AUPU_IP
            ):
                matches.append(item)

        if not matches:
            raise AupuError("该米家账号中未找到 Q360A-Pro，请确认设备地区与账号")
        selected = next(
            (item for item in matches if item.get("model") == AUPU_MODEL),
            matches[0],
        )
        raw_token = selected.get("token")
        if isinstance(raw_token, bytes):
            token = raw_token.hex()
        else:
            token = str(raw_token or "").strip()
        if len(token) != 32:
            raise AupuError("已找到设备，但米家未返回有效的本地控制令牌")
        selected["token"] = token
        self._save_config(selected)
        return selected

    @staticmethod
    def _crypt(token: bytes, data: bytes, encrypt: bool) -> bytes:
        key = hashlib.md5(token).digest()
        iv = hashlib.md5(key + token).digest()
        cipher = AES.new(key, AES.MODE_CBC, iv)
        return cipher.encrypt(data) if encrypt else cipher.decrypt(data)

    @classmethod
    def _miio_send(cls, token_hex: str, method: str, params: list[dict[str, Any]]) -> Any:
        try:
            token = bytes.fromhex(token_hex)
        except ValueError as exc:
            raise AupuError("浴霸本地控制令牌格式无效") from exc
        if len(token) != 16:
            raise AupuError("浴霸本地控制令牌格式无效")

        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(3)
            try:
                sock.sendto(MIIO_HELLO, (AUPU_IP, 54321))
                hello, _ = sock.recvfrom(64)
                if len(hello) < 32 or hello[:2] != b"\x21\x31":
                    raise AupuError("浴霸返回了无效的握手数据")
                device_id = hello[8:12]
                stamp = struct.unpack(">I", hello[12:16])[0]
                clear = json.dumps(
                    {
                        "id": int(time.time() * 1000) % 999999,
                        "method": method,
                        "params": params,
                    },
                    separators=(",", ":"),
                    ensure_ascii=False,
                ).encode("utf-8")
                padding = 16 - len(clear) % 16
                encrypted = cls._crypt(
                    token,
                    clear + bytes([padding]) * padding,
                    True,
                )
                header = (
                    b"\x21\x31"
                    + struct.pack(">H", 32 + len(encrypted))
                    + b"\x00\x00\x00\x00"
                    + device_id
                    + struct.pack(">I", stamp + 1)
                )
                checksum = hashlib.md5(header + token + encrypted).digest()
                sock.sendto(header + checksum + encrypted, (AUPU_IP, 54321))
                response, _ = sock.recvfrom(8192)
            except socket.timeout as exc:
                raise AupuError("浴霸暂时无法响应，请稍后重试") from exc
            except OSError as exc:
                raise AupuError("浴霸网络连接失败") from exc

        if len(response) < 32:
            raise AupuError("浴霸返回了不完整的数据")
        expected = hashlib.md5(response[:16] + token + response[32:]).digest()
        if expected != response[16:32]:
            raise AupuError("浴霸响应校验失败")
        decrypted = cls._crypt(token, response[32:], False)
        padding = decrypted[-1]
        try:
            payload = json.loads(decrypted[:-padding])
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AupuError("浴霸返回了无法识别的数据") from exc
        if payload.get("error"):
            raise AupuError("浴霸拒绝了本次请求")
        return payload.get("result")

    def _read(self, config: dict[str, Any]) -> dict[str, Any]:
        parameters = [dict(value) for value in PROPERTIES.values()]
        try:
            result = self._miio_send(
                str(config["token"]),
                "get_properties",
                parameters,
            )
        except Exception as exc:
            raise AupuError("浴霸暂时无法响应，请稍后重试") from exc
        if not isinstance(result, list):
            raise AupuError("浴霸返回了无法识别的状态")
        values: dict[str, Any] = {}
        for name, response in zip(PROPERTIES, result):
            if isinstance(response, dict):
                if response.get("code", 0) != 0:
                    continue
                values[name] = response.get("value")
        mode = int(values.get("mode", 0))
        return {
            "configured": True,
            "online": True,
            "ip": AUPU_IP,
            "name": AUPU_NAME,
            "model": "Q360A-Pro",
            "miot_model": AUPU_MODEL,
            "mode": mode,
            "mode_name": MODE_LABELS.get(mode, f"模式 {mode}"),
            "modes": [{"value": value, "label": label} for value, label in MODE_LABELS.items()],
            "light": bool(values.get("light", False)),
            "external_light": bool(values.get("external_light", False)),
        }

    async def status(self) -> dict[str, Any]:
        config = self._load_config()
        if not config.get("token"):
            return {
                "configured": False,
                "online": await asyncio.to_thread(self._hello),
                "ip": AUPU_IP,
                "name": AUPU_NAME,
                "model": "Q360A-Pro",
                "miot_model": AUPU_MODEL,
                "mode": None,
                "mode_name": "等待连接米家",
                "modes": [
                    {"value": value, "label": label}
                    for value, label in MODE_LABELS.items()
                ],
                "light": None,
                "external_light": None,
            }
        try:
            return await asyncio.to_thread(self._read, config)
        except AupuError as exc:
            return {
                "configured": True,
                "online": False,
                "ip": AUPU_IP,
                "name": AUPU_NAME,
                "model": "Q360A-Pro",
                "miot_model": AUPU_MODEL,
                "mode": None,
                "mode_name": "离线",
                "modes": [
                    {"value": value, "label": label}
                    for value, label in MODE_LABELS.items()
                ],
                "light": None,
                "external_light": None,
                "error": str(exc),
            }

    async def setup(self, payload: AupuSetupRequest) -> dict[str, Any]:
        async with self.lock:
            await asyncio.to_thread(
                self._cloud_bind,
                payload.username,
                payload.password,
                payload.locale,
            )
            return await self.status()

    def _set(self, config: dict[str, Any], payload: AupuCommand) -> None:
        updates = []
        for name in ("mode", "light", "external_light"):
            value = getattr(payload, name)
            if value is None:
                continue
            updates.append({**PROPERTIES[name], "value": value})
        if not updates:
            return
        try:
            result = self._miio_send(
                str(config["token"]),
                "set_properties",
                updates,
            )
        except Exception as exc:
            raise AupuError("浴霸控制失败，请确认设备在线") from exc
        if not isinstance(result, list) or any(
            not isinstance(item, dict) or item.get("code", 0) != 0
            for item in result
        ):
            raise AupuError("浴霸拒绝了本次设置")

    async def command(self, payload: AupuCommand) -> dict[str, Any]:
        async with self.lock:
            config = self._load_config()
            if not config.get("token"):
                raise AupuError("请先连接米家账号以获取浴霸本地控制令牌")
            await asyncio.to_thread(self._set, config, payload)
            await asyncio.sleep(0.25)
            return await asyncio.to_thread(self._read, config)


aupu = AupuController()
