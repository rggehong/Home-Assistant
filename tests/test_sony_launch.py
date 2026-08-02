from __future__ import annotations

import unittest
from unittest.mock import AsyncMock

from app.sony import SonyTV


class SonyLaunchAppTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.tv = SonyTV()
        self.tv._launch_app_sync = lambda app_id, endpoint=None: {
            "id": app_id,
            "name": "bilibili",
            "package": "com.xiaodianshi.tv.yst",
        }
        self.tv.foreground_app = AsyncMock(
            return_value={
                "available": True,
                "name": "bilibili",
                "package": "com.xiaodianshi.tv.yst",
                "activity": "MainActivity",
            }
        )
        self.tv._wait_for_adb_ready = AsyncMock(return_value="tv-endpoint")
        self.tv.set_power_verified = AsyncMock(return_value={"power": True})

    async def test_standby_tv_is_powered_on_before_launch(self) -> None:
        self.tv.status = AsyncMock(return_value={"online": True, "power": False})

        result = await self.tv.launch_app("bilibili")

        self.tv.set_power_verified.assert_awaited_once_with(True, attempts=5)
        self.tv._wait_for_adb_ready.assert_awaited_once_with(60)
        self.assertTrue(result["powered_on"])
        self.assertEqual(result["foreground"]["package"], "com.xiaodianshi.tv.yst")

    async def test_active_tv_launches_without_power_command(self) -> None:
        self.tv.status = AsyncMock(return_value={"online": True, "power": True})

        result = await self.tv.launch_app("bilibili")

        self.tv.set_power_verified.assert_not_awaited()
        self.tv._wait_for_adb_ready.assert_awaited_once_with(15)
        self.assertFalse(result["powered_on"])


if __name__ == "__main__":
    unittest.main()
