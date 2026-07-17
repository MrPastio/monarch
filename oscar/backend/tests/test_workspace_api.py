from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from oscar_agent.config import Settings
from oscar_agent.workspace import WorkspaceService


def make_settings(tmp_path: Path) -> Settings:
    return Settings(
        data_dir=tmp_path / "data",
        db_path=tmp_path / "data" / "memory.sqlite3",
        offload_dir=tmp_path / "offload",
        workspace_root=tmp_path / "workspace",
        workspace_generated_dir=tmp_path / "workspace" / "artifacts" / "generated",
        mock_model=True,
    )


def test_workspace_api_lists_and_reads_generated_artifacts(monkeypatch, tmp_path: Path) -> None:
    import oscar_agent.main as main

    workspace = WorkspaceService(make_settings(tmp_path))
    monkeypatch.setattr(main, "workspace", workspace)
    monkeypatch.setattr(main.settings, "disable_api_token", True)

    written = workspace.write("artifacts/generated/api-note.md", "workspace api ok")
    assert written.ok

    client = TestClient(main.app)
    listed = client.get("/api/workspace/list", params={"path": "artifacts/generated", "recursive": True})
    assert listed.status_code == 200
    listed_body = listed.json()
    assert listed_body["ok"] is True
    names = {entry["name"].replace("\\", "/") for entry in listed_body["entries"]}
    assert "artifacts/generated/api-note.md" in names

    read = client.get("/api/workspace/read", params={"path": "artifacts/generated/api-note.md"})
    assert read.status_code == 200
    read_body = read.json()
    assert read_body["ok"] is True
    assert read_body["content"] == "workspace api ok"


def test_search_query_params_reject_blank_or_oversized_before_services(monkeypatch) -> None:
    import oscar_agent.main as main

    memory_calls: list[tuple[str, int]] = []
    workspace_calls: list[tuple[str, str, int]] = []

    class FakeMemory:
        def search(self, query: str, limit: int = 6):
            memory_calls.append((query, limit))
            return []

        def hits_to_sources(self, hits):
            return []

    class FakeWorkspace:
        def search(self, query: str, path: str = ".", *, limit: int = 40):
            workspace_calls.append((query, path, limit))
            return {"ok": True, "matches": []}

    monkeypatch.setattr(main, "memory", FakeMemory())
    monkeypatch.setattr(main, "workspace", FakeWorkspace())
    monkeypatch.setattr(main.settings, "disable_api_token", True)

    client = TestClient(main.app, raise_server_exceptions=False)

    responses = [
        client.get("/api/memory/search", params={"q": "   \t", "limit": 6}),
        client.get("/api/memory/search", params={"q": "x" * 2049, "limit": 6}),
        client.get("/api/workspace/search", params={"q": "   \t", "path": ".", "limit": 40}),
        client.get("/api/workspace/search", params={"q": "x" * 2049, "path": ".", "limit": 40}),
    ]

    assert [response.status_code for response in responses] == [422, 422, 422, 422]
    assert memory_calls == []
    assert workspace_calls == []


def test_workspace_path_query_params_reject_blank_or_oversized_before_services(monkeypatch) -> None:
    import oscar_agent.main as main

    calls: list[tuple[str, object]] = []

    class FakeWorkspace:
        def read(self, path: str):
            calls.append(("read", path))
            return {"ok": True, "action": "read", "summary": "called"}

        def list(self, path: str = ".", *, recursive: bool = False, limit: int = 80):
            calls.append(("list", (path, recursive, limit)))
            return {"ok": True, "action": "list", "summary": "called", "entries": []}

    monkeypatch.setattr(main, "workspace", FakeWorkspace())
    monkeypatch.setattr(main.settings, "disable_api_token", True)
    client = TestClient(main.app, raise_server_exceptions=False)

    responses = [
        client.get("/api/workspace/read", params={"path": "   \t"}),
        client.get("/api/workspace/read", params={"path": "x" * 2049}),
        client.get("/api/workspace/list", params={"path": "   \t"}),
        client.get("/api/workspace/list", params={"path": "x" * 2049}),
    ]

    assert [response.status_code for response in responses] == [422, 422, 422, 422]
    assert calls == []


def test_workspace_search_reports_missing_path_instead_of_empty_success(monkeypatch, tmp_path: Path) -> None:
    import oscar_agent.main as main

    monkeypatch.setattr(main, "workspace", WorkspaceService(make_settings(tmp_path)))
    monkeypatch.setattr(main.settings, "disable_api_token", True)

    client = TestClient(main.app, raise_server_exceptions=False)

    searched = client.get(
        "/api/workspace/search",
        params={"q": "needle", "path": "missing-folder", "limit": 40},
    )
    action = client.post(
        "/api/workspace/action",
        json={"action": "search", "query": "needle", "path": "missing-folder"},
    )

    assert searched.status_code == 200
    assert action.status_code == 200
    assert searched.json()["ok"] is False
    assert searched.json()["error"] == "not-found"
    assert action.json()["ok"] is False
    assert action.json()["error"] == "not-found"


def test_workspace_action_rejects_oversized_fields_before_service(monkeypatch) -> None:
    import oscar_agent.main as main

    calls: list[tuple[str, object]] = []

    class FakeWorkspace:
        def execute(self, command):
            calls.append(("execute", command))
            return {"ok": True, "action": command.action, "summary": "called"}

        def search(self, query: str, path: str = ".", *, limit: int = 40):
            calls.append(("search", (query, path, limit)))
            return {"ok": True, "action": "search", "summary": "called"}

        def list(self, path: str = ".", *, recursive: bool = False, limit: int = 80):
            calls.append(("list", (path, recursive, limit)))
            return {"ok": True, "action": "list", "summary": "called"}

    monkeypatch.setattr(main, "workspace", FakeWorkspace())
    monkeypatch.setattr(main.settings, "disable_api_token", True)
    client = TestClient(main.app, raise_server_exceptions=False)

    responses = [
        client.post("/api/workspace/action", json={"action": "read", "path": "x" * 2049}),
        client.post("/api/workspace/action", json={"action": "search", "query": "x" * 2049}),
        client.post(
            "/api/workspace/action",
            json={"action": "write", "path": "artifacts/generated/huge.md", "content": "x" * (512 * 1024 + 1)},
        ),
        client.post(
            "/api/workspace/batch",
            json={"actions": [{"action": "copy", "path": "a.md", "target_path": "x" * 2049}]},
        ),
    ]

    assert [response.status_code for response in responses] == [422, 422, 422, 422]
    assert calls == []


def test_workspace_api_blocks_protected_paths(monkeypatch, tmp_path: Path) -> None:
    import oscar_agent.main as main

    monkeypatch.setattr(main, "workspace", WorkspaceService(make_settings(tmp_path)))
    monkeypatch.setattr(main.settings, "disable_api_token", True)

    client = TestClient(main.app)
    response = client.get("/api/workspace/read", params={"path": ".git/config"})
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["error"] == "protected-path"


def test_workspace_action_api_routes_mutations_to_monarch_kernel(monkeypatch, tmp_path: Path) -> None:
    import oscar_agent.main as main

    workspace = WorkspaceService(make_settings(tmp_path))
    monkeypatch.setattr(main, "workspace", workspace)
    monkeypatch.setattr(main.settings, "disable_api_token", True)

    client = TestClient(main.app)
    responses = [
        client.post("/api/workspace/action", json={"action": "write", "path": "artifacts/generated/action.md", "content": "alpha"}),
        client.post("/api/workspace/action", json={"action": "append", "path": "artifacts/generated/action.md", "content": "beta"}),
        client.post("/api/workspace/action", json={"action": "replace", "path": "artifacts/generated/action.md", "old_text": "a", "new_text": "b"}),
    ]

    assert all(response.status_code == 200 for response in responses)
    assert all(response.json()["error"] == "kernel-execution-required" for response in responses)
    assert not (workspace.root / "artifacts" / "generated" / "action.md").exists()


def test_workspace_action_api_move_and_trash_flow(monkeypatch, tmp_path: Path) -> None:
    import oscar_agent.main as main

    workspace = WorkspaceService(make_settings(tmp_path))
    monkeypatch.setattr(main, "workspace", workspace)
    monkeypatch.setattr(main.settings, "disable_api_token", True)
    assert workspace.write("artifacts/generated/move-me.md", "move api").ok

    client = TestClient(main.app)
    moved = client.post(
        "/api/workspace/action",
        json={
            "action": "move",
            "path": "artifacts/generated/move-me.md",
            "target_path": "artifacts/generated/moved.md",
        },
    )
    assert moved.status_code == 200
    moved_body = moved.json()
    assert moved_body["error"] == "kernel-execution-required"
    assert not (workspace.root / "artifacts" / "generated" / "moved.md").exists()

    trashed = client.post(
        "/api/workspace/action",
        json={"action": "trash", "path": "artifacts/generated/moved.md"},
    )
    assert trashed.status_code == 200
    trashed_body = trashed.json()
    assert trashed_body["error"] == "kernel-execution-required"
    assert (workspace.root / "artifacts" / "generated" / "move-me.md").exists()


def test_workspace_action_api_restore_flow(monkeypatch, tmp_path: Path) -> None:
    import oscar_agent.main as main

    workspace = WorkspaceService(make_settings(tmp_path))
    monkeypatch.setattr(main, "workspace", workspace)
    monkeypatch.setattr(main.settings, "disable_api_token", True)
    assert workspace.write("artifacts/generated/restore-api.md", "restore api").ok

    client = TestClient(main.app)
    trashed = client.post(
        "/api/workspace/action",
        json={"action": "trash", "path": "artifacts/generated/restore-api.md"},
    )
    assert trashed.status_code == 200
    assert trashed.json()["error"] == "kernel-execution-required"

    restored = client.post(
        "/api/workspace/action",
        json={"action": "restore", "path": ".oscar-trash/restore-api.md"},
    )
    assert restored.status_code == 200
    restored_body = restored.json()
    assert restored_body["error"] == "kernel-execution-required"
    assert (workspace.root / "artifacts" / "generated" / "restore-api.md").read_text(encoding="utf-8") == "restore api"


def test_workspace_action_api_copy_flow(monkeypatch, tmp_path: Path) -> None:
    import oscar_agent.main as main

    workspace = WorkspaceService(make_settings(tmp_path))
    monkeypatch.setattr(main, "workspace", workspace)
    monkeypatch.setattr(main.settings, "disable_api_token", True)
    assert workspace.write("artifacts/generated/copy-me.md", "copy api").ok

    client = TestClient(main.app)
    copied = client.post(
        "/api/workspace/action",
        json={
            "action": "copy",
            "path": "artifacts/generated/copy-me.md",
            "target_path": "artifacts/generated/copied.md",
        },
    )
    assert copied.status_code == 200
    copied_body = copied.json()
    assert copied_body["error"] == "kernel-execution-required"
    assert (workspace.root / "artifacts" / "generated" / "copy-me.md").read_text(encoding="utf-8") == "copy api"
    assert not (workspace.root / "artifacts" / "generated" / "copied.md").exists()


def test_workspace_action_api_keeps_workspace_boundaries(monkeypatch, tmp_path: Path) -> None:
    import oscar_agent.main as main

    monkeypatch.setattr(main, "workspace", WorkspaceService(make_settings(tmp_path)))
    monkeypatch.setattr(main.settings, "disable_api_token", True)

    client = TestClient(main.app)
    outside = client.post(
        "/api/workspace/action",
        json={"action": "write", "path": str(tmp_path / "outside.md"), "content": "nope"},
    )
    assert outside.status_code == 200
    assert outside.json()["error"] == "kernel-execution-required"

    protected = client.post(
        "/api/workspace/action",
        json={"action": "write", "path": ".git/config", "content": "nope"},
    )
    assert protected.status_code == 200
    assert protected.json()["error"] == "kernel-execution-required"


def test_workspace_batch_api_never_executes_mutations(monkeypatch, tmp_path: Path) -> None:
    import oscar_agent.main as main

    workspace = WorkspaceService(make_settings(tmp_path))
    monkeypatch.setattr(main, "workspace", workspace)
    monkeypatch.setattr(main.settings, "disable_api_token", True)

    client = TestClient(main.app)
    response = client.post(
        "/api/workspace/batch",
        json={
            "actions": [
                {"action": "mkdir", "path": "artifacts/generated/batch"},
                {"action": "write", "path": "artifacts/generated/batch/a.md", "content": "alpha"},
                {"action": "write", "path": "artifacts/generated/batch/b.md", "content": "beta"},
            ]
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert len(body["results"]) == 3
    assert all(result["error"] == "kernel-execution-required" for result in body["results"])
    assert not (workspace.root / "artifacts" / "generated" / "batch").exists()


def test_workspace_batch_api_stop_on_error(monkeypatch, tmp_path: Path) -> None:
    import oscar_agent.main as main

    workspace = WorkspaceService(make_settings(tmp_path))
    monkeypatch.setattr(main, "workspace", workspace)
    monkeypatch.setattr(main.settings, "disable_api_token", True)

    client = TestClient(main.app)
    response = client.post(
        "/api/workspace/batch",
        json={
            "stop_on_error": True,
            "actions": [
                {"action": "write", "path": ".git/config", "content": "nope"},
                {"action": "write", "path": "artifacts/generated/after.md", "content": "skip"},
            ],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert len(body["results"]) == 1
    assert body["results"][0]["error"] == "kernel-execution-required"
    assert not (workspace.root / "artifacts" / "generated" / "after.md").exists()
