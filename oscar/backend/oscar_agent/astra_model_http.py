"""Opt-in router factory. main.py deliberately does not mount these endpoints."""
from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from contextlib import suppress
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .astra_model_host import AstraPreparedModelHost
from .astra_prepared_driver import AstraModelError, bounded_json


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _BoundedModelRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def bounded(request: Request):
            # Bound bytes BEFORE FastAPI/Pydantic parses a possibly huge JSON
            # body. Only this opt-in router is affected, not legacy endpoints.
            encoded_length = request.headers.get("content-length")
            if encoded_length is not None and (not encoded_length.isdigit() or int(encoded_length) > 1048576):
                raise HTTPException(413, detail={"code": "request-byte-budget"})
            body = bytearray()
            deadline = time.monotonic() + 5
            receive = request.receive
            for _ in range(4096):
                try:
                    message = await asyncio.wait_for(receive(), timeout=max(0, deadline - time.monotonic()))
                except asyncio.TimeoutError:
                    raise HTTPException(408, detail={"code": "request-body-deadline"}) from None
                if message["type"] == "http.disconnect":
                    raise HTTPException(499, detail={"code": "caller-disconnected"})
                if message["type"] != "http.request":
                    raise HTTPException(400, detail={"code": "request-body-shape"})
                body.extend(message.get("body", b""))
                if len(body) > 1048576:
                    raise HTTPException(413, detail={"code": "request-byte-budget"})
                if not message.get("more_body", False):
                    break
            else:
                raise HTTPException(413, detail={"code": "request-frame-budget"})
            replayed = False

            async def replay_body():
                nonlocal replayed
                if not replayed:
                    replayed = True
                    return {"type": "http.request", "body": bytes(body), "more_body": False}
                return await receive()  # Preserve actual disconnect observations.

            return await handler(Request(request.scope, receive=replay_body))

        return bounded


class AstraOpenModelTurn(_Strict):
    requestId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,96}$")
    executionId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,96}$")
    expectedModelDigest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    responseSchema: dict
    maxOutputTokens: int = Field(default=1024, ge=1, le=8192)
    timeoutMs: int = Field(default=60000, ge=20, le=120000)
    lane: Literal["interactive", "agent", "coder", "background"] = "agent"
    notAfterMs: int | None = Field(default=None, ge=1, le=9007199254740991)
    memoryValidityToken: str | None = Field(default=None, pattern=r"^sha256:[0-9a-f]{64}$")

    @field_validator("responseSchema")
    @classmethod
    def schema_bound(cls, value: dict) -> dict:
        try:
            bounded_json(value, 24000)
        except AstraModelError as exc:
            raise ValueError(exc.code) from None
        return value


class AstraSettleModelTurn(AstraOpenModelTurn):
    notAfterMs: int = Field(ge=1, le=9007199254740991)


class AstraPrepareModelTurn(_Strict):
    surface: str = Field(min_length=1, max_length=524288)

    @field_validator("surface")
    @classmethod
    def utf8_bound(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 524288:
            raise ValueError("surface-size")
        return value


class AstraGenerateModelTurn(_Strict):
    preparedId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,96}$")
    promptDigest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")


def create_astra_model_router(host: AstraPreparedModelHost, *, authenticate: Callable) -> APIRouter:
    """authenticate MUST return an application-authenticated opaque actor ID.

    There is no permissive default, path discovery, memory API or model output
    acting as admission. Production mounting/actor-source admission is separate.
    """
    router = APIRouter(prefix="/internal/astra/v3/model-turns", route_class=_BoundedModelRoute)

    async def call(request: Request, operation: Callable[[], Awaitable[dict]]) -> dict:
        task = asyncio.create_task(operation())
        try:
            while not task.done():
                await asyncio.wait({task}, timeout=0.05)
                if not task.done() and await request.is_disconnected():
                    task.cancel()
                    with suppress(asyncio.CancelledError):
                        await task
                    raise HTTPException(499, detail={"code": "caller-disconnected"})
            return task.result()
        except AstraModelError as exc:
            # Do not echo the raw model, context or underlying native exception.
            raise HTTPException(409, detail={"code": exc.code}) from None
        finally:
            if not task.done():
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task

    @router.post("")
    async def open_turn(body: AstraOpenModelTurn, request: Request, actor: str = Depends(authenticate)):
        return await call(request, lambda: host.open(actor=actor, request_id=body.requestId, execution_id=body.executionId,
            expected_model_digest=body.expectedModelDigest, schema=body.responseSchema,
            max_output_tokens=body.maxOutputTokens, timeout_ms=body.timeoutMs, lane=body.lane, not_after_ms=body.notAfterMs,
            memory_validity_token=body.memoryValidityToken))

    @router.post("/settle-request")
    async def settle_request(body: AstraSettleModelTurn, actor: str = Depends(authenticate)):
        try:
            return host.settle_request(actor=actor, request_id=body.requestId, execution_id=body.executionId,
                expected_model_digest=body.expectedModelDigest, schema=body.responseSchema,
                max_output_tokens=body.maxOutputTokens, timeout_ms=body.timeoutMs, lane=body.lane, not_after_ms=body.notAfterMs,
                memory_validity_token=body.memoryValidityToken)
        except AstraModelError as exc:
            raise HTTPException(409, detail={"code": exc.code}) from None

    @router.post("/{turn_id}/prepare")
    async def prepare_turn(turn_id: str, body: AstraPrepareModelTurn, request: Request, actor: str = Depends(authenticate)):
        return await call(request, lambda: host.prepare(actor=actor, turn_id=turn_id, surface=body.surface))

    @router.post("/{turn_id}/generate")
    async def generate_turn(turn_id: str, body: AstraGenerateModelTurn, request: Request, actor: str = Depends(authenticate)):
        return await call(request, lambda: host.generate(actor=actor, turn_id=turn_id,
            prepared_id=body.preparedId, prompt_digest=body.promptDigest))

    @router.get("/{turn_id}")
    async def inspect_turn(turn_id: str, actor: str = Depends(authenticate)):
        try:
            return host.inspect(actor=actor, turn_id=turn_id)
        except AstraModelError as exc:
            raise HTTPException(409, detail={"code": exc.code}) from None

    @router.delete("/{turn_id}")
    async def cancel_turn(turn_id: str, actor: str = Depends(authenticate)):
        try:
            return host.cancel(actor=actor, turn_id=turn_id)
        except AstraModelError as exc:
            raise HTTPException(409, detail={"code": exc.code}) from None

    return router
