"""What leaves the computer as a search engine query.

A query is sent to several search engines at once, so it is shortened and
stripped of personal identifiers here, at the one place every search path goes
through: e-mail addresses, phone and other long numbers (cards, accounts,
documents), key-like tokens, and everything of a link except its site. The
model planner is already asked to leave personal details out; this is the
deterministic floor under that request, and the bound when no plan exists and
the request itself would be searched.
"""
from __future__ import annotations

import json
import os
import re

MAX_ENGINE_QUERY_CHARS = 200

_URL = re.compile(r"\b(?:https?://|www\.)([^\s/?#]+)[^\s]*", re.IGNORECASE)
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", re.UNICODE)
# Digits with ordinary separators; only runs with nine or more digits are removed,
# so years, prices and dates stay.
_NUMBER_RUN = re.compile(r"(?<![\w])\+?\d(?:[\d\s().-]*\d)?(?![\w])")
_KEY_LIKE = re.compile(r"\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z_-]*\d)(?=[0-9_-]*[A-Za-z])[A-Za-z0-9_-]+\b")


def _drop_long_numbers(text: str) -> str:
    def replace(match: re.Match[str]) -> str:
        digits = sum(char.isdigit() for char in match.group(0))
        return " " if digits >= 9 else match.group(0)
    return _NUMBER_RUN.sub(replace, text)


def minimize_search_query(value: str, *, max_chars: int = MAX_ENGINE_QUERY_CHARS) -> str:
    text = " ".join(str(value or "").split())
    text = _URL.sub(lambda match: " " + match.group(1).lower().removeprefix("www.") + " ", text)
    text = _EMAIL.sub(" ", text)
    text = _drop_long_numbers(text)
    text = _KEY_LIKE.sub(" ", text)
    text = " ".join(text.split())
    if len(text) > max_chars:
        cut = text[:max_chars + 1]
        space = cut.rfind(" ")
        text = (cut[:space] if space > max_chars // 2 else cut[:max_chars]).strip()
    return text


POLICY_CONTROL = "search.queryMinimization"


def query_minimization_enabled() -> bool:
    """The person's choice in the Monarch Security policy center.

    The runtime passes the policy file through OSCAR_SECURITY_POLICY_PATH. Only
    an explicit "off" there turns cleaning off; a missing, unreadable or
    unknown value keeps it on.
    """
    location = os.environ.get("OSCAR_SECURITY_POLICY_PATH", "").strip()
    if not location:
        return True
    try:
        with open(location, "r", encoding="utf-8") as handle:
            if os.fstat(handle.fileno()).st_size > 64 * 1024:
                return True
            policy = json.load(handle)
    except (OSError, ValueError):
        return True
    levels = policy.get("levels") if isinstance(policy, dict) and policy.get("schemaVersion") == 1 else None
    return not (isinstance(levels, dict) and levels.get(POLICY_CONTROL) == "off")


def engine_query(value: str) -> str:
    """What one search engine receives for `value` under the current policy."""
    if query_minimization_enabled():
        return minimize_search_query(value)
    return " ".join(str(value or "").split())
