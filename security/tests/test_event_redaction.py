from __future__ import annotations

import unittest

from monarch_security.events import SecurityEvent


class SecurityEventRedactionTests(unittest.TestCase):
    def test_process_serialization_does_not_expose_raw_command_or_username(self) -> None:
        event = SecurityEvent(
            kind="process.started",
            source="test",
            subject="powershell.exe",
            facts={
                "pid": 42,
                "name": "powershell.exe",
                "username": r"EXAMPLE\user",
                "cmdline": [
                    "powershell.exe",
                    "-NoProfile",
                    "-EncodedCommand",
                    "private-value",
                ],
            },
        )

        serialized = event.to_dict()["facts"]

        self.assertNotIn("cmdline", serialized)
        self.assertNotIn("username", serialized)
        self.assertNotIn("private-value", str(serialized))
        self.assertTrue(serialized["command_line"]["present"])
        self.assertTrue(serialized["command_line"]["encoded"])
        self.assertEqual(serialized["command_line"]["argument_count"], 4)
        self.assertEqual(len(serialized["command_line"]["sha256"]), 64)
        self.assertTrue(serialized["user_context_present"])


if __name__ == "__main__":
    unittest.main()
