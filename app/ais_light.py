from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import secrets
import subprocess
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, Field


logger = logging.getLogger("gree_home.ais_light")


class AisLightError(RuntimeError):
    pass


class AisLightCommand(BaseModel):
    power: bool | None = None
    brightness: int | None = Field(default=None, ge=1, le=100)
    color_temperature: int | None = Field(default=None, ge=0, le=100)


@dataclass(frozen=True)
class AisPaths:
    device: str
    read: str
    write: str
    indicate: str
    write_no_response: str
    notify: str


class AisLight:
    """Small BlueZ/DBus bridge for an Alibaba AIS GATT lamp.

    The bridge deliberately uses the system BlueZ tools instead of a Python BLE
    dependency, so it can run in the existing server venv.  AIS app-layer
    binding is separate from Bluetooth pairing; ``bind`` implements CMD 0x10-
    0x15 and reports when the cloud-issued PID/Secret are unavailable.
    """

    def __init__(self) -> None:
        self.mac = os.getenv("AIS_LIGHT_MAC", "68:79:C4:E7:DA:FF").upper()
        self.alias = os.getenv("AIS_LIGHT_ALIAS", "天猫精灵灯")
        self._tid = 0
        self._msg_id = 0

    @property
    def _mac_path(self) -> str:
        return self.mac.replace(":", "_")

    @property
    def paths(self) -> AisPaths:
        base = f"/org/bluez/hci0/dev_{self._mac_path}/service000a"
        return AisPaths(
            device=f"/org/bluez/hci0/dev_{self._mac_path}",
            read=f"{base}/char000b",
            write=f"{base}/char000d",
            indicate=f"{base}/char000f",
            write_no_response=f"{base}/char0012",
            notify=f"{base}/char0014",
        )

    @staticmethod
    def _run(*args: str, timeout: float = 8) -> str:
        try:
            completed = subprocess.run(
                list(args),
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise AisLightError(f"运行 {args[0]} 失败: {exc}") from exc
        output = (completed.stdout or "") + (completed.stderr or "")
        if completed.returncode != 0:
            raise AisLightError(output.strip() or f"{args[0]} 返回 {completed.returncode}")
        return output

    async def _run_async(self, *args: str, timeout: float = 8) -> str:
        return await asyncio.to_thread(self._run, *args, timeout=timeout)

    async def _ensure_connected(self) -> None:
        try:
            info = await self._run_async("bluetoothctl", "info", self.mac)
        except AisLightError:
            info = ""
        if "Connected: yes" not in info:
            # A device object is created only while it is visible to BlueZ.
            await self._run_async("bluetoothctl", "--timeout", "8", "scan", "on", timeout=12)
        last = ""
        for _ in range(6):
            try:
                result = await self._run_async("bluetoothctl", "connect", self.mac, timeout=10)
                last = result
                if "Connection successful" in result:
                    break
            except AisLightError as exc:
                last = str(exc)
            await asyncio.sleep(0.8)
        else:
            raise AisLightError(f"无法连接 {self.mac}: {last[-240:]}")

        # BlueZ discovers GATT objects asynchronously after Connect().
        for _ in range(12):
            try:
                out = await self._run_async(
                    "busctl",
                    "introspect",
                    "org.bluez",
                    self.paths.write,
                    "org.bluez.GattCharacteristic1",
                )
                if "WriteValue" in out:
                    return
            except AisLightError:
                pass
            await asyncio.sleep(0.5)
        raise AisLightError("BlueZ 尚未完成 AIS GATT 服务发现")

    @staticmethod
    def _busctl_write(path: str, data: bytes, *, timeout: float = 8) -> None:
        args = [
            "busctl",
            f"--timeout={int(timeout)}s",
            "call",
            "org.bluez",
            path,
            "org.bluez.GattCharacteristic1",
            "WriteValue",
            "aya{sv}",
            str(len(data)),
            *(str(value) for value in data),
            "0",
        ]
        AisLight._run(*args, timeout=timeout + 2)

    async def _write(self, path: str, data: bytes) -> None:
        await asyncio.to_thread(self._busctl_write, path, data)

    async def _start_indications(self) -> None:
        await self._run_async(
            "gdbus",
            "call",
            "--system",
            "--timeout",
            "5",
            "--dest",
            "org.bluez",
            "--object-path",
            self.paths.indicate,
            "--method",
            "org.bluez.GattCharacteristic1.StartNotify",
        )

    async def _read_value(self, path: str) -> bytes:
        out = await self._run_async(
            "busctl",
            f"--timeout=5s",
            "call",
            "org.bluez",
            path,
            "org.bluez.GattCharacteristic1",
            "ReadValue",
            "a{sv}",
            "0",
        )
        # busctl returns: ``ay <n> <decimal bytes...>``.
        tokens = out.split()
        try:
            start = tokens.index("ay") + 1
            count = int(tokens[start])
            return bytes(int(value) for value in tokens[start + 1 : start + 1 + count])
        except (ValueError, IndexError) as exc:
            raise AisLightError(f"无法解析 AIS 特征读取结果: {out}") from exc

    def _next_tid(self) -> int:
        self._tid = (self._tid % 255) + 1
        return self._tid

    def _next_msg_id(self) -> int:
        self._msg_id = (self._msg_id % 15) + 1
        return self._msg_id

    def _vendor_command(self, opcode: int, attr: int, value: bytes, *, ack: bool = True) -> bytes:
        tid = self._next_tid()
        # This lamp's vendor payload retains the Alibaba CID (0x01A8) after
        # the one-byte vendor opcode: opcode, CID little-endian, TID, attr.
        payload = bytes(
            (opcode, 0xA8, 0x01, tid, attr & 0xFF, (attr >> 8) & 0xFF)
        ) + value
        # AIS header: MsgID, CmdType (0x06 = command/no response), frame, length.
        return bytes((self._next_msg_id(), 0x06, 0x00, len(payload))) + payload

    async def status(self) -> dict[str, Any]:
        try:
            info = await self._run_async("bluetoothctl", "info", self.mac)
        except AisLightError as exc:
            return {
                "configured": True,
                "device": self.mac,
                "alias": self.alias,
                "connected": False,
                "paired": False,
                "error": str(exc),
            }
        return {
            "configured": True,
            "device": self.mac,
            "alias": self.alias,
            "service": "0000feb3-0000-1000-8000-00805f9b34fb",
            "connected": "Connected: yes" in info,
            "paired": "Paired: yes" in info,
            "bonded": "Bonded: yes" in info,
            "trusted": "Trusted: yes" in info,
            "manufacturer_data": self._manufacturer_data(info),
            "binding": "ais_app_layer",
        }

    @staticmethod
    def _manufacturer_data(info: str) -> str | None:
        lines = info.splitlines()
        for index, line in enumerate(lines):
            if "ManufacturerData.Value:" in line:
                return " ".join(item.strip() for item in lines[index + 1 : index + 4]).strip() or None
        return None

    async def command(self, payload: AisLightCommand) -> dict[str, Any]:
        if payload.power is None and payload.brightness is None and payload.color_temperature is None:
            raise AisLightError("至少提供 power、brightness 或 color_temperature")
        await self._ensure_connected()
        sent: list[str] = []
        if payload.power is not None:
            frame = self._vendor_command(0xD1, 0x0100, bytes((1 if payload.power else 0,)))
            await self._write(self.paths.write_no_response, frame)
            sent.append("power")
        if payload.brightness is not None:
            frame = self._vendor_command(0xD1, 0x0121, bytes((payload.brightness,)))
            await self._write(self.paths.write_no_response, frame)
            sent.append("brightness")
        if payload.color_temperature is not None:
            frame = self._vendor_command(0xD1, 0x0122, bytes((payload.color_temperature,)))
            await self._write(self.paths.write_no_response, frame)
            sent.append("color_temperature")
        return {
            "ok": False,
            "state": "gatt_write_accepted_no_device_ack",
            "device": self.mac,
            "sent": sent,
            "protocol": "AIS/FEB3",
            "note": "BlueZ 已接受写入，但设备未返回状态确认；不能据此断言灯具已执行。",
        }

    async def bind(self) -> dict[str, Any]:
        """Run the AIS CMD 0x10-0x15 app-layer binding sequence.

        A secure device needs the cloud-issued PID and Secret.  They are never
        transmitted over BLE, so without them this method intentionally stops
        after CMD 0x10 and reports the exact missing prerequisite.
        """
        await self._ensure_connected()
        try:
            await self._start_indications()
        except AisLightError as exc:
            raise AisLightError(f"无法订阅 AIS FED6 指示: {exc}") from exc

        random_text = secrets.token_hex(8)
        random_bytes = random_text.encode("ascii")
        # Connection-establishment commands are the raw 0x10..0x15 format on FED5.
        await self._write(self.paths.write, bytes((0x10, 0x00, 0x10)) + random_bytes)
        await asyncio.sleep(0.8)
        cipher = b""
        try:
            cipher = await self._read_value(self.paths.indicate)
        except AisLightError:
            pass
        cipher_payload = self._bind_payload(cipher, 0x11)
        pid = os.getenv("AIS_LIGHT_PID", "").strip()
        secret = os.getenv("AIS_LIGHT_SECRET", "").strip()
        if not pid or not secret:
            return {
                "ok": False,
                "state": "credentials_required",
                "device": self.mac,
                "random": random_text,
                "cipher_received": len(cipher),
                "next": "设置 AIS_LIGHT_PID 与 AIS_LIGHT_SECRET 后重试",
                "note": "这是 AIS 应用层绑定，不是 bluetoothctl pair；Secret 不能从空中读取。",
            }

        # Keep the cryptographic derivation explicit.  AES-CBC verification is
        # delegated to the system OpenSSL binary when credentials are supplied.
        pid_text = f"{int(pid):08x}"
        key_material = f"{random_text},{pid_text},{self.mac.replace(':', '').lower()},{secret}"
        ble_key = hashlib.sha256(key_material.encode("utf-8")).digest()[:16]
        expected = await asyncio.to_thread(self._aes_cbc, ble_key, random_bytes)
        verified = bool(cipher_payload and cipher_payload[:16] == expected[:16])
        await self._write(self.paths.write, bytes((0x12, 0x00, 0x01, 0x00 if verified else 0x01)))
        await asyncio.sleep(0.4)
        key_result = b""
        try:
            key_result = await self._read_value(self.paths.indicate)
        except AisLightError:
            pass
        key_payload = self._bind_payload(key_result, 0x13)
        if not verified or key_payload != b"\x00":
            return {
                "ok": False,
                "state": "authentication_failed",
                "device": self.mac,
                "random": random_text,
                "cipher_received": len(cipher_payload),
                "device_response": key_result.hex(),
            }
        await self._write(self.paths.write, bytes((0x14, 0x00, 0x01, 0x01)))
        await asyncio.sleep(0.4)
        bind_result = b""
        try:
            bind_result = await self._read_value(self.paths.indicate)
        except AisLightError:
            pass
        bind_payload = self._bind_payload(bind_result, 0x15)
        return {
            "ok": bind_payload == b"\x01",
            "state": "bound" if bind_payload == b"\x01" else "binding_ack_missing",
            "device": self.mac,
            "random": random_text,
            "cipher_received": len(cipher),
            "device_response": bind_result.hex(),
        }

    @staticmethod
    def _aes_cbc(key: bytes, value: bytes) -> bytes:
        try:
            result = subprocess.run(
                [
                    "openssl",
                    "enc",
                    "-aes-128-cbc",
                    "-K",
                    key.hex(),
                    "-iv",
                    "0" * 32,
                    "-nopad",
                ],
                input=value,
                capture_output=True,
                check=True,
                timeout=5,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise AisLightError(f"AES-128-CBC 校验失败: {exc}") from exc
        return result.stdout

    @staticmethod
    def _bind_payload(value: bytes, command: int) -> bytes:
        if len(value) >= 3 and value[0] == command:
            length = value[2]
            return value[3 : 3 + length]
        return value


ais_light = AisLight()
