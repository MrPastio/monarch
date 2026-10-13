"""Real Memory V4 database and prepared host, synthetic driver only."""
import asyncio

import pytest

from oscar_agent.astra_memory_guard import create_astra_memory_guard
from oscar_agent.astra_prepared_driver import AstraModelError
from test_memory_v4 import make_services, create_explicit, POLICY_HASH
from test_astra_model_host import host_fixture, prepared_turn, generated_turn


@pytest.mark.asyncio
@pytest.mark.parametrize("revoke", [False, True])
async def test_real_memory_guard_checks_actual_worker_after_prepare(tmp_path, monkeypatch, revoke):
    _, context, service = make_services(tmp_path)
    receipt = create_explicit(context, request_id="guard-seed", text="synthetic memory")
    token = service.read_context_validity({"type": "chat"})["validityToken"]
    monkeypatch.setattr(service, "retrieve", lambda *_: pytest.fail("guard must not retrieve text"))
    host, coordinator, _, llama, _ = host_fixture(memory_is_current=create_astra_memory_guard(service, owner_actor="owner"))
    try:
        turn, prepared = await prepared_turn(host, memory_validity_token=token)
        if revoke:
            context.execute(client_request_id="guard-delete", command="memory.delete", scope={"type": "chat"},
                            expected_revision=1, payload={"id": receipt["result"]["record"]["id"]},
                            policy_decision_hash=POLICY_HASH)
            with pytest.raises(AstraModelError, match="memory-source-stale"):
                await generated_turn(host, prepared)
        else:
            await generated_turn(host, prepared)
        await asyncio.sleep(0)
        assert len(llama.submissions) == (0 if revoke else 1)
        assert not coordinator.locked()
        assert host.inspect(actor="owner", turn_id=turn["turnId"])["state"] == ("cancelled" if revoke else "generated")
    finally:
        host.close()
        service.close()


def test_memory_guard_binds_owner_scope_and_fails_closed(tmp_path, monkeypatch):
    _, _, service = make_services(tmp_path)
    calls = []
    def validity(scope, *, lock_timeout):
        calls.append((scope, lock_timeout))
        raise OSError("synthetic unavailable database")
    monkeypatch.setattr(service, "read_context_validity", validity)
    try:
        guard = create_astra_memory_guard(service, owner_actor="owner")
        assert not guard("other", "sha256:" + "a" * 64)
        assert not guard("owner", "invalid")
        assert not calls
        assert not guard("owner", "sha256:" + "a" * 64)
        assert calls == [({"type": "chat"}, 0.1)]
        with pytest.raises(ValueError, match="memory-guard-owner"):
            create_astra_memory_guard(service, owner_actor="")
    finally:
        service.close()
