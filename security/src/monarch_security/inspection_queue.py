"""Controller-owned durable attempts; children never touch signed state."""
from __future__ import annotations

from dataclasses import dataclass
from concurrent.futures import Future
import hashlib
import math
import secrets
import time

from .events import RuleAssessment
from . import inspection_worker as worker
from .worker_transport import WorkerError

GAPS_KEY = 'file_inspection_gaps_v1'
MAX_GAPS = 512
MAX_ATTEMPTS = 3
NO_RETRY = {'observed-version-unavailable', 'observed-version-changed',
            'inspection-version-changed', 'inspection-target-not-regular'}


@dataclass
class _Job:
    future: Future
    request: dict
    generation: int


class FileInspectionQueue:
    def __init__(self, state, config, batch_key: str):
        self.state, self.config, self.batch_key = state, config, batch_key
        self._pool = None
        self._jobs: dict[str, _Job] = {}
        self._generation = 0

    def close(self):
        self._generation += 1
        if self._pool is not None:
            self._pool.close()  # Cleanup failure retains the poisoned pool.
            self._pool = None
        self._jobs.clear()

    @staticmethod
    def _metadata(batch: dict, index: int, event_id: str) -> dict:
        attempts = batch.get('inspections', {})
        if type(attempts) is not dict:
            raise WorkerError('inspection-attempt-state-invalid')
        value = attempts.get(str(index))
        if value is None:
            return {'event_id': event_id, 'attempts': 0, 'nonce': '', 'next_at': 0.0,
                    'last_code': 'inspection-interrupted'}
        if (type(value) is not dict or set(value) != {
                'event_id', 'attempts', 'nonce', 'next_at', 'last_code'}
                or value['event_id'] != event_id or type(value['attempts']) is not int
                or not 1 <= value['attempts'] <= MAX_ATTEMPTS
                or type(value['nonce']) is not str or len(value['nonce']) != 32
                or any(c not in '0123456789abcdef' for c in value['nonce'])
                or type(value['next_at']) not in (int, float) or not math.isfinite(value['next_at'])
                or type(value['last_code']) is not str or not 0 < len(value['last_code']) <= 128):
            raise WorkerError('inspection-attempt-state-invalid')
        return dict(value)

    def _persist(self, name: str, batch: dict, index: int, assessment: RuleAssessment,
                 metadata: dict, replacement: RuleAssessment | None = None):
        with self.state.lock():
            batches = self.state.get_json(self.batch_key, {})
            current = batches.get(name)
            if (type(current) is not dict or int(current.get('next_index', 0)) > index
                    or type(current.get('assessments')) is not list
                    or index >= len(current['assessments'])
                    or current['assessments'][index].get('event', {}).get('event_id') != assessment.event.event_id):
                raise WorkerError('inspection-source-state-changed')
            # Full original payload binding prevents a result for a reused ID
            # from overwriting altered signed source metadata.
            if current['assessments'][index] != assessment.to_dict():
                raise WorkerError('inspection-source-state-changed')
            attempts = dict(current.get('inspections', {}))
            attempts[str(index)] = metadata
            current['inspections'] = attempts
            if replacement is not None:
                current['assessments'][index] = replacement.to_dict()
                self._update_gap_locked(replacement.event)
            self.state.set_json(self.batch_key, batches)
        batch['inspections'] = attempts
        if replacement is not None:
            batch['assessments'][index] = replacement.to_dict()

    def materialize(self, name: str, batch: dict, index: int,
                    assessment: RuleAssessment, assess, *, accept_result: bool = True,
                    force_code: str | None = None) -> RuleAssessment | None:
        event = assessment.event
        metadata = self._metadata(batch, index, event.event_id)
        if force_code:
            if not accept_result:
                return None
            self.close()
            if not metadata['attempts']:
                metadata.update(attempts=1, nonce=secrets.token_hex(16))
            metadata.update(next_at=0.0, last_code=force_code)
            replacement = assess(worker.failure_event(event, force_code))
            self._persist(name, batch, index, assessment, metadata, replacement)
            return replacement
        job = self._jobs.get(event.event_id)
        scanned = None
        if job is not None:
            if job.generation != self._generation or job.request['nonce'] != metadata['nonce']:
                raise WorkerError('inspection-generation-invalid')
            if not accept_result or not job.future.done():
                return None
            try:
                scanned = worker.validate_result(job.request, job.future.result(), event)
            except (WorkerError, OSError):
                scanned = worker.failure_event(event, 'inspection-worker-unavailable')
            if scanned.facts.get('inspection_complete') is not True:
                code = str(scanned.facts['inspection_error'])
                if code not in NO_RETRY and metadata['attempts'] < MAX_ATTEMPTS:
                    metadata.update(last_code=code, next_at=time.time() + 4**(metadata['attempts'] - 1))
                    self._persist(name, batch, index, assessment, metadata)
                    del self._jobs[event.event_id]
                    return None
        elif metadata['attempts'] >= MAX_ATTEMPTS:
            if not accept_result:
                return None
            # Recorded third launch without an accepted result after restart:
            # interrupted work is incomplete, not silently issued a fourth time.
            scanned = worker.failure_event(event, metadata['last_code'])
        if scanned is not None:
            replacement = assess(scanned)
            self._persist(name, batch, index, assessment, metadata, replacement)
            self._jobs.pop(event.event_id, None)
            return replacement
        if time.time() < metadata['next_at'] or len(self._jobs) >= 2:
            return None
        if self._pool is None:
            self._pool = worker.new_pool()
        self._pool.tick()
        if not self._pool.available:
            return None
        nonce = secrets.token_hex(16)
        request = worker.request_for(event, self.config, nonce)
        timeout = worker.timeout_for(self.config)
        # This save precedes process launch, so abrupt death consumes the attempt.
        metadata.update(attempts=metadata['attempts'] + 1, nonce=nonce,
                        next_at=time.time() + timeout + 4**metadata['attempts'],
                        last_code='inspection-interrupted')
        self._persist(name, batch, index, assessment, metadata)
        try:
            future = self._pool.submit(request, timeout=timeout)
        except (WorkerError, OSError):
            future = Future()
            future.set_exception(WorkerError('inspection-launch-unavailable'))
        self._jobs[event.event_id] = _Job(future, request, self._generation)
        return None

    def gaps(self) -> dict:
        value = self.state.get_json(GAPS_KEY, {'schema': 1, 'entries': {}, 'overflow': False})
        if (type(value) is not dict or set(value) != {'schema', 'entries', 'overflow'}
                or type(value['schema']) is not int or value['schema'] != 1
                or type(value['entries']) is not dict or len(value['entries']) > MAX_GAPS
                or type(value['overflow']) is not bool):
            raise WorkerError('inspection-gap-state-invalid')
        for key, entry in value['entries'].items():
            if (type(key) is not str or len(key) != 64 or type(entry) is not dict
                    or set(entry) != {'event_id', 'timestamp', 'path', 'code'}
                    or any(type(item) is not str for item in entry.values())
                    or key != self._path_key(entry['path'])):
                raise WorkerError('inspection-gap-state-invalid')
        return value

    @staticmethod
    def _path_key(path: str) -> str:
        # Source paths are canonical. Case normalization matches file_watch on Windows.
        return hashlib.sha256(path.casefold().encode('utf-8')).hexdigest()

    def _update_gap_locked(self, event):
        from .inspection_recovery import record_result_locked
        current_recovery = record_result_locked(self.state, event)
        gaps = self.gaps()
        path = str(event.facts.get('path') or event.subject)
        key = self._path_key(path)
        previous = gaps['entries'].get(key)
        # An older completed lookahead/replayed batch cannot clear a newer gap.
        if previous and previous['timestamp'] > event.timestamp and not current_recovery:
            return
        if event.facts.get('inspection_complete') is True:
            gaps['entries'].pop(key, None)
        elif previous is not None or len(gaps['entries']) < MAX_GAPS:
            gaps['entries'][key] = {'event_id': event.event_id, 'timestamp': event.timestamp,
                                    'path': path, 'code': str(event.facts['inspection_error'])}
        else:
            gaps['overflow'] = True  # Sticky coverage loss; never evict and advertise protected.
        self.state.set_json(GAPS_KEY, gaps)

    def gap_count(self) -> int:
        value = self.gaps()
        return len(value['entries']) + int(value['overflow'])
