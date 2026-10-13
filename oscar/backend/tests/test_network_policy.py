import asyncio
import json
import socket
from pathlib import Path

import httpcore
import httpx
import pytest

from oscar_agent.network_policy import (
    BlockedAddressError,
    PublicOnlyNetworkBackend,
    is_public_address,
    public_async_transport,
)

FIXTURE = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "network-address-policy.json"
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", CASES, ids=[case["address"] or "<empty>" for case in CASES])
def test_shared_address_cases(case):
    assert is_public_address(case["address"]) is case["public"]


class RecordingBackend(httpcore.AsyncNetworkBackend):
    def __init__(self):
        self.connected = []

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        self.connected.append((host, port))
        raise httpcore.ConnectError("recorded")

    async def connect_unix_socket(self, path, timeout=None, socket_options=None):
        raise AssertionError("not used")

    async def sleep(self, seconds):
        return None


def resolver(answers):
    async def getaddrinfo(host, port, type=0, **_):
        return [(socket.AF_INET6 if ":" in item else socket.AF_INET, socket.SOCK_STREAM, 6, "", (item, port))
                for item in answers]
    return getaddrinfo


def run_connect(backend, host, port, answers, monkeypatch):
    async def go():
        monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", resolver(answers))
        return await backend.connect_tcp(host, port, timeout=5)
    return asyncio.run(go())


def test_connects_only_to_the_checked_public_address(monkeypatch):
    inner = RecordingBackend()
    with pytest.raises(httpcore.ConnectError):
        run_connect(PublicOnlyNetworkBackend(inner), "example.test", 443, ["93.184.216.34"], monkeypatch)
    assert inner.connected == [("93.184.216.34", 443)]


@pytest.mark.parametrize("answers", [["127.0.0.1"], ["93.184.216.34", "10.0.0.5"], ["100.64.0.1"], ["::ffff:7f00:1"], []])
def test_refuses_a_name_with_any_non_public_address(monkeypatch, answers):
    inner = RecordingBackend()
    with pytest.raises(BlockedAddressError):
        run_connect(PublicOnlyNetworkBackend(inner), "example.test", 443, answers, monkeypatch)
    assert inner.connected == []


def test_refuses_private_ip_literals_and_unix_sockets():
    inner = RecordingBackend()
    backend = PublicOnlyNetworkBackend(inner)
    with pytest.raises(BlockedAddressError):
        asyncio.run(backend.connect_tcp("127.0.0.1", 80))
    with pytest.raises(BlockedAddressError):
        asyncio.run(backend.connect_unix_socket("/tmp/socket"))
    assert inner.connected == []


def test_http_client_with_public_transport_refuses_loopback():
    async def go():
        async with httpx.AsyncClient(transport=public_async_transport(), timeout=5) as client:
            await client.get("http://127.0.0.1:9/")
    with pytest.raises(httpx.ConnectError):
        asyncio.run(go())
