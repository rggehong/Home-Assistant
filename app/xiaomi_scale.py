from __future__ import annotations

import asyncio
import json
import re
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

class XiaomiScaleError(RuntimeError):
    pass


class XiaomiScale:
    def __init__(self) -> None:
        import os

        self.mac = os.getenv("XIAOMI_SCALE_MAC", "C8:0F:10:A8:EC:79").upper()
        self.service_uuid = "0000181d-0000-1000-8000-00805f9b34fb"
        default_history = Path(__file__).resolve().parents[1] / "data" / "xiaomi_scale_history.jsonl"
        self.history_path = Path(os.getenv("XIAOMI_SCALE_HISTORY_PATH", str(default_history)))
        self._last_record_key: tuple[Any, ...] | None = None

    @staticmethod
    def _beijing_time(year: int, month: int, day: int, hour: int, minute: int, second: int) -> str | None:
        try:
            return datetime(
                year, month, day, hour, minute, second,
                tzinfo=ZoneInfo("Asia/Shanghai"),
            ).isoformat(timespec="seconds")
        except (ValueError, TypeError):
            return None

    @staticmethod
    def _run(*args: str, timeout: float = 12) -> str:
        try:
            result = subprocess.run(
                list(args),
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise XiaomiScaleError(str(exc)) from exc
        output = (result.stdout or "") + (result.stderr or "")
        if result.returncode != 0:
            raise XiaomiScaleError(output.strip() or f"{args[0]} failed")
        return output

    async def _run_async(self, *args: str, timeout: float = 12) -> str:
        return await asyncio.to_thread(self._run, *args, timeout=timeout)

    @staticmethod
    def _hex_after_marker(lines: list[str], marker: str) -> bytes:
        for index, line in enumerate(lines):
            if marker not in line:
                continue
            chunks: list[str] = []
            for candidate in lines[index + 1 :]:
                match = re.match(
                    r"^\s*((?:[0-9A-Fa-f]{2}\s+)+[0-9A-Fa-f]{2})\s+",
                    candidate,
                )
                if not match:
                    break
                chunks.extend(match.group(1).split())
            try:
                return bytes.fromhex("".join(chunks))
            except ValueError:
                return b""
        return b""

    @staticmethod
    def _decode(payload: bytes) -> dict[str, Any]:
        if len(payload) < 3:
            return {"raw": payload.hex(" "), "has_weight": False, "stable": False}
        flags = payload[0]
        has_weight = (flags & 0x80) == 0
        stable = bool(flags & 0x20)
        if flags & 0x10:
            unit = "jin"
            divisor = 100.0
        elif flags & 0x04:
            unit = "lb"
            divisor = 100.0
        elif flags & 0x02:
            unit = "kg"
            divisor = 200.0
        else:
            unit = "unknown"
            divisor = 100.0
        raw_weight = int.from_bytes(payload[1:3], "little")
        result: dict[str, Any] = {
            "raw": payload.hex(" "),
            "flags": flags,
            "has_weight": has_weight,
            "stable": stable,
            "unit": unit,
            "raw_weight": raw_weight,
            "weight": round(raw_weight / divisor, 2) if has_weight else None,
        }
        if len(payload) >= 10:
            year = int.from_bytes(payload[3:5], "little")
            month, day, hour, minute, second = payload[5:10]
            result["measured_at"] = XiaomiScale._beijing_time(
                year, month, day, hour, minute, second
            )
        return result

    def _record_measurement(self, decoded: dict[str, Any], rssi: str | None) -> bool:
        if not decoded.get("has_weight") or not decoded.get("stable"):
            return False
        if decoded.get("weight") is None:
            return False
        record = {
            "measured_at": decoded.get("measured_at"),
            "recorded_at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds"),
            "weight": decoded["weight"],
            "unit": decoded.get("unit", "unknown"),
            "raw": decoded.get("raw", ""),
            "rssi": rssi,
            "mac": self.mac,
        }
        key = (record["measured_at"], record["weight"], record["unit"], record["raw"])
        if key == self._last_record_key:
            return False
        try:
            self.history_path.parent.mkdir(parents=True, exist_ok=True)
            if self.history_path.exists():
                for line in reversed(self.history_path.read_text(encoding="utf-8").splitlines()):
                    if not line.strip():
                        continue
                    try:
                        previous = json.loads(line)
                    except json.JSONDecodeError:
                        break
                    previous_key = (
                        previous.get("measured_at"),
                        previous.get("weight"),
                        previous.get("unit"),
                        previous.get("raw"),
                    )
                    if previous_key == key:
                        self._last_record_key = key
                        return False
                    break
            with self.history_path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError:
            return False
        self._last_record_key = key
        return True

    def history(self, limit: int = 20) -> list[dict[str, Any]]:
        limit = max(1, min(100, int(limit)))
        try:
            lines = self.history_path.read_text(encoding="utf-8").splitlines()
        except (FileNotFoundError, OSError):
            return []
        records: list[dict[str, Any]] = []
        for line in reversed(lines):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(record, dict):
                records.append(record)
            if len(records) >= limit:
                break
        return records

    async def status(self, scan_seconds: int = 10) -> dict[str, Any]:
        try:
            await self._run_async(
                "bluetoothctl",
                "--timeout",
                str(max(3, min(15, scan_seconds))),
                "scan",
                "on",
                timeout=max(8, scan_seconds + 4),
            )
            info = await self._run_async("bluetoothctl", "info", self.mac)
        except XiaomiScaleError as exc:
            return {
                "configured": True,
                "mac": self.mac,
                "service": self.service_uuid,
                "online": False,
                "error": str(exc),
            }
        lines = info.splitlines()
        payload = self._hex_after_marker(lines, "ServiceData.0000181d")
        decoded = self._decode(payload)
        rssi = next((line.split(":", 1)[1].strip() for line in lines if "RSSI:" in line), None)
        name = next((line.split(":", 1)[1].strip() for line in lines if line.startswith("Name:")), "MI_SCALE")
        self._record_measurement(decoded, rssi)
        return {
            "configured": True,
            "mac": self.mac,
            "name": name,
            "service": self.service_uuid,
            "online": True,
            "rssi": rssi,
            "advertisement": decoded,
            "control_supported": False,
            "note": "小米秤通过 BLE 广播上报，项目仅读取，不发送控制命令。",
        }


xiaomi_scale = XiaomiScale()
