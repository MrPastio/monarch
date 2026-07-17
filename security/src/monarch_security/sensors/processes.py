from __future__ import annotations

from collections.abc import Iterable
import csv
import subprocess

from monarch_security.events import SecurityEvent


class ProcessSensor:
    def __init__(self, include_existing: bool = False) -> None:
        self.include_existing = include_existing
        self._seen: set[int] = set()
        self._first_poll = True
        self._psutil = None
        try:
            import psutil  # type: ignore

            self._psutil = psutil
        except Exception:
            self._psutil = None

    @property
    def backend_name(self) -> str:
        return "psutil" if self._psutil is not None else "tasklist"

    def poll(self) -> list[SecurityEvent]:
        snapshot = list(self._snapshot())
        current_pids = {int(item["pid"]) for item in snapshot if item.get("pid") is not None}
        new_items = [item for item in snapshot if int(item.get("pid", -1)) not in self._seen]
        self._seen = current_pids

        if self._first_poll and not self.include_existing:
            self._first_poll = False
            return []

        self._first_poll = False
        if self._psutil is not None:
            self._enrich_new_processes(new_items)
        return [self._event_from_process(item) for item in new_items]

    def _snapshot(self) -> Iterable[dict]:
        if self._psutil is not None:
            yield from self._snapshot_psutil()
        else:
            yield from self._snapshot_tasklist()

    def _snapshot_psutil(self) -> Iterable[dict]:
        assert self._psutil is not None
        for proc in self._psutil.process_iter(["pid", "name"]):
            try:
                info = dict(proc.info)
                yield info
            except (self._psutil.NoSuchProcess, self._psutil.AccessDenied):
                continue

    def _enrich_new_processes(self, items: list[dict]) -> None:
        assert self._psutil is not None
        for item in items:
            pid = item.get("pid")
            if pid is None:
                continue
            try:
                proc = self._psutil.Process(int(pid))
                item.update(proc.as_dict(
                    attrs=["pid", "name", "exe", "username", "ppid", "create_time"],
                    ad_value=None,
                ))
                item["cmdline"] = proc.cmdline()
                parent = proc.parent()
                item["parent_name"] = parent.name() if parent else None
            except (self._psutil.NoSuchProcess, self._psutil.AccessDenied):
                item["cmdline"] = []
                item["parent_name"] = None

    def _snapshot_tasklist(self) -> Iterable[dict]:
        completed = subprocess.run(
            ["tasklist", "/fo", "csv", "/nh"],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        reader = csv.reader(completed.stdout.splitlines())
        for row in reader:
            if len(row) < 2:
                continue
            try:
                pid = int(row[1])
            except ValueError:
                continue
            if row[0].lower() == "tasklist.exe":
                continue
            yield {
                "pid": pid,
                "name": row[0],
                "exe": None,
                "cmdline": [],
                "username": None,
                "ppid": None,
                "parent_name": None,
            }

    @staticmethod
    def _event_from_process(info: dict) -> SecurityEvent:
        subject = str(info.get("exe") or info.get("name") or info.get("pid"))
        return SecurityEvent(
            kind="process.started",
            source="process_sensor",
            subject=subject,
            facts={
                "pid": info.get("pid"),
                "name": info.get("name"),
                "exe": info.get("exe"),
                "cmdline": info.get("cmdline") or [],
                "username": info.get("username"),
                "ppid": info.get("ppid"),
                "parent_name": info.get("parent_name"),
                "create_time": info.get("create_time"),
            },
        )
