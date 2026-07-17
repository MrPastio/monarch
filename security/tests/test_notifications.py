import unittest

from monarch_security.analysis import RuleEngine
from monarch_security.config import NotificationConfig, load_config
from monarch_security.events import SecurityEvent
from monarch_security.notifications import NotificationManager, format_notification
from monarch_security.policy import PolicyEngine


class NotificationTests(unittest.TestCase):
    def test_notification_formats_high_signal_event(self):
        config = load_config()
        event = SecurityEvent(
            kind="process.started",
            source="test",
            subject="powershell.exe",
            facts={
                "name": "powershell.exe",
                "exe": r"C:\Users\Example\Downloads\update.exe",
                "cmdline": ["powershell.exe", "-EncodedCommand", "AAAA"],
                "parent_name": "WINWORD.EXE",
            },
        )
        assessment = RuleEngine(config.router).assess(event)
        decision = PolicyEngine(config.policy).local_decision(assessment)

        title, body = format_notification(assessment, decision)

        self.assertIn("Monarch Security", title)
        self.assertIn("process.started", body)
        self.assertIn("Score 100/100", body)

    def test_notification_threshold_blocks_low_score(self):
        manager = NotificationManager(
            NotificationConfig(
                enabled=True,
                min_score=35,
                windows_toast=False,
                console_bell=False,
            )
        )
        config = load_config()
        event = SecurityEvent(
            kind="network.connection_seen",
            source="test",
            subject="127.0.0.1:3000",
            facts={
                "remote_scope": "loopback",
                "remote_is_public": False,
                "process_name": "python.exe",
            },
        )
        assessment = RuleEngine(config.router).assess(event)
        decision = PolicyEngine(config.policy).local_decision(assessment)

        result = manager.notify(assessment, decision)

        self.assertFalse(result.sent)
        self.assertEqual(result.reason, "below notification threshold")
