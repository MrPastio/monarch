"""Disposable loopback HTTP fixture; real host/driver/framing, synthetic tokens.

No default Oscar app import, model load, user settings/history or external I/O.
The only control endpoint below is fixture-only, never part of the product router.
"""
from __future__ import annotations

import asyncio
import json
import socket
import sys
from pathlib import Path

MARKER = "astra-v3-prepared-model-synthetic-only"
directory = Path(sys.argv[1]).resolve(strict=True)
repository = Path(__file__).resolve().parents[3]
parent = (repository / ".test-tmp").resolve(strict=True)
if (parent.drive.upper() != "D:" or directory.parent != parent
        or not directory.name.startswith("astra-v3-prepared-model-")
        or (directory / ".fixture-marker").read_text(encoding="utf-8") != MARKER):
    raise RuntimeError("fixture-scope")

sys.path.insert(0, str(repository / "oscar" / "backend"))
sys.path.insert(0, str(repository / "oscar" / "backend" / "tests"))

import uvicorn
from fastapi import FastAPI, Header, HTTPException, Depends
from pydantic import BaseModel, ConfigDict, Field
from astra_model_fixture import MODEL, driver_fixture
from oscar_agent.astra_model_host import AstraPreparedModelHost
from oscar_agent.astra_model_http import create_astra_model_router
from oscar_agent.inference_coordinator import InferenceCoordinator
from oscar_agent.astra_prepared_driver import ASTRA_STRUCTURED_MODEL_INSTRUCTIONS
from oscar_agent.astra_memory_guard import create_astra_memory_guard
from oscar_agent.memory_v4 import MemoryV4Service
from oscar_agent.config import Settings

driver, llama, _current = driver_fixture(instructions=ASTRA_STRUCTURED_MODEL_INSTRUCTIONS)
coordinator = None
memory_service = None
memory_guard = None
memory_rejections = 0


def current_memory(actor, token):
    global memory_rejections
    valid = memory_guard(actor, token) if memory_guard else actor == "synthetic_owner" and token == "sha256:" + "a" * 64
    if not valid:
        memory_rejections += 1
    return valid


def shared_coordinator():
    global coordinator
    if coordinator is None:
        coordinator = InferenceCoordinator(asyncio.Lock())
    return coordinator


host = AstraPreparedModelHost(deployment="isolated-validation", coordinator=shared_coordinator,
                             resident_driver=lambda _expected_digest: driver, result_retention_seconds=1.0,
                             memory_is_current=current_memory)
app = FastAPI()


async def authenticate(authorization: str = Header(default="")):
    if authorization not in ("Bearer astra-synthetic-test", "Bearer astra-synthetic-product-local-only"):
        raise HTTPException(401)
    return "synthetic_owner"


app.include_router(create_astra_model_router(host, authenticate=authenticate))


class FixtureMemory(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    root: str | None = Field(default=None, max_length=1024)


@app.post("/__fixture/memory", dependencies=[Depends(authenticate)])
async def bind_memory(body: FixtureMemory):
    global memory_service, memory_guard
    if shared_coordinator().locked():
        raise HTTPException(409, detail="fixture-busy")
    if body.root is not None:
        root = Path(body.root).resolve(strict=True)
        if (root.parent != parent or not root.name.startswith("astra-v3-memory-")
                or (root / ".fixture-marker").read_text(encoding="utf-8") != "astra-v3-memory-server-synthetic-only"
                or (root / "data" / "memory.sqlite3").resolve(strict=True) != root / "data" / "memory.sqlite3"):
            raise HTTPException(400, detail="fixture-memory-scope")
        settings = Settings(data_dir=root / "data", db_path=root / "data" / "memory.sqlite3",
                            offload_dir=root / "offload", workspace_root=root / "workspace",
                            workspace_generated_dir=root / "workspace" / "generated",
                            gemma_models_dir=root / "models", coder_models_dir=root / "coder-models",
                            memory_embedding_model_dir=root / "missing-embedding", mock_model=True)
        service = MemoryV4Service(settings)
    else:
        service = None
    previous = memory_service
    memory_service = service
    memory_guard = create_astra_memory_guard(service, owner_actor="synthetic_owner") if service else None
    if previous:
        previous.close()
    return {"syntheticOnly": True}


class FixtureControl(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    output: str = Field(max_length=16384)
    finish: str = Field(default="stop", pattern=r"^(stop|length)$")
    block: bool = False


@app.post("/__fixture/control", dependencies=[Depends(authenticate)])
async def control(body: FixtureControl):
    if shared_coordinator().locked():
        raise HTTPException(409, detail="fixture-busy")
    llama.output = body.output
    llama.finish_reason = body.finish
    llama.block = body.block
    llama.started.clear()
    llama.finish.clear()
    return {"syntheticOnly": True}


@app.post("/__fixture/release", dependencies=[Depends(authenticate)])
async def release():
    llama.finish.set()
    return {"syntheticOnly": True}


@app.get("/__fixture/metrics", dependencies=[Depends(authenticate)])
async def metrics():
    return {"syntheticOnly": True, "generationCalls": len(llama.submissions), "tokenizationCalls": len(llama.tokenizations),
            # Diagnostic only. Tests may wait for natural retirement before a new
            # independent case; they must not evict replay fences or widen limits.
            "retainedTurns": len(host._turns), "memoryRejections": memory_rejections,
            "lastSubmittedTokenCount": len(llama.submissions[-1]["prompt"]) if llama.submissions else 0,
            "slotReserved": shared_coordinator().locked(), "workerStarted": llama.started.is_set()}


listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.bind(("127.0.0.1", 0))
listener.listen(32)
print(json.dumps({"marker": MARKER, "endpoint": "http://127.0.0.1:" + str(listener.getsockname()[1]),
                  "hostGeneration": host.host_generation, "modelDigest": MODEL}), flush=True)
uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False)).run(sockets=[listener])
