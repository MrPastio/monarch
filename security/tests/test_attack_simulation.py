import unittest
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory

from monarch_security.adversary import run_attack_simulation, run_live_threat_simulation
from monarch_security.analysis import RuleEngine
from monarch_security.config import load_config
from monarch_security.llm import LLMRouter
from monarch_security.policy import PolicyEngine
from monarch_security.resources import ResourceGuard


class AttackSimulationTests(unittest.TestCase):
    def test_live_simulation_uses_durable_incident_pipeline_without_harmful_actions(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            loaded = load_config()
            runtime = replace(
                loaded.runtime,
                incident_log_path=root / "incidents.jsonl",
                integrity_key_path=root / "integrity.key",
            )
            notifications = replace(loaded.notifications, enabled=False, windows_toast=False)
            config = replace(loaded, root=root, runtime=runtime, notifications=notifications)
            rules = RuleEngine(config.router)
            policy = PolicyEngine(config.policy)

            payload = run_live_threat_simulation(config, rules, policy)

            self.assertTrue(payload["ok"])
            self.assertTrue(payload["simulation"])
            self.assertGreaterEqual(payload["risk_score"], 550)
            self.assertTrue(payload["decision_required"])
            self.assertFalse(payload["safety"]["payload_executed"])
            self.assertFalse(payload["safety"]["network_connection_created"])
            self.assertTrue(runtime.incident_log_path.exists())

    def test_attack_simulation_passes_without_llm(self):
        config = load_config()
        rules = RuleEngine(config.router)
        policy = PolicyEngine(config.policy)
        router = LLMRouter(config, ResourceGuard(config.resources), policy)

        payload = run_attack_simulation(
            config,
            rules,
            router,
            policy,
            use_llm=False,
        )

        self.assertTrue(payload["passed"], payload["survived_evasions"])
        self.assertEqual(payload["case_count"], 8)
        self.assertEqual(payload["benign_case_count"], 7)
        self.assertFalse(payload["survived_evasions"])
        self.assertFalse(payload["false_positives"])
        self.assertEqual(payload["metrics"]["detection_rate"], 1.0)
        self.assertEqual(payload["metrics"]["false_positive_rate"], 0.0)
        self.assertGreaterEqual(payload["metrics"]["case_latency_ms_p95"], 0.0)
        self.assertEqual(payload["metrics"]["measurement"], "local_inert_replay")
        self.assertIn("available", payload["metrics"]["protector_idle"])
        self.assertIn("available", payload["metrics"]["replay_process_burst"])
        pipeline = payload["metrics"]["sensor_to_incident"]
        self.assertTrue(pipeline["available"])
        self.assertEqual(pipeline["iterations"], 5)
        self.assertGreaterEqual(pipeline["latency_ms_p95"], 0.0)
        self.assertGreaterEqual(pipeline["minimum_final_risk"], 550)
        self.assertTrue(pipeline["includes_rule_policy_correlation_hmac_fsync"])
        self.assertTrue(pipeline["excludes_sensor_poll_wait"])
        coverage = payload["metrics"]["coverage"]
        self.assertTrue({"rat", "persistence", "exfiltration"}.issubset(coverage["attack_families"]))
        self.assertTrue({"administrator", "developer", "network_admin"}.issubset(coverage["benign_workloads"]))
        approved_persistence = next(
            case for case in payload["benign_cases"] if case["name"] == "approved_persistence_exact_match"
        )
        self.assertEqual(approved_persistence["score"], 5)
        rat_case = next(case for case in payload["cases"] if case["scenario_family"] == "rat")
        self.assertGreaterEqual(rat_case["incident_risk"], 550)
        self.assertTrue(rat_case["emergency_eligible"])
        self.assertEqual(rat_case["evidence_families"], ["network", "process"])
        self.assertTrue(payload["residual_weaknesses"])
