"""What a memory record is about, and what Oscar may learn by itself.

Deterministic and dependency-free: a record's subject decides whether a new
statement replaces an older one ("я живу в Софии" after "я живу в Варне"),
and the same patterns pick up such statements from what the person says in
an ordinary chat. Only the person's own words are read, never the model's.
Patterns are deliberately narrow: a missed fact costs nothing, a wrong one
is something Oscar would repeat back for months.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .memory_text import STOPWORDS, fold, stem, words

# What a person does for a living, as a word; "я архитектор" says it as well as "я работаю архитектором".
_PROFESSIONS = (r"программист\w*|разработчик\w*|инженер\w*|дизайнер\w*|врач\w*|учител\w*|студент\w*|юрист\w*"
                r"|бухгалтер\w*|менеджер\w*|аналитик\w*|архитектор\w*|преподавател\w*|педагог\w*|повар\w*"
                r"|водител\w*|экономист\w*|журналист\w*|фотограф\w*|переводчик\w*|маркетолог\w*|тестировщик\w*"
                r"|художни\w*|музыкант\w*|психолог\w*|медсестр\w*|фармацевт\w*|строител\w*|электрик\w*|механик\w*")
# "работаю дизайнером / в банке / на заводе / как фрилансер", not "работаю над отчётом" or "работаю медленно".
_WORK_VALUE = (r"(?:в|во|на|как)\s+(?!(?:выходн|этой|этих|следующ|прошл|неделе|днях|праздник|ночь|ночам|утрам|"
               r"вечерам|понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)\w*)[^,.!?;]{2,58}"
               r"|[а-яё-]+(?:ом|ем|ём|ой|ей|ицей)\b[^,.!?;]{0,50}")

# "Мне нравится этот вариант" is about the conversation, not a lasting taste.
_NOT_A_TASTE = r"(?!(?:этот|эта|это|эти|тот|та|те|твой|твоя|твоё|твое|твои|ваш\w*|так\w*|как)\b)"

# (subject, category, pattern). The first group, when present, is the value.
_SUBJECTS: tuple[tuple[str, str, re.Pattern[str]], ...] = tuple(
    (subject, category, re.compile(pattern, re.IGNORECASE | re.UNICODE))
    for subject, category, pattern in (
        ("name", "about", r"\b(?:меня\s+зовут|зовут\s+меня|мо[её]\s+имя|my\s+name\s+is|i\s+am\s+called)\s+([^\s,.!?;]{2,40})"),
        ("address", "rule", r"\b(?:называй|зови|обращайся\s+ко\s+мне\s+как)\s+меня\s+([^,.!?;]{2,40})|\bcall\s+me\s+([^,.!?;]{2,40})"),
        ("address_form", "rule", r"\b(?:обращайся\s+ко\s+мне|(?:можно|давай|давайте|лучше)(?:\s+со\s+мной)?)\s+на\s+(ты|вы)\b"),
        ("home_city", "about", r"\b(?:я\s+)?(?:живу|проживаю|обитаю)\s+(?:(?:сейчас|теперь|уже|постоянно)\s+)?(?:в|во)\s+([^,.!?;]{2,40})|\bi\s+live\s+in\s+([^,.!?;]{2,40})"),
        ("home_city", "about", r"\bя\s+переехал[аи]?\s+(?:в|во)\s+([^,.!?;]{2,40})|\bi\s+moved\s+to\s+([^,.!?;]{2,40})"),
        ("hometown", "about", r"\bя\s+(?:родом\s+)?из\s+([А-ЯЁA-Z][^,.!?;]{1,40})|\bмо[йё]\s+родной\s+город\s+(?:[—–-]\s+)?([А-ЯЁA-Z][^,.!?;]{1,40})"
                              r"|\bi(?:'m|\s+am)\s+from\s+([^,.!?;]{2,40})"),
        ("work", "about", rf"\b(?:я\s+)?(?:работаю|тружусь)\s+({_WORK_VALUE})|\bi\s+work\s+(?:as|at)\s+([^,.!?;]{{2,60}})"),
        # A noun, not a verb sharing its stem: "я фотограф", not "я фотографирую".
        ("profession", "about", rf"\b(?:я\s+(?:по\s+профессии\s+)?|по\s+профессии\s+я\s+)({_PROFESSIONS})\b(?<!ую)(?<!ет)(?<!ть)"),
        ("languages", "about", r"\b(?:я\s+)?(?:(?:свободно|хорошо)\s+)?(?:говорю\s+на\s+([^.!?;]{3,60})|владею\s+([а-яё]+[сц]ким\b[^.!?;]{0,50}))|\bi\s+speak\s+([^.!?;]{3,60})"),
        ("pet", "about", r"\bу\s+меня\s+(?:есть\s+)?(?:(?:два|две|три|четыре|пять)\s+)?(кот\w*|кошк\w*|собак\w*|п[её]с\w*|попуга\w*|хомяк\w*)(?:\s+(?:по\s+имени\s+)?([А-ЯЁA-Z]\w+))?"
                         r"|\b(кот\w*|кошк\w*|собак\w*|п[её]с\w*|попуга\w*|хомяк\w*)\s+у\s+меня\s+(?:есть\b)?"),
        ("language_pref", "rule", r"\b(?:отвечай|пиши|говори)\s+(?:мне\s+)?(?:всегда\s+)?(?:на|по-)\s*(русском|английском|украинском|болгарском|русски|английски)\b"),
        ("answer_length", "rule", r"\b(?:всегда\s+)?(?:отвечай|пиши)\s+(?:мне\s+)?(?:всегда\s+)?(кратко|коротко|подробно|развернуто|развёрнуто|покороче|подробнее)\b"),
    )
)
_PREFERENCE = re.compile(
    r"\b(?:я\s+)?(?P<neg>не\s+)?(?P<verb>люблю|обожаю|предпочитаю|ненавижу|терпеть\s+не\s+могу)(?:\s+|,?\s+когда\s+)"
    rf"{_NOT_A_TASTE}(?P<object>[^,.!?;]{{2,50}})"
    r"|\bмне\s+(?:(?:очень|больше|совсем)\s+)?(?P<lneg>не\s+)?(?:нравится|нравятся)\s+"
    rf"{_NOT_A_TASTE}(?P<lobject>[^,.!?;]{{2,50}})"
    r"|\bi\s+(?P<eneg>don't\s+|do\s+not\s+)?(?P<everb>love|like|prefer|hate)\s+(?P<eobject>[^,.!?;]{2,50})",
    re.IGNORECASE | re.UNICODE,
)
_RULE = re.compile(r"\b(?:всегда|никогда)\s+(?:не\s+)?(?:отвечай|пиши|используй|называй|обращайся|предлагай|добавляй|говори)\b"
                   r"|\b(?:always|never)\s+(?:answer|reply|write|use|call|add|say)\b", re.IGNORECASE)
_PROJECT = re.compile(r"\b(?:проект\w*|репозитори\w*|codebase|repository|project)\b", re.IGNORECASE)

# Never learned by itself; only an explicit «запомни» stores these.
_SENSITIVE = re.compile(
    r"парол|password|passcode|pin[-\s]?код|\bpin\b|cvv|cvc|токен|token|api[-\s]?key|ключ\s+api|секрет|secret"
    r"|номер\s+(?:карты|паспорта|счета|счёта|телефона)|паспорт|снилс|инн\b|iban|swift"
    r"|диагноз|болезн|болею|лекарств|таблетк|беремен|аллерги|депресс|psychiatr|diagnos"
    r"|религ|вероисповед|политическ|ориентац|\b\d{12,19}\b|\b\d{4}[\s-]\d{4}[\s-]\d{4}[\s-]\d{4}\b",
    re.IGNORECASE,
)
_NOT_A_STATEMENT = re.compile(
    r"\?|\bесли\s+бы\b|\bкак\s+будто\b|\bпредставь\b|\bдопустим\b|\bнапример\b|\bсказал[аи]?,?\s+что\b"
    r"|\bпишет\b|\bгерой\b|\bперсонаж\b|\bimagine\b|\bif\s+i\s+were\b|\bpretend\b|\bsaid\s+that\b"
    # A request to write or translate text: the words after it are material, not about the person.
    r"|\b(?:напиши|переведи|перевод|перефразируй|сочини|придумай|продолжи|отредактируй|исправь)\b"
    r"|\bкак\s+(?:будет|сказать|перевести)\b|\btranslate\b|\brewrite\b|\bwrite\s+(?:a|an|me|the)\b",
    re.IGNORECASE,
)


@dataclass(frozen=True, slots=True)
class Fact:
    text: str
    category: str
    subject_key: str | None


def is_sensitive(text: str) -> bool:
    return bool(_SENSITIVE.search(text or ""))


def classify(text: str) -> tuple[str, str | None]:
    """(category, subject_key) of a memory text; subject None = no conflicts."""
    value = str(text or "")
    for subject, category, pattern in _SUBJECTS:
        if pattern.search(value):
            return category, subject
    preference = _PREFERENCE.search(value)
    if preference:
        obj = preference.group("object") or preference.group("lobject") or preference.group("eobject") or ""
        key = " ".join(stem(word) for word in words(obj) if word not in STOPWORDS)[:60]
        return "preference", f"pref:{key}" if key else None
    if _RULE.search(value):
        return "rule", None
    if _PROJECT.search(value):
        return "project", None
    return "note", None


_LEADING_FILLER = re.compile(r"^(?:пожалуйста[,\s]+)?(?:что\s+|про\s+то,?\s+что\s+|то,?\s+что\s+|that\s+)", re.IGNORECASE)


def normalize_statement(text: str) -> str:
    """'что я живу в Варне.' -> 'Я живу в Варне'. Content stays the person's."""
    value = re.sub(r"\s+", " ", str(text or "")).strip().strip("«»\"'")
    value = _LEADING_FILLER.sub("", value).strip()
    value = value.rstrip(" .!;,")
    return value[:1].upper() + value[1:] if value else ""


def _sentences(text: str) -> list[str]:
    return [part.strip() for part in re.split(r"(?<=[.!?…])\s+|\n+", text) if part.strip()]


_FIRST_PERSON = re.compile(r"\b(?:я|меня|мне|мой|моя|моё|мое|мои|у\s+меня|i|my|me)\b", re.IGNORECASE)
# Russian drops "я": "Сейчас обитаю в Казани", "Терпеть не могу джаз". Past tense says nothing about who.
_FIRST_PERSON_VERB = re.compile(r"\b(?:живу|обитаю|проживаю|работаю|тружусь|владею|говорю|учусь|люблю|обожаю|"
                                r"ненавижу|предпочитаю|могу)\b", re.IGNORECASE)
# Quoted words in the first person are someone's line, not the person's own statement.
_QUOTED = re.compile(r"«[^»]*»|\"[^\"]*\"|“[^”]*”|„[^“”]*[“”]")
# "Мой родной город — Самара" is one statement; the dash is a copula, not a break.
_COPULA_DASH = re.compile(r"(\bмо[йяеёи]\s+(?:[а-яё]+\s+){0,2}[а-яё]+)\s+[—–]\s+", re.IGNORECASE)


# "Я живу в Пловдиве и работаю дизайнером" holds two facts with two subjects;
# kept together, moving city later would also erase the job.
_SECOND_STATEMENT = re.compile(
    r"\s+(?:и|а\s+ещё|and)\s+(?=(?:я\s+|i\s+)?(?:живу|работаю|учусь|говорю|люблю|не\s+люблю|обожаю|предпочитаю|"
    r"переехал\w*|занимаюсь|live|work|study|speak|love|like|prefer)\b)",
    re.IGNORECASE,
)


def _clauses(sentence: str) -> list[str]:
    parts: list[str] = []
    sentence = _COPULA_DASH.sub(r"\1 ", sentence)
    # ", когда …" and ", чем …" finish the statement before them: "ненавижу, когда …", "чай, чем кофе".
    for part in re.split(r",(?!\s*(?:когда|чем)\b)\s*|[;:—–]\s*|\s+(?:а|но|и\s+ещё|and|but)\s+", sentence):
        part = re.sub(r"^\s*(?:а|но|и)\s+", "", part, flags=re.IGNORECASE)  # ", а живу …" after the comma split
        pieces = [piece.strip() for piece in _SECOND_STATEMENT.split(part) if piece.strip()]
        # The subject of the first statement carries over: "…и работаю X" is "я работаю X".
        if len(pieces) > 1 and _FIRST_PERSON.search(pieces[0]):
            pieces = [pieces[0], *(piece if _FIRST_PERSON.search(piece) else f"я {piece}" for piece in pieces[1:])]
        parts.extend(pieces)
    return parts


def extract_learnable(user_text: str) -> list[Fact]:
    """Statements the person made about themselves in an ordinary message.

    A long message is material (a story, a pasted document), not a statement
    about its author, so only short messages and sentences are read. A
    hypothetical or reported sentence is skipped whole; a question only spoils
    its own clause ("Я живу в Варне, какая погода?" teaches the city)."""
    text = str(user_text or "")
    if len(text) > 1200:
        return []
    facts: list[Fact] = []
    seen: set[str] = set()
    for sentence in _sentences(text):
        if len(sentence) > 220 or _NOT_A_STATEMENT.search(sentence.replace("?", "")) or is_sensitive(sentence):
            continue
        clauses = _clauses(_QUOTED.sub(lambda quote: "" if _FIRST_PERSON.search(quote.group()) else quote.group(), sentence))
        for index, clause in enumerate(clauses):
            last = index == len(clauses) - 1
            if "?" in clause or (last and sentence.rstrip().endswith("?")):
                continue
            category, subject = classify(clause)
            if subject is None and category != "rule":
                continue
            if category != "rule" and not (_FIRST_PERSON.search(clause) or _FIRST_PERSON_VERB.search(clause)):
                continue
            statement = normalize_statement(clause)
            if 4 <= len(statement) <= 200 and (subject or statement) not in seen:
                seen.add(subject or statement)
                facts.append(Fact(statement, category, subject))
    return facts[:3]


_QUESTION_SUBJECTS = (
    ("home_city", re.compile(r"\bгде\s+я\s+живу\b|\bмо[йеё]\s+город\b|\bгород\b|\bwhere\s+i\s+live\b", re.I)),
    ("name", re.compile(r"\bкак\s+меня\s+зовут\b|\bмо[её]\s+имя\b|\bmy\s+name\b", re.I)),
    ("work", re.compile(r"\bгде\s+я\s+работаю\b|\bмо[яю]\s+работ\w*\b|\bwhere\s+i\s+work\b", re.I)),
    ("pet", re.compile(r"\bпитомц\w*|\bкот\w*|\bкошк\w*|\bсобак\w*|\bpet\b", re.I)),
)


def forget_subject(query: str) -> str | None:
    """'забудь, где я живу' names a subject rather than quoting the record."""
    for subject, pattern in _QUESTION_SUBJECTS:
        if pattern.search(query or ""):
            return subject
    _category, subject = classify(query)
    return subject


def forget_terms(query: str) -> list[str]:
    return [stem(word) for word in words(query) if word not in STOPWORDS and len(word) >= 3]


def same_meaning(left: str, right: str) -> bool:
    return " ".join(words(fold(left))) == " ".join(words(fold(right)))
