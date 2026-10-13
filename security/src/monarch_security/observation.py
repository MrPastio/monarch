"""Typed completeness of an observation, separate from detection or authority."""
from __future__ import annotations

import re
import json
import math


class ObservationUnavailable(RuntimeError):
    """Only a stable reason code; no OS error text, paths or credentials."""


class ObservedSensor:
    def begin_observation(self):
        self._observation_reasons = set()

    def limit_observation(self, reason: str):
        if not hasattr(self, '_observation_reasons'):
            self.begin_observation()
        self._observation_reasons.add(reason)

    @property
    def observation(self) -> dict:
        reasons = sorted(getattr(self, '_observation_reasons', set()))
        return {'status': 'partial' if reasons else 'complete', 'reasons': reasons}


def valid_observation(value) -> bool:
    if not isinstance(value, dict) or set(value) != {'status', 'reasons'}:
        return False
    status, reasons = value['status'], value['reasons']
    if (not isinstance(status, str) or status not in {'complete', 'partial', 'unavailable'}
            or not isinstance(reasons, list) or len(reasons) > 16
            or any(not isinstance(code, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', code) for code in reasons)
            or len(set(reasons)) != len(reasons)):
        return False
    return not reasons if status == 'complete' else bool(reasons)


def require_complete(sensor: ObservedSensor) -> None:
    observation = getattr(sensor, 'observation', None)
    if getattr(sensor, 'last_error', None) or not valid_observation(observation) or observation['status'] != 'complete':
        raise ObservationUnavailable('baseline-observation-incomplete')


def parse_query_json(output: str):
    """Reject ambiguous/nonfinite OS output before snapshot/baseline use."""
    if len(output.encode('utf-8')) > 8 * 1024 * 1024:
        raise ObservationUnavailable('query-output-too-large')
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate')
            result[key] = value
        return result
    def invalid_constant(value):
        raise ValueError('nonfinite')
    def finite_float(value):
        parsed = float(value)
        if not math.isfinite(parsed):
            raise ValueError('nonfinite')
        return parsed
    try:
        return json.loads(output, object_pairs_hook=pairs, parse_constant=invalid_constant, parse_float=finite_float)
    except (ValueError, RecursionError) as exc:
        raise ObservationUnavailable('query-json-invalid') from exc
