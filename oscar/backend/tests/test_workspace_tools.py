from pathlib import Path
import os
import subprocess
import sys

import pytest

from oscar_agent.config import Settings
from oscar_agent.memory import MemoryStore, detect_memory_note, should_use_memory
from oscar_agent.workspace import (
    WorkspaceService,
    detect_incomplete_workspace_command,
    detect_workspace_command,
    detect_workspace_commands,
)


def make_settings(tmp_path: Path) -> Settings:
    return Settings(
        data_dir=tmp_path / "data",
        db_path=tmp_path / "data" / "memory.sqlite3",
        offload_dir=tmp_path / "offload",
        workspace_root=tmp_path / "workspace",
        workspace_generated_dir=tmp_path / "workspace" / "artifacts" / "generated",
        mock_model=True,
    )


def test_workspace_write_read_search_flow(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)

    command = detect_workspace_command('Создай файл artifacts/generated/check.md с текстом "Monarch tool smoke"')
    assert command is not None
    written = service.execute(command)

    assert written.ok
    assert written.path
    assert Path(written.path).read_text(encoding="utf-8") == "Monarch tool smoke"

    read = service.execute(detect_workspace_command("прочитай файл artifacts/generated/check.md"))  # type: ignore[arg-type]
    assert read.ok
    assert read.content == "Monarch tool smoke"

    found = service.execute(detect_workspace_command("найди в файлах Monarch"))  # type: ignore[arg-type]
    assert found.ok
    assert found.matches


def test_workspace_detector_accepts_bare_write_path_forms(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)

    samples = [
        ("создай artifacts/generated/bare-ru.md с текстом привет", "artifacts/generated/bare-ru.md", "привет"),
        ("create artifacts/generated/bare-en.md with text hello", "artifacts/generated/bare-en.md", "hello"),
        ("write hello to artifacts/generated/write-to.md", "artifacts/generated/write-to.md", "hello"),
        ("запиши в artifacts/generated/write-in.md текст готово", "artifacts/generated/write-in.md", "готово"),
        ("сохрани заметку в artifacts/generated/save-to.md", "artifacts/generated/save-to.md", "заметку"),
    ]

    for prompt, path, expected_content in samples:
        command = detect_workspace_command(prompt)
        assert command is not None, prompt
        assert command.action == "write"
        assert command.path == path
        written = service.execute(command)
        assert written.ok, prompt
        assert (settings.workspace_root / path).read_text(encoding="utf-8") == expected_content


def test_workspace_detector_accepts_bare_paths_for_read_list_and_search(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)
    assert service.mkdir("artifacts/generated/bare").ok
    assert service.write("artifacts/generated/bare/readme.md", "Bare Monarch note").ok

    read_command = detect_workspace_command("прочитай artifacts/generated/bare/readme.md")
    assert read_command is not None
    assert read_command.action == "read"
    read = service.execute(read_command)
    assert read.ok
    assert read.content == "Bare Monarch note"

    list_command = detect_workspace_command("покажи artifacts/generated/bare")
    assert list_command is not None
    assert list_command.action == "list"
    listed = service.execute(list_command)
    assert listed.ok
    assert [entry.name.replace("\\", "/") for entry in listed.entries] == ["artifacts/generated/bare/readme.md"]

    search_command = detect_workspace_command("найди Monarch в artifacts/generated/bare")
    assert search_command is not None
    assert search_command.action == "search"
    assert search_command.path == "artifacts/generated/bare"
    assert search_command.query == "Monarch"
    found = service.execute(search_command)
    assert found.ok
    assert found.matches


def test_workspace_detector_understands_folder_contents_and_standalone_windows_paths() -> None:
    described = detect_workspace_command('Содержание папки по этому пути "E:\\Monarch\\src\\modules\\workspace"')
    assert described is not None
    assert described.action == "list"
    assert described.path == "E:\\Monarch\\src\\modules\\workspace"

    standalone = detect_workspace_command('"E:\\Monarch\\src\\modules\\workspace"')
    assert standalone is not None
    assert standalone.action == "list"
    assert standalone.path == "E:\\Monarch\\src\\modules\\workspace"


def test_workspace_allows_local_read_roots_and_desktop_mkdir_but_not_file_writes(tmp_path: Path, monkeypatch) -> None:
    user_home = tmp_path / "user-home"
    desktop = user_home / "Desktop"
    desktop.mkdir(parents=True)
    (desktop / "visible.txt").write_text("desktop data", encoding="utf-8")
    random_outside = tmp_path / "outside"
    random_outside.mkdir()
    (random_outside / "secret.txt").write_text("outside data", encoding="utf-8")
    monkeypatch.setenv("USERPROFILE", str(user_home))
    monkeypatch.setenv("HOME", str(user_home))
    monkeypatch.setenv("MONARCH_DESKTOP_DIR", str(desktop))

    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)

    command = detect_workspace_command("Перечисли файлы на рабочем столе")
    assert command is not None
    assert command.action == "list"
    assert Path(command.path) == desktop

    listed = service.execute(command)
    assert listed.ok
    assert [entry.name for entry in listed.entries] == ["visible.txt"]

    mkdir_command = detect_workspace_command("создай новую папку на рабочем столе")
    assert mkdir_command is not None
    assert mkdir_command.action == "mkdir"
    assert Path(mkdir_command.path) == desktop / "Новая папка"
    assert mkdir_command.ensure_unique
    created_dir = service.execute(mkdir_command)
    assert created_dir.ok
    assert (desktop / "Новая папка").is_dir()

    named_mkdir_command = detect_workspace_command("создай папку demo на рабочем столе")
    assert named_mkdir_command is not None
    assert named_mkdir_command.action == "mkdir"
    assert Path(named_mkdir_command.path) == desktop / "demo"
    assert not named_mkdir_command.ensure_unique
    named_dir = service.execute(named_mkdir_command)
    assert named_dir.ok
    assert (desktop / "demo").is_dir()

    working_mkdir_command = detect_workspace_command("создай рабочую папку на столе")
    assert working_mkdir_command is not None
    assert working_mkdir_command.action == "mkdir"
    assert Path(working_mkdir_command.path) == desktop / "Рабочая папка"
    assert not working_mkdir_command.ensure_unique
    working_dir = service.execute(working_mkdir_command)
    assert working_dir.ok
    assert (desktop / "Рабочая папка").is_dir()

    read = service.read(str(desktop / "visible.txt"))
    assert read.ok
    assert read.content == "desktop data"

    copied = service.copy(str(desktop / "visible.txt"), "copied-from-desktop.txt")
    assert copied.ok
    assert (settings.workspace_root / "copied-from-desktop.txt").read_text(encoding="utf-8") == "desktop data"

    blocked_write = service.write(str(desktop / "new.txt"), "nope")
    assert not blocked_write.ok
    assert blocked_write.error == "read-only-local-root"

    blocked_copy_target = service.copy("copied-from-desktop.txt", str(desktop / "copied-back.txt"))
    assert not blocked_copy_target.ok
    assert blocked_copy_target.error == "read-only-local-root"

    blocked_random = service.read(str(random_outside / "secret.txt"))
    assert not blocked_random.ok
    assert blocked_random.error == "outside-workspace"


def test_workspace_detector_routes_folder_listing_phrase_from_chat_history(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)
    (settings.workspace_root / "alpha").mkdir(parents=True)
    (settings.workspace_root / "beta").mkdir()
    (settings.workspace_root / "note.txt").write_text("not a folder", encoding="utf-8")

    command = detect_workspace_command("Просмотри какие названия папок в твоей корневой папке")

    assert command is not None
    assert command.action == "list"
    assert command.path == "."
    assert command.entry_type == "directory"
    result = service.execute(command)
    assert result.ok
    names = [entry.name for entry in result.entries]
    assert "alpha" in names
    assert "beta" in names
    assert "note.txt" not in names


def test_workspace_detector_accepts_explicit_capability_envelope_from_chat_history() -> None:
    command = detect_workspace_command(
        '{"capability":"workspace.files.list","parameters":{"path":"E:\\\\Monarch\\\\src"}}'
    )

    assert command is not None
    assert command.action == "list"
    assert command.path == "E:\\Monarch\\src"


def test_workspace_append_and_mkdir_flow(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)

    mkdir_command = detect_workspace_command("создай папку artifacts/generated/session")
    assert mkdir_command is not None
    created_dir = service.execute(mkdir_command)
    assert created_dir.ok
    assert created_dir.path
    assert Path(created_dir.path).is_dir()

    service.write("artifacts/generated/session/log.md", "first")
    append_command = detect_workspace_command('допиши файл artifacts/generated/session/log.md с текстом "second"')
    assert append_command is not None
    appended = service.execute(append_command)
    assert appended.ok
    assert Path(appended.path or "").read_text(encoding="utf-8") == "first\nsecond"


def test_workspace_detector_does_not_use_placeholder_as_directory_name(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)

    command = detect_workspace_command("создай новую папку название придумай сам")

    assert command is not None
    assert command.action == "mkdir"
    assert command.path == "Новая папка"
    assert command.ensure_unique
    created = service.execute(command)
    assert created.ok
    assert (settings.workspace_root / "Новая папка").is_dir()
    assert not (settings.workspace_root / "название").exists()


def test_workspace_replace_flow(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)
    written = service.write("artifacts/generated/edit.md", "hello old value")
    assert written.ok

    command = detect_workspace_command('замени в файле artifacts/generated/edit.md "old" на "new"')
    assert command is not None
    replaced = service.execute(command)

    assert replaced.ok
    assert replaced.action == "replace"
    assert Path(replaced.path or "").read_text(encoding="utf-8") == "hello new value"


def test_workspace_replace_requires_unique_old_text(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)
    written = service.write("artifacts/generated/edit.md", "same same")
    assert written.ok

    command = detect_workspace_command('замени в файле artifacts/generated/edit.md "same" на "other"')
    assert command is not None
    replaced = service.execute(command)

    assert not replaced.ok
    assert replaced.error == "ambiguous-old-text"
    assert Path(written.path or "").read_text(encoding="utf-8") == "same same"


def test_workspace_move_and_trash_flow(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)
    written = service.write("artifacts/generated/move-source.md", "move me")
    assert written.ok

    moved = service.execute(
        detect_workspace_command("перемести файл artifacts/generated/move-source.md в artifacts/generated/move-target.md")  # type: ignore[arg-type]
    )
    assert moved.ok
    assert moved.action == "move"
    assert not (settings.workspace_root / "artifacts" / "generated" / "move-source.md").exists()
    assert (settings.workspace_root / "artifacts" / "generated" / "move-target.md").read_text(encoding="utf-8") == "move me"

    trashed = service.execute(
        detect_workspace_command("удали файл artifacts/generated/move-target.md")  # type: ignore[arg-type]
    )
    assert trashed.ok
    assert trashed.action == "trash"
    assert not (settings.workspace_root / "artifacts" / "generated" / "move-target.md").exists()
    assert trashed.path
    trash_path = Path(trashed.path)
    assert ".oscar-trash" in trash_path.parts
    assert trash_path.read_text(encoding="utf-8") == "move me"


def test_workspace_trash_restore_flow(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)
    assert service.write("artifacts/generated/restore-me.md", "restore me").ok

    trashed = service.trash("artifacts/generated/restore-me.md")
    assert trashed.ok
    assert trashed.path

    restored = service.execute(
        detect_workspace_command(f"восстанови файл {trashed.path}")  # type: ignore[arg-type]
    )
    assert restored.ok
    assert restored.action == "restore"
    assert (settings.workspace_root / "artifacts" / "generated" / "restore-me.md").read_text(encoding="utf-8") == "restore me"
    assert not Path(trashed.path).exists()


def test_workspace_restore_to_custom_target_and_blocks_existing_target(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)
    assert service.write("artifacts/generated/restore-source.md", "restore custom").ok
    trashed = service.trash("artifacts/generated/restore-source.md")
    assert trashed.ok
    assert trashed.path

    restored = service.restore(trashed.path, "artifacts/generated/restored-custom.md")
    assert restored.ok
    assert (settings.workspace_root / "artifacts" / "generated" / "restored-custom.md").read_text(encoding="utf-8") == "restore custom"

    assert service.write("artifacts/generated/existing.md", "existing").ok
    trashed_again = service.trash("artifacts/generated/restored-custom.md")
    assert trashed_again.ok
    assert trashed_again.path
    blocked = service.restore(trashed_again.path, "artifacts/generated/existing.md")
    assert not blocked.ok
    assert blocked.error == "target-exists"


def test_workspace_copy_file_and_folder_flow(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)
    assert service.write("artifacts/generated/copy-source.md", "copy me").ok
    assert service.mkdir("artifacts/generated/copy-folder").ok
    assert service.write("artifacts/generated/copy-folder/nested.md", "nested").ok

    copied_file = service.execute(
        detect_workspace_command("скопируй файл artifacts/generated/copy-source.md в artifacts/generated/copy-target.md")  # type: ignore[arg-type]
    )
    assert copied_file.ok
    assert copied_file.action == "copy"
    assert (settings.workspace_root / "artifacts" / "generated" / "copy-source.md").read_text(encoding="utf-8") == "copy me"
    assert (settings.workspace_root / "artifacts" / "generated" / "copy-target.md").read_text(encoding="utf-8") == "copy me"

    copied_folder = service.execute(
        detect_workspace_command("скопируй папку artifacts/generated/copy-folder в artifacts/generated/copy-folder-clone")  # type: ignore[arg-type]
    )
    assert copied_folder.ok
    assert (settings.workspace_root / "artifacts" / "generated" / "copy-folder" / "nested.md").read_text(encoding="utf-8") == "nested"
    assert (settings.workspace_root / "artifacts" / "generated" / "copy-folder-clone" / "nested.md").read_text(encoding="utf-8") == "nested"


def test_workspace_move_blocks_existing_target_and_protected_paths(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)
    assert service.write("artifacts/generated/source.md", "source").ok
    assert service.write("artifacts/generated/target.md", "target").ok

    existing = service.move("artifacts/generated/source.md", "artifacts/generated/target.md")
    assert not existing.ok
    assert existing.error == "target-exists"

    protected = service.trash(".git/config")
    assert not protected.ok
    assert protected.error == "protected-path"


def test_workspace_copy_blocks_existing_target_and_protected_children(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)
    assert service.write("artifacts/generated/source.md", "source").ok
    assert service.write("artifacts/generated/target.md", "target").ok

    existing = service.copy("artifacts/generated/source.md", "artifacts/generated/target.md")
    assert not existing.ok
    assert existing.error == "target-exists"

    protected_dir = settings.workspace_root / "artifacts" / "generated" / "unsafe" / ".git"
    protected_dir.mkdir(parents=True)
    (protected_dir / "config").write_text("hidden", encoding="utf-8")
    protected_child = service.copy("artifacts/generated/unsafe", "artifacts/generated/unsafe-copy")
    assert not protected_child.ok
    assert protected_child.error == "protected-child-path"


def test_workspace_recursive_operations_do_not_follow_link_escapes(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("outside junction needle", encoding="utf-8")
    container = settings.workspace_root / "artifacts" / "generated" / "links"
    container.mkdir(parents=True)
    link_path = container / "outside-link"
    make_directory_link_or_skip(link_path, outside)

    found = service.search("junction needle", "artifacts/generated")
    listed = service.list("artifacts/generated", recursive=True)
    copied = service.copy("artifacts/generated/links", "artifacts/generated/links-copy")

    assert found.ok
    assert found.matches == []
    assert listed.ok
    assert all("outside-link" not in entry.path for entry in listed.entries)
    assert not copied.ok
    assert copied.error == "protected-child-path"
    assert not (settings.workspace_root / "artifacts" / "generated" / "links-copy").exists()


def test_workspace_blocks_red_zone_files_in_direct_and_recursive_operations(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)
    (settings.workspace_root / ".env").write_text("PY_REDZONE_SECRET=hidden", encoding="utf-8")
    secret_dir = settings.workspace_root / "runtime" / "secrets"
    secret_dir.mkdir(parents=True)
    (secret_dir / "token.txt").write_text("PY_RUNTIME_SECRET=hidden", encoding="utf-8")
    (settings.workspace_root / "runtime" / "visible.txt").write_text("visible", encoding="utf-8")

    direct = service.read(".env")
    listed = service.list(".", recursive=True, limit=50)
    found = service.search("PY_REDZONE_SECRET", ".", limit=10)
    copied = service.copy("runtime", "runtime-copy")

    names = [entry.name.replace("\\", "/") for entry in listed.entries]
    assert not direct.ok
    assert direct.error == "protected-path"
    assert listed.ok
    assert "runtime/visible.txt" in names
    assert ".env" not in names
    assert "runtime/secrets" not in names
    assert "runtime/secrets/token.txt" not in names
    assert found.ok
    assert found.matches == []
    assert not copied.ok
    assert copied.error == "protected-child-path"
    assert not (settings.workspace_root / "runtime-copy").exists()


def test_workspace_blocks_escape_and_protected_paths(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)

    escaped = service.write(str(tmp_path / "outside.txt"), "nope")
    assert not escaped.ok
    assert escaped.error == "outside-workspace"

    protected = service.write(".git/config", "nope")
    assert not protected.ok
    assert protected.error == "protected-path"


def test_workspace_detector_does_not_execute_how_to_questions() -> None:
    assert detect_workspace_command("как создать файл в Python?") is None


def test_workspace_detector_fails_closed_for_incomplete_file_write() -> None:
    assert detect_workspace_command("создай файл с отчетом") is None
    assert detect_workspace_command("создай файл в условном месте") is None

    incomplete = detect_incomplete_workspace_command("создай файл с отчетом")
    assert incomplete is not None
    assert incomplete.ok is False
    assert incomplete.action == "write"
    assert incomplete.error == "workspace-command-incomplete"

    history_request = (
        "Хорошо ты можешь создать в своем рабочем пространсве папку,"
        "а в папке создать текстовый документ с надписью Hello World?"
    )
    assert detect_workspace_command(history_request) is None
    history_incomplete = detect_incomplete_workspace_command(history_request)
    assert history_incomplete is not None
    assert history_incomplete.action == "write"
    assert history_incomplete.error == "workspace-command-incomplete"


def test_workspace_multi_detector_and_connector(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)
    commands = detect_workspace_commands(
        'Создай папку artifacts/generated/multi и создай файл artifacts/generated/multi/a.md с текстом "alpha"'
    )

    assert [command.action for command in commands] == ["mkdir", "write"]
    results = [service.execute(command) for command in commands]

    assert all(result.ok for result in results)
    assert (settings.workspace_root / "artifacts" / "generated" / "multi" / "a.md").read_text(encoding="utf-8") == "alpha"


def test_workspace_multi_detector_accepts_implicit_file_after_folder(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)
    commands = detect_workspace_commands(
        'Создай папку artifacts/generated/implicit и файл artifacts/generated/implicit/a.md с текстом "ok"'
    )

    assert [command.action for command in commands] == ["mkdir", "write"]
    results = [service.execute(command) for command in commands]

    assert all(result.ok for result in results)
    assert (settings.workspace_root / "artifacts" / "generated" / "implicit" / "a.md").read_text(encoding="utf-8") == "ok"


def test_workspace_multi_detector_semicolon_and_newline(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)
    commands = detect_workspace_commands(
        'Создай файл artifacts/generated/one.md с текстом "one";\n'
        'создай файл artifacts/generated/two.md с текстом "two"'
    )

    assert [command.action for command in commands] == ["write", "write"]
    results = [service.execute(command) for command in commands]

    assert all(result.ok for result in results)
    assert (settings.workspace_root / "artifacts" / "generated" / "one.md").read_text(encoding="utf-8") == "one"
    assert (settings.workspace_root / "artifacts" / "generated" / "two.md").read_text(encoding="utf-8") == "two"


def test_workspace_multi_detector_does_not_split_quoted_content(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)
    commands = detect_workspace_commands(
        'Создай файл artifacts/generated/quoted.md с текстом "alpha; beta и создай файл nope.md"'
    )

    assert len(commands) == 1
    result = service.execute(commands[0])

    assert result.ok
    assert (settings.workspace_root / "artifacts" / "generated" / "quoted.md").read_text(encoding="utf-8") == "alpha; beta и создай файл nope.md"
    assert not (settings.workspace_root / "nope.md").exists()


def test_workspace_batch_detector_line_format(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)
    commands = detect_workspace_commands(
        'Создай файлы:\n'
        '- artifacts/generated/a.md: alpha\n'
        '- artifacts/generated/b.txt: "beta value"\n'
    )

    assert len(commands) == 2
    results = [service.execute(command) for command in commands]

    assert all(result.ok for result in results)
    assert (settings.workspace_root / "artifacts" / "generated" / "a.md").read_text(encoding="utf-8") == "alpha"
    assert (settings.workspace_root / "artifacts" / "generated" / "b.txt").read_text(encoding="utf-8") == "beta value"


def test_workspace_batch_detector_json_format(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)
    commands = detect_workspace_commands(
        'workspace batch\n'
        '```json\n'
        '[{"action":"mkdir","path":"artifacts/generated/batch"},'
        '{"action":"write","path":"artifacts/generated/batch/note.md","content":"json ok"}]\n'
        '```'
    )

    assert [command.action for command in commands] == ["mkdir", "write"]
    results = [service.execute(command) for command in commands]

    assert all(result.ok for result in results)
    assert (settings.workspace_root / "artifacts" / "generated" / "batch" / "note.md").read_text(encoding="utf-8") == "json ok"


def test_workspace_structure_detector_tree_format(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)
    commands = detect_workspace_commands(
        "Создай структуру проекта:\n"
        "artifacts/generated/scaffold/\n"
        "├── README.md: scaffold ready\n"
        "├── src/\n"
        "│   └── main.ts: console.log('ok')\n"
        "└── notes/\n"
        "    └── todo.md\n"
    )

    assert [command.action for command in commands] == ["mkdir", "write", "mkdir", "write", "mkdir", "write"]
    results = [service.execute(command) for command in commands]

    assert all(result.ok for result in results)
    scaffold_root = settings.workspace_root / "artifacts" / "generated" / "scaffold"
    assert (scaffold_root / "README.md").read_text(encoding="utf-8") == "scaffold ready"
    assert (scaffold_root / "src" / "main.ts").read_text(encoding="utf-8") == "console.log('ok')"
    assert (scaffold_root / "notes" / "todo.md").read_text(encoding="utf-8") == ""


def test_workspace_structure_detector_rootless_files(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    service = WorkspaceService(settings)
    commands = detect_workspace_commands(
        "Собери структуру:\n"
        "README.md: root note\n"
        "src/\n"
        "  main.py: print('ok')\n"
    )

    assert [command.action for command in commands] == ["write", "mkdir", "write"]
    results = [service.execute(command) for command in commands]

    assert all(result.ok for result in results)
    assert (settings.workspace_root / "README.md").read_text(encoding="utf-8") == "root note"
    assert (settings.workspace_root / "src" / "main.py").read_text(encoding="utf-8") == "print('ok')"


def test_memory_filters_generic_and_low_overlap_queries(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    store = MemoryStore(settings)
    store.upsert_document(url="local://one", title="Router notes", text="Monarch router chooses modules and capabilities.")

    assert not should_use_memory("привет")
    assert store.search("Monarch router") != []
    assert store.search("Monarch banana") == []


def test_manual_memory_note_can_be_saved_and_found(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    store = MemoryStore(settings)
    note = detect_memory_note("запомни: Oscar умеет создавать папки и дописывать файлы")
    assert note == "Oscar умеет создавать папки и дописывать файлы"

    remembered = store.remember_note(note)
    assert remembered.ok
    hits = store.search("Oscar папки файлы")
    assert hits


def test_manual_memory_note_matches_specific_single_anchor_in_followup(tmp_path: Path) -> None:
    store = MemoryStore(make_settings(tmp_path))
    store.create_memory_item("Кодовое слово проекта: янтарь", category="project")

    hits = store.search("помнишь что я называл янтарь")

    assert hits
    assert hits[0].url and hits[0].url.startswith("memory://")
    assert "янтарь" in hits[0].text


def test_memory_items_can_be_managed_and_disabled(tmp_path: Path) -> None:
    store = MemoryStore(make_settings(tmp_path))
    created = store.create_memory_item("Всегда отвечай на русском", category="instruction")

    assert created["enabled"] is True
    assert store.search("отвечай русском")

    updated = store.update_memory_item(created["id"], enabled=False, content="Всегда отвечай кратко на русском")
    assert updated["enabled"] is False
    assert store.search("отвечай русском") == []

    assert store.delete_memory_item(created["id"]) is True
    assert store.list_memory_items() == []


def test_memory_items_support_classified_taxonomy_fields(tmp_path: Path) -> None:
    store = MemoryStore(make_settings(tmp_path))
    created = store.create_memory_item(
        "Architecture decision: planner reads classified memory before risky changes.",
        category="architecture_note",
        title="Planner classified memory",
        tags=["planner", "memory"],
        priority=0.82,
        related_files=["src/core/planner.ts"],
        related_modules=["planner", "memory"],
    )

    assert created["type"] == "architecture_note"
    assert created["category"] == "project"
    assert created["title"] == "Planner classified memory"
    assert created["tags"] == ["planner", "memory"]
    assert created["priority"] == 0.82
    assert created["related_files"] == ["src/core/planner.ts"]
    assert store.search("planner classified memory")

    closed = store.update_memory_item(created["id"], closed=True)

    assert closed["status"] == "closed"
    assert store.search("planner classified memory") == []
    assert store.list_memory_items()[0]["status"] == "closed"


def test_conversation_history_persists_messages_and_supports_management(tmp_path: Path) -> None:
    store = MemoryStore(make_settings(tmp_path))
    conversation = store.create_conversation()
    user_message = store.append_conversation_message(conversation["id"], "user", "Как решить квадратное уравнение?")
    store.append_conversation_message(
        conversation["id"],
        "assistant",
        "Используй дискриминант.",
        token_count=418,
        elapsed_ms=2360,
    )

    loaded = store.get_conversation(conversation["id"])
    assert loaded["title"] == "Как решить квадратное уравнение?"
    assert [message["role"] for message in loaded["messages"]] == ["user", "assistant"]
    assert loaded["messages"][1]["token_count"] == 418
    assert loaded["messages"][1]["elapsed_ms"] == 2360
    assert store.list_conversations()[0]["message_count"] == 2

    edited = store.edit_user_message(conversation["id"], user_message["id"], "Объясни квадратное уравнение проще")
    assert [message["role"] for message in edited["messages"]] == ["user"]
    assert edited["messages"][0]["content"] == "Объясни квадратное уравнение проще"
    assert edited["title"] == "Объясни квадратное уравнение проще"

    renamed = store.update_conversation(conversation["id"], title="Квадратные уравнения")
    assert renamed["title"] == "Квадратные уравнения"
    assert store.delete_conversation(conversation["id"]) is True
    assert store.list_conversations() == []


def test_conversation_delete_scrubs_plaintext_from_sqlite_and_wal(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    store = MemoryStore(settings)
    marker = "SAFE_MIGRATION_SQLITE_MARKER_8F2A"
    conversation = store.create_conversation(title=marker)
    store.append_conversation_message(conversation["id"], "user", marker)

    sqlite_paths = [
        Path(settings.db_path),
        Path(f"{settings.db_path}-wal"),
        Path(f"{settings.db_path}-shm"),
    ]
    before_delete = b"".join(path.read_bytes() for path in sqlite_paths if path.exists())
    assert marker.encode("utf-8") in before_delete

    assert store.delete_conversation(conversation["id"]) is True

    for path in sqlite_paths:
        if path.exists():
            assert marker.encode("utf-8") not in path.read_bytes()
    wal_path = Path(f"{settings.db_path}-wal")
    assert not wal_path.exists() or wal_path.stat().st_size == 0


def test_conversation_delete_keeps_source_when_wal_preflight_is_busy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = MemoryStore(make_settings(tmp_path))
    conversation = store.create_conversation(title="Keep source until Safe migration can commit")

    def busy_checkpoint(*, require_idle: bool) -> bool:
        assert require_idle is True
        raise RuntimeError("busy WAL")

    monkeypatch.setattr(store, "_checkpoint_conversation_wal", busy_checkpoint)
    with pytest.raises(RuntimeError, match="busy WAL"):
        store.delete_conversation(conversation["id"])

    assert store.get_conversation(conversation["id"], include_messages=False)["id"] == conversation["id"]


def test_conversation_delete_does_not_rollback_signal_after_commit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = MemoryStore(make_settings(tmp_path))
    conversation = store.create_conversation(title="Safe copy is already verified")

    def checkpoint(*, require_idle: bool) -> bool:
        if require_idle:
            return True
        raise OSError("late checkpoint failure")

    monkeypatch.setattr(store, "_checkpoint_conversation_wal", checkpoint)
    assert store.delete_conversation(conversation["id"]) is True
    with pytest.raises(KeyError):
        store.get_conversation(conversation["id"], include_messages=False)


def make_directory_link_or_skip(link_path: Path, target: Path) -> None:
    if sys.platform == "win32":
        command = (
            "New-Item -ItemType Junction -Path "
            f"{powershell_quote(str(link_path))} -Target {powershell_quote(str(target))} | Out-Null"
        )
        completed = subprocess.run(
            ["powershell", "-NoProfile", "-Command", command],
            capture_output=True,
            text=True,
        )
        if completed.returncode != 0:
            pytest.skip(f"could not create junction: {completed.stderr or completed.stdout}")
        return
    try:
        os.symlink(target, link_path, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"could not create symlink: {exc}")


def powershell_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"
