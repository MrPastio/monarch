from __future__ import annotations

import hashlib
import json
import re
import shutil
import sqlite3
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import Settings
from .prompt_catalog import (
    OSCAR_PROMPT_DEFINITIONS,
    OSCAR_PROMPT_VERSION,
    get_oscar_prompt_definition,
)


class SettingsRevisionConflict(RuntimeError):
    def __init__(self, expected: int, actual: int):
        super().__init__(f"Settings revision changed: expected {expected}, actual {actual}.")
        self.expected = expected
        self.actual = actual


class SettingsRequestConflict(RuntimeError):
    pass


class SettingsItemNotFound(KeyError):
    pass


class ContextSettingsStore:
    """Canonical typed settings service backed by Oscar's local SQLite database."""

    def __init__(self, settings: Settings):
        self.db_path = Path(settings.db_path)
        service_data_dir = Path(settings.data_dir)
        self.data_root = service_data_dir.parent if service_data_dir.name.lower() == "oscar" else service_data_dir
        self.migration_root = self.data_root / "migrations" / "context-v4-backup"
        self.migration_diagnostic = "legacy-context-not-checked"
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()
        self._migrate_legacy_context()
        self._migrate_profile_to_personality_v2()

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        con = sqlite3.connect(self.db_path, timeout=10.0)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys=ON")
        con.execute("PRAGMA secure_delete=ON")
        con.execute("PRAGMA synchronous=NORMAL")
        try:
            yield con
            con.commit()
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()

    def _init_db(self) -> None:
        with self._connection() as con:
            con.execute("PRAGMA journal_mode=WAL")
            con.executescript(
                """
                CREATE TABLE IF NOT EXISTS settings_documents (
                    kind TEXT NOT NULL,
                    scope_type TEXT NOT NULL,
                    scope_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    content_json TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(kind, scope_type, scope_id)
                );

                CREATE TABLE IF NOT EXISTS settings_scope_revisions (
                    kind TEXT NOT NULL,
                    scope_type TEXT NOT NULL,
                    scope_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(kind, scope_type, scope_id)
                );

                CREATE TABLE IF NOT EXISTS settings_receipts (
                    client_request_id TEXT PRIMARY KEY,
                    request_hash TEXT NOT NULL,
                    receipt_json TEXT NOT NULL,
                    committed_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS settings_migrations (
                    migration_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    diagnostic TEXT NOT NULL,
                    completed_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS memory_scope_preferences (
                    scope_type TEXT NOT NULL,
                    scope_id TEXT NOT NULL,
                    cross_chat_enabled INTEGER NOT NULL DEFAULT 1,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(scope_type, scope_id)
                );
                """
            )
            memory_columns = {
                row["name"] for row in con.execute("PRAGMA table_info(memory_items)").fetchall()
            }
            additions = {
                "schema_version": "INTEGER NOT NULL DEFAULT 4",
                "scope_type": "TEXT NOT NULL DEFAULT 'chat'",
                "scope_id": "TEXT NOT NULL DEFAULT 'default'",
                "revision": "INTEGER NOT NULL DEFAULT 1",
                "content_hash": "TEXT NOT NULL DEFAULT ''",
                "deleted_at": "TEXT",
                "tier": "TEXT NOT NULL DEFAULT 'long'",
                "importance": "REAL NOT NULL DEFAULT 0.65",
                "pinned": "INTEGER NOT NULL DEFAULT 0",
                "access_count": "INTEGER NOT NULL DEFAULT 0",
                "decay_rate": "REAL NOT NULL DEFAULT 0.02",
            }
            for column, definition in additions.items():
                if column not in memory_columns:
                    con.execute(f"ALTER TABLE memory_items ADD COLUMN {column} {definition}")
            con.execute(
                "CREATE INDEX IF NOT EXISTS memory_items_scope_updated_idx "
                "ON memory_items(scope_type, scope_id, deleted_at, updated_at DESC)"
            )
            rows = con.execute(
                "SELECT id, content, category, type, title, tags_json, priority, source, "
                "scope_type, scope_id, revision, content_hash FROM memory_items"
            ).fetchall()
            for row in rows:
                if row["content_hash"]:
                    continue
                con.execute(
                    "UPDATE memory_items SET content_hash = ? WHERE id = ?",
                    (sha256_json(self._memory_hash_payload(row)), row["id"]),
                )

    def read(self, kind: str, scope: dict[str, str | None]) -> dict[str, Any]:
        scope_type, scope_id = normalize_scope(scope)
        with self._connection() as con:
            return self._read_in_connection(con, kind, scope_type, scope_id)

    def execute(
        self,
        *,
        client_request_id: str,
        command: str,
        scope: dict[str, str | None],
        expected_revision: int,
        payload: dict[str, Any],
        policy_decision_hash: str,
    ) -> dict[str, Any]:
        scope_type, scope_id = normalize_scope(scope)
        request_hash = sha256_json({
            "schemaVersion": 1,
            "clientRequestId": client_request_id,
            "command": command,
            "scope": render_scope(scope_type, scope_id),
            "expectedRevision": expected_revision,
            "payload": payload,
            "policyDecisionHash": policy_decision_hash,
        })
        with self._connection() as con:
            con.execute("BEGIN IMMEDIATE")
            replay = con.execute(
                "SELECT request_hash, receipt_json FROM settings_receipts WHERE client_request_id = ?",
                (client_request_id,),
            ).fetchone()
            if replay:
                if replay["request_hash"] != request_hash:
                    raise SettingsRequestConflict("clientRequestId was already used for a different settings command.")
                receipt = json.loads(replay["receipt_json"])
                receipt["replayed"] = True
                return receipt

            if command == "profile.update":
                kind = "profile"
                result = self._update_document(con, kind, scope_type, scope_id, expected_revision, payload)
            elif command == "personality.profile.create":
                kind = "personality"
                result = self._create_personality_profiles(
                    con, scope_type, scope_id, expected_revision, payload
                )
            elif command == "personality.profile.update":
                kind = "personality"
                result = self._update_personality_profile(
                    con, scope_type, scope_id, expected_revision, payload
                )
            elif command == "personality.profile.select":
                kind = "personality"
                result = self._select_personality_profile(
                    con, scope_type, scope_id, expected_revision, payload
                )
            elif command == "personality.personalization.set":
                kind = "personality"
                result = self._set_personalization_enabled(
                    con, scope_type, scope_id, expected_revision, payload
                )
            elif command == "personality.scope.copy":
                kind = "personality"
                result = self._copy_personality_scope(
                    con, scope_type, scope_id, expected_revision, payload
                )
            elif command == "voice.update":
                kind = "voice"
                result = self._update_voice_document(
                    con, scope_type, scope_id, expected_revision, payload
                )
            elif command == "voice.preset.create":
                kind = "voice"
                result = self._create_voice_preset(
                    con, scope_type, scope_id, expected_revision, payload
                )
            elif command == "voice.preset.update":
                kind = "voice"
                result = self._update_voice_preset(
                    con, scope_type, scope_id, expected_revision, payload
                )
            elif command == "voice.preset.delete":
                kind = "voice"
                result = self._delete_voice_preset(
                    con, scope_type, scope_id, expected_revision, payload
                )
            elif command == "voice.pronunciation.create":
                kind = "voice"
                result = self._create_voice_pronunciation(
                    con, scope_type, scope_id, expected_revision, payload
                )
            elif command == "voice.pronunciation.update":
                kind = "voice"
                result = self._update_voice_pronunciation(
                    con, scope_type, scope_id, expected_revision, payload
                )
            elif command == "voice.pronunciation.delete":
                kind = "voice"
                result = self._delete_voice_pronunciation(
                    con, scope_type, scope_id, expected_revision, payload
                )
            elif command == "memory.create":
                kind = "memory"
                result = self._create_memory(con, scope_type, scope_id, expected_revision, payload)
            elif command == "memory.update":
                kind = "memory"
                result = self._update_memory(con, scope_type, scope_id, expected_revision, payload)
            elif command == "memory.delete":
                kind = "memory"
                result = self._set_memory_deleted(con, scope_type, scope_id, expected_revision, payload, True)
            elif command == "memory.restore":
                kind = "memory"
                result = self._set_memory_deleted(con, scope_type, scope_id, expected_revision, payload, False)
            elif command == "memory.cross-chat.set":
                kind = "memory"
                result = self._set_cross_chat_enabled(con, scope_type, scope_id, expected_revision, payload)
            elif command == "prompts.update":
                kind = "prompts"
                result = self._update_prompt_override(
                    con, scope_type, scope_id, expected_revision, payload
                )
            elif command == "prompts.reset":
                kind = "prompts"
                result = self._reset_prompt_override(
                    con, scope_type, scope_id, expected_revision, payload
                )
            elif command == "prompts.reset-all":
                kind = "prompts"
                result = self._reset_all_prompt_overrides(
                    con, scope_type, scope_id, expected_revision
                )
            else:
                raise ValueError(f"Settings command {command} is not implemented by this service version.")

            read_back = self._read_in_connection(con, kind, scope_type, scope_id)
            committed_at = utc_now()
            receipt = {
                "schemaVersion": 1,
                "receiptId": f"settings_receipt_{uuid.uuid4().hex}",
                "clientRequestId": client_request_id,
                "command": command,
                "scope": render_scope(scope_type, scope_id),
                "revision": read_back["revision"],
                "contentHash": read_back["contentHash"],
                "readBackHash": read_back["contentHash"],
                "policyDecisionHash": policy_decision_hash,
                "committedAt": committed_at,
                "replayed": False,
                "result": result,
            }
            con.execute(
                "INSERT INTO settings_receipts(client_request_id, request_hash, receipt_json, committed_at) "
                "VALUES(?, ?, ?, ?)",
                (client_request_id, request_hash, canonical_json(receipt), committed_at),
            )
            return receipt

    def _read_in_connection(
        self,
        con: sqlite3.Connection,
        kind: str,
        scope_type: str,
        scope_id: str,
    ) -> dict[str, Any]:
        if kind == "memory":
            revision = self._scope_revision(con, kind, scope_type, scope_id)
            rows = con.execute(
                "SELECT * FROM memory_items WHERE scope_type = ? AND scope_id = ? "
                "AND deleted_at IS NULL ORDER BY pinned DESC, updated_at DESC LIMIT 500",
                (scope_type, scope_id),
            ).fetchall()
            preference = con.execute(
                "SELECT cross_chat_enabled FROM memory_scope_preferences WHERE scope_type = ? AND scope_id = ?",
                (scope_type, scope_id),
            ).fetchone()
            value: Any = {
                "records": [self._memory_record(row) for row in rows],
                "crossChatEnabled": bool(preference["cross_chat_enabled"]) if preference else True,
            }
        elif kind == "prompts":
            assert_prompt_scope(scope_type, scope_id)
            row = con.execute(
                "SELECT revision, content_json FROM settings_documents "
                "WHERE kind = 'prompts' AND scope_type = ? AND scope_id = ?",
                (scope_type, scope_id),
            ).fetchone()
            revision = int(row["revision"]) if row else 0
            document = json.loads(row["content_json"]) if row else {"overrides": {}}
            overrides = document.get("overrides") if isinstance(document, dict) else {}
            overrides = overrides if isinstance(overrides, dict) else {}
            value = {
                "schemaVersion": 1,
                "defaultVersion": OSCAR_PROMPT_VERSION,
                "prompts": [
                    render_prompt_definition(definition, overrides.get(definition.id))
                    for definition in OSCAR_PROMPT_DEFINITIONS
                ],
                "updatedAt": str(document.get("updatedAt") or "") if isinstance(document, dict) else "",
            }
        elif kind in {"profile", "personality", "voice"}:
            if kind == "voice":
                assert_voice_scope(scope_type, scope_id)
            row = con.execute(
                "SELECT revision, content_json FROM settings_documents "
                "WHERE kind = ? AND scope_type = ? AND scope_id = ?",
                (kind, scope_type, scope_id),
            ).fetchone()
            revision = int(row["revision"]) if row else 0
            value = json.loads(row["content_json"]) if row else default_document(kind)
            if kind == "personality":
                value = normalize_personality_document(value)
            elif kind == "voice":
                value = normalize_voice_document(value)
        else:
            raise ValueError("Unknown settings kind.")
        response = {
            "schemaVersion": 1,
            "kind": kind,
            "scope": render_scope(scope_type, scope_id),
            "revision": revision,
            "value": value,
            "migration": self.migration_diagnostic,
        }
        response["contentHash"] = sha256_json(response)
        return response

    def resolve_prompt(self, prompt_id: str) -> str:
        definition = get_oscar_prompt_definition(prompt_id)
        if not definition:
            raise KeyError(f"Unknown Oscar prompt: {prompt_id}")
        with self._connection() as con:
            row = con.execute(
                "SELECT content_json FROM settings_documents "
                "WHERE kind = 'prompts' AND scope_type = 'chat' AND scope_id = 'default'",
            ).fetchone()
        if not row:
            return definition.default_content
        document = json.loads(row["content_json"])
        overrides = document.get("overrides") if isinstance(document, dict) else {}
        content = overrides.get(definition.id) if isinstance(overrides, dict) else None
        return content if isinstance(content, str) and content.strip() else definition.default_content

    def _prompt_document(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
    ) -> tuple[int, dict[str, Any], str | None]:
        assert_prompt_scope(scope_type, scope_id)
        row = con.execute(
            "SELECT revision, content_json, created_at FROM settings_documents "
            "WHERE kind = 'prompts' AND scope_type = ? AND scope_id = ?",
            (scope_type, scope_id),
        ).fetchone()
        if not row:
            return 0, {"schemaVersion": 1, "overrides": {}, "updatedAt": ""}, None
        document = json.loads(row["content_json"])
        if not isinstance(document, dict) or not isinstance(document.get("overrides", {}), dict):
            raise ValueError("Stored Oscar prompt document is invalid.")
        return int(row["revision"]), document, str(row["created_at"])

    def _commit_prompt_document(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
        expected_revision: int,
        mutate,
    ) -> dict[str, Any]:
        revision, document, created_at = self._prompt_document(con, scope_type, scope_id)
        assert_revision(expected_revision, revision)
        overrides = dict(document.get("overrides") or {})
        result = mutate(overrides)
        now = utc_now()
        value = {"schemaVersion": 1, "overrides": overrides, "updatedAt": now}
        content_json = canonical_json(value)
        con.execute(
            "INSERT INTO settings_documents(kind, scope_type, scope_id, revision, content_json, content_hash, created_at, updated_at) "
            "VALUES('prompts', ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(kind, scope_type, scope_id) DO UPDATE SET revision = excluded.revision, "
            "content_json = excluded.content_json, content_hash = excluded.content_hash, updated_at = excluded.updated_at",
            (
                scope_type,
                scope_id,
                revision + 1,
                content_json,
                sha256_json(value),
                created_at or now,
                now,
            ),
        )
        return result

    def _update_prompt_override(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
        expected_revision: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        prompt_id = str(payload.get("promptId") or "").strip()
        definition = get_oscar_prompt_definition(prompt_id)
        if not definition:
            raise ValueError("Unknown Oscar prompt id.")
        content = str(payload.get("content") or "").strip()
        if not content:
            raise ValueError("Oscar prompt content must not be blank.")
        if len(content) > definition.max_characters:
            raise ValueError(f"Oscar prompt exceeds {definition.max_characters} characters.")

        def mutate(overrides: dict[str, Any]) -> dict[str, Any]:
            overrides[prompt_id] = content
            return {"promptId": prompt_id, "overridden": True}

        return self._commit_prompt_document(
            con, scope_type, scope_id, expected_revision, mutate
        )

    def _reset_prompt_override(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
        expected_revision: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        prompt_id = str(payload.get("promptId") or "").strip()
        if not get_oscar_prompt_definition(prompt_id):
            raise ValueError("Unknown Oscar prompt id.")

        def mutate(overrides: dict[str, Any]) -> dict[str, Any]:
            overrides.pop(prompt_id, None)
            return {"promptId": prompt_id, "overridden": False}

        return self._commit_prompt_document(
            con, scope_type, scope_id, expected_revision, mutate
        )

    def _reset_all_prompt_overrides(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
        expected_revision: int,
    ) -> dict[str, Any]:
        def mutate(overrides: dict[str, Any]) -> dict[str, Any]:
            reset_count = len(overrides)
            overrides.clear()
            return {"resetCount": reset_count}

        return self._commit_prompt_document(
            con, scope_type, scope_id, expected_revision, mutate
        )

    def _migrate_legacy_context(self) -> None:
        migration_id = "legacy-context-v4"
        with self._connection() as con:
            existing = con.execute(
                "SELECT status, diagnostic FROM settings_migrations WHERE migration_id = ?",
                (migration_id,),
            ).fetchone()
        if existing and existing["status"] == "completed":
            self.migration_diagnostic = existing["diagnostic"]
            return

        profile_path = self.data_root / "profile.json"
        memory_path = self.data_root / "memory.json"
        try:
            self.migration_root.mkdir(parents=True, exist_ok=True)
            profile_payload = backup_and_read_json(profile_path, self.migration_root / "profile.json")
            memory_payload = backup_and_read_json(memory_path, self.migration_root / "memory.json")
            self._write_sqlite_metadata_backup()
            imported_profile = False
            imported_memories = 0
            with self._connection() as con:
                con.execute("BEGIN IMMEDIATE")
                if isinstance(profile_payload, dict):
                    existing_profile = con.execute(
                        "SELECT 1 FROM settings_documents WHERE kind = 'profile' "
                        "AND scope_type = 'chat' AND scope_id = 'default'",
                    ).fetchone()
                    if not existing_profile:
                        value = merge_document("profile", default_document("profile"), {
                            key: profile_payload[key]
                            for key in (
                                "displayName", "adaptiveSummary", "traits", "styleRules", "boundaries", "preferences"
                            )
                            if key in profile_payload
                        })
                        now = utc_now()
                        con.execute(
                            "INSERT INTO settings_documents(kind, scope_type, scope_id, revision, content_json, "
                            "content_hash, created_at, updated_at) VALUES('profile', 'chat', 'default', 1, ?, ?, ?, ?)",
                            (canonical_json(value), sha256_json(value), now, now),
                        )
                        imported_profile = True
                records = memory_payload.get("records", []) if isinstance(memory_payload, dict) else []
                if isinstance(records, list):
                    for candidate in records:
                        if not isinstance(candidate, dict):
                            continue
                        content = bounded_optional_text(candidate.get("text"), 4000)
                        if not content:
                            continue
                        requested_id = str(candidate.get("id") or "").strip()
                        item_id = requested_id if re.fullmatch(
                            r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", requested_id
                        ) else uuid.uuid4().hex
                        if con.execute("SELECT 1 FROM memory_items WHERE id = ?", (item_id,)).fetchone():
                            continue
                        item = normalize_memory_payload(candidate, content)
                        created_at = bounded_optional_text(candidate.get("createdAt"), 80) or utc_now()
                        updated_at = bounded_optional_text(candidate.get("updatedAt"), 80) or created_at
                        item_hash = sha256_json({
                            **item,
                            "id": item_id,
                            "scope": {"type": "chat"},
                        })
                        con.execute(
                            """
                            INSERT INTO memory_items(
                                id, content, category, type, title, tags_json, enabled, source,
                                created_at, updated_at, priority, expires_at, related_files_json,
                                related_modules_json, schema_version, scope_type, scope_id,
                                revision, content_hash, deleted_at, tier, importance, pinned,
                                access_count, decay_rate
                            ) VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 4, 'chat', 'default', 1, ?, NULL, ?, ?, ?, ?, ?)
                            """,
                            (
                                item_id, content, item["category"], item["type"], item["title"],
                                canonical_json(item["tags"]), item["source"], created_at, updated_at,
                                item["priority"], item["expiresAt"], canonical_json(item["relatedFiles"]),
                                canonical_json(item["relatedModules"]), item_hash, item["tier"],
                                item["importance"], 1 if item["pinned"] else 0,
                                max(0, int(candidate.get("accessCount") or 0)), item["decayRate"],
                            ),
                        )
                        imported_memories += 1
                if imported_memories:
                    con.execute(
                        "INSERT INTO settings_scope_revisions(kind, scope_type, scope_id, revision, updated_at) "
                        "VALUES('memory', 'chat', 'default', 1, ?) ON CONFLICT(kind, scope_type, scope_id) DO NOTHING",
                        (utc_now(),),
                    )
                diagnostic = (
                    f"legacy-context-migrated:profile={int(imported_profile)},memory={imported_memories}"
                )
                con.execute(
                    "INSERT INTO settings_migrations(migration_id, status, diagnostic, completed_at) "
                    "VALUES(?, 'completed', ?, ?) ON CONFLICT(migration_id) DO UPDATE SET "
                    "status = excluded.status, diagnostic = excluded.diagnostic, completed_at = excluded.completed_at",
                    (migration_id, diagnostic, utc_now()),
                )
            self.migration_diagnostic = diagnostic
        except Exception as exc:
            # Legacy corruption must not make the canonical store unavailable.
            # The original and any completed backup remain untouched for repair.
            self.migration_diagnostic = f"legacy-context-migration-failed:{type(exc).__name__}"

    def _migrate_profile_to_personality_v2(self) -> None:
        migration_id = "profile-to-personality-v2"
        try:
            with self._connection() as con:
                existing = con.execute(
                    "SELECT status, diagnostic FROM settings_migrations WHERE migration_id = ?",
                    (migration_id,),
                ).fetchone()
                if existing and existing["status"] == "completed":
                    self.migration_diagnostic += f";{existing['diagnostic']}"
                    return

                con.execute("BEGIN IMMEDIATE")
                profile_row = con.execute(
                    "SELECT content_json FROM settings_documents WHERE kind = 'profile' "
                    "AND scope_type = 'chat' AND scope_id = 'default'",
                ).fetchone()
                profile = json.loads(profile_row["content_json"]) if profile_row else {}
                personality_row = con.execute(
                    "SELECT 1 FROM settings_documents WHERE kind = 'personality' "
                    "AND scope_type = 'chat' AND scope_id = 'default'",
                ).fetchone()
                style_rules = bounded_string_list(profile.get("styleRules", []), 12, 300)
                traits = bounded_string_list(profile.get("traits", []), 12, 100)
                communication_preset = bounded_optional_text(
                    (profile.get("preferences") or {}).get("communicationPreset")
                    if isinstance(profile.get("preferences"), dict) else "",
                    40,
                )
                imported_personality = False
                if not personality_row:
                    questionnaire = questionnaire_from_legacy_profile(
                        traits, communication_preset
                    )
                    value = build_personality_document(
                        questionnaire,
                        enabled=bool(style_rules or traits),
                        selected_variant=legacy_selected_variant(communication_preset),
                        legacy_rules=style_rules,
                    )
                    now = utc_now()
                    con.execute(
                        "INSERT INTO settings_documents(kind, scope_type, scope_id, revision, content_json, "
                        "content_hash, created_at, updated_at) VALUES('personality', 'chat', 'default', 1, ?, ?, ?, ?)",
                        (canonical_json(value), sha256_json(value), now, now),
                    )
                    imported_personality = True

                adaptive_summary = bounded_optional_text(profile.get("adaptiveSummary"), 4000)
                imported_memory = False
                if adaptive_summary:
                    memory_id = "profile-v1-adaptive-summary"
                    already_imported = con.execute(
                        "SELECT 1 FROM memory_items WHERE id = ? OR "
                        "(source = 'migration-profile-v1' AND scope_type = 'chat' AND scope_id = 'default')",
                        (memory_id,),
                    ).fetchone()
                    if not already_imported:
                        item = normalize_memory_payload({
                            "category": "profile",
                            "type": "user_preference",
                            "title": "Сведения о пользователе из Profile V1",
                            "source": "migration-profile-v1",
                            "tier": "permanent",
                            "pinned": True,
                            "tags": ["migration", "profile-v1"],
                        }, adaptive_summary)
                        now = utc_now()
                        item_hash = sha256_json({
                            **item,
                            "id": memory_id,
                            "scope": {"type": "chat"},
                            "provenance": {"migration": migration_id, "sourceKind": "profile"},
                        })
                        con.execute(
                            """
                            INSERT INTO memory_items(
                                id, content, category, type, title, tags_json, enabled, source,
                                created_at, updated_at, priority, expires_at, related_files_json,
                                related_modules_json, schema_version, scope_type, scope_id,
                                revision, content_hash, deleted_at, tier, importance, pinned,
                                access_count, decay_rate
                            ) VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, '[]', '[]', 4,
                                'chat', 'default', 1, ?, NULL, ?, ?, 1, 0, 0)
                            """,
                            (
                                memory_id, adaptive_summary, item["category"], item["type"], item["title"],
                                canonical_json(item["tags"]), item["source"], now, now, item["priority"],
                                item_hash, item["tier"], item["importance"],
                            ),
                        )
                        actual_memory_revision = self._scope_revision(
                            con, "memory", "chat", "default"
                        )
                        self._bump_scope_revision(
                            con, "memory", "chat", "default", actual_memory_revision
                        )
                        imported_memory = True

                diagnostic = (
                    f"profile-personality-v2:personality={int(imported_personality)},"
                    f"memory={int(imported_memory)}"
                )
                con.execute(
                    "INSERT INTO settings_migrations(migration_id, status, diagnostic, completed_at) "
                    "VALUES(?, 'completed', ?, ?) ON CONFLICT(migration_id) DO UPDATE SET "
                    "status = excluded.status, diagnostic = excluded.diagnostic, completed_at = excluded.completed_at",
                    (migration_id, diagnostic, utc_now()),
                )
                self.migration_diagnostic += f";{diagnostic}"
        except Exception as exc:
            self.migration_diagnostic += f";profile-personality-v2-failed:{type(exc).__name__}"

    def _write_sqlite_metadata_backup(self) -> None:
        destination = self.migration_root / "sqlite-metadata.json"
        if destination.exists():
            return
        with self._connection() as con:
            user_version = int(con.execute("PRAGMA user_version").fetchone()[0])
            journal_mode = str(con.execute("PRAGMA journal_mode").fetchone()[0])
            tables = [
                str(row["name"])
                for row in con.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
                ).fetchall()
            ]
        stat = self.db_path.stat()
        metadata = {
            "schemaVersion": 1,
            "databaseFile": self.db_path.name,
            "sizeBytes": stat.st_size,
            "modifiedAt": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
            "userVersion": user_version,
            "journalMode": journal_mode,
            "tables": tables,
            "capturedAt": utc_now(),
        }
        destination.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def _update_document(
        self,
        con: sqlite3.Connection,
        kind: str,
        scope_type: str,
        scope_id: str,
        expected_revision: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        current = con.execute(
            "SELECT revision, content_json, created_at FROM settings_documents "
            "WHERE kind = ? AND scope_type = ? AND scope_id = ?",
            (kind, scope_type, scope_id),
        ).fetchone()
        actual = int(current["revision"]) if current else 0
        assert_revision(expected_revision, actual)
        base = json.loads(current["content_json"]) if current else default_document(kind)
        patch = payload.get("patch", payload)
        if not isinstance(patch, dict):
            raise ValueError("Settings document patch must be an object.")
        value = merge_document(kind, base, patch)
        revision = actual + 1
        now = utc_now()
        content_json = canonical_json(value)
        content_hash = sha256_json(value)
        con.execute(
            "INSERT INTO settings_documents(kind, scope_type, scope_id, revision, content_json, content_hash, created_at, updated_at) "
            "VALUES(?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(kind, scope_type, scope_id) DO UPDATE SET revision = excluded.revision, "
            "content_json = excluded.content_json, content_hash = excluded.content_hash, updated_at = excluded.updated_at",
            (kind, scope_type, scope_id, revision, content_json, content_hash,
             current["created_at"] if current else now, now),
        )
        return {kind: value}

    def _voice_document(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
    ) -> tuple[int, dict[str, Any], str | None]:
        assert_voice_scope(scope_type, scope_id)
        row = con.execute(
            "SELECT revision, content_json, created_at FROM settings_documents "
            "WHERE kind = 'voice' AND scope_type = ? AND scope_id = ?",
            (scope_type, scope_id),
        ).fetchone()
        if not row:
            return 0, normalize_voice_document(None), None
        return (
            int(row["revision"]),
            normalize_voice_document(json.loads(row["content_json"])),
            row["created_at"],
        )

    def _write_voice_document(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
        actual_revision: int,
        value: dict[str, Any],
        created_at: str | None,
    ) -> int:
        normalized = normalize_voice_document(value)
        revision = actual_revision + 1
        now = utc_now()
        normalized["updatedAt"] = now
        normalized["createdAt"] = created_at or normalized.get("createdAt") or now
        con.execute(
            "INSERT INTO settings_documents(kind, scope_type, scope_id, revision, content_json, content_hash, created_at, updated_at) "
            "VALUES('voice', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(kind, scope_type, scope_id) "
            "DO UPDATE SET revision = excluded.revision, content_json = excluded.content_json, "
            "content_hash = excluded.content_hash, updated_at = excluded.updated_at",
            (
                scope_type, scope_id, revision, canonical_json(normalized),
                sha256_json(normalized), normalized["createdAt"], now,
            ),
        )
        return revision

    def _update_voice_document(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
        expected_revision: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        actual, current, created_at = self._voice_document(
            con, scope_type, scope_id
        )
        assert_revision(expected_revision, actual)
        patch = payload.get("patch", payload)
        if not isinstance(patch, dict):
            raise ValueError("voice.update patch must be an object.")
        unknown = set(patch) - {"preferences", "input", "legacyPreferences"}
        if unknown:
            raise ValueError(f"Unsupported voice fields: {', '.join(sorted(unknown))}")
        legacy = patch.get("legacyPreferences")
        if isinstance(legacy, dict):
            self._backup_legacy_voice_preferences(legacy)
        value = {
            **current,
            "preferences": normalize_voice_tuning(
                patch.get("preferences", current.get("preferences")),
                allow_active_preset=True,
            ),
            "input": normalize_voice_input_preferences(
                patch.get("input", current.get("input"))
            ),
            "updatedAt": utc_now(),
        }
        revision = self._write_voice_document(
            con, scope_type, scope_id, actual, value, created_at
        )
        return {"preferences": value["preferences"], "input": value["input"], "revision": revision}

    def _backup_legacy_voice_preferences(self, value: dict[str, Any]) -> None:
        destination = self.migration_root / "voice-local-storage.json"
        if destination.exists():
            return
        self.migration_root.mkdir(parents=True, exist_ok=True)
        destination.write_text(canonical_json({
            "schemaVersion": 1,
            "storageKey": "monarch.oscar.voice.preferences",
            "preferences": normalize_voice_tuning(value, allow_active_preset=False),
            "backedUpAt": utc_now(),
        }), encoding="utf-8")

    def _create_voice_preset(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
        expected_revision: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        actual, current, created_at = self._voice_document(con, scope_type, scope_id)
        assert_revision(expected_revision, actual)
        presets = list(current["presets"])
        if len(presets) >= 24:
            raise ValueError("Voice preset limit reached.")
        now = utc_now()
        preset = {
            "schemaVersion": 2,
            "id": f"voice_preset_{uuid.uuid4().hex}",
            "name": bounded_text(payload.get("name"), 80, "Voice preset name"),
            "preferences": normalize_voice_tuning(
                payload.get("preferences", current["preferences"]),
                allow_active_preset=False,
            ),
            "createdAt": now,
            "updatedAt": now,
        }
        presets.append(preset)
        value = {
            **current,
            "presets": presets,
            "preferences": {**preset["preferences"], "activePresetId": preset["id"]},
            "updatedAt": now,
        }
        revision = self._write_voice_document(con, scope_type, scope_id, actual, value, created_at)
        return {"preset": preset, "revision": revision}

    def _update_voice_preset(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
        expected_revision: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        actual, current, created_at = self._voice_document(con, scope_type, scope_id)
        assert_revision(expected_revision, actual)
        preset_id = bounded_id(payload.get("id"), "Voice preset id")
        patch = payload.get("patch", {})
        if not isinstance(patch, dict) or set(patch) - {"name", "preferences"}:
            raise ValueError("Voice preset patch contains unsupported fields.")
        matched: dict[str, Any] | None = None
        presets: list[dict[str, Any]] = []
        for entry in current["presets"]:
            preset = normalize_voice_preset(entry)
            if preset["id"] != preset_id:
                presets.append(preset)
                continue
            matched = {
                **preset,
                "name": bounded_text(patch.get("name", preset["name"]), 80, "Voice preset name"),
                "preferences": normalize_voice_tuning(
                    patch.get("preferences", preset["preferences"]),
                    allow_active_preset=False,
                ),
                "updatedAt": utc_now(),
            }
            presets.append(matched)
        if not matched:
            raise SettingsItemNotFound(preset_id)
        preferences = current["preferences"]
        if preferences.get("activePresetId") == preset_id:
            preferences = {**matched["preferences"], "activePresetId": preset_id}
        value = {**current, "presets": presets, "preferences": preferences, "updatedAt": utc_now()}
        revision = self._write_voice_document(con, scope_type, scope_id, actual, value, created_at)
        return {"preset": matched, "revision": revision}

    def _delete_voice_preset(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
        expected_revision: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        actual, current, created_at = self._voice_document(con, scope_type, scope_id)
        assert_revision(expected_revision, actual)
        preset_id = bounded_id(payload.get("id"), "Voice preset id")
        presets = [entry for entry in current["presets"] if entry["id"] != preset_id]
        if len(presets) == len(current["presets"]):
            raise SettingsItemNotFound(preset_id)
        preferences = dict(current["preferences"])
        if preferences.get("activePresetId") == preset_id:
            preferences["activePresetId"] = None
        value = {**current, "presets": presets, "preferences": preferences, "updatedAt": utc_now()}
        revision = self._write_voice_document(con, scope_type, scope_id, actual, value, created_at)
        return {"deletedId": preset_id, "revision": revision}

    def _create_voice_pronunciation(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
        expected_revision: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        actual, current, created_at = self._voice_document(con, scope_type, scope_id)
        assert_revision(expected_revision, actual)
        rules = list(current["pronunciations"])
        if len(rules) >= 128:
            raise ValueError("Voice pronunciation rule limit reached.")
        now = utc_now()
        rule = normalize_voice_pronunciation({
            **payload,
            "id": f"voice_pronunciation_{uuid.uuid4().hex}",
            "createdAt": now,
            "updatedAt": now,
        })
        rules.append(rule)
        value = {**current, "pronunciations": rules, "updatedAt": now}
        revision = self._write_voice_document(con, scope_type, scope_id, actual, value, created_at)
        return {"pronunciation": rule, "revision": revision}

    def _update_voice_pronunciation(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
        expected_revision: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        actual, current, created_at = self._voice_document(con, scope_type, scope_id)
        assert_revision(expected_revision, actual)
        rule_id = bounded_id(payload.get("id"), "Voice pronunciation id")
        patch = payload.get("patch", {})
        if not isinstance(patch, dict) or set(patch) - {"word", "pronunciation", "context", "enabled"}:
            raise ValueError("Voice pronunciation patch contains unsupported fields.")
        matched: dict[str, Any] | None = None
        rules: list[dict[str, Any]] = []
        for entry in current["pronunciations"]:
            if entry["id"] != rule_id:
                rules.append(entry)
                continue
            matched = normalize_voice_pronunciation({**entry, **patch, "updatedAt": utc_now()})
            rules.append(matched)
        if not matched:
            raise SettingsItemNotFound(rule_id)
        value = {**current, "pronunciations": rules, "updatedAt": utc_now()}
        revision = self._write_voice_document(con, scope_type, scope_id, actual, value, created_at)
        return {"pronunciation": matched, "revision": revision}

    def _delete_voice_pronunciation(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
        expected_revision: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        actual, current, created_at = self._voice_document(con, scope_type, scope_id)
        assert_revision(expected_revision, actual)
        rule_id = bounded_id(payload.get("id"), "Voice pronunciation id")
        rules = [entry for entry in current["pronunciations"] if entry["id"] != rule_id]
        if len(rules) == len(current["pronunciations"]):
            raise SettingsItemNotFound(rule_id)
        value = {**current, "pronunciations": rules, "updatedAt": utc_now()}
        revision = self._write_voice_document(con, scope_type, scope_id, actual, value, created_at)
        return {"deletedId": rule_id, "revision": revision}

    def _create_personality_profiles(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
        expected_revision: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        actual, current, created_at = self._personality_document(
            con, scope_type, scope_id
        )
        assert_revision(expected_revision, actual)
        questionnaire = normalize_personality_questionnaire(
            payload.get("questionnaire", current.get("questionnaire"))
        )
        selected = selected_variant(current)
        value = build_personality_document(
            questionnaire,
            enabled=bool(current.get("enabled", False)),
            selected_variant=selected,
            existing=current,
        )
        revision = self._write_personality_document(
            con, scope_type, scope_id, actual, value, created_at
        )
        return {"personality": value, "revision": revision}

    def _update_personality_profile(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
        expected_revision: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        actual, current, created_at = self._personality_document(
            con, scope_type, scope_id
        )
        assert_revision(expected_revision, actual)
        profile_id = bounded_id(payload.get("profileId"), "Personality profile id")
        patch = payload.get("patch", {})
        if not isinstance(patch, dict):
            raise ValueError("Personality profile patch must be an object.")
        unknown = set(patch) - {
            "name", "dimensions", "addressForm", "language", "customRules"
        }
        if unknown:
            raise ValueError(
                f"Unsupported personality fields: {', '.join(sorted(unknown))}"
            )
        profiles = current.get("profiles") if isinstance(current.get("profiles"), list) else []
        updated_profiles: list[dict[str, Any]] = []
        matched = False
        for raw in profiles:
            profile = normalize_personality_profile(raw)
            if profile["id"] != profile_id:
                updated_profiles.append(profile)
                continue
            matched = True
            now = utc_now()
            next_profile = {
                **profile,
                "name": bounded_text(
                    patch.get("name", profile["name"]), 80, "Personality profile name"
                ),
                "dimensions": normalize_personality_dimensions(
                    patch.get("dimensions", profile["dimensions"])
                ),
                "addressForm": normalize_address_form(
                    patch.get("addressForm", profile["addressForm"])
                ),
                "language": normalize_personality_language(
                    patch.get("language", profile["language"])
                ),
                "customRules": bounded_string_list(
                    patch.get("customRules", profile["customRules"]), 12, 300
                ),
                "revision": int(profile["revision"]) + 1,
                "updatedAt": now,
            }
            next_profile["contentHash"] = personality_profile_hash(next_profile)
            updated_profiles.append(next_profile)
        if not matched:
            raise SettingsItemNotFound(profile_id)
        value = {
            **current,
            "profiles": updated_profiles,
            "updatedAt": utc_now(),
        }
        revision = self._write_personality_document(
            con, scope_type, scope_id, actual, value, created_at
        )
        return {"profile": next(
            profile for profile in updated_profiles if profile["id"] == profile_id
        ), "revision": revision}

    def _select_personality_profile(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
        expected_revision: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        actual, current, created_at = self._personality_document(
            con, scope_type, scope_id
        )
        assert_revision(expected_revision, actual)
        profile_id = bounded_id(payload.get("profileId"), "Personality profile id")
        profiles = [normalize_personality_profile(entry) for entry in current.get("profiles", [])]
        if not any(profile["id"] == profile_id for profile in profiles):
            raise SettingsItemNotFound(profile_id)
        value = {
            **current,
            "profiles": profiles,
            "selectedProfileId": profile_id,
            "updatedAt": utc_now(),
        }
        revision = self._write_personality_document(
            con, scope_type, scope_id, actual, value, created_at
        )
        return {"selectedProfileId": profile_id, "revision": revision}

    def _set_personalization_enabled(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
        expected_revision: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        actual, current, created_at = self._personality_document(
            con, scope_type, scope_id
        )
        assert_revision(expected_revision, actual)
        enabled = payload.get("enabled")
        if not isinstance(enabled, bool):
            raise ValueError("personality.personalization.set requires boolean enabled.")
        profiles = [normalize_personality_profile(entry) for entry in current.get("profiles", [])]
        selected = str(current.get("selectedProfileId") or "")
        if enabled and not any(profile["id"] == selected for profile in profiles):
            raise ValueError("Select an existing personality profile before enabling personalization.")
        value = {
            **current,
            "profiles": profiles,
            "enabled": enabled,
            "updatedAt": utc_now(),
        }
        revision = self._write_personality_document(
            con, scope_type, scope_id, actual, value, created_at
        )
        return {"enabled": enabled, "revision": revision}

    def _copy_personality_scope(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
        expected_revision: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        actual, current, created_at = self._personality_document(
            con, scope_type, scope_id
        )
        assert_revision(expected_revision, actual)
        source_scope = payload.get("sourceScope")
        if not isinstance(source_scope, dict):
            raise ValueError("personality.scope.copy requires sourceScope.")
        source_type, source_id = normalize_scope(source_scope)
        if (source_type, source_id) == (scope_type, scope_id):
            raise ValueError("Personality source and destination scopes must differ.")
        _source_revision, source, _source_created = self._personality_document(
            con, source_type, source_id
        )
        source_profiles = [
            normalize_personality_profile(entry) for entry in source.get("profiles", [])
        ]
        if len(source_profiles) != 3:
            raise ValueError("Source scope does not contain a complete three-profile set.")
        now = utc_now()
        current_by_variant = {
            str(entry.get("variant")): normalize_personality_profile(entry)
            for entry in current.get("profiles", []) if isinstance(entry, dict)
        }
        copied_profiles: list[dict[str, Any]] = []
        for source_profile in source_profiles:
            previous = current_by_variant.get(source_profile["variant"])
            copied = {
                **source_profile,
                "revision": int(previous["revision"]) + 1 if previous else 1,
                "createdAt": previous["createdAt"] if previous else now,
                "updatedAt": now,
            }
            copied["contentHash"] = personality_profile_hash(copied)
            copied_profiles.append(copied)
        selected_source = str(source.get("selectedProfileId") or "")
        value = {
            "schemaVersion": 2,
            "enabled": bool(source.get("enabled", False)),
            "selectedProfileId": selected_source if any(
                profile["id"] == selected_source for profile in copied_profiles
            ) else copied_profiles[0]["id"],
            "questionnaire": normalize_personality_questionnaire(
                source.get("questionnaire")
            ),
            "profiles": copied_profiles,
            "createdAt": current.get("createdAt") or created_at or now,
            "updatedAt": now,
            "copiedFrom": render_scope(source_type, source_id),
        }
        revision = self._write_personality_document(
            con, scope_type, scope_id, actual, value, created_at
        )
        return {
            "copiedFrom": render_scope(source_type, source_id),
            "profileCount": 3,
            "revision": revision,
        }

    def _personality_document(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
    ) -> tuple[int, dict[str, Any], str | None]:
        row = con.execute(
            "SELECT revision, content_json, created_at FROM settings_documents "
            "WHERE kind = 'personality' AND scope_type = ? AND scope_id = ?",
            (scope_type, scope_id),
        ).fetchone()
        if not row:
            value = build_personality_document(
                normalize_personality_questionnaire(None),
                enabled=False,
                selected_variant="restrained",
            )
            return 0, value, None
        return int(row["revision"]), normalize_personality_document(
            json.loads(row["content_json"])
        ), row["created_at"]

    def _write_personality_document(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
        actual_revision: int,
        value: dict[str, Any],
        created_at: str | None,
    ) -> int:
        normalized = normalize_personality_document(value)
        revision = actual_revision + 1
        now = utc_now()
        normalized["updatedAt"] = now
        normalized.setdefault("createdAt", created_at or now)
        con.execute(
            "INSERT INTO settings_documents(kind, scope_type, scope_id, revision, content_json, content_hash, created_at, updated_at) "
            "VALUES('personality', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(kind, scope_type, scope_id) "
            "DO UPDATE SET revision = excluded.revision, content_json = excluded.content_json, "
            "content_hash = excluded.content_hash, updated_at = excluded.updated_at",
            (
                scope_type, scope_id, revision, canonical_json(normalized),
                sha256_json(normalized), created_at or normalized["createdAt"], now,
            ),
        )
        return revision

    def _create_memory(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
        expected_revision: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        actual = self._scope_revision(con, "memory", scope_type, scope_id)
        assert_revision(expected_revision, actual)
        content = bounded_text(payload.get("text", payload.get("content")), 4000, "Memory text")
        now = utc_now()
        item_id = uuid.uuid4().hex
        item = normalize_memory_payload(payload, content)
        content_hash = sha256_json({**item, "id": item_id, "scope": render_scope(scope_type, scope_id)})
        con.execute(
            """
            INSERT INTO memory_items(
                id, content, category, type, title, tags_json, enabled, source,
                created_at, updated_at, priority, expires_at, related_files_json,
                related_modules_json, schema_version, scope_type, scope_id,
                revision, content_hash, deleted_at, tier, importance, pinned,
                access_count, decay_rate
            ) VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 4, ?, ?, 1, ?, NULL, ?, ?, ?, 0, ?)
            """,
            (
                item_id, content, item["category"], item["type"], item["title"],
                canonical_json(item["tags"]), item["source"], now, now,
                item["priority"], item["expiresAt"], canonical_json(item["relatedFiles"]),
                canonical_json(item["relatedModules"]), scope_type, scope_id, content_hash,
                item["tier"], item["importance"], 1 if item["pinned"] else 0,
                item["decayRate"],
            ),
        )
        self._bump_scope_revision(con, "memory", scope_type, scope_id, actual)
        row = con.execute("SELECT * FROM memory_items WHERE id = ?", (item_id,)).fetchone()
        return {"record": self._memory_record(row)}

    def _update_memory(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
        expected_revision: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        actual = self._scope_revision(con, "memory", scope_type, scope_id)
        assert_revision(expected_revision, actual)
        item_id = bounded_id(payload.get("id"), "Memory id")
        row = con.execute(
            "SELECT * FROM memory_items WHERE id = ? AND scope_type = ? AND scope_id = ? AND deleted_at IS NULL",
            (item_id, scope_type, scope_id),
        ).fetchone()
        if not row:
            raise SettingsItemNotFound(item_id)
        merged_payload = {
            "text": row["content"],
            "category": row["category"],
            "type": row["type"],
            "title": row["title"],
            "tags": decode_string_list(row["tags_json"]),
            "priority": row["priority"],
            "expiresAt": row["expires_at"],
            "relatedFiles": decode_string_list(row["related_files_json"]),
            "relatedModules": decode_string_list(row["related_modules_json"]),
            "tier": row["tier"],
            "importance": row["importance"],
            "pinned": bool(row["pinned"]),
            "source": row["source"],
            **payload,
        }
        content = bounded_text(merged_payload.get("text"), 4000, "Memory text")
        item = normalize_memory_payload(merged_payload, content)
        enabled = merged_payload.get("enabled", bool(row["enabled"]))
        if not isinstance(enabled, bool):
            raise ValueError("Memory enabled must be boolean.")
        closed = merged_payload.get("closed", bool(row["closed_at"]))
        if not isinstance(closed, bool):
            raise ValueError("Memory closed must be boolean.")
        closed_at = row["closed_at"] or utc_now() if closed else None
        item_revision = int(row["revision"]) + 1
        content_hash = sha256_json({
            **item,
            "id": item_id,
            "scope": render_scope(scope_type, scope_id),
            "enabled": enabled,
            "closedAt": closed_at,
        })
        con.execute(
            "UPDATE memory_items SET content = ?, category = ?, type = ?, title = ?, tags_json = ?, "
            "source = ?, updated_at = ?, priority = ?, expires_at = ?, related_files_json = ?, "
            "related_modules_json = ?, revision = ?, content_hash = ?, tier = ?, importance = ?, "
            "pinned = ?, decay_rate = ?, enabled = ?, closed_at = ? WHERE id = ?",
            (
                content, item["category"], item["type"], item["title"], canonical_json(item["tags"]),
                item["source"], utc_now(), item["priority"], item["expiresAt"],
                canonical_json(item["relatedFiles"]), canonical_json(item["relatedModules"]),
                item_revision, content_hash, item["tier"], item["importance"],
                1 if item["pinned"] else 0, item["decayRate"], 1 if enabled else 0, closed_at, item_id,
            ),
        )
        self._bump_scope_revision(con, "memory", scope_type, scope_id, actual)
        updated = con.execute("SELECT * FROM memory_items WHERE id = ?", (item_id,)).fetchone()
        return {"record": self._memory_record(updated)}

    def _set_memory_deleted(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
        expected_revision: int,
        payload: dict[str, Any],
        deleted: bool,
    ) -> dict[str, Any]:
        actual = self._scope_revision(con, "memory", scope_type, scope_id)
        assert_revision(expected_revision, actual)
        item_id = bounded_id(payload.get("id"), "Memory id")
        row = con.execute(
            "SELECT * FROM memory_items WHERE id = ? AND scope_type = ? AND scope_id = ?",
            (item_id, scope_type, scope_id),
        ).fetchone()
        if not row:
            raise SettingsItemNotFound(item_id)
        deleted_at = utc_now() if deleted else None
        con.execute(
            "UPDATE memory_items SET deleted_at = ?, enabled = ?, updated_at = ?, revision = revision + 1 WHERE id = ?",
            (deleted_at, 0 if deleted else 1, utc_now(), item_id),
        )
        self._bump_scope_revision(con, "memory", scope_type, scope_id, actual)
        return {"id": item_id, "deleted": deleted}

    def _set_cross_chat_enabled(
        self,
        con: sqlite3.Connection,
        scope_type: str,
        scope_id: str,
        expected_revision: int,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        actual = self._scope_revision(con, "memory", scope_type, scope_id)
        assert_revision(expected_revision, actual)
        enabled = payload.get("enabled")
        if not isinstance(enabled, bool):
            raise ValueError("memory.cross-chat.set requires a boolean enabled field.")
        con.execute(
            "INSERT INTO memory_scope_preferences(scope_type, scope_id, cross_chat_enabled, updated_at) "
            "VALUES(?, ?, ?, ?) ON CONFLICT(scope_type, scope_id) DO UPDATE SET "
            "cross_chat_enabled = excluded.cross_chat_enabled, updated_at = excluded.updated_at",
            (scope_type, scope_id, 1 if enabled else 0, utc_now()),
        )
        self._bump_scope_revision(con, "memory", scope_type, scope_id, actual)
        return {"crossChatEnabled": enabled}

    def _scope_revision(self, con: sqlite3.Connection, kind: str, scope_type: str, scope_id: str) -> int:
        row = con.execute(
            "SELECT revision FROM settings_scope_revisions WHERE kind = ? AND scope_type = ? AND scope_id = ?",
            (kind, scope_type, scope_id),
        ).fetchone()
        return int(row["revision"]) if row else 0

    def _bump_scope_revision(
        self,
        con: sqlite3.Connection,
        kind: str,
        scope_type: str,
        scope_id: str,
        actual: int,
    ) -> int:
        revision = actual + 1
        con.execute(
            "INSERT INTO settings_scope_revisions(kind, scope_type, scope_id, revision, updated_at) "
            "VALUES(?, ?, ?, ?, ?) ON CONFLICT(kind, scope_type, scope_id) "
            "DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at",
            (kind, scope_type, scope_id, revision, utc_now()),
        )
        return revision

    def _memory_record(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "schemaVersion": 4,
            "id": row["id"],
            "text": row["content"],
            "content": row["content"],
            "type": row["type"],
            "title": row["title"],
            "tags": decode_string_list(row["tags_json"]),
            "source": row["source"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "category": row["category"],
            "tier": row["tier"],
            "importance": float(row["importance"]),
            "priority": float(row["priority"]),
            "accessCount": int(row["access_count"]),
            "pinned": bool(row["pinned"]),
            "enabled": bool(row["enabled"]),
            "decayRate": float(row["decay_rate"]),
            "expiresAt": row["expires_at"],
            "closedAt": row["closed_at"],
            "deletedAt": row["deleted_at"],
            "relatedFiles": decode_string_list(row["related_files_json"]),
            "relatedModules": decode_string_list(row["related_modules_json"]),
            "scope": render_scope(row["scope_type"], row["scope_id"]),
            "revision": int(row["revision"]),
            "contentHash": row["content_hash"],
        }

    @staticmethod
    def _memory_hash_payload(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "content": row["content"],
            "category": row["category"],
            "type": row["type"],
            "title": row["title"],
            "tags": decode_string_list(row["tags_json"]),
            "priority": row["priority"],
            "source": row["source"],
            "scope": render_scope(row["scope_type"], row["scope_id"]),
            "revision": row["revision"],
        }


def normalize_scope(scope: dict[str, str | None]) -> tuple[str, str]:
    scope_type = str(scope.get("type") or "").strip()
    project_id = str(scope.get("projectId") or scope.get("project_id") or "").strip()
    if scope_type == "chat" and not project_id:
        return "chat", "default"
    if scope_type == "coder-project" and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,159}", project_id):
        return scope_type, project_id
    raise ValueError("Invalid settings scope.")


def render_scope(scope_type: str, scope_id: str) -> dict[str, str]:
    return {"type": "chat"} if scope_type == "chat" else {"type": scope_type, "projectId": scope_id}


PERSONALITY_DIMENSION_KEYS = (
    "brevity", "warmth", "directness", "initiative", "humor",
    "skepticism", "technicalDepth", "structure",
)
PERSONALITY_VARIANTS = ("restrained", "direct", "lively")
PERSONALITY_VARIANT_NAMES = {
    "restrained": "Сдержанный",
    "direct": "Прямой",
    "lively": "Живой",
}
DEFAULT_PERSONALITY_DIMENSIONS = {
    "brevity": 62,
    "warmth": 52,
    "directness": 68,
    "initiative": 52,
    "humor": 28,
    "skepticism": 62,
    "technicalDepth": 68,
    "structure": 66,
}


def normalize_personality_dimensions(value: Any) -> dict[str, int]:
    source = value if isinstance(value, dict) else {}
    result: dict[str, int] = {}
    for key in PERSONALITY_DIMENSION_KEYS:
        candidate = source.get(key, DEFAULT_PERSONALITY_DIMENSIONS[key])
        if isinstance(candidate, bool):
            candidate = DEFAULT_PERSONALITY_DIMENSIONS[key]
        try:
            number = int(round(float(candidate)))
        except (TypeError, ValueError):
            number = DEFAULT_PERSONALITY_DIMENSIONS[key]
        result[key] = max(0, min(number, 100))
    return result


def normalize_address_form(value: Any) -> str:
    candidate = str(value or "ты").strip().lower()
    return candidate if candidate in {"ты", "вы", "neutral"} else "ты"


def normalize_personality_language(value: Any) -> str:
    candidate = str(value or "auto").strip().lower()
    return candidate if candidate in {"auto", "ru", "en", "uk", "bg"} else "auto"


def normalize_personality_questionnaire(value: Any) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    return {
        **normalize_personality_dimensions(source),
        "addressForm": normalize_address_form(source.get("addressForm")),
        "language": normalize_personality_language(source.get("language")),
    }


def shifted_dimension(base: dict[str, Any], key: str, amount: int) -> int:
    return max(0, min(int(base[key]) + amount, 100))


def variant_dimensions(questionnaire: dict[str, Any], variant: str) -> dict[str, int]:
    base = normalize_personality_dimensions(questionnaire)
    shifts = {
        "restrained": {
            "brevity": 14, "warmth": -12, "directness": 0, "initiative": -14,
            "humor": -18, "skepticism": 6, "technicalDepth": 0, "structure": 14,
        },
        "direct": {
            "brevity": 8, "warmth": -8, "directness": 20, "initiative": 4,
            "humor": -10, "skepticism": 12, "technicalDepth": 10, "structure": 8,
        },
        "lively": {
            "brevity": -10, "warmth": 20, "directness": 2, "initiative": 16,
            "humor": 24, "skepticism": -5, "technicalDepth": 0, "structure": -4,
        },
    }[variant]
    return {key: shifted_dimension(base, key, shifts[key]) for key in PERSONALITY_DIMENSION_KEYS}


def personality_profile_hash(profile: dict[str, Any]) -> str:
    return sha256_json({
        "schemaVersion": 2,
        "id": profile["id"],
        "variant": profile["variant"],
        "name": profile["name"],
        "revision": profile["revision"],
        "dimensions": profile["dimensions"],
        "addressForm": profile["addressForm"],
        "language": profile["language"],
        "customRules": profile["customRules"],
    })


def normalize_personality_profile(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Personality profile must be an object.")
    variant = str(value.get("variant") or "").strip()
    if variant not in PERSONALITY_VARIANTS:
        raise ValueError("Personality profile variant is invalid.")
    try:
        revision = int(value.get("revision") or 1)
    except (TypeError, ValueError):
        revision = 1
    now = utc_now()
    profile = {
        "schemaVersion": 2,
        "id": bounded_id(value.get("id") or f"personality-{variant}", "Personality profile id"),
        "variant": variant,
        "name": bounded_text(
            value.get("name") or PERSONALITY_VARIANT_NAMES[variant], 80,
            "Personality profile name",
        ),
        "revision": max(1, revision),
        "dimensions": normalize_personality_dimensions(value.get("dimensions")),
        "addressForm": normalize_address_form(value.get("addressForm")),
        "language": normalize_personality_language(value.get("language")),
        "customRules": bounded_string_list(value.get("customRules", []), 12, 300),
        "createdAt": bounded_optional_text(value.get("createdAt"), 80) or now,
        "updatedAt": bounded_optional_text(value.get("updatedAt"), 80) or now,
    }
    profile["contentHash"] = personality_profile_hash(profile)
    return profile


def build_personality_document(
    questionnaire_value: Any,
    *,
    enabled: bool,
    selected_variant: str,
    existing: dict[str, Any] | None = None,
    legacy_rules: list[str] | None = None,
) -> dict[str, Any]:
    questionnaire = normalize_personality_questionnaire(questionnaire_value)
    current = existing if isinstance(existing, dict) else {}
    current_profiles = current.get("profiles") if isinstance(current.get("profiles"), list) else []
    by_variant: dict[str, dict[str, Any]] = {}
    for entry in current_profiles:
        try:
            normalized = normalize_personality_profile(entry)
            by_variant[normalized["variant"]] = normalized
        except (ValueError, TypeError):
            continue
    now = utc_now()
    profiles: list[dict[str, Any]] = []
    for variant in PERSONALITY_VARIANTS:
        previous = by_variant.get(variant)
        custom_rules = previous["customRules"] if previous else (
            bounded_string_list(legacy_rules or [], 12, 300) if variant == "restrained" else []
        )
        profile = {
            "schemaVersion": 2,
            "id": previous["id"] if previous else f"personality-{variant}",
            "variant": variant,
            "name": previous["name"] if previous else PERSONALITY_VARIANT_NAMES[variant],
            "revision": int(previous["revision"]) + 1 if previous else 1,
            "dimensions": variant_dimensions(questionnaire, variant),
            "addressForm": questionnaire["addressForm"],
            "language": questionnaire["language"],
            "customRules": custom_rules,
            "createdAt": previous["createdAt"] if previous else now,
            "updatedAt": now,
        }
        profile["contentHash"] = personality_profile_hash(profile)
        profiles.append(profile)
    selected = selected_variant if selected_variant in PERSONALITY_VARIANTS else "restrained"
    selected_profile_id = next(
        profile["id"] for profile in profiles if profile["variant"] == selected
    )
    return {
        "schemaVersion": 2,
        "enabled": bool(enabled),
        "selectedProfileId": selected_profile_id,
        "questionnaire": questionnaire,
        "profiles": profiles,
        "createdAt": bounded_optional_text(current.get("createdAt"), 80) or now,
        "updatedAt": now,
    }


def normalize_personality_document(value: Any) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    questionnaire = normalize_personality_questionnaire(source.get("questionnaire"))
    raw_profiles = source.get("profiles") if isinstance(source.get("profiles"), list) else []
    profiles: list[dict[str, Any]] = []
    seen_variants: set[str] = set()
    for entry in raw_profiles:
        try:
            profile = normalize_personality_profile(entry)
        except (ValueError, TypeError):
            continue
        if profile["variant"] in seen_variants:
            continue
        seen_variants.add(profile["variant"])
        profiles.append(profile)
    if set(seen_variants) != set(PERSONALITY_VARIANTS):
        return build_personality_document(
            questionnaire,
            enabled=bool(source.get("enabled", False)),
            selected_variant=selected_variant(source),
            existing=source,
        )
    profiles.sort(key=lambda profile: PERSONALITY_VARIANTS.index(profile["variant"]))
    selected_id = str(source.get("selectedProfileId") or "")
    if not any(profile["id"] == selected_id for profile in profiles):
        selected_id = profiles[0]["id"]
    now = utc_now()
    return {
        "schemaVersion": 2,
        "enabled": bool(source.get("enabled", False)),
        "selectedProfileId": selected_id,
        "questionnaire": questionnaire,
        "profiles": profiles,
        "createdAt": bounded_optional_text(source.get("createdAt"), 80) or now,
        "updatedAt": bounded_optional_text(source.get("updatedAt"), 80) or now,
    }


def selected_variant(document: dict[str, Any]) -> str:
    selected_id = str(document.get("selectedProfileId") or "")
    profiles = document.get("profiles") if isinstance(document.get("profiles"), list) else []
    for entry in profiles:
        if isinstance(entry, dict) and entry.get("id") == selected_id:
            variant = str(entry.get("variant") or "")
            if variant in PERSONALITY_VARIANTS:
                return variant
    return "restrained"


def legacy_selected_variant(preset: str) -> str:
    return {
        "concise": "direct",
        "technical": "direct",
        "warm": "lively",
        "balanced": "restrained",
    }.get(preset, "restrained")


def questionnaire_from_legacy_profile(traits: list[str], preset: str) -> dict[str, Any]:
    questionnaire = normalize_personality_questionnaire(None)
    words = " ".join(traits).casefold()
    if preset == "concise" or "крат" in words or "собран" in words:
        questionnaire["brevity"] = 85
    if preset == "warm" or "тёп" in words or "игрив" in words:
        questionnaire["warmth"] = 82
        questionnaire["humor"] = 58
    if preset == "technical" or "инженер" in words or "точн" in words:
        questionnaire["technicalDepth"] = 88
        questionnaire["skepticism"] = 82
        questionnaire["structure"] = 82
    if "прям" in words:
        questionnaire["directness"] = 84
    return questionnaire


VOICE_IDS = {"oscar", "oscar-clear", "aurora"}
VOICE_STYLES = {"natural", "calm", "warm", "focused", "energetic"}


def assert_voice_scope(scope_type: str, scope_id: str) -> None:
    if scope_type != "chat" or scope_id != "default":
        raise ValueError("Voice settings are global to the local Desktop Chat scope.")


def normalize_voice_document(value: Any) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    now = utc_now()
    presets = [
        normalize_voice_preset(entry)
        for entry in source.get("presets", [])
        if isinstance(entry, dict)
    ][:24]
    preset_ids = {entry["id"] for entry in presets}
    preferences = normalize_voice_tuning(
        source.get("preferences"), allow_active_preset=True
    )
    if preferences["activePresetId"] not in preset_ids:
        preferences["activePresetId"] = None
    pronunciations = [
        normalize_voice_pronunciation(entry)
        for entry in source.get("pronunciations", [])
        if isinstance(entry, dict)
    ][:128]
    return {
        "schemaVersion": 2,
        "preferences": preferences,
        "presets": presets,
        "pronunciations": pronunciations,
        "input": normalize_voice_input_preferences(source.get("input")),
        "createdAt": bounded_optional_text(source.get("createdAt"), 80) or now,
        "updatedAt": bounded_optional_text(source.get("updatedAt"), 80) or now,
    }


def normalize_voice_tuning(value: Any, *, allow_active_preset: bool) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    voice = str(source.get("voice") or "oscar").strip().lower()
    style = str(source.get("style") or "natural").strip().lower()
    active_preset_id = bounded_optional_text(source.get("activePresetId"), 256) or None
    normalized = {
        "voice": voice if voice in VOICE_IDS else "oscar",
        "style": style if style in VOICE_STYLES else "natural",
        "speed": bounded_integer(source.get("speed"), 80, 120, 100),
        "pitch": bounded_integer(source.get("pitch"), -2, 2, 0),
        "expressiveness": bounded_integer(source.get("expressiveness"), 0, 100, 55),
        "pauseMs": bounded_integer(source.get("pauseMs"), 40, 400, 80),
        "volume": bounded_integer(source.get("volume"), 20, 100, 100),
        "instruction": bounded_optional_text(source.get("instruction"), 300),
    }
    if allow_active_preset:
        normalized["activePresetId"] = active_preset_id
    return normalized


def normalize_voice_input_preferences(value: Any) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    return {
        "schemaVersion": 1,
        "autoSendAfterDictation": source.get("autoSendAfterDictation") is True,
    }


def normalize_voice_preset(value: dict[str, Any]) -> dict[str, Any]:
    now = utc_now()
    return {
        "schemaVersion": 2,
        "id": bounded_id(value.get("id"), "Voice preset id"),
        "name": bounded_text(value.get("name"), 80, "Voice preset name"),
        "preferences": normalize_voice_tuning(
            value.get("preferences"), allow_active_preset=False
        ),
        "createdAt": bounded_optional_text(value.get("createdAt"), 80) or now,
        "updatedAt": bounded_optional_text(value.get("updatedAt"), 80) or now,
    }


def normalize_voice_pronunciation(value: dict[str, Any]) -> dict[str, Any]:
    now = utc_now()
    word = bounded_text(value.get("word"), 80, "Pronunciation word")
    pronunciation = bounded_text(
        value.get("pronunciation"), 100, "Pronunciation value"
    )
    plain_word = re.sub(r"[+\u0301]", "", word).casefold()
    plain_pronunciation = re.sub(r"[+\u0301]", "", pronunciation).casefold()
    whole_word = r"[^\W\d_]+(?:[-'][^\W\d_]+)*"
    if not re.fullmatch(whole_word, word, flags=re.UNICODE):
        raise ValueError("Pronunciation word must be one whole word without regex syntax.")
    if plain_pronunciation != plain_word or not re.fullmatch(
        r"[^\W\d_+\u0301]+(?:[+\u0301]?[^\W\d_+\u0301]+)*(?:[-'][^\W\d_+\u0301]+(?:[+\u0301]?[^\W\d_+\u0301]+)*)?",
        pronunciation,
        flags=re.UNICODE,
    ):
        raise ValueError("Pronunciation may only add a stress mark to the same whole word.")
    stress_marks = pronunciation.count("+") + pronunciation.count("\u0301")
    if stress_marks != 1:
        raise ValueError("Pronunciation must contain exactly one explicit stress mark.")
    vowels = "аеёиоуыэюяАЕЁИОУЫЭЮЯ"
    if "+" in pronunciation and not re.search(rf"\+[{vowels}]", pronunciation):
        raise ValueError("Plus stress notation must appear immediately before a vowel.")
    if "\u0301" in pronunciation and not re.search(rf"[{vowels}]\u0301", pronunciation):
        raise ValueError("Combining stress notation must appear immediately after a vowel.")
    enabled = value.get("enabled", True)
    if not isinstance(enabled, bool):
        raise ValueError("Pronunciation enabled must be boolean.")
    return {
        "schemaVersion": 1,
        "id": bounded_id(value.get("id"), "Voice pronunciation id"),
        "word": word,
        "pronunciation": pronunciation,
        "context": bounded_optional_text(value.get("context"), 240),
        "enabled": enabled,
        "createdAt": bounded_optional_text(value.get("createdAt"), 80) or now,
        "updatedAt": bounded_optional_text(value.get("updatedAt"), 80) or now,
    }


def bounded_integer(value: Any, minimum: int, maximum: int, fallback: int) -> int:
    try:
        parsed = round(float(value))
    except (TypeError, ValueError):
        parsed = fallback
    return max(minimum, min(maximum, int(parsed)))


def assert_prompt_scope(scope_type: str, scope_id: str) -> None:
    if scope_type != "chat" or scope_id != "default":
        raise ValueError("Oscar prompts support only the global chat scope.")


def render_prompt_definition(definition, override: Any) -> dict[str, Any]:
    overridden = isinstance(override, str) and bool(override.strip())
    content = override if overridden else definition.default_content
    return {
        "id": definition.id,
        "title": definition.title,
        "description": definition.description,
        "lane": definition.lane,
        "language": definition.language,
        "content": content,
        "defaultContent": definition.default_content,
        "overridden": overridden,
        "contentHash": hashlib.sha256(content.encode("utf-8")).hexdigest(),
        "defaultHash": hashlib.sha256(definition.default_content.encode("utf-8")).hexdigest(),
        "maxCharacters": definition.max_characters,
        "defaultVersion": definition.default_version,
    }


def default_document(kind: str) -> dict[str, Any]:
    if kind == "profile":
        return {
            "version": 1,
            "displayName": "Monarch",
            "adaptiveSummary": "",
            "traits": [],
            "styleRules": [],
            "boundaries": [],
            "preferences": {},
            "createdAt": "",
            "updatedAt": "",
        }
    if kind == "voice":
        return normalize_voice_document(None)
    if kind == "personality":
        return build_personality_document(
            normalize_personality_questionnaire(None),
            enabled=False,
            selected_variant="restrained",
        )
    raise ValueError("Unknown settings document kind.")


def merge_document(kind: str, base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    if kind == "voice":
        unknown = set(patch) - {"preferences", "input"}
        if unknown:
            raise ValueError(f"Unsupported voice fields: {', '.join(sorted(unknown))}")
        return normalize_voice_document({
            **base,
            **patch,
            "updatedAt": utc_now(),
        })
    allowed = {
        "profile": {"displayName", "adaptiveSummary", "traits", "styleRules", "boundaries", "preferences"},
    }.get(kind, set())
    unknown = set(patch) - allowed
    if unknown:
        raise ValueError(f"Unsupported {kind} fields: {', '.join(sorted(unknown))}")
    result = dict(base)
    for key, value in patch.items():
        if key in {"displayName", "adaptiveSummary"}:
            result[key] = bounded_optional_text(value, 4000)
        elif key in {"traits", "styleRules", "boundaries"}:
            result[key] = bounded_string_list(value, 64, 500)
        elif key == "preferences":
            result[key] = bounded_string_record(value, 64, 500)
        else:
            result[key] = json_safe(value)
    now = utc_now()
    result.setdefault("createdAt", now)
    if not result.get("createdAt"):
        result["createdAt"] = now
    result["updatedAt"] = now
    return result


def normalize_memory_payload(payload: dict[str, Any], content: str) -> dict[str, Any]:
    category = str(payload.get("category") or "note").strip().lower()
    if category not in {"fact", "preference", "project", "correction", "note", "other", "instruction", "profile"}:
        category = "note"
    entry_type = str(payload.get("type") or "").strip() or (
        "user_preference" if category in {"preference", "profile"} else "planning_note"
    )
    tier = str(payload.get("tier") or "long").strip()
    if tier not in {"working", "long", "permanent"}:
        tier = "long"
    pinned = bool(payload.get("pinned")) or tier == "permanent"
    importance = bounded_number(payload.get("importance"), 0.95 if pinned else 0.65)
    priority = bounded_number(payload.get("priority"), importance)
    return {
        "category": category,
        "type": entry_type[:80],
        "title": bounded_optional_text(payload.get("title"), 160) or content[:160],
        "tags": bounded_string_list(payload.get("tags", []), 12, 80),
        "source": bounded_optional_text(payload.get("source"), 80) or "settings-ui",
        "priority": priority,
        "importance": importance,
        "tier": tier,
        "pinned": pinned,
        "expiresAt": bounded_optional_text(payload.get("expiresAt"), 80) or None,
        "relatedFiles": bounded_string_list(payload.get("relatedFiles", []), 24, 500),
        "relatedModules": bounded_string_list(payload.get("relatedModules", []), 16, 160),
        "decayRate": 0.0 if pinned else 0.02,
    }


def assert_revision(expected: int, actual: int) -> None:
    if expected != actual:
        raise SettingsRevisionConflict(expected, actual)


def bounded_id(value: Any, label: str) -> str:
    text = str(value or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", text):
        raise ValueError(f"{label} is invalid.")
    return text


def bounded_text(value: Any, limit: int, label: str) -> str:
    text = str(value or "").strip()
    if not text or len(text) > limit:
        raise ValueError(f"{label} must contain 1 to {limit} characters.")
    return text


def bounded_optional_text(value: Any, limit: int) -> str:
    text = str(value or "").strip()
    return text[:limit]


def bounded_string_list(value: Any, count: int, item_limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for entry in value:
        text = bounded_optional_text(entry, item_limit)
        if text and text not in result:
            result.append(text)
        if len(result) >= count:
            break
    return result


def bounded_string_record(value: Any, count: int, item_limit: int) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, str] = {}
    for key, entry in value.items():
        clean_key = bounded_optional_text(key, 80)
        clean_value = bounded_optional_text(entry, item_limit)
        if clean_key and clean_value:
            result[clean_key] = clean_value
        if len(result) >= count:
            break
    return result


def bounded_number(value: Any, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = fallback
    return max(0.0, min(number, 1.0))


def decode_string_list(value: Any) -> list[str]:
    try:
        parsed = json.loads(str(value or "[]"))
    except json.JSONDecodeError:
        return []
    return [str(entry) for entry in parsed] if isinstance(parsed, list) else []


def json_safe(value: Any) -> Any:
    encoded = canonical_json(value)
    if len(encoded) > 256_000:
        raise ValueError("Settings document is too large.")
    return json.loads(encoded)


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_json(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def backup_and_read_json(source: Path, destination: Path) -> Any:
    if not source.is_file():
        return None
    if not destination.exists():
        shutil.copy2(source, destination)
    return json.loads(source.read_text(encoding="utf-8-sig"))
