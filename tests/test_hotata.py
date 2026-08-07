from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.hotata import (
    HotataCommand,
    HotataController,
    HotataLoginRequest,
    HotataSettings,
)


class HotataControllerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.controller = HotataController()
        self.controller.path = Path(self.temporary.name) / "hotata.json"

    async def asyncTearDown(self) -> None:
        await self.controller._cancel_position_task()
        self.temporary.cleanup()

    async def test_login_discovers_device_without_persisting_password(self) -> None:
        replies = [
            {
                "code": "000",
                "data": {
                    "userId": "user-1",
                    "accessToken": "access-1",
                    "refreshToken": "refresh-1",
                    "tokenType": "bearer",
                    "expiresIn": 3600,
                },
            },
            {
                "code": "000",
                "data": [
                    {
                        "iotid": "iot-107",
                        "devicename": "402A8F564528",
                        "deviceNickName": "阳台晾衣机",
                    }
                ],
            },
            {"code": "000", "data": [{"attribute": "MotorControlMode", "value": 0}]},
            {"code": "000", "data": {"onlineStatus": True}},
        ]
        with patch.object(HotataController, "_post", side_effect=replies):
            status = await self.controller.login(
                HotataLoginRequest(username="13800138000", password="secret12")
            )

        stored_text = self.controller.path.read_text(encoding="utf-8")
        stored = json.loads(stored_text)
        self.assertTrue(status["configured"])
        self.assertTrue(status["online"])
        self.assertEqual(stored["device"]["iotid"], "iot-107")
        self.assertNotIn("secret12", stored_text)
        self.assertNotIn("password", stored)

    async def test_stop_uses_motor_mode_zero(self) -> None:
        self.controller._save(
            {
                "user_id": "user-1",
                "access_token": "bearer access-1",
                "refresh_token": "refresh-1",
                "expires_at": 9999999999,
                "device": {"iotid": "iot-107"},
                "simulated_position": 100,
            }
        )
        payloads = []

        def reply(url, payload, token=""):
            payloads.append((url, payload, token))
            if url.endswith("property/get"):
                return {"code": "000", "data": [{"attribute": "MotorControlMode", "value": 0}]}
            if url.endswith("synOnlineStatus"):
                return {"code": "000", "data": {"onlineStatus": True}}
            return {"code": "000", "data": {}}

        with patch.object(HotataController, "_post", side_effect=reply):
            result = await self.controller.command(HotataCommand(action="stop"))

        command = json.loads(payloads[0][1]["paramJson"])
        self.assertEqual(command, {"MotorControlMode": 0})
        self.assertEqual(result["motor_text"], "已停止")

    async def test_best_position_is_disabled_until_calibrated(self) -> None:
        result = await self.controller.update_settings(
            HotataSettings(best_position=55, full_travel_seconds=0)
        )
        self.assertEqual(result["best_position"], 55)
        self.assertEqual(result["full_travel_seconds"], 0)


if __name__ == "__main__":
    unittest.main()
