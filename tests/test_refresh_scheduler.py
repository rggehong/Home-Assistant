import asyncio
import unittest
from unittest.mock import AsyncMock, Mock, patch

from app import main


class RefreshTests(unittest.IsolatedAsyncioTestCase):
    async def test_devices_refresh_concurrently_and_failure_is_isolated(self):
        registry = main.Registry()
        registry.devices = {name: name for name in ("a", "b", "c")}
        started = set()
        all_started = asyncio.Event()

        async def update(device):
            started.add(device)
            if len(started) == 3:
                all_started.set()
            await asyncio.wait_for(all_started.wait(), 0.5)
            if device == "b":
                raise RuntimeError("offline")

        with patch.object(main, "_update_device_state", update), \
             patch.object(main, "_serialize", lambda device: {"id": device}), \
             patch.object(main, "_sort_devices", lambda values: values):
            result = await registry.refresh()
        self.assertEqual([r["id"] for r in result], ["a", "b", "c"])
        self.assertNotIn("error", result[0])
        self.assertEqual(result[1]["error"], "offline")
        self.assertNotIn("error", result[2])

    async def test_missing_single_device_remains_an_error(self):
        with self.assertRaises(KeyError):
            await main.Registry().refresh("missing")


class SchedulerTests(unittest.IsolatedAsyncioTestCase):
    def make_store(self):
        store = main.ScheduleStore.__new__(main.ScheduleStore)
        store.items = {}
        store.save = Mock()
        return store

    def item(self, name):
        return {"id": name, "device_id": name, "status": "pending",
                "run_at": "2020-01-01T00:00:00+00:00", "action": "off"}

    async def test_cancel_during_previous_command_skips_stale_item(self):
        store = self.make_store()
        store.items = {name: self.item(name) for name in ("first", "cancelled")}

        async def command(*args):
            store.items.pop("cancelled")

        command_mock = AsyncMock(side_effect=command)
        with patch.object(main.registry, "command", command_mock), \
             patch.object(main.asyncio, "sleep", AsyncMock(side_effect=asyncio.CancelledError)):
            with self.assertRaises(asyncio.CancelledError):
                await store.run()
        self.assertEqual(command_mock.await_count, 1)
        self.assertEqual(store.items["first"]["status"], "executed")

    async def test_invalid_date_does_not_stop_other_schedules(self):
        store = self.make_store()
        store.items = {name: self.item(name) for name in ("invalid", "valid")}
        store.items["invalid"]["run_at"] = "broken"
        command_mock = AsyncMock()
        with patch.object(main.registry, "command", command_mock), \
             patch.object(main.asyncio, "sleep", AsyncMock(side_effect=asyncio.CancelledError)):
            with self.assertRaises(asyncio.CancelledError):
                await store.run()
        self.assertEqual(store.items["invalid"]["status"], "failed")
        self.assertEqual(store.items["valid"]["status"], "executed")
        command_mock.assert_awaited_once()
