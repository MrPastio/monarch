"""Text normalisation for memory search: one place for terms and stems.

FTS5's unicode61 tokenizer matches whole word forms only, so "Варна" never
found "в Варне". Every memory row stores `search_stems` (written by Python at
the time the row is written) and the FTS projection indexes it next to the
raw text, so both an exact word and any inflection of it match. The stemmer is
the Snowball Russian algorithm plus a light English suffix rule; both are pure
Python and deterministic, so a row's stems never depend on the machine.
"""
from __future__ import annotations

import re

# Bumped when stemming changes; rows written under an older version are
# re-stemmed in the background (see MemoryV4Service._repair_stems).
STEMMER_VERSION = 1

STOPWORDS = frozenset({
    # Russian function words and conversational filler.
    "а", "без", "более", "бы", "был", "была", "были", "было", "быть", "буду", "будет", "будем", "будешь",
    "будут", "будь", "в", "вам", "вас", "весь", "во", "вот",
    "все", "всё", "всего", "всех", "вы", "где", "да", "даже", "для", "до", "его", "ее", "её", "ей", "ему",
    "если", "есть", "еще", "ещё", "же", "за", "здесь", "и", "из", "или", "им", "их", "к", "как", "какая",
    "какой", "когда", "кто", "ли", "либо", "мне", "меня", "мной", "мои", "мой", "моя", "моё", "мы", "на",
    "над", "надо", "нам", "нас", "не", "него", "нее", "неё", "нет", "ни", "них", "но", "ну", "о", "об",
    "однако", "он", "она", "они", "оно", "от", "очень", "по", "под", "при", "про", "с", "сам", "сама",
    "свой", "себе", "себя", "со", "так", "также", "такой", "там", "те", "тебе", "тебя", "тем", "то",
    "того", "тоже", "той", "только", "том", "ты", "у", "уже", "чем", "что", "чтобы", "чего", "чей", "эта",
    "эти", "это", "этого", "этой", "этот", "я", "привет", "спасибо", "пожалуйста", "пока", "ладно", "окей",
    "хорошо", "можно", "нужно", "скажи", "расскажи", "подскажи", "помнишь", "вспомни", "напомни",
    "память", "памяти", "запомни", "запомнил", "обсуждали", "говорили", "называл", "почему", "зачем",
    "сейчас", "теперь", "просто", "вообще", "который", "которая", "которые", "сколько",
    # English.
    "a", "about", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "do", "does", "for",
    "from", "had", "has", "have", "he", "her", "his", "how", "i", "if", "in", "into", "is", "it", "its",
    "me", "my", "no", "not", "of", "on", "or", "our", "she", "so", "that", "the", "their", "them", "then",
    "there", "they", "this", "to", "was", "we", "were", "what", "when", "where", "which", "who", "why",
    "will", "with", "you", "your", "hello", "hi", "thanks", "please", "remember", "recall", "memory",
    "previous", "earlier", "tell",
})

_WORD = re.compile(r"[^\W_]+(?:[-'][^\W_]+)*", re.UNICODE)
_CYRILLIC = re.compile(r"[а-я]")


def fold(text: str) -> str:
    return str(text or "").casefold().replace("ё", "е")


def words(text: str) -> list[str]:
    return _WORD.findall(fold(text))


def stem(word: str) -> str:
    word = fold(word)
    if any(char.isdigit() for char in word) or len(word) <= 2:
        return word
    if _CYRILLIC.search(word):
        return _russian_stem(word)
    if word.isascii():
        return _english_stem(word)
    return word


def stem_text(*parts: str) -> str:
    """Space-separated stems of every word, for the FTS `stems` column."""
    return " ".join(stem(word) for part in parts for word in words(part))


def query_terms(text: str, *, limit: int = 12) -> list[str]:
    """Distinct content stems of a query, in order of first appearance."""
    seen: list[str] = []
    for word in words(text):
        if word in STOPWORDS or (len(word) < 3 and not any(char.isdigit() for char in word)):
            continue
        term = stem(word)
        if len(term) >= 2 and term not in seen:
            seen.append(term)
    return seen[:limit]


def fts_query(terms: list[str]) -> str:
    """OR of quoted terms; quotes keep FTS5 syntax characters literal."""
    return " OR ".join('"' + term.replace('"', '""') + '"' for term in terms)


def norm_key(text: str) -> str:
    """Case- and punctuation-insensitive identity of a memory text (dedup)."""
    return " ".join(words(text))


# --- Snowball Russian (https://snowballstem.org/algorithms/russian/stemmer.html)

_VOWELS = set("аеиоуыэюя")
_PERFECTIVE_1 = ("вшись", "вши", "в")
_PERFECTIVE_2 = ("ившись", "ывшись", "ивши", "ывши", "ив", "ыв")
_REFLEXIVE = ("ся", "сь")
_ADJECTIVE = ("ими", "ыми", "его", "ого", "ему", "ому", "ее", "ие", "ые", "ое", "ей", "ий", "ый", "ой",
              "ем", "им", "ым", "ом", "их", "ых", "ую", "юю", "ая", "яя", "ою", "ею")
_PARTICIPLE_1 = ("ем", "нн", "вш", "ющ", "щ")
_PARTICIPLE_2 = ("ивш", "ывш", "ующ")
_VERB_1 = ("ете", "йте", "ешь", "нно", "ла", "на", "ли", "ем", "ло", "но", "ет", "ют", "ны", "ть", "й", "л", "н")
_VERB_2 = ("ейте", "уйте", "ила", "ыла", "ена", "ите", "или", "ыли", "ило", "ыло", "ено", "ует", "уют", "ены",
           "ить", "ыть", "ишь", "ей", "уй", "ил", "ыл", "им", "ым", "ен", "ят", "ит", "ыт", "ую", "ю")
_NOUN = ("иями", "ями", "ами", "ией", "иям", "ием", "иях", "ев", "ов", "ие", "ье", "еи", "ии", "ей", "ой",
         "ий", "ям", "ем", "ам", "ом", "ах", "ях", "ию", "ью", "ия", "ья", "а", "е", "и", "й", "о", "у",
         "ы", "ь", "ю", "я")
_SUPERLATIVE = ("ейше", "ейш")
_DERIVATIONAL = ("ость", "ост")


def _by_length(suffixes: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(sorted(suffixes, key=len, reverse=True))


_PERFECTIVE_1, _PERFECTIVE_2, _REFLEXIVE, _ADJECTIVE = map(_by_length, (_PERFECTIVE_1, _PERFECTIVE_2, _REFLEXIVE, _ADJECTIVE))
_PARTICIPLE_1, _PARTICIPLE_2, _VERB_1, _VERB_2, _NOUN = map(_by_length, (_PARTICIPLE_1, _PARTICIPLE_2, _VERB_1, _VERB_2, _NOUN))
_SUPERLATIVE, _DERIVATIONAL = map(_by_length, (_SUPERLATIVE, _DERIVATIONAL))


def _regions(word: str) -> tuple[int, int]:
    rv = next((index + 1 for index, char in enumerate(word) if char in _VOWELS), len(word))
    r1 = next((index + 1 for index in range(1, len(word))
               if word[index] not in _VOWELS and word[index - 1] in _VOWELS), len(word))
    r2 = next((index + 1 for index in range(r1 + 1, len(word))
               if word[index] not in _VOWELS and word[index - 1] in _VOWELS), len(word))
    return rv, r2


def _strip(rv_part: str, group_after_a: tuple[str, ...], group_plain: tuple[str, ...] = ()) -> str | None:
    """Remove the longest matching suffix; group 1 must follow а or я."""
    best: tuple[int, str] | None = None
    for suffix in group_after_a:
        if rv_part.endswith(suffix) and rv_part[:-len(suffix)][-1:] in ("а", "я"):
            best = (len(suffix), rv_part[:-len(suffix)])
            break
    for suffix in group_plain:
        if rv_part.endswith(suffix) and (best is None or len(suffix) > best[0]):
            best = (len(suffix), rv_part[:-len(suffix)])
            break
    return best[1] if best else None


def _russian_stem(word: str) -> str:
    rv, r2 = _regions(word)
    head, rest = word[:rv], word[rv:]
    stripped = _strip(rest, _PERFECTIVE_1, _PERFECTIVE_2)
    if stripped is not None:
        rest = stripped
    else:
        reflexive = _strip(rest, (), _REFLEXIVE)
        if reflexive is not None:
            rest = reflexive
        adjective = _strip(rest, (), _ADJECTIVE)
        if adjective is not None:
            participle = _strip(adjective, _PARTICIPLE_1, _PARTICIPLE_2)
            rest = participle if participle is not None else adjective
        else:
            verb = _strip(rest, _VERB_1, _VERB_2)
            if verb is not None:
                rest = verb
            else:
                noun = _strip(rest, (), _NOUN)
                if noun is not None:
                    rest = noun
    if rest.endswith("и"):
        rest = rest[:-1]
    r2_in_rest = max(0, r2 - rv)
    for suffix in _DERIVATIONAL:
        if rest.endswith(suffix) and len(rest) - len(suffix) >= r2_in_rest:
            rest = rest[:-len(suffix)]
            break
    if rest.endswith("нн"):
        rest = rest[:-1]
    else:
        for suffix in _SUPERLATIVE:
            if rest.endswith(suffix):
                rest = rest[:-len(suffix)]
                if rest.endswith("нн"):
                    rest = rest[:-1]
                break
        else:
            if rest.endswith("ь"):
                rest = rest[:-1]
    return head + rest


def _english_stem(word: str) -> str:
    for suffix, replacement in (("ies", "y"), ("sses", "ss"), ("ing", ""), ("edly", ""), ("ed", ""),
                                ("ly", ""), ("es", ""), ("s", "")):
        if word.endswith(suffix) and len(word) - len(suffix) >= 3 and not word.endswith("ss"):
            return word[:-len(suffix)] + replacement
    return word
