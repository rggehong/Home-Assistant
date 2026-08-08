import unittest

from app.main import (
    LOWER_OUTLET_FORCED,
    LOWER_OUTLET_OFF,
    _lower_outlet_command_value,
    _lower_outlet_enabled,
)


class LowerOutletTests(unittest.TestCase):
    def test_only_forced_mode_is_enabled(self):
        self.assertTrue(_lower_outlet_enabled(LOWER_OUTLET_FORCED))
        self.assertTrue(_lower_outlet_enabled("2"))
        self.assertFalse(_lower_outlet_enabled(1))
        self.assertFalse(_lower_outlet_enabled(LOWER_OUTLET_OFF))
        self.assertFalse(_lower_outlet_enabled(None))

    def test_command_values_match_living_room_protocol(self):
        self.assertEqual(_lower_outlet_command_value(True), 2)
        self.assertEqual(_lower_outlet_command_value(False), 0)
