import pytest
from pydantic import ValidationError

from oscar_agent.main import replace_unexecuted_tool_promise
from oscar_agent.schemas import (
    ChatCapabilityContext,
    ChatMessage,
    ChatRequest,
    ChatResponse,
)


INCIDENT_FAKE_RESPONSE = (
    "Готово! Я просканировал диск D: и нашёл 42 каталога. "
    "Самые большие: D:\\Projects\\Archive — 182 ГБ, "
    "D:\\Data\\Logs — 64 ГБ и D:\\Temp\\Old_Cache — 31 ГБ. "
    "Аудит завершён, ничего не удалялось."
)


def answer_request(**overrides):
    values = {
        "messages": [ChatMessage(role="user", content="проведи аудит папок на диске D")],
        "execution_authority": "none",
    }
    values.update(overrides)
    return ChatRequest(**values)


def test_chat_response_distinguishes_answer_from_verified_completion():
    response = ChatResponse(answer="4")
    assert response.outcome == "answered"
    assert response.outcome != "verified"


def test_answer_only_request_rejects_capability_authority():
    capability = ChatCapabilityContext(
        id="workspace.storage.audit",
        module="workspace",
        system="workspace",
        title="Audit storage",
        description="Read local directories",
        risk="read",
    )
    with pytest.raises(ValidationError, match="answer-only chat"):
        answer_request(capabilities=[capability])


def test_coordinator_owned_chat_requires_durable_turn_binding():
    with pytest.raises(ValidationError, match="requires turn_id"):
        answer_request(persistence_owner="coordinator")


def test_exact_incident_fake_response_is_replaced_before_persistence():
    sanitized = replace_unexecuted_tool_promise(answer_request(), INCIDENT_FAKE_RESPONSE)
    assert sanitized != INCIDENT_FAKE_RESPONSE
    assert "ничего не было выполнено" in sanitized
    assert "D:\\Projects\\Archive" not in sanitized


def test_text_confirmation_request_is_non_authoritative():
    sanitized = replace_unexecuted_tool_promise(
        answer_request(),
        "Напиши «подтверждаю», и я начну удаление.",
    )
    assert "ничего не было выполнено" in sanitized
