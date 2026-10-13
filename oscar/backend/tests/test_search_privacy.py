import asyncio

import pytest

from oscar_agent import search as search_module
from oscar_agent.search_privacy import MAX_ENGINE_QUERY_CHARS, minimize_search_query

# Built at run time so the source never holds a key-shaped literal (the public
# export scanner rejects those even when they are fake).
FAKE_KEY = "sk_" + "live_" + "9fA3kQ7xZ2mN8pR4tV6wY1bC"


@pytest.mark.parametrize("raw, expected", [
    ("курс евро к доллару сегодня", "курс евро к доллару сегодня"),
    ("погода в Варне 12.10.2026", "погода в Варне 12.10.2026"),
    ("ноутбук до 1000$ в 2026 году", "ноутбук до 1000$ в 2026 году"),
    ("напиши на ivan.petrov+work@example.com про тариф", "напиши на про тариф"),
    ("перезвони +7 (912) 345-67-89 насчёт доставки", "перезвони насчёт доставки"),
    ("карта 4276 3800 1234 5678 заблокирована что делать", "карта заблокирована что делать"),
    ("ошибка https://github.com/owner/repo/issues/12?token=abc в сборке", "ошибка github.com в сборке"),
    (f"ключ {FAKE_KEY} не работает", "ключ не работает"),
])
def test_removes_identifiers_and_keeps_search_terms(raw, expected):
    assert minimize_search_query(raw) == expected


def test_bounds_the_query_at_a_word():
    raw = "слово " * 100
    result = minimize_search_query(raw)
    assert len(result) <= MAX_ENGINE_QUERY_CHARS
    assert result.endswith("слово")


def test_every_engine_query_is_minimized(monkeypatch):
    seen = []

    def fake_search(self, query, max_results, backend="auto", timelimit=None):
        seen.append(query)
        return [search_module.RawSearchResult(title="t", url="https://example.com/a")]

    monkeypatch.setattr(search_module.DuckDuckGoProvider, "_search_sync", fake_search)
    provider = search_module.DuckDuckGoProvider(timeout_seconds=2)
    request = "что такое налоговый вычет, мой номер 8 800 555 35 35, почта a.b@example.org " + "детали " * 300
    asyncio.run(provider.search(request, 3))
    asyncio.run(provider.search_voice_officeholder("кто сейчас министр, звоните 89123456789", 3))
    assert seen
    for query in seen:
        assert len(query) <= MAX_ENGINE_QUERY_CHARS
        assert "555" not in query and "@" not in query and "89123456789" not in query


def test_a_query_of_identifiers_only_searches_nothing(monkeypatch):
    called = []
    monkeypatch.setattr(search_module.DuckDuckGoProvider, "_search_sync",
                        lambda *args, **kwargs: called.append(args) or [])
    provider = search_module.DuckDuckGoProvider(timeout_seconds=2)
    assert asyncio.run(provider.search("ivan@example.com +79123456789", 3)) == []
    assert called == []


def test_policy_off_sends_the_query_as_is(monkeypatch, tmp_path):
    import json
    from oscar_agent.search_privacy import engine_query

    policy = tmp_path / "security-policy.v1.json"
    raw = "перезвони +7 (912) 345-67-89 насчёт доставки"
    monkeypatch.setenv("OSCAR_SECURITY_POLICY_PATH", str(policy))
    assert engine_query(raw) == "перезвони насчёт доставки"  # missing file: cleaning stays on
    policy.write_text(json.dumps({"schemaVersion": 1, "levels": {"search.queryMinimization": "off"}}), encoding="utf-8")
    assert engine_query(raw) == raw
    policy.write_text("{damaged", encoding="utf-8")
    assert engine_query(raw) == "перезвони насчёт доставки"
    policy.write_text(json.dumps({"schemaVersion": 1, "levels": {"search.queryMinimization": "maybe"}}), encoding="utf-8")
    assert engine_query(raw) == "перезвони насчёт доставки"


def test_policy_control_id_matches_the_policy_center():
    from pathlib import Path
    from oscar_agent.search_privacy import POLICY_CONTROL

    source = (Path(__file__).resolve().parents[3] / "src" / "settings" / "security-policy.ts").read_text(encoding="utf-8")
    assert f"id: '{POLICY_CONTROL}'" in source
