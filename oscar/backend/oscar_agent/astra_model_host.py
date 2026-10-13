"""Bounded prepared model turns sharing Oscar's existing inference coordinator.

The service is not instantiated by main.py. A host must explicitly supply its
existing coordinator and a host-selected admitted driver, plus authenticated
actors at the transport boundary. No second GPU lock, open-ended model discovery
or tool executor.
"""
from __future__ import annotations

import asyncio
import json
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

from .astra_prepared_driver import AstraDriverBinding, AstraModelError, AstraPreparedInput, bounded_json, require, sha256
from .inference_coordinator import InferenceCoordinator, InferenceLane, InferenceSlotLease


class AstraPreparedDriver(Protocol):
    def inspect(self) -> AstraDriverBinding: ...
    def prepare(self, surface: str, schema: dict, max_output_tokens: int, cancelled: threading.Event) -> AstraPreparedInput: ...
    def generate(self, prepared: AstraPreparedInput, cancelled: threading.Event) -> dict: ...
    def cancel(self) -> None: ...


def identifier(value: str) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,96}", value) is not None


@dataclass(slots=True)
class _Turn:
    id: str
    actor: str
    request_id: str
    request_digest: str
    execution_id: str
    schema: dict
    max_output: int
    deadline: float
    not_after_ms: int | None = None
    memory_validity_token: str | None = None
    state: str = "queued"
    reason: str | None = None
    cancelled: threading.Event = field(default_factory=threading.Event)
    acquisition: asyncio.Task | None = None
    worker: asyncio.Task | None = None
    worker_ack: threading.Event | None = None
    lease: InferenceSlotLease | None = None
    driver: AstraPreparedDriver | None = None
    binding: AstraDriverBinding | None = None
    timer: asyncio.TimerHandle | None = None
    prepared: AstraPreparedInput | None = None
    prepared_id: str | None = None
    prepared_receipt: dict | None = None
    prepare_count: int = 0
    result: dict | None = None
    ended_at: float | None = None


class AstraPreparedModelHost:
    """One active native worker per existing coordinator, not a shadow runtime.

    Cancellation/timeout fences output immediately but retains the coordinator
    slot until the actual worker returns. Python cannot forcibly stop a native
    worker: an unacknowledged cancellation is visible as cancelling/slotReserved.
    State/results are bounded and process-local, not native durable turn leases.
    """

    def __init__(self, *, deployment: str, coordinator: Callable[[], InferenceCoordinator],
                 resident_driver: Callable[[str], AstraPreparedDriver], max_turns: int = 32,
                 result_retention_seconds: float = 60.0,
                 memory_is_current: Callable[[str, str], bool] | None = None,
                 admitted_model_digest: str | None = None,
                 admitted_model_digests: frozenset[str] | None = None,
                 on_turn_ended: Callable[[str | None], None] | None = None):
        require(deployment == "isolated-validation", "deployment")
        self._on_turn_ended = on_turn_ended
        require(type(max_turns) is int and 1 <= max_turns <= 32, "turn-budget")
        require(1 <= result_retention_seconds <= 300, "result-retention")
        self._coordinator = coordinator
        self._resident_driver = resident_driver
        self._memory_is_current = memory_is_current
        require(not (admitted_model_digest is not None and admitted_model_digests is not None), "model-digest")
        admitted = frozenset([admitted_model_digest]) if admitted_model_digest is not None else admitted_model_digests
        require(admitted is None or 1 <= len(admitted) <= 8 and all(isinstance(digest, str)
                and re.fullmatch(r"sha256:[0-9a-f]{64}", digest) for digest in admitted), "model-digest")
        self._admitted_model_digests = admitted
        self._max_turns = max_turns
        self._retention = result_retention_seconds
        self._turns: dict[str, _Turn] = {}
        self._requests: dict[tuple[str, str], str] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self._closed = False
        self._wall_origin_ms = time.time() * 1000
        self._mono_origin = time.monotonic()
        self._last_wall_ms = self._wall_origin_ms
        self.host_generation = "model_host_" + uuid.uuid4().hex

    def _wall_ms(self) -> float:
        # A backwards wall-clock adjustment cannot extend a previously issued
        # request's absolute admission deadline or revive a forgotten fence.
        self._last_wall_ms = max(self._last_wall_ms, time.time() * 1000,
                                 self._wall_origin_ms + (time.monotonic() - self._mono_origin) * 1000)
        return self._last_wall_ms

    def _parameters(self, actor, request_id, execution_id, expected_model_digest, schema,
                    max_output_tokens, timeout_ms, lane, not_after_ms, memory_validity_token=None):
        require(all(identifier(item) for item in (actor, request_id, execution_id)), "identity")
        require(re.fullmatch(r"sha256:[0-9a-f]{64}", expected_model_digest), "model-digest")
        require(type(max_output_tokens) is int and 1 <= max_output_tokens <= 8192, "output-budget")
        require(type(timeout_ms) is int and 20 <= timeout_ms <= 120000, "deadline-budget")
        require(lane in ("interactive", "agent", "coder", "background"), "lane")
        require(isinstance(schema, dict) and bool(schema), "schema-required")
        require(not_after_ms is None or type(not_after_ms) is int and 1 <= not_after_ms <= 2**53 - 1,
                "absolute-deadline")
        schema_copy = json.loads(bounded_json(schema, 24000))
        require(memory_validity_token is None or isinstance(memory_validity_token, str)
                and re.fullmatch(r"sha256:[0-9a-f]{64}", memory_validity_token) is not None, "memory-validity-token")
        description = {"execution": execution_id, "model": expected_model_digest, "schema": schema_copy,
                       "output": max_output_tokens, "deadline": timeout_ms, "lane": lane}
        if not_after_ms is not None:
            description["notAfterMs"] = not_after_ms
        if memory_validity_token is not None:
            description["memoryValidityToken"] = memory_validity_token
        return schema_copy, sha256(bounded_json(description))

    def _on_loop(self) -> asyncio.AbstractEventLoop:
        loop = asyncio.get_running_loop()
        require(self._loop is None or self._loop is loop, "host-loop-changed")
        self._loop = loop
        return loop

    async def open(self, *, actor: str, request_id: str, execution_id: str,
                   expected_model_digest: str, schema: dict, max_output_tokens: int = 1024,
                   timeout_ms: int = 60000, lane: InferenceLane = "agent", not_after_ms: int | None = None,
                   memory_validity_token: str | None = None) -> dict:
        loop = self._on_loop()
        require(not self._closed, "host-closed")
        schema_copy, request_digest = self._parameters(actor, request_id, execution_id, expected_model_digest,
            schema, max_output_tokens, timeout_ms, lane, not_after_ms, memory_validity_token)
        require(memory_validity_token is None or self._memory_is_current is not None, "memory-guard-unavailable")
        require(self._admitted_model_digests is None or expected_model_digest in self._admitted_model_digests,
                "selected-model-changed")
        self._prune()
        previous_id = self._requests.get((actor, request_id))
        if previous_id is not None:
            previous = self._turns[previous_id]
            require(previous.request_digest == request_digest, "request-conflict")
            require(previous.binding is not None, "turn-pending" if previous.ended_at is None else "turn-unavailable")
            return self._view(previous)
        remaining_ms = timeout_ms if not_after_ms is None else min(timeout_ms, not_after_ms - self._wall_ms())
        require(remaining_ms > 0, "absolute-deadline-expired")
        require(not_after_ms is None or not_after_ms <= self._wall_ms() + timeout_ms + 1000, "absolute-deadline")
        require(len(self._turns) < self._max_turns, "turn-capacity")
        turn = _Turn("turn_" + uuid.uuid4().hex, actor, request_id, request_digest, execution_id,
                     schema_copy, max_output_tokens, time.monotonic() + remaining_ms / 1000, not_after_ms,
                     memory_validity_token=memory_validity_token)
        self._turns[turn.id] = turn
        self._requests[(actor, request_id)] = turn.id
        turn.timer = loop.call_later(remaining_ms / 1000, self._cancel, turn, "deadline")
        try:
            turn.acquisition = loop.create_task(self._coordinator().acquire(lane, timeout_seconds=remaining_ms / 1000))
            turn.acquisition.add_done_callback(lambda _task: self._acquired(turn))
            turn.lease = await asyncio.shield(turn.acquisition)
            require(turn.lease is not None, "queue-timeout")
            require(not turn.cancelled.is_set(), turn.reason or "cancelled")
            turn.state = "preparing-driver"
            driver = await self._work(turn, lambda: self._resident_driver(expected_model_digest))
            require(not turn.cancelled.is_set(), turn.reason or "cancelled")
            binding = driver.inspect()
            require(binding.model_digest == expected_model_digest, "selected-model-changed")
            turn.driver = driver
            turn.binding = binding
            turn.state = "ready"
            return self._view(turn)
        except asyncio.CancelledError:
            self._cancel(turn, "caller-cancelled")
            raise
        except Exception as exc:
            code = exc.code if isinstance(exc, AstraModelError) else "driver-unavailable"
            self._cancel(turn, code)
            raise AstraModelError(code) from exc

    async def prepare(self, *, actor: str, turn_id: str, surface: str) -> dict:
        turn = self._get(actor, turn_id)
        require(turn.state in ("ready", "prepared") and turn.worker is None and turn.driver is not None, "turn-not-ready")
        require(isinstance(surface, str) and 0 < len(surface.encode("utf-8")) <= 524288, "surface-size")
        if turn.prepared is not None and turn.prepared.surface_digest == sha256(surface):
            return self._prepared_view(turn)
        require(turn.prepare_count < 8, "prepare-budget")
        turn.prepare_count += 1
        turn.state = "preparing"
        turn.prepared = None
        turn.prepared_id = None
        try:
            prepared = await self._work(turn, lambda: turn.driver.prepare(surface, turn.schema, turn.max_output, turn.cancelled))
            require(prepared.binding == turn.binding and prepared.surface_digest == sha256(surface)
                    and prepared.schema_digest == sha256(bounded_json(turn.schema, 24000))
                    and prepared.max_output_tokens == turn.max_output, "prepared-input-binding")
            turn.prepared = prepared
            turn.prepared_id = "prepared_" + uuid.uuid4().hex
            turn.state = "prepared"
            turn.prepared_receipt = self._prepared_view(turn)
            return self._prepared_view(turn)
        except asyncio.CancelledError:
            self._cancel(turn, "caller-cancelled")
            raise
        except Exception as exc:
            code = exc.code if isinstance(exc, AstraModelError) else "prepare-failed"
            self._cancel(turn, code)
            raise AstraModelError(code) from exc

    async def generate(self, *, actor: str, turn_id: str, prepared_id: str, prompt_digest: str) -> dict:
        turn = self._get(actor, turn_id)
        require(identifier(prepared_id), "prepared-identity")
        if turn.state == "generated" and turn.result is not None:
            require(turn.prepared_id == prepared_id and turn.result["promptDigest"] == prompt_digest, "prepared-replay-conflict")
            return json.loads(bounded_json(turn.result, 131072))
        require(turn.state == "prepared" and turn.prepared is not None and turn.driver is not None
                and turn.worker is None, "turn-not-prepared")
        require(turn.prepared_id == prepared_id and turn.prepared.prompt_digest == prompt_digest, "prepared-input-binding")
        require(turn.prepared.fits, "context-capacity-insufficient")
        prepared = turn.prepared
        turn.state = "generating"
        try:
            result = await self._work(turn, lambda: turn.driver.generate(prepared, turn.cancelled))
            # A buggy adapter's echo cannot be interpreted as another input's decision.
            require(isinstance(result, dict) and isinstance(result.get("text"), str)
                    and 0 < len(result["text"].encode("utf-8")) <= 16384
                    and result.get("surfaceDigest") == prepared.surface_digest
                    and result.get("promptDigest") == prepared.prompt_digest
                    and result.get("schemaDigest") == prepared.schema_digest
                    and result.get("binding") == prepared.binding.wire()
                    and type(result.get("inputTokens")) is int and result["inputTokens"] == len(prepared.tokens)
                    and result.get("finishReason") in ("stop", "length") and result.get("authority") == "none",
                    "generation-input-binding")
            turn.result = {**json.loads(bounded_json(result, 131072)), "turnId": turn.id,
                           "hostGeneration": self.host_generation, "preparedId": prepared_id}
            self._finish(turn, "generated")
            return json.loads(bounded_json(turn.result, 131072))
        except asyncio.CancelledError:
            self._cancel(turn, "caller-cancelled")
            raise
        except Exception as exc:
            code = exc.code if isinstance(exc, AstraModelError) else "generation-failed"
            self._cancel(turn, code)
            raise AstraModelError(code) from exc

    def inspect(self, *, actor: str, turn_id: str) -> dict:
        return self._view(self._get(actor, turn_id, allow_cancelled=True))

    def cancel(self, *, actor: str, turn_id: str) -> dict:
        turn = self._get(actor, turn_id, allow_cancelled=True)
        self._cancel(turn, "cancelled")
        return self._view(turn)

    def close(self) -> None:
        self._on_loop()
        self._closed = True
        for turn in self._turns.values():
            self._cancel(turn, "host-closing")

    async def wait_closed(self, *, timeout_ms: int = 5000) -> bool:
        """Fence admission and await physical quiescence before owner unload.

        False/exception is NOT permission to unload the resident model. This
        waits only for this host's work, never closes another coordinator user.
        Caller cancellation must not cancel a native worker or release its slot.
        """
        require(type(timeout_ms) is int and 0 <= timeout_ms <= 30000, "shutdown-budget")
        loop = self._on_loop()
        self.close()
        deadline = loop.time() + timeout_ms / 1000
        while True:
            if all(turn.ended_at is not None and turn.worker is None and (turn.lease is None or not turn.lease.locked())
                   for turn in self._turns.values()):
                return True
            remaining = deadline - loop.time()
            if remaining <= 0:
                return False
            await asyncio.sleep(min(0.01, remaining))

    def settle_request(self, *, actor: str, request_id: str, execution_id: str, expected_model_digest: str,
                       schema: dict, max_output_tokens: int = 1024, timeout_ms: int = 60000,
                       lane: InferenceLane = "agent", not_after_ms: int, memory_validity_token: str | None = None) -> dict:
        """Fence delayed opens and cancel-or-return one exact caller-owned turn.

        Absence alone is NOT quiescence: an old open RPC may still arrive. A
        bounded cancellation tombstone fences that exact request through its
        absolute deadline. Active native workers remain reserved until real ack.
        Completed cached output may be recovered, never generated by this call.
        """
        self._on_loop()
        schema_copy, request_digest = self._parameters(actor, request_id, execution_id, expected_model_digest,
            schema, max_output_tokens, timeout_ms, lane, not_after_ms, memory_validity_token)
        require(not_after_ms is not None and not_after_ms <= self._wall_ms() + timeout_ms + 1000, "absolute-deadline")
        self._prune()
        previous_id = self._requests.get((actor, request_id))
        if previous_id is None:
            require(len(self._turns) < self._max_turns, "turn-capacity")
            turn = _Turn("turn_" + uuid.uuid4().hex, actor, request_id, request_digest, execution_id,
                         schema_copy, max_output_tokens, time.monotonic() + max(0, not_after_ms - self._wall_ms()) / 1000,
                         not_after_ms, memory_validity_token=memory_validity_token)
            self._turns[turn.id] = turn
            self._requests[(actor, request_id)] = turn.id
        else:
            turn = self._turns[previous_id]
            require(turn.request_digest == request_digest, "request-conflict")
        self._cancel(turn, "request-fenced")
        view = self._view(turn)
        return {"hostGeneration": self.host_generation, "requestId": request_id, "requestDigest": request_digest,
                "executionId": execution_id, "expectedModelDigest": expected_model_digest,
                "schemaDigest": sha256(bounded_json(schema_copy, 24000)), "maxOutputTokens": max_output_tokens,
                "notAfterMs": not_after_ms, "turnId": turn.id, "state": turn.state, "reason": turn.reason,
                "slotReserved": view["slotReserved"], "quiescent": turn.ended_at is not None and not view["slotReserved"],
                "prepared": json.loads(bounded_json(turn.prepared_receipt)) if turn.prepared_receipt else None,
                "output": json.loads(bounded_json(turn.result, 131072)) if turn.result else None,
                "authority": "none", "persistence": "process-local"}

    async def _work(self, turn: _Turn, operation: Callable[[], Any]) -> Any:
        require(not turn.cancelled.is_set() and turn.lease is not None and turn.lease.locked()
                and turn.worker is None, "worker-ownership")
        ack = threading.Event()
        turn.worker_ack = ack

        def acknowledged_operation() -> Any:
            try:
                # Check on the actual worker, after waiting for the shared slot.
                # Only host-owned metadata, never instructions parsed from recall.
                if turn.memory_validity_token is not None:
                    try:
                        valid = self._memory_is_current is not None and self._memory_is_current(turn.actor, turn.memory_validity_token) is True
                    except Exception:
                        valid = False
                    require(valid, "memory-source-stale")
                require(not turn.cancelled.is_set() and time.monotonic() < turn.deadline, turn.reason or "deadline")
                return operation()
            finally:
                ack.set()

        worker = asyncio.create_task(asyncio.to_thread(acknowledged_operation))
        turn.worker = worker
        worker.add_done_callback(lambda _task: self._worker_done(turn, worker))
        try:
            done, _pending = await asyncio.wait({worker}, timeout=max(0, turn.deadline - time.monotonic()))
            if not done:
                self._cancel(turn, "deadline")
                raise AstraModelError("deadline")
            result = worker.result()
            require(ack.is_set(), "worker-ack-missing")
            if turn.worker is worker:
                turn.worker = None
                turn.worker_ack = None
            require(not turn.cancelled.is_set() and time.monotonic() < turn.deadline, turn.reason or "deadline")
            return result
        except asyncio.CancelledError:
            self._cancel(turn, "caller-cancelled")
            raise

    def _worker_done(self, turn: _Turn, worker: asyncio.Task) -> None:
        # Observe exceptions even after an HTTP caller has gone away. No raw
        # exception/model/prompt is logged. Never cancel this wrapper Task while
        # a native to_thread worker could still be running beneath it.
        if turn.worker is worker and turn.worker_ack is not None and not turn.worker_ack.is_set():
            # Cancelling an asyncio wrapper is NOT proof that to_thread/native
            # work stopped. Keep the slot until the physical worker's finally.
            self._cancel(turn, "worker-wrapper-cancelled")
            self._on_loop().call_later(0.05, self._worker_done, turn, worker)
            return
        if not worker.cancelled():
            worker.exception()
        if turn.worker is worker:
            turn.worker = None
            turn.worker_ack = None
        if turn.cancelled.is_set():
            self._finish(turn, "cancelled")

    def _acquired(self, turn: _Turn) -> None:
        if turn.cancelled.is_set():
            self._finish(turn, "cancelled")

    def _cancel(self, turn: _Turn, reason: str) -> None:
        if turn.ended_at is not None:
            return
        if not turn.cancelled.is_set():
            turn.reason = reason
            turn.cancelled.set()
            if turn.acquisition is not None and not turn.acquisition.done():
                turn.acquisition.cancel()
            if turn.worker is not None and turn.driver is not None:
                try:
                    turn.driver.cancel()
                except Exception:
                    turn.reason = "cancel-signal-failed"
        turn.state = "cancelling"
        self._finish(turn, "cancelled")

    def _finish(self, turn: _Turn, state: str) -> None:
        if turn.ended_at is not None:
            return
        if turn.worker is not None:
            return  # Still owns native work; releasing here would enable overlap.
        if turn.acquisition is not None:
            if not turn.acquisition.done():
                return
            if not turn.acquisition.cancelled():
                try:
                    acquired = turn.acquisition.result()
                    if acquired is not None:
                        acquired.release()
                except Exception:
                    pass
        if turn.lease is not None:
            turn.lease.release()
            turn.lease = None
        if turn.timer is not None:
            turn.timer.cancel()
            turn.timer = None
        turn.prepared = None
        turn.state = state
        turn.ended_at = time.monotonic()
        if self._loop is not None and not self._loop.is_closed():
            retention = max(self._retention, turn.deadline - time.monotonic() + 1 if turn.not_after_ms is not None else 0)
            turn.timer = self._loop.call_later(retention, self._forget, turn)
        if self._on_turn_ended is not None:
            # Exactly once per turn, after its slot is free. A listener fault
            # must not keep the turn from settling.
            try:
                self._on_turn_ended(turn.reason)
            except Exception:
                pass

    def _get(self, actor: str, turn_id: str, *, allow_cancelled: bool = False) -> _Turn:
        self._on_loop()
        require(identifier(actor) and identifier(turn_id), "identity")
        turn = self._turns.get(turn_id)
        require(turn is not None and turn.actor == actor, "turn-not-found")
        if turn.ended_at is None and time.monotonic() >= turn.deadline:
            self._cancel(turn, "deadline")
        require(allow_cancelled or not turn.cancelled.is_set(), turn.reason or "cancelled")
        return turn

    def _prepared_view(self, turn: _Turn) -> dict:
        require(turn.prepared is not None, "turn-not-prepared")
        return {"turnId": turn.id, "hostGeneration": self.host_generation,
                "preparedId": turn.prepared_id, **turn.prepared.receipt()}

    def _view(self, turn: _Turn) -> dict:
        return {"turnId": turn.id, "hostGeneration": self.host_generation, "executionId": turn.execution_id,
                **({"memoryValidityToken": turn.memory_validity_token} if turn.memory_validity_token is not None else {}),
                "state": turn.state, "reason": turn.reason,
                "slotReserved": turn.worker is not None or (turn.lease is not None and turn.lease.locked()),
                "binding": turn.binding.wire() if turn.binding else None,
                "remainingMs": max(0, int((turn.deadline - time.monotonic()) * 1000)),
                "preparedId": turn.prepared_id, "prepareCount": turn.prepare_count,
                "authority": "none", "persistence": "process-local"}

    def _prune(self) -> None:
        cutoff = time.monotonic() - self._retention
        for turn_id, turn in list(self._turns.items()):
            if (turn.ended_at is not None and turn.ended_at < cutoff
                    and (turn.not_after_ms is None or self._wall_ms() > turn.not_after_ms)):
                self._forget(turn)

    def _forget(self, turn: _Turn) -> None:
        if turn.ended_at is not None and self._turns.get(turn.id) is turn:
            if turn.timer is not None:
                turn.timer.cancel()
            turn.result = None
            turn.driver = None
            self._requests.pop((turn.actor, turn.request_id), None)
            del self._turns[turn.id]
