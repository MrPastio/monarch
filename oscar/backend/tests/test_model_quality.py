from pathlib import Path
import sys

import pytest

backend_dir = Path(__file__).resolve().parents[1]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from oscar_agent import main as main_module
from oscar_agent.memory import MemoryStore
from oscar_agent.model_quality import ModelQualityLedger, assess_model_answer
from oscar_agent.schemas import ChatMessage, ChatRequest

from test_chat_runtime import collect_stream_body, make_settings


def test_model_quality_ledger_starts_at_100_and_reaches_coll(tmp_path: Path):
    ledger = ModelQualityLedger(tmp_path / "model_quality.json")
    assessment = assess_model_answer(
        "Я создал файл report.txt и проверил его в рабочей папке.",
        sources=[],
    )

    assert ledger.snapshot("gemma4-fast").score == 100
    assert assessment.penalty > 0

    snapshot = None
    for _ in range(3):
        snapshot = ledger.record_penalty("gemma4-fast", assessment)

    assert snapshot is not None
    assert snapshot.score <= 20
    assert snapshot.status == "Coll"


def test_model_quality_penalizes_false_citations_without_sources():
    assessment = assess_model_answer(
        "Согласно источнику [1], релиз уже состоялся.",
        sources=[],
    )

    assert assessment.penalty >= 25
    assert "false_citation" in assessment.reasons


@pytest.mark.asyncio
async def test_chat_records_internal_quality_penalty_without_visible_metadata(monkeypatch, tmp_path: Path):
    settings = make_settings(tmp_path)
    store = MemoryStore(settings)
    ledger = ModelQualityLedger(tmp_path / "model_quality.json")
    monkeypatch.setattr(main_module, "memory", store)
    monkeypatch.setattr(main_module, "model_quality", ledger)
    monkeypatch.setattr(main_module.model_runtime, "stream_chat", lambda *_args, **_kwargs: iter(["Ответ с выдуманной ссылкой [1]."]))
    monkeypatch.setattr(main_module.model_runtime, "unload", lambda: None)

    response = await main_module.chat(ChatRequest(
        conversation_id="quality-hidden-chat",
        messages=[ChatMessage(role="user", content="Ответь без поиска")],
        requested_model="gemma4-fast",
        web_search=False,
        use_memory=False,
        max_new_tokens=32,
    ))

    snapshot = ledger.snapshot("gemma4-fast")
    assert snapshot.score < 100
    assert "Ответ с выдуманной ссылкой [1]." == response.answer
    assert "model_quality" not in response.usage
    assert "quality_score" not in response.usage
    assert "Coll" not in response.answer
    assert "штраф" not in response.answer.lower()


@pytest.mark.asyncio
async def test_chat_stream_records_quality_penalty_without_sse_leak(monkeypatch, tmp_path: Path):
    settings = make_settings(tmp_path)
    store = MemoryStore(settings)
    ledger = ModelQualityLedger(tmp_path / "model_quality.json")
    monkeypatch.setattr(main_module, "memory", store)
    monkeypatch.setattr(main_module, "model_quality", ledger)
    monkeypatch.setattr(
        main_module.model_runtime,
        "stream_chat",
        lambda *_args, **_kwargs: iter(["Я создал файл result.txt и проверил его в workspace."]),
    )
    monkeypatch.setattr(main_module.model_runtime, "unload", lambda: None)

    response = await main_module.chat_stream(ChatRequest(
        conversation_id="quality-hidden-stream",
        messages=[ChatMessage(role="user", content="Сделай файл")],
        requested_model="gemma4-fast",
        web_search=False,
        use_memory=False,
        max_new_tokens=32,
    ))
    body = await collect_stream_body(response)

    snapshot = ledger.snapshot("gemma4-fast")
    assert snapshot.score < 100
    assert "Я создал файл result.txt" in body
    assert "model_quality" not in body
    assert "quality_score" not in body
    assert "Coll" not in body
    assert "штраф" not in body.lower()


@pytest.mark.asyncio
async def test_quality_regeneration_cannot_escalate_to_deep_thinking_without_consent(monkeypatch):
    monkeypatch.setenv("OSCAR_ENABLE_QUALITY_REGENERATION", "1")
    monkeypatch.setattr(main_module, "next_stronger_tier", lambda _tier: "gemma4-deepthinking")
    called = False

    def stream_chat(*_args, **_kwargs):
        nonlocal called
        called = True
        return iter(["regenerated"])

    monkeypatch.setattr(main_module.model_runtime, "stream_chat", stream_chat)
    request = ChatRequest(
        messages=[ChatMessage(role="user", content="Ответь")],
        use_memory=False,
    )

    answer, flags, regenerated = await main_module.maybe_regenerate_for_quality(
        "gemma4-balanced",
        request,
        [],
        "Я — это я, мой помощник отвечает.",
    )

    assert answer == "Я — это я, мой помощник отвечает."
    assert flags
    assert regenerated is False
    assert called is False
