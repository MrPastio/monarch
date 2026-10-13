import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pathlib import Path
import sys

backend_dir = Path(__file__).resolve().parents[1]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from oscar_agent.config import Settings
from oscar_agent import main as main_module


@pytest.mark.asyncio
async def test_verify_token_fails_closed_without_configured_token(monkeypatch):
    monkeypatch.setattr(
        main_module,
        "settings",
        Settings(api_token=None, disable_api_token=False),
    )

    with pytest.raises(HTTPException) as exc:
        await main_module.verify_token()

    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_verify_token_dev_bypass_requires_explicit_flag(monkeypatch):
    monkeypatch.setattr(
        main_module,
        "settings",
        Settings(api_token=None, disable_api_token=True),
    )

    await main_module.verify_token()


def test_cors_default_allows_local_frontend_origin():
    client = TestClient(main_module.app)
    response = client.options(
        "/api/health",
        headers={
            "Origin": "http://127.0.0.1:5173",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"


def test_cors_default_rejects_external_origin():
    client = TestClient(main_module.app)
    response = client.options(
        "/api/health",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers


def test_settings_default_cors_does_not_use_wildcard():
    settings = Settings()

    assert "*" not in settings.cors_origins
    assert "http://127.0.0.1:5173" in settings.cors_origins
    assert "http://oscar.local" in settings.cors_origins


def test_public_health_does_not_expose_sensitive_runtime_details(monkeypatch):
    monkeypatch.setattr(
        main_module,
        "settings",
        Settings(api_token="test-token", disable_api_token=False),
    )

    client = TestClient(main_module.app)
    response = client.get("/api/health")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["authenticated"] is False
    assert "workspace" not in body
    assert "memory" not in body
    assert "model" not in body
    assert "mock_model" not in body
    assert "lifecycle" not in body


def test_authenticated_health_keeps_runtime_details(monkeypatch):
    monkeypatch.setattr(
        main_module,
        "settings",
        Settings(
            api_token="test-token",
            disable_api_token=False,
            auto_unload_after_generation=False,
            recycle_backend_after_generation=False,
        ),
    )

    # No generation has finished in this process as far as this test is
    # concerned, so there is no residency decision to report.
    monkeypatch.setattr(main_module, "_last_residency_decision", None)

    client = TestClient(main_module.app)
    response = client.get("/api/health", headers={"X-Oscar-Token": "test-token"})

    assert response.status_code == 200
    body = response.json()
    assert body["authenticated"] is True
    assert "workspace" in body
    assert "memory" in body
    assert "model" in body
    assert body["lifecycle"] == {
        "process_id": main_module.os.getpid(),
        "parent_process_id": main_module.os.getppid(),
        "host_generation": main_module._backend_host_generation,
        "auto_unload_after_generation": False,
        "recycle_backend_after_generation": False,
        "recycle_scheduled": False,
        "active_inference_slots": 0,
        "model_resident_idle_seconds": 900.0,
        "residency": None,
    }


def test_hardware_requires_oscar_token(monkeypatch):
    monkeypatch.setattr(
        main_module,
        "settings",
        Settings(api_token="test-token", disable_api_token=False),
    )

    client = TestClient(main_module.app)
    response = client.get("/api/hardware")

    assert response.status_code == 401


def test_backend_stop_requires_auth_and_returns_a_token_free_correlation_receipt(monkeypatch):
    monkeypatch.setattr(main_module, "settings", Settings(api_token="test-token", disable_api_token=False))
    monkeypatch.setattr(main_module, "_backend_stop_receipt", None)
    calls = []

    class Timer:
        def __init__(self, delay, callback):
            self.delay = delay
            self.callback = callback

        def start(self):
            calls.append(self.delay)

    monkeypatch.setattr(main_module.threading, "Timer", Timer)
    client = TestClient(main_module.app)
    denied = client.post("/api/backend/stop", headers={"X-Monarch-Stop-Correlation": "x" * 16})
    assert denied.status_code == 401
    binding = {"X-Monarch-Expected-Host-Generation": main_module._backend_host_generation,
               "X-Monarch-Expected-Pid": str(main_module.os.getpid())}
    stale = client.post("/api/backend/stop", headers={"X-Oscar-Token": "test-token",
        "X-Monarch-Stop-Correlation": "correlation_fixture_stale", **binding,
        "X-Monarch-Expected-Pid": str(main_module.os.getpid() + 1)})
    assert stale.status_code == 409
    assert stale.json()["detail"] == {"code": "backend-stop-stale-process", "staleProcess": True,
        "expectedHostGeneration": main_module._backend_host_generation, "targetPid": main_module.os.getpid() + 1}
    response = client.post("/api/backend/stop", headers={"X-Oscar-Token": "test-token",
        "X-Monarch-Stop-Correlation": "correlation_fixture_20260920", **binding})
    assert response.status_code == 200
    body = response.json()
    assert body == {"ok": True, "stopping": True, "correlation": "correlation_fixture_20260920",
                    "pid": main_module.os.getpid(), "hostGeneration": main_module._backend_host_generation,
                    "activeInferenceSlots": 0, "tokenSource": "authenticated-header", "staleProcess": False}
    repeated = client.post("/api/backend/stop", headers={"X-Oscar-Token": "test-token",
        "X-Monarch-Stop-Correlation": "correlation_fixture_20260920", **binding})
    assert repeated.status_code == 200
    assert repeated.json() == body
    assert calls == [0.25]
