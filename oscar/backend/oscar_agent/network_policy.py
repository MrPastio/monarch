"""One public-address policy and a transport that connects only where it checked.

Web content chooses the URLs Oscar fetches, so a URL is checked by the
addresses it actually connects to. Checking a name and then letting the HTTP
client resolve it again would let the second answer differ from the first;
the transport below resolves once, checks every address and connects to a
checked address itself. TLS still verifies the certificate for the original
host name.

The same policy is implemented for TypeScript in
`src/core/network-address-policy.ts`; both are held to the shared cases in
`tests/fixtures/network-address-policy.json`.
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
import typing

import httpcore
import httpx

IPAddress = typing.Union[ipaddress.IPv4Address, ipaddress.IPv6Address]

_BLOCKED_V4 = tuple(ipaddress.ip_network(item) for item in (
    "0.0.0.0/8",        # this network
    "10.0.0.0/8",       # private
    "100.64.0.0/10",    # shared address space (carrier NAT, overlay VPNs)
    "127.0.0.0/8",      # loopback
    "169.254.0.0/16",   # link-local, cloud metadata
    "172.16.0.0/12",    # private
    "192.0.0.0/24",     # protocol assignments
    "192.0.2.0/24",     # documentation
    "192.88.99.0/24",   # 6to4 relay anycast
    "192.168.0.0/16",   # private
    "198.18.0.0/15",    # benchmarking
    "198.51.100.0/24",  # documentation
    "203.0.113.0/24",   # documentation
    "224.0.0.0/4",      # multicast
    "240.0.0.0/4",      # reserved, broadcast
))

_IPV6_GLOBAL_UNICAST = ipaddress.ip_network("2000::/3")
_IPV4_MAPPED = ipaddress.ip_network("::ffff:0:0/96")
_NAT64_WELL_KNOWN = ipaddress.ip_network("64:ff9b::/96")
_SIX_TO_FOUR = ipaddress.ip_network("2002::/16")
_BLOCKED_V6 = tuple(ipaddress.ip_network(item) for item in (
    "2001::/32",        # Teredo: the IPv4 endpoint is hidden
    "2001:db8::/32",    # documentation
    "2001:10::/28",     # deprecated ORCHID
    "2001:20::/28",     # ORCHIDv2
))


def _embedded_v4(address: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    if address in _IPV4_MAPPED or address in _NAT64_WELL_KNOWN:
        return ipaddress.IPv4Address(int(address) & 0xFFFFFFFF)
    if address in _SIX_TO_FOUR:
        return ipaddress.IPv4Address((int(address) >> 80) & 0xFFFFFFFF)
    return None


def is_public_address(value: str | IPAddress) -> bool:
    """True only for an address on the public internet.

    IPv6 is accepted only inside global unicast (2000::/3); an IPv4 address
    carried inside IPv6 is judged as that IPv4 address.
    """
    try:
        address = value if isinstance(value, (ipaddress.IPv4Address, ipaddress.IPv6Address)) \
            else ipaddress.ip_address(str(value).strip().strip("[]").split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        embedded = _embedded_v4(address)
        if embedded is not None:
            return is_public_address(embedded)
        return address in _IPV6_GLOBAL_UNICAST and not any(address in network for network in _BLOCKED_V6)
    return not any(address in network for network in _BLOCKED_V4)


class BlockedAddressError(httpcore.ConnectError):
    """The host resolved to an address outside the public internet."""


class PublicOnlyNetworkBackend(httpcore.AsyncNetworkBackend):
    """Resolves each host once, refuses it if any address is not public and
    connects to the checked addresses only. Unix sockets are refused."""

    def __init__(self, inner: httpcore.AsyncNetworkBackend | None = None) -> None:
        self._inner = inner if inner is not None else httpcore.AnyIOBackend()

    async def _resolve(self, host: str, port: int, timeout: float | None) -> list[str]:
        literal = host.strip("[]")
        try:
            ipaddress.ip_address(literal.split("%", 1)[0])
            candidates = [literal]
        except ValueError:
            loop = asyncio.get_running_loop()
            try:
                infos = await asyncio.wait_for(
                    loop.getaddrinfo(host, port, type=socket.SOCK_STREAM), timeout)
            except (OSError, asyncio.TimeoutError) as exc:
                raise httpcore.ConnectError(f"Name resolution failed for {host}") from exc
            candidates = list(dict.fromkeys(str(info[4][0]) for info in infos))
        if not candidates or not all(is_public_address(item) for item in candidates):
            raise BlockedAddressError(f"{host} does not resolve only to public internet addresses")
        return candidates

    async def connect_tcp(self, host: str, port: int, timeout: float | None = None,
                          local_address: str | None = None,
                          socket_options: typing.Iterable[httpcore.SOCKET_OPTION] | None = None,
                          ) -> httpcore.AsyncNetworkStream:
        last_error: Exception | None = None
        for address in await self._resolve(host, port, timeout):
            try:
                return await self._inner.connect_tcp(address, port, timeout=timeout,
                                                     local_address=local_address,
                                                     socket_options=socket_options)
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as exc:
                last_error = exc
        raise last_error if last_error is not None else httpcore.ConnectError(f"Could not connect to {host}")

    async def connect_unix_socket(self, path: str, timeout: float | None = None,
                                  socket_options: typing.Iterable[httpcore.SOCKET_OPTION] | None = None,
                                  ) -> httpcore.AsyncNetworkStream:
        raise BlockedAddressError("Unix sockets are not public internet targets")

    async def sleep(self, seconds: float) -> None:
        await self._inner.sleep(seconds)


def public_async_transport(*, limits: httpx.Limits | None = None) -> httpx.AsyncHTTPTransport:
    """An httpx transport bound to the public-only backend, without proxies.

    httpx does not take a network backend directly, so the backend is set on
    its connection pool; if that pool ever changes shape this refuses to build
    a transport instead of returning one without the check.
    """
    transport = httpx.AsyncHTTPTransport(limits=limits or httpx.Limits(), trust_env=False)
    pool = getattr(transport, "_pool", None)
    if not isinstance(pool, httpcore.AsyncConnectionPool) or not hasattr(pool, "_network_backend"):
        raise RuntimeError("public-transport-unavailable")
    pool._network_backend = PublicOnlyNetworkBackend(pool._network_backend)
    return transport
