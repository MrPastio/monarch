import unittest

from monarch_security.analysis import RuleEngine
from monarch_security.config import load_config
from monarch_security.llm import LLMRouter
from monarch_security.policy import PolicyEngine
from monarch_security.resources import ResourceGuard
from monarch_security.verification import run_protection_verification


class ProtectionVerificationTests(unittest.TestCase):
    def test_verification_lab_passes_without_llm(self):
        config = load_config()
        rules = RuleEngine(config.router)
        policy = PolicyEngine(config.policy)
        router = LLMRouter(config, ResourceGuard(config.resources), policy)

        payload = run_protection_verification(
            config,
            rules,
            router,
            policy,
            use_llm=False,
        )

        self.assertTrue(payload["passed"], payload["failed"])
        self.assertEqual(payload["case_count"], 8)
        self.assertIn(
            "suspicious_powershell_downloader",
            {case["name"] for case in payload["cases"]},
        )
        self.assertTrue(
            any(
                case["name"] == "benign_text_noise_floor"
                and case["route"] == "local"
                for case in payload["cases"]
            )
        )
