from __future__ import annotations

import asyncio
import binascii
import os
import random
import socket
import time
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, Field


OPPLE_IP = os.getenv("OPPLE_LIGHT_IP", "192.168.0.139")
OPPLE_DISCOVERY_PORT = 0xD6D9
BODY_OFFSET = 0x7C

MESSAGE_SEARCH = 0x02010000
MESSAGE_QUERY = 0x030F0000
MESSAGE_POWER = 0x03110000
MESSAGE_BRIGHTNESS = 0x03130000
MESSAGE_COLOR_TEMPERATURE = 0x031B0000


class OppleError(RuntimeError):
    pass


class OppleCommand(BaseModel):
    power: bool | None = None
    brightness: int | None = Field(default=None, ge=4, le=100)
    color_temperature: int | None = Field(default=None, ge=2700, le=6500)


@dataclass(frozen=True)
class OppleDevice:
    ip: str
    port: int
    device_id: int
    mac: bytes
    name: str
    version: int
    class_sku: int


def _put(packet: bytearray, offset: int, value: int, length: int = 4) -> None:
    packet[offset : offset + length] = value.to_bytes(length, "big")


def _build_message(
    message_type: int,
    *,
    body: bytes = b"",
    device: OppleDevice | None = None,
    local_port: int = 0,
) -> tuple[bytes, int]:
    packet = bytearray(BODY_OFFSET) + bytearray(body)
    request_serial = random.randint(1, 0x7FFFFFFF)
    _put(packet, 0x10, 0x03F2)
    _put(packet, 0x14, 0x2775)
    _put(packet, 0x20, 0x0001)
    _put(packet, 0x24, 0x0002)
    _put(packet, 0x28, 0x0003)
    _put(packet, 0x30, 0x0005)
    _put(packet, 0x3C, 0x6A68)
    _put(packet, 0x50, 0x0001)
    _put(packet, 0x64, request_serial)
    _put(packet, 0x74, message_type)
    _put(packet, 0x1C, len(body) + 0x68)
    _put(packet, 0x6C, len(body) + 0x18)
    if device is not None:
        _put(packet, 0x0C, local_port)
        _put(packet, 0x54, device.device_id)
    _put(packet, 0x70, binascii.crc_hqx(bytes(packet[0x64:]), 0))
    if device is not None and body:
        for index in range(len(body)):
            packet[BODY_OFFSET + index] ^= device.mac[index % len(device.mac)]
    return bytes(packet), request_serial


def _receive_matching(
    sock: socket.socket,
    request_serial: int,
    device: OppleDevice | None = None,
) -> bytes:
    while True:
        try:
            packet, address = sock.recvfrom(2048)
        except socket.timeout as exc:
            raise OppleError("欧普灯具暂时没有响应") from exc
        if address[0] != OPPLE_IP or len(packet) < BODY_OFFSET:
            continue
        response_serial = int.from_bytes(packet[0x68:0x6C], "big")
        if response_serial != request_serial:
            continue
        if device is None:
            return packet
        decrypted = bytearray(packet)
        for index in range(len(packet) - BODY_OFFSET):
            decrypted[BODY_OFFSET + index] ^= device.mac[index % len(device.mac)]
        return bytes(decrypted)


class OppleController:
    def __init__(self) -> None:
        self.lock = asyncio.Lock()

    @staticmethod
    def _discover(sock: socket.socket) -> OppleDevice:
        packet, serial = _build_message(MESSAGE_SEARCH)
        sock.sendto(packet, (OPPLE_IP, OPPLE_DISCOVERY_PORT))
        reply = _receive_matching(sock, serial)
        body = reply[BODY_OFFSET:]
        if len(body) < 0x34:
            raise OppleError("欧普灯具返回了无法识别的发现数据")
        embedded_ip = ".".join(str(value) for value in body[0x1F:0x23])
        if embedded_ip != OPPLE_IP:
            raise OppleError("欧普灯具返回的地址与配置不一致")
        return OppleDevice(
            ip=embedded_ip,
            port=int.from_bytes(body[0x23:0x25], "big"),
            device_id=int.from_bytes(body[0x13:0x17], "big"),
            mac=bytes(body[0x09:0x0F]),
            name=body[0x25:0x33].rstrip(b"@\x00").decode("gbk", "replace"),
            version=int.from_bytes(body[0x1B:0x1F], "big"),
            class_sku=int.from_bytes(body[0x03:0x07], "big"),
        )

    @staticmethod
    def _query(sock: socket.socket, device: OppleDevice) -> dict[str, Any]:
        packet, serial = _build_message(
            MESSAGE_QUERY,
            device=device,
            local_port=sock.getsockname()[1],
        )
        sock.sendto(packet, (device.ip, device.port))
        reply = _receive_matching(sock, serial, device)
        body = reply[BODY_OFFSET:]
        if len(body) < 9:
            raise OppleError("欧普灯具返回了无法识别的状态数据")
        brightness_raw = body[2]
        return {
            "configured": True,
            "online": True,
            "ip": device.ip,
            "name": "欧普智能灯",
            "device_name": device.name,
            "model": f"0x{device.class_sku:08x}",
            "firmware": device.version,
            "mac": ":".join(f"{value:02x}" for value in device.mac),
            "capabilities": ["power", "brightness", "color_temperature"],
            "power": bool(body[1]),
            "brightness": round(brightness_raw * 100 / 255),
            "brightness_raw": brightness_raw,
            "color_temperature": int.from_bytes(body[7:9], "big"),
        }

    @staticmethod
    def _send_value(
        sock: socket.socket,
        device: OppleDevice,
        message_type: int,
        value: bytes,
    ) -> None:
        packet, _ = _build_message(
            message_type,
            body=value,
            device=device,
            local_port=sock.getsockname()[1],
        )
        sock.sendto(packet, (device.ip, device.port))

    def _status(self) -> dict[str, Any]:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.bind(("0.0.0.0", 0))
            sock.settimeout(2.5)
            device = self._discover(sock)
            return self._query(sock, device)

    def _command(self, payload: OppleCommand) -> dict[str, Any]:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.bind(("0.0.0.0", 0))
            sock.settimeout(2.5)
            device = self._discover(sock)
            current = self._query(sock, device)
            if payload.power is not None and payload.power != current["power"]:
                self._send_value(
                    sock,
                    device,
                    MESSAGE_POWER,
                    bytes((1 if payload.power else 0,)),
                )
            if (
                payload.brightness is not None
                and payload.brightness != current["brightness"]
            ):
                raw_brightness = max(
                    10,
                    min(255, round(payload.brightness * 255 / 100)),
                )
                self._send_value(
                    sock,
                    device,
                    MESSAGE_BRIGHTNESS,
                    bytes((raw_brightness,)),
                )
            if (
                payload.color_temperature is not None
                and payload.color_temperature != current["color_temperature"]
            ):
                self._send_value(
                    sock,
                    device,
                    MESSAGE_COLOR_TEMPERATURE,
                    payload.color_temperature.to_bytes(2, "big"),
                )
            if any(
                value is not None
                for value in (
                    payload.power,
                    payload.brightness,
                    payload.color_temperature,
                )
            ):
                # The device applies UDP writes immediately but needs a short moment
                # before a subsequent query reflects the new state.
                time.sleep(0.18)
            return self._query(sock, device)

    async def status(self) -> dict[str, Any]:
        async with self.lock:
            try:
                return await asyncio.to_thread(self._status)
            except OppleError as exc:
                return {
                    "configured": True,
                    "online": False,
                    "ip": OPPLE_IP,
                    "name": "欧普智能灯",
                    "capabilities": ["power", "brightness", "color_temperature"],
                    "power": None,
                    "brightness": None,
                    "color_temperature": None,
                    "error": str(exc),
                }

    async def command(self, payload: OppleCommand) -> dict[str, Any]:
        async with self.lock:
            return await asyncio.to_thread(self._command, payload)


opple_light = OppleController()
