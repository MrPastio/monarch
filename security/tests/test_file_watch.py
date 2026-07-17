from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from monarch_security.sensors.file_watch import FileChangeSensor


class FileWatchTests(unittest.TestCase):
    def test_file_watch_ignores_existing_then_emits_new_change(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            existing = root / "existing.txt"
            existing.write_text("already here", encoding="utf-8")

            sensor = FileChangeSensor(
                paths=[root],
                recursive=False,
                max_entries_per_tick=100,
                include_existing=False,
            )

            self.assertEqual(sensor.poll(), [])

            created = root / "payload.exe"
            created.write_text("new", encoding="utf-8")
            events = sensor.poll()

            self.assertEqual(len(events), 1)
            self.assertEqual(events[0].kind, "file.observed")
            self.assertEqual(events[0].facts["extension"], ".exe")
