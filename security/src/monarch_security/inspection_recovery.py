"""Signed owner-requested rescan of the current file-watch scope."""
from __future__ import annotations

from pathlib import Path
import secrets

from .events import utc_now
from .observation import valid_observation
from .state import StateStore
from .worker_transport import WorkerError

KEY = 'file_inspection_recovery_v1'
ACTIVE = {'queued', 'running'}


def scope_for(config) -> dict:
    return {'paths': [str(path) for path in config.file_watch.paths],
            'recursive': config.file_watch.recursive}


def read(state) -> dict | None:
    value = state.get_json(KEY)
    if value is None:
        return None
    if (type(value) is not dict or set(value) != {'schema', 'id', 'status', 'scope',
            'requested_at', 'finished_at', 'checked_files', 'failed_files', 'inventory_failures', 'reason'}
            or type(value['schema']) is not int or value['schema'] != 1
            or type(value['id']) is not str or len(value['id']) != 32
            or any(c not in '0123456789abcdef' for c in value['id'])
            or type(value['status']) is not str or value['status'] not in ACTIVE | {'complete', 'incomplete'}
            or type(value['scope']) is not dict or set(value['scope']) != {'paths', 'recursive'}
            or type(value['scope']['paths']) is not list or not value['scope']['paths']
            or len(value['scope']['paths']) > 128 or type(value['scope']['recursive']) is not bool
            or any(type(p) is not str or not Path(p).is_absolute() for p in value['scope']['paths'])
            or type(value['requested_at']) is not str
            or (value['finished_at'] is not None and type(value['finished_at']) is not str)
            or any(type(value[key]) is not int or not 0 <= value[key] < 2**53
                   for key in ('checked_files', 'failed_files'))
            or value['failed_files'] > value['checked_files']
            or type(value['inventory_failures']) is not int or not 0 <= value['inventory_failures'] <= 3
            or type(value['reason']) is not str or len(value['reason']) > 128):
        raise WorkerError('inspection-recovery-state-invalid')
    return value


def projection(state) -> dict:
    value = read(state)
    return ({key: value[key] for key in ('id', 'status', 'checked_files', 'failed_files',
                                        'requested_at', 'finished_at', 'reason')}
            if value else {'status': 'idle'})


def request_retry(config) -> dict:
    # Recovery never enrolls a missing runtime or creates an integrity key.
    if not config.runtime.state_path.is_file() or not config.runtime.integrity_key_path.is_file():
        raise WorkerError('inspection-runtime-not-enrolled')
    from .background import _require_valid_state
    from .inspection_queue import FileInspectionQueue
    state = StateStore(config.runtime.state_path, config.runtime.integrity_key_path, require_existing_key=True)
    _require_valid_state(state)
    with state.lock():
        if not config.runtime.state_path.is_file():
            raise WorkerError('inspection-runtime-not-enrolled')
        _require_valid_state(state)
        if str(state.data.get('security_level', '')).strip().lower() == 'off':
            raise WorkerError('inspection-monitoring-paused')
        if not config.file_watch.enabled or not config.file_watch.paths:
            raise WorkerError('inspection-watch-scope-disabled')
        if len(config.file_watch.paths) > 128:
            raise WorkerError('inspection-watch-scope-too-large')
        current = read(state)
        if current and current['status'] in ACTIVE:
            return {'ok': True, 'accepted': False, **projection(state)}
        inspector = FileInspectionQueue(state, config.files, 'pending_sensor_batches_v1')
        if not inspector.gap_count():
            return {'ok': True, 'accepted': False, 'status': 'idle'}
        value = {'schema': 1, 'id': secrets.token_hex(16), 'status': 'queued',
                 'scope': scope_for(config), 'requested_at': utc_now(), 'finished_at': None,
                 'checked_files': 0, 'failed_files': 0, 'inventory_failures': 0, 'reason': ''}
        state.set_json(KEY, value)
        return {'ok': True, 'accepted': True, **projection(state)}


def active_id(state) -> str | None:
    value = read(state)
    return value['id'] if value and value['status'] == 'running' else None


def record_result_locked(state, event) -> bool:
    value = read(state)
    if not value or value['status'] != 'running' or event.facts.get('inspection_recovery_id') != value['id']:
        return False
    value['checked_files'] += 1
    value['failed_files'] += int(event.facts.get('inspection_complete') is not True)
    state.set_json(KEY, value)
    return True


def fail_inventory_locked(state, inspector):
    value = read(state)
    if not value or value['status'] != 'running':
        return False
    value['inventory_failures'] = min(3, value['inventory_failures'] + 1)
    if value['inventory_failures'] < 3:
        state.set_json(KEY, value)
        return False
    from .inspection_queue import GAPS_KEY
    gaps = inspector.gaps()
    gaps['overflow'] = True
    state.set_json(GAPS_KEY, gaps)
    value.update(status='incomplete', reason='inspection-inventory-unavailable', finished_at=utc_now())
    state.set_json(KEY, value)
    return True


def reset_inventory_failures_locked(state):
    value = read(state)
    if value and value['status'] == 'running' and value['inventory_failures']:
        value['inventory_failures'] = 0
        state.set_json(KEY, value)


def finish_inventory_locked(state, inspector, config, checkpoint, recovery_id, observation):
    value = read(state)
    if not value or value['status'] != 'running' or recovery_id != value['id']:
        checkpoint.setdefault('metadata', {})['verify_inventory'] = False
        return
    if value['scope'] != scope_for(config):
        checkpoint.setdefault('metadata', {})['verify_inventory'] = False
        value.update(status='incomplete', reason='inspection-watch-scope-changed', finished_at=utc_now())
        state.set_json(KEY, value)
        return
    metadata = checkpoint.get('metadata', {})
    inventory_changed = (observation == {'status': 'partial', 'reasons': ['recovery-inventory-changed']})
    if (checkpoint.get('cursor') != 0 or not valid_observation(observation)
            or (observation['status'] != 'complete' and not inventory_changed)):
        return
    if not metadata.get('verify_inventory'):
        metadata.update(verify_inventory=True, verification_match=False, verification_passes=0)
        checkpoint['metadata'] = metadata
        value['reason'] = 'inspection-verifying-inventory'
        state.set_json(KEY, value)
        return
    if not metadata.get('verification_match') and metadata.get('verification_passes', 0) < 3:
        value['reason'] = 'inspection-inventory-changed'
        state.set_json(KEY, value)
        return
    from .inspection_queue import GAPS_KEY
    gaps = inspector.gaps()
    # Full current inventory plus accepted content results repairs dropped-name
    # coverage. Missing/removed-scope named gaps remain explicitly unresolved.
    stable = metadata.get('verification_match') is True
    if not stable:
        gaps['overflow'] = True
        state.set_json(GAPS_KEY, gaps)
    elif not value['failed_files']:
        gaps['overflow'] = False
        state.set_json(GAPS_KEY, gaps)
    remaining = len(gaps['entries']) + int(gaps['overflow'])
    metadata['verify_inventory'] = False
    value.update(status='incomplete' if remaining or value['failed_files'] else 'complete',
                 reason='inspection-inventory-unstable' if not stable else 'inspection-files-unavailable' if remaining or value['failed_files'] else '',
                 finished_at=utc_now())
    state.set_json(KEY, value)
