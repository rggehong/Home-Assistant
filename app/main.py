from __future__ import annotations

import asyncio
import csv
import html
import hashlib
import hmac
import io
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from enum import Enum, IntEnum
from ipaddress import IPv4Address
from pathlib import Path
from typing import Any, Literal
from urllib.parse import parse_qs, parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import uuid4

from fastapi import Cookie, Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    RedirectResponse,
    StreamingResponse,
)
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
from app.aupu import AupuCommand, AupuError, AupuQrStartRequest, aupu
from app.plug import PlugCommand, plug
from app.opple import OppleCommand, OppleError, opple_light
from app.purifier import (
    PurifierError,
    PurifierLoginRequest,
    PurifierSmsRequest,
    purifier,
)
from app.sony import SonyError, TVCommand, sony_tv
from app.water_heater import water_heater
from app.dreame import (
    DreameCommand,
    DreameError,
    DreameLoginRequest,
    DreameSettingRequest,
    dreame,
)
from app.tmall import tmall_status
from app.ais_light import AisLightCommand, AisLightError, ais_light
from app.xiaomi_scale import xiaomi_scale
from app.ezviz import ezviz
from app.hotata import (
    HotataCommand,
    HotataError,
    HotataLoginRequest,
    HotataSettings,
    hotata,
)
from app.aligenie import aligenie_oauth, error_response, response_header
from app.aligenie_personal import (
    PersonalCommand,
    parse_personal_command,
    personal_response,
)


logging.getLogger().setLevel(logging.INFO)
logging.getLogger("greeclimate").setLevel(logging.WARNING)
scheduler_logger = logging.getLogger("gree_home.scheduler")

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
    ANTI_DIRECT = "AntiDirectBlow"


ROOMS = {
    "192.168.0.124": {
        "room": "客厅",
        "model_name": "KFR-72LW",
        "model_id": "110007e000019",
        "vertical_swing": ["full", "upper", "upper_middle", "middle", "lower_middle", "lower"],
        "horizontal_swing": [],
        "lower_outlet": True,
        "anti_direct": False,
        "turbo": True,
        "health": True,
        "auxiliary_heat": False,
    },
    "192.168.0.131": {
        "room": "主卧",
        "model_name": "KFR-35GW",
        "model_id": "10014",
        "vertical_swing": ["full", "upper", "upper_middle", "middle", "lower_middle", "lower"],
        "horizontal_swing": ["full", "left", "left_center", "center", "right_center", "right"],
        "lower_outlet": False,
        "anti_direct": True,
        "turbo": True,
        "health": True,
        "auxiliary_heat": True,
    },
    "192.168.0.134": {
        "room": "次卧",
        "model_name": "KFR-35GW",
        "model_id": "10014",
        "vertical_swing": ["full", "upper", "upper_middle", "middle", "lower_middle", "lower"],
        "horizontal_swing": ["full", "left", "left_center", "center", "right_center", "right"],
        "lower_outlet": False,
        "anti_direct": True,
        "turbo": True,
        "health": True,
        "auxiliary_heat": True,
    },
}
ROOM_ORDER = {"客厅": 0, "主卧": 1, "次卧": 2}
SONY_TV_DEVICE_ID = "sony-living-tv"
MIJIA_PLUG_DEVICE_ID = "mijia-plug-3"
AUPU_DEVICE_ID = "aupu-q360a-pro"


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
    anti_direct: bool | None = None
    health: bool | None = None
    auxiliary_heat: bool | None = None


class ScheduleCreate(BaseModel):
    device_id: str
    action: Literal["on", "off"]
    run_at: datetime
    label: str | None = Field(default=None, max_length=60)
    command: dict[str, Any] | None = None


class LoginRequest(BaseModel):
    password: str = Field(min_length=1, max_length=256)


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
        "model_name": room.get("model_name"),
        "model_id": room.get("model_id"),
        "firmware": getattr(device, "hid", None),
        "protocol_version": getattr(device, "version", None),
        "room": room.get("room", "格力空调"),
        "capabilities": {
            "vertical_swing": room.get("vertical_swing", list(VERTICAL_SWING_NAMES)),
            "horizontal_swing": room.get("horizontal_swing", list(HORIZONTAL_SWING_NAMES)),
            "lower_outlet": (
                room.get("lower_outlet", False)
                and device.raw_properties.get(ExtraProps.LOWER_OUTLET.value) is not None
            ),
            "anti_direct": room.get("anti_direct", False),
            "turbo": room.get("turbo", False) and device.turbo is not None,
            "health": room.get("health", False) and device.anion is not None,
            "auxiliary_heat": (
                room.get("auxiliary_heat", False)
                and device.steady_heat is not None
            ),
            "sleep": device.sleep is not None,
            "light": device.light is not None,
            "quiet": device.quiet is not None,
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
        "health": device.anion,
        "auxiliary_heat": device.steady_heat,
        "anti_direct": (
            bool(device.raw_properties.get(ExtraProps.ANTI_DIRECT.value, 0))
            if room.get("anti_direct", False)
            else None
        ),
        "xfan": device.xfan,
        "sleep": device.sleep,
        "lower_outlet": (
            bool(device.raw_properties.get(ExtraProps.LOWER_OUTLET.value))
            if room.get("lower_outlet", False)
            and device.raw_properties.get(ExtraProps.LOWER_OUTLET.value) is not None
            else None
        ),
    }


def _sort_devices(devices: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        devices,
        key=lambda item: (
            ROOM_ORDER.get(item.get("room", ""), len(ROOM_ORDER)),
            item.get("ip", ""),
        ),
    )


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

    def missing_target_ips(self) -> set[str]:
        discovered_ips = {device.device_info.ip for device in self.devices.values()}
        return self.target_ips - discovered_ips

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
            return _sort_devices(
                [_serialize(device) for device in self.devices.values()]
            )

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
            return _sort_devices(result)

    async def command(self, device_id: str, command: Command) -> dict[str, Any]:
        async with self.lock:
            device = self.devices.get(device_id)
            if not device:
                raise KeyError(device_id)
            await _update_device_state(device)
            room = ROOMS.get(device.device_info.ip, {})
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
                # Anti-direct blow is an independent model-specific switch. It
                # must be cleared when the user explicitly selects a vertical
                # swing mode, otherwise supported bedroom units can keep their
                # anti-direct deflector behavior while reporting SwUpDn=1.
                if room.get("anti_direct", False) and command.anti_direct is None:
                    device.set_property(ExtraProps.ANTI_DIRECT, 0)
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
                    if attr == "turbo" and not ROOMS.get(
                        device.device_info.ip, {}
                    ).get("turbo", False):
                        raise HTTPException(
                            status_code=422,
                            detail="turbo is not supported by this room",
                        )
                    setattr(device, attr, value)
            if command.health is not None:
                if not room.get("health", False):
                    raise HTTPException(
                        status_code=422,
                        detail="health is not supported by this room",
                    )
                device.anion = command.health
            if command.auxiliary_heat is not None:
                if not room.get("auxiliary_heat", False):
                    raise HTTPException(
                        status_code=422,
                        detail="auxiliary_heat is not supported by this room",
                    )
                device.steady_heat = command.auxiliary_heat
            if command.anti_direct is not None:
                if not room.get("anti_direct", False):
                    raise HTTPException(
                        status_code=422,
                        detail="anti_direct is not supported by this room",
                    )
                device.set_property(
                    ExtraProps.ANTI_DIRECT,
                    int(command.anti_direct),
                )
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
            "device_type": (
                "tv"
                if payload.device_id == SONY_TV_DEVICE_ID
                else "plug"
                if payload.device_id == MIJIA_PLUG_DEVICE_ID
                else "aupu"
                if payload.device_id == AUPU_DEVICE_ID
                else "ac"
            ),
            "action": payload.action,
            "run_at": run_at.isoformat(),
            "label": payload.label,
            "status": "pending",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        if payload.command:
            item["command"] = payload.command
        self.items[item["id"]] = item
        self.save()
        return item

    def cancel_aupu_timers(self) -> list[str]:
        cancelled_ids = [
            item_id
            for item_id, item in self.items.items()
            if item.get("status") == "pending"
            and item.get("device_id") == AUPU_DEVICE_ID
        ]
        for item_id in cancelled_ids:
            self.items.pop(item_id, None)
        if cancelled_ids:
            self.save()
        return cancelled_ids

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
                    if item["device_id"] == SONY_TV_DEVICE_ID:
                        await sony_tv.set_power_verified(item["action"] == "on")
                    elif item["device_id"] == MIJIA_PLUG_DEVICE_ID:
                        await plug.command(PlugCommand(on=item["action"] == "on"))
                    elif item["device_id"] == AUPU_DEVICE_ID:
                        await aupu.command(AupuCommand(**(item.get("command") or {})))
                    else:
                        await registry.command(
                            item["device_id"],
                            Command(power=item["action"] == "on"),
                        )
                except Exception as exc:
                    item["status"] = "failed"
                    item["error"] = str(exc)
                    scheduler_logger.error(
                        "schedule failed id=%s device=%s action=%s error=%s",
                        item.get("id"),
                        item.get("device_id"),
                        item.get("action"),
                        exc,
                    )
                else:
                    item["status"] = "executed"
                    scheduler_logger.info(
                        "schedule executed id=%s device=%s action=%s",
                        item.get("id"),
                        item.get("device_id"),
                        item.get("action"),
                    )
                item["executed_at"] = datetime.now(timezone.utc).isoformat()
                changed = True
            if changed:
                self.save()
            await asyncio.sleep(10)


schedules = ScheduleStore()

SESSION_COOKIE = "gree_home_session"
SESSION_MAX_AGE = 30 * 24 * 60 * 60
LOGIN_WINDOW = 15 * 60
LOGIN_MAX_FAILURES = 8
login_failures: dict[str, list[float]] = {}


def _api_token() -> str:
    value = os.getenv("GREE_API_TOKEN")
    if not value:
        raise HTTPException(status_code=503, detail="GREE_API_TOKEN is not configured")
    return value


def _login_password() -> str:
    return os.getenv("GREE_WEB_PASSWORD") or _api_token()


def _session_secret() -> str:
    return os.getenv("GREE_SESSION_SECRET") or _api_token()


def _session_value(expires_at: int) -> str:
    payload = f"v1:{expires_at}"
    signature = hmac.new(
        _session_secret().encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{payload}:{signature}"


def _valid_session(value: str | None) -> bool:
    if not value:
        return False
    try:
        version, expires_text, supplied_signature = value.split(":", 2)
        expires_at = int(expires_text)
    except (TypeError, ValueError):
        return False
    if version != "v1" or expires_at < int(time.time()):
        return False
    expected_signature = _session_value(expires_at).rsplit(":", 1)[1]
    return hmac.compare_digest(supplied_signature, expected_signature)


def _secure_cookie(request: Request) -> bool:
    forwarded_proto = request.headers.get("x-forwarded-proto", "")
    return request.url.scheme == "https" or forwarded_proto.lower() == "https"


def _client_address(request: Request) -> str:
    direct = request.client.host if request.client else "unknown"
    if direct in {"127.0.0.1", "::1"}:
        forwarded = request.headers.get("x-forwarded-for", "").split(",", 1)[0].strip()
        if forwarded:
            return forwarded
    return direct


def _same_secret(left: str, right: str) -> bool:
    return hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))


def require_token(
    request: Request,
    authorization: str | None = Header(default=None),
    x_api_token: str | None = Header(default=None),
    gree_home_session: str | None = Cookie(default=None),
) -> None:
    expected = _api_token()
    supplied = x_api_token
    if authorization and authorization.lower().startswith("bearer "):
        supplied = authorization[7:]
    if supplied and _same_secret(supplied, expected):
        return
    if _valid_session(gree_home_session):
        return
    raise HTTPException(status_code=401, detail="authentication required")


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        await registry.discover()
    except Exception:
        # Service remains healthy so discovery can be retried explicitly.
        pass
    schedule_task = asyncio.create_task(schedules.run())
    discovery_task = asyncio.create_task(maintain_discovery())
    xiaomi_scale_task = asyncio.create_task(xiaomi_scale.run_collector())
    await ezviz.start()
    try:
        yield
    finally:
        await ezviz.stop()
        schedule_task.cancel()
        discovery_task.cancel()
        xiaomi_scale_task.cancel()
        await asyncio.gather(schedule_task, discovery_task, xiaomi_scale_task, return_exceptions=True)


async def maintain_discovery() -> None:
    while True:
        await asyncio.sleep(max(30, registry.discovery_seconds * 6))
        if not registry.missing_target_ips():
            continue
        try:
            await registry.discover()
        except Exception:
            # A later cycle or an authenticated page refresh will retry.
            pass


app = FastAPI(
    title="Gree AC LAN Bridge",
    version="1.0.0",
    description="Local-only HTTP bridge for Gree Wi-Fi air conditioners.",
    lifespan=lifespan,
)
STATIC_DIR = Path(__file__).with_name("static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> FileResponse:
    return FileResponse(
        STATIC_DIR / "favicon.ico",
        media_type="image/x-icon",
        headers={"Cache-Control": "public, max-age=604800"},
    )


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
    return FileResponse(
        STATIC_DIR / "index.html",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "device_count": len(registry.devices)}


@app.post("/api/auth/login")
async def login(payload: LoginRequest, request: Request, response: Response) -> dict[str, Any]:
    address = _client_address(request)
    now = time.monotonic()
    attempts = [
        attempted_at
        for attempted_at in login_failures.get(address, [])
        if now - attempted_at < LOGIN_WINDOW
    ]
    if len(attempts) >= LOGIN_MAX_FAILURES:
        raise HTTPException(
            status_code=429,
            detail="尝试次数过多，请稍后再试",
            headers={"Retry-After": str(LOGIN_WINDOW)},
        )

    if not _same_secret(payload.password, _login_password()):
        attempts.append(now)
        login_failures[address] = attempts
        await asyncio.sleep(0.35)
        raise HTTPException(status_code=401, detail="家庭访问密码错误")

    login_failures.pop(address, None)
    expires_at = int(time.time()) + SESSION_MAX_AGE
    response.set_cookie(
        key=SESSION_COOKIE,
        value=_session_value(expires_at),
        max_age=SESSION_MAX_AGE,
        path="/",
        secure=_secure_cookie(request),
        httponly=True,
        samesite="strict",
    )
    response.headers["Cache-Control"] = "no-store"
    return {
        "authenticated": True,
        "expires_at": datetime.fromtimestamp(expires_at, timezone.utc).isoformat(),
    }


@app.get("/api/auth/status")
async def auth_status(
    gree_home_session: str | None = Cookie(default=None),
) -> dict[str, bool]:
    return {"authenticated": _valid_session(gree_home_session)}


@app.post("/api/auth/logout")
async def logout(request: Request, response: Response) -> dict[str, bool]:
    response.delete_cookie(
        key=SESSION_COOKIE,
        path="/",
        secure=_secure_cookie(request),
        httponly=True,
        samesite="strict",
    )
    response.headers["Cache-Control"] = "no-store"
    return {"authenticated": False}


@app.get("/api/devices", dependencies=[Depends(require_token)])
async def devices(refresh: bool = True) -> list[dict[str, Any]]:
    if not registry.devices:
        return await registry.discover()
    if refresh:
        refreshed = await registry.refresh()
        if registry.missing_target_ips():
            try:
                return await registry.discover()
            except Exception:
                return refreshed
        return refreshed
    return _sort_devices(
        [_serialize(device) for device in registry.devices.values()]
    )


@app.get("/api/tv", dependencies=[Depends(require_token)])
async def tv_status() -> dict[str, Any]:
    return await sony_tv.status()


@app.get("/api/aupu", dependencies=[Depends(require_token)])
async def aupu_status() -> dict[str, Any]:
    return await aupu.status()


@app.get("/api/hotata", dependencies=[Depends(require_token)])
async def hotata_status() -> dict[str, Any]:
    return await hotata.status()


@app.post("/api/hotata/login", dependencies=[Depends(require_token)])
async def hotata_login(payload: HotataLoginRequest) -> dict[str, Any]:
    try:
        return await hotata.login(payload)
    except HotataError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/hotata/command", dependencies=[Depends(require_token)])
async def hotata_command(payload: HotataCommand) -> dict[str, Any]:
    try:
        return await hotata.command(payload)
    except HotataError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.put("/api/hotata/settings", dependencies=[Depends(require_token)])
async def hotata_settings(payload: HotataSettings) -> dict[str, Any]:
    try:
        return await hotata.update_settings(payload)
    except HotataError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/aupu/qr/start", dependencies=[Depends(require_token)])
async def aupu_qr_start(payload: AupuQrStartRequest) -> dict[str, Any]:
    try:
        return await aupu.start_qr(payload)
    except AupuError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/aupu/qr/{session_id}", dependencies=[Depends(require_token)])
async def aupu_qr_status(session_id: str) -> dict[str, Any]:
    try:
        return await aupu.qr_status(session_id)
    except AupuError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/aupu/command", dependencies=[Depends(require_token)])
async def aupu_command(payload: AupuCommand) -> dict[str, Any]:
    try:
        result = await aupu.command(payload)
        if payload.mode is not None:
            schedules.cancel_aupu_timers()
        return result
    except AupuError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/plug", dependencies=[Depends(require_token)])
async def plug_status() -> dict[str, Any]:
    return await plug.status()


@app.get("/api/opple", dependencies=[Depends(require_token)])
async def opple_status() -> dict[str, Any]:
    return await opple_light.status()


@app.post("/api/opple/command", dependencies=[Depends(require_token)])
async def opple_command(payload: OppleCommand) -> dict[str, Any]:
    try:
        return await opple_light.command(payload)
    except OppleError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/plug/command", dependencies=[Depends(require_token)])
async def plug_command(payload: PlugCommand) -> dict[str, Any]:
    try:
        return await plug.command(payload)
    except AupuError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/purifier", dependencies=[Depends(require_token)])
async def purifier_status() -> dict[str, Any]:
    return await purifier.status()


@app.get("/api/water-heater", dependencies=[Depends(require_token)])
async def water_heater_status() -> dict[str, Any]:
    return await water_heater.status()


@app.get("/api/tmall", dependencies=[Depends(require_token)])
async def tmall_devices_status() -> dict[str, Any]:
    result = await tmall_status()
    result["voice_bridge"] = aligenie_oauth.setup()
    return result


@app.get("/api/ais-light", dependencies=[Depends(require_token)])
async def ais_light_status() -> dict[str, Any]:
    return await ais_light.status()


@app.post("/api/ais-light/command", dependencies=[Depends(require_token)])
async def ais_light_command(payload: AisLightCommand) -> dict[str, Any]:
    try:
        return await ais_light.command(payload)
    except AisLightError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/ais-light/bind", dependencies=[Depends(require_token)])
async def ais_light_bind() -> dict[str, Any]:
    try:
        return await ais_light.bind()
    except AisLightError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/xiaomi-scale", dependencies=[Depends(require_token)])
async def xiaomi_scale_status(scan_seconds: int = 10) -> dict[str, Any]:
    return await xiaomi_scale.status(scan_seconds=scan_seconds)


@app.get("/api/xiaomi-scale/history", dependencies=[Depends(require_token)])
async def xiaomi_scale_history(limit: int = 50) -> list[dict[str, Any]]:
    return xiaomi_scale.history(limit)


@app.get("/api/xiaomi-scale/summary", dependencies=[Depends(require_token)])
async def xiaomi_scale_summary(days: int = 90) -> dict[str, Any]:
    return xiaomi_scale.summary(days)


@app.get("/api/xiaomi-scale/preferences", dependencies=[Depends(require_token)])
async def xiaomi_scale_preferences() -> dict[str, Any]:
    return xiaomi_scale.preferences()


@app.put("/api/xiaomi-scale/preferences", dependencies=[Depends(require_token)])
async def update_xiaomi_scale_preferences(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return xiaomi_scale.update_preferences(payload)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/xiaomi-scale/export", dependencies=[Depends(require_token)])
async def xiaomi_scale_export(format: str = "csv", days: int = 3650) -> Response:
    rows = xiaomi_scale.export_rows(days)
    if format.lower() == "json":
        return JSONResponse(rows, headers={"Content-Disposition": "attachment; filename=xiaomi-scale-history.json"})
    if format.lower() != "csv":
        raise HTTPException(status_code=422, detail="format must be csv or json")
    output = io.StringIO()
    writer = csv.DictWriter(
        output,
        fieldnames=["measured_at", "recorded_at", "weight", "unit", "weight_kg", "rssi", "mac", "raw"],
        extrasaction="ignore",
    )
    writer.writeheader()
    writer.writerows(rows)
    return Response(
        content="\ufeff" + output.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=xiaomi-scale-history.csv"},
    )


@app.get("/api/ezviz", dependencies=[Depends(require_token)])
async def ezviz_status() -> dict[str, Any]:
    return await ezviz.status()


@app.get("/api/ezviz/{camera_id}/snapshot", dependencies=[Depends(require_token)])
async def ezviz_snapshot(camera_id: str) -> Response:
    try:
        image = await ezviz.snapshot(camera_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="camera not found") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return Response(
        content=image,
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store, max-age=0"},
    )


@app.get(
    "/api/ezviz/{camera_id}/live.mjpeg",
    dependencies=[Depends(require_token)],
)
async def ezviz_live(camera_id: str) -> StreamingResponse:
    try:
        ezviz._get_camera(camera_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="camera not found") from exc
    return StreamingResponse(
        ezviz.mjpeg_stream(camera_id),
        media_type="multipart/x-mixed-replace; boundary=camera",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/aligenie/setup", dependencies=[Depends(require_token)])
async def aligenie_setup() -> dict[str, Any]:
    return aligenie_oauth.setup(include_secret=True)


def _aligenie_authorize_page(
    client_id: str,
    redirect_uri: str,
    state: str,
    error: str = "",
) -> str:
    values = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "state": state,
    }
    hidden = "".join(
        f'<input type="hidden" name="{name}" value="{html.escape(value, quote=True)}">'
        for name, value in values.items()
    )
    error_html = (
        f'<p class="error">{html.escape(error)}</p>'
        if error
        else ""
    )
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权天猫精灵</title>
<style>
body{{margin:0;background:#edf5ef;color:#173226;font-family:system-ui,sans-serif}}
main{{max-width:420px;margin:12vh auto;padding:28px;border-radius:28px;background:white;
box-shadow:0 18px 60px #1b4c3020}}h1{{margin:0 0 8px}}p{{color:#66776e;line-height:1.6}}
input,button{{box-sizing:border-box;width:100%;min-height:48px;margin-top:12px;
border-radius:14px}}input{{padding:0 14px;border:1px solid #d6e3da}}
button{{border:0;background:#2b7651;color:white;font-weight:700}}.error{{color:#b83b32}}
</style></head><body><main><small>ALIGENIE · 智能家居</small>
<h1>授权天猫精灵</h1>
<p>允许天猫精灵语音控制本家庭系统中的空调、智能插座和欧普照明。</p>
{error_html}<form method="post">{hidden}
<input type="password" name="password" autocomplete="current-password"
placeholder="家庭访问密码" required>
<button type="submit">确认授权</button></form></main></body></html>"""


@app.get("/aligenie/oauth/authorize", response_class=HTMLResponse)
async def aligenie_authorize(
    client_id: str = "",
    redirect_uri: str = "",
    response_type: str = "",
    state: str = "",
) -> HTMLResponse:
    if (
        response_type != "code"
        or not aligenie_oauth.valid_client(client_id)
        or not aligenie_oauth.valid_redirect_uri(redirect_uri)
    ):
        return HTMLResponse("无效的天猫精灵授权请求", status_code=400)
    return HTMLResponse(_aligenie_authorize_page(client_id, redirect_uri, state))


@app.post("/aligenie/oauth/authorize")
async def aligenie_authorize_submit(request: Request) -> Response:
    form = parse_qs((await request.body()).decode("utf-8", "replace"))
    client_id = str(form.get("client_id", [""])[0])
    redirect_uri = str(form.get("redirect_uri", [""])[0])
    state = str(form.get("state", [""])[0])
    password = str(form.get("password", [""])[0])
    if (
        not aligenie_oauth.valid_client(client_id)
        or not aligenie_oauth.valid_redirect_uri(redirect_uri)
    ):
        return HTMLResponse("无效的天猫精灵授权请求", status_code=400)
    if not _same_secret(password, _login_password()):
        return HTMLResponse(
            _aligenie_authorize_page(
                client_id,
                redirect_uri,
                state,
                "家庭访问密码错误",
            ),
            status_code=401,
        )
    code = aligenie_oauth.issue_code(client_id, redirect_uri)
    split = urlsplit(redirect_uri)
    query = dict(parse_qsl(split.query, keep_blank_values=True))
    query.update({"code": code, "state": state})
    target = urlunsplit(
        (split.scheme, split.netloc, split.path, urlencode(query), split.fragment)
    )
    return RedirectResponse(target, status_code=303)


@app.post("/aligenie/oauth/token")
async def aligenie_token(request: Request) -> JSONResponse:
    body = await request.body()
    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        try:
            values = json.loads(body)
        except json.JSONDecodeError:
            values = {}
    else:
        values = {
            key: items[0]
            for key, items in parse_qs(body.decode("utf-8", "replace")).items()
        }
    result = aligenie_oauth.exchange(
        grant_type=str(values.get("grant_type") or ""),
        client_id=str(values.get("client_id") or ""),
        client_secret=str(values.get("client_secret") or ""),
        code=str(values.get("code") or ""),
        refresh_token=str(values.get("refresh_token") or ""),
        redirect_uri=str(values.get("redirect_uri") or ""),
    )
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


def _aligenie_property(name: str, value: Any) -> dict[str, str]:
    if isinstance(value, bool):
        value = "on" if value else "off"
    return {"name": name, "value": str(value)}


async def _aligenie_devices() -> list[dict[str, Any]]:
    if not registry.devices:
        air_conditioners = await registry.discover()
    else:
        air_conditioners = await registry.refresh()
    result = [
        {
            "deviceId": f"gree:{device['id']}",
            "deviceName": f"{device['room']}空调",
            "deviceType": "aircondition",
            "zone": device["room"],
            "brand": "格力",
            "model": device.get("model_name") or device.get("model") or "",
            "properties": [
                _aligenie_property("powerstate", bool(device.get("power"))),
                _aligenie_property(
                    "temperature",
                    device.get("target_temperature") or 26,
                ),
            ],
            "actions": [
                "TurnOn",
                "TurnOff",
                "SetTemperature",
                "AdjustUpTemperature",
                "AdjustDownTemperature",
                "SetMode",
                "Query",
                "QueryPowerState",
                "QueryTemperature",
                "QueryMode",
            ],
            "extensions": {},
        }
        for device in air_conditioners
    ]
    plug_state, light_state = await asyncio.gather(plug.status(), opple_light.status())
    if plug_state.get("configured"):
        result.append(
            {
                "deviceId": "plug:mijia-plug-3",
                "deviceName": "智能插座",
                "deviceType": "outlet",
                "zone": "",
                "brand": "米家",
                "model": plug_state.get("model") or "",
                "properties": [
                    _aligenie_property("powerstate", bool(plug_state.get("on")))
                ],
                "actions": ["TurnOn", "TurnOff", "Query", "QueryPowerState"],
                "extensions": {},
            }
        )
    result.append(
        {
            "deviceId": "opple:light-139",
            "deviceName": "欧普照明",
            "deviceType": "light",
            "zone": "",
            "brand": "欧普",
            "model": light_state.get("model") or "",
            "properties": [
                _aligenie_property("powerstate", bool(light_state.get("power"))),
                _aligenie_property("brightness", light_state.get("brightness") or 1),
            ],
            "actions": [
                "TurnOn",
                "TurnOff",
                "SetBrightness",
                "AdjustUpBrightness",
                "AdjustDownBrightness",
                "Query",
                "QueryPowerState",
                "QueryBrightness",
            ],
            "extensions": {},
        }
    )
    return result


async def _aligenie_state(device_id: str) -> tuple[str, dict[str, Any]]:
    if device_id.startswith("gree:"):
        values = await registry.refresh(device_id.removeprefix("gree:"))
        return "gree", values[0]
    if device_id == "plug:mijia-plug-3":
        return "plug", await plug.status()
    if device_id == "opple:light-139":
        return "opple", await opple_light.status()
    raise KeyError(device_id)


def _aligenie_properties(kind: str, state: dict[str, Any]) -> list[dict[str, str]]:
    if kind == "gree":
        return [
            _aligenie_property("powerstate", bool(state.get("power"))),
            _aligenie_property("temperature", state.get("target_temperature") or 26),
            _aligenie_property("mode", str(state.get("mode") or "auto").lower()),
        ]
    if kind == "plug":
        return [_aligenie_property("powerstate", bool(state.get("on")))]
    return [
        _aligenie_property("powerstate", bool(state.get("power"))),
        _aligenie_property("brightness", state.get("brightness") or 1),
    ]


async def _aligenie_control(
    kind: str,
    device_id: str,
    name: str,
    value: Any,
    state: dict[str, Any],
) -> None:
    if name in {"TurnOn", "TurnOff"}:
        enabled = name == "TurnOn"
        if kind == "gree":
            await registry.command(
                device_id.removeprefix("gree:"),
                Command(power=enabled),
            )
        elif kind == "plug":
            await plug.command(PlugCommand(on=enabled))
        else:
            await opple_light.command(OppleCommand(power=enabled))
        return
    if kind == "gree" and name in {
        "SetTemperature",
        "AdjustUpTemperature",
        "AdjustDownTemperature",
    }:
        if name == "SetTemperature":
            temperature = float(value)
        else:
            step = float(value or 1)
            if name == "AdjustDownTemperature":
                step = -step
            temperature = float(state.get("target_temperature") or 26) + step
        temperature = max(16, min(30, round(temperature * 2) / 2))
        await registry.command(
            device_id.removeprefix("gree:"),
            Command(target_temperature=temperature),
        )
        return
    if kind == "gree" and name == "SetMode":
        modes = {
            "auto": "auto",
            "自动": "auto",
            "cool": "cool",
            "制冷": "cool",
            "heat": "heat",
            "制热": "heat",
            "dry": "dry",
            "除湿": "dry",
            "fan": "fan",
            "送风": "fan",
        }
        mode = modes.get(str(value).lower())
        if not mode:
            raise ValueError("unsupported mode")
        await registry.command(
            device_id.removeprefix("gree:"),
            Command(mode=mode),
        )
        return
    if kind == "opple" and name in {
        "SetBrightness",
        "AdjustUpBrightness",
        "AdjustDownBrightness",
    }:
        if name == "SetBrightness":
            if value == "max":
                brightness = 100
            elif value == "min":
                brightness = 4
            else:
                brightness = int(value)
        else:
            step = int(value or 25)
            if name == "AdjustDownBrightness":
                step = -step
            brightness = int(state.get("brightness") or 50) + step
        await opple_light.command(
            OppleCommand(brightness=max(4, min(100, brightness)))
        )
        return
    raise ValueError("unsupported action")


@app.post("/aligenie/gateway")
async def aligenie_gateway(request: Request) -> dict[str, Any]:
    try:
        message = await request.json()
    except Exception:
        message = {}
    header = message.get("header") if isinstance(message, dict) else {}
    payload = message.get("payload") if isinstance(message, dict) else {}
    header = header if isinstance(header, dict) else {}
    payload = payload if isinstance(payload, dict) else {}
    namespace = str(header.get("namespace") or "AliGenie.Iot.Device.Control")
    name = str(header.get("name") or "")
    message_id = str(header.get("messageId") or uuid4())
    device_id = str(payload.get("deviceId") or "")
    if not aligenie_oauth.valid_access_token(str(payload.get("accessToken") or "")):
        return error_response(
            namespace,
            message_id,
            device_id,
            "ACCESS_TOKEN_INVALIDATE",
            "access_token is invalidate",
        )
    if (
        namespace == "AliGenie.Iot.Device.Discovery"
        and name == "DiscoveryDevices"
    ):
        return {
            "header": response_header(
                namespace,
                "DiscoveryDevicesResponse",
                message_id,
            ),
            "payload": {"devices": await _aligenie_devices()},
        }
    try:
        kind, state = await _aligenie_state(device_id)
    except KeyError:
        return error_response(
            namespace,
            message_id,
            device_id,
            "DEVICE_IS_NOT_EXIST",
            "device is not exist",
        )
    if state.get("online") is False:
        return error_response(
            namespace,
            message_id,
            device_id,
            "IOT_DEVICE_OFFLINE",
            "device is offline",
        )
    try:
        if namespace == "AliGenie.Iot.Device.Control":
            await _aligenie_control(
                kind,
                device_id,
                name,
                payload.get("value"),
                state,
            )
            return {
                "header": response_header(namespace, f"{name}Response", message_id),
                "payload": {"deviceId": device_id},
            }
        if namespace == "AliGenie.Iot.Device.Query":
            properties = _aligenie_properties(kind, state)
            property_names = {
                "QueryPowerState": "powerstate",
                "QueryTemperature": "temperature",
                "QueryBrightness": "brightness",
                "QueryMode": "mode",
            }
            selected = property_names.get(name)
            if name != "Query" and selected is None:
                raise ValueError("unsupported query")
            if selected:
                properties = [item for item in properties if item["name"] == selected]
            if name != "Query" and not properties:
                raise ValueError("unsupported query")
            return {
                "properties": properties,
                "header": response_header(namespace, f"{name}Response", message_id),
                "payload": {"deviceId": device_id},
            }
    except (ValueError, TypeError):
        return error_response(
            namespace,
            message_id,
            device_id,
            "DEVICE_NOT_SUPPORT_FUNCTION",
            "device not support",
        )
    except Exception:
        return error_response(
            namespace,
            message_id,
            device_id,
            "SERVICE_ERROR",
            "service error",
        )
    return error_response(
        namespace,
        message_id,
        device_id,
        "INVALIDATE_CONTROL_ORDER",
        "invalidate control order",
    )


def _personal_webhook_token() -> str:
    return os.getenv("ALIGENIE_PERSONAL_TOKEN", "").strip()


def _personal_webhook_url() -> str:
    public_base_url = os.getenv(
        "GREE_PUBLIC_URL",
        "https://home.gezhixin.cn:4430",
    ).rstrip("/")
    return f"{public_base_url}/aligenie/personal/webhook"


async def _personal_air_conditioner(
    command: PersonalCommand,
) -> tuple[dict[str, Any], str]:
    devices = await registry.refresh()
    device = next(
        (item for item in devices if item.get("room") == command.room),
        None,
    )
    if not device:
        raise ValueError(f"没有找到{command.room}空调")
    if command.action == "status":
        power = "开着" if device.get("power") else "关闭"
        temperature = device.get("target_temperature") or 26
        return device, f"{command.room}空调目前{power}，设定温度{temperature}度"
    payload = Command()
    if command.action == "power":
        payload.power = bool(command.value)
    elif command.action == "temperature":
        payload.target_temperature = float(command.value)
    elif command.action == "mode":
        payload.mode = str(command.value)
    elif command.action == "turbo":
        payload.turbo = bool(command.value)
    elif command.action == "sleep":
        payload.sleep = bool(command.value)
    else:
        raise ValueError("不支持的空调操作")
    state = await registry.command(str(device["id"]), payload)
    replies = {
        "power": f"已{'打开' if command.value else '关闭'}{command.room}空调",
        "temperature": f"已把{command.room}空调调到{command.value:g}度",
        "mode": f"已切换{command.room}空调运行模式",
        "turbo": f"已{'打开' if command.value else '关闭'}{command.room}空调强劲模式",
        "sleep": f"已{'打开' if command.value else '关闭'}{command.room}空调睡眠模式",
    }
    return state, replies[command.action]


async def _run_personal_command(command: PersonalCommand) -> str:
    if command.device == "unknown":
        return (
            "我可以控制客厅、主卧和次卧空调，也可以控制照明、插座、"
            "索尼电视、浴霸和追觅扫地机器人"
        )
    if command.device == "ac":
        _, reply = await _personal_air_conditioner(command)
        return reply
    if command.device == "plug":
        if command.action == "status":
            state = await plug.status()
            return f"智能插座目前{'打开' if state.get('on') else '关闭'}"
        await plug.command(PlugCommand(on=bool(command.value)))
        return f"已{'打开' if command.value else '关闭'}智能插座"
    if command.device == "light":
        if command.action == "status":
            state = await opple_light.status()
            return f"照明目前{'打开' if state.get('power') else '关闭'}"
        if command.action == "brightness":
            await opple_light.command(OppleCommand(brightness=int(command.value)))
            return f"已把灯光亮度调到百分之{int(command.value)}"
        await opple_light.command(OppleCommand(power=bool(command.value)))
        return f"已{'打开' if command.value else '关闭'}照明"
    if command.device == "tv":
        if command.action == "status":
            state = await sony_tv.status()
            return f"客厅电视目前{'打开' if state.get('power') else '关闭'}"
        if command.action == "mute":
            await sony_tv.command(TVCommand(mute=bool(command.value)))
            return "已静音" if command.value else "已恢复电视声音"
        await sony_tv.command(TVCommand(power=bool(command.value)))
        return f"已{'打开' if command.value else '关闭'}客厅电视"
    if command.device == "aupu":
        if command.action == "status":
            state = await aupu.status()
            return f"浴霸当前模式是{state.get('mode_label') or state.get('mode') or '待机'}"
        await aupu.command(AupuCommand(mode=int(command.value)))
        labels = {
            0: "关闭",
            1: "弱暖风",
            2: "强暖风",
            3: "吹风",
            4: "换气",
            5: "干燥",
            6: "杀菌除臭",
        }
        return f"已将浴霸切换到{labels[int(command.value)]}"
    if command.device == "dreame":
        if command.action == "status":
            state = await dreame.status()
            return (
                f"追觅扫地机器人当前"
                f"{state.get('status_label') or state.get('state_label') or '在线'}"
            )
        await dreame.command(DreameCommand(action=command.action))
        replies = {
            "start": "追觅扫地机器人已开始全屋清扫",
            "pause": "已暂停追觅扫地机器人",
            "stop": "已停止追觅扫地机器人",
            "charge": "追觅扫地机器人正在返回充电座",
        }
        return replies[command.action]
    raise ValueError("暂不支持这个设备")


@app.get(
    "/api/aligenie/personal/setup",
    dependencies=[Depends(require_token)],
)
async def aligenie_personal_setup() -> dict[str, str | bool]:
    token = _personal_webhook_token()
    return {
        "configured": bool(token),
        "webhook_url": _personal_webhook_url(),
        "header_name": "X-Home-Skill-Token",
        "header_value": token,
        "skill_id": "119359",
        "application_id": "2026073128637",
    }


@app.post("/aligenie/personal/webhook")
async def aligenie_personal_webhook(
    request: Request,
    x_home_skill_token: str | None = Header(default=None),
) -> dict[str, Any]:
    expected = _personal_webhook_token()
    if not expected or not x_home_skill_token or not _same_secret(
        x_home_skill_token,
        expected,
    ):
        raise HTTPException(status_code=401, detail="invalid skill token")
    try:
        message = await request.json()
    except Exception:
        message = {}
    if str(message.get("skillId") or "") not in {"", "119359"}:
        raise HTTPException(status_code=403, detail="unexpected skill")
    utterance = message.get("utterance") or message.get("query")
    if not utterance:
        request_data = message.get("requestData")
        if isinstance(request_data, dict):
            utterance = request_data.get("utterance") or request_data.get("query")
    try:
        reply = await _run_personal_command(parse_personal_command(utterance))
        return personal_response(reply)
    except Exception:
        logging.exception("AliGenie personal skill command failed")
        return personal_response("设备暂时没有响应，请稍后再试", success=False)


@app.get("/aligenie/{verification_file}")
async def aligenie_verification_file(verification_file: str) -> FileResponse:
    if not re.fullmatch(r"[0-9a-fA-F]{16,64}\.txt", verification_file):
        raise HTTPException(status_code=404, detail="not found")
    path = Path(
        os.getenv(
            "GREE_DATA_DIR",
            str(Path(__file__).resolve().parent.parent / "data"),
        )
    ) / "aligenie" / verification_file
    if not path.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(
        path,
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/dreame", dependencies=[Depends(require_token)])
async def dreame_status() -> dict[str, Any]:
    return await dreame.status()


@app.post("/api/dreame/login", dependencies=[Depends(require_token)])
async def dreame_login(payload: DreameLoginRequest) -> dict[str, Any]:
    try:
        return await dreame.login(payload)
    except DreameError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/dreame/command", dependencies=[Depends(require_token)])
async def dreame_command(payload: DreameCommand) -> dict[str, Any]:
    try:
        return await dreame.command(payload)
    except DreameError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/dreame/setting", dependencies=[Depends(require_token)])
async def dreame_setting(payload: DreameSettingRequest) -> dict[str, Any]:
    try:
        return await dreame.setting(payload)
    except DreameError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/purifier/captcha", dependencies=[Depends(require_token)])
async def purifier_captcha(payload: PurifierSmsRequest) -> dict[str, Any]:
    try:
        return await purifier.send_captcha(payload)
    except PurifierError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/purifier/login", dependencies=[Depends(require_token)])
async def purifier_login(payload: PurifierLoginRequest) -> dict[str, Any]:
    try:
        return await purifier.login(payload)
    except PurifierError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/tv/screenshot", dependencies=[Depends(require_token)])
async def tv_screenshot() -> Response:
    try:
        image = await sony_tv.screenshot()
    except SonyError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return Response(
        content=image,
        media_type="image/png",
        headers={"Cache-Control": "no-store, max-age=0"},
    )


@app.get("/api/tv/foreground", dependencies=[Depends(require_token)])
async def tv_foreground() -> dict[str, Any]:
    try:
        return await sony_tv.foreground_app()
    except SonyError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/api/tv/apps/{app_id}", dependencies=[Depends(require_token)])
async def tv_launch_app(app_id: str) -> dict[str, Any]:
    try:
        return await sony_tv.launch_app(app_id)
    except SonyError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/tv/cleanup", dependencies=[Depends(require_token)])
async def tv_cleanup_apps() -> dict[str, Any]:
    try:
        return await sony_tv.cleanup_apps()
    except SonyError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/tv/command", dependencies=[Depends(require_token)])
async def tv_command(payload: TVCommand) -> dict[str, Any]:
    try:
        return await sony_tv.command(payload)
    except SonyError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


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
    if payload.device_id == SONY_TV_DEVICE_ID:
        if not sony_tv.configured:
            raise HTTPException(status_code=503, detail="Sony TV is not configured")
    elif payload.device_id == MIJIA_PLUG_DEVICE_ID:
        if not (await plug.status()).get("configured"):
            raise HTTPException(status_code=503, detail="Mijia plug is not configured")
    elif payload.device_id == AUPU_DEVICE_ID:
        aupu_state = await aupu.status()
        if not aupu_state.get("configured"):
            raise HTTPException(status_code=503, detail="Aupu bath heater is not configured")
        if not aupu_state.get("online"):
            raise HTTPException(status_code=503, detail="Aupu bath heater is offline")
    elif payload.device_id not in registry.devices:
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
