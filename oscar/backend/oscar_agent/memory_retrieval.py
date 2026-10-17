"""Relevance scoring for Memory 4.1: what deserves a place in the prompt.

Two signals, both absolute so that "nothing relevant" really yields nothing:

* lexical: the share of the query's information (IDF-weighted stems) that a
  record contains. Unlike the old rank position, a record sharing one common
  word with the question scores low.
* semantic: how far a record's E5 similarity stands above the scope's noise
  floor for this query. E5 compresses cosines into ~0.75-0.90, so a fixed
  cut-off either admits noise ("привет" ~ 0.84 to anything) or misses
  paraphrases. The floor is the 90th percentile of the query's similarity to
  every record in the scope (blended with a prior while the scope is small):
  measured on Russian samples (2026-10-16), noise tops stood <= 0.019 above
  it and true matches >= 0.030 ("доллар" 0.087, "борщ" from "свёкла" 0.063).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone

FLOOR_PRIOR = 0.82
FLOOR_PRIOR_WEIGHT = 20
FLOOR_PERCENTILE = 90
# A record passes on meaning alone above this margin over the floor (the
# tail of a large scope reaches further out, so a past chat, which can
# derail an answer, needs more than a short owner record)...
SEMANTIC_GATE = {"explicit": 0.032, "episode": 0.045, "capsule": 0.055}
# ...and only while it stays close to the best match of this query.
SEMANTIC_BEST_DELTA = 0.03
# ...or on meaning plus words with a smaller margin.
SEMANTIC_ASSIST = 0.012
SEMANTIC_SATURATION = 0.08
SEMANTIC_WEIGHT = 0.65
LEXICAL_GATE = {"explicit": 0.50, "episode": 0.60, "capsule": 0.60}
LEXICAL_ASSIST = 0.30
EPISODE_HALF_LIFE_DAYS = 120.0


@dataclass(slots=True)
class Candidate:
    kind: str  # explicit | episode | capsule
    id: str
    text: str
    title: str
    created_at: str
    stems: frozenset[str]
    pinned: bool = False
    profile: bool = False
    stale: bool = False
    conversation_id: str | None = None
    turn_id: str | None = None
    capsule_id: str | None = None
    lexical: float = 0.0
    matched: int = 0
    semantic: float | None = None
    margin: float | None = None
    score: float = 0.0
    reason: str = "fts"
    meta: dict = field(default_factory=dict)


def idf(document_frequency: int, documents: int) -> float:
    return math.log((documents + 1.0) / (document_frequency + 0.5)) + 1.0


def lexical_coverage(terms: list[str], weights: dict[str, float], stems: frozenset[str]) -> tuple[float, int]:
    """(IDF-weighted share of the query found in the record, matched terms)."""
    total = sum(weights.get(term, 1.0) for term in terms)
    if total <= 0:
        return 0.0, 0
    matched = [term for term in terms if term in stems]
    return sum(weights.get(term, 1.0) for term in matched) / total, len(matched)


def noise_floor(similarities) -> float:
    import numpy as np

    count = int(similarities.size)
    if count == 0:
        return FLOOR_PRIOR
    percentile = float(np.percentile(similarities, FLOOR_PERCENTILE))
    return (percentile * count + FLOOR_PRIOR * FLOOR_PRIOR_WEIGHT) / (count + FLOOR_PRIOR_WEIGHT)


def age_factor(created_at: str, now: datetime | None = None) -> float:
    """Old conversations fade slightly; owner records never do."""
    try:
        created = datetime.fromisoformat(created_at)
    except (TypeError, ValueError):
        return 1.0
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    days = max(0.0, ((now or datetime.now(timezone.utc)) - created).total_seconds() / 86400.0)
    return 0.8 + 0.2 * math.pow(0.5, days / EPISODE_HALF_LIFE_DAYS)


def score(candidate: Candidate, floor: float | None) -> None:
    """Ranking score in [0, 1] and the reason shown with a recalled item.
    floor None means no semantics for this retrieval."""
    if candidate.semantic is not None and floor is not None:
        candidate.margin = candidate.semantic - floor
        unit = max(0.0, min(1.0, candidate.margin / SEMANTIC_SATURATION))
        value = SEMANTIC_WEIGHT * unit + (1.0 - SEMANTIC_WEIGHT) * candidate.lexical
        # A record that answers the question word for word is relevant even
        # when E5 places it near the floor (short facts, names, codes).
        value = max(value, candidate.lexical * 0.9)
        candidate.reason = "semantic+fts" if candidate.lexical > 0 else "semantic"
    else:
        candidate.margin = None
        value = candidate.lexical
        candidate.reason = "fts"
    if candidate.kind != "explicit":
        value *= age_factor(candidate.created_at)
    if candidate.kind == "capsule":
        # A digest is less specific than the episode that matched in it.
        value *= 0.95
    if candidate.stale:
        value *= 0.7
    candidate.score = max(0.0, min(1.0, value))


def relevant(candidate: Candidate, query_terms: int, best_semantic: float | None = None) -> bool:
    extra = 0.01 if candidate.kind == "capsule" else 0.0
    if candidate.margin is not None:
        near_best = best_semantic is None or candidate.semantic >= best_semantic - SEMANTIC_BEST_DELTA
        if candidate.margin >= SEMANTIC_GATE.get(candidate.kind, 0.05) and near_best:
            return True
        if candidate.margin >= SEMANTIC_ASSIST + extra and candidate.lexical >= LEXICAL_ASSIST:
            return True
    if candidate.lexical < LEXICAL_GATE.get(candidate.kind, 0.6):
        return False
    if candidate.margin is not None and candidate.margin < 0:
        # Words match but the meaning sits below the noise floor.
        return candidate.kind == "explicit" and candidate.lexical >= 0.75
    # Without semantics one shared word is weak evidence for a past chat: an
    # old refusal resurfaced that way in unrelated chats (2026-09-18).
    return candidate.kind == "explicit" or candidate.matched >= min(2, query_terms)
