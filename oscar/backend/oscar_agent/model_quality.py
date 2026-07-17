from __future__ import annotations

import json
import logging
import os
import re
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .schemas import ChatSource


INITIAL_MODEL_SCORE = 100
MIN_MODEL_SCORE = 0
COLL_THRESHOLD = 20
MAX_EVENTS_PER_MODEL = 80

QUALITY_STATUS_ORDER = (
    ("Prime", 90),
    ("Stable", 70),
    ("Watch", 45),
    ("Penalty", COLL_THRESHOLD + 1),
    ("Coll", MIN_MODEL_SCORE),
)

QUALITY_PENALTIES = {
    "prompt_leak": 35,
    "tool_result_hallucination": 30,
    "false_citation": 25,
    "unverified_web_claim": 20,
    "identity_confusion": 16,
    "capability_denial": 16,
    "language_drift": 10,
    "blank_answer": 10,
}

HONESTY_REDUCTION = 0.5


@dataclass(frozen=True)
class ModelQualityAssessment:
    penalty: int
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class ModelQualitySnapshot:
    model_id: str
    score: int
    status: str
    updated_at: str | None = None


class ModelQualityLedger:
    """Local-only persistent quality ledger for model reliability penalties."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.Lock()

    def snapshot(self, model_id: str) -> ModelQualitySnapshot:
        normalized = normalize_model_id(model_id)
        with self._lock:
            data = self._read()
            record = self._record_for(data, normalized)
            return snapshot_from_record(normalized, record)

    def record_penalty(
        self,
        model_id: str,
        assessment: ModelQualityAssessment,
    ) -> ModelQualitySnapshot:
        normalized = normalize_model_id(model_id)
        if assessment.penalty <= 0:
            return self.snapshot(normalized)
        with self._lock:
            data = self._read()
            record = self._record_for(data, normalized)
            before = int(record.get("score", INITIAL_MODEL_SCORE))
            after = max(MIN_MODEL_SCORE, before - int(assessment.penalty))
            record["score"] = after
            record["status"] = quality_status_for_score(after)
            record["updated_at"] = utc_now_iso()
            record["total_penalty"] = int(record.get("total_penalty", 0)) + int(assessment.penalty)
            event = {
                "at": record["updated_at"],
                "penalty": int(assessment.penalty),
                "reasons": list(assessment.reasons),
                "score_before": before,
                "score_after": after,
                "status": record["status"],
            }
            events = list(record.get("events") or [])
            events.append(event)
            record["events"] = events[-MAX_EVENTS_PER_MODEL:]
            data.setdefault("models", {})[normalized] = record
            self._write(data)
            return snapshot_from_record(normalized, record)

    def reset_model(self, model_id: str) -> ModelQualitySnapshot:
        normalized = normalize_model_id(model_id)
        with self._lock:
            data = self._read()
            record = self._record_for(data, normalized)
            record["score"] = INITIAL_MODEL_SCORE
            record["status"] = quality_status_for_score(INITIAL_MODEL_SCORE)
            record["updated_at"] = utc_now_iso()
            record["total_penalty"] = 0
            record["events"] = []
            data.setdefault("models", {})[normalized] = record
            self._write(data)
            return snapshot_from_record(normalized, record)

    def _record_for(self, data: dict[str, Any], model_id: str) -> dict[str, Any]:
        models = data.setdefault("models", {})
        raw = models.get(model_id)
        if not isinstance(raw, dict):
            raw = {
                "score": INITIAL_MODEL_SCORE,
                "status": quality_status_for_score(INITIAL_MODEL_SCORE),
                "updated_at": None,
                "total_penalty": 0,
                "events": [],
            }
            models[model_id] = raw
        score = clamp_score(raw.get("score"))
        raw["score"] = score
        raw["status"] = quality_status_for_score(score)
        return raw

    def _read(self) -> dict[str, Any]:
        try:
            if self.path.exists():
                data = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    data.setdefault("version", 1)
                    data.setdefault("models", {})
                    return data
        except Exception:
            logging.exception("Oscar model quality ledger is unreadable; starting fresh")
        return {"version": 1, "models": {}}

    def _write(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp_path, self.path)


def assess_model_answer(
    answer: str,
    *,
    quality_flags: list[str] | None = None,
    sources: list[ChatSource] | None = None,
    tool_promise_rewritten: bool = False,
    blank_answer: bool = False,
) -> ModelQualityAssessment:
    reasons: list[str] = []
    if blank_answer or not answer.strip():
        reasons.append("blank_answer")

    for flag in quality_flags or []:
        if flag in QUALITY_PENALTIES and flag not in reasons:
            reasons.append(flag)

    if tool_promise_rewritten or has_unexecuted_action_claim(answer):
        reasons.append("tool_result_hallucination")

    if has_false_citation(answer, sources or []):
        reasons.append("false_citation")

    if has_unverified_web_claim(answer, sources or []):
        reasons.append("unverified_web_claim")

    penalty = sum(QUALITY_PENALTIES.get(reason, 0) for reason in dict.fromkeys(reasons))
    if penalty and answer_is_honest_about_uncertainty(answer):
        penalty = max(1, round(penalty * HONESTY_REDUCTION))
    return ModelQualityAssessment(penalty=min(penalty, INITIAL_MODEL_SCORE), reasons=tuple(dict.fromkeys(reasons)))


def render_hidden_quality_guard(lang_code: str) -> str:
    if lang_code == "ru":
        return (
            "\n\nКонтроль качества (не упоминать): перед ответом молча проверь факты, источники, пути, версии, даты и действия. "
            "Неподтверждённое пометь как неопределённость; замеченную ошибку кратко исправь. Не упоминай guard, ledger, баллы или Coll."
        )
    return (
        "\n\nQuality check (never mention): silently verify facts, sources, paths, versions, dates, and actions before answering. "
        "Mark unsupported claims as uncertain and briefly correct noticed errors. Never mention the guard, ledger, scores, or Coll."
    )


def quality_status_for_score(score: int) -> str:
    clamped = clamp_score(score)
    for status, minimum in QUALITY_STATUS_ORDER:
        if clamped >= minimum:
            return status
    return "Coll"


def normalize_model_id(model_id: str | None) -> str:
    normalized = str(model_id or "").strip().lower()
    return normalized or "unknown"


def clamp_score(value: Any) -> int:
    try:
        score = int(value)
    except (TypeError, ValueError):
        score = INITIAL_MODEL_SCORE
    return max(MIN_MODEL_SCORE, min(INITIAL_MODEL_SCORE, score))


def snapshot_from_record(model_id: str, record: dict[str, Any]) -> ModelQualitySnapshot:
    score = clamp_score(record.get("score"))
    return ModelQualitySnapshot(
        model_id=model_id,
        score=score,
        status=quality_status_for_score(score),
        updated_at=str(record.get("updated_at") or "") or None,
    )


def has_false_citation(answer: str, sources: list[ChatSource]) -> bool:
    if not re.search(r"\[\d+\]", answer):
        return False
    source_ids = {int(source.id) for source in sources if isinstance(source.id, int)}
    if not source_ids:
        return True
    cited = {int(match) for match in re.findall(r"\[(\d+)\]", answer)}
    return bool(cited - source_ids)


def has_unverified_web_claim(answer: str, sources: list[ChatSource]) -> bool:
    if any(source.url and str(source.url).startswith(("http://", "https://")) for source in sources):
        return False
    return bool(re.search(
        r"(?:я\s+(?:наш[её]л|проверил|посмотрел)\s+(?:в\s+)?(?:интернете|сети)|"
        r"согласно\s+(?:источникам|сайтам|данным\s+из\s+интернета)|"
        r"\b(?:according to|sources say|i found online|i checked online)\b)",
        answer,
        flags=re.IGNORECASE,
    ))


def has_unexecuted_action_claim(answer: str) -> bool:
    return bool(re.search(
        r"(?:\bя\s+(?:создал|создала|сделал|сделала|удалил|удалила|переименовал|переименовала|"
        r"запустил|запустила|выполнил|выполнила|проверил|проверила|прочитал|прочитала|наш[её]л|нашла)\b"
        r".{0,100}\b(?:файл|папк|директор|workspace|команд|терминал|скрипт|поиск|интернет|источник|сайт)\b|"
        r"\bi\s+(?:created|deleted|renamed|ran|executed|checked|read|searched|found)\b"
        r".{0,100}\b(?:file|folder|directory|workspace|command|terminal|script|search|internet|source|site)\b)",
        answer,
        flags=re.IGNORECASE | re.DOTALL,
    ))


def answer_is_honest_about_uncertainty(answer: str) -> bool:
    return bool(re.search(
        r"(?:не\s+(?:уверен|подтверждено|проверено|могу\s+подтвердить)|"
        r"нужн[ао]\s+провер|"
        r"предполож|"
        r"без\s+(?:проверки|источника|результата)|"
        r"\b(?:uncertain|unverified|cannot confirm|need to verify|without a source)\b)",
        answer,
        flags=re.IGNORECASE,
    ))


def utc_now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
