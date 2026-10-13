"""Opt-in real-CPU smoke. Only one pinned, owned GGUF under a marked D child.

No product main.py, profile/config/token reads, model discovery or provider
fallback. This is actual llama.cpp inference, never scripted model output.
"""
from __future__ import annotations

import asyncio
import json
import socket
import sys
import time
import traceback
from pathlib import Path

repository = Path(__file__).resolve().parents[3]
from owned_model_scope import admit_owned_model
directory, MARKER, profile, model_file, actual_digest = admit_owned_model(Path(sys.argv[1]), repository / '.test-tmp')

sys.path.insert(0, str(repository / "oscar" / "backend"))
from oscar_agent.config import Settings
from oscar_agent.model_runtime import LocalModelRuntime, configure_nvidia_dll_directories
from oscar_agent.astra_prepared_driver import ASTRA_STRUCTURED_MODEL_INSTRUCTIONS, AstraPreparedLlamaTextDriver
from oscar_agent.astra_model_host import AstraPreparedModelHost
from oscar_agent.astra_model_http import create_astra_model_router
from oscar_agent.inference_coordinator import InferenceCoordinator

configure_nvidia_dll_directories()
from llama_cpp import Llama
import psutil
import uvicorn
from fastapi import FastAPI, Header, HTTPException, Depends

# Explicit arguments suppress Settings' token-file factory and .env loading.
# No get_settings()/ensure_dirs(), no memory/history/source-directory scan.
settings = Settings(_env_file=None, api_token=None, model_path=model_file,
    data_dir=directory / "data", db_path=directory / "data" / "unused.sqlite", offload_dir=directory / "offload",
    gemma_models_dir=directory / "model", qwen_models_dir=directory / "unused-qwen",
    coder_models_dir=directory / "unused-coder", memory_embedding_model_dir=directory / "unused-embedding",
    workspace_root=directory / "workspace", workspace_generated_dir=directory / "generated",
    mock_model=False, mock_fallback=False, require_gpu_offload=False, suppress_llama_logs=False)
runtime = LocalModelRuntime(settings)
load_start = time.perf_counter()
resident = Llama(model_path=str(model_file), n_ctx=4096, n_threads=4, n_threads_batch=4,
                 n_batch=128, n_gpu_layers=0, offload_kqv=False, flash_attn=False,
                 use_mmap=True, use_mlock=False, verbose=False)
load_ms = round((time.perf_counter() - load_start) * 1000, 2)
runtime._llama_model = resident
runtime.loaded = True
runtime.active_tier = profile['profile']
from native_grammar_conformance import run_native_grammar_conformance
grammar_conformance = run_native_grammar_conformance(resident)
driver = AstraPreparedLlamaTextDriver(runtime, model_digest="sha256:" + actual_digest,
    expected_tier=runtime.active_tier, instructions=ASTRA_STRUCTURED_MODEL_INSTRUCTIONS,
    is_residency_current=lambda: runtime._llama_model is resident)
if len(sys.argv) == 3 and sys.argv[2] == '--quality-probe':
    import tempfile
    from owned_quality_probe import run_owned_quality_probe
    try:
        result = run_owned_quality_probe(runtime, resident, 'sha256:' + actual_digest)
        result.update(loadMs=load_ms, contextTokens=resident.n_ctx(), threads=4, gpuLayers=0,
                      grammarConformance=grammar_conformance)
        artifact_parent = Path('D:/Monarch-artifacts').resolve(strict=True)
        if artifact_parent != Path('D:/Monarch-artifacts'):
            raise RuntimeError('quality-artifact-parent')
        artifact = Path(tempfile.mkdtemp(prefix='astra-v3-quality-20260831-', dir=artifact_parent)).resolve(strict=True)
        if artifact.parent != artifact_parent:
            raise RuntimeError('quality-artifact-scope')
        (artifact / 'quality-probe.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({**result, 'artifact': str(artifact)}, ensure_ascii=False), flush=True)
    finally:
        resident.close()
    raise SystemExit(0)
actual_generate = driver.generate


def diagnose_owned_generation(*args):
    counts["generationWorkerActive"] = True
    started = time.perf_counter()
    try:
        output = actual_generate(*args)
        counts["finishReason"] = output['finishReason']
        return output
    except Exception:
        # QA-only synthetic-input traceback. Product transport still returns a
        # bounded code and never exposes prompt/native exception contents.
        traceback.print_exc(file=sys.stderr)
        raise
    finally:
        counts["nativeGenerationMs"] = round((time.perf_counter() - started) * 1000, 2)
        counts["generationWorkerActive"] = False


driver.generate = diagnose_owned_generation
counts = {"generationCalls": 0, "nativePromptTokenCount": 0, "generationWorkerActive": False,
          "nativeGenerationMs": None, "finishReason": None}
native_completion = resident.create_completion


def measured_completion(**kwargs):
    counts["generationCalls"] += 1
    counts["nativePromptTokenCount"] = len(kwargs["prompt"])
    # Preserve the streaming iterator and its native lifetime unchanged. Measure
    # at the driver's consuming boundary above, not at iterator construction.
    return native_completion(**kwargs)


resident.create_completion = measured_completion
coordinator = None


def shared_coordinator():
    global coordinator
    if coordinator is None:
        coordinator = InferenceCoordinator(asyncio.Lock())
    return coordinator


host = AstraPreparedModelHost(deployment="isolated-validation", coordinator=shared_coordinator,
                              resident_driver=lambda _expected_digest: driver)
app = FastAPI()


async def authenticate(authorization: str = Header(default="")):
    if authorization != "Bearer astra-owned-live-smoke":
        raise HTTPException(401)
    return "owned_live_fixture"


app.include_router(create_astra_model_router(host, authenticate=authenticate))


@app.get("/__fixture/metrics", dependencies=[Depends(authenticate)])
async def metrics():
    return {**counts, "realModel": True, "modelSha256": actual_digest, "loadMs": load_ms,
            "grammarConformance": grammar_conformance,
            "contextTokens": resident.n_ctx(), "gpuLayers": 0, "threads": 4,
            "rssBytes": psutil.Process().memory_info().rss,
            "slotReserved": shared_coordinator().locked(), "binding": driver.inspect().wire()}


listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.bind(("127.0.0.1", 0))
listener.listen(16)
print(json.dumps({"marker": MARKER, "realModel": True, "endpoint": "http://127.0.0.1:" + str(listener.getsockname()[1]),
                  "hostGeneration": host.host_generation, "modelDigest": "sha256:" + actual_digest}), flush=True)
try:
    uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False)).run(sockets=[listener])
finally:
    # Normal shutdown follows an idle host. The owning harness may terminate the
    # whole disposable process on failure; never close a live user model handle.
    if coordinator is None or not coordinator.locked():
        resident.close()
