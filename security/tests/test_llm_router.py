import unittest

from monarch_security.llm.router import _first_json_object


class LlmRouterTests(unittest.TestCase):
    def test_first_json_object_ignores_trailing_schema_text(self):
        text = (
            '{"action":"warn","confidence":75,"notes":"ok","reasons":["a"]} '
            'Schema: {"action":"..."}'
        )

        self.assertEqual(
            _first_json_object(text),
            '{"action":"warn","confidence":75,"notes":"ok","reasons":["a"]}',
        )

    def test_first_json_object_handles_braces_inside_strings(self):
        text = '{"notes":"value with { brace }","action":"ask_user"} extra'

        self.assertEqual(
            _first_json_object(text),
            '{"notes":"value with { brace }","action":"ask_user"}',
        )
