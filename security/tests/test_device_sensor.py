from __future__ import annotations

from types import SimpleNamespace
import unittest
from unittest.mock import patch

from monarch_security.sensors.devices import DeviceSensor


class DeviceSensorTests(unittest.TestCase):
    @patch("monarch_security.sensors.devices.subprocess.run")
    def test_snapshot_forces_utf8_before_reading_friendly_names(self, run_mock) -> None:
        run_mock.return_value = SimpleNamespace(
            returncode=0,
            stdout=(
                '[{"Class":"HIDClass","FriendlyName":"USB-клавиатура",'
                '"InstanceId":"USB\\\\VID_1234&PID_5678\\\\A","Status":"OK"}]'
            ),
            stderr="",
        )

        devices = DeviceSensor(include_existing=True).snapshot()

        self.assertEqual(devices[0]["friendly_name"], "USB-клавиатура")
        command = run_mock.call_args.args[0]
        self.assertIn("[Console]::OutputEncoding", command[-1])
        self.assertIn("[System.Text.UTF8Encoding]::new($false)", command[-1])
        self.assertEqual(run_mock.call_args.kwargs["encoding"], "utf-8")


if __name__ == "__main__":
    unittest.main()
