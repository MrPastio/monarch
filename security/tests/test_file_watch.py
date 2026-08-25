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

    def test_file_watch_pages_past_the_first_budget_without_false_existing_events(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            files = []
            for index in range(5):
                path = root / f"item-{index}.txt"
                path.write_text(f"baseline-{index}", encoding="utf-8")
                files.append(path)

            sensor = FileChangeSensor(
                paths=[root],
                recursive=False,
                max_entries_per_tick=2,
                include_existing=False,
            )

            self.assertEqual(sensor.poll(), [])
            self.assertEqual(sensor.checkpoint_cursor, 2)
            self.assertEqual(sensor.poll(), [])
            self.assertEqual(sensor.checkpoint_cursor, 4)
            self.assertEqual(sensor.poll(), [])
            self.assertEqual(sensor.checkpoint_cursor, 0)

            files[-1].write_text("malicious-tail-change", encoding="utf-8")
            self.assertEqual(sensor.poll(), [])
            self.assertEqual(sensor.poll(), [])
            events = sensor.poll()

            self.assertEqual(len(events), 1)
            self.assertEqual(events[0].subject, str(files[-1].resolve()))

    def test_file_watch_cursor_rejects_invalid_persisted_values(self):
        sensor = FileChangeSensor([], False, 2)

        with self.assertRaisesRegex(ValueError, "negative"):
            sensor.restore_checkpoint_cursor(-1)
        with self.assertRaisesRegex(ValueError, "invalid"):
            sensor.restore_checkpoint_cursor("not-a-number")

    def test_file_watch_prunes_deleted_tail_only_after_a_complete_page_cycle(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "item-0.txt"
            second = root / "item-1.txt"
            tail = root / "item-2.txt"
            for path in (first, second, tail):
                path.write_text("same-size", encoding="utf-8")
            sensor = FileChangeSensor([root], False, 2, include_existing=False)

            self.assertEqual(sensor.poll(), [])
            self.assertEqual(sensor.poll(), [])
            tail_key = str(tail.resolve()).lower()
            self.assertIn(tail_key, sensor.signatures)

            tail.unlink()
            self.assertEqual(sensor.poll(), [])
            self.assertNotIn(tail_key, sensor.signatures)

            tail.write_text("same-size", encoding="utf-8")
            self.assertEqual(sensor.poll(), [])
            events = sensor.poll()
            self.assertEqual([event.subject for event in events], [str(tail.resolve())])

    def test_file_watch_restores_mid_cycle_cursor_and_seen_page(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            for index in range(5):
                (root / f"item-{index}.txt").write_text("baseline", encoding="utf-8")
            first = FileChangeSensor([root], False, 2, include_existing=False)
            self.assertEqual(first.poll(), [])

            restored = FileChangeSensor(
                [root],
                False,
                2,
                include_existing=False,
                initial_signatures=first.signatures,
            )
            restored.restore_checkpoint_cursor(first.checkpoint_cursor)
            restored.restore_checkpoint_metadata(first.checkpoint_metadata)
            restored._first_poll = first._first_poll

            self.assertEqual(restored.poll(), [])
            self.assertEqual(restored.checkpoint_cursor, 4)
            self.assertEqual(restored.poll(), [])
            self.assertEqual(restored.checkpoint_cursor, 0)
            self.assertEqual(len(restored.signatures), 5)
