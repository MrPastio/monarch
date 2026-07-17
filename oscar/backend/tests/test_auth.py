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


def test_authenticated_health_keeps_runtime_details(monkeypatch):
    monkeypatch.setattr(
        main_module,
        "settings",
        Settings(api_token="test-token", disable_api_token=False),
    )

    client = TestClient(main_module.app)
    response = client.get("/api/health", headers={"X-Oscar-Token": "test-token"})

    assert response.status_code == 200
    body = response.json()
    assert body["authenticated"] is True
    assert "workspace" in body
    assert "memory" in body
    assert "model" in body


def test_hardware_requires_oscar_token(monkeypatch):
    monkeypatch.setattr(
        main_module,
        "settings",
        Settings(api_token="test-token", disable_api_token=False),
    )

    client = TestClient(main_module.app)
    response = client.get("/api/hardware")

    assert response.status_code == 401
