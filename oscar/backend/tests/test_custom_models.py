"""Owner-added GGUF models run as their own strict tier."""
import json
import struct

import pytest

from oscar_agent import main as main_module
from oscar_agent.config import Settings
from oscar_agent.custom_models import custom_gpu_layers, is_custom_tier, read_custom_models
from oscar_agent.model_runtime import LocalModelRuntime, normalize_gemma4_tier, tier_fallback_chain

TIER = "custom-a1b2c3d4e5f6"


def write_registry(root, model_path, *, status="ready", context=16384):
    root.mkdir(parents=True, exist_ok=True)
    (root / "registry.v1.json").write_text(json.dumps({
        "schemaVersion": 1,
        "models": [{
            "id": TIER,
            "label": "My Llama",
            "source": "file",
            "path": str(model_path),
            "sizeBytes": 3 * 1024 ** 3,
            "contextTokens": context,
            "addedAt": "2026-09-26T00:00:00Z",
            "origin": None,
            "status": status,
            "downloadedBytes": 0,
            "error": None,
        }],
    }), encoding="utf-8")


def gguf(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gguf_bytes())
    return path


def gguf_bytes(*, draft=False, mtp=False, auxiliary=False, split=False):
    def u32(n): return struct.pack("<I", n)
    def u64(n): return struct.pack("<Q", n)
    def string(s):
        b = s.encode()
        return u64(len(b)) + b
    def field(k, v): return string(k) + u32(8 if isinstance(v, str) else 4) + (string(v) if isinstance(v, str) else u32(v))
    fields = [field("general.architecture", "clip" if auxiliary else "qwen35"), field("general.type", "model"),
              field("qwen35.block_count", 3), field("qwen35.nextn_predict_layers", 1 if draft or mtp else 0),
              field("split.count", 2 if split else 1)]
    tensors = [string(f"blk.{i}.attn_norm.weight") + u32(1) + u64(8) + u32(0) + u64(0) for i in ([2] if draft else [0, 1, 2])]
    return b"GGUF" + u32(3) + u64(len(tensors)) + u64(len(fields)) + b"".join(fields + tensors)


@pytest.mark.parametrize("options,code", [({"draft": True}, "custom-model-draft-only"), ({"auxiliary": True}, "custom-model-auxiliary"), ({"split": True}, "custom-model-split")])
def test_non_chat_files_are_refused_before_native_or_mock(tmp_path, monkeypatch, options, code):
    from oscar_agent.gguf_chat import GgufChatError
    model = tmp_path / "renamed.gguf"
    model.write_bytes(gguf_bytes(**options))
    root = tmp_path / "custom"
    write_registry(root, model)
    runtime = LocalModelRuntime(Settings(api_token="test", mock_fallback=True, custom_models_dir=root))
    native = []
    monkeypatch.setattr(runtime, "_load_llama", lambda *a, **k: native.append(True))
    with pytest.raises(GgufChatError, match=code):
        runtime.load_tier(TIER, allow_fallback=False)
    assert not native and not runtime.loaded and not runtime.fallback_active
    assert runtime.available_gemma4_tiers()[TIER] is False
    assert runtime._discover_custom_assets(TIER)["model_path"] is None


def test_full_model_with_mtp_is_allowed_and_filename_does_not_decide(tmp_path):
    from oscar_agent.gguf_chat import assert_chat_gguf
    model = tmp_path / "mtp-draft.gguf"
    model.write_bytes(gguf_bytes(mtp=True))
    assert_chat_gguf(model)


@pytest.mark.asyncio
async def test_custom_file_rejected_before_context_history_or_generation(tmp_path, monkeypatch):
    from fastapi import HTTPException
    from oscar_agent.schemas import ChatRequest, ChatMessage
    model = tmp_path / "chat.gguf"
    model.write_bytes(gguf_bytes(draft=True))
    root = tmp_path / "custom"
    write_registry(root, model)
    runtime = LocalModelRuntime(Settings(api_token="test", mock_fallback=True, custom_models_dir=root))
    monkeypatch.setattr(main_module, "model_runtime", runtime)
    def forbidden(*a, **k): raise AssertionError("Must refuse before history or generation")
    monkeypatch.setattr(main_module, "begin_conversation", forbidden)
    monkeypatch.setattr(main_module, "hydrate_conversation_context", forbidden)
    request = ChatRequest(messages=[ChatMessage(role="user", content="Hello")], requested_model=TIER, incognito=True)
    with pytest.raises(HTTPException) as failure:
        await main_module.chat(request)
    assert failure.value.status_code == 422
    assert failure.value.detail["code"] == "custom-model-draft-only"
    response = await main_module.chat_stream(request)
    events = [event async for event in response.body_iterator]
    assert len(events) == 2 and 'custom-model-draft-only' in events[0] and '"ok": false' in events[1]


def test_custom_tier_names_are_strict():
    assert is_custom_tier(TIER)
    assert not is_custom_tier("custom-")
    assert not is_custom_tier("custom-../x")
    assert not is_custom_tier("gemma4-fast")
    assert normalize_gemma4_tier(TIER.upper()) == TIER
    # Never silently replaced by another model.
    assert tier_fallback_chain(TIER) == (TIER,)


def test_only_ready_registry_entries_are_served(tmp_path):
    model = gguf(tmp_path / "models" / "llama.gguf")
    root = tmp_path / "custom"
    write_registry(root, model, status="downloading")
    assert read_custom_models(root) == {}
    write_registry(root, model)
    entry = read_custom_models(root)[TIER]
    assert entry.path == model and entry.context_tokens == 16384 and entry.label == "My Llama"


def test_runtime_resolves_the_owner_file_and_its_limits(tmp_path):
    model = gguf(tmp_path / "anywhere" / "llama.gguf")
    root = tmp_path / "custom"
    write_registry(root, model, context=12288)
    runtime = LocalModelRuntime(Settings(api_token="test", mock_fallback=False, custom_models_dir=root))
    path, vision, draft = runtime._resolve_gemma4_assets(TIER)
    assert path == model and vision is None and draft is None
    assert runtime._configured_context_tokens(TIER) == 12288
    assert runtime._gemma4_gpu_layers(TIER) == custom_gpu_layers(3 * 1024 ** 3)
    assert runtime.available_gemma4_tiers()[TIER] is True


def test_a_missing_file_is_reported_not_replaced(tmp_path):
    root = tmp_path / "custom"
    write_registry(root, tmp_path / "gone.gguf")
    runtime = LocalModelRuntime(Settings(api_token="test", mock_fallback=False, custom_models_dir=root))
    with pytest.raises(FileNotFoundError):
        runtime._resolve_gemma4_assets(TIER)
    assert runtime.available_gemma4_tiers()[TIER] is False


def test_chat_keeps_an_explicit_custom_choice():
    assert main_module.normalize_chat_tier(TIER) == TIER
    assert main_module.next_stronger_tier(TIER) == TIER


def test_an_opening_think_block_is_hidden_and_plain_answers_pass():
    from oscar_agent.model_runtime import _LeadingThinkBoundary

    hidden = _LeadingThinkBoundary()
    parts = ["  <thi", "nk>\nплан ответа", " и ещё</th", "ink>\n\nМеня зовут Оскар."]
    assert "".join(hidden.push(part) for part in parts) == "Меня зовут Оскар."

    plain = _LeadingThinkBoundary()
    assert "".join(plain.push(part) for part in ["Привет", "! <think> тут просто текст"]) == "Привет! <think> тут просто текст"

    structured = _LeadingThinkBoundary()
    structured.mark_structured_reasoning()
    assert structured.push("<think>x") == "<think>x"
