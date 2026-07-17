from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal

from fastapi import Request, status
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from starlette.concurrency import iterate_in_threadpool

from .model_runtime import LocalModelRuntime
from .router import select_model_tier
from .schemas import ChatMessage, MAX_CHAT_MESSAGE_CHARS, MAX_CHAT_MESSAGES
from .sharing_qwen import (
    QwenSharingRuntime,
    available_qwen_chat_models,
    find_qwen_chat_model,
    is_qwen_chat_model_available,
)
from .sharing_tts import (
    QwenTtsSharingRuntime,
    TtsSynthesisError,
    available_qwen_tts_models,
)


PUBLIC_MODEL_TIERS: tuple[tuple[str, str], ...] = (
    ("monarch-fast", "gemma4-fast"),
    ("monarch-balanced", "gemma4-balanced"),
    ("monarch-deep", "gemma4-deepthinking"),
    ("monarch-extra", "gemma4-31b"),
)

MODEL_ALIASES = {
    "monarch-fast": "gemma4-fast",
    "gemma4-fast": "gemma4-fast",
    "weak": "gemma4-fast",
    "monarch-balanced": "gemma4-balanced",
    "gemma4-balanced": "gemma4-balanced",
    "medium": "gemma4-balanced",
    "monarch-deep": "gemma4-deepthinking",
    "gemma4-deepthinking": "gemma4-deepthinking",
    "powerful": "gemma4-deepthinking",
    "reasoning": "gemma4-deepthinking",
    "monarch-extra": "gemma4-31b",
    "gemma4-31b": "gemma4-31b",
}

AUTO_MODEL_ALIASES = {"auto", "monarch", "monarch-auto"}


@dataclass(frozen=True, slots=True)
class SharingChatTarget:
    provider: Literal["gemma", "qwen"]
    model_id: str
    strict: bool

TIER_FALLBACKS = {
    "gemma4-fast": ("gemma4-fast", "gemma4-balanced", "gemma4-deepthinking"),
    "gemma4-balanced": ("gemma4-balanced", "gemma4-fast", "gemma4-deepthinking"),
    "gemma4-deepthinking": ("gemma4-deepthinking", "gemma4-balanced", "gemma4-fast"),
    "gemma4-31b": ("gemma4-31b", "gemma4-deepthinking", "gemma4-balanced", "gemma4-fast"),
}


class SharingMessage(BaseModel):
    model_config = ConfigDict(extra="ignore")

    role: Literal["system", "developer", "user", "assistant"]
    content: str = Field(min_length=1, max_length=MAX_CHAT_MESSAGE_CHARS)

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("message content must not be blank")
        return value

    def to_chat_message(self) -> ChatMessage:
        role = "system" if self.role == "developer" else self.role
        return ChatMessage(role=role, content=self.content)


class SharingStreamOptions(BaseModel):
    model_config = ConfigDict(extra="ignore")

    include_usage: bool = False


class SharingChatRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    model: str = Field(default="monarch-auto", min_length=1, max_length=160)
    messages: list[SharingMessage] = Field(min_length=1, max_length=MAX_CHAT_MESSAGES)
    stream: bool = False
    stream_options: SharingStreamOptions | None = None
    temperature: float = Field(default=0.3, ge=0.0, le=1.5)
    top_p: float = Field(default=0.9, ge=0.1, le=1.0)
    max_tokens: int | None = Field(default=None, ge=32, le=8192)
    max_completion_tokens: int | None = Field(default=None, ge=32, le=8192)
    reasoning_effort: Literal["low", "medium", "high"] = "low"
    n: int = Field(default=1, ge=1, le=1)

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("model must not be blank")
        return cleaned

    @model_validator(mode="after")
    def validate_messages(self) -> "SharingChatRequest":
        if not any(message.role == "user" for message in self.messages):
            raise ValueError("messages must include a user message")
        return self

    def output_token_limit(self) -> int:
        return self.max_completion_tokens or self.max_tokens or 1024

    def chat_messages(self) -> list[ChatMessage]:
        return [message.to_chat_message() for message in self.messages]


class SharingSpeechRequest(BaseModel):
    """OpenAI-style speech request supported by the local Qwen TTS bridge."""

    model_config = ConfigDict(extra="ignore")

    model: str = Field(min_length=1, max_length=160)
    input: str = Field(min_length=1, max_length=3_000)
    voice: str = Field(default="", max_length=160)
    response_format: Literal["wav"] = "wav"
    language: str = Field(default="ru-RU", min_length=2, max_length=32)
    instructions: str = Field(default="", max_length=320)

    @field_validator("model", "input", "voice", "language", "instructions")
    @classmethod
    def normalize_speech_fields(cls, value: str) -> str:
        cleaned = " ".join(value.split())
        if not cleaned and value is not None:
            return ""
        return cleaned

    @model_validator(mode="after")
    def validate_speech_request(self) -> "SharingSpeechRequest":
        if not self.model:
            raise ValueError("model must not be blank")
        if not self.input:
            raise ValueError("input must not be blank")
        if not self.language:
            raise ValueError("language must not be blank")
        return self


def build_openai_models(runtime: LocalModelRuntime) -> dict:
    availability = runtime.available_gemma4_tiers()
    mock = bool(getattr(runtime.settings, "mock_model", False))
    data = [
        openai_model_object("monarch-auto")
        for _ in [0]
        if mock or any(availability.values())
    ]
    data.extend(
        openai_model_object(model_id)
        for model_id, tier in PUBLIC_MODEL_TIERS
        if mock or availability.get(tier, False)
    )
    data.extend(
        openai_model_object(model.id)
        for model in available_qwen_chat_models(runtime.settings)
    )
    return {"object": "list", "data": data}


def build_openai_tts_models(tts_runtime: QwenTtsSharingRuntime) -> dict:
    return {
        "object": "list",
        "data": [
            {
                **openai_model_object(model.id),
                "type": "tts",
                "label": model.label,
                "capabilities": ["audio.speech"],
            }
            for model in tts_runtime.available_models()
        ],
    }


def build_openai_model(runtime: LocalModelRuntime, model_id: str) -> dict | None:
    normalized = model_id.strip().lower()
    listed = build_openai_models(runtime)["data"]
    return next((model for model in listed if model["id"] == normalized), None)


async def create_openai_chat_completion(
    request: SharingChatRequest,
    http_request: Request,
    *,
    runtime: LocalModelRuntime,
    acquire_inference_slot: Callable[[], Awaitable[asyncio.Lock | None]],
    unload_after_generation: Callable[[], None],
    qwen_runtime: QwenSharingRuntime | None = None,
):
    qwen_runtime = qwen_runtime or QwenSharingRuntime(runtime.settings)
    try:
        target = resolve_request_target(request, runtime)
    except SharingRequestError as exc:
        return exc.response()

    inference_slot = await acquire_inference_slot()
    if inference_slot is None:
        return openai_error_response(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Monarch Sharing inference queue is busy. Try again shortly.",
            error_type="rate_limit_error",
            code="inference_queue_busy",
        )

    runtime.reset_generation_cancel()
    qwen_runtime.reset_generation_cancel()
    try:
        ram = runtime.ram_assessment(target.model_id if target.provider == "gemma" else "gemma4-fast")
    except Exception as exc:
        inference_slot.release()
        return openai_error_response(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            safe_generation_error(exc),
            error_type="server_error",
            code="runtime_assessment_failed",
        )
    if ram.get("ram_warning") == "critical":
        inference_slot.release()
        return openai_error_response(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            str(ram.get("ram_warning_message") or "Not enough free RAM for the selected local model."),
            error_type="server_error",
            code="insufficient_memory",
        )

    completion_id = f"chatcmpl-{uuid.uuid4().hex}"
    created = int(time.time())
    messages = request.chat_messages()
    max_tokens = request.output_token_limit()
    release_model = unload_after_generation

    if target.provider == "qwen":
        unload = getattr(runtime, "unload", None)
        if callable(unload):
            unload()
        release_model = qwen_runtime.unload
    else:
        qwen_runtime.unload()

    if request.stream:
        events = stream_openai_completion(
            request=request,
            http_request=http_request,
            runtime=runtime,
            qwen_runtime=qwen_runtime,
            messages=messages,
            target=target,
            max_tokens=max_tokens,
            completion_id=completion_id,
            created=created,
            inference_slot=inference_slot,
            unload_after_generation=release_model,
        )
        return StreamingResponse(
            events,
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    generator = None
    pieces: list[str] = []
    try:
        generator = stream_target_chat(
            target,
            runtime=runtime,
            qwen_runtime=qwen_runtime,
            messages=messages,
            max_tokens=max_tokens,
            temperature=request.temperature,
            top_p=request.top_p,
        )
        async for piece in iterate_in_threadpool(generator):
            pieces.append(piece)
        answer = "".join(pieces)
        if not answer.strip():
            return openai_error_response(
                status.HTTP_502_BAD_GATEWAY,
                "The local model returned an empty response.",
                error_type="server_error",
                code="empty_model_response",
            )
        active_model = active_public_model(target, runtime)
        usage = estimate_openai_usage(runtime, messages, answer, max_tokens)
        return {
            "id": completion_id,
            "object": "chat.completion",
            "created": created,
            "model": active_model,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": answer},
                    "finish_reason": "stop",
                }
            ],
            "usage": usage,
        }
    except Exception as exc:
        logging.exception("Monarch Sharing generation failed")
        return openai_error_response(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            safe_generation_error(exc),
            error_type="server_error",
            code="local_generation_failed",
        )
    finally:
        close_generator(generator)
        release_inference_resources(inference_slot, release_model)


async def stream_openai_completion(
    *,
    request: SharingChatRequest,
    http_request: Request,
    runtime: LocalModelRuntime,
    qwen_runtime: QwenSharingRuntime,
    messages: list[ChatMessage],
    target: SharingChatTarget,
    max_tokens: int,
    completion_id: str,
    created: int,
    inference_slot: asyncio.Lock,
    unload_after_generation: Callable[[], None],
):
    pieces: list[str] = []
    generator = None
    next_disconnect_check = 0.0
    try:
        public_model = active_public_model(target, runtime)
        yield sse_data(openai_chunk(completion_id, created, public_model, role="assistant"))
        generator = stream_target_chat(
            target,
            runtime=runtime,
            qwen_runtime=qwen_runtime,
            messages=messages,
            max_tokens=max_tokens,
            temperature=request.temperature,
            top_p=request.top_p,
        )
        async for piece in iterate_in_threadpool(generator):
            now = time.monotonic()
            if now >= next_disconnect_check:
                next_disconnect_check = now + 0.05
                if await http_request.is_disconnected():
                    if target.provider == "qwen":
                        qwen_runtime.cancel_generation()
                    else:
                        runtime.cancel_generation()
                    return
            pieces.append(piece)
            active_model = active_public_model(target, runtime)
            yield sse_data(openai_chunk(completion_id, created, active_model, content=piece))

        active_model = active_public_model(target, runtime)
        yield sse_data(openai_chunk(completion_id, created, active_model, finish_reason="stop"))
        if request.stream_options and request.stream_options.include_usage:
            usage = estimate_openai_usage(runtime, messages, "".join(pieces), max_tokens)
            yield sse_data({
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": active_model,
                "choices": [],
                "usage": usage,
            })
        yield "data: [DONE]\n\n"
    except Exception as exc:
        logging.exception("Monarch Sharing stream failed")
        yield sse_data({
            "error": {
                "message": safe_generation_error(exc),
                "type": "server_error",
                "param": None,
                "code": "local_generation_failed",
            }
        })
        yield "data: [DONE]\n\n"
    finally:
        close_generator(generator)
        release_inference_resources(inference_slot, unload_after_generation)


def resolve_request_target(
    request: SharingChatRequest,
    runtime: LocalModelRuntime,
) -> SharingChatTarget:
    requested = request.model.strip().lower()
    availability = runtime.available_gemma4_tiers()
    mock = bool(getattr(runtime.settings, "mock_model", False))

    if requested in AUTO_MODEL_ALIASES:
        selected = select_model_tier(
            [message.model_dump() for message in request.messages],
            use_reasoning=request.reasoning_effort == "high",
        )
        if selected == "gemma4-deepthinking" and request.reasoning_effort != "high":
            selected = "gemma4-balanced"
        if mock:
            return SharingChatTarget("gemma", selected, False)
        for candidate in TIER_FALLBACKS[selected]:
            if availability.get(candidate, False):
                return SharingChatTarget("gemma", candidate, False)
        raise SharingRequestError(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "No local Monarch text model is available.",
            error_type="server_error",
            code="no_local_models",
        )

    qwen_model = find_qwen_chat_model(requested)
    if qwen_model is not None:
        if not is_qwen_chat_model_available(runtime.settings, qwen_model):
            raise SharingRequestError(
                status.HTTP_404_NOT_FOUND,
                f"The model '{request.model}' is not installed locally.",
                error_type="invalid_request_error",
                code="model_not_found",
            )
        return SharingChatTarget("qwen", qwen_model.id, True)

    tier = MODEL_ALIASES.get(requested)
    if tier is None:
        raise SharingRequestError(
            status.HTTP_404_NOT_FOUND,
            f"The model '{request.model}' does not exist in Monarch Sharing.",
            error_type="invalid_request_error",
            code="model_not_found",
        )
    if not mock and not availability.get(tier, False):
        raise SharingRequestError(
            status.HTTP_404_NOT_FOUND,
            f"The model '{request.model}' is not installed locally.",
            error_type="invalid_request_error",
            code="model_not_found",
        )
    return SharingChatTarget("gemma", tier, True)


def stream_target_chat(
    target: SharingChatTarget,
    *,
    runtime: LocalModelRuntime,
    qwen_runtime: QwenSharingRuntime,
    messages: list[ChatMessage],
    max_tokens: int,
    temperature: float,
    top_p: float,
):
    if target.provider == "qwen":
        return qwen_runtime.stream_raw_chat(
            target.model_id,
            messages,
            max_tokens,
            temperature,
            top_p,
        )
    return runtime.stream_raw_chat(
        target.model_id,
        messages,
        max_tokens,
        temperature,
        top_p,
        strict_tier=target.strict,
    )


def active_public_model(target: SharingChatTarget, runtime: LocalModelRuntime) -> str:
    if target.provider == "qwen":
        return target.model_id
    return public_model_for_tier(runtime.active_tier or target.model_id)


async def create_openai_speech(
    request: SharingSpeechRequest,
    *,
    tts_runtime: QwenTtsSharingRuntime,
    acquire_inference_slot: Callable[[], Awaitable[asyncio.Lock | None]],
) -> Response | JSONResponse:
    inference_slot = await acquire_inference_slot()
    if inference_slot is None:
        return openai_error_response(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Monarch Sharing inference queue is busy. Try again shortly.",
            error_type="rate_limit_error",
            code="inference_queue_busy",
        )
    try:
        result = await asyncio.to_thread(tts_runtime.synthesize, request)
        return Response(
            content=result.audio,
            media_type="audio/wav",
            headers={
                "X-Monarch-TTS-Model": result.model,
                "X-Monarch-TTS-Sample-Rate": str(result.sample_rate),
                "Content-Disposition": 'inline; filename="monarch-speech.wav"',
            },
        )
    except TtsSynthesisError as exc:
        status_code = (
            status.HTTP_404_NOT_FOUND
            if exc.code == "model_not_found"
            else status.HTTP_503_SERVICE_UNAVAILABLE
        )
        return openai_error_response(
            status_code,
            str(exc),
            error_type="invalid_request_error" if status_code == status.HTTP_404_NOT_FOUND else "server_error",
            code=exc.code,
        )
    except Exception as exc:
        logging.exception("Monarch Sharing TTS generation failed")
        return openai_error_response(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            safe_generation_error(exc),
            error_type="server_error",
            code="tts_generation_failed",
        )
    finally:
        if inference_slot.locked():
            inference_slot.release()


def openai_model_object(model_id: str) -> dict:
    return {
        "id": model_id,
        "object": "model",
        "created": 0,
        "owned_by": "monarch",
    }


def public_model_for_tier(tier: str) -> str:
    return next((model_id for model_id, model_tier in PUBLIC_MODEL_TIERS if model_tier == tier), tier)


def openai_chunk(
    completion_id: str,
    created: int,
    model: str,
    *,
    role: str | None = None,
    content: str | None = None,
    finish_reason: str | None = None,
) -> dict:
    delta = {}
    if role:
        delta["role"] = role
    if content is not None:
        delta["content"] = content
    return {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": delta,
                "finish_reason": finish_reason,
            }
        ],
    }


def estimate_openai_usage(
    runtime: LocalModelRuntime,
    messages: list[ChatMessage],
    answer: str,
    max_tokens: int,
) -> dict[str, int]:
    try:
        return runtime.estimate_raw_chat_usage(messages, answer, max_tokens)
    except Exception:
        prompt_chars = sum(len(message.content) for message in messages)
        prompt_tokens = max(1, round(prompt_chars / 4))
        completion_tokens = max(0, round(len(answer) / 4))
        return {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        }


def sse_data(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}\n\n"


def close_generator(generator) -> None:
    if generator is None:
        return
    close = getattr(generator, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            logging.exception("Monarch Sharing generator cleanup failed")


def release_inference_resources(
    inference_slot: asyncio.Lock,
    unload_after_generation: Callable[[], None],
) -> None:
    try:
        unload_after_generation()
    except Exception:
        logging.exception("Monarch Sharing model unload failed")
    finally:
        if inference_slot.locked():
            inference_slot.release()


def safe_generation_error(exc: Exception) -> str:
    detail = " ".join(str(exc).split())[:240]
    return f"Local model generation failed: {detail or type(exc).__name__}"


def openai_error_response(
    status_code: int,
    message: str,
    *,
    error_type: str,
    code: str,
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "error": {
                "message": message,
                "type": error_type,
                "param": None,
                "code": code,
            }
        },
    )


class SharingRequestError(RuntimeError):
    def __init__(self, status_code: int, message: str, *, error_type: str, code: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message
        self.error_type = error_type
        self.code = code

    def response(self) -> JSONResponse:
        return openai_error_response(
            self.status_code,
            self.message,
            error_type=self.error_type,
            code=self.code,
        )
