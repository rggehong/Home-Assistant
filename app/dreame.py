from __future__ import annotations

import asyncio
import hashlib
import json
import os
import random
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlencode

from pydantic import BaseModel, Field


DREAME_IP = os.getenv("DREAME_VACUUM_IP", "192.168.0.106")
API_SUFFIX = ".iot.dreame.tech:13267"
CLIENT_SECRET = "RAylYC%fmSKp7%Tq"
USER_AGENT = "Dreame_Smarthome/2.1.9 (iPhone; iOS 18.4.1; Scale/3.00)"
CN_RLC = "1c80b3787b2266776bcdc481f37d8fa42ba10a30af81a6df-1"
BASIC_AUTH = "Basic ZHJlYW1lX2FwcHYxOkFQXmR2QHpAU1FZVnhOODg="

PROPERTY_MAP: dict[str, tuple[int, int]] = {
    "state": (2, 1),
    "error": (2, 2),
    "battery": (3, 1),
    "charging_status": (3, 2),
    "off_peak_charging": (3, 3),
    "status": (4, 1),
    "cleaning_time": (4, 2),
    "cleaned_area": (4, 3),
    "suction_level": (4, 4),
    "water_volume": (4, 5),
    "task_status": (4, 7),
    "resume_cleaning": (4, 11),
    "carpet_boost": (4, 12),
    "faults": (4, 18),
    "obstacle_avoidance": (4, 21),
    "cleaning_mode": (4, 23),
    "base_status": (4, 25),
    "child_lock": (4, 27),
    "warn_status": (4, 35),
    "auto_add_detergent": (4, 37),
    "drying_time": (4, 40),
    "low_water_warning": (4, 41),
    "auto_mount_mop": (4, 45),
    "mop_wash_level": (4, 46),
    "auto_water_refilling": (4, 51),
    "mop_in_station": (4, 52),
    "mop_pad_installed": (4, 53),
    "cleaning_progress": (4, 63),
    "drying_progress": (4, 64),
    "dnd": (5, 1),
    "dnd_start": (5, 2),
    "dnd_end": (5, 3),
    "volume": (7, 1),
    "main_brush_left": (9, 2),
    "side_brush_left": (10, 2),
    "filter_left": (11, 1),
    "cleaning_count": (12, 3),
    "total_cleaned_area": (12, 4),
    "auto_dust_collecting": (15, 1),
    "auto_empty_status": (15, 5),
    "sensor_dirty_left": (16, 1),
    "silver_ion_left": (19, 2),
    "clean_water_tank_status": (27, 1),
    "dirty_water_tank_status": (27, 2),
    "dust_bag_status": (27, 3),
    "detergent_status": (27, 4),
    "hot_water_status": (27, 15),
    "wetness_level": (28, 1),
    "water_temperature": (28, 8),
    "smart_mop_washing": (28, 22),
    "silent_drying": (28, 27),
}

CLEANING_PROPERTIES_PIID = 10

STATE_NAMES = {
    1: "扫地中",
    2: "待机",
    3: "已暂停",
    4: "发生故障",
    5: "正在回充",
    6: "充电中",
    7: "拖地中",
    8: "烘干中",
    9: "清洗拖布",
    10: "返回清洗",
    11: "正在建图",
    12: "扫拖中",
    13: "充电完成",
    14: "升级中",
    18: "返回拆卸拖布",
    21: "拖布清洗暂停",
    22: "集尘中",
    23: "远程控制",
    28: "返回集尘",
    30: "基站清洁",
}
STATUS_NAMES = {
    0: "空闲",
    1: "已暂停",
    2: "清扫中",
    3: "返回基站",
    6: "充电中",
    12: "故障",
    14: "休眠",
    17: "待机",
    18: "房间清扫",
    19: "区域清扫",
    20: "定点清扫",
    21: "快速建图",
}
BASE_STATUS_NAMES = {
    0: "基站空闲",
    1: "清洗拖布",
    2: "烘干拖布",
    3: "返回基站",
    4: "基站暂停",
    5: "清洁加水",
    6: "正在加水",
}
SUCTION_NAMES = {0: "安静", 1: "标准", 2: "强力", 3: "超强"}
WETNESS_NAMES = {5: "偏干", 16: "适中", 27: "湿润"}
MOP_WASH_NAMES = {0: "节水", 1: "日常", 2: "深度"}


class DreameError(RuntimeError):
    pass


class DreameLoginRequest(BaseModel):
    username: str = Field(min_length=3, max_length=128)
    password: str = Field(min_length=3, max_length=256)
    country: Literal["cn", "eu", "us", "sg", "ru", "kr"] = "cn"


class DreameCommand(BaseModel):
    action: Literal[
        "start",
        "pause",
        "charge",
        "stop",
        "locate",
        "auto_empty",
        "wash_mop",
        "stop_washing",
        "dry_mop",
        "stop_drying",
    ]


class DreameSettingRequest(BaseModel):
    setting: Literal[
        "suction_level",
        "wetness_level",
        "cleaning_mode",
        "mop_wash_level",
        "volume",
        "resume_cleaning",
        "carpet_boost",
        "obstacle_avoidance",
        "child_lock",
        "dnd",
        "auto_add_detergent",
        "auto_water_refilling",
        "auto_dust_collecting",
        "smart_mop_washing",
        "silent_drying",
    ]
    value: int | bool


class DreameController:
    def __init__(self) -> None:
        data_dir = Path(
            os.getenv(
                "GREE_DATA_DIR",
                str(Path(__file__).resolve().parent.parent / "data"),
            )
        )
        self.path = data_dir / "dreame.json"
        self.lock = asyncio.Lock()
        self.request_id = random.randint(1, 100)

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

    @staticmethod
    def _base_url(country: str) -> str:
        return f"https://{country}{API_SUFFIX}"

    @staticmethod
    def _headers(country: str, token: str | None = None) -> dict[str, str]:
        headers = {
            "Accept": "*/*",
            "Accept-Language": "zh-CN;q=0.9",
            "Accept-Encoding": "gzip, deflate",
            "User-Agent": USER_AGENT,
            "Dreame-Rlc": "000000",
            "Tenant-Id": "000000",
        }
        if token:
            headers["Dreame-Auth"] = token
            headers["Content-Type"] = "application/json"
        else:
            headers["Authorization"] = BASIC_AUTH
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        if country == "cn":
            headers["region"] = CN_RLC
        return headers

    @staticmethod
    def _request(
        url: str,
        headers: dict[str, str],
        payload: bytes | None,
        timeout: float = 12,
    ) -> dict[str, Any]:
        request = urllib.request.Request(url, data=payload, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                data = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            try:
                error_data = json.loads(detail)
            except json.JSONDecodeError:
                error_data = {}
            if error_data.get("error") == "limit_attempts_unauthorized":
                remains = error_data.get("remains")
                suffix = f"，当前还可尝试 {remains} 次" if remains is not None else ""
                raise DreameError(
                    "Dreamehome 邮箱账号或密码不匹配"
                    f"{suffix}。请勿继续试手机号或短信验证码；先在 App 中绑定邮箱并设置登录密码。"
                ) from exc
            raise DreameError(f"Dreamehome 请求失败 ({exc.code})：{detail[:180]}") from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise DreameError(f"无法连接 Dreamehome 云端：{exc}") from exc
        return data if isinstance(data, dict) else {}

    def _token_login(
        self,
        country: str,
        *,
        username: str | None = None,
        password: str | None = None,
        refresh_token: str | None = None,
    ) -> dict[str, Any]:
        if refresh_token:
            body = urlencode(
                {
                    "platform": "IOS",
                    "scope": "all",
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                }
            )
        elif username is not None and password is not None:
            digest = hashlib.md5((password + CLIENT_SECRET).encode("utf-8")).hexdigest()
            body = urlencode(
                {
                    "platform": "IOS",
                    "scope": "all",
                    "grant_type": "password",
                    "username": username,
                    "password": digest,
                    "type": "account",
                }
            )
        else:
            raise DreameError("缺少 Dreamehome 登录信息")
        result = self._request(
            f"{self._base_url(country)}/dreame-auth/oauth/token",
            self._headers(country),
            body.encode("utf-8"),
        )
        if not result.get("access_token"):
            message = result.get("error_description") or result.get("message") or "账号或密码错误"
            raise DreameError(str(message))
        return result

    def _cloud_call(
        self,
        config: dict[str, Any],
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        country = str(config.get("country") or "cn")
        token = str(config.get("access_token") or "")
        expires_at = float(config.get("expires_at") or 0)
        if not token or expires_at <= time.time() + 60:
            auth = self._token_login(
                country,
                refresh_token=str(config.get("refresh_token") or ""),
            )
            config["access_token"] = auth["access_token"]
            config["refresh_token"] = auth.get("refresh_token") or config.get("refresh_token")
            config["expires_at"] = time.time() + int(auth.get("expires_in") or 3600) - 120
            config["tenant_id"] = auth.get("tenant_id") or config.get("tenant_id") or "000000"
            self._save(config)
        headers = self._headers(country, str(config["access_token"]))
        headers["Tenant-Id"] = str(config.get("tenant_id") or "000000")
        body = (
            json.dumps(payload, separators=(",", ":")).encode("utf-8")
            if payload is not None
            else None
        )
        result = self._request(
            f"{self._base_url(country)}/{path.lstrip('/')}",
            headers,
            body,
        )
        if result.get("code") not in (None, 0) and not result.get("success"):
            raise DreameError(str(result.get("message") or result.get("msg") or "云端请求失败"))
        return result

    def _devices(self, config: dict[str, Any]) -> list[dict[str, Any]]:
        result = self._cloud_call(
            config,
            "dreame-user-iot/iotuserbind/device/listV2",
        )
        data = result.get("data") or {}
        records = (data.get("page") or {}).get("records") or []
        return [item for item in records if isinstance(item, dict)]

    @staticmethod
    def _choose_device(devices: list[dict[str, Any]]) -> dict[str, Any]:
        vacuums = [item for item in devices if ".vacuum." in str(item.get("model") or "")]
        if not vacuums:
            raise DreameError("该 Dreamehome 账号下未发现扫地机器人")
        return next(
            (
                item
                for item in vacuums
                if "x30" in json.dumps(item, ensure_ascii=False).lower()
            ),
            vacuums[0],
        )

    def _send(self, config: dict[str, Any], method: str, params: Any) -> Any:
        did = str(config["did"])
        last_error: DreameError | None = None
        for attempt in range(3):
            request_id = self.request_id
            self.request_id += 1
            if self.request_id > 99999999:
                self.request_id = 1
            try:
                result = self._cloud_call(
                    config,
                    "dreame-iot-com-10000/device/sendCommand",
                    {
                        "did": did,
                        "id": request_id,
                        "data": {
                            "did": did,
                            "id": request_id,
                            "method": method,
                            "params": params,
                        },
                    },
                )
            except DreameError as exc:
                last_error = exc
                if attempt < 2 and "超时" in str(exc):
                    continue
                raise
            data = result.get("data") or {}
            if "result" in data:
                return data["result"]
            if result.get("success") is True and attempt < 2:
                continue
            return None
        if last_error is not None:
            raise last_error
        return None

    def _get_properties(
        self,
        config: dict[str, Any],
        names: list[str],
    ) -> tuple[dict[str, Any], list[str]]:
        did = str(config["did"])
        values: dict[str, Any] = {}
        supported: list[str] = []
        for start in range(0, len(names), 15):
            chunk = names[start : start + 15]
            request = [
                {
                    "did": did,
                    "siid": PROPERTY_MAP[name][0],
                    "piid": PROPERTY_MAP[name][1],
                }
                for name in chunk
            ]
            result = self._send(config, "get_properties", request) or []
            by_key = {
                (int(item["siid"]), int(item["piid"])): item
                for item in result
                if isinstance(item, dict)
                and item.get("siid") is not None
                and item.get("piid") is not None
            }
            for name in chunk:
                item = by_key.get(PROPERTY_MAP[name], {})
                if item.get("code") == 0:
                    supported.append(name)
                    values[name] = item.get("value")
        return values, supported

    def _set_property(
        self,
        config: dict[str, Any],
        name: str,
        value: Any,
    ) -> None:
        if name not in PROPERTY_MAP:
            raise DreameError("该设置暂未接入")
        did = str(config["did"])
        siid, piid = PROPERTY_MAP[name]
        result = self._send(
            config,
            "set_properties",
            [{"did": did, "siid": siid, "piid": piid, "value": value}],
        )
        if (
            not isinstance(result, list)
            or not result
            or result[0].get("code") != 0
        ):
            raise DreameError("X30 未确认保存该设置")

    @staticmethod
    def _cleaning_mode(value: Any) -> int | None:
        if not isinstance(value, int):
            return None
        return value & 0x03

    def _status_sync(self) -> dict[str, Any]:
        config = self._load()
        base = {
            "ip": DREAME_IP,
            "model_name": "追觅 X30",
            "configured": bool(config.get("refresh_token") and config.get("did")),
            "online": False,
            "state": None,
            "status": None,
            "battery": None,
            "charging_status": None,
            "cleaning_time": None,
            "cleaned_area": None,
            "suction_level": None,
            "capabilities": [],
        }
        if not base["configured"]:
            return base
        try:
            names = list(PROPERTY_MAP)
            values, supported = self._get_properties(config, names)
            state = values.get("state")
            status = values.get("status")
            base_status = values.get("base_status")
            suction = values.get("suction_level")
            wetness = values.get("wetness_level")
            wash_level = values.get("mop_wash_level")
            base.update(
                {
                    "online": True,
                    "device_name": config.get("name") or "追觅 X30",
                    "model": config.get("model"),
                    **values,
                    "state_text": STATE_NAMES.get(state, f"状态 {state}"),
                    "status_text": STATUS_NAMES.get(status, f"模式 {status}"),
                    "base_status_text": BASE_STATUS_NAMES.get(
                        base_status,
                        f"基站状态 {base_status}",
                    ),
                    "suction_text": SUCTION_NAMES.get(suction, "未知"),
                    "wetness_text": WETNESS_NAMES.get(wetness, "未知"),
                    "mop_wash_text": MOP_WASH_NAMES.get(wash_level, "未知"),
                    "cleaning_mode_value": self._cleaning_mode(
                        values.get("cleaning_mode")
                    ),
                    "capabilities": supported,
                }
            )
        except DreameError as exc:
            base["error"] = str(exc)
        return base

    async def login(self, payload: DreameLoginRequest) -> dict[str, Any]:
        async with self.lock:
            def work() -> dict[str, Any]:
                username = payload.username.strip()
                if "@" not in username or username.startswith("@") or username.endswith("@"):
                    raise DreameError(
                        "当前 Dreamehome 云端接口仅支持邮箱账号。"
                        "请先在 Dreamehome App 的账号与安全中绑定邮箱并设置登录密码。"
                    )
                auth = self._token_login(
                    payload.country,
                    username=username,
                    password=payload.password,
                )
                config = {
                    "country": payload.country,
                    "access_token": auth["access_token"],
                    "refresh_token": auth.get("refresh_token"),
                    "expires_at": time.time() + int(auth.get("expires_in") or 3600) - 120,
                    "tenant_id": auth.get("tenant_id") or "000000",
                }
                device = self._choose_device(self._devices(config))
                config.update(
                    {
                        "did": str(device.get("did")),
                        "model": device.get("model"),
                        "name": device.get("customName")
                        or (device.get("deviceInfo") or {}).get("displayName")
                        or "追觅 X30",
                    }
                )
                self._save(config)
                return self._status_sync()

            return await asyncio.to_thread(work)

    async def status(self) -> dict[str, Any]:
        async with self.lock:
            return await asyncio.to_thread(self._status_sync)

    async def command(self, payload: DreameCommand) -> dict[str, Any]:
        async with self.lock:
            def work() -> dict[str, Any]:
                config = self._load()
                if not config.get("did"):
                    raise DreameError("请先连接 Dreamehome 账号")
                actions = {
                    "start": (2, 1, []),
                    "pause": (2, 2, []),
                    "charge": (3, 1, []),
                    "stop": (4, 2, []),
                    "locate": (7, 1, []),
                    "auto_empty": (15, 1, []),
                    "wash_mop": (
                        4,
                        4,
                        [{"piid": CLEANING_PROPERTIES_PIID, "value": "2,1"}],
                    ),
                    "stop_washing": (
                        4,
                        4,
                        [{"piid": CLEANING_PROPERTIES_PIID, "value": "1,0"}],
                    ),
                    "dry_mop": (
                        4,
                        4,
                        [{"piid": CLEANING_PROPERTIES_PIID, "value": "3,1"}],
                    ),
                    "stop_drying": (
                        4,
                        4,
                        [{"piid": CLEANING_PROPERTIES_PIID, "value": "3,0"}],
                    ),
                }
                siid, aiid, inputs = actions[payload.action]
                did = str(config["did"])
                result = self._send(
                    config,
                    "action",
                    {"did": did, "siid": siid, "aiid": aiid, "in": inputs},
                )
                if (
                    not isinstance(result, list)
                    or not result
                    or result[0].get("code") != 0
                ):
                    raise DreameError("X30 未确认执行该指令")
                time.sleep(0.8)
                return self._status_sync()

            return await asyncio.to_thread(work)

    async def setting(self, payload: DreameSettingRequest) -> dict[str, Any]:
        async with self.lock:
            def work() -> dict[str, Any]:
                config = self._load()
                if not config.get("did"):
                    raise DreameError("请先连接 Dreamehome 账号")

                setting = payload.setting
                value: Any = payload.value
                allowed_values = {
                    "suction_level": {0, 1, 2, 3},
                    "wetness_level": {5, 16, 27},
                    "mop_wash_level": {0, 1, 2},
                }
                if setting in allowed_values:
                    if isinstance(value, bool) or int(value) not in allowed_values[setting]:
                        raise DreameError("该档位无效")
                    value = int(value)
                elif setting == "volume":
                    if isinstance(value, bool) or not 0 <= int(value) <= 100:
                        raise DreameError("音量必须在 0 到 100 之间")
                    value = int(value)
                elif setting == "cleaning_mode":
                    if isinstance(value, bool) or int(value) not in {0, 1, 2, 3}:
                        raise DreameError("该清扫模式无效")
                    current, supported = self._get_properties(
                        config,
                        ["state", "cleaning_mode"],
                    )
                    if "cleaning_mode" not in supported:
                        raise DreameError("这台 X30 不支持切换清扫模式")
                    if current.get("state") not in {2, 6, 13, 24}:
                        raise DreameError("请在扫地机空闲或充电时切换清扫模式")
                    grouped = int(current.get("cleaning_mode") or 0)
                    value = (grouped & ~0x03) | int(value)
                else:
                    value = bool(value)

                _, supported = self._get_properties(config, [setting])
                if setting not in supported:
                    raise DreameError("这台 X30 不支持该设置")
                self._set_property(config, setting, value)
                time.sleep(0.5)
                return self._status_sync()

            return await asyncio.to_thread(work)


dreame = DreameController()
