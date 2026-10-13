from oscar_agent.config import Settings
from oscar_agent.model_runtime import LocalModelRuntime
from oscar_agent.prompt_catalog import OSCAR_SYSTEM_PROMPT_RU, OSCAR_SYSTEM_PROMPT_EN
from oscar_agent.schemas import ChatMessage
import pytest


@pytest.mark.parametrize('user_text,marker,memory_rule', [
    ('Как работает твоя память?', 'language="ru"', 'не являются воспоминаниями о пользователе'),
    ('How does your memory work?', 'language="en"', 'not model training knowledge'),
])
def test_real_prompt_builder_includes_plain_memory_policy(user_text, marker, memory_rule):
    runtime = LocalModelRuntime(Settings(api_token='synthetic', mock_model=True))
    messages = runtime._build_prompt_messages([ChatMessage(role='user', content=user_text)], [], 'low')
    prompt = messages[0].content
    assert marker in prompt
    assert 'version="3.4"' in prompt
    assert memory_rule in prompt


@pytest.mark.parametrize('prompt', [OSCAR_SYSTEM_PROMPT_RU, OSCAR_SYSTEM_PROMPT_EN])
def test_prompt_budget_and_no_tool_instruction_precedence(prompt):
    assert len(prompt) <= 4600
    assert 'execution receipts/tools →' not in prompt


@pytest.mark.parametrize('profile', ['full', 'compact-social'])
@pytest.mark.parametrize('user_text', ['Как работает твоя память?', 'How does memory work?'])
def test_custom_style_cannot_remove_host_memory_contract(profile, user_text):
    runtime = LocalModelRuntime(Settings(api_token='synthetic', mock_model=True))
    runtime.resolve_prompt = lambda prompt_id, fallback: 'Custom saved style.'
    prompt = runtime._build_prompt_messages([ChatMessage(role='user', content=user_text)], [], 'low', context_profile=profile)[0].content
    assert prompt.startswith('Custom saved style.')
    assert prompt.count('<monarch_response_contract>') == 1
    assert 'successful save' in prompt or 'успешного сохранения' in prompt


def test_agent_runtime_marker_is_host_authoritative_not_untrusted_context():
    """The host asserts a boolean; the wording is ours.

    Sent as prose, the same fact arrived as an untrusted context block and the
    model answered that it cannot touch the user's computer — false about
    Oscar, since Monarch routes ordinary work to the Agent Runtime.
    """
    from oscar_agent.prompt_catalog import AGENT_RUNTIME_CONTEXT_MARKER

    runtime = LocalModelRuntime(Settings(api_token='synthetic', mock_model=True))
    prompt = runtime._build_prompt_messages(
        [
            ChatMessage(role='system', content=AGENT_RUNTIME_CONTEXT_MARKER),
            ChatMessage(role='user', content='ты умеешь создавать файлы?'),
        ],
        [], 'low',
    )[0].content

    assert '<monarch_agent_runtime_context>' in prompt
    assert 'подключён Agent Runtime Monarch' in prompt
    assert 'не заявляй об успехе без результата исполнителя' in prompt
    # The marker must not also survive as a quoted context block.
    assert AGENT_RUNTIME_CONTEXT_MARKER not in prompt
    assert '<context_block_1>' not in prompt


def test_agent_runtime_context_is_absent_without_the_marker():
    runtime = LocalModelRuntime(Settings(api_token='synthetic', mock_model=True))
    prompt = runtime._build_prompt_messages(
        [ChatMessage(role='user', content='ты умеешь создавать файлы?')], [], 'low',
    )[0].content
    assert '<monarch_agent_runtime_context>' not in prompt
