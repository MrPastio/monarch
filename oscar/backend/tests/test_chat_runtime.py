from pathlib import Path
import sys
import asyncio
import base64
import gc
import json
import logging
from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

backend_dir = Path(__file__).resolve().parents[1]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from oscar_agent import main as main_module
from oscar_agent import model_runtime as runtime_module
from oscar_agent.config import Settings
from oscar_agent.memory import MemoryStore
from oscar_agent.model_runtime import LocalModelRuntime, stream_text_fragments
from oscar_agent.schemas import ChatAccessContext, ChatCapabilityContext, ChatImageAttachment, ChatRequest, ChatMessage, ChatRouteHint, ChatSkillContext, ChatSource, ConversationMessageCreate, MAX_CHAT_MESSAGES
from oscar_agent.workspace import WorkspaceService


def make_settings(tmp_path: Path) -> Settings:
    return Settings(
        data_dir=tmp_path / "data",
        db_path=tmp_path / "data" / "memory.sqlite3",
        offload_dir=tmp_path / "offload",
        workspace_root=tmp_path / "workspace",
        workspace_generated_dir=tmp_path / "workspace" / "artifacts" / "generated",
        gemma_models_dir=tmp_path / "models",
        coder_models_dir=tmp_path / "coder-models",
        mock_model=True,
    )


def test_chat_request_exposes_a_very_large_output_budget_without_unbounded_input():
    default_request = ChatRequest(messages=[ChatMessage(role="user", content="Подробный ответ")])
    largest_request = ChatRequest(
        messages=[ChatMessage(role="user", content="Очень длинный ответ")],
        max_new_tokens=262_144,
    )

    assert default_request.max_new_tokens == 65_536
    assert largest_request.max_new_tokens == 262_144
    with pytest.raises(ValidationError):
        ChatRequest(
            messages=[ChatMessage(role="user", content="Некорректный бюджет")],
            max_new_tokens=262_145,
        )


def test_deep_research_only_auto_continues_the_final_answer():
    request = ChatRequest(
        messages=[ChatMessage(role="user", content="Исследуй худший сценарий после IPO")],
        research_mode="deep",
        use_memory=False,
    )
    truncated_usage = {"likely_truncated": True}

    assert main_module.should_auto_continue(request, "Черновик оборван", truncated_usage, 0) is False
    assert main_module.should_auto_continue(
        request,
        "Финальный вывод оборван",
        truncated_usage,
        0,
        allow_deep_research=True,
    ) is True


def test_deep_research_adopts_loaded_fallback_without_reloading(monkeypatch):
    monkeypatch.setattr(main_module.model_runtime, "loaded", True)
    monkeypatch.setattr(main_module.model_runtime, "fallback_active", True)
    monkeypatch.setattr(main_module.model_runtime, "active_tier", "gemma4-balanced")
    monkeypatch.setattr(main_module.model_runtime, "load_attempts", [])

    tier = main_module.adopt_deep_research_runtime_tier(
        "gemma4-deepthinking",
        strict_model=False,
    )

    assert tier == "gemma4-balanced"
    assert main_module.model_runtime.fallback_active is False
    assert main_module.model_runtime.load_attempts == [
        "deep research continued on loaded tier: gemma4-deepthinking -> gemma4-balanced"
    ]


def test_deep_research_keeps_explicit_model_selection_strict(monkeypatch):
    monkeypatch.setattr(main_module.model_runtime, "loaded", True)
    monkeypatch.setattr(main_module.model_runtime, "fallback_active", True)
    monkeypatch.setattr(main_module.model_runtime, "active_tier", "gemma4-balanced")

    tier = main_module.adopt_deep_research_runtime_tier(
        "gemma4-deepthinking",
        strict_model=True,
    )

    assert tier == "gemma4-deepthinking"
    assert main_module.model_runtime.fallback_active is True


async def collect_stream_body(response) -> str:
    chunks = []
    async for chunk in response.body_iterator:
        chunks.append(chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk)
    return "".join(chunks)


@pytest.mark.asyncio
async def test_deep_research_stream_exposes_safe_progress_and_verified_answer(monkeypatch, tmp_path: Path):
    store = MemoryStore(make_settings(tmp_path))

    async def fake_research_events(*_args, **_kwargs):
        yield "progress", {
            "stage": "plan",
            "label": "Планирую исследование",
            "detail": "Три независимые ветки",
            "completed": 0,
            "total": 3,
        }
        yield "plan", ["официальные факты", "исторические аналоги", "контраргументы"]
        yield "sources", [
            ChatSource(id=1, title="Primary", url="https://example.com/primary", excerpt="Факт 1"),
            ChatSource(id=2, title="Independent", url="https://example.org/check", excerpt="Факт 2"),
        ]

    async def fake_deliberation(*_args, **_kwargs):
        yield "progress", {
            "stage": "reflect",
            "label": "Проверяю полноту · раунд 1/3",
            "detail": "Ищу пробелы",
            "completed": 0,
            "total": 3,
        }
        yield "progress", {
            "stage": "revise",
            "label": "Пересобираю вывод · раунд 1",
            "detail": "Учитываю пробелы",
            "completed": 0,
            "total": 3,
        }
        yield "progress", {
            "stage": "finalize",
            "label": "Формирую окончательный вывод",
            "detail": "Объединяю результат",
            "completed": 2,
            "total": 3,
        }
        yield "result", {
            "answer": "Проверенный итог с оговорками [1] [2]",
            "sources": [
                ChatSource(id=1, title="Primary", url="https://example.com/primary", excerpt="Факт 1"),
                ChatSource(id=2, title="Independent", url="https://example.org/check", excerpt="Факт 2"),
            ],
            "queries": ["официальные факты", "исторические аналоги", "контраргументы"],
            "rounds": 2,
            "confidence": 0.87,
            "stop_reason": "model-satisfied",
            "revised": True,
        }

    async def no_language_rewrite(*_args, **_kwargs):
        return None

    async def no_registry_regeneration(_tier, _request, _sources, answer):
        return answer, [], False

    async def no_quality_regeneration(_tier, _request, _sources, answer):
        return answer, [], False

    monkeypatch.setattr(main_module, "memory", store)
    monkeypatch.setattr(main_module, "deep_research_source_events", fake_research_events)
    monkeypatch.setattr(main_module, "deep_research_deliberation_events", fake_deliberation)
    monkeypatch.setattr(main_module, "maybe_rewrite_answer_language", no_language_rewrite)
    monkeypatch.setattr(main_module, "maybe_regenerate_for_registry_grounding", no_registry_regeneration)
    monkeypatch.setattr(main_module, "maybe_regenerate_for_quality", no_quality_regeneration)
    monkeypatch.setattr(main_module.model_runtime, "stream_chat", lambda *_args, **_kwargs: iter(["Черновой аналитический вывод"]))
    monkeypatch.setattr(main_module.model_runtime, "unload", lambda: None)

    response = await main_module.chat_stream(ChatRequest(
        conversation_id="deep-research-stream",
        messages=[ChatMessage(
            role="user",
            content="Предположи самый худший сценарий для OpenAI, продуктов и политики после IPO",
        )],
        use_memory=False,
        allow_tools=False,
        deep_thinking_consent="deny",
        max_new_tokens=256,
    ))
    body = await collect_stream_body(response)

    assert "event: research" in body
    assert "Планирую исследование" in body
    assert "Синтезирую вывод" in body
    assert "Проверяю полноту" in body
    assert "Пересобираю вывод" in body
    assert "Формирую окончательный вывод" in body
    assert "Проверенный итог" in body
    assert "Черновой аналитический вывод" not in body
    assert "event: token" not in body
    assert '"research_mode": "deep"' in body
    assert '"research_queries": 3' in body
    assert '"research_verified": true' in body
    assert '"research_rounds": 2' in body
    assert '"research_stop_reason": "model-satisfied"' in body


@pytest.mark.asyncio
async def test_deep_research_source_branches_are_bounded_and_parallel(monkeypatch):
    active_searches = 0
    peak_searches = 0
    calls = []

    async def fake_search(query, limit, fetch_pages=False):
        nonlocal active_searches, peak_searches
        calls.append((query, limit, fetch_pages))
        branch_number = len(calls)
        active_searches += 1
        peak_searches = max(peak_searches, active_searches)
        await asyncio.sleep(0)
        active_searches -= 1
        return [SimpleNamespace(
            url=f"https://example.com/{branch_number}",
            title=f"Source {branch_number}",
            snippet=f"Evidence for {query}",
        )]

    monkeypatch.setattr(
        main_module.model_runtime,
        "stream_chat",
        lambda *_args, **_kwargs: iter([
            '{"queries":["official current facts","historical precedents","independent counterarguments"]}'
        ]),
    )
    monkeypatch.setattr(main_module.search_service, "search_and_ingest", fake_search)
    monkeypatch.setattr(main_module.memory, "search_urls", lambda *_args, **_kwargs: [])
    main_module.model_runtime.reset_generation_cancel()

    events = []
    async for event in main_module.deep_research_source_events(
        ChatRequest(
            messages=[ChatMessage(role="user", content="Исследуй последствия IPO для компании")],
            research_mode="deep",
            use_memory=False,
        ),
        "gemma4-balanced",
        strict_model=False,
    ):
        events.append(event)

    sources = next(payload for kind, payload in events if kind == "sources")
    assert len(calls) == 3
    assert peak_searches == 3
    assert all(limit == 3 and fetch_pages is True for _query, limit, fetch_pages in calls)
    assert len(sources) == 3
    assert [source.id for source in sources] == [1, 2, 3]
    assert any(kind == "progress" and payload["stage"] == "search" for kind, payload in events)


@pytest.mark.asyncio
async def test_deep_research_source_cancellation_closes_pending_completion_waiters(monkeypatch, recwarn):
    async def fake_search(query, limit, fetch_pages=False):
        main_module.model_runtime.cancel_generation()
        await asyncio.sleep(0)
        return []

    monkeypatch.setattr(
        main_module.model_runtime,
        "stream_chat",
        lambda *_args, **_kwargs: iter([
            '{"queries":["first branch","second branch","third branch"]}'
        ]),
    )
    monkeypatch.setattr(main_module.search_service, "search_and_ingest", fake_search)
    main_module.model_runtime.reset_generation_cancel()

    try:
        events = [
            event
            async for event in main_module.deep_research_source_events(
                ChatRequest(
                    messages=[ChatMessage(role="user", content="Исследуй сложный сценарий")],
                    research_mode="deep",
                    use_memory=False,
                ),
                "gemma4-balanced",
                strict_model=False,
            )
        ]
        assert any(kind == "sources" for kind, _payload in events)
        gc.collect()
        await asyncio.sleep(0)
        assert not any("was never awaited" in str(warning.message) for warning in recwarn)
    finally:
        main_module.model_runtime.reset_generation_cancel()


@pytest.mark.asyncio
async def test_deliberation_loop_self_directs_followup_research_and_stops_when_satisfied(monkeypatch):
    outputs = iter([
        '{"decision":"continue","confidence":0.52,"gaps":["missing governance precedent"],'
        '"queries":["AI company IPO governance precedent","second query beyond total budget"],'
        '"revision_focus":"Add the missing precedent"}',
        "Уточнённый черновик после первого раунда [1] [3]",
        '{"decision":"finalize","confidence":0.89,"gaps":[],"queries":[],"revision_focus":""}',
        "Окончательный подробный вывод [1] [2] [3]",
    ])
    calls = []
    expanded_queries = []

    def fake_stream(tier, messages, sources, *_args, **_kwargs):
        calls.append((tier, messages[-1].content, len(sources)))
        return iter([next(outputs)])

    async def fake_expand(queries, sources):
        expanded_queries.extend(queries)
        return [
            *sources,
            ChatSource(id=3, title="Precedent", url="https://example.net/precedent", excerpt="Precedent evidence"),
        ]

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", fake_stream)
    monkeypatch.setattr(main_module, "expand_deep_research_sources", fake_expand)
    main_module.model_runtime.reset_generation_cancel()
    main_module.model_runtime.fallback_active = False

    events = []
    async for event in main_module.deep_research_deliberation_events(
        "gemma4-balanced",
        ChatRequest(
            messages=[ChatMessage(role="user", content="Исследуй худший сценарий после IPO")],
            research_mode="deep",
            use_memory=False,
            max_new_tokens=1024,
        ),
        [
            ChatSource(id=1, title="Primary", url="https://example.com/1", excerpt="Fact 1"),
            ChatSource(id=2, title="Check", url="https://example.com/2", excerpt="Fact 2"),
        ],
        "Первичный черновик [1] [2]",
        [f"initial research {index}" for index in range(1, 7)],
        strict_model=False,
    ):
        events.append(event)

    result = next(payload for kind, payload in events if kind == "result")
    stages = [payload["stage"] for kind, payload in events if kind == "progress"]
    assert expanded_queries == ["AI company IPO governance precedent"]
    assert result["answer"] == "Окончательный подробный вывод [1] [2] [3]"
    assert result["rounds"] == 2
    assert result["confidence"] == 0.89
    assert result["stop_reason"] == "model-satisfied"
    assert result["revised"] is True
    assert result["queries"] == [
        "initial research 1",
        "initial research 2",
        "initial research 3",
        "initial research 4",
        "initial research 5",
        "initial research 6",
        "AI company IPO governance precedent",
    ]
    assert stages == ["reflect", "search", "read", "revise", "reflect", "decision", "finalize"]
    assert len(calls) == 4
    assert {tier for tier, _prompt, _sources in calls} == {"gemma4-balanced"}


@pytest.mark.asyncio
async def test_deep_research_final_answer_continues_after_single_pass_limit(monkeypatch):
    outputs = iter([
        '{"decision":"finalize","confidence":0.91,"gaps":[],"queries":[],"revision_focus":""}',
        "Финальный вывод обрывается на",
        " самом важном заключении.",
    ])
    calls = []
    usage_checks = 0

    def fake_stream(*_args, **_kwargs):
        calls.append(True)
        return iter([next(outputs)])

    def fake_estimate(*_args, **_kwargs):
        nonlocal usage_checks
        usage_checks += 1
        return {"likely_truncated": usage_checks == 1}

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", fake_stream)
    monkeypatch.setattr(main_module, "estimate_continuation_usage", fake_estimate)
    main_module.model_runtime.reset_generation_cancel()
    main_module.model_runtime.fallback_active = False

    events = []
    async for event in main_module.deep_research_deliberation_events(
        "gemma4-balanced",
        ChatRequest(
            messages=[ChatMessage(role="user", content="Исследуй худший сценарий после IPO")],
            research_mode="deep",
            use_memory=False,
            max_new_tokens=65_536,
        ),
        [ChatSource(id=1, title="Source", url="https://example.com", excerpt="Evidence")],
        "Первичный черновик",
        ["initial research"],
        strict_model=False,
    ):
        events.append(event)

    result = next(payload for kind, payload in events if kind == "result")
    progress_labels = [payload["label"] for kind, payload in events if kind == "progress"]
    assert result["answer"] == "Финальный вывод обрывается на самом важном заключении."
    assert result["continuation_count"] == 1
    assert any("Продолжаю полный вывод" in label for label in progress_labels)
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_deliberation_loop_is_bounded_when_model_keeps_requesting_more_work(monkeypatch):
    outputs = []
    for round_index in range(1, 4):
        outputs.extend([
            '{"decision":"continue","confidence":0.4,"gaps":["more analysis"],'
            '"queries":[],"revision_focus":"Improve the draft"}',
            f"Пересобранный черновик {round_index}",
        ])
    outputs.append("Финальный ответ после лимита")
    output_iter = iter(outputs)
    calls = []

    def fake_stream(*_args, **_kwargs):
        calls.append(True)
        return iter([next(output_iter)])

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", fake_stream)
    main_module.model_runtime.reset_generation_cancel()
    main_module.model_runtime.fallback_active = False

    events = []
    async for event in main_module.deep_research_deliberation_events(
        "gemma4-fast",
        ChatRequest(
            messages=[ChatMessage(role="user", content="Проведи глубокое исследование")],
            research_mode="deep",
            use_memory=False,
            max_new_tokens=512,
        ),
        [ChatSource(id=1, title="Source", url="https://example.com", excerpt="Evidence")],
        "Начальный черновик",
        ["initial research"],
        strict_model=True,
    ):
        events.append(event)

    result = next(payload for kind, payload in events if kind == "result")
    assert result["rounds"] == 3
    assert result["stop_reason"] == "round-limit"
    assert result["answer"] == "Финальный ответ после лимита"
    assert len(calls) == 7


@pytest.mark.asyncio
async def test_deliberation_loop_stops_cleanly_when_generation_is_cancelled(monkeypatch):
    calls = []

    def cancelled_stream(*_args, **_kwargs):
        calls.append(True)

        def chunks():
            main_module.model_runtime.cancel_generation()
            yield ""

        return chunks()

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", cancelled_stream)
    main_module.model_runtime.reset_generation_cancel()
    main_module.model_runtime.fallback_active = False

    events = []
    async for event in main_module.deep_research_deliberation_events(
        "gemma4-balanced",
        ChatRequest(
            messages=[ChatMessage(role="user", content="Исследуй сложный сценарий")],
            research_mode="deep",
            use_memory=False,
        ),
        [ChatSource(id=1, title="Source", url="https://example.com", excerpt="Evidence")],
        "Лучший доступный черновик",
        ["initial research"],
        strict_model=False,
    ):
        events.append(event)

    result = next(payload for kind, payload in events if kind == "result")
    assert result["stop_reason"] == "cancelled"
    assert result["answer"] == "Лучший доступный черновик"
    assert result["rounds"] == 1
    assert len(calls) == 1
    main_module.model_runtime.reset_generation_cancel()


@pytest.mark.asyncio
async def test_stream_persists_conversation_and_unloads_model_after_answer(monkeypatch, tmp_path: Path):
    store = MemoryStore(make_settings(tmp_path))
    unloads = []
    monkeypatch.setattr(main_module, "memory", store)
    monkeypatch.setattr(main_module.model_runtime, "stream_chat", lambda *_args, **_kwargs: iter(["Готовый ответ"]))
    monkeypatch.setattr(main_module.model_runtime, "unload", lambda: unloads.append(True))

    response = await main_module.chat_stream(ChatRequest(
        conversation_id="conversation-test",
        messages=[ChatMessage(role="user", content="Объясни формулу")],
        image_attachments=[ChatImageAttachment(
            mime_type="image/png",
            data_base64=base64.b64encode(b"fake-image").decode("ascii"),
            name="formula.png",
            size_bytes=10,
        )],
        use_memory=False,
        allow_tools=False,
        max_new_tokens=32,
    ))
    body = await collect_stream_body(response)
    conversation = store.get_conversation("conversation-test")

    assert 'event: conversation' in body
    assert 'Готовый ответ' in body
    assert [message["content"] for message in conversation["messages"]] == ["Объясни формулу", "Готовый ответ"]
    assert conversation["messages"][0]["attachments"][0]["name"] == "formula.png"
    assert conversation["messages"][1]["model_tier"] == "gemma4-balanced"
    assert unloads == [True]


@pytest.mark.asyncio
async def test_stream_throttles_disconnect_probes_for_fast_token_bursts(monkeypatch, tmp_path: Path):
    store = MemoryStore(make_settings(tmp_path))
    disconnect_checks = 0

    class ConnectedRequest:
        async def is_disconnected(self):
            nonlocal disconnect_checks
            disconnect_checks += 1
            return False

    monkeypatch.setattr(main_module, "memory", store)
    monkeypatch.setattr(main_module.model_runtime, "stream_chat", lambda *_args, **_kwargs: iter(["x"] * 200))
    monkeypatch.setattr(main_module.model_runtime, "unload", lambda: None)

    response = await main_module.chat_stream(ChatRequest(
        conversation_id="disconnect-poll-throttle",
        messages=[ChatMessage(role="user", content="Ответь коротко")],
        use_memory=False,
        allow_tools=False,
        max_new_tokens=32,
    ), http_request=ConnectedRequest())
    body = await collect_stream_body(response)

    assert body.count("event: token") == 200
    assert disconnect_checks < 20


@pytest.mark.asyncio
async def test_incognito_stream_keeps_existing_memory_readable_without_persisting_chat_or_notes(monkeypatch, tmp_path: Path):
    store = MemoryStore(make_settings(tmp_path))
    monkeypatch.setattr(main_module, "memory", store)
    monkeypatch.setattr(main_module.model_runtime, "stream_chat", lambda *_args, **_kwargs: iter(["Приватный ответ"]))
    monkeypatch.setattr(main_module.model_runtime, "unload", lambda: None)

    request = ChatRequest(
        conversation_id="private-conversation",
        incognito=True,
        messages=[ChatMessage(role="user", content="Запомни, что люблю оранжевый цвет")],
        use_memory=True,
        allow_tools=True,
        max_new_tokens=32,
    )
    response = await main_module.chat_stream(request)
    body = await collect_stream_body(response)

    assert "Приватный ответ" in body
    assert "event: conversation" not in body
    with pytest.raises(KeyError):
        store.get_conversation("private-conversation")
    assert store.list_memory_items() == []


@pytest.mark.asyncio
async def test_stream_automatically_continues_truncated_code(monkeypatch, tmp_path: Path):
    store = MemoryStore(make_settings(tmp_path))
    calls = []

    def stream_chat(_tier, messages, *_args, **_kwargs):
        calls.append(messages)
        if len(calls) == 1:
            return iter(["```python\nprint("])
        return iter(["'готово')\n```"])

    monkeypatch.setattr(main_module, "memory", store)
    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)
    monkeypatch.setattr(main_module.model_runtime, "unload", lambda: None)

    response = await main_module.chat_stream(ChatRequest(
        conversation_id="continued-code",
        messages=[ChatMessage(role="user", content="Напиши код приложения")],
        use_memory=False,
        allow_tools=False,
        max_new_tokens=32,
    ))
    body = await collect_stream_body(response)
    conversation = store.get_conversation("continued-code")

    assert len(calls) == 2
    assert "Расширяю лимит ответа" in body
    assert conversation["messages"][-1]["content"] == "```python\nprint('готово')\n```"
    assert conversation["messages"][-1]["token_count"] > 0
    assert '"auto_continued": true' in body
    assert '"likely_truncated": false' in body


@pytest.mark.asyncio
async def test_stream_expands_truncated_code_budget_up_to_four_passes(monkeypatch, tmp_path: Path):
    store = MemoryStore(make_settings(tmp_path))
    calls = []
    chunks = ["```python\nvalues = [", "1,\n", "2,\n", "3]\n```"]

    def stream_chat(_tier, messages, *_args, **_kwargs):
        calls.append(messages)
        return iter([chunks[len(calls) - 1]])

    monkeypatch.setattr(main_module, "memory", store)
    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)
    monkeypatch.setattr(main_module.model_runtime, "unload", lambda: None)

    response = await main_module.chat_stream(ChatRequest(
        conversation_id="four-pass-code",
        messages=[ChatMessage(role="user", content="Напиши код приложения")],
        use_memory=False,
        allow_tools=False,
        max_new_tokens=32,
    ))
    body = await collect_stream_body(response)
    conversation = store.get_conversation("four-pass-code")

    assert len(calls) == 4
    assert "×2 из ×64" in body
    assert "×3 из ×64" in body
    assert "×4 из ×64" in body
    assert conversation["messages"][-1]["content"] == "```python\nvalues = [1,\n2,\n3]\n```"
    assert '"continuation_count": 3' in body
    assert '"adaptive_budget_multiplier": 4' in body
    assert '"adaptive_budget_tokens": 128' in body


@pytest.mark.asyncio
async def test_followup_continue_uses_saved_code_cut_point_without_restarting(monkeypatch, tmp_path: Path):
    store = MemoryStore(make_settings(tmp_path))
    store.append_conversation_message("resume-code", "user", "Напиши функцию")
    store.append_conversation_message("resume-code", "assistant", "```python\ndef total(items):\n    return sum(")
    calls = []

    def stream_chat(_tier, messages, *_args, **_kwargs):
        calls.append(messages)
        return iter(["items)\n```"])

    monkeypatch.setattr(main_module, "memory", store)
    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)
    monkeypatch.setattr(main_module.model_runtime, "unload", lambda: None)

    response = await main_module.chat_stream(ChatRequest(
        conversation_id="resume-code",
        messages=[ChatMessage(role="user", content="Продолжи")],
        use_memory=False,
        allow_tools=False,
        max_new_tokens=8192,
    ))
    body = await collect_stream_body(response)
    conversation = store.get_conversation("resume-code")

    assert len(calls) == 1
    assert calls[0][-2].role == "assistant"
    assert calls[0][-2].content.endswith("return sum(")
    assert "ровно с последнего символа" in calls[0][-1].content
    assert conversation["messages"][-1]["content"] == "items)\n```"
    assert '"continued_from_previous": true' in body
    assert '"adaptive_budget_ceiling_tokens": 524288' in body


@pytest.mark.asyncio
async def test_language_rewrite_never_rewrites_code_only_output_even_when_explicit(monkeypatch):
    calls = []

    def stream_chat(*args, **kwargs):
        calls.append((args, kwargs))
        return iter(["не должно вызываться"])

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)

    corrected = await main_module.maybe_rewrite_answer_language(
        "gemma4-balanced",
        ChatRequest(
            messages=[ChatMessage(role="user", content="Напиши код и ответь на русском")],
            use_memory=False,
        ),
        [],
        "```python\nprint('hello world')\n```",
    )

    assert corrected is None
    assert calls == []


@pytest.mark.asyncio
async def test_language_rewrite_keeps_image_grounding_for_long_wrong_language_answer(monkeypatch):
    attachment = ChatImageAttachment(
        mime_type="image/png",
        data_base64=base64.b64encode(b"fake-png").decode("ascii"),
        name="screen.png",
        size_bytes=8,
    )
    captured = {}

    def stream_chat(*args, **kwargs):
        captured["images"] = args[7]
        return iter(["Исправленный ответ на русском языке."])

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)

    corrected = await main_module.maybe_rewrite_answer_language(
        "gemma4-balanced",
        ChatRequest(
            messages=[ChatMessage(role="user", content="Опиши картинку")],
            image_attachments=[attachment],
            use_memory=False,
        ),
        [],
        "This answer uses enough natural language words to trigger correction.",
    )

    assert corrected == "Исправленный ответ на русском языке."
    assert captured["images"] == [attachment]


def test_followup_continuation_strips_client_interruption_notice():
    partial = "```ts\nexport function value() {\n  return"
    request = ChatRequest(
        messages=[
            ChatMessage(role="user", content="Напиши функцию"),
            ChatMessage(
                role="assistant",
                content=f"{partial}\n\n*Поток завершился раньше времени. Уже полученная часть ответа сохранена.*",
            ),
            ChatMessage(role="user", content="Продолжи"),
        ],
        max_new_tokens=8192,
    )

    source = main_module.explicit_code_continuation_source(request)
    assert source == partial
    main_module.apply_explicit_code_continuation(request, source)
    assert request.messages[-2].content == partial
    assert "ровно с последнего символа" in request.messages[-1].content


@pytest.mark.asyncio
async def test_chat_stream_hydrates_saved_conversation_tail_for_model_handoff(monkeypatch, tmp_path: Path):
    store = MemoryStore(make_settings(tmp_path))
    store.append_conversation_message("handoff-memory", "user", "Кодовое слово: янтарь. Сохрани это для текущего диалога.")
    store.append_conversation_message("handoff-memory", "assistant", "Запомнил: кодовое слово янтарь.")
    for index in range(40):
        store.append_conversation_message("handoff-memory", "user", f"Промежуточный вопрос {index}")
        store.append_conversation_message("handoff-memory", "assistant", f"Промежуточный ответ {index}")

    captured: list[list[ChatMessage]] = []

    def stream_chat(_tier, messages, *_args, **_kwargs):
        captured.append(messages)
        return iter(["Кодовое слово было янтарь."])

    monkeypatch.setattr(main_module, "memory", store)
    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)
    monkeypatch.setattr(main_module.model_runtime, "ram_assessment", lambda _tier: {"ram_warning": "none"})
    monkeypatch.setattr(main_module.model_runtime, "unload", lambda: None)

    response = await main_module.chat_stream(ChatRequest(
        conversation_id="handoff-memory",
        messages=[ChatMessage(role="user", content="Какое кодовое слово я назвал?")],
        use_memory=False,
        allow_tools=False,
        requested_model="gemma4-31b",
        max_new_tokens=32,
    ))
    body = await collect_stream_body(response)

    assert "Кодовое слово было янтарь." in body
    assert captured
    prompt_messages = captured[0]
    assert len(prompt_messages) <= MAX_CHAT_MESSAGES
    assert prompt_messages[0].role == "system"
    assert "Conversation handoff digest" in prompt_messages[0].content
    assert "Кодовое слово: янтарь" in prompt_messages[0].content
    assert prompt_messages[-1].content == "Какое кодовое слово я назвал?"


@pytest.mark.parametrize("stored_count", [87, 100, 1000])
@pytest.mark.parametrize("system_count", [0, 3])
@pytest.mark.parametrize("overlap", [0, 1, 20, 60])
def test_bounded_conversation_fit_matches_full_history(stored_count: int, system_count: int, overlap: int):
    stored = [
        ChatMessage(
            role="user" if index % 2 == 0 else "assistant",
            content=f"message {index} unique context {'x' * (index % 17)}",
        )
        for index in range(stored_count)
    ]
    supplied = list(stored[-overlap:]) if overlap else []
    supplied.extend([
        ChatMessage(role="user", content="new user follow-up"),
        ChatMessage(role="assistant", content="new assistant bridge"),
        ChatMessage(role="user", content="current user request"),
    ])
    systems = [ChatMessage(role="system", content=f"system {index}") for index in range(system_count)]

    expected = main_module.fit_conversation_messages(
        systems,
        main_module.merge_conversation_dialogue(stored, supplied),
    )
    bounded = main_module.fit_bounded_conversation_messages(
        systems,
        stored[:main_module.CONVERSATION_DIGEST_EDGE_MESSAGES],
        stored[-main_module.CONVERSATION_CONTEXT_TAIL_MESSAGES:],
        len(stored),
        supplied,
    )

    assert [(message.role, message.content) for message in bounded] == [
        (message.role, message.content) for message in expected
    ]


def test_conversation_context_window_reads_bounded_head_and_tail(tmp_path: Path):
    store = MemoryStore(make_settings(tmp_path))
    conversation_id = "bounded-history"
    for index in range(300):
        store.append_conversation_message(
            conversation_id,
            "user" if index % 2 == 0 else "assistant",
            f"history message {index}",
        )

    window = store.get_conversation_context_window(conversation_id, head_limit=4, tail_limit=86)

    assert window["message_count"] == 300
    assert [message["content"] for message in window["head_messages"]] == [
        f"history message {index}" for index in range(4)
    ]
    assert len(window["tail_messages"]) == 86
    assert window["tail_messages"][0]["content"] == "history message 214"
    assert window["tail_messages"][-1]["content"] == "history message 299"


def test_conversation_api_pages_history_from_newest_without_changing_full_read(monkeypatch, tmp_path: Path):
    settings = make_settings(tmp_path)
    settings.api_token = "test-token"
    settings.disable_api_token = False
    store = MemoryStore(settings)
    conversation_id = "paged-history"
    for index in range(225):
        store.append_conversation_message(
            conversation_id,
            "user" if index % 2 == 0 else "assistant",
            f"history message {index}",
        )
    monkeypatch.setattr(main_module, "settings", settings)
    monkeypatch.setattr(main_module, "memory", store)
    client = TestClient(main_module.app, raise_server_exceptions=False)

    first_response = client.get(
        f"/api/conversations/{conversation_id}?message_limit=80",
        headers={"X-Oscar-Token": "test-token"},
    )
    assert first_response.status_code == 200
    first = first_response.json()
    assert [item["content"] for item in first["messages"]] == [
        f"history message {index}" for index in range(145, 225)
    ]
    assert first["message_page"]["has_more"] is True

    second = store.get_conversation(
        conversation_id,
        message_limit=80,
        before_rowid=first["message_page"]["next_before"],
    )
    third = store.get_conversation(
        conversation_id,
        message_limit=80,
        before_rowid=second["message_page"]["next_before"],
    )
    combined = [*third["messages"], *second["messages"], *first["messages"]]
    assert [item["content"] for item in combined] == [
        f"history message {index}" for index in range(225)
    ]
    assert third["message_page"] == {
        "limit": 80,
        "returned": 65,
        "has_more": False,
        "next_before": None,
    }

    full = store.get_conversation(conversation_id)
    assert len(full["messages"]) == 225
    assert "message_page" not in full


def test_model_runtime_preserves_monarch_supplied_system_context():
    runtime = LocalModelRuntime(Settings(api_token="test", mock_fallback=False))
    prompt = runtime._build_prompt_messages(
        [
            ChatMessage(role="system", content="<local_user_context>Пользователь предпочитает краткий русский ответ.</local_user_context>"),
            ChatMessage(role="user", content="Привет"),
        ],
        [],
        "low",
    )

    assert len(prompt) == 2
    assert prompt[0].role == "system"
    assert "Переданные Monarch context blocks" in prompt[0].content
    assert "Пользователь предпочитает краткий русский ответ" in prompt[0].content
    assert prompt[1].role == "user"
    assert prompt[1].content == "Привет"


def test_model_runtime_treats_resolved_live_registry_mentions_as_separate_modules():
    runtime = LocalModelRuntime(Settings(api_token="test", mock_fallback=False))
    prompt = runtime._build_prompt_messages(
        [
            ChatMessage(
                role="system",
                content=(
                    '<live_monarch_system>{"resolvedMentionIds":["safe","sharing"],'
                    '"modules":[{"id":"safe","name":"Monarch Safe"},'
                    '{"id":"sharing","name":"Monarch Sharing"}]}</live_monarch_system>'
                ),
            ),
            ChatMessage(role="user", content="Я про самые новые, Safe-Sharing"),
        ],
        [],
        "low",
    )

    assert "Несколько resolvedMentionIds" in prompt[0].content
    assert "отдельные модули" in prompt[0].content
    assert "Используй релевантные факты естественно" in prompt[0].content
    assert "не выгружай raw JSON" in prompt[0].content
    assert "Monarch Safe" in prompt[0].content
    assert "Monarch Sharing" in prompt[0].content


@pytest.mark.asyncio
async def test_live_registry_grounding_retries_through_model_instead_of_template(monkeypatch):
    request = ChatRequest(
        messages=[
            ChatMessage(
                role="system",
                content=(
                    '<live_monarch_system>{"resolvedMentionIds":["safe","sharing"],'
                    '"modules":[{"id":"safe","name":"Monarch Safe","description":"Encrypted local vault."},'
                    '{"id":"sharing","name":"Monarch Sharing","description":"Offline local model API."}]}'
                    '</live_monarch_system>'
                ),
            ),
            ChatMessage(role="user", content="Я про самые новые, Safe-Sharing"),
        ],
        use_memory=False,
        max_new_tokens=512,
    )
    calls = []

    def stream_chat(tier, messages, *_args, **_kwargs):
        calls.append((tier, messages))
        return iter([
            "Monarch Safe — локальное зашифрованное хранилище, а Monarch Sharing — офлайн API для локальных моделей."
        ])

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)

    answer, flags, regenerated = await main_module.maybe_regenerate_for_registry_grounding(
        "gemma4-fast",
        request,
        [],
        "Safe-Sharing — единый модуль для локального API.",
    )

    assert regenerated is True
    assert flags == ["registry_module_omission"]
    assert answer.startswith("Monarch Safe")
    assert calls[0][0] == "gemma4-balanced"
    assert "Regenerate your previous answer" in calls[0][1][-1].content
    assert "Monarch Safe (id=safe)" in calls[0][1][-1].content
    assert "Monarch Sharing (id=sharing)" in calls[0][1][-1].content


def test_live_registry_grounding_rejects_false_clarification_for_known_module():
    request = ChatRequest(
        messages=[
            ChatMessage(
                role="system",
                content=(
                    '<live_monarch_system>{"resolvedMentionIds":["sharing"],'
                    '"modules":[{"id":"sharing","name":"Monarch Sharing","description":"Offline API."}]}'
                    '</live_monarch_system>'
                ),
            ),
            ChatMessage(role="user", content="Sharing модуль"),
        ],
        use_memory=False,
    )

    assert main_module.detect_registry_grounding_flags(
        request,
        "Уточни, пожалуйста, какой модуль ты имеешь в виду.",
    ) == ["registry_module_omission", "registry_false_ambiguity"]


def test_conversation_persists_sources_with_model_metadata(tmp_path: Path):
    store = MemoryStore(make_settings(tmp_path))
    store.append_conversation_message("source-history", "user", "Найди свежие данные")
    store.append_conversation_message(
        "source-history",
        "assistant",
        "Ответ [1]",
        token_count=42,
        elapsed_ms=1200,
        model_tier="gemma4-balanced",
        sources=[ChatSource(id=1, title="Official source", url="https://example.com/fresh", excerpt="Fresh fact")],
    )


def critical_ram_assessment() -> dict:
    return {
        "ram_available_gb": 20.4,
        "estimated_ram_required_gb": 19.7,
        "projected_ram_available_gb": 0.7,
        "ram_warning": "critical",
        "ram_warning_message": "Extra не запущена: закрой лишние программы.",
    }

    message = store.get_conversation("source-history")["messages"][1]
    assert message["model_tier"] == "gemma4-balanced"
    assert message["sources"] == [{
        "id": 1,
        "title": "Official source",
        "url": "https://example.com/fresh",
        "excerpt": "Fresh fact",
        "score": None,
    }]


def test_fresh_web_context_is_restricted_to_current_result_urls(tmp_path: Path):
    store = MemoryStore(make_settings(tmp_path))
    store.upsert_document(
        url="https://stale.example/gpt",
        title="Stale result",
        text="GPT 5.6 stale secondary claim from an earlier search",
        source="web",
    )
    store.upsert_document(
        url="https://official.example/gpt",
        title="Official current result",
        text="GPT 5.6 official current release evidence",
        source="web",
    )

    hits = store.search_urls(
        "GPT 5.6 current release",
        ["https://official.example/gpt"],
        limit=4,
    )
    assert hits
    assert {hit.url for hit in hits} == {"https://official.example/gpt"}


def test_fresh_web_context_preserves_result_priority_and_uses_one_excerpt_per_url(tmp_path: Path):
    store = MemoryStore(make_settings(tmp_path))
    store.upsert_document(
        url="https://official.example/release",
        title="Official release",
        text=("Primary announcement with verified availability. " * 80),
        source="web",
    )
    store.upsert_document(
        url="https://seo.example/speculation",
        title="SEO speculation",
        text=("GPT 5.6 current release specs tokens benchmarks OpenAI. " * 80),
        source="web",
    )

    hits = store.search_urls(
        "GPT 5.6 current release specs tokens benchmarks OpenAI",
        ["https://official.example/release", "https://seo.example/speculation"],
        limit=6,
    )

    assert [hit.url for hit in hits] == [
        "https://official.example/release",
        "https://seo.example/speculation",
    ]
    sources = store.hits_to_sources(hits)
    assert len(sources[0].excerpt) == 900


@pytest.mark.asyncio
async def test_chat_endpoint_consumes_generator_without_stopiteration_runtime_error(monkeypatch):
    def stream_chat(*_args, **_kwargs):
        return iter(["Oscar ", "ok"])

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)

    response = await main_module.chat(ChatRequest(
        messages=[ChatMessage(role="user", content="ping")],
        use_memory=False,
        requested_model="weak",
        max_new_tokens=32,
    ))

    assert response.answer == "Oscar ok"


def test_extra_ram_assessment_uses_host_ram_and_critical_1_5_gb_boundary(monkeypatch, tmp_path: Path):
    settings = make_settings(tmp_path)
    settings.gemma_models_dir = tmp_path / "models"
    runtime = LocalModelRuntime(settings)
    monkeypatch.setattr(runtime_module, "available_system_ram_gb", lambda: 20.4)

    assessment = runtime.ram_assessment("gemma4-31b")

    assert assessment["estimated_ram_required_gb"] == 19.7
    assert assessment["projected_ram_available_gb"] == 0.7
    assert assessment["ram_warning"] == "critical"
    assert "1,5 ГБ" in assessment["ram_warning_message"]


def test_extra_route_preview_exposes_ram_pressure(monkeypatch):
    monkeypatch.setattr(main_module.model_runtime, "ram_assessment", lambda _tier: critical_ram_assessment())

    preview = main_module.preview_chat_route(ChatRequest(
        messages=[ChatMessage(role="user", content="Напиши код")],
        use_memory=False,
        requested_model="gemma4-31b",
        model_selection_source="user-explicit",
        deep_thinking_consent="allow",
        max_new_tokens=32,
    ))

    assert preview.selected_model == "gemma4-31b"
    assert preview.ram_warning == "critical"
    assert preview.projected_ram_available_gb == 0.7


@pytest.mark.asyncio
async def test_chat_blocks_extra_before_loading_when_ram_is_critical(monkeypatch):
    calls = []

    def fail_stream_chat(*_args, **_kwargs):
        calls.append(True)
        raise AssertionError("Extra must not load under critical RAM pressure")

    monkeypatch.setattr(main_module.model_runtime, "ram_assessment", lambda _tier: critical_ram_assessment())
    monkeypatch.setattr(main_module.model_runtime, "stream_chat", fail_stream_chat)

    response = await main_module.chat(ChatRequest(
        messages=[ChatMessage(role="user", content="Напиши код")],
        use_memory=False,
        requested_model="gemma4-31b",
        max_new_tokens=32,
    ))

    assert response.answer == "Extra не запущена: закрой лишние программы."
    assert calls == []


@pytest.mark.asyncio
async def test_chat_stream_reports_ram_pressure_and_finishes_without_loading_extra(monkeypatch):
    calls = []

    def fail_stream_chat(*_args, **_kwargs):
        calls.append(True)
        raise AssertionError("Extra must not load under critical RAM pressure")

    monkeypatch.setattr(main_module.model_runtime, "ram_assessment", lambda _tier: critical_ram_assessment())
    monkeypatch.setattr(main_module.model_runtime, "stream_chat", fail_stream_chat)

    response = await main_module.chat_stream(ChatRequest(
        messages=[ChatMessage(role="user", content="Напиши код")],
        use_memory=False,
        requested_model="gemma4-31b",
        max_new_tokens=32,
    ))
    body = await collect_stream_body(response)

    assert "event: resource" in body
    assert '"ram_warning": "critical"' in body
    assert "закрой лишние программы" in body
    assert '"blocked": true' in body
    assert calls == []


def test_extra_llama_profile_uses_smaller_native_batch(monkeypatch, tmp_path: Path):
    captured = {}

    class FakeLlama:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    settings = make_settings(tmp_path)
    settings.gemma_speculative_decoding = False
    runtime = LocalModelRuntime(settings)
    model_path = tmp_path / "gemma-4-31b-it-Q4_K_M.gguf"
    model_path.touch()
    monkeypatch.setitem(sys.modules, "llama_cpp", SimpleNamespace(Llama=FakeLlama))
    monkeypatch.setattr(runtime_module, "local_cuda_available", lambda: True)

    runtime._load_llama(model_path, n_ctx=4096, n_gpu_layers=15)

    assert captured["n_batch"] == 128
    assert captured["n_ubatch"] == 128
    assert runtime.device_map["batch_tokens"] == "128"


def test_recycle_waits_for_response_flush_and_skips_native_unload(monkeypatch):
    unloads = []
    timers = []

    class FakeTimer:
        def __init__(self, delay, callback):
            self.delay = delay
            self.callback = callback
            self.daemon = False
            self.started = False
            self.cancelled = False
            timers.append(self)

        def start(self):
            self.started = True

        def cancel(self):
            self.cancelled = True

    monkeypatch.setattr(main_module.settings, "auto_unload_after_generation", True)
    monkeypatch.setattr(main_module.settings, "recycle_backend_after_generation", True)
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.setattr(main_module.model_runtime, "unload", lambda: unloads.append(True))
    monkeypatch.setattr(main_module.threading, "Timer", FakeTimer)

    main_module.unload_after_generation()

    assert unloads == []
    assert len(timers) == 1
    assert timers[0].delay == 5.0
    assert timers[0].daemon is True
    assert timers[0].started is True
    main_module.cancel_pending_backend_recycle()


@pytest.mark.asyncio
async def test_new_inference_cancels_stale_backend_recycle(monkeypatch):
    timers = []
    stops = []

    class FakeTimer:
        def __init__(self, delay, callback):
            self.delay = delay
            self.callback = callback
            self.daemon = False
            self.started = False
            self.cancelled = False
            timers.append(self)

        def start(self):
            self.started = True

        def cancel(self):
            self.cancelled = True

    monkeypatch.setattr(main_module.settings, "auto_unload_after_generation", True)
    monkeypatch.setattr(main_module.settings, "recycle_backend_after_generation", True)
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.setattr(main_module.threading, "Timer", FakeTimer)
    monkeypatch.setattr(main_module, "stop_process_tree", lambda: stops.append(True))

    main_module.unload_after_generation()
    stale_timer = timers[-1]
    lease = await main_module.acquire_inference_slot()

    assert lease is not None
    assert stale_timer.cancelled is True
    stale_timer.callback()
    assert stops == []

    main_module.unload_after_generation()
    active_timer = timers[-1]
    active_timer.callback()
    assert stops == []

    lease.release()
    active_timer.callback()
    assert stops == [True]
    main_module.cancel_pending_backend_recycle()


@pytest.mark.asyncio
async def test_chat_honors_exact_one_word_instruction_through_model(monkeypatch):
    calls = []

    def fail_stream_chat(*args, **_kwargs):
        calls.append(args)
        return iter(["готов"])

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", fail_stream_chat)
    response = await main_module.chat(ChatRequest(
        messages=[ChatMessage(role="user", content="Ответь одним словом: готов")],
        use_memory=False,
        max_new_tokens=32,
    ))

    assert response.answer == "готов"
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_chat_endpoint_waits_for_busy_inference_queue(monkeypatch):
    def stream_chat(*_args, **_kwargs):
        return iter(["queued sync"])

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)

    lock = main_module.get_inference_lock()
    await lock.acquire()

    async def release_later() -> None:
        await asyncio.sleep(0.02)
        if lock.locked():
            lock.release()

    release_task = asyncio.create_task(release_later())
    try:
        response = await main_module.chat(ChatRequest(
            messages=[ChatMessage(role="user", content="wait for sync queue")],
            use_memory=False,
            requested_model="weak",
            max_new_tokens=32,
        ))
    finally:
        if lock.locked():
            lock.release()
        await release_task

    assert response.answer == "queued sync"


@pytest.mark.asyncio
async def test_generation_cancel_endpoint_is_idle_safe():
    main_module.model_runtime.reset_generation_cancel()
    main_module.model_runtime.last_error = None

    response = await main_module.generation_cancel()

    assert response["ok"] is True
    assert response["cancelled"] is False
    assert response["queue_busy"] is False
    assert main_module.model_runtime.last_error is None


@pytest.mark.asyncio
async def test_generation_cancel_endpoint_marks_busy_runtime_cancelled():
    main_module.model_runtime.reset_generation_cancel()
    main_module.model_runtime.last_error = None

    lock = main_module.get_inference_lock()
    await lock.acquire()
    try:
        response = await main_module.generation_cancel()
    finally:
        if lock.locked():
            lock.release()
        main_module.model_runtime.reset_generation_cancel()

    assert response["ok"] is True
    assert response["cancelled"] is True
    assert main_module.model_runtime.last_error == "generation cancelled"


@pytest.mark.asyncio
async def test_chat_stream_reports_user_cancellation_without_recovery_answer(monkeypatch):
    def stream_chat(*_args, **_kwargs):
        main_module.model_runtime.cancel_generation()
        return iter(["частичный ответ"])

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)
    response = await main_module.chat_stream(ChatRequest(
        messages=[ChatMessage(role="user", content="Останови этот ответ")],
        use_memory=False,
        requested_model="weak",
        max_new_tokens=32,
    ))
    chunks = []
    async for chunk in response.body_iterator:
        chunks.append(chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk)
    body = "".join(chunks)

    assert '"token": "частичный ответ"' in body
    assert '"cancelled": true' in body
    assert "Генерация остановлена" in body
    assert "Не смог завершить локальную генерацию" not in body
    main_module.model_runtime.reset_generation_cancel()
    main_module.model_runtime.last_error = None


@pytest.mark.asyncio
async def test_chat_stream_ignores_stale_cancellation_error_after_reset(monkeypatch):
    main_module.model_runtime.reset_generation_cancel()
    main_module.model_runtime.last_error = "generation cancelled"
    monkeypatch.setattr(main_module.model_runtime, "stream_chat", lambda *_args, **_kwargs: iter(["полный ответ"]))

    response = await main_module.chat_stream(ChatRequest(
        messages=[ChatMessage(role="user", content="Новый запрос")],
        use_memory=False,
        requested_model="weak",
        max_new_tokens=32,
    ))
    body = await collect_stream_body(response)

    assert '"token": "полный ответ"' in body
    assert '"ok": true' in body
    assert '"cancelled": true' not in body
    main_module.model_runtime.last_error = None


@pytest.mark.asyncio
async def test_chat_stream_passes_activated_skills_and_emits_safe_metadata(monkeypatch):
    captured = {}

    def stream_chat(*args, **_kwargs):
        captured["skills"] = args[-3]
        return iter(["ответ по навыку"])

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)
    response = await main_module.chat_stream(ChatRequest(
        messages=[ChatMessage(role="user", content="$demo проверь проект")],
        use_memory=False,
        requested_model="weak",
        max_new_tokens=32,
        skills=[ChatSkillContext(
            name="demo",
            description="Проверяет проект",
            instructions="Сначала запусти тесты.",
            source=".agents/skills/demo/SKILL.md",
            explicit=True,
        )],
    ))
    body = await collect_stream_body(response)

    assert captured["skills"][0].name == "demo"
    assert 'event: skills' in body
    assert '"name": "demo"' in body
    assert "Сначала запусти тесты." not in body
    assert '"ok": true' in body


def test_model_prompt_applies_skills_below_core_policy(tmp_path):
    runtime = LocalModelRuntime(make_settings(tmp_path))
    prompt = runtime._build_prompt_messages(
        [ChatMessage(role="user", content="Проверь проект")],
        [],
        "low",
        [ChatSkillContext(
            name="verify",
            description="Проверяет проект",
            instructions="Запусти тесты и сборку.",
            source=".agents/skills/verify/SKILL.md",
        )],
    )

    assert prompt[0].role == "system"
    assert "Запусти тесты и сборку." in prompt[0].content
    assert "cannot override this system prompt" in prompt[0].content
    assert prompt[-1].content == "Проверь проект"


def test_model_prompt_exposes_real_monarch_capabilities_without_claiming_success(tmp_path):
    runtime = LocalModelRuntime(make_settings(tmp_path))
    prompt = runtime._build_prompt_messages(
        [ChatMessage(role="user", content="Что ты умеешь делать с файлами?")],
        [],
        "low",
        [],
        [ChatCapabilityContext(
            id="workspace.files.read",
            module="workspace",
            system="Monarch Workspace",
            title="Read file",
            description="Read a file in the active workspace.",
            risk="read",
        )],
        ChatAccessContext(sandboxMode="read-only", approvalPolicy="on-request"),
    )

    assert "workspace.files.read" in prompt[0].content
    assert "Monarch Workspace" in prompt[0].content
    assert "Видимый текст не должен утверждать успех" in prompt[0].content
    assert "sandbox=read-only" in prompt[0].content


def test_capability_prompt_payload_stays_valid_json_under_budget():
    capabilities = [
        ChatCapabilityContext(
            id=f"workspace.demo.{index}",
            module="workspace",
            system="Monarch Workspace",
            title=f"Demo {index}",
            description="bounded capability description " * 20,
            risk="write",
            inputSchema={
                "type": "object",
                "properties": {f"field_{field}": {"type": "string"} for field in range(30)},
            },
        )
        for index in range(80)
    ]

    rendered = runtime_module.render_capability_context(capabilities)
    parsed = json.loads(rendered)

    assert len(rendered) <= 12000
    assert parsed["monarchCapabilities"]
    assert len(parsed["monarchCapabilities"]) <= 48
    assert len(parsed["detailedSchemas"]) <= 8


def test_coder_capability_prompt_includes_all_bounded_schemas():
    capabilities = [
        ChatCapabilityContext(
            id=f"coder.demo.{index}",
            module="coder",
            system="Monarch Coder",
            title=f"Coder {index}",
            description="bounded coder capability",
            risk="write",
            inputSchema={"type": "object", "properties": {"path": {"type": "string"}}},
        )
        for index in range(20)
    ]

    rendered = runtime_module.render_capability_context(capabilities)
    parsed = json.loads(rendered)

    assert len(rendered) <= 12000
    assert len(parsed["monarchCapabilities"]) == 20
    assert len(parsed["detailedSchemas"]) == 20


def test_model_prompt_contains_authoritative_workspace_root(tmp_path):
    settings = make_settings(tmp_path)
    runtime = LocalModelRuntime(settings)

    prompt = runtime._build_prompt_messages(
        [ChatMessage(role="user", content="Где находится твое рабочее пространство?")],
        [],
        "low",
    )

    assert str(settings.workspace_root.resolve()) in prompt[0].content
    assert "Никогда не заменяй этот Windows-путь вымышленным `/workspace`" in prompt[0].content
    assert "Agent operating context" in prompt[0].content
    assert "environment.inspect" in prompt[0].content
    assert "workspace.files.write" in prompt[0].content
    assert "не декоративный чат" in prompt[0].content
    assert "[[MONARCH_ACTION:" in prompt[0].content
    assert "raw tool JSON" in prompt[0].content


def test_conversation_message_create_persists_predispatched_action(monkeypatch, tmp_path):
    store = MemoryStore(make_settings(tmp_path))
    store.create_conversation(conversation_id="predispatch-history")
    monkeypatch.setattr(main_module, "memory", store)

    user = main_module.conversation_message_create(
        "predispatch-history",
        ConversationMessageCreate(role="user", content="Где находится твое рабочее пространство?"),
    )
    assistant = main_module.conversation_message_create(
        "predispatch-history",
        ConversationMessageCreate(
            role="assistant",
            content=f"Точный путь: {make_settings(tmp_path).workspace_root.resolve()}",
            token_count=0,
            elapsed_ms=0,
            model_tier="system",
        ),
    )

    conversation = store.get_conversation("predispatch-history")
    assert user["ok"] is True
    assert assistant["ok"] is True
    assert [message["role"] for message in conversation["messages"]] == ["user", "assistant"]
    assert conversation["messages"][1]["model_tier"] == "system"


def test_memory_and_conversation_api_reject_blank_content(monkeypatch, tmp_path):
    settings = make_settings(tmp_path)
    settings.api_token = "test-token"
    settings.disable_api_token = False
    store = MemoryStore(settings)
    store.create_conversation(conversation_id="blank-content")
    message = store.append_conversation_message("blank-content", "user", "Исходный вопрос")
    memory_item = store.create_memory_item("Исходная заметка", category="other")
    monkeypatch.setattr(main_module, "settings", settings)
    monkeypatch.setattr(main_module, "memory", store)
    client = TestClient(main_module.app, raise_server_exceptions=False)
    headers = {"X-Oscar-Token": "test-token"}

    blank_message = client.post(
        "/api/conversations/blank-content/messages",
        headers=headers,
        json={"role": "user", "content": "   \n\t"},
    )
    blank_memory = client.post(
        "/api/memory/items",
        headers=headers,
        json={"content": "   \n\t", "category": "other"},
    )
    blank_message_update = client.patch(
        f"/api/conversations/blank-content/messages/{message['id']}",
        headers=headers,
        json={"content": "   \n\t"},
    )
    blank_memory_update = client.patch(
        f"/api/memory/items/{memory_item['id']}",
        headers=headers,
        json={"content": "   \n\t"},
    )

    assert blank_message.status_code == 422
    assert blank_memory.status_code == 422
    assert blank_message_update.status_code == 422
    assert blank_memory_update.status_code == 422
    assert [item["content"] for item in store.get_conversation("blank-content")["messages"]] == ["Исходный вопрос"]
    assert [item["content"] for item in store.list_memory_items()] == ["Исходная заметка"]


def test_memory_and_conversation_path_ids_reject_blank_or_oversized_before_store(monkeypatch, tmp_path):
    settings = make_settings(tmp_path)
    settings.api_token = "test-token"
    settings.disable_api_token = False
    calls: list[tuple[str, tuple[object, ...]]] = []

    class FakeMemory:
        def update_memory_item(self, *args, **kwargs):
            calls.append(("update_memory_item", args))
            raise KeyError(args[0])

        def delete_memory_item(self, *args):
            calls.append(("delete_memory_item", args))
            return False

        def get_conversation(self, *args, **kwargs):
            calls.append(("get_conversation", args))
            raise KeyError(args[0])

        def update_conversation(self, *args, **kwargs):
            calls.append(("update_conversation", args))
            raise KeyError(args[0])

        def edit_user_message(self, *args, **kwargs):
            calls.append(("edit_user_message", args))
            raise KeyError(args[1])

        def append_conversation_message(self, *args, **kwargs):
            calls.append(("append_conversation_message", args))
            return None

        def delete_conversation(self, *args):
            calls.append(("delete_conversation", args))
            return False

    monkeypatch.setattr(main_module, "settings", settings)
    monkeypatch.setattr(main_module, "memory", FakeMemory())
    client = TestClient(main_module.app, raise_server_exceptions=False)
    headers = {"X-Oscar-Token": "test-token"}
    oversized = "x" * 65

    cases = [
        ("PATCH", "/api/memory/items/%20%20%20", {"content": "valid memory"}),
        ("DELETE", f"/api/memory/items/{oversized}", None),
        ("GET", "/api/conversations/%20%20%20", None),
        ("PATCH", f"/api/conversations/{oversized}", {"title": "renamed"}),
        ("PATCH", "/api/conversations/valid/messages/%20%20%20", {"content": "updated"}),
        ("POST", f"/api/conversations/{oversized}/messages", {"role": "user", "content": "updated"}),
        ("DELETE", "/api/conversations/%20%20%20", None),
    ]

    responses = [
        client.request(method, path, headers=headers, json=payload)
        for method, path, payload in cases
    ]

    assert [response.status_code for response in responses] == [422] * len(cases)
    assert calls == []


def test_chat_api_rejects_empty_or_blank_message_payloads(monkeypatch, tmp_path):
    settings = make_settings(tmp_path)
    settings.api_token = "test-token"
    settings.disable_api_token = False
    monkeypatch.setattr(main_module, "settings", settings)
    client = TestClient(main_module.app, raise_server_exceptions=False)
    headers = {"X-Oscar-Token": "test-token"}

    cases = [
        {"messages": []},
        {"messages": [{"role": "user", "content": "   \n\t"}]},
        {"messages": [{"role": "system", "content": "system prompt without a user request"}]},
        {"conversation_id": "   \n\t", "messages": [{"role": "user", "content": "Привет"}]},
        {
            "messages": [{"role": "user", "content": "Привет"}],
            "skills": [{"name": "   ", "instructions": "Проверь проект"}],
        },
        {
            "messages": [{"role": "user", "content": "Привет"}],
            "skills": [{"name": "verify", "instructions": "   \n\t"}],
        },
        {
            "messages": [{"role": "user", "content": "Привет"}],
            "capabilities": [{"id": "   ", "module": "workspace", "title": "Read file"}],
        },
        {
            "messages": [{"role": "user", "content": "Привет"}],
            "capabilities": [{"id": "workspace.files.read", "module": "   ", "title": "Read file"}],
        },
        {
            "messages": [{"role": "user", "content": "Привет"}],
            "capabilities": [{"id": "workspace.files.read", "module": "workspace", "title": "   \n\t"}],
        },
        {
            "messages": [{"role": "user", "content": "Привет"}],
            "capabilities": [{
                "id": "workspace.files.read",
                "module": "workspace",
                "title": "Read file",
                "risk": "   ",
            }],
        },
    ]

    for payload in cases:
        response = client.post("/api/chat/route", headers=headers, json=payload)
        assert response.status_code == 422, payload


def test_chat_api_rejects_oversized_message_payloads(monkeypatch, tmp_path):
    settings = make_settings(tmp_path)
    settings.api_token = "test-token"
    settings.disable_api_token = False
    monkeypatch.setattr(main_module, "settings", settings)
    client = TestClient(main_module.app, raise_server_exceptions=False)
    headers = {"X-Oscar-Token": "test-token"}

    oversized_message = client.post(
        "/api/chat/route",
        headers=headers,
        json={"messages": [{"role": "user", "content": "x" * 20001}]},
    )
    oversized_history = client.post(
        "/api/chat/route",
        headers=headers,
        json={
            "messages": [
                {"role": "user" if index == 0 else "assistant", "content": f"message {index}"}
                for index in range(65)
            ]
        },
    )
    oversized_route = client.post(
        "/api/chat/route",
        headers=headers,
        json={
            "messages": [{"role": "user", "content": "Привет"}],
            "route": {
                "intentKind": "x" * 161,
                "modelTier": "medium",
                "riskHint": "read",
                "language": "ru",
            },
        },
    )
    oversized_requested_model = client.post(
        "/api/chat/route",
        headers=headers,
        json={"messages": [{"role": "user", "content": "Привет"}], "requested_model": "x" * 161},
    )
    oversized_capability_schema = client.post(
        "/api/chat/route",
        headers=headers,
        json={
            "messages": [{"role": "user", "content": "Привет"}],
            "capabilities": [{
                "id": "workspace.large.schema",
                "module": "workspace",
                "title": "Large schema",
                "inputSchema": {
                    "type": "object",
                    "description": "x" * 9000,
                },
            }],
        },
    )

    assert oversized_message.status_code == 422
    assert oversized_history.status_code == 422
    assert oversized_route.status_code == 422
    assert oversized_requested_model.status_code == 422
    assert oversized_capability_schema.status_code == 422


@pytest.mark.asyncio
async def test_model_unload_cancels_busy_generation_and_waits(monkeypatch):
    main_module.model_runtime.reset_generation_cancel()
    main_module.model_runtime.last_error = None
    monkeypatch.setattr(main_module.model_runtime, "unload", lambda: {"ok": True})

    lock = main_module.get_inference_lock()
    await lock.acquire()

    async def release_later() -> None:
        await asyncio.sleep(0.02)
        if lock.locked():
            lock.release()

    release_task = asyncio.create_task(release_later())
    try:
        response = await main_module.model_unload()
    finally:
        if lock.locked():
            lock.release()
        await release_task
        main_module.model_runtime.reset_generation_cancel()

    assert response == {"ok": True}
    assert main_module.model_runtime.last_error == "generation cancelled"


@pytest.mark.asyncio
async def test_chat_endpoint_recovers_from_empty_model_answer(monkeypatch):
    def stream_chat(*_args, **_kwargs):
        return iter([" ", "\n"])

    main_module.model_runtime.last_error = None
    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)

    response = await main_module.chat(ChatRequest(
        messages=[ChatMessage(role="user", content="Почему пустой ответ?")],
        use_memory=False,
        requested_model="weak",
        max_new_tokens=32,
    ))

    assert "Не смог завершить локальную генерацию" in response.answer
    assert "Почему пустой ответ?" in response.answer
    assert main_module.model_runtime.last_error == "empty model response"


@pytest.mark.asyncio
async def test_chat_endpoint_generates_identity_answer_instead_of_template(monkeypatch):
    calls = []

    def stream_chat(*args, **_kwargs):
        calls.append(args)
        return iter(["Живой ответ Oscar о себе и MrPastio"])

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)

    response = await main_module.chat(ChatRequest(
        messages=[ChatMessage(role="user", content="Расскажи о себе")],
        use_memory=False,
        web_search=False,
        max_new_tokens=32,
    ))

    assert response.answer == "Живой ответ Oscar о себе и MrPastio"
    assert len(calls) == 1
    assert calls[0][0] == "gemma4-fast"
    assert response.sources == []
    assert response.tool_results == []


@pytest.mark.parametrize(
    ("legacy_name", "expected_tier"),
    [
        ("systemrouter", "gemma4-fast"),
        ("weak", "gemma4-fast"),
        ("medium", "gemma4-balanced"),
        ("powerful", "gemma4-balanced"),
    ],
)
def test_legacy_model_names_resolve_to_gemma_profiles(legacy_name: str, expected_tier: str):
    tier, _fallback = main_module.resolve_chat_tier(ChatRequest(
        messages=[ChatMessage(role="user", content="Проверь маршрутизацию")],
        requested_model=legacy_name,
        use_memory=False,
    ))

    assert tier == expected_tier


def test_auto_deep_thinking_requires_consent_and_falls_back_to_medium():
    request = ChatRequest(
        messages=[ChatMessage(role="user", content="Докажи теорему пошагово")],
        use_memory=False,
    )

    preview = main_module.preview_chat_route(request)
    assert preview.deep_thinking is True
    assert preview.requires_confirmation is True
    assert preview.selected_model == "gemma4-balanced"
    assert main_module.resolve_chat_tier(request)[0] == "gemma4-balanced"

    allowed = request.model_copy(update={"deep_thinking_consent": "allow"})
    denied = request.model_copy(update={"deep_thinking_consent": "deny"})
    assert main_module.resolve_chat_tier(allowed)[0] == "gemma4-deepthinking"
    assert main_module.resolve_chat_tier(denied)[0] == "gemma4-balanced"


def test_scenario_request_routes_to_bounded_deep_research():
    request = ChatRequest(
        messages=[ChatMessage(
            role="user",
            content="Попробуй предположить самый худший сценарий для OpenAI, продуктов и политики после выхода компании на IPO",
        )],
        use_memory=False,
    )

    preview = main_module.preview_chat_route(request)

    assert preview.research_mode == "deep"
    assert preview.research_reason == "scenario-analysis"
    assert preview.research_score >= 0.52
    assert preview.web_search is True
    assert preview.search_reason == "deep-research"
    assert preview.selected_model == "gemma4-balanced"
    assert preview.deep_thinking is False
    assert preview.requires_confirmation is False


def test_elliptical_scenario_followup_keeps_topic_for_route_and_search():
    request = ChatRequest(
        messages=[
            ChatMessage(
                role="user",
                content=(
                    "Попробуй предположить самый худший сценарий для OpenAI, продуктов и политики "
                    "после выхода компании на IPO"
                ),
            ),
            ChatMessage(role="assistant", content="Разобрал худший сценарий по фактам и допущениям."),
            ChatMessage(role="user", content="Теперь давай спрогнозируем самый реалестичный сценарий"),
        ],
        use_memory=False,
    )

    contextual = main_module.contextual_user_query(request)
    preview = main_module.preview_chat_route(request)

    assert "OpenAI" in contextual
    assert "IPO" in contextual
    assert "самый реалестичный сценарий" in contextual
    assert main_module.contextual_web_search_query(request) == contextual
    assert preview.research_mode == "deep"
    assert preview.web_search is True
    assert preview.selected_model == "gemma4-balanced"


def test_new_short_topic_does_not_inherit_previous_research_subject():
    request = ChatRequest(
        messages=[
            ChatMessage(role="user", content="Исследуй худший сценарий для OpenAI после IPO"),
            ChatMessage(role="assistant", content="Готово."),
            ChatMessage(role="user", content="Теперь покажи прогноз погоды для Киева"),
        ],
        use_memory=False,
    )

    assert main_module.contextual_user_query(request) == "Теперь покажи прогноз погоды для Киева"
    assert main_module.preview_chat_route(request).research_mode != "deep"


def test_pronoun_followup_keeps_previous_subject_but_new_topic_does_not():
    assert main_module.is_context_dependent_followup("Как к нему относишься?") is True
    assert main_module.is_context_dependent_followup("Почему он так сделал?") is True
    assert main_module.is_context_dependent_followup("Проверка гипотезы — это что?") is False
    assert main_module.is_context_dependent_followup("Что такое память человека?") is False

    request = ChatRequest(messages=[
        ChatMessage(role="user", content="Кто твой создатель?"),
        ChatMessage(role="assistant", content="Меня создал MrPastio."),
        ChatMessage(role="user", content="Как к нему относишься?"),
    ])
    assert "Кто твой создатель?" in main_module.contextual_user_query(request)


def test_route_preview_hydrates_saved_topic_for_elliptical_followup(monkeypatch, tmp_path: Path):
    store = MemoryStore(make_settings(tmp_path))
    store.append_conversation_message(
        "scenario-followup",
        "user",
        "Предположи худший сценарий для OpenAI, продуктов и политики после IPO",
    )
    store.append_conversation_message("scenario-followup", "assistant", "Разобрал худший сценарий.")
    store.append_conversation_message(
        "scenario-followup",
        "user",
        "Теперь спрогнозируй самый реалистичный сценарий",
    )
    store.append_conversation_message(
        "scenario-followup",
        "assistant",
        "Какой сценарий ты имеешь в виду? Уточни, пожалуйста.",
    )
    monkeypatch.setattr(main_module, "memory", store)

    request = ChatRequest(
        conversation_id="scenario-followup",
        messages=[ChatMessage(role="user", content="Теперь спрогнозируй самый реалистичный сценарий")],
        use_memory=False,
    )
    preview = main_module.chat_route(request)

    assert "OpenAI" in main_module.contextual_user_query(request)
    assert preview.research_mode == "deep"
    assert preview.web_search is True


@pytest.mark.parametrize(
    "requested_model",
    ["gemma4-fast", "gemma4-balanced", "gemma4-deepthinking", "gemma4-31b"],
)
def test_deep_research_planning_is_available_on_every_selected_model(requested_model: str):
    request = ChatRequest(
        messages=[ChatMessage(role="user", content="Исследуй худший сценарий после IPO")],
        research_mode="deep",
        requested_model=requested_model,
        model_selection_source="user-explicit",
        deep_thinking_consent="allow",
        use_memory=False,
    )

    preview = main_module.preview_chat_route(request)

    assert preview.research_mode == "deep"
    assert preview.web_search is True
    assert main_module.resolve_chat_tier(request)[0] == requested_model


@pytest.mark.parametrize(
    "requested_model",
    ["qwen3-coder-30b-a3b-instruct", "deepseek-coder-v2-lite-instruct"],
)
def test_coder_models_are_strict_explicit_tiers_without_deep_thinking_confirmation(requested_model: str):
    request = ChatRequest(
        messages=[ChatMessage(role="user", content="CODER MODE TASK: исправь тест")],
        requested_model=requested_model,
        model_selection_source="user-explicit",
        use_memory=False,
    )

    preview = main_module.preview_chat_route(request)

    assert preview.selected_model == requested_model
    assert preview.requires_confirmation is False
    assert main_module.is_strict_tier_request(request) is True


def test_manual_research_off_prevents_auto_search_for_scenario_request():
    request = ChatRequest(
        messages=[ChatMessage(role="user", content="Предположи худший сценарий для OpenAI после IPO")],
        research_mode="off",
        use_memory=False,
    )

    preview = main_module.preview_chat_route(request)

    assert preview.research_mode == "off"
    assert preview.web_search is False
    assert preview.search_reason == "research-off"


def test_explicit_deep_thinking_requires_confirmation_until_allowed():
    request = ChatRequest(
        messages=[ChatMessage(role="user", content="Разбери задачу")],
        requested_model="gemma4-deepthinking",
        use_memory=False,
        model_selection_source="user-explicit",
    )

    preview = main_module.preview_chat_route(request)
    assert preview.auto_selected is False
    assert preview.requires_confirmation is True
    assert preview.selected_model == "gemma4-balanced"
    assert main_module.resolve_chat_tier(
        request.model_copy(update={"deep_thinking_consent": "allow"})
    )[0] == "gemma4-deepthinking"


def test_chat_schema_rejects_legacy_voice_route_contract():
    payload = {
        "messages": [{"role": "user", "content": "Проанализируй архитектуру"}],
        "route": {
            "interactionMode": "voice",
            "voiceLane": "fast",
            "modelTier": "reasoning",
        },
        "model_selection_source": "voice-router",
    }

    with pytest.raises(ValidationError) as exc_info:
        ChatRequest.model_validate(payload)

    errors = exc_info.value.errors()
    assert any(error["type"] == "extra_forbidden" for error in errors)
    assert any(error["type"] == "literal_error" for error in errors)


def test_web_search_auto_route_detects_fresh_public_model_info():
    automatic = ChatRequest(
        messages=[ChatMessage(role="user", content="Найди информацию про GPT 5.6")],
        use_memory=True,
    )
    local = ChatRequest(
        messages=[ChatMessage(role="user", content="Объясни двоичный поиск")],
        use_memory=True,
    )

    assert main_module.effective_web_search(automatic) == (True, "versioned-public-product")
    assert main_module.effective_web_search(local) == (False, "not-needed")


def test_route_preview_runs_external_model_ranking_as_deep_research():
    request = ChatRequest(
        messages=[ChatMessage(
            role="user",
            content="Найди и выведи мне топ 3 самых умных моделей LLM в диапазоне 2b данных",
        )],
        use_memory=True,
    )

    preview = main_module.preview_chat_route(request)

    assert preview.web_search is True
    assert preview.search_reason == "deep-research"
    assert preview.research_mode == "deep"
    assert preview.research_reason == "comparative-ranking"


@pytest.mark.asyncio
async def test_chat_endpoint_route_hint_floors_python_tier(monkeypatch):
    captured = {}

    def stream_chat(tier, *_args, **_kwargs):
        captured["tier"] = tier
        return iter(["hint ok"])

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)

    response = await main_module.chat(ChatRequest(
        messages=[ChatMessage(role="user", content="ping")],
        route=ChatRouteHint(modelTier="medium", intentKind="chat"),
        use_memory=False,
        max_new_tokens=32,
    ))

    assert response.answer == "hint ok"
    assert captured["tier"] == "gemma4-balanced"


@pytest.mark.asyncio
async def test_chat_endpoint_gemma_override_bypasses_tier_selection(monkeypatch):
    captured = {}

    def fail_tier_selection(*_args, **_kwargs):
        raise AssertionError("Gemma override should bypass normal tier selection")

    def stream_chat(tier, *_args, **_kwargs):
        captured["tier"] = tier
        return iter(["gemma only"])

    monkeypatch.setattr(main_module, "select_model_tier", fail_tier_selection)
    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)

    response = await main_module.chat(ChatRequest(
        messages=[ChatMessage(role="user", content="Ответь через Gemma Mode")],
        route=ChatRouteHint(modelTier="reasoning", intentKind="chat"),
        requested_model="Gemma",
        use_memory=False,
        max_new_tokens=32,
    ))

    assert response.answer == "gemma only"
    assert captured["tier"] == "gemma4-balanced"


@pytest.mark.asyncio
async def test_chat_stream_does_not_quality_regenerate_by_default(monkeypatch):
    calls = []

    def stream_chat(tier, *_args, **_kwargs):
        calls.append(tier)
        return iter(["Я - это я, мой помощник."])

    monkeypatch.delenv("OSCAR_ENABLE_QUALITY_REGENERATION", raising=False)
    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)

    response = await main_module.chat_stream(ChatRequest(
        messages=[ChatMessage(role="user", content="Ответь коротко")],
        use_memory=False,
        requested_model="weak",
        max_new_tokens=32,
    ))
    body = await collect_stream_body(response)

    assert calls == ["gemma4-fast"]
    assert "Я - это я" in body
    assert "event: replace" not in body
    assert '"ok": true' in body


@pytest.mark.asyncio
async def test_chat_stream_logs_streaming_and_gemma_override(monkeypatch, caplog):
    def stream_chat(tier, *_args, **_kwargs):
        return iter([f"{tier} ok"])

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)
    caplog.set_level(logging.INFO)

    response = await main_module.chat_stream(ChatRequest(
        messages=[ChatMessage(role="user", content="Проверь Gemma Mode")],
        use_memory=False,
        requested_model="gemma",
        max_new_tokens=32,
    ))
    await collect_stream_body(response)

    assert '"finalTier": "gemma4-balanced"' in caplog.text
    assert '"streaming": true' in caplog.text
    assert '"gemmaOverride": true' in caplog.text


def test_mock_runtime_does_not_try_to_load_model_files():
    runtime = LocalModelRuntime(Settings(api_token="test", mock_model=True))

    answer = "".join(runtime.stream_chat(
        "weak",
        [ChatMessage(role="user", content="Привет, проверь runtime")],
        [],
        "low",
        32,
        0.2,
        0.9,
    ))

    assert "mock-режиме" in answer
    assert "Ошибка" not in answer
    assert runtime.status().load_strategy == "mock"
    assert runtime.status().last_error is None


def test_prompt_builder_uses_russian_only_base_prompt():
    runtime = LocalModelRuntime(Settings(api_token="test", mock_model=True))

    messages = runtime._build_prompt_messages(
        [ChatMessage(role="user", content="Расскажи о себе")],
        [],
        "low",
    )
    system = messages[0].content

    assert '<oscar_agent_policy version="3.2" language="ru">' in system
    assert "Тебя зовут Oscar" in system
    assert "Тебя и Monarch создал MrPastio" in system
    assert "Никогда не представляйся языковой моделью Google" in system
    assert "Codex создан OpenAI" in system
    assert "создавший Monarch и Codex" not in system
    assert "Главная цель" in system
    assert "You are Oscar" not in system
    assert "Primary objective" not in system


def test_prompt_builder_uses_english_only_base_prompt():
    runtime = LocalModelRuntime(Settings(api_token="test", mock_model=True))

    messages = runtime._build_prompt_messages(
        [ChatMessage(role="user", content="Who are you?")],
        [],
        "low",
    )
    system = messages[0].content

    assert '<oscar_agent_policy version="3.2" language="en">' in system
    assert "Your name is Oscar" in system
    assert "MrPastio created you and Monarch" in system
    assert "Never introduce yourself as a Google language model" in system
    assert "Codex was created by OpenAI" in system
    assert "MrPastio created Monarch and Codex" not in system
    assert "Primary objective" in system
    assert "Главная цель" not in system


def test_prompt_carries_current_turn_date_and_preserves_elliptical_followups():
    runtime = LocalModelRuntime(Settings(api_token="test", mock_model=True))

    messages = runtime._build_prompt_messages(
        [
            ChatMessage(role="user", content="Расскажи о реалистичном сценарии"),
            ChatMessage(role="assistant", content="Краткий сценарий."),
            ChatMessage(role="user", content="ещё больше"),
        ],
        [],
        "low",
    )
    system = messages[0].content

    assert datetime.now().astimezone().date().isoformat() in system
    assert "Сохраняй активную тему диалога" in system
    assert "ещё больше" in system
    assert "один конкретный вопрос" in system


def test_prompt_keeps_agent_catalog_for_short_action_followup():
    runtime = LocalModelRuntime(Settings(api_token="test", mock_model=True))

    messages = runtime._build_prompt_messages(
        [
            ChatMessage(role="user", content="Проверь проект и исправь найденную проблему"),
            ChatMessage(role="assistant", content="Нужно прочитать конфигурацию."),
            ChatMessage(role="user", content="Продолжай"),
        ],
        [],
        "low",
    )
    system = messages[0].content

    assert '<monarch_action_policy version="3.0">' in system
    assert "workspace.files.read" in system
    assert "workspace.files.write" in system
    assert "не обещай сделать позже" in system


def test_simple_chat_prompt_skips_unneeded_agent_catalog_and_environment():
    runtime = LocalModelRuntime(Settings(api_token="test", mock_model=True))

    for request in ("Привет", "Объясни двоичный поиск"):
        messages = runtime._build_prompt_messages(
            [ChatMessage(role="user", content=request)],
            [],
            "low",
        )
        system = messages[0].content

        assert len(system) < 7000
        assert "Agent operating context" not in system
        assert '<monarch_action_policy version="3.0">' not in system
        assert "workspace.files.write" not in system


def test_vision_prompt_requires_pixel_grounded_answer(tmp_path):
    runtime = LocalModelRuntime(make_settings(tmp_path))
    messages = runtime._build_prompt_messages(
        [ChatMessage(role="user", content="Что видно на скриншоте?")],
        [],
        "low",
        has_images=True,
    )

    system = messages[0].content
    assert "только то, что ясно видно" in system
    assert "не выдавай догадку за факт" in system
    assert "не придумывай имена файлов" in system.lower()


def test_quality_gate_flags_broken_identity_answer():
    flags = main_module.detect_quality_flags(
        "Я - это я, мой помощник. Я - Oscar, встроенная ассистент.",
        "ru",
    )

    assert "identity_confusion" in flags


@pytest.mark.parametrize(
    "answer",
    [
        "Я — большая языковая модель, разработанная Google.",
        "Это возможно в рамках моих возможностей как большой языковой модели.",
        "I am a large language model developed by Google.",
    ],
)
def test_quality_gate_regenerates_provider_identity_leaks(answer: str):
    request = ChatRequest(messages=[
        ChatMessage(role="user", content="Кто ты и чем можешь быть полезен?"),
    ])

    flags = main_module.detect_quality_flags(answer, "ru", request)

    assert "provider_identity_leak" in flags
    assert main_module.quality_regeneration_enabled(request, flags) is True


def test_quality_gate_allows_oscar_identity_with_internal_model_fact():
    answer = (
        "Я — Oscar, локальный агент Monarch. "
        "Для генерации текста Monarch может использовать локальную модель Gemma от Google."
    )

    assert "provider_identity_leak" not in main_module.detect_quality_flags(answer, "ru")


def test_quality_gate_flags_false_codex_creator_attribution():
    flags = main_module.detect_quality_flags(
        "MrPastio — соло-разработчик, создавший Monarch и Codex.",
        "ru",
    )

    assert "creator_confusion" in flags


def test_quality_gate_allows_correct_codex_creator_attribution():
    flags = main_module.detect_quality_flags(
        "MrPastio создал Monarch и Oscar. Codex создан OpenAI и помогает в инженерной работе.",
        "ru",
    )

    assert "creator_confusion" not in flags


def test_quality_gate_allows_valid_russian_answer():
    flags = main_module.detect_quality_flags(
        "Monarch — локальная AI-платформа для работы с моделями и инструментами.",
        "ru",
    )

    assert flags == []


def test_quality_gate_detects_creator_repeat_and_irrelevant_identity_fallback():
    request = ChatRequest(messages=[
        ChatMessage(role="user", content="Кто твой создатель?"),
        ChatMessage(role="assistant", content="Меня создал MrPastio."),
        ChatMessage(role="user", content="Как к нему относишься?"),
    ])

    flags = main_module.detect_quality_flags("Меня создал MrPastio.", "ru", request)

    assert "stale_answer_repeat" in flags
    assert "irrelevant_identity_fallback" in flags
    assert main_module.quality_regeneration_enabled(request, flags) is True


def test_quality_gate_allows_creator_fact_for_direct_authorship_question():
    request = ChatRequest(messages=[ChatMessage(role="user", content="Кто твой создатель?")])

    assert "irrelevant_identity_fallback" not in main_module.detect_quality_flags(
        "Меня создал MrPastio.",
        "ru",
        request,
    )


@pytest.mark.parametrize(
    "prompt",
    [
        "росскажи историю твоего создания",
        "Как ты был создан?",
        "Tell me your origin story",
    ],
)
def test_quality_gate_allows_identity_fact_for_creation_history_request(prompt: str):
    request = ChatRequest(messages=[ChatMessage(role="user", content=prompt)])

    flags = main_module.detect_quality_flags("Меня создал MrPastio.", "ru", request)

    assert main_module.is_direct_identity_request(prompt) is True
    assert "irrelevant_identity_fallback" not in flags


def test_unexecuted_tool_promise_is_never_presented_as_a_result():
    request = ChatRequest(
        messages=[ChatMessage(role="user", content="Просмотри какие названия папок в твоей корневой папке")],
        use_memory=False,
    )
    answer = (
        "Для этого мне нужно воспользоваться инструментом `workspace.files.list`. "
        "Сейчас я отправлю запрос к контроллеру Monarch. Ожидаю результат выполнения действия..."
    )

    sanitized = main_module.replace_unexecuted_tool_promise(request, answer)

    assert "Ожидаю результат" not in sanitized
    assert "Действие не выполнено" in sanitized


def test_unexecuted_multi_capability_waiting_claim_is_blocked():
    request = ChatRequest(
        messages=[ChatMessage(role="user", content="Приступайте к выполнению всему по очереди")],
        use_memory=False,
    )
    answer = (
        "Использую `security.status`, `environment.inspect` и `diagnostics.project.report`. "
        "Жду результатов выполнения этих шагов."
    )

    sanitized = main_module.replace_unexecuted_tool_promise(request, answer)

    assert "Жду результатов" not in sanitized
    assert "Действие не выполнено" in sanitized


def test_hidden_monarch_command_is_not_persisted_as_visible_chat_text():
    answer = (
        "Проверяю общую безопасность.\n\n"
        '[[MONARCH_COMMAND:{"command":"security.status{}","reason":"Проверить защиту"}]]'
    )

    assert main_module.strip_hidden_monarch_commands(answer) == "Проверяю общую безопасность."


def test_action_protocol_envelope_is_extracted_and_validated_against_catalog():
    request = ChatRequest(
        messages=[ChatMessage(role="user", content="Создай заметку")],
        use_memory=False,
    )
    answer = (
        "Создаю заметку.\n\n"
        '[[MONARCH_ACTION:{"actions":[{"capabilityId":"workspace.files.write","args":{"path":"note.txt","content":"ok"},"reason":"requested","expectedEffect":"create note"}]}]]'
    )

    visible, proposals = main_module.extract_action_proposals(answer, request)

    assert visible == "Создаю заметку."
    assert proposals == [{
        "version": 1,
        "capabilityId": "workspace.files.write",
        "args": {"path": "note.txt", "content": "ok"},
        "reason": "requested",
        "expectedEffect": "create note",
        "provenance": {"source": "runtime-grammar", "model": main_module.model_runtime.active_tier or "unknown"},
    }]


def test_coder_action_protocol_rejects_default_workspace_capabilities():
    marker = '<monarch_coder_mode>{"project":{"root":"E:\\\\Work"}}</monarch_coder_mode>'
    request = ChatRequest(
        messages=[
            ChatMessage(role="system", content=marker),
            ChatMessage(role="user", content="Create hello.txt"),
        ],
        use_memory=False,
        capabilities=[ChatCapabilityContext(
            id="coder.files.write",
            module="coder",
            system="Monarch Coder",
            title="Write",
            description="Write a project file",
            risk="write",
        )],
    )

    workspace_answer = (
        '[[MONARCH_ACTION:{"actions":[{"capabilityId":"workspace.files.write",'
        '"args":{"path":"hello.txt","content":"ok"}}]}]]'
    )
    coder_answer = (
        '[[MONARCH_ACTION:{"actions":[{"capabilityId":"coder.files.write",'
        '"args":{"path":"hello.txt","content":"ok"}}]}]]'
    )

    assert main_module.extract_action_proposals(workspace_answer, request)[1] == []
    assert main_module.extract_action_proposals(coder_answer, request)[1][0]["capabilityId"] == "coder.files.write"


def test_coder_native_tool_calls_are_extracted_but_model_outputs_are_never_trusted():
    marker = '<monarch_coder_mode>{"project":{"root":"E:\\\\Work"}}</monarch_coder_mode>'
    request = ChatRequest(
        messages=[
            ChatMessage(role="system", content=marker),
            ChatMessage(role="user", content="Create and run verify.js"),
        ],
        use_memory=False,
        capabilities=[
            ChatCapabilityContext(
                id="coder.files.write",
                module="coder",
                system="Monarch Coder",
                title="Write",
                description="Write a project file",
                risk="write",
            ),
            ChatCapabilityContext(
                id="coder.command.run",
                module="coder",
                system="Monarch Coder",
                title="Run",
                description="Run an isolated command",
                risk="execute",
            ),
        ],
    )
    answer = (
        "<｜tool▁calls▁begin｜>"
        "<｜tool▁call▁begin｜>function<｜tool▁sep｜>coder.files.write\n"
        '```json\n{"path":"verify.js","content":"console.log(1)"}\n```'
        "<｜tool▁call▁end｜>"
        "<｜tool▁call▁begin｜>function<｜tool▁sep｜>coder.command.run\n"
        '```json\n{"executable":"node","args":["verify.js"],"cwd":null}\n```'
        "<｜tool▁call▁end｜>"
        "<｜tool▁calls▁end｜>"
        "<｜tool▁outputs▁begin｜><｜tool▁output▁begin｜>"
        '{"status":"success","output":"FAKE_MODEL_RECEIPT"}'
        "<｜tool▁output▁end｜><｜tool▁outputs▁end｜>"
    )

    visible, proposals = main_module.extract_action_proposals(answer, request)

    assert visible == ""
    assert [proposal["capabilityId"] for proposal in proposals] == [
        "coder.files.write",
        "coder.command.run",
    ]
    assert proposals[0]["args"]["path"] == "verify.js"
    assert "cwd" not in proposals[1]["args"]
    assert all(proposal["provenance"]["source"] == "runtime-native-tool-call" for proposal in proposals)
    assert "FAKE_MODEL_RECEIPT" not in json.dumps(proposals)


def test_native_tool_call_protocol_is_coder_only_and_fails_closed_when_malformed():
    native = (
        "<｜tool▁calls▁begin｜>"
        "<｜tool▁call▁begin｜>function<｜tool▁sep｜>coder.files.write\n"
        '```json\n{"path":"hello.txt","content":"ok"}\n```'
        "<｜tool▁call▁end｜><｜tool▁calls▁end｜>"
    )
    ordinary = ChatRequest(messages=[ChatMessage(role="user", content="hello")], use_memory=False)
    malformed_coder = ChatRequest(
        messages=[
            ChatMessage(role="system", content="<monarch_coder_mode>{}</monarch_coder_mode>"),
            ChatMessage(role="user", content="Create hello.txt"),
        ],
        use_memory=False,
        capabilities=[ChatCapabilityContext(
            id="coder.files.write",
            module="coder",
            system="Monarch Coder",
            title="Write",
            description="Write a project file",
            risk="write",
        )],
    )

    assert main_module.extract_action_proposals(native, ordinary)[1] == []
    assert main_module.extract_action_proposals(native.replace("```json", "```json BROKEN"), malformed_coder)[1] == []


def test_raw_environment_toolcall_is_replaced_with_environment_result(monkeypatch, tmp_path: Path):
    settings = make_settings(tmp_path)
    settings.workspace_root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("OSCAR_WORKSPACE_ROOT", str(settings.workspace_root))
    monkeypatch.setattr(main_module, "environment", main_module.EnvironmentScanner(settings))
    request = ChatRequest(
        messages=[ChatMessage(role="user", content="Проверка связи Oscar внутри Monarch Electron.")],
        use_memory=False,
    )

    sanitized = main_module.replace_unexecuted_tool_promise(
        request,
        "<|toolcall|>call: environment.inspect{}<toolcall|>",
    )

    assert "<|toolcall|>" not in sanitized
    assert "environment.inspect" not in sanitized
    assert "Окружение Monarch/Oscar" in sanitized
    assert str(settings.workspace_root.resolve()) in sanitized


def test_raw_json_environment_toolcall_is_replaced(monkeypatch, tmp_path: Path):
    settings = make_settings(tmp_path)
    settings.workspace_root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("OSCAR_WORKSPACE_ROOT", str(settings.workspace_root))
    monkeypatch.setattr(main_module, "environment", main_module.EnvironmentScanner(settings))
    request = ChatRequest(
        messages=[ChatMessage(role="user", content="Проверка связи Oscar внутри Monarch Electron.")],
        use_memory=False,
    )

    sanitized = main_module.replace_unexecuted_tool_promise(
        request,
        '<tool_call>{"name":"environment.inspect","arguments":{}}</tool_call>',
    )

    assert "<tool_call>" not in sanitized
    assert "environment.inspect" not in sanitized
    assert "Окружение Monarch/Oscar" in sanitized


def test_runtime_repairs_common_russian_mojibake():
    assert runtime_module.repair_mojibake_text("Èçîáðàæåíèå íå ïðåäîñòàâëåíî.") == "Изображение не предоставлено."
    assert runtime_module.repair_mojibake_text("Ð¢Ñ‹ Oscar") == "Ты Oscar"
    assert runtime_module.repair_mojibake_text("Нормальный русский текст") == "Нормальный русский текст"
    assert runtime_module.repair_mojibake_text("plain english") == "plain english"


def test_mock_stream_splits_text_into_live_fragments():
    chunks = list(stream_text_fragments("alpha beta gamma", delay_seconds=0))
    spaced_chunks = list(stream_text_fragments("  alpha beta", delay_seconds=0))

    assert chunks == ["alpha ", "beta ", "gamma"]
    assert spaced_chunks == ["  ", "alpha ", "beta"]


def test_model_load_fallback_hides_raw_exception_from_user(monkeypatch, tmp_path: Path):
    (tmp_path / "gemma-4-E2B-it-Q5_K_M.gguf").write_bytes(b"GGUF")
    (tmp_path / "gemma-4-12B-it-Q4_K_M.gguf").write_bytes(b"GGUF")
    runtime = LocalModelRuntime(Settings(
        api_token="test",
        gemma_models_dir=tmp_path,
        mock_fallback=True,
    ))

    def fail_load(_model_file, **_kwargs):
        raise RuntimeError("secret loader failure")

    monkeypatch.setattr(runtime, "_load_llama", fail_load)

    answer = "".join(runtime.stream_chat(
        "weak",
        [ChatMessage(role="user", content="Ответь на русском")],
        [],
        "low",
        32,
        0.2,
        0.9,
    ))

    assert "fallback-режим" in answer
    assert "secret loader failure" not in answer
    assert "secret loader failure" in (runtime.status().last_error or "")


def test_gemma_status_tracks_partial_download(tmp_path: Path):
    gemma_root = tmp_path / "gemma_models"
    model_dir = gemma_root / "Gemma_12B"
    vision_dir = gemma_root / "vision_other"
    model_dir.mkdir(parents=True)
    vision_dir.mkdir(parents=True)
    (model_dir / "gemma-4-12B-it-Q4_K_M.gguf.crdownload").write_bytes(b"partial")
    (vision_dir / "mmproj-BF16_12B.gguf").write_bytes(b"GGUFvision")

    runtime = LocalModelRuntime(Settings(api_token="test", gemma_models_dir=gemma_root, mock_fallback=True))
    status = runtime.status()

    assert status.gemma_model_ready is False
    assert status.gemma_vision_ready is True
    assert status.gemma_partial_path.endswith(".crdownload")

    answer = "".join(runtime.stream_chat(
        "gemma",
        [ChatMessage(role="user", content="Ответь на русском")],
        [],
        "low",
        32,
        0.2,
        0.9,
    ))

    assert "fallback-режим" in answer
    assert "crdownload" not in answer
    assert "still downloading" in (runtime.status().last_error or "")


def test_gemma_load_force_refreshes_asset_cache_after_download_finishes(monkeypatch, tmp_path: Path):
    gemma_root = tmp_path / "gemma_models"
    model_dir = gemma_root / "Gemma_12B"
    model_dir.mkdir(parents=True)
    partial = model_dir / "gemma-4-12B-it-Q4_K_M.gguf.crdownload"
    model_path = model_dir / "gemma-4-12B-it-Q4_K_M.gguf"
    partial.write_bytes(b"partial")
    runtime = LocalModelRuntime(Settings(
        api_token="test",
        gemma_models_dir=gemma_root,
        mock_model=False,
        mock_fallback=False,
    ))
    assert runtime.status().gemma_model_ready is False

    partial.unlink()
    model_path.write_bytes(b"GGUFmodel")
    loaded = []
    monkeypatch.setattr(runtime, "_load_llama", lambda path, **_kwargs: loaded.append(path))
    runtime.load_tier("gemma4-balanced", allow_fallback=False)

    assert loaded == [model_path]


def test_unloaded_status_does_not_initialize_native_cuda_runtime(monkeypatch, tmp_path: Path):
    runtime = LocalModelRuntime(Settings(api_token="test", gemma_models_dir=tmp_path))
    monkeypatch.setattr(runtime_module, "lightweight_cuda_runtime_present", lambda: True)

    def unexpected_native_probe():
        raise AssertionError("native CUDA probe must stay lazy until model load")

    monkeypatch.setattr(runtime_module, "local_cuda_available", unexpected_native_probe)

    assert runtime.status().gpu_offload_available is True


def test_invalid_fast_gguf_falls_back_to_valid_balanced_model(monkeypatch, tmp_path: Path):
    gemma_root = tmp_path / "gemma_models"
    fast_dir = gemma_root / "Gemma_E2B"
    balanced_dir = gemma_root / "Gemma_12B"
    fast_dir.mkdir(parents=True)
    balanced_dir.mkdir(parents=True)
    (fast_dir / "gemma-4-E2B-it-Q5_K_M.gguf").write_bytes(b"\x00" * 16)
    balanced_path = balanced_dir / "gemma-4-12B-it-Q4_K_M.gguf"
    balanced_path.write_bytes(b"GGUFmodel")

    runtime = LocalModelRuntime(Settings(
        api_token="test",
        gemma_models_dir=gemma_root,
        mock_model=False,
        mock_fallback=False,
    ))
    loaded = []

    def remember_load(model_path, **_kwargs):
        loaded.append(model_path)

    monkeypatch.setattr(runtime, "_load_llama", remember_load)
    runtime.load_tier("gemma4-fast")

    assert loaded == [balanced_path]
    assert runtime.active_tier == "gemma4-balanced"
    assert runtime.loaded is True
    assert runtime.fallback_active is True
    assert runtime.load_attempts and "not a valid GGUF" in runtime.load_attempts[0]


def test_legacy_weak_alias_uses_only_gemma_fast(monkeypatch, tmp_path: Path):
    gemma_root = tmp_path / "gemma_models"
    fast_dir = gemma_root / "Gemma_E2B"
    fast_dir.mkdir(parents=True)
    fast_path = fast_dir / "gemma-4-E2B-it-Q5_K_M.gguf"
    fast_path.write_bytes(b"GGUFfast")

    runtime = LocalModelRuntime(Settings(
        api_token="test",
        gemma_models_dir=gemma_root,
        mock_model=False,
        mock_fallback=False,
    ))
    loaded = []

    def remember_load(model_path, **_kwargs):
        loaded.append(model_path)

    monkeypatch.setattr(runtime, "_load_llama", remember_load)
    runtime.load_tier("weak")

    assert loaded == [fast_path]
    assert runtime.active_tier == "gemma4-fast"
    assert runtime.load_attempts == []


def test_balanced_tier_uses_hybrid_gpu_plan(monkeypatch, tmp_path: Path):
    gemma_root = tmp_path / "gemma_models"
    balanced_dir = gemma_root / "Gemma_12B"
    balanced_dir.mkdir(parents=True)
    (balanced_dir / "gemma-4-12B-it-Q4_K_M.gguf").write_bytes(b"GGUFbalanced")

    runtime = LocalModelRuntime(Settings(
        api_token="test",
        gemma_models_dir=gemma_root,
        mock_model=False,
        mock_fallback=False,
    ))
    loaded = []
    monkeypatch.setattr(runtime, "_load_llama", lambda model_path, **kwargs: loaded.append((model_path, kwargs)))

    runtime.load_tier("gemma4-balanced")

    assert loaded[0][0] == balanced_dir / "gemma-4-12B-it-Q4_K_M.gguf"
    assert loaded[0][1]["n_gpu_layers"] == 30
    assert runtime.active_tier == "gemma4-balanced"


def test_gemma_mtp_draft_is_passed_only_for_text_generation(monkeypatch, tmp_path: Path):
    gemma_root = tmp_path / "gemma_models"
    fast_dir = gemma_root / "Gemma_E2B"
    draft_dir = gemma_root / "mtp_model"
    vision_dir = gemma_root / "vision_other"
    fast_dir.mkdir(parents=True)
    draft_dir.mkdir(parents=True)
    vision_dir.mkdir(parents=True)
    model_path = fast_dir / "gemma-4-E2B-it-Q5_K_M.gguf"
    draft_path = draft_dir / "mtp-gemma-4-E2B-it.gguf"
    vision_path = vision_dir / "mmproj-BF16_E2B.gguf"
    model_path.write_bytes(b"GGUFmodel")
    draft_path.write_bytes(b"GGUFdraft")
    vision_path.write_bytes(b"GGUFvision")

    runtime = LocalModelRuntime(Settings(
        api_token="test",
        gemma_models_dir=gemma_root,
        mock_model=False,
        mock_fallback=False,
    ))
    loaded = []
    monkeypatch.setattr(runtime, "_load_llama", lambda model_path, **kwargs: loaded.append((model_path, kwargs)))

    status = runtime.status()
    assert status.gemma_draft_ready is False
    assert status.speculative_status == "missing"

    runtime.load_tier("gemma4-fast")
    assert loaded[-1][0] == model_path
    assert loaded[-1][1]["draft_path"] == draft_path
    assert loaded[-1][1]["vision_path"] is None
    status = runtime.status()
    assert status.gemma_draft_ready is True
    assert status.gemma_draft_model_path == str(draft_path)
    assert status.gemma_draft_mode == "mtp"
    assert status.speculative_status == "available"

    runtime.unload()
    runtime.load_tier("gemma4-fast", require_vision=True)
    assert loaded[-1][0] == model_path
    assert loaded[-1][1]["draft_path"] is None
    assert loaded[-1][1]["vision_path"] == vision_path


@pytest.mark.parametrize(
    ("tier", "directory", "filename", "expected_layers"),
    [
        ("gemma4-deepthinking", "Gemma_26B", "gemma-4-26B-A4B-it-UD-Q4_K_M.gguf", 18),
        ("gemma4-31b", "Gemma_31B", "gemma-4-31B-it-Q4_K_M.gguf", 15),
    ],
)
def test_large_gemma_tiers_use_vram_safe_hybrid_plans(
    monkeypatch,
    tmp_path: Path,
    tier: str,
    directory: str,
    filename: str,
    expected_layers: int,
):
    gemma_root = tmp_path / "gemma_models"
    model_dir = gemma_root / directory
    model_dir.mkdir(parents=True)
    model_path = model_dir / filename
    model_path.write_bytes(b"GGUFmodel")
    runtime = LocalModelRuntime(Settings(
        api_token="test",
        gemma_models_dir=gemma_root,
        mock_model=False,
        mock_fallback=False,
    ))
    loaded = []
    monkeypatch.setattr(runtime, "_load_llama", lambda path, **kwargs: loaded.append((path, kwargs)))

    runtime.load_tier(tier)

    assert loaded[0][0] == model_path
    assert loaded[0][1]["n_gpu_layers"] == expected_layers
    assert loaded[0][1]["n_ctx"] == 8192


def test_explicit_31b_replaces_loaded_26b_instead_of_reusing_it(monkeypatch, tmp_path: Path):
    gemma_root = tmp_path / "gemma_models"
    deep_dir = gemma_root / "Gemma_26B"
    extra_dir = gemma_root / "Gemma_31B"
    deep_dir.mkdir(parents=True)
    extra_dir.mkdir(parents=True)
    deep_path = deep_dir / "gemma-4-26B-A4B-it-UD-Q4_K_M.gguf"
    extra_path = extra_dir / "gemma-4-31B-it-Q4_K_M.gguf"
    deep_path.write_bytes(b"GGUFdeep")
    extra_path.write_bytes(b"GGUFextra")
    runtime = LocalModelRuntime(Settings(
        api_token="test",
        gemma_models_dir=gemma_root,
        mock_fallback=False,
    ))
    loaded = []
    monkeypatch.setattr(runtime, "_load_llama", lambda path, **kwargs: loaded.append((path, kwargs)))

    runtime.load_tier("gemma4-deepthinking")
    runtime.load_tier("gemma4-31b", allow_fallback=False)

    assert [entry[0] for entry in loaded] == [deep_path, extra_path]
    assert runtime.active_tier == "gemma4-31b"
    assert runtime.fallback_active is False


def test_31b_skips_speculative_draft_when_it_would_cross_ram_floor(monkeypatch, tmp_path: Path):
    gemma_root = tmp_path / "gemma_models"
    extra_dir = gemma_root / "Gemma_31B"
    draft_dir = gemma_root / "mtp_model"
    extra_dir.mkdir(parents=True)
    draft_dir.mkdir(parents=True)
    model_path = extra_dir / "gemma-4-31B-it-Q4_K_M.gguf"
    draft_path = draft_dir / "mtp-gemma-4-31B-it.gguf"
    model_path.write_bytes(b"GGUFmodel")
    draft_path.write_bytes(b"GGUFdraft")
    runtime = LocalModelRuntime(Settings(
        api_token="test",
        gemma_models_dir=gemma_root,
        mock_fallback=False,
    ))
    loaded = []
    monkeypatch.setattr(runtime_module, "available_system_ram_gb", lambda: 4.0)
    monkeypatch.setattr(runtime, "_load_llama", lambda path, **kwargs: loaded.append((path, kwargs)))

    runtime.load_tier("gemma4-31b", allow_fallback=False)

    assert loaded[0][0] == model_path
    assert loaded[0][1]["draft_path"] is None
    assert any("speculative draft skipped" in attempt for attempt in runtime.load_attempts)


def test_deepthinking_preserves_history_and_reports_real_context_window():
    class ContextLlama:
        def tokenize(self, value, **_kwargs):
            text = value.decode("utf-8")
            return list(range(max(1, len(text) // 4)))

        def create_chat_completion(self, **_kwargs):
            yield {"choices": [{"delta": {"content": "помню"}}]}

    runtime = LocalModelRuntime(Settings(api_token="test", mock_fallback=False))
    runtime.loaded = True
    runtime.active_tier = "gemma4-deepthinking"
    runtime._llama_model = ContextLlama()
    messages = [
        ChatMessage(role="user", content="Кодовое слово: янтарь. " + "важный контекст " * 180),
        ChatMessage(role="assistant", content="Запомнил кодовое слово и контекст."),
        ChatMessage(role="user", content="Какое кодовое слово я назвал?"),
    ]

    answer = "".join(runtime.stream_chat(
        "gemma4-deepthinking",
        messages,
        [],
        "low",
        4096,
        0.2,
        0.9,
        strict_tier=True,
    ))

    assert answer == "помню"
    assert runtime.last_context_window["context_tokens"] == 8192
    assert runtime.last_context_window["dropped_messages"] == 0
    status = runtime.status()
    assert status.active_context_tokens == 8192
    assert status.last_context_window["dropped_messages"] == 0


def test_gemma_text_tier_does_not_force_vision_adapter(monkeypatch, tmp_path: Path):
    gemma_root = tmp_path / "gemma_models"
    model_dir = gemma_root / "Gemma_12B"
    vision_dir = gemma_root / "vision_other"
    model_dir.mkdir(parents=True)
    vision_dir.mkdir(parents=True)
    model_path = model_dir / "gemma-4-12B-it-Q4_K_M.gguf"
    vision_path = vision_dir / "mmproj-BF16_12B.gguf"
    model_path.write_bytes(b"GGUFmodel")
    vision_path.write_bytes(b"GGUFvision")

    runtime = LocalModelRuntime(Settings(
        api_token="test",
        gemma_models_dir=gemma_root,
        gemma_context_tokens=6144,
        gemma4_balanced_gpu_layers=7,
        mock_fallback=False,
    ))
    captured = {}

    def fake_load(model_file, **kwargs):
        captured["model_file"] = model_file
        captured.update(kwargs)

    monkeypatch.setattr(runtime, "_load_llama", fake_load)

    runtime.load_tier("gemma")

    assert runtime.loaded is True
    assert runtime.active_tier == "gemma4-balanced"
    assert captured["model_file"] == model_path
    assert captured["vision_path"] is None
    assert captured["n_ctx"] == 6144
    assert captured["n_gpu_layers"] == 7

    runtime.unload()
    runtime.load_tier("gemma", require_vision=True)

    assert captured["model_file"] == model_path
    assert captured["vision_path"] == vision_path


def test_configure_nvidia_dll_directories_is_idempotent(monkeypatch, tmp_path: Path):
    nvidia_root = tmp_path / "Lib" / "site-packages" / "nvidia"
    for relative in ("cublas/bin", "cuda_runtime/bin", "nvjitlink/bin"):
        (nvidia_root / relative).mkdir(parents=True)

    added = []
    monkeypatch.setattr(runtime_module.os, "name", "nt", raising=False)
    monkeypatch.setattr(runtime_module.sys, "prefix", str(tmp_path))
    monkeypatch.setenv("PATH", "C:\\Windows\\System32")
    monkeypatch.setattr(runtime_module, "_DLL_DIRECTORY_HANDLES", [])
    monkeypatch.setattr(runtime_module, "_DLL_DIRECTORY_PATHS", set())
    monkeypatch.setattr(
        runtime_module.os,
        "add_dll_directory",
        lambda directory: added.append(directory) or object(),
        raising=False,
    )

    runtime_module.configure_nvidia_dll_directories()
    first_path = runtime_module.os.environ["PATH"]
    runtime_module.configure_nvidia_dll_directories()

    assert runtime_module.os.environ["PATH"] == first_path
    assert first_path.count(str(nvidia_root / "cublas" / "bin")) == 1
    assert first_path.count(str(nvidia_root / "cuda_runtime" / "bin")) == 1
    assert first_path.count(str(nvidia_root / "nvjitlink" / "bin")) == 1
    assert added == [
        str(nvidia_root / "cublas" / "bin"),
        str(nvidia_root / "cuda_runtime" / "bin"),
        str(nvidia_root / "nvjitlink" / "bin"),
    ]


def test_configure_nvidia_dll_directories_skips_oversized_path(monkeypatch, tmp_path: Path, caplog):
    nvidia_root = tmp_path / "Lib" / "site-packages" / "nvidia"
    for relative in ("cublas/bin", "cuda_runtime/bin", "nvjitlink/bin"):
        (nvidia_root / relative).mkdir(parents=True)

    oversized_path = "C:\\" + ("x" * 32765)
    fake_environ = {"PATH": oversized_path}
    monkeypatch.setattr(runtime_module.os, "name", "nt", raising=False)
    monkeypatch.setattr(runtime_module.sys, "prefix", str(tmp_path))
    monkeypatch.setattr(runtime_module.os, "environ", fake_environ)
    monkeypatch.setattr(runtime_module, "_DLL_DIRECTORY_HANDLES", [])
    monkeypatch.setattr(runtime_module, "_DLL_DIRECTORY_PATHS", set())
    monkeypatch.setattr(runtime_module.os, "add_dll_directory", lambda _directory: object(), raising=False)

    with caplog.at_level(logging.WARNING):
        runtime_module.configure_nvidia_dll_directories()

    assert fake_environ["PATH"] == oversized_path
    assert "Windows environment limit" in caplog.text


def test_gemma_vision_uses_native_gemma4_chat_handler(monkeypatch, tmp_path: Path):
    runtime_module.configure_nvidia_dll_directories()
    import llama_cpp
    import llama_cpp.llama_chat_format as chat_format

    created = {}

    class FakeGemma4ChatHandler:
        def __init__(self, clip_model_path: str, verbose: bool = True):
            created["clip_model_path"] = clip_model_path
            created["verbose"] = verbose

    class FakeLlama:
        def __init__(self, **kwargs):
            created["llama_kwargs"] = kwargs

    monkeypatch.setattr(chat_format, "Gemma4ChatHandler", FakeGemma4ChatHandler)
    monkeypatch.setattr(llama_cpp, "Llama", FakeLlama)
    monkeypatch.setattr(runtime_module, "local_cuda_available", lambda: True)

    model_path = tmp_path / "gemma-4-12B-it-Q4_K_M.gguf"
    vision_path = tmp_path / "mmproj-BF16_12B.gguf"
    model_path.write_bytes(b"GGUFmodel")
    vision_path.write_bytes(b"GGUFvision")

    runtime = LocalModelRuntime(Settings(api_token="test", mock_fallback=False))
    runtime._load_llama(model_path, vision_path=vision_path, n_ctx=2048, n_gpu_layers=3)

    assert isinstance(created["llama_kwargs"]["chat_handler"], FakeGemma4ChatHandler)
    assert created["clip_model_path"] == str(vision_path)
    assert created["verbose"] is False
    assert runtime._vision_enabled is True
    assert runtime.load_strategy == "llama.cpp+cuda+gemma4-vision"
    assert runtime.device_map["vision_handler"] == "Gemma4ChatHandler"


def test_cuda_oom_retries_with_smaller_hybrid_offload(monkeypatch, tmp_path: Path):
    runtime_module.configure_nvidia_dll_directories()
    import llama_cpp

    attempts = []

    class FakeLlama:
        def __init__(self, **kwargs):
            attempts.append(kwargs["n_gpu_layers"])
            if kwargs["n_gpu_layers"] == 30:
                raise RuntimeError("CUDA out of memory while allocating buffer")

    monkeypatch.setattr(llama_cpp, "Llama", FakeLlama)
    monkeypatch.setattr(runtime_module, "local_cuda_available", lambda: True)
    model_path = tmp_path / "gemma-4-12B-it-Q4_K_M.gguf"
    model_path.write_bytes(b"GGUFmodel")
    runtime = LocalModelRuntime(Settings(api_token="test", mock_fallback=False))

    runtime._load_llama(model_path, n_ctx=4096, n_gpu_layers=30)

    assert attempts == [30, 24]
    assert runtime.device_map["backend"] == "cuda"
    assert runtime.device_map["gpu_layers"] == "24"
    assert runtime.device_map["gpu_layers_requested"] == "30"
    assert runtime.load_attempts


def test_gemma_status_marks_unsupported_vision_runtime(tmp_path: Path):
    gemma_root = tmp_path / "gemma_models"
    vision_dir = gemma_root / "vision_other"
    vision_dir.mkdir(parents=True)
    (vision_dir / "mmproj-BF16_12B.gguf").write_bytes(b"GGUFvision")

    runtime = LocalModelRuntime(Settings(api_token="test", gemma_models_dir=gemma_root))
    runtime.last_error = "Gemma vision adapter could not be loaded by the installed llama.cpp backend."

    status = runtime.status()

    assert status.gemma_vision_runtime_status == "unsupported"
    assert "text mode still works" in (status.gemma_vision_note or "")


def test_gemma_status_marks_mtmd_failure_unsupported(tmp_path: Path):
    gemma_root = tmp_path / "gemma_models"
    vision_dir = gemma_root / "vision_other"
    vision_dir.mkdir(parents=True)
    (vision_dir / "mmproj-BF16_12B.gguf").write_bytes(b"GGUFvision")

    runtime = LocalModelRuntime(Settings(api_token="test", gemma_models_dir=gemma_root))
    runtime._vision_enabled = True
    runtime._vision_handler_name = "Gemma4ChatHandler"
    runtime.last_error = "Failed to load mtmd context from: adapter.gguf"

    status = runtime.status()

    assert status.gemma_vision_runtime_status == "unsupported"
    assert "text mode still works" in (status.gemma_vision_note or "")


def test_gemma_image_attachment_formats_llama_multimodal_message():
    runtime = LocalModelRuntime(Settings(api_token="test", mock_model=True))
    image = ChatImageAttachment(
        mime_type="image/png",
        data_base64=base64.b64encode(b"fake-png").decode("ascii"),
        name="screen.png",
        size_bytes=8,
    )

    formatted = runtime._format_llama_messages(
        [ChatMessage(role="system", content="sys"), ChatMessage(role="user", content="Что на экране?")],
        [image],
    )

    assert formatted[1]["role"] == "user"
    assert formatted[1]["content"][0]["type"] == "image_url"
    assert formatted[1]["content"][0]["image_url"]["url"].startswith("data:image/png;base64,")
    assert formatted[1]["content"][1] == {"type": "text", "text": "Что на экране?"}


def test_generation_error_activates_clean_fallback():
    class FailingLlama:
        def create_chat_completion(self, **_kwargs):
            raise RuntimeError("Failed to load mtmd context from: adapter.gguf")

    image = ChatImageAttachment(
        mime_type="image/png",
        data_base64=base64.b64encode(b"fake-png").decode("ascii"),
        name="screen.png",
        size_bytes=8,
    )
    runtime = LocalModelRuntime(Settings(api_token="test", mock_fallback=True))
    runtime.loaded = True
    runtime.active_tier = "gemma"
    runtime.load_strategy = "llama.cpp+gemma4-vision"
    runtime.device_map = {"vision_handler": "Gemma4ChatHandler"}
    runtime._llama_model = FailingLlama()
    runtime._vision_enabled = True
    runtime._vision_handler_name = "Gemma4ChatHandler"

    answer = "".join(runtime.stream_chat(
        "gemma",
        [ChatMessage(role="user", content="Что на картинке?")],
        [],
        "low",
        32,
        0.2,
        0.9,
        [image],
    ))

    assert "fallback-режим" in answer
    assert runtime.fallback_active is True
    assert runtime.load_strategy == "fallback-mock"
    assert runtime.device_map == {"fallback-mock": "cpu"}
    assert "Запрос принят" not in answer
    assert "Доступный контекст" not in answer


def test_runtime_compacts_history_skills_and_capabilities_before_generation():
    captured = {}

    class BudgetedLlama:
        def tokenize(self, value, **_kwargs):
            text = value.decode("utf-8")
            return list(range(max(1, len(text) // 4)))

        def create_chat_completion(self, **kwargs):
            captured.update(kwargs)
            yield {"choices": [{"delta": {"content": "Готово"}}]}

    runtime = LocalModelRuntime(Settings(
        api_token="test",
        mock_fallback=False,
        gemma_context_tokens=512,
        default_max_new_tokens=128,
    ))
    runtime.loaded = True
    runtime.active_tier = "gemma4-fast"
    runtime._llama_model = BudgetedLlama()

    messages = [
        ChatMessage(role="user", content="старый вопрос " * 180),
        ChatMessage(role="assistant", content="старый ответ " * 180),
        ChatMessage(role="user", content="последний вопрос должен сохраниться"),
    ]
    skills = [ChatSkillContext(
        name="deep-security-scan",
        description="security",
        instructions="длинная инструкция " * 500,
        source="skill.md",
    )]
    capabilities = [ChatCapabilityContext(
        id=f"workspace.demo.{index}",
        module="workspace",
        title=f"Demo {index}",
    ) for index in range(24)]

    answer = "".join(runtime.stream_chat(
        "gemma4-fast",
        messages,
        [],
        "low",
        4096,
        0.2,
        0.9,
        skill_context=skills,
        capability_context=capabilities,
    ))

    assert answer == "Готово"
    assert runtime.fallback_active is False
    assert runtime.last_context_window["context_trimmed"] is True
    assert runtime.last_context_window["dropped_messages"] == 2
    assert runtime.last_context_window["input_tokens"] <= runtime.last_context_window["input_limit"]
    assert captured["max_tokens"] <= 128
    assert captured["messages"][-1]["content"] == "последний вопрос должен сохраниться"


def test_compaction_trims_oversized_system_before_short_recent_dialogue():
    class TokenCounter:
        def tokenize(self, value, **_kwargs):
            text = value.decode("utf-8")
            return list(range(max(1, len(text) // 4)))

    runtime = LocalModelRuntime(Settings(api_token="test", mock_fallback=False))
    runtime._llama_model = TokenCounter()
    dialogue = [
        runtime_module.PromptMessage(role="user", content="Кто твой создатель?"),
        runtime_module.PromptMessage(role="assistant", content="Меня создал MrPastio."),
        runtime_module.PromptMessage(role="user", content="Как к нему относишься?"),
        runtime_module.PromptMessage(role="assistant", content="Я ценю его работу над Monarch."),
        runtime_module.PromptMessage(role="user", content="Расскажи подробнее."),
    ]
    messages = [runtime_module.PromptMessage(role="system", content="policy context " * 3000), *dialogue]

    compacted, dropped, trimmed = runtime._compact_prompt_messages(messages, 1200)

    assert trimmed is True
    assert dropped == 0
    assert [message.content for message in compacted[1:]] == [message.content for message in dialogue]
    assert runtime._count_chat_tokens(compacted) <= 1200


@pytest.mark.parametrize("query", [
    "Кто твой создатель?",
    "Как ты относишься к своему создателю?",
    "Расскажи историю создания Monarch",
    "Почему изменение климата опасно?",
    "Что означает командная работа?",
    "Проверка гипотезы — это что?",
    "Что такое память человека?",
])
def test_semantic_questions_do_not_receive_agent_action_contract(query):
    assert runtime_module.prompt_needs_agent_context(query) is False


@pytest.mark.parametrize("query", [
    "Создай файл notes.txt",
    "Проверь проект и исправь баг",
    "Какими инструментами ты можешь пользоваться?",
    "Чем ты можешь быть полезен?",
    "Можешь выполнять агентские функции?",
    "Can you act as an agent?",
])
def test_real_agent_requests_still_receive_action_contract(query):
    assert runtime_module.prompt_needs_agent_context(query) is True


@pytest.mark.parametrize("query", [
    "Объясни квадратный корень",
    "Каков путь героя в романе?",
    "Опиши окружение персонажа",
    "Что означает статус-кво?",
    "Установленная традиция",
    "Расскажи про Python",
])
def test_ordinary_semantics_do_not_receive_environment_dump(query):
    assert runtime_module.prompt_needs_environment_context(query) is False


@pytest.mark.parametrize("query", [
    "Где находится корень workspace?",
    "Проверь runtime Oscar",
    "Сколько оперативной памяти доступно?",
])
def test_real_environment_queries_still_receive_environment_context(query):
    assert runtime_module.prompt_needs_environment_context(query) is True


def test_runtime_compacts_internal_system_prompt_beyond_external_message_limit():
    runtime = LocalModelRuntime(Settings(
        api_token="test",
        mock_fallback=False,
        gemma_context_tokens=512,
        default_max_new_tokens=128,
    ))
    messages = [
        ChatMessage(role="system", content="локальный пользовательский контекст " + ("x" * 12_000)),
        ChatMessage(role="user", content="создай папку в рабочем пространстве"),
    ]
    skills = [ChatSkillContext(
        name="workspace-workflow",
        description="workspace",
        instructions="длинная инструкция " * 500,
        source="skill.md",
    )]
    capabilities = [ChatCapabilityContext(
        id=f"workspace.demo.{index}",
        module="workspace",
        title=f"Demo {index}",
        description="Проверяемая capability рабочего пространства " * 8,
    ) for index in range(24)]

    assembled = runtime._build_prompt_messages(
        messages,
        [],
        "low",
        skills,
        capabilities,
    )
    assert len(assembled[0].content) > 20_000

    compacted, _max_new_tokens, metadata = runtime._prepare_prompt_messages(
        messages,
        [],
        "low",
        skills,
        capabilities,
        None,
        128,
    )

    assert metadata["context_trimmed"] is True
    assert metadata["input_tokens"] <= metadata["input_limit"]
    assert compacted[-1].content == "создай папку в рабочем пространстве"


def test_vision_runtime_blocks_repeated_unused_tokens_and_returns_clean_fallback():
    captured = {}

    class BrokenVisionLlama:
        def n_vocab(self):
            return 120

        def detokenize(self, tokens, special=True):
            assert special is True
            token = tokens[0]
            return ("<unused24>" if token == 30 else f"token-{token}").encode("utf-8")

        def tokenize(self, value, **_kwargs):
            text = value.decode("utf-8")
            if text.startswith("<unused"):
                return [1000 + int(text.removeprefix("<unused").removesuffix(">"))]
            return list(range(max(1, len(text) // 4)))

        def create_chat_completion(self, **kwargs):
            captured.update(kwargs)
            for _ in range(8):
                yield {"choices": [{"delta": {"content": "<unused24>"}}]}

    runtime = LocalModelRuntime(Settings(api_token="test", mock_fallback=True))
    runtime.loaded = True
    runtime.active_tier = "gemma4-balanced"
    runtime._vision_enabled = True
    runtime._llama_model = BrokenVisionLlama()
    image = ChatImageAttachment(
        mime_type="image/png",
        data_base64=base64.b64encode(b"not-decoded-by-test").decode("ascii"),
        name="screen.png",
        size_bytes=19,
    )

    answer = "".join(runtime.stream_chat(
        "gemma4-balanced",
        [ChatMessage(role="user", content="Опиши изображение")],
        [],
        "low",
        128,
        0.2,
        0.9,
        image_attachments=[image],
    ))

    assert "<unused24>" not in answer
    assert "fallback-режим" in answer
    assert "vision runtime" in answer
    assert captured["logit_bias"]["30"] == float("-inf")
    assert captured["stop"] == ["<turn|>"]
    assert runtime._vision_enabled is False


def test_model_status_reports_only_valid_gemma4_tiers(tmp_path):
    balanced_dir = tmp_path / "Gemma_12B"
    balanced_dir.mkdir()
    (balanced_dir / "gemma-4-12B-it-Q4_K_M.gguf").write_bytes(b"GGUFbalanced")
    fast_dir = tmp_path / "Gemma_E2B"
    fast_dir.mkdir()
    (fast_dir / "gemma-4-E2B-it-Q5_K_M.gguf").write_bytes(b"\0" * 32)

    runtime = LocalModelRuntime(Settings(
        api_token="test",
        gemma_models_dir=tmp_path,
        coder_models_dir=tmp_path / "coder-models",
    ))

    assert runtime.available_gemma4_tiers() == {
        "gemma4-fast": False,
        "gemma4-balanced": True,
        "gemma4-deepthinking": False,
        "gemma4-31b": False,
        "qwen3-coder-30b-a3b-instruct": False,
        "deepseek-coder-v2-lite-instruct": False,
    }


@pytest.mark.parametrize(
    ("tier", "filename", "expected_layers"),
    [
        ("qwen3-coder-30b-a3b-instruct", "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf", 12),
        ("deepseek-coder-v2-lite-instruct", "DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf", 20),
    ],
)
def test_coder_tiers_load_only_from_separate_coder_root(monkeypatch, tmp_path: Path, tier: str, filename: str, expected_layers: int):
    gemma_root = tmp_path / "gemma"
    coder_root = tmp_path / "coder"
    gemma_root.mkdir()
    model_dir = coder_root / tier
    model_dir.mkdir(parents=True)
    model_path = model_dir / filename
    model_path.write_bytes(b"GGUFcoder")
    runtime = LocalModelRuntime(Settings(
        api_token="test",
        gemma_models_dir=gemma_root,
        coder_models_dir=coder_root,
        mock_fallback=False,
    ))
    loaded = []
    monkeypatch.setattr(runtime, "_load_llama", lambda path, **kwargs: loaded.append((path, kwargs)))

    runtime.load_tier(tier, allow_fallback=False)

    assert loaded[0][0] == model_path
    assert loaded[0][1]["n_gpu_layers"] == expected_layers
    assert loaded[0][1]["n_ctx"] == 16384


def test_coder_context_marker_becomes_a_trusted_bounded_runtime_contract(tmp_path: Path):
    runtime = LocalModelRuntime(make_settings(tmp_path))
    marker = '<monarch_coder_mode>{"responseLanguage":"ru","project":{"root":"E:\\\\Work"}}</monarch_coder_mode>'
    live_registry = (
        '<live_monarch_system>{"resolvedMentionIds":["workspace"],'
        '"modules":[{"id":"workspace","name":"Monarch Workspace","description":"Must not enter Coder"}]}'
        '</live_monarch_system>'
    )
    local_profile = '<local_user_context>{"profile":{"adaptiveSummary":"Must not enter Coder"}}</local_user_context>'

    prompt = runtime._build_prompt_messages(
        [
            ChatMessage(role="system", content=marker),
            ChatMessage(role="system", content=live_registry),
            ChatMessage(role="system", content=local_profile),
            ChatMessage(role="user", content="CODER MODE TASK: проверь проект"),
            ChatMessage(role="user", content="CODER TOOL RECEIPTS: Continue from these Kernel facts."),
        ],
        [],
        "high",
        [ChatSkillContext(
            name="monarch-security",
            description="Global Oscar skill",
            instructions="Must not enter Coder",
            source="builtin://monarch/security",
        )],
        [
            ChatCapabilityContext(id="coder.files.read", module="coder", system="Monarch Coder", title="Read", description="Read file", risk="read"),
            ChatCapabilityContext(id="coder.files.write", module="coder", system="Monarch Coder", title="Write", description="Write file", risk="write"),
        ],
        ChatAccessContext(sandboxMode="workspace-write", approvalPolicy="on-request"),
    )

    assert '<monarch_coder_agent_policy version="3.0">' in prompt[0].content
    assert "understand the requested outcome -> inspect real project evidence" in prompt[0].content
    assert "Propose only listed coder.* capabilities" in prompt[0].content
    assert '"capabilityId":"coder.files.write"' in prompt[0].content
    assert '"capabilityId":"workspace.files.write"' not in prompt[0].content
    assert marker in prompt[0].content
    assert "is the only working root" in prompt[0].content
    assert "coder.projects.* metadata is not inspection evidence" in prompt[0].content
    assert "Never end with a future-tense promise" in prompt[0].content
    assert "batching independent reads" in prompt[0].content
    assert "Язык ответа: русский (ru)" in prompt[0].content
    assert str(runtime.settings.workspace_root.resolve()) not in prompt[0].content
    assert "Agent operating context" not in prompt[0].content
    assert live_registry not in prompt[0].content
    assert local_profile not in prompt[0].content
    assert "Must not enter Coder" not in prompt[0].content

    request = ChatRequest(
        messages=[
            ChatMessage(role="system", content=marker),
            ChatMessage(role="system", content=live_registry),
            ChatMessage(role="user", content="CODER TOOL RECEIPTS: Continue from these Kernel facts."),
        ],
        use_memory=False,
    )
    assert main_module.expected_request_language(request) == "ru"
    assert main_module.live_monarch_registry_snapshot(request) is None


def test_runtime_cancel_stops_llama_stream():
    runtime = LocalModelRuntime(Settings(api_token="test", mock_fallback=False))

    class CancelledLlama:
        def create_chat_completion(self, **_kwargs):
            runtime.cancel_generation()
            yield {"choices": [{"delta": {"content": "late token"}}]}

    runtime.loaded = True
    runtime.active_tier = "gemma4-fast"
    runtime._llama_model = CancelledLlama()

    answer = list(runtime.stream_chat(
        "weak",
        [ChatMessage(role="user", content="cancel me")],
        [],
        "low",
        32,
        0.2,
        0.9,
    ))

    assert answer == []
    assert runtime.status().last_error == "generation cancelled"


def test_llama_stream_closes_only_when_iteration_is_interrupted():
    class CompletionStream:
        def __init__(self):
            self.emitted = False
            self.close_calls = 0

        def __iter__(self):
            return self

        def __next__(self):
            if self.emitted:
                raise StopIteration
            self.emitted = True
            return {"choices": [{"delta": {"content": "готово"}}]}

        def close(self):
            self.close_calls += 1

    class StreamLlama:
        def __init__(self):
            self.streams = []

        def create_chat_completion(self, **_kwargs):
            stream = CompletionStream()
            self.streams.append(stream)
            return stream

    runtime = LocalModelRuntime(Settings(api_token="test", mock_fallback=False))
    runtime.loaded = True
    runtime.active_tier = "gemma4-fast"
    runtime._llama_model = StreamLlama()

    completed = list(runtime.stream_chat(
        "weak",
        [ChatMessage(role="user", content="complete")],
        [],
        "low",
        32,
        0.2,
        0.9,
    ))
    interrupted = runtime.stream_chat(
        "weak",
        [ChatMessage(role="user", content="interrupt")],
        [],
        "low",
        32,
        0.2,
        0.9,
    )
    assert next(interrupted) == "готово"
    interrupted.close()

    assert completed == ["готово"]
    assert runtime._llama_model.streams[0].close_calls == 0
    assert runtime._llama_model.streams[1].close_calls == 1


def test_unload_closes_native_llama_runtime_and_trims_memory(monkeypatch):
    calls = []
    monkeypatch.setattr(runtime_module, "trim_process_memory", lambda: calls.append("trim"))

    class Closable:
        def __init__(self, name):
            self.name = name

        def close(self):
            calls.append(self.name)

    runtime = LocalModelRuntime(Settings(api_token="test", mock_fallback=False))
    runtime.loaded = True
    runtime.active_tier = "gemma"
    runtime._llama_model = Closable("llama")
    runtime._llama_chat_handler = Closable("handler")
    runtime._transformers_model = object()
    runtime._tokenizer = object()

    status = runtime.unload()

    assert status.loaded is False
    assert runtime._llama_model is None
    assert runtime._llama_chat_handler is None
    assert runtime._transformers_model is None
    assert runtime._tokenizer is None
    assert calls == ["llama", "handler", "trim"]


def test_image_attachment_rejects_invalid_base64():
    with pytest.raises(ValueError):
        ChatImageAttachment(
            mime_type="image/png",
            data_base64="not base64!",
            name="bad.png",
            size_bytes=10,
        )


@pytest.mark.asyncio
async def test_chat_endpoint_routes_image_attachment_to_gemma(monkeypatch):
    captured = {}

    def stream_chat(
        tier,
        messages,
        sources,
        reasoning_effort,
        max_new_tokens,
        temperature,
        top_p,
        image_attachments=None,
        skill_context=None,
        capability_context=None,
        access_context=None,
        strict_tier=False,
    ):
        captured["tier"] = tier
        captured["image_count"] = len(image_attachments or [])
        captured["skill_count"] = len(skill_context or [])
        captured["capability_count"] = len(capability_context or [])
        captured["access"] = access_context
        captured["strict_tier"] = strict_tier
        return iter(["vision ok"])

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)

    response = await main_module.chat(ChatRequest(
        messages=[ChatMessage(role="user", content="Опиши картинку")],
        image_attachments=[
            ChatImageAttachment(
                mime_type="image/png",
                data_base64=base64.b64encode(b"fake-png").decode("ascii"),
                name="screen.png",
                size_bytes=8,
            )
        ],
        use_memory=False,
        max_new_tokens=32,
    ))

    assert response.answer == "vision ok"
    assert captured == {
        "tier": "gemma4-balanced",
        "image_count": 1,
        "skill_count": 0,
        "capability_count": 0,
        "access": None,
        "strict_tier": False,
    }


@pytest.mark.asyncio
async def test_chat_endpoint_returns_sanitized_recovery_answer(monkeypatch):
    async def fail_prepare_sources(_request):
        raise RuntimeError("secret prepare failure")

    monkeypatch.setattr(main_module, "prepare_sources", fail_prepare_sources)

    response = await main_module.chat(ChatRequest(
        messages=[ChatMessage(role="user", content="Почему ответ упал?")],
        use_memory=True,
        requested_model="weak",
        max_new_tokens=32,
    ))

    assert "Не смог завершить локальную генерацию" in response.answer
    assert "secret prepare failure" not in response.answer


@pytest.mark.asyncio
async def test_chat_endpoint_continues_when_web_search_fails(monkeypatch):
    async def fail_search(_query, _max_results, _fetch_pages):
        raise RuntimeError("secret web provider failure")

    def stream_chat(*_args, **_kwargs):
        return iter(["Ответ без свежего web-контекста"])

    main_module.model_runtime.last_error = None
    monkeypatch.setattr(main_module.search_service, "search_and_ingest", fail_search)
    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)

    response = await main_module.chat(ChatRequest(
        messages=[ChatMessage(role="user", content="Найди актуальные данные и ответь кратко")],
        web_search=True,
        use_memory=False,
        requested_model="weak",
        max_new_tokens=32,
    ))

    assert response.answer == "Ответ без свежего web-контекста"
    assert "secret web provider failure" not in response.answer
    assert main_module.model_runtime.last_error == "web search failed; continuing without fresh web context"


@pytest.mark.asyncio
async def test_chat_stream_continues_when_memory_lookup_fails(monkeypatch):
    def fail_memory_search(*_args, **_kwargs):
        raise RuntimeError("secret memory db failure")

    def stream_chat(*_args, **_kwargs):
        return iter(["Ответ ", "без памяти"])

    main_module.model_runtime.last_error = None
    monkeypatch.setattr(main_module.memory, "search", fail_memory_search)
    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)

    response = await main_module.chat_stream(ChatRequest(
        messages=[ChatMessage(role="user", content="Что ты помнишь о проекте Monarch?")],
        use_memory=True,
        requested_model="weak",
        max_new_tokens=32,
    ))
    body = await collect_stream_body(response)

    assert "Ответ " in body
    assert "без памяти" in body
    assert '"ok": true' in body
    assert "secret memory db failure" not in body
    assert main_module.model_runtime.last_error == "memory search failed; continuing without memory context"


@pytest.mark.asyncio
async def test_chat_stream_marks_model_fallback_as_not_ok(monkeypatch):
    def stream_chat(*_args, **_kwargs):
        main_module.model_runtime.fallback_active = True
        return iter(["fallback answer"])

    monkeypatch.setattr(main_module.model_runtime, "fallback_active", False)
    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)

    response = await main_module.chat_stream(ChatRequest(
        messages=[ChatMessage(role="user", content="Проверь fallback")],
        use_memory=False,
        requested_model="weak",
        max_new_tokens=32,
    ))
    body = await collect_stream_body(response)

    assert "fallback answer" in body
    assert "Переключился в безопасный fallback" in body
    assert '"ok": false' in body


@pytest.mark.asyncio
async def test_chat_endpoint_executes_workspace_batch_without_model(monkeypatch, tmp_path: Path):
    workspace = WorkspaceService(make_settings(tmp_path))
    monkeypatch.setattr(main_module, "workspace", workspace)

    def fail_stream_chat(*_args, **_kwargs):
        raise AssertionError("model should not run for workspace batch")

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", fail_stream_chat)

    response = await main_module.chat(ChatRequest(
        messages=[
            ChatMessage(
                role="user",
                content="Создай файлы:\n- artifacts/generated/one.md: first\n- artifacts/generated/two.md: second",
            )
        ],
        use_memory=False,
        requested_model="weak",
        max_new_tokens=32,
    ))

    assert len(response.tool_results) == 1
    assert response.tool_results[0].error == "kernel-execution-required"
    assert len(response.tool_results[0].details["commands"]) == 2
    assert "[[MONARCH_ACTION:" not in response.answer
    assert "Не получилось выполнить действие" not in response.answer
    assert response.outcome == "action-proposed"
    assert len(response.action_proposals) == 2
    assert response.action_proposals[0]["capabilityId"] == "workspace.files.write"
    assert not (workspace.root / "artifacts" / "generated" / "one.md").exists()


@pytest.mark.asyncio
async def test_chat_workspace_root_followups_are_exact_fast_and_persisted(monkeypatch, tmp_path: Path):
    settings = make_settings(tmp_path)
    workspace = WorkspaceService(settings)
    store = MemoryStore(settings)
    monkeypatch.setattr(main_module, "workspace", workspace)
    monkeypatch.setattr(main_module, "memory", store)

    def fail_stream_chat(*_args, **_kwargs):
        raise AssertionError("model should not run for an authoritative workspace-root fact")

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", fail_stream_chat)
    messages: list[ChatMessage] = []
    prompts = [
        "Где находится твое рабочее пространство?",
        "укажи путь до него",
        "более точный путь",
    ]

    for prompt in prompts:
        messages.append(ChatMessage(role="user", content=prompt))
        response = await main_module.chat(ChatRequest(
            messages=list(messages),
            conversation_id="workspace-root-truth",
            use_memory=False,
            max_new_tokens=32,
        ))
        assert response.tool_results[0].action == "root"
        assert response.tool_results[0].path == str(workspace.root)
        assert str(workspace.root) in response.answer
        assert response.usage["model_tier"] == "system"
        assert response.usage["elapsed_ms"] < 1000
        messages.append(ChatMessage(role="assistant", content=response.answer))

    conversation = store.get_conversation("workspace-root-truth")
    assert [message["content"] for message in conversation["messages"] if message["role"] == "user"] == prompts
    assert len(conversation["messages"]) == 6
    assert all(
        str(workspace.root) in message["content"]
        for message in conversation["messages"]
        if message["role"] == "assistant"
    )


@pytest.mark.asyncio
async def test_chat_executes_environment_ping_without_model(monkeypatch, tmp_path: Path):
    settings = make_settings(tmp_path)
    settings.workspace_root.mkdir(parents=True, exist_ok=True)
    store = MemoryStore(settings)
    monkeypatch.setenv("OSCAR_WORKSPACE_ROOT", str(settings.workspace_root))
    monkeypatch.setattr(main_module, "memory", store)
    monkeypatch.setattr(main_module, "environment", main_module.EnvironmentScanner(settings))

    def fail_stream_chat(*_args, **_kwargs):
        raise AssertionError("model should not run for environment diagnostics")

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", fail_stream_chat)

    response = await main_module.chat(ChatRequest(
        conversation_id="environment-ping",
        messages=[ChatMessage(role="user", content="Проверка связи Oscar внутри Monarch Electron.")],
        use_memory=False,
        max_new_tokens=32,
    ))

    assert len(response.tool_results) == 1
    assert response.tool_results[0].kind == "environment"
    assert response.tool_results[0].action == "environment"
    assert "Окружение Monarch/Oscar" in response.answer
    assert "<|toolcall|>" not in response.answer
    assert str(settings.workspace_root.resolve()) in response.answer
    conversation = store.get_conversation("environment-ping")
    assert conversation["messages"][-1]["model_tier"] == "system"


@pytest.mark.asyncio
async def test_chat_stream_executes_environment_ping_without_model(monkeypatch, tmp_path: Path):
    settings = make_settings(tmp_path)
    settings.workspace_root.mkdir(parents=True, exist_ok=True)
    store = MemoryStore(settings)
    monkeypatch.setenv("OSCAR_WORKSPACE_ROOT", str(settings.workspace_root))
    monkeypatch.setattr(main_module, "memory", store)
    monkeypatch.setattr(main_module, "environment", main_module.EnvironmentScanner(settings))

    def fail_stream_chat(*_args, **_kwargs):
        raise AssertionError("model should not run for environment diagnostics")

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", fail_stream_chat)

    response = await main_module.chat_stream(ChatRequest(
        conversation_id="environment-ping-stream",
        messages=[ChatMessage(role="user", content="Проверка связи Oscar внутри Monarch Electron.")],
        use_memory=False,
        max_new_tokens=32,
    ))
    body = await collect_stream_body(response)

    assert "event: tool" in body
    assert "environment" in body
    assert "Окружение Monarch/Oscar" in body
    assert "<|toolcall|>" not in body
    conversation = store.get_conversation("environment-ping-stream")
    assert conversation["messages"][-1]["model_tier"] == "system"


@pytest.mark.asyncio
async def test_chat_environment_questions_are_grounded_in_model_context(monkeypatch, tmp_path: Path):
    settings = make_settings(tmp_path)
    settings.workspace_root.mkdir(parents=True, exist_ok=True)
    store = MemoryStore(settings)
    monkeypatch.setattr(main_module, "memory", store)
    monkeypatch.setattr(main_module.model_runtime, "settings", settings)
    captured: dict[str, str] = {}

    def stream_chat(
        _tier,
        messages,
        sources,
        reasoning_effort,
        _max_new_tokens,
        _temperature,
        _top_p,
        *extra_args,
        **_kwargs,
    ):
        skill_context = extra_args[1] if len(extra_args) > 1 else _kwargs.get("skill_context")
        capability_context = extra_args[2] if len(extra_args) > 2 else _kwargs.get("capability_context")
        access_context = extra_args[3] if len(extra_args) > 3 else _kwargs.get("access_context")
        prompt_messages = main_module.model_runtime._build_prompt_messages(
            messages,
            sources,
            reasoning_effort,
            skill_context or [],
            capability_context or [],
            access_context,
        )
        captured["system"] = prompt_messages[0].content
        yield f"Я запущен в `{settings.workspace_root.resolve()}` и вижу реальные Monarch capabilities."

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)

    response = await main_module.chat(ChatRequest(
        messages=[ChatMessage(role="user", content="Где ты сейчас находишься и что установлено?")],
        conversation_id="environment-truth",
        web_search=False,
        use_memory=False,
        max_new_tokens=32,
    ))

    assert response.tool_results == []
    assert str(settings.workspace_root.resolve()) in response.answer
    assert response.usage["model_tier"] != "system"
    assert str(settings.workspace_root.resolve()) in captured["system"]
    assert "environment.inspect" in captured["system"]
    assert "workspace.files.write" in captured["system"]
    assert "не декоративный чат" in captured["system"]

    conversation = store.get_conversation("environment-truth")
    assert [message["role"] for message in conversation["messages"]] == ["user", "assistant"]
    assert str(settings.workspace_root.resolve()) in conversation["messages"][1]["content"]


@pytest.mark.asyncio
async def test_chat_executes_saved_root_folder_request_without_model(monkeypatch, tmp_path: Path):
    workspace = WorkspaceService(make_settings(tmp_path))
    monkeypatch.setattr(main_module, "workspace", workspace)
    (workspace.root / "alpha").mkdir()
    (workspace.root / "note.txt").write_text("not a directory", encoding="utf-8")

    def fail_stream_chat(*_args, **_kwargs):
        raise AssertionError("model should not run for a recognized folder listing")

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", fail_stream_chat)

    response = await main_module.chat(ChatRequest(
        messages=[ChatMessage(role="user", content="Просмотри какие названия папок в твоей корневой папке")],
        use_memory=False,
        max_new_tokens=32,
    ))

    assert len(response.tool_results) == 1
    assert response.tool_results[0].ok is True
    assert response.tool_results[0].action == "list"
    assert "alpha/" in response.answer
    assert "note.txt" not in response.answer


@pytest.mark.asyncio
async def test_chat_does_not_create_literal_placeholder_directory_name(monkeypatch, tmp_path: Path):
    workspace = WorkspaceService(make_settings(tmp_path))
    monkeypatch.setattr(main_module, "workspace", workspace)

    def fail_stream_chat(*_args, **_kwargs):
        raise AssertionError("model should not run for detected workspace mkdir")

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", fail_stream_chat)

    response = await main_module.chat(ChatRequest(
        messages=[ChatMessage(role="user", content="создай новую папку название придумай сам и укажи путь до нее")],
        use_memory=False,
        max_new_tokens=32,
    ))

    assert response.tool_results[0].error == "kernel-execution-required"
    assert response.tool_results[0].action == "mkdir"
    assert response.tool_results[0].details["commands"][0]["parameters"]["path"] == "Новая папка"
    assert not (workspace.root / "Новая папка").exists()
    assert not (workspace.root / "название").exists()


@pytest.mark.asyncio
async def test_chat_hands_assigned_directory_name_to_kernel_without_persisting_a_false_result(monkeypatch, tmp_path: Path):
    settings = make_settings(tmp_path)
    workspace = WorkspaceService(settings)
    store = MemoryStore(settings)
    monkeypatch.setattr(main_module, "workspace", workspace)
    monkeypatch.setattr(main_module, "memory", store)

    def fail_stream_chat(*_args, **_kwargs):
        raise AssertionError("model should not run for detected workspace mkdir")

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", fail_stream_chat)

    response = await main_module.chat(ChatRequest(
        messages=[ChatMessage(
            role="user",
            content="Создай новую папку в твоем рабочем пространстве назови ее цветок.",
        )],
        conversation_id="assigned-directory-handoff",
        use_memory=False,
        max_new_tokens=32,
    ))

    assert response.outcome == "action-proposed"
    assert response.action_proposals[0]["capabilityId"] == "workspace.files.mkdir"
    assert response.action_proposals[0]["args"]["path"] == "цветок"
    assert "Не получилось выполнить действие" not in response.answer
    assert not (workspace.root / "цветок").exists()
    conversation = store.get_conversation("assigned-directory-handoff")
    assert [message["role"] for message in conversation["messages"]] == ["user"]


def test_compound_or_underspecified_workspace_creation_is_deferred_to_model_planner():
    assert main_module.requires_model_workspace_planning(
        "Ставлю тестовую задачу: в рабочем пространстве создай папку, в папке создай текстовый файл."
    ) is True
    assert main_module.requires_model_workspace_planning("создай папку") is True
    assert main_module.requires_model_workspace_planning(
        "Короче тебе надо создать новую папку в твоём в рабочем пространстве в этой новой папке "
        "тебе надо создать два текста файла один текстовой файл назови тест второй буква"
    ) is True
    assert main_module.requires_model_workspace_planning(
        '{"capability":"workspace.files.mkdir","parameters":{"path":"demo"}}'
    ) is False


@pytest.mark.asyncio
async def test_chat_compound_unnamed_creation_does_not_execute_partial_mkdir(monkeypatch, tmp_path: Path):
    workspace = WorkspaceService(make_settings(tmp_path))
    monkeypatch.setattr(main_module, "workspace", workspace)

    def plan_stream_chat(*_args, **_kwargs):
        yield "Подготовил полный workspace-план."

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", plan_stream_chat)
    response = await main_module.chat(ChatRequest(
        messages=[ChatMessage(
            role="user",
            content=(
                "Короче тебе надо создать новую папку в твоём в рабочем пространстве в этой новой папке "
                "тебе надо создать два текста файла один текстовой файл назови тест второй буква"
            ),
        )],
        use_memory=False,
        max_new_tokens=32,
    ))

    assert response.tool_results == []
    assert response.answer == "Подготовил полный workspace-план."
    assert not (workspace.root / "Новая папка").exists()


@pytest.mark.asyncio
async def test_chat_uses_recent_directory_for_text_file_followup(monkeypatch, tmp_path: Path):
    workspace = WorkspaceService(make_settings(tmp_path))
    monkeypatch.setattr(main_module, "workspace", workspace)
    created = workspace.mkdir("Новая папка")
    assert created.ok
    escaped_path = str(created.path).replace("\\", "\\\\")

    def fail_stream_chat(*_args, **_kwargs):
        raise AssertionError("model should not run for contextual workspace write")

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", fail_stream_chat)

    response = await main_module.chat(ChatRequest(
        messages=[
            ChatMessage(role="user", content="создай новую папку название придумай сам и укажи путь до нее"),
            ChatMessage(
                role="assistant",
                content=f"**Monarch Workspace**\n\nCreated directory {created.path}.\n\n{{\"path\":\"{escaped_path}\"}}",
            ),
            ChatMessage(role="user", content="в этой папке сделай текстовый файл"),
            ChatMessage(role="assistant", content="Какой текст ты хочешь поместить в новый текстовый файл?"),
            ChatMessage(role="user", content="тест валидации"),
        ],
        use_memory=False,
        max_new_tokens=32,
    ))

    assert response.tool_results[0].error == "kernel-execution-required"
    assert response.tool_results[0].action == "write"
    assert Path(response.tool_results[0].path or "").name == "note.txt"
    assert response.tool_results[0].details["commands"][0]["parameters"]["content"] == "тест валидации"
    assert not (workspace.root / "Новая папка" / "note.txt").exists()


@pytest.mark.asyncio
async def test_chat_executes_oscar_architecture_audit_starter_without_model(monkeypatch, tmp_path: Path):
    workspace = WorkspaceService(make_settings(tmp_path))
    monkeypatch.setattr(main_module, "workspace", workspace)
    for directory in [
        "oscar",
        "oscar/backend/oscar_agent",
        "oscar/backend/tests",
        "src/modules/oscar",
    ]:
        (workspace.root / directory).mkdir(parents=True, exist_ok=True)

    def fail_stream_chat(*_args, **_kwargs):
        raise AssertionError("model should not promise an audit without running workspace tools")

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", fail_stream_chat)

    response = await main_module.chat(ChatRequest(
        messages=[ChatMessage(
            role="user",
            content="расскажи о архитектуре Oscar не на основе твоих знаний а на основе аудита который ты проведешь",
        )],
        use_memory=False,
        max_new_tokens=32,
    ))

    assert len(response.tool_results) >= 5
    assert {result.action for result in response.tool_results} == {"list"}
    assert response.usage["model_tier"] == "system"
    assert "oscar/backend/oscar_agent" in response.answer.replace("\\", "/")


@pytest.mark.asyncio
async def test_chat_workspace_tools_respect_monarch_access(monkeypatch, tmp_path: Path):
    workspace = WorkspaceService(make_settings(tmp_path))
    monkeypatch.setattr(main_module, "workspace", workspace)

    def fail_stream_chat(*_args, **_kwargs):
        raise AssertionError("model should not run for detected workspace tools")

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", fail_stream_chat)
    target = workspace.root / "artifacts" / "generated" / "access.txt"

    read_only = await main_module.chat(ChatRequest(
        messages=[ChatMessage(role="user", content='Создай файл artifacts/generated/access.txt с текстом "safe"')],
        use_memory=False,
        max_new_tokens=32,
        access=ChatAccessContext(sandboxMode="read-only", approvalPolicy="on-request"),
    ))
    assert read_only.tool_results[0].error == "kernel-execution-required"
    assert not target.exists()

    automatic = await main_module.chat(ChatRequest(
        messages=[ChatMessage(role="user", content='Создай файл artifacts/generated/access.txt с текстом "safe"')],
        use_memory=False,
        max_new_tokens=32,
        access=ChatAccessContext(sandboxMode="workspace-write", approvalPolicy="on-request"),
    ))
    assert automatic.tool_results[0].error == "kernel-execution-required"
    assert not target.exists()

    destructive = await main_module.chat(ChatRequest(
        messages=[ChatMessage(role="user", content="удали файл artifacts/generated/access.txt")],
        use_memory=False,
        max_new_tokens=32,
        access=ChatAccessContext(sandboxMode="danger-full-access", approvalPolicy="on-request"),
    ))
    assert destructive.tool_results[0].error == "kernel-execution-required"
    assert not target.exists()


@pytest.mark.asyncio
async def test_chat_workspace_tools_do_not_expose_red_zone_files(monkeypatch, tmp_path: Path):
    workspace = WorkspaceService(make_settings(tmp_path))
    monkeypatch.setattr(main_module, "workspace", workspace)
    (workspace.root / ".env").write_text("CHAT_REDZONE_NEEDLE=super-hidden-value", encoding="utf-8")
    (workspace.root / "runtime" / "visible.txt").parent.mkdir(parents=True, exist_ok=True)
    (workspace.root / "runtime" / "visible.txt").write_text("visible", encoding="utf-8")

    def fail_stream_chat(*_args, **_kwargs):
        raise AssertionError("model should not run for detected workspace tools")

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", fail_stream_chat)

    direct = await main_module.chat(ChatRequest(
        messages=[ChatMessage(role="user", content="прочитай файл .env")],
        use_memory=False,
        max_new_tokens=32,
    ))
    search = await main_module.chat(ChatRequest(
        messages=[ChatMessage(role="user", content="найди в файлах CHAT_REDZONE_NEEDLE")],
        use_memory=False,
        max_new_tokens=32,
    ))

    assert direct.tool_results[0].error == "protected-path"
    assert "super-hidden-value" not in direct.answer
    assert search.tool_results[0].ok is True
    assert search.tool_results[0].matches == []
    assert "super-hidden-value" not in search.answer


@pytest.mark.asyncio
async def test_chat_workspace_tools_fail_closed_when_approvals_disabled(monkeypatch, tmp_path: Path):
    workspace = WorkspaceService(make_settings(tmp_path))
    monkeypatch.setattr(main_module, "workspace", workspace)

    response = await main_module.chat(ChatRequest(
        messages=[ChatMessage(role="user", content='Создай файл artifacts/generated/denied.txt с текстом "no"')],
        use_memory=False,
        max_new_tokens=32,
        access=ChatAccessContext(sandboxMode="read-only", approvalPolicy="never"),
    ))

    assert response.tool_results[0].error == "kernel-execution-required"
    assert not (workspace.root / "artifacts" / "generated" / "denied.txt").exists()


@pytest.mark.asyncio
async def test_chat_incomplete_workspace_write_runs_model_planner(monkeypatch, tmp_path: Path):
    workspace = WorkspaceService(make_settings(tmp_path))
    monkeypatch.setattr(main_module, "workspace", workspace)

    def plan_stream_chat(*_args, **_kwargs):
        yield 'Подготовил безопасный план.'

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", plan_stream_chat)

    response = await main_module.chat(ChatRequest(
        messages=[ChatMessage(role="user", content="Создай файл с отчетом")],
        use_memory=False,
        max_new_tokens=32,
    ))

    assert response.tool_results == []
    assert response.answer == "Подготовил безопасный план."
    assert not (workspace.root / "с").exists()


@pytest.mark.asyncio
async def test_chat_endpoint_executes_workspace_multi_action_without_model(monkeypatch, tmp_path: Path):
    workspace = WorkspaceService(make_settings(tmp_path))
    monkeypatch.setattr(main_module, "workspace", workspace)

    def fail_stream_chat(*_args, **_kwargs):
        raise AssertionError("model should not run for workspace multi-action")

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", fail_stream_chat)

    response = await main_module.chat(ChatRequest(
        messages=[
            ChatMessage(
                role="user",
                content=(
                    'Создай папку artifacts/generated/natural и '
                    'создай файл artifacts/generated/natural/a.md с текстом "natural ok"'
                ),
            )
        ],
        use_memory=False,
        requested_model="weak",
        max_new_tokens=32,
    ))

    assert len(response.tool_results) == 1
    assert response.tool_results[0].error == "kernel-execution-required"
    assert len(response.tool_results[0].details["commands"]) == 2
    assert not (workspace.root / "artifacts" / "generated" / "natural" / "a.md").exists()


@pytest.mark.asyncio
async def test_chat_endpoint_executes_workspace_structure_without_model(monkeypatch, tmp_path: Path):
    workspace = WorkspaceService(make_settings(tmp_path))
    monkeypatch.setattr(main_module, "workspace", workspace)

    def fail_stream_chat(*_args, **_kwargs):
        raise AssertionError("model should not run for workspace structure")

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", fail_stream_chat)

    response = await main_module.chat(ChatRequest(
        messages=[
            ChatMessage(
                role="user",
                content=(
                    "Создай структуру проекта:\n"
                    "artifacts/generated/app/\n"
                    "├── README.md: app ready\n"
                    "└── src/\n"
                    "    └── main.ts: console.log('app')"
                ),
            )
        ],
        use_memory=False,
        requested_model="weak",
        max_new_tokens=32,
    ))

    assert len(response.tool_results) == 1
    assert response.tool_results[0].error == "kernel-execution-required"
    assert response.tool_results[0].details["truncated"] is True
    assert len(response.tool_results[0].details["commands"]) == 3
    assert not (workspace.root / "artifacts" / "generated" / "app").exists()


@pytest.mark.asyncio
async def test_chat_stream_returns_sanitized_recovery_event(monkeypatch):
    async def fail_prepare_sources(_request):
        raise RuntimeError("secret stream failure")

    monkeypatch.setattr(main_module, "prepare_sources", fail_prepare_sources)

    response = await main_module.chat_stream(ChatRequest(
        messages=[ChatMessage(role="user", content="Почему stream упал?")],
        use_memory=True,
        requested_model="weak",
        max_new_tokens=32,
    ))
    chunks = []
    async for chunk in response.body_iterator:
        chunks.append(chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk)
    body = "".join(chunks)

    assert "event: token" in body
    assert "event: done" in body
    assert '"usage"' in body
    assert '"total_tokens"' in body
    assert "Не смог завершить локальную генерацию" in body
    assert "secret stream failure" not in body


@pytest.mark.asyncio
async def test_chat_stream_recovery_survives_usage_estimation_failure(monkeypatch):
    async def fail_prepare_sources(_request):
        raise RuntimeError("primary stream failure")

    def fail_usage(*_args, **_kwargs):
        raise RuntimeError("secondary usage failure")

    monkeypatch.setattr(main_module, "prepare_sources", fail_prepare_sources)
    monkeypatch.setattr(main_module.model_runtime, "estimate_chat_usage", fail_usage)

    response = await main_module.chat_stream(ChatRequest(
        messages=[ChatMessage(role="user", content="Проверь восстановление потока")],
        incognito=True,
        use_memory=False,
        requested_model="weak",
        max_new_tokens=32,
    ))
    body = await collect_stream_body(response)

    assert "event: token" in body
    assert "event: done" in body
    assert '"usage_fallback": true' in body
    assert "Не смог завершить локальную генерацию" in body
    assert "primary stream failure" not in body
    assert "secondary usage failure" not in body


@pytest.mark.asyncio
async def test_chat_stream_waits_for_busy_inference_queue(monkeypatch):
    def stream_chat(*_args, **_kwargs):
        return iter(["queued ", "answer"])

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)

    lock = main_module.get_inference_lock()
    await lock.acquire()

    async def release_later() -> None:
        await asyncio.sleep(0.02)
        if lock.locked():
            lock.release()

    release_task = asyncio.create_task(release_later())
    try:
        response = await main_module.chat_stream(ChatRequest(
            messages=[ChatMessage(role="user", content="wait for queue")],
            use_memory=False,
            requested_model="weak",
            max_new_tokens=32,
        ))
        body = await collect_stream_body(response)
    finally:
        if lock.locked():
            lock.release()
        await release_task

    assert "Жду очередь генерации" in body
    assert "queued " in body
    assert "answer" in body
    assert '"ok": true' in body
    assert '"elapsed_ms"' in body


@pytest.mark.asyncio
async def test_chat_stream_queue_timeout_returns_done(monkeypatch):
    monkeypatch.setattr(main_module.settings, "inference_queue_timeout_seconds", 0.01)

    lock = main_module.get_inference_lock()
    await lock.acquire()
    try:
        response = await main_module.chat_stream(ChatRequest(
            messages=[ChatMessage(role="user", content="timeout queue")],
            use_memory=False,
            requested_model="weak",
            max_new_tokens=32,
        ))
        body = await collect_stream_body(response)
    finally:
        if lock.locked():
            lock.release()

    assert "Жду очередь генерации" in body
    assert "Очередь генерации занята" in body
    assert "event: done" in body
    assert '"ok": false' in body


@pytest.mark.asyncio
async def test_chat_stream_recovers_from_empty_model_answer(monkeypatch):
    def stream_chat(*_args, **_kwargs):
        return iter([])

    main_module.model_runtime.last_error = None
    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)

    response = await main_module.chat_stream(ChatRequest(
        messages=[ChatMessage(role="user", content="Почему stream пустой?")],
        use_memory=False,
        requested_model="weak",
        max_new_tokens=32,
    ))
    body = await collect_stream_body(response)

    assert "Восстанавливаю пустой ответ модели" in body
    assert "Не смог завершить локальную генерацию" in body
    assert "Почему stream пустой?" in body
    assert "event: done" in body
    assert '"ok": false' in body
    assert main_module.model_runtime.last_error == "empty model response"


@pytest.mark.asyncio
@pytest.mark.parametrize("drifted_answer", [
    "Какво е това",
    "I can use my web search capability to inspect this site.",
])
async def test_chat_stream_appends_language_correction(monkeypatch, drifted_answer):
    calls = []

    def stream_chat(_tier, messages, *_args, **_kwargs):
        calls.append(messages)
        if len(calls) == 1:
            return iter([drifted_answer])
        return iter(["Русский ответ без смешанного языка"])

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)

    response = await main_module.chat_stream(ChatRequest(
        messages=[ChatMessage(role="user", content="Ответь на русском: объясни локальный runtime")],
        use_memory=False,
        requested_model="weak",
        max_new_tokens=64,
    ))
    chunks = []
    async for chunk in response.body_iterator:
        chunks.append(chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk)
    body = "".join(chunks)

    assert len(calls) == 2
    assert "Исправляю язык ответа" in body
    assert "event: replace" in body
    assert "Русский" in body
    assert "смешанного" in body
    assert '"content": "Русский ответ без смешанного языка"' in body
    assert "event: done" in body
    assert '"ok": true' in body
