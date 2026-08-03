from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

class XiaomiScaleError(RuntimeError):
    pass


BEIJING_TZ = ZoneInfo("Asia/Shanghai")
UNIT_TO_KG = {"kg": 1.0, "jin": 0.5, "lb": 0.45359237}
DISPLAY_UNITS = tuple(UNIT_TO_KG)


class XiaomiScale:
    def __init__(self) -> None:
        self.mac = os.getenv("XIAOMI_SCALE_MAC", "C8:0F:10:A8:EC:79").upper()
        self.service_uuid = "0000181d-0000-1000-8000-00805f9b34fb"
        default_history = Path(__file__).resolve().parents[1] / "data" / "xiaomi_scale_history.jsonl"
        self.history_path = Path(os.getenv("XIAOMI_SCALE_HISTORY_PATH", str(default_history)))
        self.preferences_path = Path(
            os.getenv(
                "XIAOMI_SCALE_PREFERENCES_PATH",
                str(self.history_path.with_name("xiaomi_scale_preferences.json")),
            )
        )
        self.poll_seconds = self._bounded_int(os.getenv("XIAOMI_SCALE_POLL_SECONDS"), 300, 0, 3600)
        self.scan_seconds = self._bounded_int(os.getenv("XIAOMI_SCALE_SCAN_SECONDS"), 10, 3, 15)
        self._scan_lock = asyncio.Lock()
        self._last_record_key: tuple[Any, ...] | None = None
        self._last_scan_at: str | None = None
        self._last_recorded_at: str | None = None
        self._last_scan_error: str | None = None

    @staticmethod
    def _bounded_int(value: str | None, default: int, minimum: int, maximum: int) -> int:
        try:
            parsed = int(value) if value is not None else default
        except (TypeError, ValueError):
            parsed = default
        return max(minimum, min(maximum, parsed))

    @staticmethod
    def _beijing_time(year: int, month: int, day: int, hour: int, minute: int, second: int) -> str | None:
        try:
            return datetime(
                year, month, day, hour, minute, second,
                # Xiaomi's BLE Measurement Date Time is emitted as UTC.  Attach
                # UTC first, then convert it to the Beijing display timezone.
                tzinfo=timezone.utc,
            ).astimezone(BEIJING_TZ).isoformat(timespec="seconds")
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
        self._last_recorded_at = record["recorded_at"]
        return True

    def _read_records(self) -> list[dict[str, Any]]:
        try:
            lines = self.history_path.read_text(encoding="utf-8").splitlines()
        except (FileNotFoundError, OSError):
            return []
        records: list[dict[str, Any]] = []
        for line in lines:
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(record, dict):
                records.append(record)
        return records

    def history(self, limit: int = 20) -> list[dict[str, Any]]:
        limit = max(1, min(100, int(limit)))
        return list(reversed(self._read_records()))[:limit]

    @staticmethod
    def _parse_time(value: Any) -> datetime | None:
        if not value:
            return None
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=BEIJING_TZ)
        return parsed.astimezone(BEIJING_TZ)

    @staticmethod
    def _weight_kg(weight: Any, unit: Any) -> float | None:
        try:
            value = float(weight)
            factor = UNIT_TO_KG.get(str(unit or "").lower())
            if factor is None or value < 0:
                return None
            return value * factor
        except (TypeError, ValueError):
            return None

    def _records_since(self, days: int) -> list[dict[str, Any]]:
        days = max(1, min(3650, int(days)))
        cutoff = datetime.now(BEIJING_TZ) - timedelta(days=days)
        result: list[dict[str, Any]] = []
        for record in self._read_records():
            measured_at = self._parse_time(record.get("measured_at") or record.get("recorded_at"))
            weight_kg = self._weight_kg(record.get("weight"), record.get("unit"))
            if measured_at is None or weight_kg is None or measured_at < cutoff:
                continue
            result.append({**record, "measured_at": measured_at.isoformat(timespec="seconds"), "weight_kg": round(weight_kg, 3)})
        return sorted(result, key=lambda item: item["measured_at"])

    def summary(self, days: int = 90) -> dict[str, Any]:
        records = self._records_since(days)
        values = [float(record["weight_kg"]) for record in records]
        if not values:
            return {
                "days": max(1, min(3650, int(days))),
                "count": 0,
                "first_at": None,
                "latest_at": None,
                "first_kg": None,
                "latest_kg": None,
                "min_kg": None,
                "max_kg": None,
                "average_kg": None,
                "change_kg": None,
                "points": [],
            }
        return {
            "days": max(1, min(3650, int(days))),
            "count": len(records),
            "first_at": records[0]["measured_at"],
            "latest_at": records[-1]["measured_at"],
            "first_kg": round(values[0], 3),
            "latest_kg": round(values[-1], 3),
            "min_kg": round(min(values), 3),
            "max_kg": round(max(values), 3),
            "average_kg": round(sum(values) / len(values), 3),
            "change_kg": round(values[-1] - values[0], 3),
            "points": [
                {"measured_at": record["measured_at"], "weight_kg": record["weight_kg"]}
                for record in records[-180:]
            ],
        }

    def export_rows(self, days: int = 3650) -> list[dict[str, Any]]:
        return self._records_since(days)

    def preferences(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "display_unit": "jin",
            "target_weight_kg": None,
            "target_enabled": False,
        }
        try:
            loaded = json.loads(self.preferences_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                result.update(loaded)
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            pass
        if result.get("display_unit") not in DISPLAY_UNITS:
            result["display_unit"] = "jin"
        if result.get("target_weight_kg") is not None:
            try:
                result["target_weight_kg"] = round(float(result["target_weight_kg"]), 3)
            except (TypeError, ValueError):
                result["target_weight_kg"] = None
        result["target_enabled"] = bool(result.get("target_enabled")) and result.get("target_weight_kg") is not None
        return result

    def update_preferences(self, payload: dict[str, Any]) -> dict[str, Any]:
        result = self.preferences()
        if "display_unit" in payload:
            unit = str(payload["display_unit"] or "").lower()
            if unit not in DISPLAY_UNITS:
                raise ValueError("display_unit must be kg, jin, or lb")
            result["display_unit"] = unit
        if "target_weight_kg" in payload:
            raw_target = payload["target_weight_kg"]
            if raw_target in (None, ""):
                result["target_weight_kg"] = None
            else:
                try:
                    target = float(raw_target)
                except (TypeError, ValueError) as exc:
                    raise ValueError("target_weight_kg must be numeric") from exc
                if not 1 <= target <= 500:
                    raise ValueError("target_weight_kg must be between 1 and 500")
                result["target_weight_kg"] = round(target, 3)
        if "target_enabled" in payload:
            result["target_enabled"] = bool(payload["target_enabled"])
        result["target_enabled"] = bool(result["target_enabled"]) and result["target_weight_kg"] is not None
        self.preferences_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.preferences_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(self.preferences_path)
        return result

    async def run_collector(self) -> None:
        if self.poll_seconds <= 0:
            return
        await asyncio.sleep(15)
        while True:
            try:
                await self.status(scan_seconds=self.scan_seconds)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._last_scan_error = str(exc)
            await asyncio.sleep(self.poll_seconds)

    async def status(self, scan_seconds: int = 10) -> dict[str, Any]:
        async with self._scan_lock:
            self._last_scan_at = datetime.now(BEIJING_TZ).isoformat(timespec="seconds")
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
                self._last_scan_error = str(exc)
                return {
                    "configured": True,
                    "mac": self.mac,
                    "service": self.service_uuid,
                    "online": False,
                    "error": str(exc),
                    "collector_enabled": self.poll_seconds > 0,
                    "poll_seconds": self.poll_seconds,
                    "last_scan_at": self._last_scan_at,
                    "last_recorded_at": self._last_recorded_at,
                    "history_count": len(self._read_records()),
                }
        lines = info.splitlines()
        payload = self._hex_after_marker(lines, "ServiceData.0000181d")
        decoded = self._decode(payload)
        rssi = next((line.split(":", 1)[1].strip() for line in lines if "RSSI:" in line), None)
        name = next((line.split(":", 1)[1].strip() for line in lines if line.startswith("Name:")), "MI_SCALE")
        self._last_scan_error = None
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
            "collector_enabled": self.poll_seconds > 0,
            "poll_seconds": self.poll_seconds,
            "last_scan_at": self._last_scan_at,
            "last_recorded_at": self._last_recorded_at,
            "last_scan_error": self._last_scan_error,
            "history_count": len(self._read_records()),
        }


xiaomi_scale = XiaomiScale()
