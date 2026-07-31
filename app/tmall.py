from __future__ import annotations

import asyncio
from typing import Any


TMALL_DEVICES = (
    {"id": "tmall-genie-113", "name": "天猫精灵 1", "ip": "192.168.0.113"},
    {"id": "tmall-genie-135", "name": "天猫精灵 2", "ip": "192.168.0.135"},
)


async def _reachable(ip: str) -> bool:
    try:
        process = await asyncio.create_subprocess_exec(
            "ping",
            "-c",
            "1",
            "-W",
            "1",
            ip,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        return await process.wait() == 0
    except (OSError, asyncio.TimeoutError):
        return False


async def tmall_status() -> dict[str, Any]:
    online = await asyncio.gather(*(_reachable(item["ip"]) for item in TMALL_DEVICES))
    devices = [
        {
            **item,
            "online": is_online,
            "control_supported": False,
            "integration": "cloud_required",
        }
        for item, is_online in zip(TMALL_DEVICES, online)
    ]
    return {
        "devices": devices,
        "online_count": sum(1 for item in devices if item["online"]),
        "control_supported": False,
        "notice": "设备已纳入在线监测；天猫精灵未开放家庭账号的局域网控制接口，语音与播放控制仍需天猫精灵 App 或阿里云开发者授权。",
    }
