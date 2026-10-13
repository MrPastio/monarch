"""Owned metadata/inspection wrapper. No stores, credentials or action authority."""
from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
import math
import os
import stat
import sys

from .config import FileConfig
from .events import SecurityEvent
from .file_parser_worker import _worker_environment
from .worker_transport import ProcessWorkerPool, WorkerError, decode_frame, encode_frame

REQUEST_BYTES = 65_536
RESPONSE_BYTES = 1_048_576
VERSION_FIELDS = ('size', 'mtime_ns', 'device', 'inode', 'ctime_ns')


def new_pool() -> ProcessWorkerPool:
    environment = _worker_environment()
    environment.pop('MONARCH_SECURITY_FILE_PARSER_WORKER', None)
    return ProcessWorkerPool(
        [sys._base_executable, '-S', '-u', '-m', 'monarch_security.inspection_worker'],
        environment=environment, cwd=str(Path(__file__).resolve().parents[1]),
        capacity=2, request_bytes=REQUEST_BYTES, response_bytes=RESPONSE_BYTES,
    )


def request_for(event: SecurityEvent, config: FileConfig, nonce: str) -> dict:
    return {'schema': 1, 'nonce': nonce, 'event_id': event.event_id,
            'path': event.facts.get('path'),
            'version': {key: event.facts.get(key) for key in VERSION_FIELDS},
            'config': asdict(config)}


def timeout_for(config: FileConfig) -> float:
    # The inner parser keeps its own configured deadline, including default 5s.
    return min(30.0, max(0.5, float(config.parser_timeout_seconds))) + 7.0


def _require(condition: bool) -> None:
    if not condition:
        raise WorkerError('inspection-protocol-invalid')


def validate_request(request: dict) -> FileConfig:
    _require(type(request) is dict and set(request) == {
        'schema', 'nonce', 'event_id', 'path', 'version', 'config'})
    _require(type(request['schema']) is int and request['schema'] == 1)
    _require(type(request['nonce']) is str and len(request['nonce']) == 32
             and all(c in '0123456789abcdef' for c in request['nonce']))
    _require(type(request['event_id']) is str and 0 < len(request['event_id']) <= 128)
    _require(type(request['path']) is str and 0 < len(request['path']) <= 32_768
             and '\0' not in request['path'] and Path(request['path']).is_absolute())
    _require(type(request['version']) is dict and set(request['version']) == set(VERSION_FIELDS))
    for value in request['version'].values():
        _require(value is None or (type(value) is int and 0 <= value < 2**128))
    options = request['config']
    _require(type(options) is dict and set(options) == set(asdict(FileConfig())))
    for key, low, high in (('max_full_hash_bytes', 0, 4 * 1024**3),
                           ('entropy_sample_bytes', 0, 16 * 1024**2),
                           ('parser_memory_limit_bytes', 128 * 1024**2, 512 * 1024**2)):
        _require(type(options[key]) is int and low <= options[key] <= high)
    value = options['parser_timeout_seconds']
    _require(type(value) in (int, float) and math.isfinite(value) and 0.5 <= value <= 30)
    return FileConfig(**options)


def file_version(path: Path) -> dict:
    value = path.lstat()
    if (not stat.S_ISREG(value.st_mode)
            or getattr(value, 'st_file_attributes', 0) & 0x400
            or path.resolve() != path):
        raise WorkerError('inspection-target-not-regular')
    return dict(zip(VERSION_FIELDS, (value.st_size, value.st_mtime_ns,
                                     value.st_dev, value.st_ino, value.st_ctime_ns)))


def failure_event(event: SecurityEvent, code: str) -> SecurityEvent:
    # Retain observed metadata only. A failed result is never a digest approval.
    return SecurityEvent(kind='file.scanned', source='file_scanner', subject=event.subject,
                         event_id=event.event_id, timestamp=event.timestamp,
                         facts={**event.facts, 'content_parser_isolated': True,
                                'content_parser_status': 'unavailable',
                                'content_error': code, 'inspection_complete': False,
                                'inspection_error': code})


def _response(request: dict, status: str, facts: dict) -> dict:
    return {'schema': 1, 'nonce': request['nonce'], 'event_id': request['event_id'],
            'path': request['path'], 'status': status, 'facts': facts}


def _incomplete(request: dict, code: str) -> dict:
    return _response(request, 'incomplete', {'inspection_complete': False,
                                          'inspection_error': code})


def process_request(request: dict) -> dict:
    config = validate_request(request)
    if any(value is None for value in request['version'].values()):
        return _incomplete(request, 'observed-version-unavailable')
    path = Path(request['path'])
    try:
        before = file_version(path)
        if before != request['version']:
            return _incomplete(request, 'observed-version-changed')
        from .sensors.files import FileScanner
        event = FileScanner(config).inspect(path)
        facts = dict(event.facts)
        if facts.get('content_parser_status') != 'ok':
            facts.update(inspection_complete=False, inspection_error='content-unavailable')
        else:
            from .signature_metadata import signature_facts, signature_required
            if signature_required(path, facts):
                facts.update(signature_facts(path))
            complete = facts.get('authenticode_status') != 'Unavailable'
            facts.update(inspection_complete=complete)
            if not complete:
                facts['inspection_error'] = 'signature-unavailable'
        if file_version(path) != before:
            return _incomplete(request, 'inspection-version-changed')
        return _response(request, 'complete' if facts['inspection_complete'] else 'incomplete', facts)
    except OSError:
        return _incomplete(request, 'inspection-file-unavailable')
    except WorkerError as exc:
        return _incomplete(request, str(exc))


def validate_result(request: dict, response: dict, source: SecurityEvent) -> SecurityEvent:
    _require(type(response) is dict and set(response) == {
        'schema', 'nonce', 'event_id', 'path', 'status', 'facts'})
    _require(type(response['schema']) is int and response['schema'] == 1
             and all(response[key] == request[key] for key in ('nonce', 'event_id', 'path'))
             and type(response['status']) is str and response['status'] in ('complete', 'incomplete')
             and type(response['facts']) is dict)
    facts = response['facts']
    complete = response['status'] == 'complete'
    _require(type(facts.get('inspection_complete')) is bool and facts['inspection_complete'] == complete)
    if complete:
        from .signature_metadata import signature_required
        _require(facts.get('path') == request['path'] and facts.get('content_parser_status') == 'ok'
                 and facts.get('content_parser_isolated') is True)
        sandbox = facts.get('content_parser_sandbox')
        _require(type(sandbox) is dict and sandbox.get('process') == 'isolated-worker'
                 and (os.name != 'nt' or (sandbox.get('integrity') == 'low'
                                          and sandbox.get('memory_limit') == 'windows-job')))
        if signature_required(Path(request['path']), facts):
            _require(facts.get('authenticode_status') in {
                'Valid', 'NotSigned', 'HashMismatch', 'NotTrusted', 'NotSupportedFileFormat', 'UnknownError'})
            _require(type(facts.get('authenticode_signed')) is bool
                     and (facts['authenticode_status'] != 'Valid' or facts['authenticode_signed']))
    else:
        _require(type(facts.get('inspection_error')) is str
                 and 0 < len(facts['inspection_error']) <= 128)
        # Keep partial content evidence when genuine parser failure returned it;
        # version/protocol failures carry no newly attributed content facts.
        facts = {**failure_event(source, facts['inspection_error']).facts, **facts}
    if 'inspection_recovery_id' in source.facts:
        facts = {**facts, 'inspection_recovery_id': source.facts['inspection_recovery_id']}
    return SecurityEvent(kind='file.scanned', source='file_scanner', subject=source.subject,
                         event_id=source.event_id, timestamp=source.timestamp, facts=facts)


def worker_main() -> int:
    try:
        while True:
            raw = sys.stdin.buffer.readline(REQUEST_BYTES + 1)
            if not raw:
                return 0
            message = decode_frame(raw, REQUEST_BYTES)
            _require(set(message) == {'schema', 'id', 'payload'}
                     and type(message['schema']) is int and message['schema'] == 1
                     and type(message['id']) is int and message['id'] > 0)
            result = process_request(message['payload'])
            sys.stdout.buffer.write(encode_frame({'schema': 1, 'id': message['id'], 'payload': result}, RESPONSE_BYTES))
            sys.stdout.buffer.flush()
    except (WorkerError, OSError):
        return 2


if __name__ == '__main__':
    raise SystemExit(worker_main())
