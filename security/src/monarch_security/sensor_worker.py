"""Fixed sensor worker entry point; no signed stores or action APIs."""
from __future__ import annotations

from dataclasses import asdict, fields
import os
from pathlib import Path
import sys
import sysconfig

from .worker_transport import MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, WorkerError, decode_frame, encode_frame
from .observation import ObservedSensor, ObservationUnavailable, valid_observation

SENSOR_PROTOCOL_SCHEMA = 2


def worker_launch():
    """Use the actual interpreter; Windows venv launchers escape late assignment.

    -S avoids site customization. Only this package and this runtime's declared
    dependency directories are supplied, not ambient PYTHONPATH or credentials.
    """
    source = Path(__file__).resolve().parent.parent
    paths = [str(source)]
    for name in ('purelib', 'platlib'):
        dependency = sysconfig.get_path(name)
        if dependency and dependency not in paths:
            paths.append(dependency)
    allowed = {'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'USERPROFILE', 'APPDATA',
               'LOCALAPPDATA', 'PROGRAMDATA', 'TEMP', 'TMP', 'SYSTEMDRIVE', 'PUBLIC'}
    environment = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    environment.update(PYTHONPATH=os.pathsep.join(paths), PYTHONDONTWRITEBYTECODE='1', PYTHONIOENCODING='utf-8')
    return [sys._base_executable, '-S', '-u', '-m', 'monarch_security.sensor_worker'], environment, str(source)


def _classes():
    from .sensors import (ProcessSensor, DeviceSensor, InstallSensor, FileChangeSensor,
                          TamperSensor, NetworkSensor, PersistenceSensor, PostureSensor)
    return dict(zip(('process_sensor', 'device_sensor', 'install_sensor', 'file_watch_sensor',
                     'tamper_sensor', 'network_sensor', 'persistence_sensor', 'posture_sensor'),
                    (ProcessSensor, DeviceSensor, InstallSensor, FileChangeSensor, TamperSensor,
                     NetworkSensor, PersistenceSensor, PostureSensor)))


def _require(condition):
    if not condition:
        raise WorkerError('sensor-protocol-invalid')


def snapshot(sensor) -> dict:
    values = {}
    for key in ('_first_poll', '_seen', '_pending_details', '_signatures', '_cursor', '_cycle_seen', '_overflow', '_overflow_detail',
                '_verify_inventory', '_verification_match', '_verification_passes'):
        if hasattr(sensor, key):
            value = getattr(sensor, key)
            values[key] = sorted(value) if isinstance(value, set) else value.copy() if isinstance(value, dict) else value
    return values


def validate_snapshot(sensor, state):
    _require(isinstance(state, dict) and set(state) == set(snapshot(sensor)))
    for key, value in state.items():
        if key in {'_first_poll', '_overflow', '_verify_inventory', '_verification_match'}:
            _require(type(value) is bool)
        elif key == '_cursor':
            _require(type(value) is int and 0 <= value < 2**53)
        elif key == '_verification_passes':
            _require(type(value) is int and 0 <= value <= 3)
        elif key in {'_seen', '_cycle_seen', '_pending_details'}:
            from .sensors import ProcessSensor
            item_type = int if key in {'_seen', '_pending_details'} and isinstance(sensor, ProcessSensor) else str
            _require(isinstance(value, list) and all(type(item) is item_type for item in value))
            if item_type is int:
                _require(all(0 <= item < 2**32 for item in value))
        elif key == '_signatures':
            _require(isinstance(value, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in value.items()))
        elif key == '_overflow_detail':
            _require(isinstance(value, dict) and set(value) <= {'neighbor', 'listener', 'connection'})
            for detail in value.values():
                _require(isinstance(detail, dict) and set(detail) == {'observed', 'configured_threshold'}
                         and all(type(v) is int and 0 <= v < 2**53 for v in detail.values()))


def restore(sensor, state):
    validate_snapshot(sensor, state)
    for key, value in state.items():
        setattr(sensor, key, set(value) if key in {'_seen', '_cycle_seen', '_pending_details'} else value.copy() if isinstance(value, dict) else value)


def request_for(name: str, sensor) -> dict:
    _require(name in _classes() and type(sensor) is _classes()[name])
    options = {'include_existing': sensor.include_existing}
    if name in {'file_watch_sensor', 'tamper_sensor'}:
        options['paths'] = [str(path) for path in sensor.paths]
    if name == 'file_watch_sensor':
        options.update(recursive=sensor.recursive, max_entries_per_tick=sensor.max_entries_per_tick)
    if name in {'network_sensor', 'persistence_sensor', 'posture_sensor'}:
        options['config'] = asdict(sensor.config)
    if name == 'persistence_sensor':
        options['approved_signatures'] = dict(sensor._approved_signatures)
    return {'schema': SENSOR_PROTOCOL_SCHEMA, 'sensor': name, 'options': options, 'state': snapshot(sensor)}


def construct(request):
    _require(isinstance(request, dict) and set(request) == {'schema', 'sensor', 'options', 'state'}
             and type(request['schema']) is int and request['schema'] == SENSOR_PROTOCOL_SCHEMA)
    name, options = request['sensor'], request['options']
    _require(isinstance(name, str) and name in _classes() and isinstance(options, dict))
    options = dict(options)
    expected = {'include_existing'}
    if name in {'file_watch_sensor', 'tamper_sensor'}:
        expected.add('paths')
        _require(isinstance(options.get('paths'), list) and all(isinstance(p, str) and Path(p).is_absolute() for p in options['paths']))
        options['paths'] = tuple(Path(p) for p in options['paths'])
    if name == 'file_watch_sensor':
        expected.update(('recursive', 'max_entries_per_tick'))
        _require(type(options.get('recursive')) is bool and type(options.get('max_entries_per_tick')) is int
                 and 1 <= options['max_entries_per_tick'] <= 1_000_000)
    if name in {'network_sensor', 'persistence_sensor', 'posture_sensor'}:
        from .config import NetworkConfig, PersistenceConfig, PostureConfig
        config_type = {'network_sensor': NetworkConfig, 'persistence_sensor': PersistenceConfig,
                       'posture_sensor': PostureConfig}[name]
        expected.add('config')
        config = options.get('config')
        _require(isinstance(config, dict) and set(config) == {field.name for field in fields(config_type)})
        defaults = asdict(config_type())
        for key, value in config.items():
            default = defaults[key]
            if type(default) is bool:
                _require(type(value) is bool)
            elif type(default) is int:
                _require(type(value) is int and 0 < value <= 1_000_000)
            else:
                _require(type(value) in {int, float} and 0 < value <= 1_000_000)
        options['config'] = config_type(**config)
    if name == 'persistence_sensor':
        expected.add('approved_signatures')
        approved = options.get('approved_signatures')
        _require(isinstance(approved, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in approved.items()))
    _require(set(options) == expected and type(options.get('include_existing')) is bool)
    sensor = _classes()[name](**options)
    restore(sensor, request['state'])
    return sensor


def poll(request):
    sensor = construct(request)
    _require(isinstance(sensor, ObservedSensor))
    events = []
    before = snapshot(sensor)
    try:
        for event in sensor.poll():
            if len(events) >= 10000:
                raise WorkerError('sensor-event-limit')
            # Raw command facts exist only in transit for controller rules.
            events.append(asdict(event))
        if getattr(sensor, 'last_error', None):
            raise ObservationUnavailable('sensor-query-failed')
        observation = sensor.observation
    except ObservationUnavailable as exc:
        restore(sensor, before)
        events = []
        observation = {'status': 'unavailable', 'reasons': [str(exc)]}
    _require(valid_observation(observation))
    return {'schema': SENSOR_PROTOCOL_SCHEMA, 'sensor': request['sensor'], 'state': snapshot(sensor), 'events': events,
            'backend': getattr(sensor, 'backend_name', None), 'observation': observation}


def validate_result(name, sensor, reply):
    from .events import SecurityEvent
    if isinstance(reply, dict) and set(reply) == {'error'}:
        _require(reply['error'] in {'sensor-query-failed', 'sensor-event-limit', 'sensor-protocol-invalid', 'sensor-poll-failed', 'worker-frame-too-large'})
        raise WorkerError(reply['error'])
    _require(isinstance(reply, dict) and set(reply) == {'schema', 'sensor', 'state', 'events', 'backend', 'observation'}
             and type(reply['schema']) is int and reply['schema'] == SENSOR_PROTOCOL_SCHEMA and reply['sensor'] == name)
    _require(valid_observation(reply['observation']))
    validate_snapshot(sensor, reply['state'])
    _require(reply['backend'] in ({'psutil', 'tasklist'} if name == 'process_sensor' else {None}))
    raw_events = reply['events']
    _require(isinstance(raw_events, list) and len(raw_events) <= 10000)
    if reply['observation']['status'] == 'unavailable':
        _require(not raw_events and reply['state'] == snapshot(sensor))
    events = []
    for raw in raw_events:
        _require(isinstance(raw, dict) and set(raw) == {'kind', 'source', 'subject', 'facts', 'event_id', 'timestamp'})
        _require(all(isinstance(raw[field], str) and raw[field].strip()
                     for field in ('kind', 'source', 'subject', 'event_id', 'timestamp')) and isinstance(raw['facts'], dict))
        _require(raw['source'] == name)
        events.append(SecurityEvent.from_dict(raw))
    return events


def main():
    # Gate before importing sensor modules or creating descendants. Parent has
    # assigned its Job Object before it sends this first frame.
    while True:
        raw = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
        if not raw:
            return 0
        try:
            frame = decode_frame(raw, MAX_REQUEST_BYTES)
            _require(set(frame) == {'schema', 'id', 'payload'} and type(frame['schema']) is int
                     and frame['schema'] == 1 and type(frame['id']) is int and frame['id'] > 0)
            try:
                result = poll(frame['payload'])
                output = encode_frame({'schema': 1, 'id': frame['id'], 'payload': result}, MAX_RESPONSE_BYTES)
            except Exception as exc:
                code = str(exc) if isinstance(exc, WorkerError) else 'sensor-poll-failed'
                output = encode_frame({'schema': 1, 'id': frame['id'], 'payload': {'error': code}}, MAX_RESPONSE_BYTES)
            sys.stdout.buffer.write(output)
            sys.stdout.buffer.flush()
        except Exception:
            # No partial output/checkpoint, no raw exception text on disk/pipes.
            return 1


if __name__ == '__main__':
    raise SystemExit(main())
