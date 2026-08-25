from pathlib import Path
from types import SimpleNamespace
import sys

from fastapi.testclient import TestClient


backend_dir = Path(__file__).resolve().parents[1]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from oscar_agent.config import Settings
from oscar_agent.model_runtime import LocalModelRuntime
from oscar_agent.schemas import ChatMessage
from oscar_agent.sharing_qwen import QwenSharingRuntime
from oscar_agent.sharing_tts import TtsSynthesisResult
from oscar_agent import main as main_module


class FakeSharingRuntime:
    def __init__(
        self,
        qwen_models_dir: Path | None = None,
        *,
        finish_reason: str = "stop",
        fail_after_first_piece: bool = False,
    ):
        self.settings = SimpleNamespace(
            mock_model=False,
            sharing_qwen_models_dir=qwen_models_dir or Path(__file__).parent / "missing-qwen-models",
            auto_unload_after_generation=False,
        )
        self.active_tier = None
        self.received_messages = []
        self.received_response_format = None
        self.received_context_tokens = None
        self.received_enable_thinking = None
        self.strict_tier = None
        self.cancelled = False
        self.unloaded = False
        self.finish_reason = finish_reason
        self.fail_after_first_piece = fail_after_first_piece
        self.last_generation_stop_reason = "unknown"

    def available_gemma4_tiers(self):
        return {
            "gemma4-fast": True,
            "gemma4-balanced": True,
            "gemma4-deepthinking": False,
            "gemma4-31b": False,
        }

    def reset_generation_cancel(self):
        self.cancelled = False

    def cancel_generation(self):
        self.cancelled = True

    def unload(self):
        self.unloaded = True

    def ram_assessment(self, _tier):
        return {"ram_warning": "none"}

    def stream_raw_chat(
        self,
        tier,
        messages,
        _max_tokens,
        _temperature,
        _top_p,
        *,
        strict_tier=False,
        response_format=None,
        context_tokens=None,
        enable_thinking=None,
    ):
        self.active_tier = tier
        self.received_messages = messages
        self.strict_tier = strict_tier
        self.received_response_format = response_format
        self.received_context_tokens = context_tokens
        self.received_enable_thinking = enable_thinking
        yield "local "
        if self.fail_after_first_piece:
            self.last_generation_stop_reason = "error"
            raise RuntimeError("synthetic generation failure")
        yield "answer"
        self.last_generation_stop_reason = self.finish_reason

    def estimate_raw_chat_usage(self, _messages, _answer, _max_tokens):
        return {"prompt_tokens": 4, "completion_tokens": 2, "total_tokens": 6}


class FakeQwenRuntime:
    def __init__(self):
        self.unloaded = False
        self.received_model = None
        self.received_response_format = None
        self.cancelled = False
        self.last_generation_stop_reason = "unknown"

    def reset_generation_cancel(self):
        self.cancelled = False

    def cancel_generation(self):
        self.cancelled = True

    def unload(self):
        self.unloaded = True

    def stream_raw_chat(
        self,
        model_id,
        _messages,
        _max_tokens,
        _temperature,
        _top_p,
        response_format=None,
    ):
        self.received_model = model_id
        self.received_response_format = response_format
        yield "qwen "
        yield "answer"
        self.last_generation_stop_reason = "stop"


class FakeTtsRuntime:
    def available_models(self):
        return (SimpleNamespace(id="qwen3-tts-0.6b-base", label="Qwen3-TTS 0.6B Base"),)

    def synthesize(self, request):
        assert request.model == "qwen3-tts-0.6b-base"
        return TtsSynthesisResult(audio=b"RIFF\x24\x00\x00\x00WAVEfmt ", model=request.model, sample_rate=24000)


def configured_client(monkeypatch, runtime=None, qwen_runtime=None, tts_runtime=None):
    runtime = runtime or FakeSharingRuntime()
    monkeypatch.setattr(
        main_module,
        "settings",
        Settings(
            api_token="sharing-test-token",
            auto_unload_after_generation=False,
            recycle_backend_after_generation=False,
        ),
    )
    monkeypatch.setattr(main_module, "model_runtime", runtime)
    monkeypatch.setattr(main_module, "sharing_qwen_runtime", qwen_runtime or FakeQwenRuntime())
    monkeypatch.setattr(main_module, "sharing_tts_runtime", tts_runtime or FakeTtsRuntime())
    return TestClient(main_module.app), runtime


def auth_headers():
    return {"Authorization": "Bearer sharing-test-token"}


def test_sharing_models_requires_authentication(monkeypatch):
    client, _runtime = configured_client(monkeypatch)

    response = client.get("/v1/models")

    assert response.status_code == 401


def test_sharing_lists_only_available_local_models(monkeypatch):
    client, _runtime = configured_client(monkeypatch)

    response = client.get("/v1/models", headers=auth_headers())

    assert response.status_code == 200
    assert [entry["id"] for entry in response.json()["data"]] == [
        "monarch-auto",
        "monarch-fast",
        "monarch-balanced",
    ]


def test_sharing_lists_installed_qwen_super_fast_models(monkeypatch, tmp_path):
    for filename in ("qwen2.5-0.5b-instruct-q4_k_m.gguf", "qwen3-1.7b-q4_k_m.gguf"):
        (tmp_path / filename).write_bytes(b"GGUF")
    client, _runtime = configured_client(monkeypatch, FakeSharingRuntime(tmp_path))

    response = client.get("/v1/models", headers=auth_headers())

    assert response.status_code == 200
    assert [entry["id"] for entry in response.json()["data"]][-2:] == [
        "qwen2.5-0.5b-instruct",
        "qwen3-1.7b-instruct",
    ]


def test_sharing_qwen_chat_uses_super_fast_runtime(monkeypatch, tmp_path):
    (tmp_path / "qwen2.5-0.5b-instruct-q4_k_m.gguf").write_bytes(b"GGUF")
    qwen_runtime = FakeQwenRuntime()
    client, runtime = configured_client(monkeypatch, FakeSharingRuntime(tmp_path), qwen_runtime=qwen_runtime)

    response = client.post(
        "/v1/chat/completions",
        headers=auth_headers(),
        json={
            "model": "qwen2.5-0.5b-instruct",
            "messages": [{"role": "user", "content": "Answer locally."}],
            "response_format": {"type": "json_object"},
        },
    )

    assert response.status_code == 200
    assert response.json()["model"] == "qwen2.5-0.5b-instruct"
    assert response.json()["choices"][0]["message"]["content"] == "qwen answer"
    assert qwen_runtime.received_model == "qwen2.5-0.5b-instruct"
    assert qwen_runtime.received_response_format == {"type": "json_object"}
    assert qwen_runtime.unloaded is False
    assert runtime.unloaded is True
    assert runtime.received_messages == []


def test_sharing_tts_lists_models_and_returns_wav(monkeypatch):
    client, _runtime = configured_client(monkeypatch, tts_runtime=FakeTtsRuntime())

    models = client.get("/v1/audio/models", headers=auth_headers())
    speech = client.post(
        "/v1/audio/speech",
        headers=auth_headers(),
        json={
            "model": "qwen3-tts-0.6b-base",
            "voice": "oscar",
            "input": "Привет из локального TTS.",
            "response_format": "wav",
        },
    )

    assert models.status_code == 200
    assert models.json()["data"][0]["id"] == "qwen3-tts-0.6b-base"
    assert speech.status_code == 200
    assert speech.headers["content-type"].startswith("audio/wav")
    assert speech.headers["x-monarch-tts-model"] == "qwen3-tts-0.6b-base"
    assert speech.content.startswith(b"RIFF")


def test_sharing_chat_uses_raw_caller_messages(monkeypatch):
    qwen_runtime = FakeQwenRuntime()
    client, runtime = configured_client(monkeypatch, qwen_runtime=qwen_runtime)

    response = client.post(
        "/v1/chat/completions",
        headers=auth_headers(),
        json={
            "model": "monarch-balanced",
            "messages": [
                {"role": "developer", "content": "Caller-owned system rule."},
                {"role": "user", "content": "Say hello locally."},
            ],
            "max_tokens": 64,
            "response_format": {"type": "json_object"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["object"] == "chat.completion"
    assert body["model"] == "monarch-balanced"
    assert body["choices"][0]["message"] == {
        "role": "assistant",
        "content": "local answer",
    }
    assert body["usage"] == {
        "prompt_tokens": 4,
        "completion_tokens": 2,
        "total_tokens": 6,
    }
    assert body["monarch_runtime"]["queue_latency_ms"] >= 0
    assert body["monarch_runtime"]["load_latency_ms"] >= 0
    assert body["monarch_runtime"]["generation_latency_ms"] >= 0
    assert [(message.role, message.content) for message in runtime.received_messages] == [
        ("system", "Caller-owned system rule."),
        ("user", "Say hello locally."),
    ]
    assert runtime.strict_tier is True
    assert runtime.received_response_format == {"type": "json_object"}
    assert qwen_runtime.unloaded is True


def test_sharing_uses_the_exact_context_selected_by_ram_admission(monkeypatch):
    runtime = FakeSharingRuntime()
    runtime.available_gemma4_tiers = lambda: {
        "gemma4-fast": True,
        "gemma4-balanced": True,
        "qwen3.8-27b-pro": True,
    }
    runtime.ram_assessment = lambda _tier: {
        "ram_warning": "none",
        "effective_context_tokens": 16384,
    }
    client, _runtime = configured_client(monkeypatch, runtime)

    response = client.post(
        "/v1/chat/completions",
        headers=auth_headers(),
        json={
            "model": "monarch-pro",
            "messages": [{"role": "user", "content": "Привет, что ты умеешь?"}],
            "inference_lane": "agent",
        },
    )

    assert response.status_code == 200
    assert runtime.received_context_tokens == 16384
    assert runtime.received_enable_thinking is False


def test_agent_lane_reuses_exact_resident_model_above_emergency_ram_floor(monkeypatch):
    runtime = FakeSharingRuntime()
    runtime.loaded = True
    runtime.active_tier = "gemma4-fast"
    runtime.ram_assessment = lambda _tier: {
        "ram_warning": "critical",
        "ram_available_gb": 1.2,
        "ram_warning_message": "Synthetic low-memory pressure.",
    }
    client, _runtime = configured_client(monkeypatch, runtime)

    response = client.post(
        "/v1/chat/completions",
        headers=auth_headers(),
        json={
            "model": "monarch-fast",
            "messages": [{"role": "user", "content": "Continue the bounded agent task."}],
            "inference_lane": "agent",
        },
    )

    assert response.status_code == 200
    assert response.json()["monarch_runtime"]["resident_model_reused_under_pressure"] is True


def test_agent_session_reuses_exact_resident_model_with_half_gib_emergency_reserve(monkeypatch):
    runtime = FakeSharingRuntime()
    runtime.loaded = True
    runtime.active_tier = "gemma4-fast"
    runtime.ram_assessment = lambda _tier: {
        "ram_warning": "critical",
        "ram_available_gb": 0.75,
        "ram_warning_message": "Synthetic low-memory pressure.",
    }
    client, _runtime = configured_client(monkeypatch, runtime)

    response = client.post(
        "/v1/chat/completions",
        headers=auth_headers(),
        json={
            "model": "monarch-fast",
            "messages": [{"role": "user", "content": "Continue the same bounded agent task."}],
            "inference_lane": "agent",
            "agent_session_id": "agent_task_fixture",
        },
    )

    assert response.status_code == 200
    assert response.json()["monarch_runtime"]["resident_model_reused_under_pressure"] is True


def test_agent_session_extends_backend_recycle_window(monkeypatch):
    recycle_delays = []
    client, _runtime = configured_client(monkeypatch)
    monkeypatch.setattr(main_module, "unload_after_generation", lambda delay=5.0: recycle_delays.append(delay))

    response = client.post(
        "/v1/chat/completions",
        headers=auth_headers(),
        json={
            "model": "monarch-fast",
            "messages": [{"role": "user", "content": "Continue the same bounded agent task."}],
            "inference_lane": "agent",
            "agent_session_id": "agent_task_fixture",
        },
    )

    assert response.status_code == 200
    assert recycle_delays == [45.0]


def test_resident_model_pressure_exception_stays_closed_for_interactive_or_emergency_ram(monkeypatch):
    runtime = FakeSharingRuntime()
    runtime.loaded = True
    runtime.active_tier = "gemma4-fast"
    available_ram = 1.2
    runtime.ram_assessment = lambda _tier: {
        "ram_warning": "critical",
        "ram_available_gb": available_ram,
        "ram_warning_message": "Synthetic low-memory pressure.",
    }
    client, _runtime = configured_client(monkeypatch, runtime)
    request = {
        "model": "monarch-fast",
        "messages": [{"role": "user", "content": "Continue."}],
    }

    interactive = client.post("/v1/chat/completions", headers=auth_headers(), json=request)
    available_ram = 0.8
    emergency = client.post(
        "/v1/chat/completions",
        headers=auth_headers(),
        json={**request, "inference_lane": "agent"},
    )
    available_ram = 0.4
    session_emergency = client.post(
        "/v1/chat/completions",
        headers=auth_headers(),
        json={**request, "inference_lane": "agent", "agent_session_id": "agent_task_fixture"},
    )

    assert interactive.status_code == 503
    assert interactive.json()["error"]["code"] == "insufficient_memory"
    assert emergency.status_code == 503
    assert emergency.json()["error"]["code"] == "insufficient_memory"
    assert session_emergency.status_code == 503
    assert session_emergency.json()["error"]["code"] == "insufficient_memory"


def test_sharing_stream_uses_openai_sse_contract(monkeypatch):
    client, _runtime = configured_client(monkeypatch)

    response = client.post(
        "/v1/chat/completions",
        headers=auth_headers(),
        json={
            "model": "monarch-fast",
            "messages": [{"role": "user", "content": "Stream locally."}],
            "stream": True,
            "stream_options": {"include_usage": True},
        },
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert '"role":"assistant"' in response.text
    assert '"content":"local "' in response.text
    assert '"finish_reason":"stop"' in response.text
    assert '"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}' in response.text
    assert response.text.rstrip().endswith("data: [DONE]")


def test_sharing_non_stream_preserves_native_length_finish_reason(monkeypatch):
    runtime = FakeSharingRuntime(finish_reason="length")
    client, _runtime = configured_client(monkeypatch, runtime)

    response = client.post(
        "/v1/chat/completions",
        headers=auth_headers(),
        json={
            "model": "monarch-fast",
            "messages": [{"role": "user", "content": "Reach the limit."}],
            "max_tokens": 32,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["choices"][0]["finish_reason"] == "length"
    assert body["monarch_runtime"]["generation_stop_reason"] == "length"
    assert body["monarch_runtime"]["likely_truncated"] is True


def test_sharing_non_stream_preserves_unsupported_native_tool_call_finish(monkeypatch):
    runtime = FakeSharingRuntime(finish_reason="tool_calls")
    client, _runtime = configured_client(monkeypatch, runtime)

    response = client.post(
        "/v1/chat/completions",
        headers=auth_headers(),
        json={
            "model": "monarch-fast",
            "messages": [{"role": "user", "content": "Try to call a tool"}],
            "stream": False,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["choices"][0]["finish_reason"] == "tool_calls"
    assert body["monarch_runtime"]["generation_stop_reason"] == "tool_calls"
    assert body["monarch_runtime"]["likely_truncated"] is False


def test_sharing_stream_preserves_native_length_finish_reason(monkeypatch):
    runtime = FakeSharingRuntime(finish_reason="length")
    client, _runtime = configured_client(monkeypatch, runtime)

    response = client.post(
        "/v1/chat/completions",
        headers=auth_headers(),
        json={
            "model": "monarch-fast",
            "messages": [{"role": "user", "content": "Stream to the limit."}],
            "stream": True,
        },
    )

    assert response.status_code == 200
    assert '"finish_reason":"length"' in response.text
    assert '"generation_stop_reason":"length"' in response.text
    assert '"likely_truncated":true' in response.text
    assert response.text.rstrip().endswith("data: [DONE]")


def test_sharing_does_not_invent_stop_when_runtime_reason_is_unknown(monkeypatch):
    runtime = FakeSharingRuntime(finish_reason="unknown")
    client, _runtime = configured_client(monkeypatch, runtime)

    response = client.post(
        "/v1/chat/completions",
        headers=auth_headers(),
        json={
            "model": "monarch-fast",
            "messages": [{"role": "user", "content": "Unknown terminal reason."}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["choices"][0]["finish_reason"] is None
    assert body["monarch_runtime"]["generation_stop_reason"] == "unknown"
    assert body["monarch_runtime"]["likely_truncated"] is False


def test_sharing_stream_emits_error_instead_of_false_stop_after_partial_generation(monkeypatch):
    runtime = FakeSharingRuntime(fail_after_first_piece=True)
    client, _runtime = configured_client(monkeypatch, runtime)

    response = client.post(
        "/v1/chat/completions",
        headers=auth_headers(),
        json={
            "model": "monarch-fast",
            "messages": [{"role": "user", "content": "Fail after one piece."}],
            "stream": True,
        },
    )

    assert response.status_code == 200
    assert '"content":"local "' in response.text
    assert '"code":"local_generation_failed"' in response.text
    assert '"finish_reason":"stop"' not in response.text
    assert response.text.rstrip().endswith("data: [DONE]")


def test_qwen_sharing_tracks_native_length_finish_reason(monkeypatch, tmp_path):
    model_path = tmp_path / "qwen2.5-0.5b-instruct-q4_k_m.gguf"
    model_path.write_bytes(b"GGUF")
    runtime = QwenSharingRuntime(SimpleNamespace(sharing_qwen_models_dir=tmp_path))
    fake_llama = SimpleNamespace(
        create_chat_completion=lambda **_kwargs: iter([
            {"choices": [{"delta": {"content": "bounded"}, "finish_reason": None}]},
            {"choices": [{"delta": {}, "finish_reason": "length"}]},
            {"choices": [{"delta": {"content": "poisoned-late-token"}, "finish_reason": "stop"}]},
        ])
    )
    monkeypatch.setattr(runtime, "_load", lambda _model: fake_llama)

    pieces = list(runtime.stream_raw_chat(
        "qwen2.5-0.5b-instruct",
        [ChatMessage(role="user", content="Bounded Qwen output.")],
        32,
        0.1,
        0.9,
    ))

    assert pieces == ["bounded"]
    assert runtime.last_generation_stop_reason == "length"


def test_qwen_sharing_marks_mid_stream_runtime_cancellation(monkeypatch, tmp_path):
    model_path = tmp_path / "qwen2.5-0.5b-instruct-q4_k_m.gguf"
    model_path.write_bytes(b"GGUF")
    runtime = QwenSharingRuntime(SimpleNamespace(sharing_qwen_models_dir=tmp_path))

    def native_stream():
        yield {"choices": [{"delta": {"content": "first"}, "finish_reason": None}]}
        runtime.cancel_generation()
        yield {"choices": [{"delta": {"content": "must-not-leak"}, "finish_reason": "stop"}]}

    fake_llama = SimpleNamespace(create_chat_completion=lambda **_kwargs: native_stream())
    monkeypatch.setattr(runtime, "_load", lambda _model: fake_llama)

    pieces = list(runtime.stream_raw_chat(
        "qwen2.5-0.5b-instruct",
        [ChatMessage(role="user", content="Cancel Qwen output.")],
        32,
        0.1,
        0.9,
    ))

    assert pieces == ["first"]
    assert runtime.last_generation_stop_reason == "cancelled"


def test_sharing_rejects_unknown_model_with_openai_error_shape(monkeypatch):
    client, _runtime = configured_client(monkeypatch)

    response = client.post(
        "/v1/chat/completions",
        headers=auth_headers(),
        json={
            "model": "cloud-model",
            "messages": [{"role": "user", "content": "Do not leave this machine."}],
        },
    )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "model_not_found"


def test_raw_runtime_prompt_keeps_only_caller_messages(tmp_path):
    runtime = LocalModelRuntime(
        Settings(
            mock_model=True,
            data_dir=tmp_path / "data",
            db_path=tmp_path / "data" / "memory.sqlite3",
            offload_dir=tmp_path / "offload",
            gemma_models_dir=tmp_path / "models",
            workspace_generated_dir=tmp_path / "generated",
        )
    )
    messages = [
        ChatMessage(role="system", content="Only the caller system prompt."),
        ChatMessage(role="user", content="No Oscar context."),
    ]

    prompt, _max_tokens, _metadata = runtime._prepare_raw_prompt_messages(messages, 64)

    assert [(message.role, message.content) for message in prompt] == [
        ("system", "Only the caller system prompt."),
        ("user", "No Oscar context."),
    ]
    assert "Authoritative local runtime facts" not in "\n".join(message.content for message in prompt)
