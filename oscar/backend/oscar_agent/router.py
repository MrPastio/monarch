from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from .meta_templates import detect_meta_intent

TIER_ORDER = ["gemma4-fast", "gemma4-balanced", "gemma4-deepthinking"]
TIER_RANK = {tier: index for index, tier in enumerate(TIER_ORDER)}
META_INTENTS = {
    "assistant_identity",
    "project_identity",
    "capabilities_question",
    "model_status_question",
}
LEGACY_TIER_ALIASES = {
    "weak": "gemma4-fast",
    "medium": "gemma4-balanced",
    "powerful": "gemma4-deepthinking",
    "reasoning": "gemma4-deepthinking",
    "vision": "gemma4-balanced",
}

DEFAULT_TIER_CONFIG = {
    "tiers": {
        "reasoning": {
            "keywords": [
                "подумай пошагово",
                "deep reasoning",
                "сложная логика",
                "математическое доказательство",
                "докажи",
                "solve rigorously",
                "prove rigorously",
                "step by step",
            ],
            "minLength": 0,
        },
        "powerful": {
            "keywords": [
                "refactor",
                "debug",
                "typescript",
                "javascript",
                "python",
                "api",
                "json schema",
                "архитектур",
                "безопасност",
                "security",
                "router",
                "runtime",
            ],
            "minLength": 300,
        },
        "medium": {
            "keywords": [
                "объясни",
                "почему",
                "как",
                "расскажи",
                "опиши",
                "напиши",
                "what is",
                "why",
                "explain",
                "how",
            ],
            "minLength": 100,
        },
        "weak": {"keywords": [], "minLength": 0},
    },
    "scoring": {
        "thresholds": {"medium": 0.30, "powerful": 0.60},
        "weights": {
            "lengthDivisor": 1200,
            "lengthCap": 0.12,
            "multipart": 0.12,
            "context": 0.08,
            "freshness": 0.12,
            "structuredOutput": 0.08,
            "metaBase": 0.02,
            "metaDepth": 0.22,
            "metaActionDepth": 0.08,
            "metaDomainDepth": 0.06,
            "metaKnowledgeDepth": 0.04,
            "action": 0.10,
            "domain": 0.15,
            "knowledge": 0.06,
            "depth": 0.26,
            "highImpact": 0.18,
            "socialDamping": -0.10,
        },
    },
    "tierPriority": ["reasoning", "powerful", "medium", "weak"],
}

_tier_config_cache: dict[str, Any] | None = None
_warned_missing_tier_config = False


def select_model_tier(
    messages: list[dict],
    use_reasoning: bool = False,
    route_hint: Any | None = None,
) -> str:
    latest_user = _latest_user_message(messages)
    lowered = latest_user.lower()
    intent_kind = _read_hint_intent(route_hint) or detect_meta_intent(latest_user)

    if use_reasoning or _has_reasoning_keyword(lowered):
        return "gemma4-deepthinking"

    fallback_tier = _normalize_router_tier(_fallback_tier_for_text(lowered, intent_kind))
    hinted_tier = _read_hint_tier(route_hint)
    intent_floor = _normalize_router_tier(_tier_floor_for_intent(intent_kind))

    final_tier = _max_tier(fallback_tier, intent_floor)
    if hinted_tier:
        final_tier = _max_tier(final_tier, hinted_tier)
    return final_tier


def compute_complexity_score(text: str) -> float:
    return _score_adaptive_model_route(text, detect_meta_intent(text))["score"]


def _fallback_tier_for_text(text: str, intent_kind: str | None = None) -> str:
    score = _score_adaptive_model_route(text, intent_kind)["score"]
    thresholds = _scoring_config()["thresholds"]
    if score >= thresholds["powerful"]:
        return "powerful"
    if score >= thresholds["medium"]:
        return "medium"
    return "weak"


def _score_adaptive_model_route(text: str, intent_kind: str | None = None) -> dict[str, Any]:
    lowered = text.lower().strip()
    if not lowered:
        return {"score": 0.0, "features": {}}

    config = _load_tier_config()
    is_meta = intent_kind in META_INTENTS
    has_depth = _has_depth_signal(lowered)
    has_action = _has_action_signal(lowered)
    has_domain = _has_domain_signal(lowered) or _matches_tier_keywords(lowered, config, "powerful")
    has_medium_knowledge = _has_medium_knowledge_signal(lowered) or _matches_tier_keywords(lowered, config, "medium")
    has_freshness = bool(re.search(r"(интернет|в сети|новост|актуаль|свеж|web|online|latest|current|news)", lowered))
    has_context = bool(re.search(r"\b(this|that|previous|continue)\b|(?:это|этот|как выше|продолжи|сделай так|исправь это)", lowered))
    multi_part = len(re.findall(r"[?;]|\n|\bи\b|\band\b", lowered)) >= 2
    output_structured = bool(re.search(r"(json|schema|структур|таблиц|markdown|html|код|code block)", lowered))
    scoring = _scoring_config(config)
    weights = scoring["weights"]
    high_impact = bool(re.search(r"(?:архитектур|безопасност|security|threat model|модель угроз)", lowered))
    score_parts: dict[str, float] = {
        "length": min(len(lowered) / weights["lengthDivisor"], weights["lengthCap"]),
        "intent": _intent_complexity_bonus(intent_kind),
        "multipart": weights["multipart"] if multi_part else 0.0,
        "context": weights["context"] if has_context else 0.0,
        "freshness": weights["freshness"] if has_freshness else 0.0,
        "structured_output": weights["structuredOutput"] if output_structured else 0.0,
    }

    if is_meta:
        score_parts["meta_base"] = weights["metaBase"]
        score_parts["meta_depth"] = weights["metaDepth"] if has_depth else 0.0
        score_parts["meta_actionable"] = weights["metaActionDepth"] if has_action and has_depth else 0.0
        score_parts["domain"] = weights["metaDomainDepth"] if has_domain and has_depth else 0.0
        score_parts["knowledge"] = weights["metaKnowledgeDepth"] if has_medium_knowledge and has_depth else 0.0
    else:
        score_parts["action"] = weights["action"] if has_action else 0.0
        score_parts["domain"] = weights["domain"] if has_domain else 0.0
        score_parts["knowledge"] = weights["knowledge"] if has_medium_knowledge else 0.0
        score_parts["depth"] = weights["depth"] if has_depth else 0.0
        score_parts["high_impact"] = weights["highImpact"] if high_impact and (has_action or has_depth) else 0.0

    if _is_brief_social_exchange(lowered):
        score_parts["social_damping"] = weights["socialDamping"]

    score = max(0.0, min(sum(score_parts.values()), 1.0))
    return {"score": score, "features": {k: v for k, v in score_parts.items() if v}}


def _has_reasoning_keyword(text: str) -> bool:
    config = _load_tier_config()
    return _matches_tier_keywords(text, config, "reasoning")


def _matches_tier_keywords(text: str, config: dict[str, Any], tier: str) -> bool:
    keywords = config.get("tiers", {}).get(tier, {}).get("keywords", [])
    return any(str(keyword).lower() in text for keyword in keywords)


def _tier_min_length(config: dict[str, Any], tier: str) -> int:
    value = config.get("tiers", {}).get(tier, {}).get("minLength", 0)
    return value if isinstance(value, int) and value > 0 else 0


def _tier_floor_for_intent(intent_kind: str | None) -> str:
    if intent_kind in {
        "assistant_identity",
        "project_identity",
        "capabilities_question",
        "model_status_question",
    }:
        return "weak"
    if intent_kind == "diagnostics_request":
        return "medium"
    if intent_kind in {"code_edit", "code_debug", "architecture_review", "security_review"}:
        return "powerful"
    if intent_kind in {"reasoning", "proof", "rigorous_solve"}:
        return "reasoning"
    return "weak"


def _has_depth_signal(text: str) -> bool:
    return bool(re.search(
        r"(подроб|деталь|пошаг|глубок|проанализ|сравни|аудит|исслед|докажи|обоснуй|план|стратег|trade-?off|thorough|deep|detailed|analy[sz]e|compare|audit|prove|strategy)",
        text,
    ))


def _intent_complexity_bonus(intent_kind: str | None) -> float:
    if intent_kind in {"code", "code_edit", "code_debug", "architecture_review", "security_review", "file_generation", "system_action"}:
        return 0.16
    if intent_kind in {"search", "diagnostics_request"}:
        return 0.08
    if intent_kind in {"reasoning", "proof", "rigorous_solve"}:
        return 0.40
    return 0.0


def _has_action_signal(text: str) -> bool:
    return bool(re.search(
        r"\b(write|draft|compose|generate|fix|review|analyze|find|search|implement|refactor|debug|design|build)\b|(?:напиши|составь|исправь|проверь|проанализируй|найди|поищи|реализуй|отрефактор|отлад|спроектируй|собери)",
        text,
    ))


def _has_domain_signal(text: str) -> bool:
    return bool(re.search(
        r"(typescript|javascript|python|api|json schema|router|runtime|security|architecture|workspace|repository|repo|llm|model|архитектур|безопасност|роутер|маршрутизатор|рантайм|код|отлад|рефактор|модель|проект|репозитор)",
        text,
    ))


def _has_medium_knowledge_signal(text: str) -> bool:
    return bool(re.search(
        r"\b(what is|why|explain|how|tell me)\b|(?:объясни|почему|как|расскажи|опиши|что такое|поясни)",
        text,
    ))


def _is_brief_social_exchange(text: str) -> bool:
    compact = text.strip().lower()
    if not compact or len(compact) > 80:
        return False
    return bool(re.fullmatch(
        r"(?:ping|pong|hi|hello|hey|yo|привет|здравствуй|здравствуйте|как дела|как ты|how are you|how's it going)\??",
        compact,
    ))


def _read_hint_tier(route_hint: Any | None) -> str | None:
    raw = _read_hint_value(route_hint, "modelTier")
    if not raw:
        return None
    normalized = str(raw).strip().lower()
    tier = _normalize_router_tier(normalized)
    if tier in TIER_RANK:
        return tier
    logging.warning("Ignoring invalid Oscar route hint tier: %s", raw)
    return None


def _read_hint_intent(route_hint: Any | None) -> str | None:
    raw = _read_hint_value(route_hint, "intentKind")
    return str(raw).strip() if raw else None


def _read_hint_value(route_hint: Any | None, key: str) -> Any | None:
    if route_hint is None:
        return None
    if isinstance(route_hint, dict):
        return route_hint.get(key)
    return getattr(route_hint, key, None)


def _max_tier(left: str, right: str) -> str:
    return left if TIER_RANK[left] >= TIER_RANK[right] else right


def _normalize_router_tier(tier: str | None) -> str:
    normalized = str(tier or "").strip().lower()
    if normalized in TIER_RANK:
        return normalized
    return LEGACY_TIER_ALIASES.get(normalized, "gemma4-fast")


def _latest_user_message(messages: list[dict]) -> str:
    for msg in reversed(messages):
        if msg.get("role") == "user":
            return str(msg.get("content", ""))
    return ""


def _load_tier_config() -> dict[str, Any]:
    global _tier_config_cache
    if _tier_config_cache is not None:
        return _tier_config_cache

    config_path = _find_shared_tier_config_path()
    if config_path is None:
        _warn_missing_tier_config_once()
        _tier_config_cache = DEFAULT_TIER_CONFIG
        return _tier_config_cache

    try:
        parsed = json.loads(config_path.read_text(encoding="utf-8"))
        _tier_config_cache = _merge_tier_config(parsed)
    except Exception:
        _warn_missing_tier_config_once()
        _tier_config_cache = DEFAULT_TIER_CONFIG
    return _tier_config_cache


def _merge_tier_config(parsed: dict[str, Any]) -> dict[str, Any]:
    merged = json.loads(json.dumps(DEFAULT_TIER_CONFIG))
    if isinstance(parsed, dict):
        tiers = parsed.get("tiers")
        if isinstance(tiers, dict):
            for tier, value in tiers.items():
                if tier in merged["tiers"] and isinstance(value, dict):
                    merged["tiers"][tier].update(value)
        priority = parsed.get("tierPriority")
        if isinstance(priority, list):
            merged["tierPriority"] = priority
        scoring = parsed.get("scoring")
        if isinstance(scoring, dict):
            thresholds = scoring.get("thresholds")
            weights = scoring.get("weights")
            if isinstance(thresholds, dict):
                for key, value in thresholds.items():
                    if key in merged["scoring"]["thresholds"] and isinstance(value, (int, float)):
                        merged["scoring"]["thresholds"][key] = float(value)
            if isinstance(weights, dict):
                for key, value in weights.items():
                    if key in merged["scoring"]["weights"] and isinstance(value, (int, float)):
                        merged["scoring"]["weights"][key] = float(value)
    return merged


def _scoring_config(config: dict[str, Any] | None = None) -> dict[str, Any]:
    source = config or _load_tier_config()
    scoring = source.get("scoring") if isinstance(source, dict) else None
    return scoring if isinstance(scoring, dict) else DEFAULT_TIER_CONFIG["scoring"]


def _find_shared_tier_config_path() -> Path | None:
    starts = [Path.cwd(), Path(__file__).resolve()]
    for start in starts:
        current = start if start.is_dir() else start.parent
        for _ in range(8):
            candidate = current / "shared" / "tier-config.json"
            if candidate.is_file():
                return candidate
            if current.parent == current:
                break
            current = current.parent
    return None


def _warn_missing_tier_config_once() -> None:
    global _warned_missing_tier_config
    if _warned_missing_tier_config:
        return
    _warned_missing_tier_config = True
    logging.warning("Oscar tier config is unavailable; using built-in fallback tier config.")
