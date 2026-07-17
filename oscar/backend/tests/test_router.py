from oscar_agent.router import select_model_tier


def test_short_explanation_uses_fast_tier():
    assert select_model_tier([
        {"role": "user", "content": "Объясни коротко, что такое бинарный поиск"}
    ]) == "gemma4-fast"


def test_high_reasoning_effort_selects_reasoning_tier():
    assert select_model_tier([
        {"role": "user", "content": "Объясни коротко, что такое Monarch"}
    ], use_reasoning=True) == "gemma4-deepthinking"


def test_simple_ping_uses_weak_tier():
    assert select_model_tier([
        {"role": "user", "content": "ping"}
    ]) == "gemma4-fast"


def test_meta_identity_uses_weak_tier():
    assert select_model_tier([
        {"role": "user", "content": "Расскажи о себе"}
    ]) == "gemma4-fast"


def test_simple_capability_question_uses_weak_tier():
    assert select_model_tier([
        {"role": "user", "content": "что ты умеешь"}
    ]) == "gemma4-fast"


def test_lightweight_social_chat_uses_weak_tier():
    assert select_model_tier([
        {"role": "user", "content": "как дела?"}
    ]) == "gemma4-fast"


def test_detailed_meta_question_can_use_medium_tier():
    assert select_model_tier([
        {"role": "user", "content": "Подробно расскажи о себе и своих возможностях"}
    ]) == "gemma4-balanced"


def test_compact_router_fix_uses_balanced_tier():
    assert select_model_tier([
        {"role": "user", "content": "Исправь баг в router.py и объясни причину"}
    ]) == "gemma4-balanced"


def test_intent_hint_participates_in_adaptive_score():
    assert select_model_tier([
        {"role": "user", "content": "debug router failure"}
    ], route_hint={"intentKind": "code_debug", "modelTier": "weak"}) == "gemma4-deepthinking"


def test_route_hint_cannot_be_downgraded():
    assert select_model_tier([
        {"role": "user", "content": "ping"}
    ], route_hint={"modelTier": "medium"}) == "gemma4-balanced"
    assert select_model_tier([
        {"role": "user", "content": "ping"}
    ], route_hint={"modelTier": "powerful"}) == "gemma4-deepthinking"


def test_reasoning_keyword_overrides_route_hint_floor():
    assert select_model_tier([
        {"role": "user", "content": "Докажи теорему Гёделя о неполноте"}
    ], route_hint={"modelTier": "medium"}) == "gemma4-deepthinking"


def test_short_text_generation_uses_fast_tier():
    assert select_model_tier([
        {"role": "user", "content": "Напиши пост для Telegram"}
    ]) == "gemma4-fast"


def test_router_never_selects_31b_without_explicit_override():
    assert select_model_tier([
        {"role": "user", "content": "Проведи сложный аудит архитектуры и докажи корректность решения пошагово"}
    ]) == "gemma4-deepthinking"
