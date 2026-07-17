from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
import json
import uuid


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class SecurityEvent:
    kind: str
    source: str
    subject: str
    facts: dict[str, Any] = field(default_factory=dict)
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: str = field(default_factory=utc_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "timestamp": self.timestamp,
            "kind": self.kind,
            "source": self.source,
            "subject": self.subject,
            "facts": self.facts,
        }


@dataclass(frozen=True)
class RuleAssessment:
    event: SecurityEvent
    score: int
    severity: str
    reasons: list[str]
    route: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "event": self.event.to_dict(),
            "score": self.score,
            "severity": self.severity,
            "reasons": self.reasons,
            "route": self.route,
        }


@dataclass(frozen=True)
class ActionDecision:
    action: str
    confidence: float
    source: str
    reasons: list[str]
    llm_notes: str | None = None
    deferred: bool = False
    controls: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "confidence": round(self.confidence, 3),
            "source": self.source,
            "reasons": self.reasons,
            "llm_notes": self.llm_notes,
            "deferred": self.deferred,
            "controls": self.controls,
        }


def json_line(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=True, sort_keys=True)
