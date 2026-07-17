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
from oscar_agent.sharing_tts import TtsSynthesisResult
from oscar_agent import main as main_module


class FakeSharingRuntime:
    def __init__(self, qwen_models_dir: Path | None = None):
        self.settings = SimpleNamespace(
            mock_model=False,
            sharing_qwen_models_dir=qwen_models_dir or Path(__file__).parent / "missing-qwen-models",
        )
        self.active_tier = None
        self.received_messages = []
        self.strict_tier = None
        self.cancelled = False

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
    ):
        self.active_tier = tier
        self.received_messages = messages
        self.strict_tier = strict_tier
        yield "local "
        yield "answer"

    def estimate_raw_chat_usage(self, _messages, _answer, _max_tokens):
        return {"prompt_tokens": 4, "completion_tokens": 2, "total_tokens": 6}


class FakeQwenRuntime:
    def __init__(self):
        self.unloaded = False
        self.received_model = None
        self.cancelled = False

    def reset_generation_cancel(self):
        self.cancelled = False

    def cancel_generation(self):
        self.cancelled = True

    def unload(self):
        self.unloaded = True

    def stream_raw_chat(self, model_id, _messages, _max_tokens, _temperature, _top_p):
        self.received_model = model_id
        yield "qwen "
        yield "answer"


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
        },
    )

    assert response.status_code == 200
    assert response.json()["model"] == "qwen2.5-0.5b-instruct"
    assert response.json()["choices"][0]["message"]["content"] == "qwen answer"
    assert qwen_runtime.received_model == "qwen2.5-0.5b-instruct"
    assert qwen_runtime.unloaded is True
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
    client, runtime = configured_client(monkeypatch)

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
    assert [(message.role, message.content) for message in runtime.received_messages] == [
        ("system", "Caller-owned system rule."),
        ("user", "Say hello locally."),
    ]
    assert runtime.strict_tier is True


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
