from __future__ import annotations

from pathlib import Path
import json

import pytest

from oscar_agent.config import Settings
from oscar_agent.context_settings import (
    ContextSettingsStore,
    SettingsRequestConflict,
    SettingsRevisionConflict,
)
from oscar_agent.memory import MemoryStore
from oscar_agent.prompt_catalog import OSCAR_SYSTEM_PROMPT_RU


POLICY_HASH = "a" * 64


def make_store(tmp_path: Path) -> ContextSettingsStore:
    settings = Settings(
        data_dir=tmp_path / "data",
        db_path=tmp_path / "data" / "memory" / "oscar_memory.sqlite3",
        offload_dir=tmp_path / "offload",
        workspace_root=tmp_path / "workspace",
        workspace_generated_dir=tmp_path / "workspace" / "artifacts" / "generated",
        mock_model=True,
    )
    MemoryStore(settings)
    return ContextSettingsStore(settings)


def execute(store: ContextSettingsStore, **overrides):
    request = {
        "client_request_id": "settings_test_1",
        "command": "memory.create",
        "scope": {"type": "chat"},
        "expected_revision": 0,
        "payload": {"text": "Я предпочитаю короткие ответы", "category": "preference"},
        "policy_decision_hash": POLICY_HASH,
    }
    request.update(overrides)
    return store.execute(**request)


def test_memory_command_returns_durable_readback_and_is_idempotent(tmp_path: Path) -> None:
    store = make_store(tmp_path)

    receipt = execute(store)
    replay = execute(store)
    context = store.read("memory", {"type": "chat"})

    assert receipt["revision"] == 1
    assert receipt["contentHash"] == receipt["readBackHash"] == context["contentHash"]
    assert receipt["replayed"] is False
    assert replay["receiptId"] == receipt["receiptId"]
    assert replay["replayed"] is True
    assert [item["text"] for item in context["value"]["records"]] == [
        "Я предпочитаю короткие ответы"
    ]


def test_settings_reject_stale_revision_and_client_id_rebinding(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    execute(store)

    with pytest.raises(SettingsRevisionConflict):
        execute(store, client_request_id="settings_test_2", payload={"text": "другая запись"})
    with pytest.raises(SettingsRequestConflict):
        execute(store, payload={"text": "другой payload"})


def test_memory_scopes_are_isolated_and_delete_is_soft(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    chat_receipt = execute(store)
    record_id = chat_receipt["result"]["record"]["id"]
    project_receipt = execute(
        store,
        client_request_id="settings_project_1",
        scope={"type": "coder-project", "projectId": "project-alpha"},
        payload={"text": "project-only"},
    )

    assert project_receipt["revision"] == 1
    assert len(store.read("memory", {"type": "chat"})["value"]["records"]) == 1
    assert [record["text"] for record in store.read(
        "memory", {"type": "coder-project", "projectId": "project-alpha"}
    )["value"]["records"]] == ["project-only"]

    deleted = execute(
        store,
        client_request_id="settings_delete_1",
        command="memory.delete",
        expected_revision=1,
        payload={"id": record_id},
    )
    assert deleted["revision"] == 2
    assert store.read("memory", {"type": "chat"})["value"]["records"] == []

    restored = execute(
        store,
        client_request_id="settings_restore_1",
        command="memory.restore",
        expected_revision=2,
        payload={"id": record_id},
    )
    assert restored["revision"] == 3
    assert len(store.read("memory", {"type": "chat"})["value"]["records"]) == 1


def test_profile_revision_and_readback_are_canonical(tmp_path: Path) -> None:
    store = make_store(tmp_path)

    receipt = execute(
        store,
        client_request_id="settings_profile_1",
        command="profile.update",
        payload={
            "adaptiveSummary": "Практичный разработчик",
            "traits": ["direct"],
            "styleRules": ["Сначала результат."],
            "preferences": {"communicationPreset": "concise"},
        },
    )
    context = store.read("profile", {"type": "chat"})

    assert receipt["revision"] == 1
    assert context["value"]["adaptiveSummary"] == "Практичный разработчик"
    assert receipt["contentHash"] == context["contentHash"]


def test_owner_prompt_override_is_runtime_resolvable_and_resettable(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    initial = store.read("prompts", {"type": "chat"})
    prompt = next(
        item for item in initial["value"]["prompts"]
        if item["id"] == "oscar.chat.system.ru"
    )
    assert prompt["content"] == OSCAR_SYSTEM_PROMPT_RU
    assert prompt["overridden"] is False

    updated = execute(
        store,
        client_request_id="prompt_update_1",
        command="prompts.update",
        expected_revision=0,
        payload={"promptId": "oscar.chat.system.ru", "content": "Owner override prompt"},
    )
    assert store.resolve_prompt("oscar.chat.system.ru") == "Owner override prompt"
    assert updated["revision"] == 1
    assert next(
        item for item in store.read("prompts", {"type": "chat"})["value"]["prompts"]
        if item["id"] == "oscar.chat.system.ru"
    )["overridden"] is True

    execute(
        store,
        client_request_id="prompt_reset_1",
        command="prompts.reset",
        expected_revision=1,
        payload={"promptId": "oscar.chat.system.ru"},
    )
    assert store.resolve_prompt("oscar.chat.system.ru") == OSCAR_SYSTEM_PROMPT_RU


def test_legacy_profile_and_memory_are_backed_up_and_migrated_once(tmp_path: Path) -> None:
    data_root = tmp_path / "data"
    data_root.mkdir(parents=True)
    (data_root / "profile.json").write_text(json.dumps({
        "version": 1,
        "adaptiveSummary": "legacy summary",
        "styleRules": ["legacy rule"],
        "preferences": {"communicationPreset": "warm"},
    }), encoding="utf-8")
    (data_root / "memory.json").write_text(json.dumps({
        "version": 3,
        "records": [{
            "id": "legacy_memory_1",
            "text": "legacy memory",
            "category": "fact",
            "tier": "permanent",
            "pinned": True,
        }],
    }), encoding="utf-8")

    first = make_store(tmp_path)
    second = ContextSettingsStore(Settings(
        data_dir=data_root,
        db_path=data_root / "memory" / "oscar_memory.sqlite3",
        offload_dir=tmp_path / "offload",
        workspace_root=tmp_path / "workspace",
        workspace_generated_dir=tmp_path / "workspace" / "artifacts" / "generated",
        mock_model=True,
    ))

    assert first.read("profile", {"type": "chat"})["value"]["adaptiveSummary"] == "legacy summary"
    migrated_records = {
        record["id"]: record
        for record in first.read("memory", {"type": "chat"})["value"]["records"]
    }
    assert set(migrated_records) == {"legacy_memory_1", "profile-v1-adaptive-summary"}
    assert migrated_records["profile-v1-adaptive-summary"]["text"] == "legacy summary"
    assert migrated_records["profile-v1-adaptive-summary"]["source"] == "migration-profile-v1"
    assert migrated_records["profile-v1-adaptive-summary"]["pinned"] is True
    personality = first.read("personality", {"type": "chat"})["value"]
    assert personality["enabled"] is True
    assert len(personality["profiles"]) == 3
    assert next(
        profile for profile in personality["profiles"]
        if profile["id"] == personality["selectedProfileId"]
    )["variant"] == "lively"
    assert personality["profiles"][0]["customRules"] == ["legacy rule"]
    assert len(second.read("memory", {"type": "chat"})["value"]["records"]) == 2
    backup = data_root / "migrations" / "context-v4-backup"
    assert (backup / "profile.json").is_file()
    assert (backup / "memory.json").is_file()
    assert (backup / "sqlite-metadata.json").is_file()
    assert (data_root / "profile.json").is_file()
    assert (data_root / "memory.json").is_file()


def test_personality_generates_exact_variants_and_supports_durable_selection(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    initial = store.read("personality", {"type": "chat"})
    created = execute(
        store,
        client_request_id="personality_create_1",
        command="personality.profile.create",
        expected_revision=initial["revision"],
        payload={
            "questionnaire": {
                "brevity": 70,
                "warmth": 60,
                "directness": 75,
                "initiative": 55,
                "humor": 35,
                "skepticism": 80,
                "technicalDepth": 90,
                "structure": 85,
                "addressForm": "ты",
                "language": "ru",
            }
        },
    )
    context = store.read("personality", {"type": "chat"})
    profiles = context["value"]["profiles"]

    assert created["revision"] == initial["revision"] + 1
    assert [profile["variant"] for profile in profiles] == ["restrained", "direct", "lively"]
    assert len({profile["id"] for profile in profiles}) == 3
    assert all(len(profile["contentHash"]) == 64 for profile in profiles)
    assert profiles[0]["dimensions"] != profiles[1]["dimensions"] != profiles[2]["dimensions"]

    direct = next(profile for profile in profiles if profile["variant"] == "direct")
    selected = execute(
        store,
        client_request_id="personality_select_1",
        command="personality.profile.select",
        expected_revision=context["revision"],
        payload={"profileId": direct["id"]},
    )
    enabled = execute(
        store,
        client_request_id="personality_enable_1",
        command="personality.personalization.set",
        expected_revision=selected["revision"],
        payload={"enabled": True},
    )
    updated = execute(
        store,
        client_request_id="personality_update_1",
        command="personality.profile.update",
        expected_revision=enabled["revision"],
        payload={
            "profileId": direct["id"],
            "patch": {
                "name": "Инженерный",
                "customRules": ["Сначала результат."],
                "dimensions": {**direct["dimensions"], "technicalDepth": 100},
            },
        },
    )
    read_back = store.read("personality", {"type": "chat"})
    selected_profile = next(
        profile for profile in read_back["value"]["profiles"]
        if profile["id"] == read_back["value"]["selectedProfileId"]
    )

    assert updated["contentHash"] == read_back["contentHash"]
    assert read_back["value"]["enabled"] is True
    assert selected_profile["name"] == "Инженерный"
    assert selected_profile["revision"] == direct["revision"] + 1
    assert selected_profile["dimensions"]["technicalDepth"] == 100
    assert selected_profile["customRules"] == ["Сначала результат."]


def test_personality_scopes_are_isolated_until_explicit_copy(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    chat = store.read("personality", {"type": "chat"})
    chat_created = execute(
        store,
        client_request_id="personality_chat_create",
        command="personality.profile.create",
        expected_revision=chat["revision"],
        payload={"questionnaire": {"warmth": 91, "language": "ru"}},
    )
    project_scope = {"type": "coder-project", "projectId": "project-personality"}
    project_before = store.read("personality", project_scope)

    assert project_before["revision"] == 0
    assert project_before["value"]["questionnaire"]["warmth"] != 91

    copied = execute(
        store,
        client_request_id="personality_copy_1",
        command="personality.scope.copy",
        scope=project_scope,
        expected_revision=project_before["revision"],
        payload={"sourceScope": {"type": "chat"}},
    )
    project = store.read("personality", project_scope)
    assert copied["revision"] == 1
    assert project["value"]["questionnaire"] == store.read(
        "personality", {"type": "chat"}
    )["value"]["questionnaire"]

    project_profile = project["value"]["profiles"][0]
    execute(
        store,
        client_request_id="personality_project_update",
        command="personality.profile.update",
        scope=project_scope,
        expected_revision=project["revision"],
        payload={"profileId": project_profile["id"], "patch": {"name": "Только проект"}},
    )
    assert store.read("personality", project_scope)["value"]["profiles"][0]["name"] == "Только проект"
    assert store.read("personality", {"type": "chat"})["value"]["profiles"][0]["name"] != "Только проект"
    assert chat_created["revision"] > chat["revision"]


def test_voice_preferences_presets_and_input_are_durable(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    initial = store.read("voice", {"type": "chat"})
    assert initial["value"]["preferences"]["voice"] == "oscar"
    assert initial["value"]["input"]["autoSendAfterDictation"] is False

    saved = execute(
        store,
        client_request_id="voice_update_1",
        command="voice.update",
        expected_revision=0,
        payload={
            "preferences": {
                "voice": "aurora",
                "style": "warm",
                "speed": 108,
                "pitch": 1,
                "expressiveness": 73,
                "pauseMs": 120,
                "volume": 84,
            },
            "input": {"autoSendAfterDictation": True},
            "legacyPreferences": {"voice": "oscar-clear", "speed": 96},
        },
    )
    context = store.read("voice", {"type": "chat"})
    assert saved["contentHash"] == context["contentHash"]
    assert context["value"]["preferences"] == {
        "voice": "aurora",
        "style": "warm",
        "speed": 108,
        "pitch": 1,
        "expressiveness": 73,
        "pauseMs": 120,
        "volume": 84,
        "instruction": "",
        "activePresetId": None,
    }
    assert context["value"]["input"]["autoSendAfterDictation"] is True
    backup = tmp_path / "data" / "migrations" / "context-v4-backup" / "voice-local-storage.json"
    assert backup.is_file()

    created = execute(
        store,
        client_request_id="voice_preset_create_1",
        command="voice.preset.create",
        expected_revision=context["revision"],
        payload={"name": "Мой тёплый", "preferences": context["value"]["preferences"]},
    )
    preset_id = created["result"]["preset"]["id"]
    preset_context = store.read("voice", {"type": "chat"})
    assert preset_context["value"]["preferences"]["activePresetId"] == preset_id
    assert preset_context["value"]["presets"][0]["name"] == "Мой тёплый"

    updated = execute(
        store,
        client_request_id="voice_preset_update_1",
        command="voice.preset.update",
        expected_revision=preset_context["revision"],
        payload={"id": preset_id, "patch": {"name": "Тёплый 2"}},
    )
    deleted = execute(
        store,
        client_request_id="voice_preset_delete_1",
        command="voice.preset.delete",
        expected_revision=updated["revision"],
        payload={"id": preset_id},
    )
    after_delete = store.read("voice", {"type": "chat"})
    assert deleted["revision"] == after_delete["revision"]
    assert after_delete["value"]["presets"] == []
    assert after_delete["value"]["preferences"]["activePresetId"] is None


def test_voice_pronunciation_is_whole_word_only_and_scope_is_global(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    created = execute(
        store,
        client_request_id="voice_pronunciation_create_1",
        command="voice.pronunciation.create",
        payload={
            "word": "замок",
            "pronunciation": "за\u0301мок",
            "context": "старый замок",
            "enabled": True,
        },
    )
    rule_id = created["result"]["pronunciation"]["id"]
    context = store.read("voice", {"type": "chat"})
    assert context["value"]["pronunciations"][0]["pronunciation"] == "за\u0301мок"

    updated = execute(
        store,
        client_request_id="voice_pronunciation_update_1",
        command="voice.pronunciation.update",
        expected_revision=context["revision"],
        payload={"id": rule_id, "patch": {"enabled": False}},
    )
    assert store.read("voice", {"type": "chat"})["value"]["pronunciations"][0]["enabled"] is False

    with pytest.raises(ValueError, match="whole word"):
        execute(
            store,
            client_request_id="voice_pronunciation_regex",
            command="voice.pronunciation.create",
            expected_revision=updated["revision"],
            payload={"word": ".*", "pronunciation": "за\u0301мок"},
        )
    with pytest.raises(ValueError, match="before a vowel"):
        execute(
            store,
            client_request_id="voice_pronunciation_bad_plus",
            command="voice.pronunciation.create",
            expected_revision=updated["revision"],
            payload={"word": "замок", "pronunciation": "за+мок"},
        )
    with pytest.raises(ValueError, match="exactly one"):
        execute(
            store,
            client_request_id="voice_pronunciation_two_marks",
            command="voice.pronunciation.create",
            expected_revision=updated["revision"],
            payload={"word": "замок", "pronunciation": "з+ам+ок"},
        )
    with pytest.raises(ValueError, match="global"):
        store.read("voice", {"type": "coder-project", "projectId": "voice-project"})
