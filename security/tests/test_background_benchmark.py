import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from monarch_security.benchmark import run_background_benchmark


class _FakeSampler:
    def __init__(self):
        self.index = 0

    def sample(self, interval):
        self.index += 1
        return float(self.index), 10_000_000 + self.index


class BackgroundBenchmarkTests(unittest.TestCase):
    def test_short_observation_writes_bounded_artifact(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            pid_path = root / "protector.pid"
            pid_path.write_text(str(os.getpid()), encoding="utf-8")

            payload = run_background_benchmark(
                pid_path,
                root / "reports",
                duration_seconds=0.2,
                interval_seconds=0.05,
                output_path=Path("short.json"),
                sampler=_FakeSampler(),
            )

            self.assertTrue(payload["ok"])
            self.assertGreaterEqual(payload["sample_count"], 1)
            self.assertLessEqual(payload["sample_count"], 4)
            self.assertEqual(payload["active_sample_rate"]["scope"], "process_cpu_samples_not_per_sensor_duty_cycle")
            self.assertTrue(Path(payload["artifact_path"]).is_file())
            self.assertTrue(payload["limitations"])

    def test_output_cannot_escape_reports_root(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            pid_path = root / "protector.pid"
            pid_path.write_text(str(os.getpid()), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "must stay inside"):
                run_background_benchmark(
                    pid_path,
                    root / "reports",
                    duration_seconds=0.1,
                    interval_seconds=0.05,
                    output_path=root / "outside.json",
                    sampler=_FakeSampler(),
                )


if __name__ == "__main__":
    unittest.main()
