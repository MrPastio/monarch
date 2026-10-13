"""Authenticated composition around the existing local model owner."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
from collections.abc import Callable
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Response

from .astra_asset_pin import AstraAssetExpectation
from .astra_memory_guard import create_astra_memory_guard
from .astra_model_host import AstraPreparedModelHost
from .astra_model_http import create_astra_model_router
from .astra_prepared_driver import AstraModelError, AstraResidentDriverProvider
from .inference_coordinator import InferenceCoordinator
from .memory_v4 import MemoryV4Service
from .model_runtime import LocalModelRuntime

# Same code the chat and /v1 guards decline with.
TIER_RECYCLE_REQUIRED = "model-tier-recycle-required"


class AstraLocalModelService:
    def __init__(self, *, runtime: LocalModelRuntime, memory: MemoryV4Service,
                 coordinator: Callable[[], InferenceCoordinator],
                 components: dict[str, AstraAssetExpectation], owner_actor: str, authenticate: Callable,
                 request_recycle: Callable[[float], None] | None = None):
        # These are host-owned admission inputs, never parsed from the model API.
        guard = create_astra_memory_guard(memory, owner_actor=owner_actor)
        provider = AstraResidentDriverProvider(runtime)
        by_digest = {asset.digest: (tier, asset) for tier, asset in components.items()}

        def resident(expected_model_digest: str):
            # Executed by host worker while holding the EXISTING inference lease.
            selected = by_digest.get(expected_model_digest)
            if selected is None:
                raise ValueError("astra-local-selected-model")
            tier, asset = selected
            if runtime.astra_load_needs_fresh_process(tier, asset):
                # Loading a second model into a CUDA process aborts ggml-cuda
                # (0xC0000409) and takes every lane down with it. Decline before
                # any native release; the process exits once this lease is gone.
                raise AstraModelError(TIER_RECYCLE_REQUIRED)
            runtime.load_tier(tier, allow_fallback=False, astra_asset=asset)
            return provider()

        def turn_ended(reason: str | None) -> None:
            # Called after the lease is released: a recycle scheduled while the
            # slot is still held is dropped by the idle check and never re-armed.
            if reason == TIER_RECYCLE_REQUIRED and request_recycle is not None:
                request_recycle(0.25)

        self.host = AstraPreparedModelHost(deployment="isolated-validation", coordinator=coordinator,
            resident_driver=resident, memory_is_current=guard,
            admitted_model_digests=frozenset(by_digest), on_turn_ended=turn_ended)
        self.model_digests = {tier: asset.digest for tier, asset in components.items()}

        async def owner(actor=Depends(authenticate)):
            if actor != owner_actor:
                raise HTTPException(403, detail={"code": "local-owner-required"})
            return owner_actor

        self.router = APIRouter()
        self.router.include_router(create_astra_model_router(self.host, authenticate=owner))

        @self.router.get("/internal/astra/v3/model-descriptor", dependencies=[Depends(owner)])
        async def descriptor(response: Response):
            response.headers["Cache-Control"] = "no-store"
            return {"schemaVersion": 1, "hostGeneration": self.host.host_generation, "hostPid": os.getpid(),
                    "modelDigest": self.model_digests["gemma4-fast"],
                    "modelDigests": self.model_digests, "memoryGuard": "chat-validity-v1",
                    "configurationOnly": True, "authority": "none"}

    async def wait_closed(self, *, timeout_ms: int = 5000) -> bool:
        # No unload here: other inference lanes still belong to the application.
        return await self.host.wait_closed(timeout_ms=timeout_ms)


def create_owned_astra_local_service(*, component_json: str | None, api_token: str,
                                    runtime: LocalModelRuntime, memory: MemoryV4Service,
                                    coordinator: Callable[[], InferenceCoordinator],
                                    request_recycle: Callable[[float], None] | None = None):
    """Process-owner configuration only. No path/digest admission HTTP endpoint.

    Monarch's existing component catalog authors this envelope when spawning
    Oscar. File size selects an allowed variant; the loader still verifies and
    pins its actual SHA-256 before publishing any resident identity.
    """
    if component_json is None:
        return None
    if not api_token or len(api_token) < 32 or len(component_json) > 8192:
        raise ValueError("astra-local-owner-configuration")
    component = json.loads(component_json)
    if not isinstance(component, dict) or not isinstance(component.get("root"), str) or not Path(component["root"]).is_absolute():
        raise ValueError("astra-local-component")
    version = component.get("version")
    if type(version) is int and version == 1:
        if set(component) != {"version", "root", "relativePath", "tier", "variants"}:
            raise ValueError("astra-local-component")
        component_rows = [{key: component[key] for key in ("relativePath", "tier", "variants")}]
    elif type(version) is int and version == 2:
        if set(component) != {"version", "root", "components"} or not isinstance(component["components"], list):
            raise ValueError("astra-local-component")
        component_rows = component["components"]
    else:
        raise ValueError("astra-local-component")
    allowed_paths = {
        "gemma4-fast": {"gemma_models/Gemma_E2B/gemma-4-E2B-it-Q5_K_M.gguf"},
        "gemma4-balanced": {"gemma_models/Gemma_12B/gemma-4-12B-it-Q4_K_M.gguf"},
        "qwen3-coder-30b-a3b-instruct": {
            "runtime/coder/models/qwen3-coder-30b-a3b-instruct/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf",
            "coder/qwen3-coder-30b-a3b-instruct/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf",
        },
        "deepseek-coder-v2-lite-instruct": {
            "runtime/coder/models/deepseek-coder-v2-lite-instruct/DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf",
            "coder/deepseek-coder-v2-lite-instruct/DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf",
        },
    }
    expected_tiers = {"gemma4-fast"} if version == 1 else set(allowed_paths)
    if (not 1 <= len(component_rows) <= 4 or any(not isinstance(row, dict)
            or set(row) != {"relativePath", "tier", "variants"}
            or not isinstance(row.get("tier"), str) or row["tier"] not in allowed_paths
            for row in component_rows)):
        raise ValueError("astra-local-component")
    if {row["tier"] for row in component_rows} != expected_tiers:
        raise ValueError("astra-local-component")
    root = Path(component["root"])
    components: dict[str, AstraAssetExpectation] = {}
    for row in component_rows:
        tier, relative, variants = row["tier"], row["relativePath"], row["variants"]
        normalized = relative.replace("\\", "/") if isinstance(relative, str) else ""
        if normalized not in allowed_paths[tier]:
            raise ValueError("astra-local-component-path")
        if (not isinstance(variants, list) or not 1 <= len(variants) <= 4
                or any(not isinstance(v, dict) or set(v) != {"size", "digest"}
                       or type(v["size"]) is not int or not 4 <= v["size"] <= 64 * 1024**3
                       or not isinstance(v["digest"], str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", v["digest"])
                       for v in variants)
                or len({v["size"] for v in variants}) != len(variants)):
            raise ValueError("astra-local-component-variants")
        candidate = root / relative
        try:
            size = candidate.stat().st_size
        except FileNotFoundError:
            size = None
        variant = next((v for v in variants if v["size"] == size), None)
        if variant is None:
            if tier == "gemma4-fast":
                raise ValueError("astra-local-required-component-unavailable")
            continue
        components[tier] = AstraAssetExpectation(root=root, candidate=candidate,
            digest=variant["digest"], size=variant["size"])
    if "gemma4-fast" not in components:
        raise ValueError("astra-local-required-component-unavailable")
    if len({asset.digest for asset in components.values()}) != len(components):
        raise ValueError("astra-local-component-digest-alias")
    actor = "astra_owner_" + hmac.new(api_token.encode(), b"monarch.astra-v3.local-owner.v1", hashlib.sha256).hexdigest()

    async def authenticate(authorization: str | None = Header(default=None),
                           x_oscar_token: str | None = Header(default=None, alias="X-Oscar-Token")):
        # The general developer token bypass never grants Astra ownership.
        supplied = authorization[7:] if authorization and authorization.startswith("Bearer ") else x_oscar_token
        if not supplied or not hmac.compare_digest(supplied, api_token):
            raise HTTPException(401, detail={"code": "local-owner-required"})
        return actor

    return AstraLocalModelService(runtime=runtime, memory=memory, coordinator=coordinator,
        components=components, owner_actor=actor, authenticate=authenticate, request_recycle=request_recycle)
