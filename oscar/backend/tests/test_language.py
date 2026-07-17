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
