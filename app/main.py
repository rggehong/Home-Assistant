from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from enum import Enum, IntEnum
from ipaddress import IPv4Address
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from greeclimate.device import (
    Device,
    FanSpeed,
    HorizontalSwing,
    Mode,
    Props,
    TemperatureUnits,
    VerticalSwing,
)
from greeclimate.discovery import Discovery


logging.getLogger("greeclimate").setLevel(logging.WARNING)

MODE_NAMES = {
    "auto": Mode.Auto,
    "cool": Mode.Cool,
    "dry": Mode.Dry,
    "fan": Mode.Fan,
    "heat": Mode.Heat,
}
FAN_NAMES = {
    "auto": FanSpeed.Auto,
    "low": FanSpeed.Low,
    "medium_low": FanSpeed.MediumLow,
    "medium": FanSpeed.Medium,
    "medium_high": FanSpeed.MediumHigh,
    "high": FanSpeed.High,
}
VERTICAL_SWING_NAMES = {
    "default": VerticalSwing.Default,
    "full": VerticalSwing.FullSwing,
    "upper": VerticalSwing.FixedUpper,
    "upper_middle": VerticalSwing.FixedUpperMiddle,
    "middle": VerticalSwing.FixedMiddle,
    "lower_middle": VerticalSwing.FixedLowerMiddle,
    "lower": VerticalSwing.FixedLower,
}
HORIZONTAL_SWING_NAMES = {
    "default": HorizontalSwing.Default,
    "full": HorizontalSwing.FullSwing,
    "left": HorizontalSwing.Left,
    "left_center": HorizontalSwing.LeftCenter,
    "center": HorizontalSwing.Center,
    "right_center": HorizontalSwing.RightCenter,
    "right": HorizontalSwing.Right,
}


class ExtraProps(str, Enum):
    LOWER_OUTLET = "UDFanPort"


ROOMS = {
    "192.168.0.124": {
        "room": "客厅",
        "vertical_swing": ["full", "upper", "upper_middle", "middle", "lower_middle", "lower"],
        "horizontal_swing": [],
        "lower_outlet": True,
    },
    "192.168.0.131": {
        "room": "主卧",
        "vertical_swing": ["full", "upper", "upper_middle", "middle", "lower_middle", "lower"],
        "horizontal_swing": ["full", "left", "left_center", "center", "right_center", "right"],
        "lower_outlet": False,
    },
    "192.168.0.134": {
        "room": "次卧",
        "vertical_swing": ["full", "upper", "upper_middle", "middle", "lower_middle", "lower"],
        "horizontal_swing": ["full", "left", "left_center", "center", "right_center", "right"],
        "lower_outlet": False,
    },
}


class Command(BaseModel):
    power: bool | None = None
    mode: str | None = None
    target_temperature: float | None = Field(
        default=None,
        ge=16,
        le=30,
        multiple_of=0.5,
    )
    fan_speed: str | None = None
    vertical_swing: str | None = None
    horizontal_swing: str | None = None
    light: bool | None = None
    quiet: bool | None = None
    turbo: bool | None = None
    xfan: bool | None = None
    sleep: bool | None = None
    lower_outlet: bool | None = None


class ScheduleCreate(BaseModel):
    device_id: str
    action: Literal["on", "off"]
    run_at: datetime
    label: str | None = Field(default=None, max_length=60)


def _enum_name(enum_type: type[IntEnum], value: Any) -> str | None:
    if value is None:
        return None
    try:
        return enum_type(value).name
    except (ValueError, TypeError):
        return str(value)


def _device_id(device: Device) -> str:
    info = device.device_info
    raw = getattr(info, "mac", None) or getattr(info, "name", None) or info.ip
    return str(raw).lower().replace(":", "").replace("-", "")


def _serialize(device: Device) -> dict[str, Any]:
    info = device.device_info
    room = ROOMS.get(info.ip, {})
    target_temperature = device.target_temperature
    if (
        device.temperature_units == TemperatureUnits.C
        and target_temperature is not None
        and device.raw_properties.get(Props.TEMP_BIT.value) == 1
    ):
        target_temperature = float(target_temperature) + 0.5
    return {
        "id": _device_id(device),
        "ip": info.ip,
        "port": info.port,
        "mac": getattr(info, "mac", None),
        "name": getattr(info, "name", None),
        "brand": getattr(info, "brand", None),
        "model": getattr(info, "model", None),
        "firmware": getattr(device, "hid", None),
        "protocol_version": getattr(device, "version", None),
        "room": room.get("room", "格力空调"),
        "capabilities": {
            "vertical_swing": room.get("vertical_swing", list(VERTICAL_SWING_NAMES)),
            "horizontal_swing": room.get("horizontal_swing", list(HORIZONTAL_SWING_NAMES)),
            "lower_outlet": room.get("lower_outlet", False),
            "sleep": True,
            "schedules": True,
        },
        "online": device.has_valid_state,
        "power": device.power,
        "mode": _enum_name(Mode, device.mode),
        "target_temperature": target_temperature,
        "current_temperature": device.current_temperature,
        "fan_speed": _enum_name(FanSpeed, device.fan_speed),
        "vertical_swing": _enum_name(VerticalSwing, device.vertical_swing),
        "horizontal_swing": _enum_name(HorizontalSwing, device.horizontal_swing),
        "light": device.light,
        "quiet": bool(device.quiet) if device.quiet is not None else None,
        "turbo": device.turbo,
        "xfan": device.xfan,
        "sleep": device.sleep,
        "lower_outlet": (
            bool(device.raw_properties.get(ExtraProps.LOWER_OUTLET.value))
            if room.get("lower_outlet", False)
            and device.raw_properties.get(ExtraProps.LOWER_OUTLET.value) is not None
            else None
        ),
    }


async def _update_device_state(device: Device) -> None:
    await device.update_state()
    if ROOMS.get(device.device_info.ip, {}).get("lower_outlet", False):
        await device.send(
            device.create_status_message(
                device.device_info,
                ExtraProps.LOWER_OUTLET.value,
            )
        )
        # `send` schedules the decoded UDP reply; allow its state callback to
        # merge this model-specific property before serializing the response.
        await asyncio.sleep(0.15)


class Registry:
    def __init__(self) -> None:
        target_ips = os.getenv("GREE_TARGET_IPS", "")
        self.target_ips = {item.strip() for item in target_ips.split(",") if item.strip()}
        self.discovery_seconds = int(os.getenv("GREE_DISCOVERY_SECONDS", "5"))
        self.devices: dict[str, Device] = {}
        self.lock = asyncio.Lock()

    async def discover(self) -> list[dict[str, Any]]:
        async with self.lock:
            discovery = Discovery()
            if self.target_ips:
                # Directed discovery also works on Wi-Fi networks that suppress
                # client-to-client broadcast traffic.
                targets = [IPv4Address(ip) for ip in sorted(self.target_ips)]
                infos = await discovery.scan(
                    wait_for=self.discovery_seconds,
                    bcast_ifaces=targets,
                )
            else:
                infos = await discovery.scan(wait_for=self.discovery_seconds)
            for info in infos:
                if self.target_ips and info.ip not in self.target_ips:
                    continue
                device = Device(info, timeout=10, bind_timeout=5)
                try:
                    await device.bind()
                    await _update_device_state(device)
                except Exception:
                    # Keep the discovered endpoint visible even when a model needs
                    # a stored key or uses an unsupported cipher generation.
                    pass
                self.devices[_device_id(device)] = device
            return [_serialize(device) for device in self.devices.values()]

    async def refresh(self, device_id: str | None = None) -> list[dict[str, Any]]:
        async with self.lock:
            selected = self.devices.values()
            if device_id:
                device = self.devices.get(device_id)
                if not device:
                    raise KeyError(device_id)
                selected = [device]
            result = []
            for device in selected:
                try:
                    await _update_device_state(device)
                except Exception as exc:
                    result.append({**_serialize(device), "error": str(exc)})
                else:
                    result.append(_serialize(device))
            return result

    async def command(self, device_id: str, command: Command) -> dict[str, Any]:
        async with self.lock:
            device = self.devices.get(device_id)
            if not device:
                raise KeyError(device_id)
            await _update_device_state(device)
            if command.power is not None:
                device.power = command.power
            if command.mode is not None:
                device.mode = _lookup(MODE_NAMES, command.mode, "mode")
            if command.target_temperature is not None:
                base_temperature = int(command.target_temperature)
                half_degree = int(command.target_temperature % 1 == 0.5)
                device.set_property(Props.TEMP_SET, base_temperature)
                device.set_property(Props.TEMP_BIT, half_degree)
                device.set_property(Props.TEMP_UNIT, TemperatureUnits.C)
            if command.fan_speed is not None:
                device.fan_speed = _lookup(FAN_NAMES, command.fan_speed, "fan_speed")
            if command.vertical_swing is not None:
                allowed = ROOMS.get(device.device_info.ip, {}).get(
                    "vertical_swing", list(VERTICAL_SWING_NAMES)
                )
                if command.vertical_swing not in allowed:
                    raise HTTPException(
                        status_code=422,
                        detail="vertical_swing is not supported by this room",
                    )
                device.vertical_swing = _lookup(
                    VERTICAL_SWING_NAMES, command.vertical_swing, "vertical_swing"
                )
            if command.horizontal_swing is not None:
                allowed = ROOMS.get(device.device_info.ip, {}).get(
                    "horizontal_swing", list(HORIZONTAL_SWING_NAMES)
                )
                if command.horizontal_swing not in allowed:
                    raise HTTPException(
                        status_code=422,
                        detail="horizontal_swing is not supported by this room",
                    )
                device.horizontal_swing = _lookup(
                    HORIZONTAL_SWING_NAMES, command.horizontal_swing, "horizontal_swing"
                )
            for attr in ("light", "quiet", "turbo", "xfan", "sleep"):
                value = getattr(command, attr)
                if value is not None:
                    setattr(device, attr, value)
            if command.lower_outlet is not None:
                if not ROOMS.get(device.device_info.ip, {}).get("lower_outlet", False):
                    raise HTTPException(
                        status_code=422,
                        detail="lower_outlet is not supported by this room",
                    )
                device.set_property(
                    ExtraProps.LOWER_OUTLET,
                    int(command.lower_outlet),
                )
            await device.push_state_update()
            await _update_device_state(device)
            return _serialize(device)


def _lookup(values: dict[str, IntEnum], value: str, field: str) -> IntEnum:
    try:
        return values[value.lower()]
    except KeyError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"invalid {field}; allowed: {', '.join(values)}",
        ) from exc


registry = Registry()


class ScheduleStore:
    def __init__(self) -> None:
        data_dir = Path(
            os.getenv(
                "GREE_DATA_DIR",
                str(Path(__file__).resolve().parent.parent / "data"),
            )
        )
        self.path = data_dir / "schedules.json"
        self.items: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            self.items = {item["id"]: item for item in raw if "id" in item}
        except (FileNotFoundError, json.JSONDecodeError, TypeError):
            self.items = {}

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(list(self.items.values()), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temporary.replace(self.path)

    def add(self, payload: ScheduleCreate) -> dict[str, Any]:
        run_at = payload.run_at
        if run_at.tzinfo is None:
            run_at = run_at.replace(tzinfo=timezone.utc)
        run_at = run_at.astimezone(timezone.utc)
        if run_at <= datetime.now(timezone.utc):
            raise HTTPException(status_code=422, detail="run_at must be in the future")
        item = {
            "id": uuid4().hex,
            "device_id": payload.device_id,
            "action": payload.action,
            "run_at": run_at.isoformat(),
            "label": payload.label,
            "status": "pending",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        self.items[item["id"]] = item
        self.save()
        return item

    async def run(self) -> None:
        while True:
            now = datetime.now(timezone.utc)
            changed = False
            for item in list(self.items.values()):
                if item.get("status") != "pending":
                    continue
                if datetime.fromisoformat(item["run_at"]) > now:
                    continue
                try:
                    await registry.command(
                        item["device_id"],
                        Command(power=item["action"] == "on"),
                    )
                except Exception as exc:
                    item["status"] = "failed"
                    item["error"] = str(exc)
                else:
                    item["status"] = "executed"
                item["executed_at"] = datetime.now(timezone.utc).isoformat()
                changed = True
            if changed:
                self.save()
            await asyncio.sleep(10)


schedules = ScheduleStore()


def require_token(
    authorization: str | None = Header(default=None),
    x_api_token: str | None = Header(default=None),
) -> None:
    expected = os.getenv("GREE_API_TOKEN")
    if not expected:
        raise HTTPException(status_code=503, detail="GREE_API_TOKEN is not configured")
    supplied = x_api_token
    if authorization and authorization.lower().startswith("bearer "):
        supplied = authorization[7:]
    if supplied != expected:
        raise HTTPException(status_code=401, detail="invalid API token")


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        await registry.discover()
    except Exception:
        # Service remains healthy so discovery can be retried explicitly.
        pass
    schedule_task = asyncio.create_task(schedules.run())
    try:
        yield
    finally:
        schedule_task.cancel()
        try:
            await schedule_task
        except asyncio.CancelledError:
            pass


app = FastAPI(
    title="Gree AC LAN Bridge",
    version="1.0.0",
    description="Local-only HTTP bridge for Gree Wi-Fi air conditioners.",
    lifespan=lifespan,
)
STATIC_DIR = Path(__file__).with_name("static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
async def dashboard() -> FileResponse:
    return FileResponse(
        STATIC_DIR / "h5.html",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


@app.get("/h5", include_in_schema=False)
async def h5_dashboard() -> FileResponse:
    return FileResponse(
        STATIC_DIR / "h5.html",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


@app.get("/desktop", include_in_schema=False)
async def desktop_dashboard() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "device_count": len(registry.devices)}


@app.get("/api/devices", dependencies=[Depends(require_token)])
async def devices(refresh: bool = True) -> list[dict[str, Any]]:
    if not registry.devices:
        return await registry.discover()
    if refresh:
        return await registry.refresh()
    return [_serialize(device) for device in registry.devices.values()]


@app.post("/api/discover", dependencies=[Depends(require_token)])
async def discover() -> list[dict[str, Any]]:
    return await registry.discover()


@app.get("/api/devices/{device_id}", dependencies=[Depends(require_token)])
async def device(device_id: str) -> dict[str, Any]:
    try:
        return (await registry.refresh(device_id))[0]
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="device not found") from exc


@app.post("/api/devices/{device_id}/command", dependencies=[Depends(require_token)])
async def command(device_id: str, payload: Command) -> dict[str, Any]:
    try:
        return await registry.command(device_id, payload)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="device not found") from exc


@app.get("/api/schedules", dependencies=[Depends(require_token)])
async def list_schedules() -> list[dict[str, Any]]:
    return sorted(
        schedules.items.values(),
        key=lambda item: item.get("run_at", ""),
        reverse=True,
    )


@app.post("/api/schedules", dependencies=[Depends(require_token)])
async def create_schedule(payload: ScheduleCreate) -> dict[str, Any]:
    if payload.device_id not in registry.devices:
        raise HTTPException(status_code=404, detail="device not found")
    return schedules.add(payload)


@app.delete("/api/schedules/{schedule_id}", dependencies=[Depends(require_token)])
async def delete_schedule(schedule_id: str) -> dict[str, bool]:
    item = schedules.items.get(schedule_id)
    if not item:
        raise HTTPException(status_code=404, detail="schedule not found")
    if item.get("status") != "pending":
        raise HTTPException(status_code=409, detail="only pending schedules can be deleted")
    del schedules.items[schedule_id]
    schedules.save()
    return {"deleted": True}
