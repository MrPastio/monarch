"""Existing conversation append service, independent of model/application startup.

MemoryStore remains the sole conversation content authority. The exact-content
receipt confirms persistence only; it is not permission or verified task output.
"""
import hashlib

from fastapi import HTTPException

from .memory import (
    ClientMessageConflictError,
    ConversationMessagePrerequisiteError,
    ConversationMessageSupersededError,
    ConversationMessageCausalParentError,
    MemoryStore,
)
from .schemas import ConversationMessageCreate


def append_conversation_message(memory: MemoryStore, conversation_id: str, request: ConversationMessageCreate) -> dict:
    try:
        message = memory.append_conversation_message(
            conversation_id, request.role, request.content,
            token_count=request.token_count, elapsed_ms=request.elapsed_ms,
            model_tier=request.model_tier, client_message_id=request.client_message_id,
            turn_id=request.turn_id, task_id=request.task_id, provenance=request.provenance,
            outcome=request.outcome, integrity_warning=request.integrity_warning,
            max_fallback_code=request.max_fallback_code,
            research_steps=request.research_steps,
            create_conversation_if_missing=request.create_conversation_if_missing,
            required_previous_message_id=request.required_previous_message_id,
            attachments=request.attachments, sources=request.sources,
            content_mode=request.content_mode,
            causal_parent_id=request.causal_parent_id,
        )
    except ClientMessageConflictError as exc:
        raise HTTPException(status_code=409, detail={"code": "client-message-reused", "message": str(exc)}) from exc
    except ConversationMessagePrerequisiteError as exc:
        raise HTTPException(status_code=409, detail={
            "code": "conversation-message-prerequisite-pending", "message": str(exc), "retryable": True,
        }) from exc
    except ConversationMessageCausalParentError as exc:
        raise HTTPException(status_code=409, detail={"code": "conversation-causal-parent-mismatch", "message": str(exc)}) from exc
    except ConversationMessageSupersededError:
        # No insertion: never attach an exact persistence receipt to this result.
        return {"ok": True, "disposition": "superseded", "message": None, "duplicate": False}
    result = {"ok": True, "disposition": "duplicate" if message is None else "created",
              "message": message, "duplicate": message is None}
    if request.content_mode == "exact":
        # On replay MemoryStore compares actual stored text and all immutable
        # bindings before returning None. Legacy normalized history is not repaired.
        result.update(content_mode="exact", content_sha256=hashlib.sha256(request.content.encode("utf-8")).hexdigest())
    if request.causal_parent_id:
        result["causal_parent_id"] = request.causal_parent_id
    return result
