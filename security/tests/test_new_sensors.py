import unittest
from unittest import mock
from types import SimpleNamespace

from monarch_security.config import NetworkConfig, PersistenceConfig, PostureConfig
from monarch_security.sensors.network import NetworkSensor
from monarch_security.sensors.network import _with_signature as network_signature
from monarch_security.sensors.persistence import PersistenceSensor
from monarch_security.sensors.persistence import _with_signature as persistence_signature
from monarch_security.sensors.posture import PostureSensor
from monarch_security.sensors.posture import _with_signature as posture_signature
from monarch_security.sensors.processes import ProcessSensor


class NewSensorSignatureTests(unittest.TestCase):
    def test_network_listener_signature_is_stable(self):
        item = network_signature(
            {
                "kind": "listener",
                "local_address": "0.0.0.0",
                "local_port": 3389,
                "owning_process": 123,
            }
        )

        self.assertEqual(item["key"], "listener:0.0.0.0:3389:123")
        self.assertIn("3389", item["signature"])
        self.assertTrue(item["exposed_on_all_interfaces"])

    def test_network_connection_marks_public_remote_scope(self):
        item = network_signature(
            {
                "kind": "connection",
                "local_address": "192.168.1.10",
                "local_port": 51515,
                "remote_address": "8.8.8.8",
                "remote_port": 4444,
                "owning_process": 321,
            }
        )

        self.assertEqual(item["remote_scope"], "public")
        self.assertTrue(item["remote_is_public"])

    @mock.patch("monarch_security.sensors.network._native_tcp_items")
    @mock.patch("monarch_security.sensors.network._run_powershell_json")
    def test_network_snapshot_uses_one_powershell_process_and_native_tcp(self, run, native_tcp):
        native_tcp.return_value = [{
            "kind": "connection",
            "subject": "8.8.8.8:443",
            "local_address": "192.168.1.10",
            "local_port": 51515,
            "remote_address": "8.8.8.8",
            "remote_port": 443,
            "owning_process": None,
        }]
        run.return_value = ([
            {"kind": "config", "subject": "Ethernet", "interface_alias": "Ethernet"},
            {"kind": "dns_cache", "domain": "dns.google", "ip": "8.8.8.8"},
        ], None)

        snapshot = NetworkSensor(NetworkConfig()).snapshot()

        run.assert_called_once()
        command = run.call_args.args[0]
        self.assertNotIn("Get-NetTCPConnection", command)
        connection = next(item for item in snapshot if item["kind"] == "connection")
        self.assertEqual(connection["remote_domain"], "dns.google")

    @mock.patch("monarch_security.sensors.network._native_tcp_items", return_value=None)
    @mock.patch("monarch_security.sensors.network._run_powershell_json", return_value=([], None))
    def test_network_snapshot_keeps_powershell_tcp_fallback(self, run, _native_tcp):
        NetworkSensor(NetworkConfig()).snapshot()

        run.assert_called_once()
        self.assertEqual(run.call_args.kwargs["timeout"], 60)
        self.assertIn("Get-NetTCPConnection", run.call_args.args[0])

    def test_persistence_run_key_signature_tracks_value(self):
        item = persistence_signature(
            {
                "kind": "run_key",
                "subject": r"HKCU\Software\Run\Updater",
                "value": r"C:\Users\Example\Downloads\update.exe",
            }
        )

        self.assertEqual(item["key"], r"run_key:hkcu\software\run\updater")
        self.assertIn("update.exe", item["signature"])

    def test_persistence_events_distinguish_exact_approved_baseline_from_changed_entry(self):
        approved = persistence_signature({
            "kind": "run_key",
            "subject": r"HKCU\Software\Run\Updater",
            "value": r"C:\Program Files\Vendor\update.exe",
        })
        exact_sensor = PersistenceSensor(
            PersistenceConfig(),
            include_existing=True,
            approved_signatures={approved["key"]: approved["signature"]},
        )
        exact_sensor.snapshot = lambda: [approved]  # type: ignore[method-assign]
        exact_event = exact_sensor.poll()[0]
        self.assertTrue(exact_event.facts["approved_baseline_exact_match"])
        self.assertFalse(exact_event.facts["approved_baseline_entry_changed"])

        changed = persistence_signature({
            "kind": "run_key",
            "subject": r"HKCU\Software\Run\Updater",
            "value": r"C:\Users\Example\Downloads\update.exe",
        })
        changed_sensor = PersistenceSensor(
            PersistenceConfig(),
            include_existing=True,
            approved_signatures={approved["key"]: approved["signature"]},
        )
        changed_sensor.snapshot = lambda: [changed]  # type: ignore[method-assign]
        changed_event = changed_sensor.poll()[0]
        self.assertFalse(changed_event.facts["approved_baseline_exact_match"])
        self.assertTrue(changed_event.facts["approved_baseline_entry_changed"])

    def test_posture_signature_tracks_disabled_defender(self):
        item = posture_signature(
            {
                "kind": "defender_status",
                "subject": "Microsoft Defender",
                "real_time_protection_enabled": False,
            }
        )

        self.assertEqual(item["key"], "defender_status:microsoft defender")
        self.assertIn("false", item["signature"])

    @mock.patch("monarch_security.sensors.posture._run_powershell_json")
    def test_posture_snapshot_uses_one_powershell_process(self, run):
        run.return_value = ([
            {"kind": "firewall_profile", "subject": "Public", "enabled": True},
            {"kind": "defender_status", "subject": "Microsoft Defender", "antivirus_enabled": True},
        ], None)

        snapshot = PostureSensor(PostureConfig()).snapshot()

        run.assert_called_once()
        command = run.call_args.args[0]
        self.assertIn("Get-NetFirewallProfile", command)
        self.assertIn("Get-MpComputerStatus", command)
        self.assertEqual(len(snapshot), 2)

    def test_process_sensor_reads_expensive_details_only_for_new_processes(self):
        requested_attrs = []

        class FakeError(Exception):
            pass

        class FakeProcess:
            def as_dict(self, *, attrs, ad_value):
                self.detail_attrs = attrs
                return {
                    "pid": 42,
                    "name": "worker.exe",
                    "exe": r"C:\Tools\worker.exe",
                    "username": "tester",
                    "ppid": 7,
                    "create_time": 123.0,
                }

            def cmdline(self):
                return ["worker.exe", "--run"]

            def parent(self):
                return SimpleNamespace(name=lambda: "parent.exe")

        fake_process = FakeProcess()
        fake_psutil = SimpleNamespace(
            NoSuchProcess=FakeError,
            AccessDenied=FakeError,
            process_iter=lambda attrs: (
                requested_attrs.append(attrs)
                or [SimpleNamespace(info={"pid": 42, "name": "worker.exe"})]
            ),
            Process=lambda _pid: fake_process,
        )
        sensor = ProcessSensor(include_existing=True)
        sensor._psutil = fake_psutil

        events = sensor.poll()

        self.assertEqual(requested_attrs, [["pid", "name"]])
        self.assertEqual(fake_process.detail_attrs, ["pid", "name", "exe", "username", "ppid", "create_time"])
        self.assertEqual(events[0].facts["cmdline"], ["worker.exe", "--run"])
        self.assertEqual(events[0].facts["parent_name"], "parent.exe")
