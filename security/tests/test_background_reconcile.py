import json
import pytest
from monarch_security import background
from test_supervisor_backlog import _config


@pytest.fixture
def installed(tmp_path, monkeypatch):
    install = tmp_path / 'install'
    root = install / 'versions' / '2' / 'security'
    root.mkdir(parents=True)
    monkeypatch.setattr(background, '__file__', str(root / 'src' / 'monarch_security' / 'background.py'))
    monkeypatch.setenv('MONARCH_INSTALL_ROOT', str(install))
    pointer = install / 'current.json'
    pointer.write_text(json.dumps({'schemaVersion': 1, 'currentVersion': '2'}))
    (tmp_path / 'data').mkdir()
    config = _config(tmp_path / 'data', max_events_per_tick=2)
    background.write_background(config, enabled=True, requested=False, startup_registered=True)
    return config, root / 'config' / 'monarch_security.toml', pointer


def test_rebind_preserves_signed_pause_and_never_starts_or_registers(installed, monkeypatch):
    config, config_path, _ = installed
    before = config.runtime.state_path.read_bytes()
    calls = []
    def command(spec, operation):
        calls.append(operation)
        return {'exact': operation == 'rebind', 'enabled': True, 'run_level': 'Limited'}
    monkeypatch.setattr(background, '_task_command', command)
    assert background.reconcile_background(config, config_path) == {'ok': True, 'state': 'rebound'}
    assert calls == ['inspect', 'rebind']
    assert config.runtime.state_path.read_bytes() == before
    assert background.read_background(config)['requested'] is False


@pytest.mark.parametrize('pointer_value', [{'schemaVersion': 1, 'currentVersion': '1'}, [], {'schemaVersion': 1, 'currentVersion': '../2'}])
def test_trial_old_runtime_and_invalid_pointer_never_modify_task(installed, monkeypatch, pointer_value):
    config, config_path, pointer = installed
    pointer.write_text(json.dumps(pointer_value))
    monkeypatch.setattr(background, '_task_command', lambda *_: pytest.fail('must not touch task'))
    assert background.reconcile_background(config, config_path)['state'] == 'awaiting-current-version'


def test_disabled_preference_never_recreates_task(installed, monkeypatch):
    config, config_path, _ = installed
    background.write_background(config, enabled=False)
    monkeypatch.setattr(background, '_task_command', lambda *_: pytest.fail('must not touch task'))
    assert background.reconcile_background(config, config_path)['state'] == 'not-enabled'


def test_current_action_is_idempotent(installed, monkeypatch):
    config, config_path, _ = installed
    calls = []
    monkeypatch.setattr(background, '_task_command', lambda spec, op: calls.append(op) or {'exact': True})
    assert background.reconcile_background(config, config_path)['state'] == 'current'
    assert calls == ['inspect']


@pytest.mark.parametrize('status', [{'enabled': False, 'run_level': 'Limited'}, {'enabled': True, 'run_level': 'Highest'}])
def test_external_task_policy_is_preserved(installed, monkeypatch, status):
    config, config_path, _ = installed
    calls = []
    monkeypatch.setattr(background, '_task_command', lambda spec, op: calls.append(op) or status)
    assert background.reconcile_background(config, config_path)['state'] == 'task-not-eligible'
    assert calls == ['inspect']


def test_concurrent_pointer_change_prevents_rebind(installed, monkeypatch):
    config, config_path, pointer = installed
    def command(spec, op):
        assert op == 'inspect'
        pointer.write_text(json.dumps({'schemaVersion': 1, 'currentVersion': '3'}))
        return {'enabled': True, 'run_level': 'Limited'}
    monkeypatch.setattr(background, '_task_command', command)
    assert background.reconcile_background(config, config_path)['state'] == 'superseded'


def test_corrupted_state_never_rebinds(installed, monkeypatch):
    config, config_path, _ = installed
    config.runtime.state_path.write_bytes(bytes(30))
    monkeypatch.setattr(background, '_task_command', lambda *_: pytest.fail('must not touch task'))
    with pytest.raises(RuntimeError, match='state-integrity'):
        background.reconcile_background(config, config_path)
