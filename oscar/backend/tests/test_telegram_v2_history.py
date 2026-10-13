from pathlib import Path
import sqlite3

from oscar_agent.config import Settings
from oscar_agent.memory import MemoryStore


def fixture_store(root: Path) -> MemoryStore:
    return MemoryStore(Settings(data_dir=root / 'data', db_path=root / 'history.sqlite',
        offload_dir=root / 'offload', workspace_root=root / 'workspace',
        workspace_generated_dir=root / 'generated', gemma_models_dir=root / 'models',
        coder_models_dir=root / 'coder', mock_model=True))


def test_local_only_migrates_without_losing_existing_history(tmp_path: Path):
    store = fixture_store(tmp_path)
    conversation = store.create_conversation('Fixture')
    store.append_conversation_message(conversation['id'], 'user', 'Existing fixture text')
    with sqlite3.connect(tmp_path / 'history.sqlite') as connection:
        connection.execute('ALTER TABLE conversations DROP COLUMN local_only')
    reopened = fixture_store(tmp_path)
    history = reopened.get_conversation(conversation['id'])
    assert history['local_only'] is False
    assert history['messages'][0]['content'] == 'Existing fixture text'
    reopened.update_conversation(conversation['id'], local_only=True)
    assert fixture_store(tmp_path).get_conversation(conversation['id'])['local_only'] is True


def test_telegram_origin_does_not_depend_on_conversation_id(tmp_path: Path):
    store = fixture_store(tmp_path)
    local = store.create_conversation('Local fixture')
    remote = store.create_conversation('Telegram fixture')
    store.append_conversation_message(local['id'], 'user', 'Local')
    store.append_conversation_message(remote['id'], 'assistant', 'Cloud answer',
        provenance={'surface': 'telegram-cloud', 'executionAuthority': 'none'})
    conversations = {c['id']: c for c in store.list_conversations()}
    assert conversations[local['id']]['telegram_origin'] is False
    assert conversations[remote['id']]['telegram_origin'] is True
    assert store.get_conversation(remote['id'])['messages'][0]['content'] == 'Cloud answer'
