from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import wave
from pathlib import Path
from types import SimpleNamespace

import pytest

from oscar_agent import sharing_tts


WORKSPACE_ROOT = Path(__file__).resolve().parents[3]
GENERATOR_PATH = WORKSPACE_ROOT / "tools" / "generate-voice-references.py"


def _wav_payload(sample_rate: int = 24_000) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(sample_rate)
        stream.writeframes(b"\x00\x00" * 32)
    return output.getvalue()


def _settings(tmp_path: Path) -> SimpleNamespace:
    models = tmp_path / "models"
    model = models / "qwen3-tts-0.6b-base"
    (model / "speech_tokenizer").mkdir(parents=True)
    (model / "config.json").write_text("{}", encoding="utf-8")
    (model / "model.safetensors").write_bytes(b"model")
    (model / "speech_tokenizer" / "model.safetensors").write_bytes(
        b"tokenizer"
    )
    python_path = tmp_path / "python.exe"
    python_path.write_bytes(b"python")
    return SimpleNamespace(
        sharing_tts_models_dir=models,
        sharing_tts_python=python_path,
        data_dir=tmp_path / "data",
    )


def _request() -> SimpleNamespace:
    return SimpleNamespace(
        model="qwen3-tts-0.6b-base",
        input="Привет",
        voice="oscar",
        language="ru-RU",
        instructions="",
    )


def _load_generator() -> object:
    spec = importlib.util.spec_from_file_location(
        "monarch_voice_provenance_test",
        GENERATOR_PATH,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _create_directory_link(target: Path, link: Path) -> None:
    try:
        os.symlink(target, link, target_is_directory=True)
        return
    except (OSError, NotImplementedError) as error:
        if os.name != "nt":
            pytest.skip(f"directory links are unavailable: {error}")
    system_root = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    completed = subprocess.run(
        [
            str(system_root / "System32" / "cmd.exe"),
            "/d",
            "/c",
            "mklink",
            "/J",
            str(link),
            str(target),
        ],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode != 0:
        pytest.skip(
            "directory links are unavailable: "
            f"{completed.stderr or completed.stdout}"
        )


def test_runtime_accepts_only_identity_bound_worker_evidence(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    worker = tmp_path / "worker.py"
    worker.write_text("# probe", encoding="utf-8")
    monkeypatch.setattr(sharing_tts, "TTS_WORKER", worker)
    payload = _wav_payload()

    def runner(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        target = Path(command[command.index("--output") + 1])
        target.write_bytes(payload)
        evidence = {
            "ok": True,
            "sample_rate": 24_000,
            "bytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        }
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=json.dumps(evidence),
            stderr="",
        )

    runtime = sharing_tts.QwenTtsSharingRuntime(
        _settings(tmp_path),
        runner=runner,
    )
    result = runtime.synthesize(_request())

    assert result.audio == payload
    assert result.sample_rate == 24_000
    assert list((tmp_path / "data" / "sharing-tts").iterdir()) == []


def test_runtime_rejects_worker_digest_mismatch(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    worker = tmp_path / "worker.py"
    worker.write_text("# probe", encoding="utf-8")
    monkeypatch.setattr(sharing_tts, "TTS_WORKER", worker)
    payload = _wav_payload()

    def runner(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        target = Path(command[command.index("--output") + 1])
        target.write_bytes(payload)
        evidence = {
            "ok": True,
            "sample_rate": 24_000,
            "bytes": len(payload),
            "sha256": "0" * 64,
        }
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=json.dumps(evidence),
            stderr="",
        )

    runtime = sharing_tts.QwenTtsSharingRuntime(
        _settings(tmp_path),
        runner=runner,
    )
    with pytest.raises(sharing_tts.TtsSynthesisError) as captured:
        runtime.synthesize(_request())

    assert captured.value.code == "tts_audio_invalid"
    assert "does not match worker evidence" in str(captured.value)


def test_runtime_rejects_hardlinked_worker_output(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    worker = tmp_path / "worker.py"
    worker.write_text("# probe", encoding="utf-8")
    monkeypatch.setattr(sharing_tts, "TTS_WORKER", worker)
    payload = _wav_payload()

    def runner(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        target = Path(command[command.index("--output") + 1])
        source = target.with_suffix(".source")
        source.write_bytes(payload)
        os.link(source, target)
        evidence = {
            "ok": True,
            "sample_rate": 24_000,
            "bytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        }
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=json.dumps(evidence),
            stderr="",
        )

    runtime = sharing_tts.QwenTtsSharingRuntime(
        _settings(tmp_path),
        runner=runner,
    )
    with pytest.raises(sharing_tts.TtsSynthesisError) as captured:
        runtime.synthesize(_request())

    assert captured.value.code == "tts_audio_invalid"
    assert "identity is unsafe" in str(captured.value)


@pytest.mark.parametrize("linked_target", ["python", "worker"])
def test_runtime_rejects_linked_launch_files_before_creating_data(
    linked_target: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    real_worker = tmp_path / "real-worker.py"
    real_worker.write_text("# probe", encoding="utf-8")
    worker = real_worker
    if linked_target == "python":
        runtime_dir = tmp_path / "real-python-runtime"
        runtime_dir.mkdir()
        (runtime_dir / "python.exe").write_bytes(b"python")
        linked_runtime = tmp_path / "linked-python-runtime"
        _create_directory_link(runtime_dir, linked_runtime)
        settings.sharing_tts_python = linked_runtime / "python.exe"
    else:
        worker_dir = tmp_path / "real-worker-runtime"
        worker_dir.mkdir()
        (worker_dir / "worker.py").write_text("# probe", encoding="utf-8")
        linked_runtime = tmp_path / "linked-worker-runtime"
        _create_directory_link(worker_dir, linked_runtime)
        worker = linked_runtime / "worker.py"
    monkeypatch.setattr(sharing_tts, "TTS_WORKER", worker)
    calls: list[list[str]] = []

    def runner(
        command: list[str],
        **_kwargs: object,
    ) -> subprocess.CompletedProcess[str]:
        calls.append(command)
        return subprocess.CompletedProcess(command, 1, stdout="", stderr="")

    runtime = sharing_tts.QwenTtsSharingRuntime(settings, runner=runner)
    with pytest.raises(sharing_tts.TtsSynthesisError) as captured:
        runtime.synthesize(_request())

    assert captured.value.code == "tts_file_invalid"
    assert calls == []
    assert not Path(settings.data_dir).exists()


def test_runtime_rejects_hardlinked_worker_before_creating_data(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    worker_source = tmp_path / "worker-source.py"
    worker_alias = tmp_path / "worker-alias.py"
    worker_source.write_text("# probe", encoding="utf-8")
    os.link(worker_source, worker_alias)
    monkeypatch.setattr(sharing_tts, "TTS_WORKER", worker_alias)
    calls: list[list[str]] = []

    def runner(
        command: list[str],
        **_kwargs: object,
    ) -> subprocess.CompletedProcess[str]:
        calls.append(command)
        return subprocess.CompletedProcess(command, 1, stdout="", stderr="")

    runtime = sharing_tts.QwenTtsSharingRuntime(settings, runner=runner)
    with pytest.raises(sharing_tts.TtsSynthesisError) as captured:
        runtime.synthesize(_request())

    assert captured.value.code == "tts_file_invalid"
    assert calls == []
    assert not Path(settings.data_dir).exists()


@pytest.mark.skipif(os.name != "nt", reason="Windows ADS policy")
@pytest.mark.parametrize("ads_target", ["python", "worker"])
def test_runtime_rejects_launch_file_ads_before_creating_data(
    ads_target: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    worker = tmp_path / "worker.py"
    worker.write_text("# probe", encoding="utf-8")
    monkeypatch.setattr(sharing_tts, "TTS_WORKER", worker)
    target = (
        Path(settings.sharing_tts_python)
        if ads_target == "python"
        else worker
    )
    Path(f"{target}:monarch-provenance-test").write_text(
        "blocked",
        encoding="utf-8",
    )
    calls: list[list[str]] = []

    def runner(
        command: list[str],
        **_kwargs: object,
    ) -> subprocess.CompletedProcess[str]:
        calls.append(command)
        return subprocess.CompletedProcess(command, 1, stdout="", stderr="")

    runtime = sharing_tts.QwenTtsSharingRuntime(settings, runner=runner)
    with pytest.raises(sharing_tts.TtsSynthesisError) as captured:
        runtime.synthesize(_request())

    assert captured.value.code == "tts_file_invalid"
    assert "alternate data stream" in str(captured.value)
    assert calls == []
    assert not Path(settings.data_dir).exists()


def test_runtime_rejects_linked_data_root_without_writing_through_it(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    worker = tmp_path / "worker.py"
    worker.write_text("# probe", encoding="utf-8")
    monkeypatch.setattr(sharing_tts, "TTS_WORKER", worker)
    real_data = tmp_path / "real-data"
    real_data.mkdir()
    linked_data = tmp_path / "linked-data"
    _create_directory_link(real_data, linked_data)
    settings.data_dir = linked_data
    calls: list[list[str]] = []

    def runner(
        command: list[str],
        **_kwargs: object,
    ) -> subprocess.CompletedProcess[str]:
        calls.append(command)
        return subprocess.CompletedProcess(command, 1, stdout="", stderr="")

    runtime = sharing_tts.QwenTtsSharingRuntime(settings, runner=runner)
    with pytest.raises(sharing_tts.TtsSynthesisError) as captured:
        runtime.synthesize(_request())

    assert captured.value.code == "tts_file_invalid"
    assert calls == []
    assert list(real_data.iterdir()) == []


@pytest.mark.parametrize(
    ("reported_bytes", "reported_sha256"),
    [
        (len(_wav_payload()) + 1, hashlib.sha256(_wav_payload()).hexdigest()),
        (sharing_tts.MAX_AUDIO_BYTES + 1, hashlib.sha256(_wav_payload()).hexdigest()),
        (len(_wav_payload()), "F" * 64),
    ],
)
def test_runtime_rejects_invalid_or_mismatched_worker_receipts(
    reported_bytes: int,
    reported_sha256: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    worker = tmp_path / "worker.py"
    worker.write_text("# probe", encoding="utf-8")
    monkeypatch.setattr(sharing_tts, "TTS_WORKER", worker)
    payload = _wav_payload()

    def runner(
        command: list[str],
        **_kwargs: object,
    ) -> subprocess.CompletedProcess[str]:
        target = Path(command[command.index("--output") + 1])
        target.write_bytes(payload)
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=json.dumps(
                {
                    "ok": True,
                    "sample_rate": 24_000,
                    "bytes": reported_bytes,
                    "sha256": reported_sha256,
                }
            ),
            stderr="",
        )

    runtime = sharing_tts.QwenTtsSharingRuntime(
        _settings(tmp_path),
        runner=runner,
    )
    with pytest.raises(sharing_tts.TtsSynthesisError) as captured:
        runtime.synthesize(_request())

    assert captured.value.code == "tts_audio_invalid"


def test_contract_load_is_bounded_and_identity_bound(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    generator = _load_generator()
    contract_path = tmp_path / "reference-provenance.json"
    replacement = tmp_path / "replacement.json"
    displaced = tmp_path / "displaced.json"
    contract_path.write_text('{"contractId":"original"}', encoding="utf-8")
    replacement.write_text('{"contractId":"replacement"}', encoding="utf-8")
    monkeypatch.setattr(generator, "CONTRACT_PATH", contract_path)
    real_open = os.open
    swapped = False

    def swapping_open(
        path: os.PathLike[str] | str,
        flags: int,
        mode: int = 0o777,
    ) -> int:
        nonlocal swapped
        if Path(path) == contract_path and not swapped:
            swapped = True
            contract_path.replace(displaced)
            replacement.replace(contract_path)
        return real_open(path, flags, mode)

    monkeypatch.setattr(generator.os, "open", swapping_open)
    with pytest.raises(RuntimeError, match="identity changed before read"):
        generator.load_contract()

    monkeypatch.setattr(generator.os, "open", real_open)
    contract_path.write_bytes(
        b'{"payload":"' + (b"x" * (1024 * 1024)) + b'"}'
    )
    with pytest.raises(RuntimeError, match="exceeds the local safety limit"):
        generator.load_contract()


def test_provenance_json_rejects_duplicate_keys(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    generator = _load_generator()
    contract_path = tmp_path / "reference-provenance.json"
    contract_path.write_text(
        '{"contractId":"first","contractId":"second"}',
        encoding="utf-8",
    )
    monkeypatch.setattr(generator, "CONTRACT_PATH", contract_path)

    with pytest.raises(RuntimeError, match="duplicate key: contractId"):
        generator.load_contract()

    manifest_path = tmp_path / "generation-manifest.json"
    manifest_path.write_text(
        '{"schemaVersion":1,"schemaVersion":2}',
        encoding="utf-8",
    )
    with pytest.raises(RuntimeError, match="duplicate key: schemaVersion"):
        generator.load_generation_manifest_snapshot(manifest_path)


@pytest.mark.parametrize("swapped_path", ["contract", "manifest"])
def test_release_verification_reconciles_persistent_input_digests(
    swapped_path: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    generator = _load_generator()
    source_sha256 = "1" * 64
    generator_path = tmp_path / "generate-voice-references.py"
    generator_bytes = b"# trusted generator\n"
    generator_path.write_bytes(generator_bytes)
    generator_sha256 = hashlib.sha256(generator_bytes).hexdigest()
    manifest_path = tmp_path / "generation-manifest.json"
    manifest_bytes = b'{"schemaVersion":1}'
    manifest_path.write_bytes(manifest_bytes)
    manifest_sha256 = hashlib.sha256(manifest_bytes).hexdigest()
    contract = {
        "status": "verified",
        "generationEvidence": {
            "sourceContractSha256": source_sha256,
            "generatorSha256": generator_sha256,
            "manifestSha256": manifest_sha256,
        },
    }
    contract_bytes = json.dumps(
        contract,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    contract_path = tmp_path / "reference-provenance.json"
    contract_path.write_bytes(contract_bytes)
    contract_file_sha256 = hashlib.sha256(contract_bytes).hexdigest()
    monkeypatch.setattr(generator, "CONTRACT_PATH", contract_path)
    monkeypatch.setattr(generator, "GENERATOR_PATH", generator_path)
    monkeypatch.setattr(generator, "RELEASE_MANIFEST", manifest_path)
    monkeypatch.setattr(generator, "validate_contract", lambda _value: None)
    monkeypatch.setattr(
        generator,
        "source_contract_digest",
        lambda _value: source_sha256,
    )
    monkeypatch.setattr(generator, "verify_assets", lambda _value: None)

    def swap_during_validation(
        _contract: dict[str, object],
        _manifest: dict[str, object],
        **_kwargs: object,
    ) -> list[dict[str, object]]:
        target = contract_path if swapped_path == "contract" else manifest_path
        target.write_bytes(b'{"changed":true}')
        return []

    monkeypatch.setattr(
        generator,
        "validate_generation_manifest_payload",
        swap_during_validation,
    )

    expected_label = (
        "voice provenance contract"
        if swapped_path == "contract"
        else "released voice generation manifest"
    )
    with pytest.raises(
        RuntimeError,
        match=rf"{expected_label} persistent digest changed",
    ):
        generator.verify_release(
            contract,
            contract_file_sha256=contract_file_sha256,
        )


@pytest.mark.skipif(os.name != "nt", reason="Windows ADS policy")
def test_worker_contract_reader_rejects_ads(
    tmp_path: Path,
) -> None:
    contract_path = tmp_path / "reference-provenance.json"
    contract_path.write_text("{}", encoding="utf-8")
    Path(f"{contract_path}:monarch-provenance-test").write_text(
        "blocked",
        encoding="utf-8",
    )
    worker_path = WORKSPACE_ROOT / "tools" / "sharing-tts-worker.py"
    probe = "\n".join(
        [
            "import importlib.util,pathlib,sys",
            "module_path=pathlib.Path(sys.argv[1])",
            "target=pathlib.Path(sys.argv[2])",
            (
                "spec=importlib.util.spec_from_file_location("
                "'sharing_contract_reader_probe',module_path)"
            ),
            "module=importlib.util.module_from_spec(spec)",
            "spec.loader.exec_module(module)",
            "try:",
            (
                " module.read_bound_regular_file("
                "target,label='voice provenance contract',maximum_bytes=1024)"
            ),
            "except Exception as error:",
            " module.PROTOCOL_STDOUT.write(str(error))",
            " raise SystemExit(3)",
            "raise SystemExit(0)",
        ]
    )
    completed = subprocess.run(
        [sys.executable, "-c", probe, str(worker_path), str(contract_path)],
        cwd=WORKSPACE_ROOT,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env={
            **os.environ,
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONUTF8": "1",
        },
    )

    assert completed.returncode == 3
    assert "alternate data stream" in completed.stdout


def test_staging_parent_link_is_rejected_before_creation(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    generator = _load_generator()
    real_parent = tmp_path / "real-parent"
    real_parent.mkdir()
    linked_parent = tmp_path / "linked-parent"
    _create_directory_link(real_parent, linked_parent)
    monkeypatch.setattr(
        generator,
        "STAGING_PATH",
        linked_parent / "qa" / "voice-staging",
    )

    with pytest.raises(RuntimeError, match="link or junction"):
        generator.ensure_clean_staging()

    assert list(real_parent.iterdir()) == []


def test_model_availability_rejects_lexical_directory_link(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    real_model = (
        Path(settings.sharing_tts_models_dir) / "qwen3-tts-0.6b-base"
    )
    linked_root = tmp_path / "linked-models"
    real_root = tmp_path / "models"
    real_root.rename(tmp_path / "real-models")
    _create_directory_link(tmp_path / "real-models", linked_root)
    settings.sharing_tts_models_dir = linked_root

    assert not sharing_tts.is_qwen_tts_model_available(
        settings,
        sharing_tts.QWEN_TTS_MODELS[0],
    )
    assert real_model.name == "qwen3-tts-0.6b-base"
