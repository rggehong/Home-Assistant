from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import os
import secrets
import time
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import quote, urlsplit, urlunsplit


@dataclass(frozen=True)
class CameraConfig:
    camera_id: str
    name: str
    ip: str
    password: str
    control_port: int = 554
    protocol: str = "rtsp"
    stream_path: str = "/ch1/sub"


def _camera_config() -> tuple[CameraConfig, ...]:
    """Parse runtime configuration without exposing passwords in API output."""
    cameras: list[CameraConfig] = []
    for item in os.getenv("EZVIZ_CAMERAS", "").split(";"):
        parts = [value.strip() for value in item.split("|")]
        if len(parts) < 4 or not all(parts[:4]):
            continue
        try:
            control_port = int(parts[4]) if len(parts) >= 5 and parts[4] else 554
        except ValueError:
            control_port = 554
        protocol = parts[5].lower() if len(parts) >= 6 and parts[5] else "rtsp"
        stream_path = parts[6] if len(parts) >= 7 and parts[6] else "/ch1/sub"
        if not stream_path.startswith("/"):
            stream_path = f"/{stream_path}"
        cameras.append(
            CameraConfig(
                camera_id=parts[0],
                name=parts[1],
                ip=parts[2],
                password=parts[3],
                control_port=control_port,
                protocol=protocol,
                stream_path=stream_path,
            )
        )
    return tuple(cameras)


class EzvizService:
    def __init__(self) -> None:
        self.timeout = float(os.getenv("EZVIZ_LOCAL_TIMEOUT", "2.5"))
        self.snapshot_ttl = float(os.getenv("EZVIZ_SNAPSHOT_TTL", "10"))
        self._snapshot_cache: dict[str, tuple[float, bytes]] = {}
        self._snapshot_locks: dict[str, asyncio.Lock] = {}
        self._stream_cache: dict[str, tuple[float, str]] = {}

    @property
    def cameras(self) -> tuple[CameraConfig, ...]:
        return _camera_config()

    async def _port_open(self, ip: str, port: int) -> bool:
        try:
            _, writer = await asyncio.wait_for(
                asyncio.open_connection(ip, port), timeout=self.timeout
            )
        except (OSError, asyncio.TimeoutError):
            return False
        writer.close()
        await writer.wait_closed()
        return True

    async def _camera_status(self, camera: CameraConfig) -> dict[str, object]:
        ports = sorted({camera.control_port, 554, 8000})
        checks = await asyncio.gather(*(self._port_open(camera.ip, port) for port in ports))
        open_ports = {port for port, opened in zip(ports, checks) if opened}
        services: list[dict[str, object]] = []
        if 554 in open_ports:
            services.append({"name": "RTSP", "port": 554})
        if 8000 in open_ports:
            services.append({"name": "Hikvision SDK", "port": 8000})
        if camera.protocol == "onvif" and camera.control_port in open_ports:
            services.append({"name": "ONVIF", "port": camera.control_port})
        online = camera.control_port in open_ports
        return {
            "id": camera.camera_id,
            "name": camera.name,
            "ip": camera.ip,
            "port": camera.control_port,
            "protocol": camera.protocol.upper(),
            "online": online,
            "services": services,
            "stream_path": "ONVIF auto" if camera.protocol == "onvif" else camera.stream_path,
            "snapshot_url": f"/api/ezviz/{camera.camera_id}/snapshot",
            "live_url": f"/api/ezviz/{camera.camera_id}/live.mjpeg",
        }

    async def status(self) -> dict[str, object]:
        cameras = self.cameras
        return {
            "configured": bool(cameras),
            "cameras": await asyncio.gather(*(self._camera_status(camera) for camera in cameras)),
        }

    async def start(self) -> None:
        return

    async def stop(self) -> None:
        return

    async def mjpeg_stream(self, camera_id: str):
        camera = self._get_camera(camera_id)
        if not await self._port_open(camera.ip, camera.control_port):
            raise RuntimeError("camera is offline")
        uri = await self._stream_uri(camera)
        process = await asyncio.create_subprocess_exec(
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-rtsp_transport", "tcp", "-i", uri,
            "-an", "-vf", "fps=5,scale='min(960,iw)':-2",
            "-q:v", "5", "-f", "mpjpeg", "-boundary_tag", "camera",
            "pipe:1",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            assert process.stdout is not None
            while chunk := await process.stdout.read(128 * 1024):
                yield chunk
        finally:
            if process.returncode is None:
                process.terminate()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(process.wait(), timeout=5)

    def _get_camera(self, camera_id: str) -> CameraConfig:
        for camera in self.cameras:
            if camera.camera_id == camera_id:
                return camera
        raise KeyError(camera_id)

    @staticmethod
    def _wsse_header(camera: CameraConfig) -> str:
        nonce = secrets.token_bytes(16)
        created = (
            datetime.now(timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z")
        )
        digest = base64.b64encode(
            hashlib.sha1(nonce + created.encode() + camera.password.encode()).digest()
        ).decode()
        nonce_text = base64.b64encode(nonce).decode()
        return (
            '<wsse:Security soap:mustUnderstand="1"><wsse:UsernameToken>'
            '<wsse:Username>admin</wsse:Username>'
            f'<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">{digest}</wsse:Password>'
            f'<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">{nonce_text}</wsse:Nonce>'
            f'<wsu:Created>{created}</wsu:Created>'
            "</wsse:UsernameToken></wsse:Security>"
        )

    def _soap_envelope(self, camera: CameraConfig, body: str) -> bytes:
        return (
            '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" '
            'xmlns:tds="http://www.onvif.org/ver10/device/wsdl" '
            'xmlns:trt="http://www.onvif.org/ver10/media/wsdl" '
            'xmlns:tt="http://www.onvif.org/ver10/schema" '
            'xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" '
            'xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">'
            f"<soap:Header>{self._wsse_header(camera)}</soap:Header>"
            f"<soap:Body>{body}</soap:Body></soap:Envelope>"
        ).encode()

    def _soap_post(
        self, camera: CameraConfig, url: str, action: str, body: str
    ) -> bytes:
        password_manager = urllib.request.HTTPPasswordMgrWithDefaultRealm()
        password_manager.add_password(None, url, "admin", camera.password)
        opener = urllib.request.build_opener(
            urllib.request.HTTPDigestAuthHandler(password_manager),
            urllib.request.HTTPBasicAuthHandler(password_manager),
        )
        request = urllib.request.Request(
            url,
            data=self._soap_envelope(camera, body),
            headers={
                "Content-Type": f'application/soap+xml; charset=utf-8; action="{action}"'
            },
            method="POST",
        )
        with opener.open(request, timeout=self.timeout + 2) as response:
            return response.read()

    async def _onvif_stream_uri(self, camera: CameraConfig) -> str:
        cached = self._stream_cache.get(camera.camera_id)
        if cached and time.monotonic() - cached[0] < 3600:
            return cached[1]
        device_url = f"http://{camera.ip}:{camera.control_port}/onvif/device_service"
        capabilities_xml = await asyncio.to_thread(
            self._soap_post,
            camera,
            device_url,
            "http://www.onvif.org/ver10/device/wsdl/GetCapabilities",
            "<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>",
        )
        root = ET.fromstring(capabilities_xml)
        media_url = next(
            (node.text.strip() for node in root.findall(".//{*}Media/{*}XAddr") if node.text),
            "",
        )
        if not media_url:
            raise RuntimeError("ONVIF media service was not advertised")
        profiles_xml = await asyncio.to_thread(
            self._soap_post,
            camera,
            media_url,
            "http://www.onvif.org/ver10/media/wsdl/GetProfiles",
            "<trt:GetProfiles/>",
        )
        profiles = ET.fromstring(profiles_xml).findall(".//{*}Profiles")
        if not profiles:
            raise RuntimeError("ONVIF media profile was not returned")

        def profile_pixels(profile: ET.Element) -> int:
            width = profile.findtext(".//{*}Resolution/{*}Width")
            height = profile.findtext(".//{*}Resolution/{*}Height")
            try:
                return int(width or 0) * int(height or 0)
            except ValueError:
                return 0

        profiles_with_size = [profile for profile in profiles if profile_pixels(profile) > 0]
        profile = min(profiles_with_size, key=profile_pixels) if profiles_with_size else profiles[-1]
        token = profile.attrib.get("token")
        if not token:
            raise RuntimeError("ONVIF media profile has no token")
        stream_body = (
            "<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream>"
            "<tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport>"
            f"</trt:StreamSetup><trt:ProfileToken>{token}</trt:ProfileToken></trt:GetStreamUri>"
        )
        stream_xml = await asyncio.to_thread(
            self._soap_post,
            camera,
            media_url,
            "http://www.onvif.org/ver10/media/wsdl/GetStreamUri",
            stream_body,
        )
        uri = next(
            (
                node.text.strip()
                for node in ET.fromstring(stream_xml).findall(".//{*}Uri")
                if node.text
            ),
            "",
        )
        if not uri:
            raise RuntimeError("ONVIF stream URI was not returned")
        parsed = urlsplit(uri)
        if not parsed.hostname:
            raise RuntimeError("ONVIF returned an invalid stream URI")
        authenticated = urlunsplit(
            (
                parsed.scheme or "rtsp",
                f"admin:{quote(camera.password, safe='')}@{parsed.hostname}:{parsed.port or 554}",
                parsed.path,
                parsed.query,
                parsed.fragment,
            )
        )
        self._stream_cache[camera.camera_id] = (time.monotonic(), authenticated)
        return authenticated

    async def _stream_uri(self, camera: CameraConfig) -> str:
        if camera.protocol == "onvif":
            return await self._onvif_stream_uri(camera)
        return (
            f"rtsp://admin:{quote(camera.password, safe='')}@"
            f"{camera.ip}:554{camera.stream_path}"
        )

    async def snapshot(self, camera_id: str) -> bytes:
        camera = self._get_camera(camera_id)
        cached = self._snapshot_cache.get(camera_id)
        if cached and time.monotonic() - cached[0] < self.snapshot_ttl:
            return cached[1]
        lock = self._snapshot_locks.setdefault(camera_id, asyncio.Lock())
        async with lock:
            cached = self._snapshot_cache.get(camera_id)
            if cached and time.monotonic() - cached[0] < self.snapshot_ttl:
                return cached[1]
            if not await self._port_open(camera.ip, camera.control_port):
                raise RuntimeError("camera is offline")
            url = await self._stream_uri(camera)
            process = await asyncio.create_subprocess_exec(
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-rtsp_transport",
                "tcp",
                "-i",
                url,
                "-frames:v",
                "1",
                "-f",
                "image2",
                "-vcodec",
                "mjpeg",
                "pipe:1",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=15)
            except asyncio.TimeoutError:
                process.kill()
                await process.communicate()
                raise RuntimeError("camera snapshot timed out") from None
            if process.returncode != 0 or not stdout:
                detail = stderr.decode("utf-8", errors="replace")[-160:]
                raise RuntimeError(f"camera snapshot failed: {detail}")
            self._snapshot_cache[camera_id] = (time.monotonic(), stdout)
            return stdout


ezviz = EzvizService()
