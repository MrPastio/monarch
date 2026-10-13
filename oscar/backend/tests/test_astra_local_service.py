import asyncio
import os
import json

import httpx
import pytest
from fastapi import FastAPI, Header

from oscar_agent.astra_local_service import AstraLocalModelService, create_owned_astra_local_service
from oscar_agent.inference_coordinator import InferenceCoordinator
from oscar_agent import astra_prepared_driver as prepared_module
from astra_model_fixture import FixtureLlama, FixturePreparedDriver
from test_astra_residency import setup
from test_memory_v4 import make_services, create_explicit, POLICY_HASH

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows owned asset pin")


def owned_component(root, variants=None):
    return {"version": 1, "root": str(root), "tier": "gemma4-fast",
        "relativePath": "gemma_models/Gemma_E2B/gemma-4-E2B-it-Q5_K_M.gguf",
        "variants": variants or [{"size": 4, "digest": "sha256:" + "a" * 64}]}


@pytest.mark.asyncio
async def test_process_owner_mount_authentication_variant_and_generation(tmp_path, monkeypatch):
    runtime, _, _ = setup(tmp_path, monkeypatch)
    _, _, memory = make_services(tmp_path / "owner-memory")
    coordinator = InferenceCoordinator(asyncio.Lock())
    candidate = tmp_path / owned_component(tmp_path)["relativePath"]
    candidate.parent.mkdir(parents=True, exist_ok=True)
    candidate.write_bytes(b"GGUFlegacy")
    component = owned_component(tmp_path, [{"size": 4, "digest": "sha256:" + "a" * 64},
        {"size": 10, "digest": "sha256:" + "b" * 64}])
    args = dict(component_json=json.dumps(component), api_token="s" * 48,
        runtime=runtime, memory=memory, coordinator=lambda: coordinator)
    service = create_owned_astra_local_service(**args)
    replacement = create_owned_astra_local_service(**args)
    assert service.host.host_generation != replacement.host.host_generation
    app = FastAPI(); app.include_router(service.router)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as client:
            assert (await client.get("/internal/astra/v3/model-descriptor")).status_code == 401
            response = await client.get("/internal/astra/v3/model-descriptor", headers={"X-Oscar-Token": "s" * 48})
            assert response.status_code == 200
            assert response.json()["modelDigest"] == "sha256:" + "b" * 64
            assert response.headers["cache-control"] == "no-store"
            assert str(tmp_path) not in response.text
            assert not runtime.loaded and not coordinator.locked()
    finally:
        assert await service.wait_closed()
        assert await replacement.wait_closed()
        memory.close()


@pytest.mark.parametrize("mutation", [
    {"tier": "mock"}, {"relativePath": "../other.gguf"}, {"root": "relative"}, {"version": True},
    {"variants": []}, {"variants": [{"size": True, "digest": "sha256:" + "a" * 64}]},
    {"variants": [{"size": 4, "digest": "bad"}]}, {"extra": True},
])
def test_process_owner_configuration_rejects_ambiguous_authority(tmp_path, mutation):
    component = {**owned_component(tmp_path), **mutation}
    with pytest.raises(ValueError):
        create_owned_astra_local_service(component_json=json.dumps(component), api_token="s" * 48,
            runtime=None, memory=None, coordinator=lambda: None)


def test_no_inherited_token_bypass_or_default_activation(tmp_path):
    args = dict(api_token="", runtime=None, memory=None, coordinator=lambda: None)
    assert create_owned_astra_local_service(component_json=None, **args) is None
    with pytest.raises(ValueError, match="owner-configuration"):
        create_owned_astra_local_service(component_json=json.dumps(owned_component(tmp_path)), **args)


@pytest.mark.asyncio
@pytest.mark.parametrize("revoke", [False, True])
async def test_composed_http_service_owns_admission_queue_and_memory_guard(tmp_path, monkeypatch, revoke):
    runtime, asset, _ = setup(tmp_path, monkeypatch)
    _, context, memory = make_services(tmp_path / "memory-fixture")
    receipt = create_explicit(context, request_id="seed", text="synthetic fact")
    token = memory.read_context_validity({"type": "chat"})["validityToken"]
    llama = FixtureLlama()
    llama.close = lambda: None
    loads = []
    def load(*_args, **_kwargs):
        loads.append(True)
        runtime._llama_model = llama
    monkeypatch.setattr(runtime, "_load_llama", load)
    monkeypatch.setattr(prepared_module, "AstraPreparedLlamaTextDriver", FixturePreparedDriver)
    coordinator = InferenceCoordinator(asyncio.Lock())
    async def authenticate(authorization: str = Header(default="")):
        return "owner" if authorization == "Bearer synthetic-owner" else "other"
    service = AstraLocalModelService(runtime=runtime, memory=memory, coordinator=lambda: coordinator,
        components={"gemma4-fast": asset}, owner_actor="owner", authenticate=authenticate)
    app = FastAPI()
    app.include_router(service.router)
    prefix = "/internal/astra/v3/model-turns"
    request = {"requestId": "one", "executionId": "one", "expectedModelDigest": asset.digest,
        "responseSchema": {"type": "object", "properties": {"kind": {"const": "request-completion"}},
            "required": ["kind"], "additionalProperties": False}, "maxOutputTokens": 128,
        "memoryValidityToken": token}
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as client:
            assert (await client.get("/internal/astra/v3/model-descriptor")).status_code == 403
            assert (await client.post(prefix, json=request)).status_code == 403
            client.headers["Authorization"] = "Bearer synthetic-owner"
            descriptor = await client.get("/internal/astra/v3/model-descriptor")
            assert descriptor.status_code == 200 and descriptor.headers["cache-control"] == "no-store"
            assert descriptor.json()["modelDigest"] == asset.digest and not loads
            wrong = await client.post(prefix, json={**request, "expectedModelDigest": "sha256:" + "0" * 64})
            assert wrong.status_code == 409 and not loads and not coordinator.locked()
            opened = await client.post(prefix, json=request)
            assert opened.status_code == 200 and len(loads) == 1 and coordinator.locked()
            turn = opened.json()["turnId"]
            prepared = (await client.post(prefix + "/" + turn + "/prepare", json={"surface": "synthetic input"})).json()
            if revoke:
                context.execute(client_request_id="delete", command="memory.delete", scope={"type": "chat"},
                    expected_revision=1, payload={"id": receipt["result"]["record"]["id"]}, policy_decision_hash=POLICY_HASH)
            generated = await client.post(prefix + "/" + turn + "/generate",
                json={"preparedId": prepared["preparedId"], "promptDigest": prepared["promptDigest"]})
            assert generated.status_code == (409 if revoke else 200)
            if revoke:
                assert generated.json()["detail"]["code"] == "memory-source-stale"
            assert len(llama.submissions) == (0 if revoke else 1)
            assert not coordinator.locked()
    finally:
        assert await service.wait_closed()
        runtime._release_model_memory()
        memory.close()


@pytest.mark.asyncio
async def test_astra_open_declines_cuda_tier_swap_and_recycles_after_release(tmp_path, monkeypatch):
    runtime, asset, calls = setup(tmp_path, monkeypatch)
    _, _, memory = make_services(tmp_path / "memory-fixture")
    runtime.load_tier("gemma4-balanced")
    runtime.device_map = {"backend": "cuda"}
    released = []
    monkeypatch.setattr(runtime, "_release_model_memory", lambda: released.append(True))
    coordinator = InferenceCoordinator(asyncio.Lock())
    recycles = []
    def request_recycle(delay):
        recycles.append((delay, coordinator.locked()))
    async def authenticate(authorization: str = Header(default="")):
        return "owner"
    service = AstraLocalModelService(runtime=runtime, memory=memory, coordinator=lambda: coordinator,
        components={"gemma4-fast": asset}, owner_actor="owner", authenticate=authenticate,
        request_recycle=request_recycle)
    app = FastAPI()
    app.include_router(service.router)
    request = {"requestId": "swap", "executionId": "swap", "expectedModelDigest": asset.digest,
        "responseSchema": {"type": "object", "properties": {"kind": {"const": "request-completion"}},
            "required": ["kind"], "additionalProperties": False}, "maxOutputTokens": 128}
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as client:
            declined = await client.post("/internal/astra/v3/model-turns", json=request)
            for _ in range(20):
                if recycles:
                    break
                await asyncio.sleep(0.01)
        assert declined.status_code == 409 and declined.json()["detail"]["code"] == "model-tier-recycle-required"
        assert len(calls) == 1 and not released and runtime.active_tier == "gemma4-balanced"
        assert recycles == [(0.25, False)] and not coordinator.locked()
    finally:
        assert await service.wait_closed()
        monkeypatch.undo()
        memory.close()
