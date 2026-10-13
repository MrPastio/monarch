"""Existing runtime load/unload seam, native Windows pin, synthetic native loader."""
import hashlib
import os
import sys
from types import SimpleNamespace

import pytest

from oscar_agent.config import Settings
from oscar_agent.model_runtime import LocalModelRuntime, ModelTierRecycleRequiredError
from oscar_agent.astra_asset_pin import AstraAssetExpectation
from oscar_agent import astra_prepared_driver as prepared_module
from astra_model_fixture import FixtureLlama, FixturePreparedDriver

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows admitted asset")


def setup(tmp_path, monkeypatch):
    root = tmp_path / "models"
    root.mkdir()
    model = root / "synthetic.gguf"
    data = b"GGUFsynthetic residency"
    model.write_bytes(data)
    settings = Settings(data_dir=tmp_path / "data", db_path=tmp_path / "data" / "memory.sqlite3",
        offload_dir=tmp_path / "offload", workspace_root=tmp_path / "workspace",
        workspace_generated_dir=tmp_path / "generated", gemma_models_dir=root,
        coder_models_dir=root, memory_embedding_model_dir=tmp_path / "missing", mock_model=False, mock_fallback=True)
    runtime = LocalModelRuntime(settings)
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False)))
    monkeypatch.setattr(runtime, "_resolve_gemma4_assets", lambda *_args, **_kwargs: (model, None, None))
    monkeypatch.setattr(runtime, "_gemma4_draft_fits_memory", lambda *_args: True)
    monkeypatch.setattr(runtime, "_load_context_tokens", lambda *_args, **_kwargs: 4096)
    calls = []
    def load(path, **kwargs):
        assert path.read_bytes() == data
        calls.append((path, kwargs))
        runtime._llama_model = SimpleNamespace(close=lambda: None)
    monkeypatch.setattr(runtime, "_load_llama", load)
    expectation = AstraAssetExpectation(root, model, "sha256:" + hashlib.sha256(data).hexdigest(), len(data))
    return runtime, expectation, calls


def test_existing_loader_retains_pin_reuses_resident_and_revokes_before_close(tmp_path, monkeypatch):
    runtime, asset, calls = setup(tmp_path, monkeypatch)
    try:
        runtime.load_tier("gemma4-fast", astra_asset=asset)
        first = runtime.astra_residency()
        assert first and first[1].digest == asset.digest and len(calls) == 1
        runtime.load_tier("gemma4-fast", astra_asset=asset)
        assert runtime.astra_residency() == first and len(calls) == 1
        with pytest.raises(OSError):
            asset.candidate.write_bytes(b"blocked")
        closed_checks = []
        def closed():
            assert runtime.astra_residency() is None
            with pytest.raises(OSError):
                asset.candidate.write_bytes(b"still pinned during native close")
            closed_checks.append(True)
        runtime._llama_model.close = closed
        runtime._release_model_memory()
        assert closed_checks == [True]
        assert runtime.astra_residency() is None
        runtime.load_tier("gemma4-fast", astra_asset=asset)
        assert runtime.astra_residency()[0] != first[0] and len(calls) == 2
    finally:
        runtime._release_model_memory()
    asset.candidate.write_bytes(b"released")


def test_bad_digest_or_native_failure_never_publishes_or_mock_falls_back(tmp_path, monkeypatch):
    runtime, asset, calls = setup(tmp_path, monkeypatch)
    bad = AstraAssetExpectation(asset.root, asset.candidate, "sha256:" + "0" * 64, asset.size)
    with pytest.raises(RuntimeError):
        runtime.load_tier("gemma4-fast", astra_asset=bad)
    assert not calls and not runtime.loaded and runtime.astra_residency() is None
    def fail(*_args, **_kwargs):
        raise RuntimeError("synthetic native load failure")
    monkeypatch.setattr(runtime, "_load_llama", fail)
    with pytest.raises(RuntimeError):
        runtime.load_tier("gemma4-fast", astra_asset=asset)
    assert not runtime.loaded and not runtime.fallback_active and runtime.astra_residency() is None
    asset.candidate.write_bytes(b"released")


def test_legacy_resident_is_not_retroactively_admitted_and_vision_is_rejected(tmp_path, monkeypatch):
    runtime, asset, calls = setup(tmp_path, monkeypatch)
    try:
        runtime.load_tier("gemma4-fast")
        assert runtime.astra_residency() is None and len(calls) == 1
        runtime.load_tier("gemma4-fast", astra_asset=asset)
        assert runtime.astra_residency() is not None and len(calls) == 2
        with pytest.raises(ValueError, match="astra-resident-text-required"):
            runtime.load_tier("gemma4-fast", astra_asset=asset, require_vision=True)
    finally:
        runtime._release_model_memory()


def test_failed_native_close_quarantines_resident_and_retains_pin(tmp_path, monkeypatch):
    runtime, asset, _ = setup(tmp_path, monkeypatch)
    runtime.load_tier("gemma4-fast", astra_asset=asset)
    def fail():
        raise RuntimeError("synthetic close failure")
    runtime._llama_model.close = fail
    try:
        with pytest.raises(RuntimeError, match="synthetic close failure"):
            runtime._release_model_memory()
        assert runtime.astra_residency() is None
        with pytest.raises(OSError):
            asset.candidate.write_bytes(b"must remain pinned")
        with pytest.raises(RuntimeError, match="restart-required"):
            runtime.load_tier("gemma4-fast")
    finally:
        # Test-only disposal of the synthetic object; production cannot clear quarantine.
        runtime._astra_close_failed = False
        runtime._llama_model.close = lambda: None
        runtime._release_model_memory()


def test_resident_driver_reuses_binding_and_rejects_old_prepared_input_after_reload(tmp_path, monkeypatch):
    runtime, asset, _ = setup(tmp_path, monkeypatch)
    def load(*_args, **_kwargs):
        runtime._llama_model = FixtureLlama()
        runtime._llama_model.close = lambda: None
    monkeypatch.setattr(runtime, "_load_llama", load)
    # Actual formatter/grammar with synthetic vocabulary; no native model loaded.
    monkeypatch.setattr(prepared_module, "AstraPreparedLlamaTextDriver", FixturePreparedDriver)
    provider = prepared_module.AstraResidentDriverProvider(runtime)
    try:
        with pytest.raises(prepared_module.AstraModelError, match="admitted-resident-required"):
            provider()
        runtime.load_tier("gemma4-fast", astra_asset=asset)
        first = provider()
        assert provider() is first and first.inspect().model_digest == asset.digest
        import threading
        prepared = first.prepare('synthetic input', {"type": "string", "minLength": 1, "maxLength": 16}, 128, threading.Event())
        runtime._release_model_memory()
        with pytest.raises(prepared_module.AstraModelError, match="driver-changed"):
            first.generate(prepared, threading.Event())
        runtime.load_tier("gemma4-fast", astra_asset=asset)
        second = provider()
        assert second is not first and second.inspect().driver_generation != first.binding.driver_generation
        second._native_failed = True
        with pytest.raises(prepared_module.AstraModelError, match="native-residency-faulted"):
            provider()
        assert provider._driver is second  # No rebuild to clear quarantine.
    finally:
        runtime._release_model_memory()


def test_astra_admission_declines_any_native_load_into_a_cuda_process(tmp_path, monkeypatch):
    runtime, asset, calls = setup(tmp_path, monkeypatch)
    try:
        assert runtime.astra_load_needs_fresh_process("gemma4-fast", asset) is False  # fresh process
        runtime.load_tier("gemma4-balanced")
        runtime.device_map = {"backend": "cuda"}
        assert runtime.astra_load_needs_fresh_process("gemma4-fast", asset) is True  # tier swap
        assert runtime.astra_load_needs_fresh_process("qwen3-coder-30b-a3b-instruct", asset) is True
        # The swap itself is refused in a CUDA process (496cad6): recycle the host instead.
        with pytest.raises(ModelTierRecycleRequiredError):
            runtime.load_tier("gemma4-fast")
        # A recycled host loads the chat tier into a process without a CUDA resident.
        runtime.device_map = {"backend": "cpu"}
        runtime.load_tier("gemma4-fast")
        runtime.device_map = {"backend": "cuda"}
        # Same tier, loaded unpinned by chat: load_tier would still release and reload.
        assert runtime.astra_load_needs_fresh_process("gemma4-fast", asset) is True
        runtime.device_map = {"backend": "cpu"}
        assert runtime.astra_load_needs_fresh_process("gemma4-balanced", asset) is False  # CPU never aborted
        runtime._release_model_memory()
        runtime.loaded = False
        runtime.load_tier("gemma4-fast", astra_asset=asset)
        runtime.device_map = {"backend": "cuda"}
        assert runtime.astra_load_needs_fresh_process("gemma4-fast", asset) is False  # exact pinned reuse
    finally:
        runtime._release_model_memory()
