from __future__ import annotations

from typing import Any
import sys

from monarch_security.events import SecurityEvent

if sys.platform == "win32":
    import winreg
else:
    winreg = None  # type: ignore


UNINSTALL_KEYS = [
    ("HKLM", r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ("HKLM", r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
    ("HKCU", r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
]


class InstallSensor:
    def __init__(
        self,
        include_existing: bool = False,
        initial_seen: set[str] | None = None,
    ) -> None:
        self.include_existing = include_existing
        self._seen: set[str] = set(initial_seen or set())
        self._first_poll = not bool(initial_seen)

    @property
    def seen_ids(self) -> set[str]:
        return set(self._seen)

    def snapshot(self) -> list[dict[str, Any]]:
        if winreg is None:
            return []

        items: list[dict[str, Any]] = []
        for hive_name, key_path in UNINSTALL_KEYS:
            hive = winreg.HKEY_LOCAL_MACHINE if hive_name == "HKLM" else winreg.HKEY_CURRENT_USER
            try:
                with winreg.OpenKey(hive, key_path) as root:
                    count = winreg.QueryInfoKey(root)[0]
                    for index in range(count):
                        try:
                            subkey_name = winreg.EnumKey(root, index)
                            item = self._read_uninstall_item(
                                root, subkey_name, hive_name, key_path
                            )
                        except OSError:
                            continue
                        if item is not None:
                            items.append(item)
            except OSError:
                continue
        return items

    def poll(self) -> list[SecurityEvent]:
        snapshot = self.snapshot()
        current = {str(item["id"]) for item in snapshot}
        new_items = [item for item in snapshot if str(item["id"]) not in self._seen]
        self._seen = current

        if self._first_poll and not self.include_existing:
            self._first_poll = False
            return []

        self._first_poll = False
        return [self._event_from_install(item) for item in new_items]

    def _read_uninstall_item(
        self, root, subkey_name: str, hive_name: str, key_path: str
    ) -> dict[str, Any] | None:
        with winreg.OpenKey(root, subkey_name) as subkey:
            display_name = self._query_string(subkey, "DisplayName")
            if not display_name:
                return None
            publisher = self._query_string(subkey, "Publisher")
            version = self._query_string(subkey, "DisplayVersion")
            install_location = self._query_string(subkey, "InstallLocation")
            install_date = self._query_string(subkey, "InstallDate")
            uninstall = self._query_string(subkey, "UninstallString")
            identity = f"{hive_name}\\{key_path}\\{subkey_name}"
            return {
                "id": identity,
                "name": display_name,
                "publisher": publisher,
                "version": version,
                "install_location": install_location,
                "install_date": install_date,
                "uninstall_string_present": bool(uninstall),
            }

    @staticmethod
    def _query_string(key, name: str) -> str | None:
        try:
            value, _ = winreg.QueryValueEx(key, name)
        except OSError:
            return None
        return str(value).strip() if value is not None else None

    @staticmethod
    def _event_from_install(item: dict[str, Any]) -> SecurityEvent:
        return SecurityEvent(
            kind="software.installed",
            source="install_sensor",
            subject=str(item.get("name") or item.get("id")),
            facts=item,
        )
