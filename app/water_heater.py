from __future__ import annotations

import asyncio
import os
import time
from typing import Any


WATER_HEATER_IP = os.getenv("WATER_HEATER_IP", "192.168.0.108")
WATER_HEATER_MODEL = os.getenv("WATER_HEATER_MODEL", "JSQ31-VJSAi")
WATER_HEATER_NAME = "A.O.史密斯燃气热水器"


class WaterHeaterController:
    """Read-only discovery for the Huawei Smart Life connected water heater.

    The appliance exposes no TCP/UPnP/MiIO/CoAP control service on the LAN.
    Reachability is therefore reported independently from cloud control
    authorization so the UI never presents an unsafe or non-functional control.
    """

    def __init__(self) -> None:
        self._last_probe_at = 0.0
        self._last_reachable = False
        self._probe_lock = asyncio.Lock()

    async def _probe(self) -> bool:
        now = time.monotonic()
        if now - self._last_probe_at < 10:
            return self._last_reachable
        async with self._probe_lock:
            now = time.monotonic()
            if now - self._last_probe_at < 10:
                return self._last_reachable
            try:
                process = await asyncio.create_subprocess_exec(
                    "ping",
                    "-c",
                    "1",
                    "-W",
                    "1",
                    WATER_HEATER_IP,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                self._last_reachable = await process.wait() == 0
            except (FileNotFoundError, OSError):
                self._last_reachable = False
            self._last_probe_at = time.monotonic()
            return self._last_reachable

    async def status(self) -> dict[str, Any]:
        reachable = await self._probe()
        return {
            "id": "aosmith-gas-water-heater",
            "name": WATER_HEATER_NAME,
            "model": WATER_HEATER_MODEL,
            "ip": WATER_HEATER_IP,
            "platform": "华为智慧生活",
            "reachable": reachable,
            "cloud_authorized": False,
            "control_ready": False,
            "capabilities": [],
            "connection": "华为智慧生活云端",
            "status_text": (
                "局域网在线，等待华为云授权"
                if reachable
                else "当前未在局域网发现设备"
            ),
            "notice": (
                "设备未开放局域网控制接口；待取得华为智慧生活云授权后，"
                "再启用开关、温度和定时控制。"
            ),
        }


water_heater = WaterHeaterController()
