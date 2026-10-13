"""Closed QA admission before resident load; all temporary data on owned D:."""
import importlib.util
import json
from pathlib import Path

import pytest

FIXTURES = Path(__file__).resolve().parents[3] / 'tests/fixtures/agent-v3'
spec = importlib.util.spec_from_file_location('owned_model_scope', FIXTURES / 'owned_model_scope.py')
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)


def test_only_explicit_pinned_public_qa_profiles_are_admitted():
    assert set(scope.PROFILES) == {'astra-v3-live-smollm2-', 'astra-v3-live-qwen25-15b-', 'astra-v3-live-gemma4-e4b-'}
    for marker, file, size in scope.PROFILES.values():
        profile = json.loads((FIXTURES / file).read_text(encoding='utf-8'))
        assert len(profile['sha256']) == 64 and len(profile['revision']) == 40
        assert profile['file'] == Path(profile['file']).name
        assert profile['execution']['gpuLayers'] == 0
        assert size in (105454432, 1117320736, 5154941280)


@pytest.mark.parametrize('name', ['unknown-model', 'astra-v3-live-qwen25-', 'astra-v3-live-product-'])
def test_unknown_children_fail_before_any_marker_or_profile_read(tmp_path, name):
    assert tmp_path.drive.upper() == 'D:'
    root = tmp_path / name; root.mkdir()
    with pytest.raises(RuntimeError, match='fixture-scope'):
        scope.admit_owned_model(root, tmp_path)


def test_nested_child_cannot_escape_exact_parent(tmp_path):
    root = tmp_path / 'nested/astra-v3-live-qwen25-15b-fake'; root.mkdir(parents=True)
    with pytest.raises(RuntimeError, match='fixture-scope'):
        scope.admit_owned_model(root, tmp_path)


@pytest.mark.parametrize('prefix', list(scope.PROFILES))
def test_marker_and_exact_size_required_before_asset_load(tmp_path, prefix):
    assert tmp_path.drive.upper() == 'D:'
    root = tmp_path / (prefix + 'synthetic-test'); root.mkdir()
    marker, profile_file, _ = scope.PROFILES[prefix]
    marker_file = root / '.fixture-marker'; marker_file.write_text('wrong-marker', encoding='utf-8')
    with pytest.raises(RuntimeError, match='fixture-marker'):
        scope.admit_owned_model(root, tmp_path)
    marker_file.write_text(marker, encoding='utf-8')
    profile = json.loads((FIXTURES / profile_file).read_text(encoding='utf-8'))
    (root / 'model').mkdir(); (root / 'model' / profile['file']).write_bytes(b'GGUFfake')
    with pytest.raises(RuntimeError, match='fixture-model-scope'):
        scope.admit_owned_model(root, tmp_path)
