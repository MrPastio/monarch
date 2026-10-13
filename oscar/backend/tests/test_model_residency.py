from pathlib import Path
import sys

import pytest

backend_dir = Path(__file__).resolve().parents[1]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from oscar_agent import main as main_module
from oscar_agent.residency import (
    AGENT_SESSION_MIN_RESIDENT_SECONDS,
    MAX_RESIDENT_SECONDS,
    MIN_RESIDENT_SECONDS,
    plan_residency,
)


def plan(**overrides):
    request = {
        "configured_idle_seconds": 900.0,
        "min_free_ram_gb": 3.0,
        "tier": "gemma4-fast",
        "available_ram_gb": 12.0,
        "agent_session": False,
    }
    request.update(overrides)
    return plan_residency(**request)


def test_a_conversation_keeps_its_model_between_messages():
    # The defect this policy exists for: the recycle fired five seconds after
    # every generation, and nobody types the next message that fast, so every
    # interactive turn paid a full cold load.
    decision = plan()
    assert decision.delay_seconds == 900.0
    assert decision.reason == "resident-idle-window"


def test_a_large_tier_is_held_for_less_time_than_a_small_one():
    # Hold time is paid for in memory the rest of the machine cannot use.
    fast = plan(tier="gemma4-fast").delay_seconds
    balanced = plan(tier="gemma4-balanced").delay_seconds
    pro = plan(tier="qwen3.8-27b-pro").delay_seconds
    assert fast > balanced > pro >= MIN_RESIDENT_SECONDS


def test_an_unknown_tier_is_treated_as_an_expensive_one():
    assert plan(tier="some-future-model").delay_seconds == plan(tier="qwen3.8-27b-pro").delay_seconds


def test_low_host_memory_gives_the_memory_back_now():
    decision = plan(available_ram_gb=1.5)
    assert decision.delay_seconds == MIN_RESIDENT_SECONDS
    assert decision.reason == "host-ram-low"


def test_unmeasurable_host_memory_is_not_read_as_pressure():
    # A machine whose memory cannot be read is not thereby assumed to be full.
    decision = plan(available_ram_gb=None)
    assert decision.delay_seconds == 900.0
    assert decision.reason == "resident-idle-window"


def test_zero_restores_the_previous_recycle_immediately_behaviour():
    decision = plan(configured_idle_seconds=0)
    assert decision.delay_seconds == MIN_RESIDENT_SECONDS
    assert decision.reason == "residency-disabled"


def test_a_malformed_setting_does_not_hold_the_model_forever():
    assert plan(configured_idle_seconds="soon").delay_seconds == MIN_RESIDENT_SECONDS


def test_an_agent_session_never_drops_below_the_delay_that_lane_relied_on():
    # Even under memory pressure: that lane's next request is already owed, and
    # dropping the model under it is what made multi-turn local agent runs fail.
    assert plan(agent_session=True, available_ram_gb=0.4).delay_seconds == (
        AGENT_SESSION_MIN_RESIDENT_SECONDS
    )
    assert plan(agent_session=True, configured_idle_seconds=0).delay_seconds == (
        AGENT_SESSION_MIN_RESIDENT_SECONDS
    )


def test_the_window_is_capped_so_release_still_happens():
    # Releasing is process exit, which is also how this backend reclaims native
    # allocations; a window past an hour is indistinguishable from never.
    assert plan(configured_idle_seconds=10_000_000).delay_seconds == MAX_RESIDENT_SECONDS


class FakeTimer:
    instances: list["FakeTimer"] = []

    def __init__(self, delay, callback):
        self.delay = delay
        self.callback = callback
        self.daemon = False
        self.started = False
        self.cancelled = False
        FakeTimer.instances.append(self)

    def start(self):
        self.started = True

    def cancel(self):
        self.cancelled = True


@pytest.fixture
def scheduled_recycles(monkeypatch):
    FakeTimer.instances = []
    monkeypatch.setattr(main_module, "_active_inference_slots", 0)
    monkeypatch.setattr(main_module, "_backend_recycle_requested", False)
    monkeypatch.setattr(main_module, "_backend_recycle_timer", None)
    monkeypatch.setattr(main_module.settings, "auto_unload_after_generation", True)
    monkeypatch.setattr(main_module.settings, "recycle_backend_after_generation", True)
    monkeypatch.setattr(main_module.settings, "model_resident_idle_seconds", 900.0)
    monkeypatch.setattr(main_module.settings, "model_resident_min_free_ram_gb", 3.0)
    monkeypatch.setattr(main_module, "available_system_ram_gb", lambda: 12.0)
    monkeypatch.setattr(main_module.threading, "Timer", FakeTimer)

    def finish_generation(tier):
        # The backend skips recycling under pytest so suites do not shoot
        # themselves; these tests are about the scheduling decision itself.
        monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
        main_module.unload_after_generation(tier)

    yield finish_generation, FakeTimer.instances
    main_module.cancel_pending_backend_recycle()


def test_a_finished_generation_schedules_the_window_its_tier_earned(scheduled_recycles):
    finish_generation, timers = scheduled_recycles
    finish_generation("gemma4-fast")

    assert len(timers) == 1
    assert timers[0].delay == 900.0
    assert timers[0].started is True


def test_the_tier_that_just_ran_decides_the_window_not_the_caller(scheduled_recycles):
    finish_generation, timers = scheduled_recycles
    finish_generation("qwen3.8-27b-pro")

    assert timers[0].delay == 225.0


def test_the_decision_is_reportable(scheduled_recycles):
    finish_generation, _timers = scheduled_recycles
    finish_generation("gemma4-balanced")

    diagnostic = main_module._last_residency_decision.as_diagnostic()
    assert diagnostic == {
        "delay_seconds": 450.0,
        "reason": "resident-idle-window",
        "tier": "gemma4-balanced",
        "available_ram_gb": 12.0,
    }


def test_active_inference_pauses_but_does_not_lose_a_pending_recycle(scheduled_recycles):
    _finish_generation, timers = scheduled_recycles
    main_module.schedule_backend_recycle(5.0)
    first = timers[-1]

    main_module.begin_inference_activity()
    assert first.cancelled is True
    assert main_module._backend_recycle_requested is True
    assert main_module._backend_recycle_timer is None

    main_module.finish_inference_activity()
    assert len(timers) == 2
    assert timers[-1].delay == 0.25
    assert timers[-1].started is True


def test_recycle_rearms_only_after_the_last_active_lease(scheduled_recycles):
    _finish_generation, timers = scheduled_recycles
    main_module.schedule_backend_recycle(5.0)
    main_module.begin_inference_activity()
    main_module.begin_inference_activity()
    main_module.finish_inference_activity()
    assert len(timers) == 1
    main_module.finish_inference_activity()
    assert len(timers) == 2
