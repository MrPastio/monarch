"""Memory 4.1 personal facts: remember, replace, forget, learn. Synthetic data only."""
from __future__ import annotations

from pathlib import Path

import pytest

from oscar_agent.memory_facts import classify, extract_learnable, forget_subject, is_sensitive, normalize_statement
from oscar_agent.context_settings import ContextSettingsStore
from test_memory_v4 import POLICY_HASH, append_turn, make_services, make_settings

SCOPE = {"type": "chat"}


def command(context, name: str, payload: dict, request_id: str) -> dict:
    revision = context.read("memory", SCOPE)["revision"]
    return context.execute(client_request_id=request_id, command=name, scope=SCOPE, expected_revision=revision,
                           payload=payload, policy_decision_hash=POLICY_HASH)


def active_texts(context) -> list[str]:
    return sorted(record["text"] for record in context.read("memory", SCOPE)["value"]["records"]
                  if record["origin"] != "suggested")


@pytest.mark.parametrize(("text", "category", "subject"), [
    ("Я живу в Варне", "about", "home_city"),
    ("меня зовут Антон", "about", "name"),
    ("называй меня Тоша", "rule", "address"),
    ("отвечай мне кратко", "rule", "answer_length"),
    ("я не люблю кинзу", "preference", "pref:кинз"),
    ("я люблю кинзу", "preference", "pref:кинз"),
    ("У меня есть кот Барсик", "about", "pet"),
    ("Проект собирается через npm run build", "project", None),
    ("Ключ от гаража у соседа", "note", None),
])
def test_classify(text, category, subject):
    assert classify(text) == (category, subject)


def test_normalize_statement_keeps_the_persons_words():
    assert normalize_statement("что я живу в Варне.") == "Я живу в Варне"
    assert normalize_statement("  «отвечай кратко»  ") == "Отвечай кратко"


def test_extract_learnable_reads_only_plain_statements_about_oneself():
    assert [fact.subject_key for fact in extract_learnable("Привет! Я живу в Варне. Какая завтра погода?")] == ["home_city"]
    assert extract_learnable("Я живу в Варне?") == []
    assert extract_learnable("Представь, что я живу в Париже") == []
    assert extract_learnable("Мой друг сказал, что я живу неправильно") == []
    assert extract_learnable("Мой пароль от почты qwerty, я живу в Варне") == []
    assert extract_learnable("Я живу в Варне. " * 200) == []  # material, not a statement
    assert extract_learnable("Расскажи про Варну") == []


def test_two_statements_joined_by_and_become_two_facts():
    facts = extract_learnable("Привет! Я живу в Пловдиве и работаю дизайнером. Посоветуй, чем заняться вечером.")
    assert [(fact.text, fact.subject_key) for fact in facts] == [
        ("Я живу в Пловдиве", "home_city"), ("Я работаю дизайнером", "work")]
    # "и" inside one statement is left alone.
    assert [fact.text for fact in extract_learnable("Я люблю чай и кофе")] == ["Я люблю чай и кофе"]


@pytest.mark.parametrize("text", [
    "Напиши рассказ от первого лица: «Меня зовут Игорь, я пилот».",
    "Переведи на немецкий: меня зовут Анна и я живу в Берлине.",
    "Напиши письмо от моего имени: я живу в Туле и прошу перенести встречу.",
    "Придумай диалог, где я говорю на французском.",
    "Он сказал мне: «я живу в Москве».",
    "Работаю над отчётом, помоги со структурой.",
    "Работаю на выходных, так что напомни в понедельник.",
    "Я работаю удалённо.",
    "Я фотографирую закаты.",
    "Я владею квартирой в центре.",
    "Мне нравится твой ответ.",
    "Мама переехала в Псков.",
    "Мой брат работает инженером в Перми.",
])
def test_text_requests_quotes_and_lookalikes_teach_nothing(text):
    assert extract_learnable(text) == []


@pytest.mark.parametrize(("text", "expected"), [
    ("Зовут меня Лена, будем знакомы.", [("name", "Зовут меня Лена")]),
    ("Сейчас обитаю в Екатеринбурге.", [("home_city", "Сейчас обитаю в Екатеринбурге")]),
    ("Тружусь бэкенд-разработчиком в банке.", [("work", "Тружусь бэкенд-разработчиком в банке")]),
    ("По профессии я архитектор.", [("profession", "По профессии я архитектор")]),
    ("Мой родной город — Самара, а живу теперь в Москве.",
     [("hometown", "Мой родной город Самара"), ("home_city", "Живу теперь в Москве")]),
    ("Терпеть не могу джаз.", [("pref:джаз", "Терпеть не могу джаз")]),
    ("Мне больше нравится чай, чем кофе.", [("pref:ча", "Мне больше нравится чай, чем кофе")]),
    ("Я ненавижу, когда в ответах много воды.", [("pref:ответ мног вод", "Я ненавижу, когда в ответах много воды")]),
    ("Свободно владею немецким и французским.", [("languages", "Свободно владею немецким и французским")]),
    ("У меня две собаки — Рекс и Луна.", [("pet", "У меня две собаки")]),
    ("Давай без формальностей, можно на ты.", [("address_form", "Можно на ты")]),
    ("Я работаю в Яндексе аналитиком, живу в Москве.",
     [("work", "Я работаю в Яндексе аналитиком"), ("home_city", "Живу в Москве")]),
])
def test_everyday_paraphrases_are_learned(text, expected):
    assert [(fact.subject_key, fact.text) for fact in extract_learnable(text)] == expected


def test_sensitive_patterns():
    assert is_sensitive("номер карты 4111 1111 1111 1111")
    assert is_sensitive("у меня диагноз диабет")
    assert not is_sensitive("я живу в Варне")


def test_remember_deduplicates_and_replaces_by_subject(tmp_path: Path):
    _memory, context, service = make_services(tmp_path)
    try:
        first = command(context, "memory.remember", {"text": "что я живу в Варне"}, "r1")["result"]
        again = command(context, "memory.remember", {"text": "Я ЖИВУ В ВАРНЕ!"}, "r2")["result"]
        moved = command(context, "memory.remember", {"text": "я живу в Софии"}, "r3")["result"]
        assert first["action"] == "created" and again["action"] == "unchanged"
        assert moved["action"] == "replaced" and moved["replaced"]["text"] == "Я живу в Варне"
        assert active_texts(context) == ["Я живу в Софии"]
        recalled = service.retrieve("где я живу?", SCOPE)
        assert "Варне" not in str(recalled) and "Софии" in str(recalled)
    finally:
        service.close()


def test_preference_flip_replaces_the_old_one(tmp_path: Path):
    _memory, context, service = make_services(tmp_path)
    try:
        command(context, "memory.remember", {"text": "я люблю кинзу"}, "p1")
        command(context, "memory.remember", {"text": "я не люблю кинзу"}, "p2")
        assert active_texts(context) == ["Я не люблю кинзу"]
    finally:
        service.close()


def test_forget_by_subject_or_words_and_restore(tmp_path: Path):
    _memory, context, service = make_services(tmp_path)
    try:
        command(context, "memory.remember", {"text": "я живу в Варне"}, "f1")
        command(context, "memory.remember", {"text": "ключ от гаража лежит у соседа"}, "f2")
        city = command(context, "memory.forget", {"query": "где я живу"}, "f3")["result"]["record"]
        key = command(context, "memory.forget", {"query": "про ключ от гаража"}, "f4")["result"]["record"]
        nothing = command(context, "memory.forget", {"query": "предыдущее сообщение"}, "f5")["result"]["record"]
        assert city["text"] == "Я живу в Варне" and key["text"].startswith("Ключ")
        assert nothing is None
        assert active_texts(context) == []
        command(context, "memory.restore", {"id": city["id"]}, "f6")
        assert active_texts(context) == ["Я живу в Варне"]
    finally:
        service.close()


def test_forgetting_a_fact_takes_its_replaced_history_along(tmp_path: Path):
    import sqlite3
    _memory, context, service = make_services(tmp_path)
    try:
        command(context, "memory.remember", {"text": "я живу в Варне"}, "h1")
        command(context, "memory.remember", {"text": "я живу в Софии"}, "h2")
        command(context, "memory.remember", {"text": "я живу в Пловдиве"}, "h3")
        command(context, "memory.forget", {"query": "где я живу"}, "h4")
        with sqlite3.connect(service.db_path) as con:
            alive = con.execute("SELECT content FROM memory_items WHERE deleted_at IS NULL").fetchall()
        assert alive == []
    finally:
        service.close()


def test_startup_sweeps_history_of_records_deleted_earlier(tmp_path: Path):
    import sqlite3
    _memory, context, service = make_services(tmp_path)
    command(context, "memory.remember", {"text": "я живу в Варне"}, "s1")
    newer = command(context, "memory.remember", {"text": "я живу в Софии"}, "s2")["result"]["record"]["id"]
    service.close()
    with sqlite3.connect(service.db_path) as con:
        # As an earlier build left it: the newer record deleted, history alive.
        con.execute("UPDATE memory_items SET deleted_at = '2026-10-16T00:00:00+00:00', enabled = 0 WHERE id = ?", (newer,))
    _memory, context, service = make_services(tmp_path)
    try:
        with sqlite3.connect(service.db_path) as con:
            assert con.execute("SELECT COUNT(*) FROM memory_items WHERE deleted_at IS NULL").fetchone()[0] == 0
    finally:
        service.close()


def test_forget_subject_from_questions():
    assert forget_subject("где я живу") == "home_city"
    assert forget_subject("как меня зовут") == "name"
    assert forget_subject("про моего кота") == "pet"


def test_learning_auto_mode_remembers_and_replaces(tmp_path: Path):
    memory, context, service = make_services(tmp_path)
    try:
        learned = context.learn_from_message(SCOPE, "Я живу в Варне, подскажи погоду")
        assert [entry["record"]["origin"] for entry in learned] == ["learned"]
        context.learn_from_message(SCOPE, "Кстати, я переехал в Софию.")
        assert active_texts(context) == ["Я переехал в Софию"]
        assert context.learn_from_message(SCOPE, "Кстати, я переехал в Софию.") == []
    finally:
        service.close()


def test_learning_suggest_mode_waits_for_the_persons_yes(tmp_path: Path):
    _memory, context, service = make_services(tmp_path)
    try:
        command(context, "memory.learning.set", {"mode": "suggest"}, "m1")
        command(context, "memory.remember", {"text": "я живу в Варне"}, "m2")
        suggestion = context.learn_from_message(SCOPE, "я живу в Софии")[0]["record"]
        assert suggestion["origin"] == "suggested"
        assert active_texts(context) == ["Я живу в Варне"]  # not replaced before a yes
        assert "Софии" not in str(service.retrieve("где я живу", SCOPE))
        command(context, "memory.suggestion.accept", {"id": suggestion["id"]}, "m3")
        assert active_texts(context) == ["Я живу в Софии"]
    finally:
        service.close()


def test_dismissed_suggestion_is_not_suggested_again(tmp_path: Path):
    _memory, context, service = make_services(tmp_path)
    try:
        command(context, "memory.learning.set", {"mode": "suggest"}, "d1")
        suggestion = context.learn_from_message(SCOPE, "я люблю оливки")[0]["record"]
        command(context, "memory.suggestion.dismiss", {"id": suggestion["id"]}, "d2")
        assert context.learn_from_message(SCOPE, "я люблю оливки") == []
        assert context.read("memory", SCOPE)["value"]["records"] == []
    finally:
        service.close()


def test_learning_off_writes_nothing(tmp_path: Path):
    _memory, context, service = make_services(tmp_path)
    try:
        command(context, "memory.learning.set", {"mode": "off"}, "o1")
        assert context.learn_from_message(SCOPE, "я живу в Варне") == []
        assert context.read("memory", SCOPE)["value"]["learningMode"] == "off"
    finally:
        service.close()


def test_learn_endpoint_reports_what_was_learned_and_episodes_do_not_learn(tmp_path: Path, monkeypatch):
    from oscar_agent import main
    from oscar_agent.schemas import MemoryEpisodeIndexRequestV1, MemoryLearnRequestV1
    memory, context, service = make_services(tmp_path)
    monkeypatch.setattr(main, "memory_v4", service)
    monkeypatch.setattr(main, "context_settings", context)
    try:
        learn = lambda text: main.memory_learn(MemoryLearnRequestV1.model_validate({"schemaVersion": 1, "text": text}))
        first = learn("Я живу в Варне, какая погода?")["learned"]
        assert [(entry["origin"], entry["action"]) for entry in first] == [("learned", "created")]
        assert learn("Я живу в Варне, какая погода?")["learned"] == []
        moved = learn("Я живу в Софии")["learned"]
        assert moved[0]["replacedText"] == "Я живу в Варне"
        append_turn(memory, conversation_id="c", turn_id="t", user_text="Я живу в Риме", assistant_text="Ок.")
        result = main.memory_episode_index(MemoryEpisodeIndexRequestV1.model_validate({
            "schemaVersion": 1, "source": "desktop", "scope": {"type": "chat"}, "conversationId": "c", "turnId": "t"}))
        assert "learned" not in result
        assert active_texts(context) == ["Я живу в Софии"]
    finally:
        service.close()


def test_coder_note_keeps_its_section_kind_and_files_and_never_uses_person_subjects(tmp_path: Path):
    _memory, context, service = make_services(tmp_path)
    scope = {"type": "coder-project", "projectId": "project_demo"}
    try:
        def note(request_id, text, **payload):
            revision = context.read("memory", scope)["revision"]
            return context.execute(client_request_id=request_id, command="memory.remember", scope=scope,
                                   expected_revision=revision, payload={"text": text, **payload},
                                   policy_decision_hash=POLICY_HASH)["result"]
        first = note("n1", "Хранилище переведено на SQLite", category="project", type="decision",
                     relatedFiles=["src/store.ts@abc123"], origin="learned", source="coder-run")
        assert first["record"]["category"] == "project" and first["record"]["type"] == "decision"
        assert first["record"]["relatedFiles"] == ["src/store.ts@abc123"]
        assert note("n2", "Хранилище переведено на SQLite", category="project", type="decision",
                origin="learned")["action"] == "unchanged"
        # "I live in…" phrasing inside a project note is not the person's city.
        note("n3", "Я живу в Варне — сервер деплоя тоже там", category="note", type="pitfall")
        note("n4", "Я живу в Софии — новый сервер там", category="note", type="pitfall")
        texts = sorted(record["text"] for record in context.read("memory", scope)["value"]["records"])
        assert len(texts) == 3
        assert context.read("memory", {"type": "chat"})["value"]["records"] == []
    finally:
        service.close()


def test_undo_of_a_learned_replacement_brings_the_old_fact_back(tmp_path: Path):
    _memory, context, service = make_services(tmp_path)
    try:
        context.learn_from_message(SCOPE, "Я живу в Варне")
        moved = context.learn_from_message(SCOPE, "Я живу в Софии")
        new_id = moved[0]["record"]["id"]
        result = command(context, "memory.delete", {"id": new_id, "undo": True}, "u1")["result"]
        assert result["restoredId"]
        assert active_texts(context) == ["Я живу в Варне"]
        ContextSettingsStore(make_settings(tmp_path))
        assert active_texts(context) == ["Я живу в Варне"]
    finally:
        service.close()
