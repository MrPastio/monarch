from contextlib import redirect_stdout
from io import StringIO
import unittest

from monarch_security.cli import _format_payload, _split_console_command, main


class ConsoleUiTests(unittest.TestCase):
    def test_commands_lists_user_facing_commands(self):
        stream = StringIO()
        with redirect_stdout(stream):
            code = main(["commands"])

        output = stream.getvalue()
        self.assertEqual(code, 0)
        self.assertIn("start", output)
        self.assertIn("deep-scan-file", output)
        self.assertIn("verify-integrity", output)
        self.assertIn("attack-simulation", output)

    def test_tui_once_shows_quick_actions_and_full_catalog(self):
        stream = StringIO()
        with redirect_stdout(stream):
            code = main(["tui", "--once"])

        output = stream.getvalue()
        self.assertEqual(code, 0)
        self.assertIn("Быстрые действия", output)
        self.assertIn("Команды Monarch Security", output)
        self.assertIn("Можно ввести номер", output)

    def test_console_split_keeps_windows_paths_with_spaces(self):
        self.assertEqual(
            _split_console_command(r'scan-path "E:\Folder With Space" --recursive --no-llm'),
            ["scan-path", r"E:\Folder With Space", "--recursive", "--no-llm"],
        )

    def test_format_payload_shows_report_artifacts(self):
        rows = _format_payload(
            {
                "id": "security-report-20260704-120000",
                "scan": {"summary": {"events": 3, "high_or_higher": 1, "medium_or_higher": 2}},
                "integrity": {"ok": True},
                "artifacts": {
                    "json": r"D:\Projects\Monarch\security\reports\report.json",
                    "markdown": r"D:\Projects\Monarch\security\reports\report.md",
                    "html": r"D:\Projects\Monarch\security\reports\report.html",
                },
            }
        )

        output = "\n".join(rows)
        self.assertIn("Security report", output)
        self.assertIn("report.json", output)
        self.assertIn("report.md", output)
