from __future__ import annotations

import asyncio
import json
import os
import socket
import time
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from app.aupu import AupuController, AupuError, MIIO_HELLO


PLUG_IP = os.getenv("MIJIA_PLUG_IP", "192.168.0.145")
PLUG_MAC = os.getenv("MIJIA_PLUG_MAC", "8c:d0:b2:ba:70:fe").lower()
PLUG_MODEL = "cuco.plug.v3"
PLUG_NAME = "米家智能插座 3"

PROPERTIES = {
    "on": {"did": "switch:on", "siid": 2, "piid": 1},
    "default_power_state": {
        "did": "switch:default-power-on-state",
        "siid": 2,
        "piid": 2,
    },
    "fault": {"did": "switch:fault", "siid": 2, "piid": 3},
    "physical_lock": {
        "did": "physical-controls-locked",
        "siid": 7,
        "piid": 1,
    },
    "energy_raw": {
        "did": "power-consumption:power-consumption",
        "siid": 11,
        "piid": 1,
    },
    "electric_power": {
        "did": "power-consumption:electric-power",
        "siid": 11,
        "piid": 2,
    },
    "on_off_count": {"did": "on-off-count:on-off-count", "siid": 12, "piid": 1},
    "temperature": {"did": "on-off-count:temperature", "siid": 12, "piid": 2},
    "indicator_light": {
        "did": "indicator-light:on",
        "siid": 13,
        "piid": 1,
    },
    "charging_protection": {
        "did": "charging-protection:on",
        "siid": 4,
        "piid": 1,
    },
    "max_power_limit": {
        "did": "max-power-limit:on",
        "siid": 9,
        "piid": 1,
    },
    "max_power": {
        "did": "max-power-limit:power",
        "siid": 9,
        "piid": 2,
    },
}

FAULT_LABELS = {0: "正常", 1: "过温", 2: "过载"}
DEFAULT_POWER_LABELS = {0: "恢复断电前状态", 1: "上电打开", 2: "上电关闭"}


class PlugCommand(BaseModel):
    on: bool | None = None
    default_power_state: int | None = Field(default=None, ge=0, le=2)
    physical_lock: bool | None = None
    indicator_light: bool | None = None
    charging_protection: bool | None = None
    max_power_limit: bool | None = None
    max_power: int | None = Field(default=None, ge=1500, le=2500, multiple_of=100)


class PlugController:
    def __init__(self) -> None:
        data_dir = Path(
            os.getenv(
                "GREE_DATA_DIR",
                str(Path(__file__).resolve().parent.parent / "data"),
            )
        )
        self.path = data_dir / "plug.json"
        self.lock = asyncio.Lock()

    @staticmethod
    def _device_value(device: Any, key: str) -> Any:
        if isinstance(device, dict):
            return device.get(key)
        return getattr(device, key, None)

    def _load_config(self) -> dict[str, Any]:
        token = os.getenv("MIJIA_PLUG_TOKEN", "").strip()
        if token:
            return {"token": token, "ip": PLUG_IP, "model": PLUG_MODEL}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, TypeError):
            return {}
        return data if isinstance(data, dict) else {}

    def _save_config(self, device: dict[str, Any]) -> None:
        raw_token = device.get("token")
        token = raw_token.hex() if isinstance(raw_token, bytes) else str(raw_token or "")
        if len(token) != 32:
            raise AupuError("米家未返回智能插座的有效本地令牌")
        payload = {
            "ip": PLUG_IP,
            "mac": PLUG_MAC,
            "model": str(device.get("model") or PLUG_MODEL),
            "did": str(device.get("did") or ""),
            "token": token,
            "locale": str(device.get("locale") or "cn"),
            "bound_at": int(time.time()),
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
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

    def bind_from_cloud(self, devices: Any, locale: str) -> bool:
        values = devices.values() if isinstance(devices, dict) else devices
        matches = []
        for device in values:
            item = {
                key: self._device_value(device, key)
                for key in ("did", "token", "mac", "name", "model", "localip", "ip")
            }
            item["locale"] = locale
            item["mac"] = str(item.get("mac") or "").lower()
            item["ip"] = item.get("localip") or item.get("ip")
            if (
                item.get("model") == PLUG_MODEL
                or item["mac"] == PLUG_MAC
                or item.get("ip") == PLUG_IP
            ):
                matches.append(item)
        if not matches:
            return False
        selected = next(
            (item for item in matches if item.get("model") == PLUG_MODEL),
            matches[0],
        )
        self._save_config(selected)
        return True

    @staticmethod
    def _hello() -> bool:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(1.2)
            try:
                sock.sendto(MIIO_HELLO, (PLUG_IP, 54321))
                reply, _ = sock.recvfrom(64)
                return len(reply) >= 32 and reply[:2] == b"\x21\x31"
            except OSError:
                return False

    @staticmethod
    def _base(configured: bool, online: bool) -> dict[str, Any]:
        return {
            "configured": configured,
            "online": online,
            "ip": PLUG_IP,
            "name": PLUG_NAME,
            "model": "智能插座 3",
            "miot_model": PLUG_MODEL,
        }

    def _read(self, config: dict[str, Any]) -> dict[str, Any]:
        try:
            result = AupuController._miio_send(
                PLUG_IP,
                str(config["token"]),
                "get_properties",
                [dict(value) for value in PROPERTIES.values()],
            )
        except AupuError as exc:
            raise AupuError("智能插座暂时无法响应，请稍后重试") from exc
        if not isinstance(result, list):
            raise AupuError("智能插座返回了无法识别的状态")
        values: dict[str, Any] = {}
        capabilities: list[str] = []
        for name, response in zip(PROPERTIES, result):
            if isinstance(response, dict) and response.get("code", 0) == 0:
                values[name] = response.get("value")
                capabilities.append(name)
        fault = int(values.get("fault", 0))
        default_state = int(values.get("default_power_state", 0))
        energy_raw = values.get("energy_raw")
        return {
            **self._base(True, True),
            "capabilities": capabilities,
            "on": bool(values.get("on", False)),
            "default_power_state": default_state,
            "default_power_state_name": DEFAULT_POWER_LABELS.get(
                default_state,
                str(default_state),
            ),
            "fault": fault,
            "fault_name": FAULT_LABELS.get(fault, f"故障 {fault}"),
            "energy_kwh": (
                round(float(energy_raw) * 0.01, 2)
                if energy_raw is not None
                else None
            ),
            "electric_power": values.get("electric_power"),
            "temperature": values.get("temperature"),
            "on_off_count": values.get("on_off_count"),
            "physical_lock": values.get("physical_lock"),
            "indicator_light": values.get("indicator_light"),
            "charging_protection": values.get("charging_protection"),
            "max_power_limit": values.get("max_power_limit"),
            "max_power": values.get("max_power"),
        }

    async def status(self) -> dict[str, Any]:
        config = self._load_config()
        if not config.get("token"):
            return {
                **self._base(False, await asyncio.to_thread(self._hello)),
                "capabilities": [],
                "on": None,
                "fault": None,
                "fault_name": "等待连接米家",
            }
        try:
            return await asyncio.to_thread(self._read, config)
        except AupuError as exc:
            return {
                **self._base(True, False),
                "capabilities": [],
                "on": None,
                "fault": None,
                "fault_name": "离线",
                "error": str(exc),
            }

    def _set(self, config: dict[str, Any], payload: PlugCommand) -> None:
        updates = []
        for name in (
            "on",
            "default_power_state",
            "physical_lock",
            "indicator_light",
            "charging_protection",
            "max_power_limit",
            "max_power",
        ):
            value = getattr(payload, name)
            if value is not None:
                updates.append({**PROPERTIES[name], "value": value})
        if not updates:
            return
        result = AupuController._miio_send(
            PLUG_IP,
            str(config["token"]),
            "set_properties",
            updates,
        )
        if not isinstance(result, list) or any(
            not isinstance(item, dict) or item.get("code", 0) != 0
            for item in result
        ):
            raise AupuError("智能插座拒绝了本次设置")

    async def command(self, payload: PlugCommand) -> dict[str, Any]:
        async with self.lock:
            config = self._load_config()
            if not config.get("token"):
                raise AupuError("请先扫码连接米家以获取智能插座本地令牌")
            await asyncio.to_thread(self._set, config, payload)
            await asyncio.sleep(0.2)
            return await asyncio.to_thread(self._read, config)


plug = PlugController()
