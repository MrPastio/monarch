from __future__ import annotations

import re


MetaIntentKind = str


def detect_meta_intent(text: str) -> MetaIntentKind | None:
    """Classify meta questions for routing only; answers always come from a model."""
    lowered = text.strip().lower()
    if re.search(r"(кто ты|кто такой\s+(?:oscar|оскар)|расскажи о себе|представься|who are you|what are you)", lowered):
        return "assistant_identity"
    if re.search(r"(что такое\s+monarch|расскажи (?:про|о)\s+monarch|что за проект\s+monarch|what is monarch)", lowered):
        return "project_identity"
    if (
        re.search(r"(что ты умеешь|какие у тебя возможност|какие capabilities доступны|какие инструменты доступны|какими инструментами.+можешь|what can you do|available capabilities|available actions)", lowered)
        or re.search(r"(?:ты\s+)?(?:можешь|умеешь)\s+.*(?:удал|запуск|команд|файл|инструмент|модел|диагност|delete|run|execute|command|file|tool|model)", lowered)
    ):
        return "capabilities_question"
    if re.search(r"(какие модели доступны|какие модели используешь|какой runtime активен|покажи статус моделей|model status|available models|which models)", lowered):
        return "model_status_question"
    return None
