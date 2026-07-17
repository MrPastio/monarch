import re
from typing import Literal

LanguageCode = Literal["ru", "en", "uk", "bg", "auto"]

RU_MARKERS = {"что", "это", "как", "почему", "объясни", "напиши", "пожалуйста", "ты", "мне", "такое", "где", "когда"}
UK_MARKERS = {"що", "це", "як", "чому", "поясни", "будь ласка", "мені", "де", "коли", "таке"}
BG_MARKERS = {"какво", "това", "защо", "обясни", "моля", "ти", "ми", "е", "къде", "кога"}
EN_MARKERS = {"what", "this", "how", "why", "explain", "write", "please", "you", "me", "where", "when", "is", "are"}

EXPLICIT_REQUEST_PATTERNS = [
    r"ответь на \w+",
    r"напиши по-\w+",
    r"translate .*?to",
    r"переведи на",
    r"in english",
    r"по-английски",
    r"по-русски",
    r"на болгарском",
    r"на украинском",
    r"на русском",
    r"на английском",
]

REQUESTED_LANGUAGE_PATTERNS: list[tuple[LanguageCode, tuple[str, ...]]] = [
    ("ru", ("на русском", "по-русски", "in russian", "to russian", "russian")),
    ("en", ("на английском", "по-английски", "in english", "to english", "english")),
    ("uk", ("на украинском", "по-украински", "in ukrainian", "to ukrainian", "ukrainian")),
    ("bg", ("на болгарском", "по-болгарски", "in bulgarian", "to bulgarian", "bulgarian")),
]

URL_PATTERN = re.compile(r"(?:https?://|www\.)[^\s<>]+", re.IGNORECASE)
FENCED_CODE_PATTERN = re.compile(r"```.*?(?:```|$)", re.DOTALL)
INLINE_CODE_PATTERN = re.compile(r"`[^`\n]+`")
WINDOWS_PATH_PATTERN = re.compile(r"\b[A-Za-z]:[\\/][^\s<>`\"']+")


def strip_language_neutral_content(text: str) -> str:
    """Remove transport tokens that must not vote on the user's language."""
    text = FENCED_CODE_PATTERN.sub(" ", text)
    text = INLINE_CODE_PATTERN.sub(" ", text)
    text = URL_PATTERN.sub(" ", text)
    return WINDOWS_PATH_PATTERN.sub(" ", text)

def clean_text(text: str) -> list[str]:
    # Strip <think>...</think> blocks for cleaner detection
    text = re.sub(r'<think>.*?(?:</think>|$)', ' ', text, flags=re.DOTALL)
    # Remove punctuation and lowercase
    text = re.sub(r'[^\w\s]', ' ', text.lower())
    return text.split()

def detect_user_language(text: str) -> LanguageCode:
    detection_text = strip_language_neutral_content(text)
    words = clean_text(detection_text)
    if not words:
        return "auto"

    ru_count = sum(1 for w in words if w in RU_MARKERS)
    uk_count = sum(1 for w in words if w in UK_MARKERS)
    bg_count = sum(1 for w in words if w in BG_MARKERS)
    en_count = sum(1 for w in words if w in EN_MARKERS)

    # Check cyrillic vs latin if markers don't help
    cyrillic_chars = sum(1 for c in detection_text if 'а' <= c.lower() <= 'я' or c.lower() in 'ёіїєґ')
    latin_chars = sum(1 for c in detection_text if 'a' <= c.lower() <= 'z')

    scores = {
        "ru": ru_count,
        "uk": uk_count,
        "bg": bg_count,
        "en": en_count,
    }
    
    max_score = max(scores.values())
    if max_score > 0:
        # If there's a tie, we can default based on character counts or general priority
        if scores["ru"] == max_score and scores["bg"] < max_score and scores["uk"] < max_score:
            return "ru"
        if scores["bg"] == max_score and scores["ru"] < max_score:
            return "bg"
        if scores["uk"] == max_score and scores["ru"] < max_score:
            return "uk"
        if scores["en"] == max_score:
            return "en"

    # Fallback to character types if markers failed
    if latin_chars > cyrillic_chars * 2:
        return "en"
    if cyrillic_chars >= 4 and cyrillic_chars >= latin_chars:
        return "ru"
    if cyrillic_chars > latin_chars * 2:
        # We can't be sure which slavic language if no markers, default to ru
        # But wait, what if it's Bulgarian without markers? Just return "ru" as fallback for cyrillic
        return "ru"

    return "auto"


def has_reliable_language_sample(text: str, min_words: int = 5) -> bool:
    """Require enough natural-language prose before spending a second model pass."""
    return len(clean_text(strip_language_neutral_content(text))) >= min_words

def has_explicit_language_request(text: str) -> bool:
    text_lower = text.lower()
    for pattern in EXPLICIT_REQUEST_PATTERNS:
        if re.search(pattern, text_lower):
            return True
    return False

def detect_requested_language(text: str) -> LanguageCode | None:
    text_lower = text.lower()
    for language, markers in REQUESTED_LANGUAGE_PATTERNS:
        if any(marker in text_lower for marker in markers):
            return language
    return None

def get_language_name(code: LanguageCode) -> str:
    return {
        "ru": "Russian",
        "en": "English",
        "uk": "Ukrainian",
        "bg": "Bulgarian",
        "auto": "the user's language"
    }.get(code, "the user's language")
