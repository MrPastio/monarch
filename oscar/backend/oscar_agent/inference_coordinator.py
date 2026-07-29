from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass
from typing import Callable, Literal


InferenceLane = Literal["interactive", "agent", "coder", "background"]
INFERENCE_LANE_WEIGHTS: dict[InferenceLane, int] = {
    "interactive": 4,
    "agent": 4,
    "coder": 2,
    "background": 1,
}


@dataclass(slots=True)
class _Waiter:
    lane: InferenceLane
    enqueued_at: float
    future: asyncio.Future["InferenceSlotLease"]


class InferenceSlotLease:
    """One non-preemptive inference turn with idempotent release."""

    def __init__(
        self,
        coordinator: "InferenceCoordinator",
        *,
        lane: InferenceLane,
        queue_latency_ms: float,
    ):
        self._coordinator = coordinator
        self._released = False
        self.lane = lane
        self.queue_latency_ms = max(0.0, queue_latency_ms)

    def locked(self) -> bool:
        return not self._released and self._coordinator.locked()

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        self._coordinator.release(self)


class InferenceCoordinator:
    """Single-slot FIFO lanes with weighted round-robin between lanes."""

    def __init__(
        self,
        lock: asyncio.Lock,
        *,
        on_acquire: Callable[[], None] | None = None,
        on_release: Callable[[], None] | None = None,
    ):
        self._lock = lock
        self._on_acquire = on_acquire
        self._on_release = on_release
        self._queues: dict[InferenceLane, deque[_Waiter]] = {
            lane: deque() for lane in INFERENCE_LANE_WEIGHTS
        }
        self._schedule = tuple(
            lane
            for lane, weight in INFERENCE_LANE_WEIGHTS.items()
            for _ in range(weight)
        )
        self._cursor = 0
        self._active_lease: InferenceSlotLease | None = None
        self._dispatch_task: asyncio.Task[None] | None = None
        self._loop = asyncio.get_running_loop()

    @property
    def loop(self) -> asyncio.AbstractEventLoop:
        return self._loop

    @property
    def lock(self) -> asyncio.Lock:
        return self._lock

    def locked(self) -> bool:
        return self._lock.locked()

    def queue_depths(self) -> dict[InferenceLane, int]:
        return {
            lane: sum(1 for waiter in queue if not waiter.future.done())
            for lane, queue in self._queues.items()
        }

    async def acquire(
        self,
        lane: InferenceLane = "interactive",
        *,
        timeout_seconds: float,
    ) -> InferenceSlotLease | None:
        normalized_lane: InferenceLane = lane if lane in self._queues else "background"
        if timeout_seconds <= 0 and (
            self._lock.locked()
            or self._active_lease is not None
            or self._has_live_waiters()
        ):
            return None

        future: asyncio.Future[InferenceSlotLease] = self._loop.create_future()
        waiter = _Waiter(
            lane=normalized_lane,
            enqueued_at=time.perf_counter(),
            future=future,
        )
        self._queues[normalized_lane].append(waiter)
        self._try_dispatch()
        try:
            return await asyncio.wait_for(
                asyncio.shield(future),
                timeout=max(timeout_seconds, 0.001),
            )
        except asyncio.TimeoutError:
            self._reclaim_or_cancel(future)
            self._remove_waiter(waiter)
            return None
        except asyncio.CancelledError:
            self._reclaim_or_cancel(future)
            self._remove_waiter(waiter)
            raise

    def release(self, lease: InferenceSlotLease) -> None:
        if lease is not self._active_lease:
            return
        self._active_lease = None
        if self._lock.locked():
            self._lock.release()
        if self._on_release is not None:
            self._on_release()
        self._loop.call_soon(self._try_dispatch)

    def _has_live_waiters(self) -> bool:
        return any(
            any(not waiter.future.done() for waiter in queue)
            for queue in self._queues.values()
        )

    def _remove_waiter(self, target: _Waiter) -> None:
        queue = self._queues[target.lane]
        try:
            queue.remove(target)
        except ValueError:
            pass

    @staticmethod
    def _reclaim_or_cancel(
        future: asyncio.Future["InferenceSlotLease"],
    ) -> None:
        if not future.done():
            future.cancel()
            return
        if future.cancelled():
            return
        try:
            future.result().release()
        except Exception:
            # Acquisition cleanup must preserve the original timeout or
            # cancellation result. A lease release is idempotent.
            pass

    def _try_dispatch(self) -> None:
        if self._active_lease is not None:
            return
        if self._dispatch_task is not None and not self._dispatch_task.done():
            return
        waiter = self._next_waiter()
        if waiter is None:
            return
        self._dispatch_task = self._loop.create_task(self._grant(waiter))

    def _next_waiter(self) -> _Waiter | None:
        for _ in range(len(self._schedule)):
            lane = self._schedule[self._cursor]
            self._cursor = (self._cursor + 1) % len(self._schedule)
            queue = self._queues[lane]
            while queue and queue[0].future.done():
                queue.popleft()
            if queue:
                return queue.popleft()
        return None

    async def _grant(self, waiter: _Waiter) -> None:
        acquired = False
        try:
            await self._lock.acquire()
            acquired = True
            if waiter.future.done():
                self._lock.release()
                acquired = False
                return
            lease = InferenceSlotLease(
                self,
                lane=waiter.lane,
                queue_latency_ms=(time.perf_counter() - waiter.enqueued_at) * 1000,
            )
            self._active_lease = lease
            if self._on_acquire is not None:
                self._on_acquire()
            waiter.future.set_result(lease)
        finally:
            self._dispatch_task = None
            if acquired and self._active_lease is None and self._lock.locked():
                self._lock.release()
            if self._active_lease is None:
                self._try_dispatch()
