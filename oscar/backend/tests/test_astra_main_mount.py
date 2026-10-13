"""Real main composition in a fresh process with every data path synthetic."""
import os
import subprocess
import sys
from pathlib import Path


def test_actual_main_auth_descriptor_and_shared_shutdown(tmp_path):
    script = r'''
import asyncio, json, os, sys
from pathlib import Path
root = Path(sys.argv[1])
for key in ("CONFIG", "DATA", "PAYLOAD", "MODELS", "GENERATED", "SECRETS", "WORKSPACE", "STATE"):
    os.environ["MONARCH_" + key + "_ROOT"] = str(root / key.lower())
os.environ["OSCAR_API_TOKEN"] = "synthetic-main-" + "x" * 48
digests = {"gemma4-fast": "sha256:" + "a" * 64,
    "gemma4-balanced": "sha256:" + "b" * 64,
    "qwen3-coder-30b-a3b-instruct": "sha256:" + "c" * 64,
    "deepseek-coder-v2-lite-instruct": "sha256:" + "d" * 64}
fast = root / "models/gemma_models/Gemma_E2B/gemma-4-E2B-it-Q5_K_M.gguf"
balanced = root / "models/gemma_models/Gemma_12B/gemma-4-12B-it-Q4_K_M.gguf"
fast.parent.mkdir(parents=True, exist_ok=True); balanced.parent.mkdir(parents=True, exist_ok=True)
fast.write_bytes(b"fast"); balanced.write_bytes(b"balanced")
os.environ["OSCAR_ASTRA_LOCAL_COMPONENT"] = json.dumps({"version": 2, "root": str(root / "models"),
    "components": [
        {"relativePath": "gemma_models/Gemma_E2B/gemma-4-E2B-it-Q5_K_M.gguf", "tier": "gemma4-fast",
         "variants": [{"size": 4, "digest": digests["gemma4-fast"]}]},
        {"relativePath": "gemma_models/Gemma_12B/gemma-4-12B-it-Q4_K_M.gguf", "tier": "gemma4-balanced",
         "variants": [{"size": 8, "digest": digests["gemma4-balanced"]}]},
        {"relativePath": "runtime/coder/models/qwen3-coder-30b-a3b-instruct/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf",
         "tier": "qwen3-coder-30b-a3b-instruct", "variants": [{"size": 5, "digest": digests["qwen3-coder-30b-a3b-instruct"]}]},
        {"relativePath": "runtime/coder/models/deepseek-coder-v2-lite-instruct/DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf",
         "tier": "deepseek-coder-v2-lite-instruct", "variants": [{"size": 6, "digest": digests["deepseek-coder-v2-lite-instruct"]}]},
    ]})
from oscar_agent import config
settings = config.Settings(_env_file=None, data_dir=root / "data", db_path=root / "data/memory.sqlite3",
    offload_dir=root / "offload", workspace_root=root / "workspace", workspace_generated_dir=root / "generated",
    gemma_models_dir=root / "models/gemma_models", qwen_models_dir=root / "qwen", coder_models_dir=root / "coder",
    memory_embedding_model_dir=root / "missing-embedding", api_token=os.environ["OSCAR_API_TOKEN"], mock_model=True)
settings.ensure_dirs()
config.get_settings = lambda: settings
from oscar_agent import main
import httpx
async def run():
    assert main.astra_local_service is not None
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://fixture") as client:
        url = "/internal/astra/v3/model-descriptor"
        assert (await client.get(url)).status_code == 401
        settings.disable_api_token = True
        assert (await client.get(url)).status_code == 401
        client.headers["X-Oscar-Token"] = settings.api_token
        descriptor = await client.get(url)
        assert descriptor.status_code == 200 and descriptor.json()["configurationOnly"] is True
        assert descriptor.json()["modelDigest"] == digests["gemma4-fast"]
        assert descriptor.json()["modelDigests"] == {key: digests[key] for key in ("gemma4-fast", "gemma4-balanced")}
        assert descriptor.headers["cache-control"] == "no-store"
        assert not main.model_runtime.loaded
        response = await client.post("/internal/astra/v3/model-turns", json={"requestId":"one", "executionId":"one",
            "expectedModelDigest":"sha256:" + "b"*64, "responseSchema":{"type":"object"}, "maxOutputTokens":32})
        assert response.status_code == 409 and not main.get_inference_coordinator().locked()
    calls = []
    main.memory_v4.start_background = lambda: None
    main.memory_v4.close = lambda: calls.append("memory")
    main.sharing_qwen_runtime.unload = lambda: calls.append("sharing")
    main.model_runtime.unload = lambda: calls.append("model")
    lease = await main.get_inference_coordinator().acquire("interactive", timeout_seconds=1)
    async def release():
        await asyncio.sleep(.05)
        assert calls == []
        lease.release()
    pending = asyncio.create_task(release())
    async with main.app_lifespan(main.app):
        pass
    await pending
    assert calls == ["memory", "sharing", "model"]
    assert await main.astra_local_service.wait_closed()
asyncio.run(run())
print("ASTRA_MAIN_MOUNT_PASS")
'''
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
    result = subprocess.run([sys.executable, "-B", "-c", script, str(tmp_path)],
        cwd=tmp_path, env=env, capture_output=True, text=True, timeout=45)
    assert result.returncode == 0, result.stderr[-5000:]
    assert "ASTRA_MAIN_MOUNT_PASS" in result.stdout
