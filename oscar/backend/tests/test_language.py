from oscar_agent.language import (
    detect_requested_language,
    detect_user_language,
    has_explicit_language_request,
    has_reliable_language_sample,
)

def test_detect_user_language_ru():
    assert detect_user_language("Объясни коротко, что такое Monarch") == "ru"
    assert detect_user_language("Где скачать Python?") == "ru"
    assert detect_user_language("Ты можешь помочь мне?") == "ru"
    assert detect_user_language("Привет, проверь runtime") == "ru"
    assert detect_user_language(
        "Эй Оскар зацени сайт https://julia-kolesnik.mrpastio.chatgpt.site/#contact"
    ) == "ru"

def test_detect_user_language_bg():
    assert detect_user_language("Какво е Monarch?") == "bg"
    assert detect_user_language("Обясни ми това моля") == "bg"

def test_detect_user_language_uk():
    assert detect_user_language("Що таке Monarch?") == "uk"
    assert detect_user_language("Поясни мені будь ласка") == "uk"

def test_detect_user_language_en():
    assert detect_user_language("What is Monarch?") == "en"
    assert detect_user_language("Explain how this works.") == "en"
    assert detect_user_language("Review https://пример.рф/очень-длинный-путь") == "en"


def test_detect_user_language_url_only_is_neutral():
    assert detect_user_language("https://julia-kolesnik.mrpastio.chatgpt.site/#contact") == "auto"


def test_detect_user_language_ignores_code_and_local_paths():
    assert detect_user_language(
        "Я запущен в `C:\\Users\\anton\\workspace` и вижу реальные Monarch capabilities."
    ) == "ru"
    assert detect_user_language("```python\nprint('hello')\n``` Что именно проверить?") == "ru"


def test_language_rewrite_requires_natural_language_sample():
    assert has_reliable_language_sample("vision ok") is False
    assert has_reliable_language_sample("```python\nprint('hello')\n```") is False
    assert has_reliable_language_sample("I checked the website and found its contact information.") is True

def test_detect_with_think_tags():
    # Model might output some think block, should be stripped out for detection
    text = "<think> I need to answer in English because why not. </think> Что такое Monarch?"
    # Wait, the detect_user_language is primarily for user queries, but also used on full_answer.
    # We should ensure the answer text language is correctly detected.
    assert detect_user_language(text) == "ru"

def test_has_explicit_language_request():
    assert has_explicit_language_request("Объясни на английском, что такое Monarch") is True
    assert has_explicit_language_request("Translate this to english") is True
    assert has_explicit_language_request("Напиши по-украински") is True
    assert has_explicit_language_request("Объясни коротко, что такое Monarch") is False
    assert has_explicit_language_request("Какво е Monarch?") is False

def test_detect_requested_language():
    assert detect_requested_language("Ответь на русском") == "ru"
    assert detect_requested_language("Translate this to english") == "en"
    assert detect_requested_language("Напиши по-украински") == "uk"
    assert detect_requested_language("Объясни на болгарском") == "bg"
    assert detect_requested_language("Объясни коротко, что такое Monarch") is None


def test_evidence_names_a_language_only_when_something_proves_it():
    from oscar_agent.language import detect_user_language_evidence

    # Markers are proof; two of them keep one shared short word from deciding.
    assert detect_user_language_evidence("What is this and how does it work please") == ("en", "markers")
    assert detect_user_language_evidence("Какво е това и защо, обясни ми моля") == ("bg", "markers")
    assert detect_user_language_evidence("Ответь на русском") == ("ru", "requested")


def test_script_alone_is_never_evidence_of_a_language():
    from oscar_agent.language import detect_user_language_evidence

    # Every Latin-script language scores alike, and so does every Cyrillic one.
    # The legacy code is kept for other callers, but it is marked unproven.
    for text in [
        "Bonjour, peux-tu m expliquer la différence entre un processus et un thread ?",
        "Hallo, kannst du mir den Unterschied zwischen Prozess und Thread erklären?",
        "Hola, explícame la diferencia entre proceso e hilo por favor",
        "Merhaba, süreç ve iş parçacığı arasındaki farkı açıklar mısın",
    ]:
        code, evidence = detect_user_language_evidence(text)
        assert evidence == "script", text
        assert code == "en", text

    for text in [
        "Здраво, објасни ми разлику између процеса и нити",
        "Сәлем, процесс пен ағын арасындағы айырмашылықты түсіндірші",
    ]:
        code, evidence = detect_user_language_evidence(text)
        assert evidence == "script", text


def test_evidence_does_not_change_the_legacy_detector():
    # Other callers still depend on the original codes; only the extra signal
    # is new, so every existing detection keeps its answer.
    for text in [
        "Объясни коротко, что такое Monarch",
        "What is Monarch?",
        "Какво е Monarch?",
        "Що таке Monarch?",
        "https://julia-kolesnik.mrpastio.chatgpt.site/#contact",
    ]:
        from oscar_agent.language import detect_user_language_evidence

        assert detect_user_language_evidence(text)[0] == detect_user_language(text), text


def test_cyrillic_is_proof_only_when_the_alphabet_rules_the_others_out():
    from oscar_agent.language import detect_user_language_evidence

    # "ы" cannot appear in Bulgarian, Ukrainian or Serbian text.
    assert detect_user_language_evidence("Как тебе новый Computer Use?") == ("ru", "markers")
    # Kazakh also uses "ы", but its own letters rule Russian out first.
    assert detect_user_language_evidence("Сәлем, ағын мен процесс")[1] == "script"
    # Serbian letters likewise.
    assert detect_user_language_evidence("Објасни ми разлику")[1] == "script"
