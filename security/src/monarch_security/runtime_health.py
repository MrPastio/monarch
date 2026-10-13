"""One conservative contract for observation health; never an action authority."""
from __future__ import annotations

import math
from .observation import valid_observation

SENSOR_STATES = frozenset({"healthy", "starting", "failed", "stalled", "overdue", "limited"})
RUNTIME_STATES = frozenset({"starting", "running", "stopping", "stopped"})
POLL_GRACE_SECONDS = 75.0


def finite_number(value: object) -> bool:
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def protection_state(status: str, health: dict, backlog: dict) -> str:
    if not isinstance(status, str) or status not in RUNTIME_STATES:
        return "degraded"
    if status != "running":
        return status
    if not isinstance(health, dict) or not health:
        return 'degraded'
    for name, item in health.items():
        if not isinstance(item, dict) or not isinstance(item.get('state'), str) or item['state'] not in {'healthy', 'starting'}:
            return 'degraded'
        observation = item.get('observation')
        if item['state'] == 'healthy' and not valid_observation(observation):
            return 'degraded'
        if 'observation' in item and (not valid_observation(observation) or observation['status'] != 'complete'):
            return 'degraded'
        if name == 'process_sensor' and item.get('backend') == 'tasklist':
            return 'degraded'
    queued = backlog.get("queued", 0)
    if type(queued) is not int or queued < 0 or queued:
        return "degraded"
    return "starting" if any(item.get("state") == "starting" for item in health.values()) else "protected"


def validate_runtime_health(payload: dict) -> bool:
    started, guardian = payload.get('process_started'), payload.get('guardian')
    if type(started) is not str or not 0 < len(started) <= 128:
        return False
    if guardian is not None and (type(guardian) is not dict
            or set(guardian) != {'pid', 'process_started', 'lease_seconds', 'mechanism'}
            or type(guardian['pid']) is not int or not 0 < guardian['pid'] < 2**32
            or type(guardian['process_started']) is not str or not 0 < len(guardian['process_started']) <= 128
            or type(guardian['lease_seconds']) is not int or guardian['lease_seconds'] != 45
            or type(guardian['mechanism']) is not str or guardian['mechanism'] not in {'owned-job', 'owned-process-group'}):
        return False
    sensors, health = payload.get("sensors"), payload.get("sensor_health")
    if (not isinstance(sensors, list) or len(sensors) > 32
            or any(not isinstance(name, str) or not name or len(name) > 64 for name in sensors)
            or len(set(sensors)) != len(sensors) or not isinstance(health, dict)
            or set(health) != set(sensors) or type(payload.get("sensor_count")) is not int
            or payload["sensor_count"] != len(sensors) or not isinstance(payload.get("status"), str)
            or payload["status"] not in RUNTIME_STATES):
        return False
    for sensor_name, item in health.items():
        if not isinstance(item, dict) or not isinstance(item.get("state"), str) or item["state"] not in SENSOR_STATES:
            return False
        observation = item.get('observation')
        if item['state'] in {'healthy', 'limited'} and not valid_observation(observation):
            return False
        if sensor_name == 'process_sensor' and item.get('backend') == 'tasklist' and item['state'] == 'healthy':
            return False
        if 'observation' in item and (not valid_observation(observation)
                or (item['state'] == 'healthy' and observation['status'] != 'complete')):
            return False
        if item["state"] in {"healthy", "limited"} and not finite_number(item.get("last_success_at")):
            return False
        for name in ("last_success_at", "interval_seconds", "next_check_at", "poll_started_at", "failed_at"):
            if name in item and not finite_number(item[name]):
                return False
        if item["state"] in {"healthy", "limited"}:
            interval = item.get("interval_seconds")
            if not finite_number(interval) or interval <= 0:
                return False
            age = payload["updated_at"] - item["last_success_at"]
            if age < -5 or age > interval + POLL_GRACE_SECONDS:
                return False
    backlog = payload.get("sensor_backlog")
    return isinstance(backlog, dict) and type(backlog.get("queued")) is int and backlog["queued"] >= 0
