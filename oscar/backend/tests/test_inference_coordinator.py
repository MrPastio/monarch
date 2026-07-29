from __future__ import annotations

import asyncio
from collections import Counter

import pytest

from oscar_agent.inference_coordinator import InferenceCoordinator


@pytest.mark.asyncio
async def test_inference_coordinator_is_non_preemptive_and_fifo_inside_lane():
    coordinator = InferenceCoordinator(asyncio.Lock())
    active = await coordinator.acquire("agent", timeout_seconds=1)
    assert active is not None

    completed: list[int] = []

    async def run(index: int) -> None:
        lease = await coordinator.acquire("interactive", timeout_seconds=1)
        assert lease is not None
        completed.append(index)
        lease.release()

    waiters = [asyncio.create_task(run(index)) for index in range(4)]
    await asyncio.sleep(0)
    assert completed == []

    active.release()
    await asyncio.gather(*waiters)
    assert completed == [0, 1, 2, 3]


@pytest.mark.asyncio
async def test_inference_coordinator_uses_weighted_round_robin_between_lanes():
    coordinator = InferenceCoordinator(asyncio.Lock())
    active = await coordinator.acquire("interactive", timeout_seconds=1)
    assert active is not None

    completed: list[str] = []

    async def run(lane: str) -> None:
        lease = await coordinator.acquire(lane, timeout_seconds=2)  # type: ignore[arg-type]
        assert lease is not None
        completed.append(lane)
        lease.release()

    tasks = [
        asyncio.create_task(run(lane))
        for lane, count in (
            ("interactive", 12),
            ("agent", 12),
            ("coder", 6),
            ("background", 3),
        )
        for _ in range(count)
    ]
    await asyncio.sleep(0)
    active.release()
    await asyncio.gather(*tasks)

    first_cycle = Counter(completed[:11])
    assert first_cycle == {
        "interactive": 4,
        "agent": 4,
        "coder": 2,
        "background": 1,
    }


@pytest.mark.asyncio
async def test_inference_coordinator_serializes_simultaneous_oscar_and_coder_turns():
    coordinator = InferenceCoordinator(asyncio.Lock())
    blocker = await coordinator.acquire("agent", timeout_seconds=1)
    assert blocker is not None

    active_count = 0
    max_active_count = 0
    completed: list[str] = []

    async def run(lane: str, label: str) -> None:
        nonlocal active_count, max_active_count
        lease = await coordinator.acquire(lane, timeout_seconds=2)  # type: ignore[arg-type]
        assert lease is not None
        active_count += 1
        max_active_count = max(max_active_count, active_count)
        completed.append(label)
        await asyncio.sleep(0.01)
        active_count -= 1
        lease.release()

    oscar = asyncio.create_task(run("interactive", "oscar"))
    coder = asyncio.create_task(run("coder", "coder"))
    await asyncio.sleep(0)
    assert coordinator.queue_depths()["interactive"] == 1
    assert coordinator.queue_depths()["coder"] == 1

    blocker.release()
    await asyncio.gather(oscar, coder)

    assert max_active_count == 1
    assert sorted(completed) == ["coder", "oscar"]
    assert coordinator.locked() is False


@pytest.mark.asyncio
async def test_inference_coordinator_timeout_does_not_grant_late_lease():
    lock = asyncio.Lock()
    coordinator = InferenceCoordinator(lock)
    await lock.acquire()

    lease = await coordinator.acquire("background", timeout_seconds=0.01)
    assert lease is None

    lock.release()
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert coordinator.locked() is False
    assert coordinator.queue_depths() == {
        "interactive": 0,
        "agent": 0,
        "coder": 0,
        "background": 0,
    }


@pytest.mark.asyncio
async def test_inference_coordinator_reclaims_a_lease_won_at_timeout_boundary():
    coordinator = InferenceCoordinator(asyncio.Lock())
    lease = await coordinator.acquire("agent", timeout_seconds=1)
    assert lease is not None
    future = asyncio.get_running_loop().create_future()
    future.set_result(lease)

    coordinator._reclaim_or_cancel(future)
    await asyncio.sleep(0)

    assert coordinator.locked() is False
    replacement = await coordinator.acquire("interactive", timeout_seconds=1)
    assert replacement is not None
    replacement.release()
