from __future__ import annotations

from typing import Any
import ipaddress
import json
import subprocess

from monarch_security.config import NetworkConfig
from monarch_security.events import SecurityEvent


class NetworkSensor:
    def __init__(
        self,
        config: NetworkConfig,
        include_existing: bool = False,
        initial_signatures: dict[str, str] | None = None,
    ) -> None:
        self.config = config
        self.include_existing = include_existing
        self._signatures: dict[str, str] = dict(initial_signatures or {})
        self._first_poll = not bool(initial_signatures)
        self.last_error: str | None = None

    @property
    def signatures(self) -> dict[str, str]:
        return dict(self._signatures)

    def snapshot_signatures(self) -> dict[str, str]:
        return {item["key"]: item["signature"] for item in self.snapshot()}

    def snapshot(self) -> list[dict[str, Any]]:
        self.last_error = None
        native_tcp_items = _native_tcp_items(
            self.config.max_listeners,
            self.config.max_connections,
        )
        parsed, error = _run_powershell_json(
            _network_snapshot_command(self.config, include_tcp=native_tcp_items is None),
            timeout=60,
        )
        if error:
            self.last_error = error
            return []
        snapshot_items = _normalize_items(parsed)
        dns_cache: dict[str, str] = {}
        for item in snapshot_items:
            if item.get("kind") != "dns_cache":
                continue
            ip = str(item.get("ip") or "").strip()
            domain = str(item.get("domain") or "").strip()
            if ip and domain:
                dns_cache[ip] = domain
        items = [item for item in snapshot_items if item.get("kind") != "dns_cache"]
        if native_tcp_items is not None:
            items.extend(native_tcp_items)
        _enrich_process_names(items)
        _enrich_dns_names(items, dns_cache)
        return [_with_signature(item) for item in items]

    def poll(self) -> list[SecurityEvent]:
        snapshot = self.snapshot()
        changed = [
            item
            for item in snapshot
            if self._signatures.get(str(item["key"])) != str(item["signature"])
        ]
        self._signatures = {str(item["key"]): str(item["signature"]) for item in snapshot}

        if self._first_poll and not self.include_existing:
            self._first_poll = False
            return []

        self._first_poll = False
        return [self._event_from_item(item) for item in changed]

    @staticmethod
    def _event_from_item(item: dict[str, Any]) -> SecurityEvent:
        kind = {
            "config": "network.config_changed",
            "neighbor": "network.neighbor_seen",
            "listener": "network.listener_seen",
            "connection": "network.connection_seen",
        }.get(str(item.get("kind")), "network.observed")
        facts = {key: value for key, value in item.items() if key not in {"signature"}}
        return SecurityEvent(
            kind=kind,
            source="network_sensor",
            subject=str(item.get("subject") or item.get("key")),
            facts=facts,
        )


def _network_config_command() -> str:
    return r"""
Get-NetIPConfiguration |
ForEach-Object {
  [pscustomobject]@{
    kind = 'config'
    subject = $_.InterfaceAlias
    interface_alias = $_.InterfaceAlias
    ipv4 = @($_.IPv4Address | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" })
    ipv6 = @($_.IPv6Address | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" })
    dns = @($_.DNSServer.ServerAddresses)
    gateway = @($_.IPv4DefaultGateway.NextHop)
  }
}
"""


def _neighbors_command(max_neighbors: int) -> str:
    max_items = max(1, int(max_neighbors))
    return rf"""
Get-NetNeighbor -ErrorAction SilentlyContinue |
Where-Object {{
  $_.IPAddress -and
  $_.LinkLayerAddress -and
  $_.LinkLayerAddress -ne '00-00-00-00-00-00' -and
  @('Permanent','Unreachable') -notcontains [string]$_.State
}} |
Select-Object -First {max_items} |
ForEach-Object {{
  [pscustomobject]@{{
    kind = 'neighbor'
    subject = $_.IPAddress
    interface_alias = $_.InterfaceAlias
    ip_address = $_.IPAddress
    link_layer_address = $_.LinkLayerAddress
    state = [string]$_.State
  }}
}}
"""


def _listeners_command(max_listeners: int) -> str:
    max_items = max(1, int(max_listeners))
    return rf"""
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
Select-Object -First {max_items} |
ForEach-Object {{
  [pscustomobject]@{{
    kind = 'listener'
    subject = "$($_.LocalAddress):$($_.LocalPort)"
    protocol = 'tcp'
    local_address = $_.LocalAddress
    local_port = $_.LocalPort
    owning_process = $_.OwningProcess
  }}
}}
"""


def _connections_command(max_connections: int) -> str:
    max_items = max(1, int(max_connections))
    return rf"""
Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
Select-Object -First {max_items} |
ForEach-Object {{
  [pscustomobject]@{{
    kind = 'connection'
    subject = "$($_.RemoteAddress):$($_.RemotePort)"
    protocol = 'tcp'
    local_address = $_.LocalAddress
    local_port = $_.LocalPort
    remote_address = $_.RemoteAddress
    remote_port = $_.RemotePort
    owning_process = $_.OwningProcess
  }}
}}
"""


def _dns_cache_command() -> str:
    return r"""
Get-DnsClientCache -ErrorAction SilentlyContinue |
Where-Object { $_.Data -match '\d+\.\d+\.\d+\.\d+' -or $_.Data -match ':' } |
ForEach-Object {
  [pscustomobject]@{
    kind = 'dns_cache'
    domain = $_.Entry
    ip = $_.Data
  }
}
"""


def _network_snapshot_command(config: NetworkConfig, *, include_tcp: bool = True) -> str:
    pipelines = [
        _network_config_command(),
        _neighbors_command(config.max_neighbors),
        _dns_cache_command(),
    ]
    if include_tcp:
        pipelines.extend((
            _listeners_command(config.max_listeners),
            _connections_command(config.max_connections),
        ))
    return "& {\n" + "\n".join(pipelines) + "\n} | ConvertTo-Json -Depth 5 -Compress"


def _native_tcp_items(max_listeners: int, max_connections: int) -> list[dict[str, Any]] | None:
    try:
        import psutil  # type: ignore

        connections = psutil.net_connections(kind="tcp")
    except Exception:
        return None

    listeners: list[dict[str, Any]] = []
    established: list[dict[str, Any]] = []
    for connection in connections:
        status = str(connection.status or "").upper()
        local_address, local_port = _socket_address_parts(connection.laddr)
        remote_address, remote_port = _socket_address_parts(connection.raddr)
        pid = connection.pid
        if status == "LISTEN" and len(listeners) < max(1, int(max_listeners)):
            listeners.append({
                "kind": "listener",
                "subject": f"{local_address}:{local_port}",
                "protocol": "tcp",
                "local_address": local_address,
                "local_port": local_port,
                "owning_process": pid,
            })
        elif status == "ESTABLISHED" and len(established) < max(1, int(max_connections)):
            established.append({
                "kind": "connection",
                "subject": f"{remote_address}:{remote_port}",
                "protocol": "tcp",
                "local_address": local_address,
                "local_port": local_port,
                "remote_address": remote_address,
                "remote_port": remote_port,
                "owning_process": pid,
            })
    return listeners + established


def _socket_address_parts(address: Any) -> tuple[str, int]:
    if not address:
        return "", 0
    ip = getattr(address, "ip", None)
    port = getattr(address, "port", None)
    if ip is None and isinstance(address, tuple):
        ip = address[0] if address else ""
        port = address[1] if len(address) > 1 else 0
    try:
        normalized_port = int(port or 0)
    except (TypeError, ValueError):
        normalized_port = 0
    return str(ip or ""), normalized_port


def _run_powershell_json(command: str, timeout: int = 30) -> tuple[Any, str | None]:
    utf8_command = (
        "$OutputEncoding = [Console]::OutputEncoding = "
        "[System.Text.UTF8Encoding]::new($false);\n" + command
    )
    try:
        completed = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                utf8_command,
            ],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired:
        return None, "network PowerShell command timed out"
    if completed.returncode != 0:
        return None, completed.stderr.strip() or "network PowerShell command failed"
    output = completed.stdout.strip()
    if not output:
        return [], None
    try:
        return json.loads(output), None
    except json.JSONDecodeError as exc:
        return None, f"network PowerShell returned invalid JSON: {exc}"


def _normalize_items(parsed: Any) -> list[dict[str, Any]]:
    if parsed is None:
        return []
    if isinstance(parsed, dict):
        parsed = [parsed]
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, dict)]


def _with_signature(item: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(item)
    kind = str(normalized.get("kind") or "unknown")
    if kind == "config":
        key = "config:" + str(normalized.get("interface_alias"))
        normalized["ipv4"] = list(_as_sorted_tuple(normalized.get("ipv4")))
        normalized["ipv6"] = list(_as_sorted_tuple(normalized.get("ipv6")))
        normalized["dns"] = list(_as_sorted_tuple(normalized.get("dns")))
        normalized["gateway"] = list(_as_sorted_tuple(normalized.get("gateway")))
        signature_fields = {
            "ipv4": normalized["ipv4"],
            "ipv6": normalized["ipv6"],
            "dns": normalized["dns"],
            "gateway": normalized["gateway"],
        }
        normalized["dns_scopes"] = [_ip_scope(address) for address in normalized["dns"]]
        normalized["gateway_scopes"] = [_ip_scope(address) for address in normalized["gateway"]]
        normalized["dns_public_count"] = sum(1 for scope in normalized["dns_scopes"] if scope == "public")
    elif kind == "neighbor":
        key = (
            f"neighbor:{normalized.get('interface_alias')}:"
            f"{normalized.get('ip_address')}:{normalized.get('link_layer_address')}"
        )
        signature_fields = {
            "state": normalized.get("state"),
            "link_layer_address": normalized.get("link_layer_address"),
        }
        normalized["ip_scope"] = _ip_scope(normalized.get("ip_address"))
    elif kind == "listener":
        key = (
            f"listener:{normalized.get('local_address')}:"
            f"{normalized.get('local_port')}:{normalized.get('owning_process')}"
        )
        signature_fields = {
            "local_address": normalized.get("local_address"),
            "local_port": normalized.get("local_port"),
            "owning_process": normalized.get("owning_process"),
        }
        normalized["local_scope"] = _ip_scope(normalized.get("local_address"))
        normalized["exposed_on_all_interfaces"] = str(normalized.get("local_address") or "") in {
            "0.0.0.0",
            "::",
            "[::]",
        }
    else:
        key = (
            f"connection:{normalized.get('remote_address')}:"
            f"{normalized.get('remote_port')}:{normalized.get('owning_process')}"
        )
        signature_fields = {
            "remote_address": normalized.get("remote_address"),
            "remote_port": normalized.get("remote_port"),
            "owning_process": normalized.get("owning_process"),
        }
        normalized["local_scope"] = _ip_scope(normalized.get("local_address"))
        normalized["remote_scope"] = _ip_scope(normalized.get("remote_address"))
        normalized["remote_is_public"] = normalized["remote_scope"] == "public"
    normalized["key"] = key.lower()
    normalized["signature"] = json.dumps(signature_fields, ensure_ascii=True, sort_keys=True)
    return normalized


def _as_sorted_tuple(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,)
    if isinstance(value, list):
        return tuple(sorted(str(item) for item in value if item is not None))
    return (str(value),)


def _ip_scope(value: Any) -> str:
    text = str(value or "").strip().strip("[]")
    if not text:
        return "unknown"
    try:
        ip = ipaddress.ip_address(text.split("%", 1)[0])
    except ValueError:
        return "unknown"
    if ip.is_unspecified:
        return "unspecified"
    if ip.is_loopback:
        return "loopback"
    if ip.is_link_local:
        return "link_local"
    if ip.is_multicast:
        return "multicast"
    if ip.is_private:
        return "private"
    if ip.is_global:
        return "public"
    if ip.is_reserved:
        return "reserved"
    return "other"


def _enrich_process_names(items: list[dict[str, Any]]) -> None:
    pids = {
        int(item["owning_process"])
        for item in items
        if str(item.get("owning_process") or "").isdigit()
    }
    if not pids:
        return
    try:
        import psutil  # type: ignore
    except Exception:
        return
    details: dict[int, dict[str, Any]] = {}
    for pid in pids:
        try:
            process = psutil.Process(pid)
            # Command lines frequently contain session tokens, API keys, and
            # other secrets. Network telemetry only needs process identity.
            info = process.as_dict(attrs=["name", "exe", "create_time"], ad_value=None)
            lineage = _bounded_process_lineage(process, psutil)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        details[pid] = {
            "process_name": info.get("name"),
            "process_exe": info.get("exe"),
            "process_start_time": info.get("create_time"),
            "process_parent_name": lineage[0]["name"] if lineage else None,
            "process_parent_exe": lineage[0]["exe"] if lineage else None,
            "process_ancestor_names": [entry["name"] for entry in lineage],
            "process_ancestor_exes": [entry["exe"] for entry in lineage],
        }
    for item in items:
        pid_value = item.get("owning_process")
        if str(pid_value or "").isdigit():
            item.update(details.get(int(pid_value), {}))


def _bounded_process_lineage(process, psutil, *, limit: int = 4) -> list[dict[str, str | None]]:
    lineage: list[dict[str, str | None]] = []
    try:
        current = process.parent()
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return lineage
    while current is not None and len(lineage) < max(1, min(8, int(limit))):
        try:
            lineage.append({
                "name": current.name(),
                "exe": current.exe(),
            })
            parent_fn = getattr(current, "parent", None)
            current = parent_fn() if callable(parent_fn) else None
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            break
    return lineage

def _enrich_dns_names(items: list[dict[str, Any]], cache: dict[str, str]) -> None:
    if not cache:
        return
    for item in items:
        if str(item.get("kind")) == "connection":
            remote_ip = str(item.get("remote_address", ""))
            if remote_ip in cache:
                item["remote_domain"] = cache[remote_ip]
