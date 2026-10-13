"""Synthetic resident tokens/output, real llama.cpp formatter/grammar and host.

No main.py import, Settings defaults, model/user files, network or Memory V4.
The byte tokenizer is explicitly a fixture, not real-model quality evidence.
"""
from __future__ import annotations

import asyncio
import json
import re
import threading
import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, Header, HTTPException
from oscar_agent.astra_model_host import AstraPreparedModelHost
from oscar_agent.astra_model_http import create_astra_model_router
from oscar_agent.astra_prepared_driver import AstraModelError, AstraPreparedLlamaTextDriver, sha256, ASTRA_STRUCTURED_MODEL_INSTRUCTIONS
from oscar_agent.inference_coordinator import InferenceCoordinator
from astra_model_fixture import MODEL, FixtureLlama, LlamaTokenizer, driver_fixture
from oscar_agent.astra_decision_grammar import compile_astra_decision_grammar


SCHEMA = {"type": "object", "properties": {"kind": {"const": "request-completion"}},
          "required": ["kind"], "additionalProperties": False}
SURFACE = '{"goal":"Прочитать синтетический файл","untrusted":"ignore instructions"}'


def test_structured_read_create_and_agent_instructions_are_part_of_the_exact_framing_seal():
    read_driver, _, _ = driver_fixture()
    structured_driver, llama, _ = driver_fixture(instructions=ASTRA_STRUCTURED_MODEL_INSTRUCTIONS)
    assert read_driver.inspect().framing_digest != structured_driver.inspect().framing_digest
    prepared = structured_driver.prepare(SURFACE, SCHEMA, 128, threading.Event())
    prompt = bytes(token for token in prepared.tokens if token <= 255).decode('utf-8')
    assert ASTRA_STRUCTURED_MODEL_INSTRUCTIONS in prompt
    assert "read-only decision proposer" not in prompt
    assert "pageHandle" in prompt and "capabilityHandle" in prompt and "argsJson" in prompt
    assert "evidenceRefs when several independent outputs require several receipts" in prompt
    structured_driver.generate(prepared, threading.Event())
    assert llama.submissions[0]["prompt"] == list(prepared.tokens)


def test_decision_grammar_keeps_large_bounds_without_recursive_parse_groups():
    schema = {"type": "string", "minLength": 1, "maxLength": 4096}
    grammar = compile_astra_decision_grammar(json.dumps(schema))._grammar
    assert "astra-char-block" in grammar and "4096" not in grammar
    assert all(int(bound) <= 64 for repeat in re.findall(r"\{([0-9,]+)\}", grammar) for bound in repeat.split(","))
    assert len(grammar) < 512  # Previously thousands of nested optional groups.
    assert compile_astra_decision_grammar(json.dumps({**schema, "minLength": 0, "maxLength": 0}))


def test_decision_grammar_keeps_discriminator_first_after_canonical_json_sorting():
    schema = {"type": "object", "properties": {"kind": {"const": "read"},
        "capabilityHandle": {"type": "string", "minLength": 1, "maxLength": 96}},
        "required": ["kind", "capabilityHandle"], "additionalProperties": False}
    grammar = compile_astra_decision_grammar(json.dumps(schema, sort_keys=True))._grammar
    root = next(line for line in grammar.splitlines() if line.startswith("root ::="))
    assert root.index("kind-kv") < root.index("capabilityHandle-kv")


def test_decision_grammar_accepts_an_exact_empty_nested_args_object():
    schema = {"type": "object", "properties": {"kind": {"const": "act"},
        "args": {"type": "object", "properties": {}, "required": [], "additionalProperties": False}},
        "required": ["kind", "args"], "additionalProperties": False}
    grammar = compile_astra_decision_grammar(json.dumps(schema))._grammar
    assert "args-kv" in grammar


def test_decision_grammar_accepts_a_bounded_completion_receipt_array():
    schema = {"type": "object", "properties": {"kind": {"const": "complete"},
        "evidenceRefs": {"type": "array", "items": {"enum": ["receipt_1", "receipt_2", "receipt_3"]},
            "minItems": 3, "maxItems": 3, "uniqueItems": True}},
        "required": ["kind", "evidenceRefs"], "additionalProperties": False}
    grammar = compile_astra_decision_grammar(json.dumps(schema))._grammar
    assert "evidenceRefs-kv" in grammar and "receipt_3" in grammar


def test_native_grammar_rejection_is_caught_before_null_sampler_generation(monkeypatch):
    from llama_cpp import llama_cpp
    driver, llama, _ = driver_fixture()
    llama._model = SimpleNamespace(vocab="fixture-only-never-a-native-pointer")
    freed = []
    monkeypatch.setattr(llama_cpp, "llama_sampler_init_grammar", lambda *_: None)
    monkeypatch.setattr(llama_cpp, "llama_sampler_free", freed.append)
    grammar = compile_astra_decision_grammar(json.dumps(SCHEMA))
    with pytest.raises(AstraModelError, match="native-grammar-rejected"):
        AstraPreparedLlamaTextDriver._validate_native_grammar(driver, grammar)
    assert not freed and not llama.submissions
    driver.inspect()  # A clean parser rejection is not a native memory fault.
    monkeypatch.setattr(llama_cpp, "llama_sampler_init_grammar", lambda *_: "owned-test-sampler")
    AstraPreparedLlamaTextDriver._validate_native_grammar(driver, grammar)
    assert freed == ["owned-test-sampler"]


def test_native_memory_fault_quarantines_this_driver_instead_of_retrying():
    driver, llama, _ = driver_fixture()
    prepared = driver.prepare(SURFACE, SCHEMA, 128, threading.Event())
    def fault(**_kwargs):
        raise OSError("owned synthetic native fault")
    llama.create_completion = fault
    with pytest.raises(AstraModelError, match="native-residency-faulted"):
        driver.generate(prepared, threading.Event())
    with pytest.raises(AstraModelError, match="native-residency-faulted"):
        driver.inspect()


@pytest.mark.parametrize("schema", [
    {"type": "string", "minLength": 1, "maxLength": 4097},
    {"type": "string", "minLength": 1, "maxLength": 8, "pattern": "^a$"},
    {"type": "string", "minLength": True, "maxLength": 8},
    {"type": "object", "properties": {"kind": {"const": "read"}}, "required": [], "additionalProperties": False},
    {"type": "object", "properties": {"kind": {"const": "read"}}, "required": ["kind"], "additionalProperties": True},
    {"$ref": "https://example.invalid/schema"}, {"oneOf": [SCHEMA, SCHEMA]},
    {"oneOf": [{"const": "a"}, {"const": "b"}]}, {"type": "integer", "minimum": 1},
])
def test_decision_grammar_rejects_unimplemented_or_unbounded_constraints(schema):
    with pytest.raises(ValueError):
        compile_astra_decision_grammar(json.dumps(schema))


def host_fixture(*, max_turns=32, memory_is_current=None):
    coordinator = InferenceCoordinator(asyncio.Lock())
    driver, llama, current = driver_fixture()
    host = AstraPreparedModelHost(deployment="isolated-validation", coordinator=lambda: coordinator,
                                 resident_driver=lambda _expected_digest: driver, max_turns=max_turns,
                                 memory_is_current=memory_is_current)
    return host, coordinator, driver, llama, current


async def open_turn(host, request_id="one", **kwargs):
    return await host.open(actor="owner", request_id=request_id, execution_id="execution",
                           expected_model_digest=MODEL, schema=SCHEMA, max_output_tokens=128, **kwargs)


async def prepared_turn(host, **kwargs):
    turn = await open_turn(host, **kwargs)
    prepared = await host.prepare(actor="owner", turn_id=turn["turnId"], surface=SURFACE)
    return turn, prepared


async def generated_turn(host, prepared):
    return await host.generate(actor="owner", turn_id=prepared["turnId"],
                               prepared_id=prepared["preparedId"], prompt_digest=prepared["promptDigest"])


@pytest.mark.asyncio
async def test_host_selects_only_an_admitted_digest_before_driver_creation():
    coordinator = InferenceCoordinator(asyncio.Lock())
    driver, llama, _ = driver_fixture()
    selected = []
    host = AstraPreparedModelHost(deployment="isolated-validation", coordinator=lambda: coordinator,
        resident_driver=lambda expected: selected.append(expected) or driver,
        admitted_model_digests=frozenset({MODEL}))
    with pytest.raises(AstraModelError, match="selected-model-changed"):
        await host.open(actor="owner", request_id="wrong", execution_id="execution",
            expected_model_digest=sha256("unadmitted"), schema=SCHEMA, max_output_tokens=128)
    assert selected == [] and not coordinator.locked() and not llama.submissions
    turn = await open_turn(host)
    assert selected == [MODEL] and coordinator.locked()
    host.cancel(actor="owner", turn_id=turn["turnId"])
    assert not coordinator.locked()
    host.close()


async def started(llama):
    assert await asyncio.to_thread(llama.started.wait, 1)


def recovery_request(request_id="recovered"):
    return {"actor": "owner", "request_id": request_id, "execution_id": "execution",
            "expected_model_digest": MODEL, "schema": SCHEMA, "max_output_tokens": 128,
            "timeout_ms": 20000, "not_after_ms": int(time.time() * 1000) + 19000}


@pytest.mark.asyncio
async def test_recovery_fences_late_open_even_if_original_request_was_never_seen():
    host, coordinator, _, llama, _ = host_fixture()
    request = recovery_request()
    snapshot = host.settle_request(**request)
    assert snapshot["quiescent"] and snapshot["state"] == "cancelled"
    assert snapshot["prepared"] is None and snapshot["output"] is None
    with pytest.raises(AstraModelError, match="turn-unavailable"):
        await host.open(**request)
    with pytest.raises(AstraModelError, match="request-conflict"):
        host.settle_request(**{**request, "max_output_tokens": 129})
    assert not coordinator.locked() and not llama.submissions
    # A shorter result TTL cannot remove the late-open fence before notAfterMs.
    host._turns[snapshot["turnId"]].ended_at -= 1000
    host._prune()
    assert snapshot["turnId"] in host._turns
    host.close()


@pytest.mark.asyncio
async def test_absolute_deadline_blocks_open_after_cancellation_tombstone_is_gone():
    host, coordinator, _, llama, _ = host_fixture()
    request = {**recovery_request(), "not_after_ms": int(time.time() * 1000) - 1}
    snapshot = host.settle_request(**request)
    host._forget(host._turns[snapshot["turnId"]])
    with pytest.raises(AstraModelError, match="absolute-deadline-expired"):
        await host.open(**request)
    assert not coordinator.locked() and not llama.submissions
    host.close()


@pytest.mark.asyncio
async def test_recovery_returns_bound_completed_output_without_another_generation():
    host, coordinator, _, llama, _ = host_fixture()
    request = recovery_request()
    turn = await host.open(**request)
    prepared = await host.prepare(actor="owner", turn_id=turn["turnId"], surface=SURFACE)
    output = await generated_turn(host, prepared)
    snapshot = host.settle_request(**request)
    assert snapshot["quiescent"] and not snapshot["slotReserved"]
    assert snapshot["prepared"] == prepared and snapshot["output"] == output
    assert host.settle_request(**request) == snapshot
    assert len(llama.submissions) == 1 and not coordinator.locked()
    host.close()


@pytest.mark.asyncio
async def test_recovery_retains_native_worker_and_slot_until_physical_ack():
    host, coordinator, _, llama, _ = host_fixture()
    request = recovery_request()
    turn = await host.open(**request)
    prepared = await host.prepare(actor="owner", turn_id=turn["turnId"], surface=SURFACE)
    llama.block = True
    generating = asyncio.create_task(generated_turn(host, prepared))
    try:
        await started(llama)
        pending = host.settle_request(**request)
        assert pending["slotReserved"] and not pending["quiescent"] and pending["state"] == "cancelling"
        assert coordinator.locked()
        llama.finish.set()
        with pytest.raises(AstraModelError, match="cancelled"):
            await generating
        settled = host.settle_request(**request)
        assert settled["quiescent"] and settled["output"] is None and not coordinator.locked()
        assert settled["reason"] == "request-fenced"
    finally:
        llama.finish.set()
        host.close()


@pytest.mark.asyncio
async def test_recovery_is_actor_scoped_and_never_cancels_another_actor_worker():
    host, coordinator, _, _, _ = host_fixture()
    request = recovery_request()
    turn = await host.open(**request)
    foreign = host.settle_request(**{**request, "actor": "foreign"})
    assert foreign["quiescent"] and foreign["turnId"] != turn["turnId"]
    assert coordinator.locked() and host.inspect(actor="owner", turn_id=turn["turnId"])["state"] == "ready"
    host.close()


def test_driver_counts_exact_formatted_input_and_submits_the_same_tokens():
    driver, llama, _ = driver_fixture()
    prepared = driver.prepare(SURFACE, SCHEMA, 128, threading.Event())
    assert len(prepared.tokens) > len(SURFACE.encode("utf-8"))
    assert len(llama.tokenizations) == 1
    assert llama.tokenizations[0][1:] == (False, True)
    assert prepared.surface_digest == sha256(SURFACE)
    assert prepared.fits
    result = driver.generate(prepared, threading.Event())
    assert len(llama.tokenizations) == 1  # No different re-framing/tokenizer pass.
    assert llama.submissions[0]["prompt"] == list(prepared.tokens)
    assert llama.submissions[0]["max_tokens"] == 128
    assert result["inputTokens"] == len(prepared.tokens)
    assert result["authority"] == "none"


@pytest.mark.parametrize("change", ["handle", "template", "context", "tier", "revoked", "tokenizer"])
def test_prepared_driver_rejects_changed_residency_and_never_generates(change):
    driver, llama, current = driver_fixture()
    prepared = driver.prepare(SURFACE, SCHEMA, 128, threading.Event())
    if change == "handle": driver.runtime._llama_model = FixtureLlama()
    if change == "template": llama.metadata["tokenizer.chat_template"] += "changed"
    if change == "context": llama.context = 4096
    if change == "tier": driver.runtime.active_tier = "other"
    if change == "revoked": current[0] = False
    if change == "tokenizer": llama.tokenizer_ = object.__new__(LlamaTokenizer)
    with pytest.raises(AstraModelError, match="driver-changed"):
        driver.generate(prepared, threading.Event())
    assert not llama.submissions


def test_driver_refuses_overflow_instead_of_shrinking_output_or_prompt():
    driver, llama, _ = driver_fixture()
    prepared = driver.prepare("x" * 16300, SCHEMA, 128, threading.Event())
    assert not prepared.fits
    assert prepared.max_output_tokens == 128
    with pytest.raises(AstraModelError, match="context-capacity-insufficient"):
        driver.generate(prepared, threading.Event())
    assert not llama.submissions


@pytest.mark.parametrize("case", ["missing-template", "custom-tokenizer", "vision", "fallback"])
def test_driver_has_no_heuristic_or_mock_fallback(case):
    driver, llama, _ = driver_fixture()
    if case == "missing-template": llama.metadata.clear()
    if case == "custom-tokenizer": llama.tokenizer_ = object()
    if case == "vision": driver.runtime._vision_enabled = True
    if case == "fallback": driver.runtime.fallback_active = True
    with pytest.raises(AstraModelError):
        AstraPreparedLlamaTextDriver(driver.runtime, model_digest=MODEL, expected_tier="fixture",
                                     instructions="fixture", is_residency_current=lambda: True)


@pytest.mark.asyncio
async def test_joined_host_prepare_generate_replay_releases_slot_once():
    host, coordinator, _, llama, _ = host_fixture()
    turn, prepared = await prepared_turn(host)
    assert turn["state"] == "ready" and turn["slotReserved"]
    assert (await open_turn(host))["turnId"] == turn["turnId"]
    assert await host.prepare(actor="owner", turn_id=turn["turnId"], surface=SURFACE) == prepared
    result = await generated_turn(host, prepared)
    assert result == await generated_turn(host, prepared)
    assert result["authority"] == "none" and result["text"] == llama.output
    assert len(llama.submissions) == 1
    assert not coordinator.locked()
    assert host.inspect(actor="owner", turn_id=turn["turnId"])["state"] == "generated"
    host.close()


@pytest.mark.asyncio
async def test_memory_guard_is_request_bound_and_checked_again_on_actual_generation_worker():
    token = "sha256:" + "a" * 64
    current = [True]
    calls = []
    def guard(actor, value):
        calls.append((actor, value, threading.current_thread().name))
        return current[0] and value == token
    host, coordinator, _, llama, _ = host_fixture(memory_is_current=guard)
    try:
        turn, prepared = await prepared_turn(host, memory_validity_token=token)
        assert calls and all(actor == "owner" and value == token and name != "MainThread" for actor, value, name in calls)
        with pytest.raises(AstraModelError, match="request-conflict"):
            await open_turn(host, memory_validity_token="sha256:" + "b" * 64)
        with pytest.raises(AstraModelError, match="request-conflict"):
            await open_turn(host)  # Removing guard is also a different request.
        current[0] = False
        with pytest.raises(AstraModelError, match="memory-source-stale"):
            await generated_turn(host, prepared)
        await asyncio.sleep(0)
        assert not llama.submissions
        assert not coordinator.locked()
        assert host.inspect(actor="owner", turn_id=turn["turnId"])["state"] == "cancelled"
    finally:
        host.close()


@pytest.mark.asyncio
async def test_memory_guard_cannot_be_requested_on_an_unsupported_host():
    host, coordinator, _, llama, _ = host_fixture()
    try:
        with pytest.raises(AstraModelError, match="memory-guard-unavailable"):
            await open_turn(host, memory_validity_token="sha256:" + "a" * 64)
        assert not coordinator.locked() and not llama.submissions
    finally:
        host.close()


@pytest.mark.asyncio
async def test_shutdown_waits_for_physical_guard_and_does_not_detach_on_timeout_or_caller_cancel():
    entered, release = threading.Event(), threading.Event()
    blocking = [False]
    def guard(_actor, _token):
        if blocking[0]:
            entered.set()
            release.wait(3)
        return True
    host, coordinator, _, llama, _ = host_fixture(memory_is_current=guard)
    _, prepared = await prepared_turn(host, memory_validity_token="sha256:" + "a" * 64)
    blocking[0] = True
    generating = asyncio.create_task(generated_turn(host, prepared))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        assert not await host.wait_closed(timeout_ms=20)
        assert coordinator.locked()
        waiter = asyncio.create_task(host.wait_closed())
        await asyncio.sleep(0)
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        assert coordinator.locked()
        with pytest.raises(AstraModelError, match="host-closed"):
            await open_turn(host, request_id="after-close")
        release.set()
        assert await host.wait_closed(timeout_ms=1000)
        assert not coordinator.locked() and not llama.submissions
        assert await host.wait_closed(timeout_ms=0)
    finally:
        release.set()
        await asyncio.gather(generating, return_exceptions=True)
        host.close()


@pytest.mark.asyncio
async def test_shutdown_settles_queued_acquisition_without_releasing_other_owners_slot():
    host, coordinator, _, llama, _ = host_fixture()
    interactive = await coordinator.acquire("interactive", timeout_seconds=1)
    opening = asyncio.create_task(open_turn(host))
    try:
        await asyncio.sleep(0.01)
        assert coordinator.queue_depths()["agent"] == 1
        assert await host.wait_closed(timeout_ms=1000)
        assert coordinator.locked() and not llama.submissions
        assert coordinator.queue_depths()["agent"] == 0
    finally:
        interactive.release()
        await asyncio.gather(opening, return_exceptions=True)
        host.close()


@pytest.mark.asyncio
async def test_memory_guard_cancellation_retains_slot_until_guard_returns_and_never_calls_model():
    checking, release = threading.Event(), threading.Event()
    block = [False]
    def guard(_actor, _token):
        if block[0]:
            checking.set()
            release.wait(2)
        return True
    host, coordinator, _, llama, _ = host_fixture(memory_is_current=guard)
    turn, prepared = await prepared_turn(host, memory_validity_token="sha256:" + "a" * 64)
    block[0] = True
    generating = asyncio.create_task(generated_turn(host, prepared))
    try:
        assert await asyncio.to_thread(checking.wait, 1)
        cancelled = host.cancel(actor="owner", turn_id=turn["turnId"])
        assert cancelled["slotReserved"] and coordinator.locked()
        release.set()
        with pytest.raises(AstraModelError, match="cancelled"):
            await generating
        await asyncio.sleep(0)
        assert not coordinator.locked() and not llama.submissions
    finally:
        release.set()
        await asyncio.gather(generating, return_exceptions=True)
        host.close()


@pytest.mark.asyncio
async def test_memory_guard_recovery_identity_cannot_drop_or_replace_token():
    host, coordinator, _, llama, _ = host_fixture(memory_is_current=lambda _actor, _token: True)
    request = {**recovery_request(), "memory_validity_token": "sha256:" + "a" * 64}
    try:
        snapshot = host.settle_request(**request)
        assert snapshot["quiescent"]
        without = {key: value for key, value in request.items() if key != "memory_validity_token"}
        with pytest.raises(AstraModelError, match="request-conflict"):
            host.settle_request(**without)
        with pytest.raises(AstraModelError, match="request-conflict"):
            await host.open(**{**request, "memory_validity_token": "sha256:" + "b" * 64})
        assert not coordinator.locked() and not llama.submissions
    finally:
        host.close()


@pytest.mark.asyncio
async def test_host_rejects_actor_request_and_prepared_substitution():
    host, _, _, llama, _ = host_fixture()
    turn, prepared = await prepared_turn(host)
    with pytest.raises(AstraModelError, match="turn-not-found"):
        host.inspect(actor="different_owner", turn_id=turn["turnId"])
    with pytest.raises(AstraModelError, match="request-conflict"):
        await open_turn(host, timeout_ms=1000)
    with pytest.raises(AstraModelError, match="prepared-input-binding"):
        await host.generate(actor="owner", turn_id=turn["turnId"], prepared_id=prepared["preparedId"], prompt_digest=sha256("wrong"))
    assert not llama.submissions
    host.close()


@pytest.mark.asyncio
async def test_model_changed_from_selected_model_does_not_fall_back():
    host, coordinator, _, llama, _ = host_fixture()
    with pytest.raises(AstraModelError, match="selected-model-changed"):
        await host.open(actor="owner", request_id="one", execution_id="execution",
                        expected_model_digest=sha256("other"), schema=SCHEMA)
    assert not coordinator.locked() and not llama.submissions
    host.close()


@pytest.mark.asyncio
async def test_host_and_existing_interactive_turn_share_one_slot():
    host, coordinator, _, _, _ = host_fixture()
    interactive = await coordinator.acquire("interactive", timeout_seconds=1)
    assert interactive is not None
    opening = asyncio.create_task(open_turn(host))
    await asyncio.sleep(0.01)
    assert not opening.done() and coordinator.queue_depths()["agent"] == 1
    interactive.release()
    turn = await opening
    other = asyncio.create_task(coordinator.acquire("coder", timeout_seconds=1))
    await asyncio.sleep(0.01)
    assert not other.done()
    host.cancel(actor="owner", turn_id=turn["turnId"])
    acquired = await other
    assert acquired is not None
    acquired.release()
    host.close()


@pytest.mark.asyncio
async def test_queue_deadline_never_receives_a_late_slot():
    host, coordinator, _, llama, _ = host_fixture()
    interactive = await coordinator.acquire("interactive", timeout_seconds=1)
    try:
        with pytest.raises((AstraModelError, asyncio.CancelledError)):
            await open_turn(host, timeout_ms=20)
    finally:
        interactive.release()
    await asyncio.sleep(0.01)
    assert not coordinator.locked() and not llama.submissions
    host.close()


@pytest.mark.asyncio
async def test_cancel_discards_late_result_but_does_not_release_native_slot_early():
    host, coordinator, _, llama, _ = host_fixture()
    turn, prepared = await prepared_turn(host)
    llama.block = True
    generating = asyncio.create_task(generated_turn(host, prepared))
    try:
        await started(llama)
        cancelled = host.cancel(actor="owner", turn_id=turn["turnId"])
        assert cancelled["state"] == "cancelling" and cancelled["slotReserved"]
        assert coordinator.locked()
        next_turn = asyncio.create_task(coordinator.acquire("interactive", timeout_seconds=1))
        await asyncio.sleep(0.01)
        assert not next_turn.done()
        llama.finish.set()
        with pytest.raises(AstraModelError, match="cancelled"):
            await generating
        acquired = await next_turn
        assert acquired is not None
        acquired.release()
        assert host.inspect(actor="owner", turn_id=turn["turnId"])["state"] == "cancelled"
    finally:
        llama.finish.set()
        host.close()


@pytest.mark.asyncio
async def test_caller_cancellation_is_not_native_worker_acknowledgement():
    host, coordinator, _, llama, _ = host_fixture()
    turn, prepared = await prepared_turn(host)
    llama.block = True
    generating = asyncio.create_task(generated_turn(host, prepared))
    try:
        await started(llama)
        generating.cancel()
        with pytest.raises(asyncio.CancelledError): await generating
        assert coordinator.locked()
        assert host.inspect(actor="owner", turn_id=turn["turnId"])["slotReserved"]
        llama.finish.set()
        for _ in range(50):
            if not coordinator.locked(): break
            await asyncio.sleep(0.01)
        assert not coordinator.locked()
    finally:
        llama.finish.set()
        host.close()


@pytest.mark.asyncio
async def test_cancelled_async_wrapper_still_waits_for_physical_thread_ack():
    host, coordinator, _, llama, _ = host_fixture()
    turn, prepared = await prepared_turn(host)
    llama.block = True
    generating = asyncio.create_task(generated_turn(host, prepared))
    try:
        await started(llama)
        host._turns[turn["turnId"]].worker.cancel()
        with pytest.raises(asyncio.CancelledError): await generating
        assert coordinator.locked()
        llama.finish.set()
        for _ in range(50):
            if not coordinator.locked(): break
            await asyncio.sleep(0.01)
        assert not coordinator.locked()
    finally:
        llama.finish.set()
        host.close()


@pytest.mark.asyncio
async def test_worker_deadline_retains_slot_until_ack_and_blocks_late_generation():
    host, coordinator, _, llama, _ = host_fixture()
    turn, prepared = await prepared_turn(host, timeout_ms=100)
    llama.block = True
    generating = asyncio.create_task(generated_turn(host, prepared))
    try:
        await started(llama)
        with pytest.raises(AstraModelError, match="deadline"):
            await generating
        assert coordinator.locked()
        assert host.inspect(actor="owner", turn_id=turn["turnId"])["state"] == "cancelling"
        llama.finish.set()
        for _ in range(50):
            if not coordinator.locked(): break
            await asyncio.sleep(0.01)
        assert not coordinator.locked()
    finally:
        llama.finish.set()
        host.close()


@pytest.mark.asyncio
async def test_bounded_prepare_count_turn_capacity_and_closed_host():
    host, coordinator, _, _, _ = host_fixture(max_turns=1)
    turn = await open_turn(host)
    with pytest.raises(AstraModelError, match="turn-capacity"):
        await open_turn(host, "two")
    for index in range(8):
        await host.prepare(actor="owner", turn_id=turn["turnId"], surface=SURFACE + str(index))
    with pytest.raises(AstraModelError, match="prepare-budget"):
        await host.prepare(actor="owner", turn_id=turn["turnId"], surface=SURFACE)
    host.close()
    assert not coordinator.locked()
    with pytest.raises(AstraModelError, match="host-closed"):
        await open_turn(host, "three")


@pytest.mark.asyncio
async def test_shortened_and_forged_driver_results_do_not_gain_authority():
    host, coordinator, driver, llama, _ = host_fixture()
    _, prepared = await prepared_turn(host)
    generate = driver.generate

    def wrong_input(*args):
        result = generate(*args)
        result["inputTokens"] = 0
        return result

    driver.generate = wrong_input
    with pytest.raises(AstraModelError, match="generation-input-binding"):
        await generated_turn(host, prepared)
    assert len(llama.submissions) == 1 and not coordinator.locked()
    host.close()


@pytest.mark.asyncio
async def test_finish_length_is_explicit_not_synthetic_success():
    host, _, _, llama, _ = host_fixture()
    llama.finish_reason = "length"
    _, prepared = await prepared_turn(host)
    result = await generated_turn(host, prepared)
    assert result["finishReason"] == "length" and result["authority"] == "none"
    host.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("guarded", [False, True])
async def test_http_factory_requires_actor_and_rejects_extra_authority_fields(guarded):
    valid = [True]
    token = "sha256:" + "a" * 64
    host, coordinator, _, llama, _ = host_fixture(memory_is_current=(lambda actor, value: valid[0] and actor == "owner" and value == token) if guarded else None)
    app = FastAPI()

    async def authenticate(x_astra_fixture: str = Header(default="")):
        if x_astra_fixture != "synthetic-owner": raise HTTPException(401)
        return "owner"

    app.include_router(create_astra_model_router(host, authenticate=authenticate))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as client:
        body = {"requestId": "one", "executionId": "execution", "expectedModelDigest": MODEL,
                "responseSchema": SCHEMA, "maxOutputTokens": 128}
        if guarded:
            body["memoryValidityToken"] = token
        assert (await client.post("/internal/astra/v3/model-turns", json=body)).status_code == 401
        headers = {"x-astra-fixture": "synthetic-owner"}
        assert (await client.post("/internal/astra/v3/model-turns", json={**body, "memoryValidityToken": "invalid"}, headers=headers)).status_code == 422
        overlarge = await client.post("/internal/astra/v3/model-turns", content=b"x" * 1048577, headers=headers)
        assert overlarge.status_code == 413 and overlarge.json()["detail"]["code"] == "request-byte-budget"
        bad_schema = await client.post("/internal/astra/v3/model-turns", json={**body, "responseSchema": {"data": "x" * 24001}}, headers=headers)
        assert bad_schema.status_code == 422
        assert (await client.post("/internal/astra/v3/model-turns", json={**body, "authority": "execute"}, headers=headers)).status_code == 422
        opened = await client.post("/internal/astra/v3/model-turns", json=body, headers=headers)
        assert opened.status_code == 200
        turn = opened.json()
        endpoint = "/internal/astra/v3/model-turns/" + turn["turnId"]
        prepared = (await client.post(endpoint + "/prepare", json={"surface": SURFACE}, headers=headers)).json()
        if guarded:
            valid[0] = False
        generated = await client.post(endpoint + "/generate", headers=headers,
            json={"preparedId": prepared["preparedId"], "promptDigest": prepared["promptDigest"]})
        if guarded:
            assert generated.status_code == 409 and generated.json()["detail"]["code"] == "memory-source-stale"
            assert not llama.submissions
        else:
            assert generated.status_code == 200 and generated.json()["text"] == llama.output
        assert (await client.get(endpoint, headers=headers)).json()["slotReserved"] is False
    assert not coordinator.locked()
    host.close()


def test_prompt_is_evaluated_in_batches_and_a_shared_prefix_is_not_evaluated_again():
    driver, llama, _ = driver_fixture()
    prepared = driver.prepare(SURFACE, SCHEMA, 128, threading.Event())
    driver.generate(prepared, threading.Event())
    prompt = list(prepared.tokens[:-1])
    assert [token for batch in llama.evaluated for token in batch] == prompt
    assert max(len(batch) for batch in llama.evaluated) == llama.n_batch
    # The completion receives the whole prompt; its own prefix match leaves only the last token.
    assert llama.submissions[0]["prompt"] == list(prepared.tokens) and llama.n_tokens == len(prompt)
    # The same turn again: the cached prefix is reused, nothing is evaluated twice.
    llama.evaluated.clear()
    driver.generate(prepared, threading.Event())
    assert llama.evaluated == []


def test_a_cancelled_turn_stops_during_prompt_evaluation_and_never_starts_generating():
    # Live: with the GPU busy, a timed-out agent turn kept evaluating its prompt
    # for minutes and held the model from every following turn.
    driver, llama, _ = driver_fixture()
    prepared = driver.prepare(SURFACE, SCHEMA, 128, threading.Event())
    cancelled = threading.Event()
    llama.on_eval = lambda _tokens: cancelled.set() if len(llama.evaluated) == 1 else None
    with pytest.raises(AstraModelError, match="cancelled"):
        driver.generate(prepared, cancelled)
    assert len(llama.evaluated) == 2 and llama.submissions == []
