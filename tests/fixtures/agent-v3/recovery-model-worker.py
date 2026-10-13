"""Opt-in decision probe: real production loader, synthetic stdin, no product main.

Only the exact existing Fast model is read; all mutable state stays in a marked
test child. This is not HTTP/Kernel/native-chat acceptance.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import time

repository = Path(__file__).resolve().parents[3]
directory = Path(sys.argv[1]).resolve(strict=True)
parent = (repository / ".test-tmp").resolve(strict=True)
if parent != Path("D:/Monarch-test-tmp-astra-v3") or directory.parent != parent:
    raise RuntimeError("recovery-probe-root")
if not directory.name.startswith("agent-recovery-model-"):
    raise RuntimeError("recovery-probe-child")
if (directory / ".owner").read_text() != "monarch-synthetic-agent-recovery-v1":
    raise RuntimeError("recovery-probe-marker")
model = Path("E:/MonarchData/models/gemma_models/Gemma_E2B/gemma-4-E2B-it-Q5_K_M.gguf")
if model.resolve(strict=True) != model or model.stat().st_size != 3356035200:
    raise RuntimeError("recovery-probe-model")

# Do not inherit user profile/config/model paths or token factories.
for key in list(os.environ):
    if key.startswith(("OSCAR_", "MONARCH_")):
        del os.environ[key]
os.environ["TEMP"] = os.environ["TMP"] = str(directory)
sys.path.insert(0, str(repository / "oscar" / "backend"))
from oscar_agent.config import Settings
from oscar_agent.model_runtime import LocalModelRuntime
from oscar_agent.schemas import ChatMessage

settings = Settings(_env_file=None, api_token=None,
    model_path=model, gemma_models_dir=model.parent,
    data_dir=directory / "data", db_path=directory / "data" / "unused.sqlite",
    offload_dir=directory / "offload", qwen_models_dir=directory / "unused-qwen",
    coder_models_dir=directory / "unused-coder",
    memory_embedding_model_dir=directory / "unused-embedding",
    workspace_root=directory / "workspace", workspace_generated_dir=directory / "generated",
    mock_model=False, mock_fallback=False, gemma_speculative_decoding=False,
    gemma4_fast_context_tokens=4096, suppress_llama_logs=True)
runtime = LocalModelRuntime(settings)
try:
    for index, line in enumerate(sys.stdin):
        if index >= 12:
            raise RuntimeError("recovery-probe-call-budget")
        request = json.loads(line)
        if request["role"] != "gemma4-fast":
            raise RuntimeError("recovery-probe-exact-model")
        started = time.perf_counter()
        try:
            reply = "".join(runtime.stream_raw_chat("gemma4-fast",
                [ChatMessage(**message) for message in request["messages"]],
                min(request.get("maxTokens", 256), 768), 0, 0.9,
                strict_tier=True, enable_thinking=False,
                response_format=({"type": "json_object", **(
                    {"schema": request["responseJsonSchema"]} if request.get("responseJsonSchema") else {})}
                    if request.get("responseFormat") == "json" else None)))
            result = dict(ok=True, rawText=reply, finishReason=runtime.last_generation_stop_reason,
                activeTier=runtime.active_tier, mock=settings.mock_model,
                fallback=runtime.fallback_active, context=runtime.last_context_window)
        except Exception as error:
            result = dict(ok=False, error=str(error))
        result["durationMs"] = round((time.perf_counter() - started) * 1000)
        print(json.dumps(result, ensure_ascii=True), flush=True)
finally:
    runtime.unload()
