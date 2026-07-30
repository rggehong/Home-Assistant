from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import urllib.error
import urllib.request
from typing import Any

from pydantic import BaseModel, Field

REMOTE_CODES = {
    "tv": "AAAAAQAAAAEAAAAkAw==",
    "input": "AAAAAQAAAAEAAAAlAw==",
    # On the K-75XR51Z, `Options` opens quick settings while `ActionMenu`
    # opens the physical remote's colors/numbers/subtitles/audio panel.
    "settings": "AAAAAgAAAJcAAAA2Aw==",
    "options": "AAAAAgAAAMQAAABLAw==",
    "up": "AAAAAQAAAAEAAAB0Aw==",
    "down": "AAAAAQAAAAEAAAB1Aw==",
    "left": "AAAAAQAAAAEAAAA0Aw==",
    "right": "AAAAAQAAAAEAAAAzAw==",
    "confirm": "AAAAAQAAAAEAAABlAw==",
    "back": "AAAAAgAAAJcAAAAjAw==",
    "home": "AAAAAQAAAAEAAABgAw==",
    "volume_up": "AAAAAQAAAAEAAAASAw==",
    "volume_down": "AAAAAQAAAAEAAAATAw==",
    "mute": "AAAAAQAAAAEAAAAUAw==",
    "menu": "AAAAAgAAAMQAAABPAw==",
}


class SonyError(RuntimeError):
    pass


class TVCommand(BaseModel):
    power: bool | None = None
    volume: int | None = Field(default=None, ge=0, le=100)
    mute: bool | None = None
    input_uri: str | None = Field(default=None, max_length=180)
    remote: str | None = Field(default=None, max_length=40)


class SonyTV:
    def __init__(self) -> None:
        self.ip = os.getenv("SONY_TV_IP", "192.168.0.142")
        self.name = os.getenv("SONY_TV_NAME", "客厅电视")
        self.model = "K-75XR51Z"

    @property
    def configured(self) -> bool:
        return bool(os.getenv("SONY_TV_PSK"))

    def _call_sync(
        self,
        service: str,
        method: str,
        params: list[Any] | None = None,
        version: str = "1.0",
    ) -> Any:
        payload = json.dumps(
            {"method": method, "params": params or [], "id": 1, "version": version}
        ).encode()
        headers = {"Content-Type": "application/json; charset=UTF-8"}
        psk = os.getenv("SONY_TV_PSK")
        if psk:
            headers["X-Auth-PSK"] = psk
        request = urllib.request.Request(
            f"http://{self.ip}/sony/{service}",
            data=payload,
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise SonyError(f"电视接口拒绝请求 ({exc.code})") from exc
        except (OSError, ValueError) as exc:
            raise SonyError("无法连接索尼电视") from exc
        if "error" in body:
            message = body["error"][1] if len(body["error"]) > 1 else "电视接口错误"
            raise SonyError(str(message))
        return body.get("result", [])

    async def call(
        self,
        service: str,
        method: str,
        params: list[Any] | None = None,
        version: str = "1.0",
    ) -> Any:
        return await asyncio.to_thread(
            self._call_sync, service, method, params, version
        )

    def _ircc_sync(self, command: str) -> None:
        code = REMOTE_CODES.get(command)
        if not code:
            raise SonyError("不支持的电视遥控命令")
        body = (
            '<?xml version="1.0"?>'
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
            's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
            "<s:Body><u:X_SendIRCC xmlns:u=\"urn:schemas-sony-com:service:IRCC:1\">"
            f"<IRCCCode>{code}</IRCCCode>"
            "</u:X_SendIRCC></s:Body></s:Envelope>"
        ).encode()
        request = urllib.request.Request(
            f"http://{self.ip}/sony/IRCC",
            data=body,
            headers={
                "Content-Type": 'text/xml; charset="utf-8"',
                "SOAPAction": '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"',
                "X-Auth-PSK": os.getenv("SONY_TV_PSK", ""),
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=5):
                pass
        except urllib.error.HTTPError as exc:
            raise SonyError(f"电视遥控接口拒绝请求 ({exc.code})") from exc
        except (OSError, ValueError) as exc:
            raise SonyError("无法连接索尼电视") from exc

    async def send_remote(self, command: str) -> None:
        await asyncio.to_thread(self._ircc_sync, command)

    def _screenshot_sync(self) -> bytes:
        adb = shutil.which("adb")
        if not adb:
            raise SonyError("服务器尚未安装 ADB，无法抓取电视画面")

        def run(*args: str, timeout: float = 8) -> subprocess.CompletedProcess[bytes]:
            try:
                return subprocess.run(
                    [adb, *args],
                    check=False,
                    capture_output=True,
                    timeout=timeout,
                )
            except subprocess.TimeoutExpired as exc:
                raise SonyError("电视截图请求超时") from exc

        run("start-server", timeout=5)
        devices = run("devices", "-l", timeout=5).stdout.decode(errors="replace")
        endpoints = [
            line.split()[0]
            for line in devices.splitlines()[1:]
            if line.strip() and "\tdevice" in line
        ]

        configured_endpoint = os.getenv("SONY_TV_ADB_ENDPOINT", "").strip()
        candidates: list[str] = []
        if configured_endpoint:
            candidates.append(configured_endpoint)

        mdns = run("mdns", "services", timeout=5)
        mdns_text = mdns.stdout.decode(errors="replace")
        discovered = [
            match.group(0)
            for match in re.finditer(rf"{re.escape(self.ip)}:\d{{2,5}}", mdns_text)
        ]
        candidates.extend(discovered)
        candidates.append(f"{self.ip}:5555")

        endpoint = next(
            (item for item in endpoints if item == self.ip or item.startswith(f"{self.ip}:")),
            None,
        )
        for candidate in dict.fromkeys(candidates):
            if endpoint:
                break
            connected = run("connect", candidate, timeout=6)
            message = (connected.stdout + connected.stderr).decode(errors="replace").lower()
            if "connected to" in message or "already connected" in message:
                endpoint = candidate

        if not endpoint:
            if discovered:
                raise SonyError(
                    "电视已开启无线调试，但 146 服务器尚未配对。请在电视中选择"
                    "“使用配对码配对设备”完成首次配对"
                )
            raise SonyError(
                "电视未开启无线调试。请在电视“开发者选项 → 无线调试”中开启后重试"
            )

        capture = run("-s", endpoint, "exec-out", "screencap", "-p", timeout=15)
        if capture.returncode != 0 or not capture.stdout.startswith(b"\x89PNG\r\n\x1a\n"):
            detail = capture.stderr.decode(errors="replace").strip()
            raise SonyError(detail or "电视没有返回有效画面")
        if len(capture.stdout) > 20 * 1024 * 1024:
            raise SonyError("电视截图文件过大")
        return capture.stdout

    async def screenshot(self) -> bytes:
        return await asyncio.to_thread(self._screenshot_sync)

    async def set_power_verified(
        self,
        power: bool,
        attempts: int = 3,
    ) -> dict[str, Any]:
        state = await self.status()
        if bool(state.get("power")) == power:
            return state

        last_error: Exception | None = None
        for attempt in range(attempts):
            try:
                await self.call("system", "setPowerStatus", [{"status": power}])
            except Exception as exc:
                last_error = exc
            await asyncio.sleep(1.5 + attempt)
            state = await self.status()
            if bool(state.get("power")) == power:
                return state

        if last_error is not None:
            raise SonyError(f"电视电源操作失败：{last_error}")
        target = "开机" if power else "关机"
        raise SonyError(f"电视未确认完成{target}")

    async def status(self) -> dict[str, Any]:
        result = {
            "id": "sony-living-tv",
            "type": "television",
            "name": self.name,
            "room": "客厅",
            "ip": self.ip,
            "brand": "Sony",
            "model": self.model,
            "configured": self.configured,
            "online": False,
            "power": False,
            "volume": None,
            "mute": None,
            "input_uri": None,
            "input_title": None,
            "inputs": [],
        }
        try:
            power, inputs, volume, playing = await asyncio.gather(
                self.call("system", "getPowerStatus"),
                self.call("avContent", "getCurrentExternalInputsStatus"),
                self.call("audio", "getVolumeInformation"),
                self.call("avContent", "getPlayingContentInfo"),
                return_exceptions=True,
            )
            if isinstance(power, Exception):
                raise power
            result["online"] = True
            result["power"] = bool(power and power[0].get("status") == "active")
            if not isinstance(inputs, Exception) and inputs:
                result["inputs"] = [
                    {
                        "uri": item.get("uri"),
                        "title": item.get("title") or item.get("label") or item.get("uri"),
                        "connected": bool(item.get("connection")),
                    }
                    for item in inputs[0]
                    if item.get("uri")
                ]
            if not isinstance(volume, Exception) and volume:
                entries = volume[0] if isinstance(volume[0], list) else volume
                speaker = next(
                    (item for item in entries if item.get("target") == "speaker"),
                    entries[0] if entries else {},
                )
                try:
                    result["volume"] = int(speaker.get("volume"))
                except (TypeError, ValueError):
                    pass
                result["mute"] = speaker.get("mute")
            if not isinstance(playing, Exception) and playing:
                current = playing[0]
                result["input_uri"] = current.get("uri")
                result["input_title"] = current.get("title")
        except Exception as exc:
            result["error"] = str(exc)
        return result

    async def command(self, command: TVCommand) -> dict[str, Any]:
        if not self.configured:
            raise SonyError("电视预共享密钥尚未配置")
        if command.power is not None:
            await self.call("system", "setPowerStatus", [{"status": command.power}])
        if command.volume is not None:
            await self.call(
                "audio",
                "setAudioVolume",
                [{"target": "speaker", "volume": str(command.volume)}],
            )
        if command.mute is not None:
            await self.call("audio", "setAudioMute", [{"status": command.mute}])
        if command.input_uri is not None:
            if not command.input_uri.startswith("extInput:"):
                raise SonyError("不支持的电视输入源")
            await self.call(
                "avContent",
                "setPlayContent",
                [{"uri": command.input_uri}],
            )
        if command.remote is not None:
            await self.send_remote(command.remote)
        return await self.status()


sony_tv = SonyTV()
