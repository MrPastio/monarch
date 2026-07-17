import unittest

from monarch_security.analysis import RuleEngine
from monarch_security.config import load_config
from monarch_security.events import SecurityEvent
from monarch_security.policy import PolicyEngine


class PolicyTests(unittest.TestCase):
    def test_policy_raises_weak_llm_action_for_critical_score(self):
        config = load_config()
        rules = RuleEngine(config.router)
        policy = PolicyEngine(config.policy)
        event = SecurityEvent(
            kind="process.started",
            source="test",
            subject="powershell.exe",
            facts={
                "name": "powershell.exe",
                "exe": r"C:\Users\Example\Downloads\payload.exe",
                "cmdline": ["powershell.exe", "-EncodedCommand", "AAAA"],
                "parent_name": "WINWORD.EXE",
            },
        )
        assessment = rules.assess(event)

        decision = policy.merge_llm_decision(
            assessment,
            {
                "action": "warn",
                "confidence": 75,
                "reasons": assessment.reasons + ["extra"],
                "notes": "warning only",
            },
        )

        self.assertEqual(assessment.score, 100)
        self.assertEqual(decision.action, "ask_user")
        self.assertEqual(decision.confidence, 0.75)
        self.assertEqual(len(decision.reasons), len(set(decision.reasons)))
