"""A second model tier must never be loaded into a CUDA process holding one.

Measured on an 8 GiB device: after one tier has been resident, loading another
aborts inside ggml-cuda. The CUDA error becomes abort(), the process dies with
0xC0000409 in the middle of the request, and the user gets no answer at all.
An in-process unload does not give the device memory back, so the backend
declines the swap and the host retries against a fresh process.
"""
from oscar_agent.main import tier_swap_needs_fresh_process
from oscar_agent import main as main_module


class FakeRuntime:
    def __init__(self, *, loaded=True, tier="gemma4-fast", backend="cuda", fallback=False):
        self.loaded = loaded
        self.active_tier = tier
        self.fallback_active = fallback
        self.device_map = {"backend": backend} if backend else None


def with_runtime(monkeypatch, runtime):
    monkeypatch.setattr(main_module, "model_runtime", runtime)


def test_declines_a_swap_between_two_cuda_tiers(monkeypatch):
    with_runtime(monkeypatch, FakeRuntime(tier="gemma4-fast"))
    assert tier_swap_needs_fresh_process("gemma4-balanced") is True
    assert tier_swap_needs_fresh_process("qwen3.8-27b-pro") is True


def test_serves_the_resident_tier_without_a_restart(monkeypatch):
    with_runtime(monkeypatch, FakeRuntime(tier="gemma4-fast"))
    assert tier_swap_needs_fresh_process("gemma4-fast") is False


def test_a_process_holding_nothing_needs_no_restart(monkeypatch):
    with_runtime(monkeypatch, FakeRuntime(loaded=False))
    assert tier_swap_needs_fresh_process("gemma4-balanced") is False
    with_runtime(monkeypatch, FakeRuntime(tier=None))
    assert tier_swap_needs_fresh_process("gemma4-balanced") is False


def test_a_mock_fallback_holds_no_device_memory(monkeypatch):
    with_runtime(monkeypatch, FakeRuntime(tier="gemma4-fast", fallback=True))
    assert tier_swap_needs_fresh_process("gemma4-balanced") is False


def test_cpu_installs_keep_one_process(monkeypatch):
    # Without a CUDA context there is no device memory to strand, and a CPU
    # swap has never aborted. Restarting those installs would cost a reload
    # for nothing.
    with_runtime(monkeypatch, FakeRuntime(tier="gemma4-fast", backend="cpu"))
    assert tier_swap_needs_fresh_process("gemma4-balanced") is False
    with_runtime(monkeypatch, FakeRuntime(tier="gemma4-fast", backend=None))
    assert tier_swap_needs_fresh_process("gemma4-balanced") is False


def test_an_unknown_tier_name_never_forces_a_restart(monkeypatch):
    with_runtime(monkeypatch, FakeRuntime(tier="gemma4-fast"))
    assert tier_swap_needs_fresh_process("not-a-tier") is False


def test_automatic_selection_keeps_a_stronger_resident_gemma(monkeypatch):
    # Live 2026-09-18: routing escalated to balanced, then the answer asked for
    # fast and paid a second process restart (~25 s for a two-second reply).
    from oscar_agent.main import prefer_resident_stronger_tier
    with_runtime(monkeypatch, FakeRuntime(tier="gemma4-balanced"))
    assert prefer_resident_stronger_tier("gemma4-fast") == "gemma4-balanced"


def test_automatic_selection_never_downgrades_to_or_stays_on_pro_by_residency(monkeypatch):
    from oscar_agent.main import prefer_resident_stronger_tier
    with_runtime(monkeypatch, FakeRuntime(tier="qwen3.8-27b-pro"))
    assert prefer_resident_stronger_tier("gemma4-fast") == "gemma4-fast"
    with_runtime(monkeypatch, FakeRuntime(tier="gemma4-fast"))
    assert prefer_resident_stronger_tier("gemma4-balanced") == "gemma4-balanced"


def test_residency_preference_is_inert_without_a_cuda_swap(monkeypatch):
    from oscar_agent.main import prefer_resident_stronger_tier
    with_runtime(monkeypatch, FakeRuntime(tier="gemma4-balanced", backend="cpu"))
    assert prefer_resident_stronger_tier("gemma4-fast") == "gemma4-fast"
    with_runtime(monkeypatch, FakeRuntime(loaded=False, tier=None))
    assert prefer_resident_stronger_tier("gemma4-fast") == "gemma4-fast"
