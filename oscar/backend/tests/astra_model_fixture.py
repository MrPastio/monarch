"""Owned test-only resident substitute. Never import this from product code."""
from __future__ import annotations

import threading
from contextlib import nullcontext
from types import SimpleNamespace

from oscar_agent.astra_prepared_driver import ASTRA_READ_MODEL_INSTRUCTIONS, AstraPreparedLlamaTextDriver, sha256
from oscar_agent.model_runtime import configure_nvidia_dll_directories

configure_nvidia_dll_directories()
from llama_cpp import LlamaTokenizer

MODEL = sha256("owned synthetic resident fixture, not a model asset digest")


class FixtureLlama:
    def __init__(self):
        self.metadata = {"tokenizer.chat_template": "{{bos_token}}{% for m in messages %}{{m['role']}}:{{m['content']}}<end>{% endfor %}assistant:"}
        self.tokenizer_ = object.__new__(LlamaTokenizer)
        self.context = 16384
        self.tokenizations: list[tuple[bytes, bool, bool]] = []
        self.submissions: list[dict] = []
        self.output = '{"kind":"request-completion"}'
        self.finish_reason = "stop"
        self.block = False
        self.started = threading.Event()
        self.finish = threading.Event()
        self.interrupted_closed = False
        # The prompt evaluation surface the driver uses (Llama.eval and its cache).
        self.n_batch = 4
        self.n_tokens = 0
        self.input_ids: list[int] = []
        self.evaluated: list[list[int]] = []
        self.on_eval = None
        self._ctx = SimpleNamespace(kv_cache_seq_rm=lambda _seq, _start, _end: True)

    def reset(self):
        self.n_tokens = 0

    def eval(self, tokens):
        if self.on_eval:
            self.on_eval(tokens)
        self.evaluated.append(list(tokens))
        del self.input_ids[self.n_tokens:]
        self.input_ids.extend(tokens)
        self.n_tokens += len(tokens)

    def token_bos(self): return 300
    def token_eos(self): return 301
    def n_ctx(self): return self.context
    def detokenize(self, tokens, **_kwargs): return b"<s>" if tokens == [300] else b"</s>"

    def tokenize(self, raw, *, add_bos, special):
        self.tokenizations.append((raw, add_bos, special))
        return ([300] if add_bos else []) + list(raw)

    def create_completion(self, **kwargs):
        self.submissions.append(kwargs)
        self.started.set()
        try:
            if self.block:
                assert self.finish.wait(3), "test did not release its own worker"
            yield {"choices": [{"text": self.output, "finish_reason": self.finish_reason}]}
        finally:
            self.interrupted_closed = True


class FixturePreparedDriver(AstraPreparedLlamaTextDriver):
    def _validate_native_grammar(self, grammar):
        # This resident has no model/vocabulary. Native sampler admission is
        # exercised only by the opt-in pinned-model harness, never claimed here.
        assert isinstance(grammar._grammar, str) and grammar._grammar


def driver_fixture(*, instructions=ASTRA_READ_MODEL_INSTRUCTIONS):
    llama = FixtureLlama()
    cancelled = threading.Event()
    current = [True]
    runtime = SimpleNamespace(loaded=True, fallback_active=False, active_tier="fixture", _llama_model=llama,
        _vision_enabled=False, _llama_output_context=nullcontext,
        settings=SimpleNamespace(repetition_penalty=1.1),
        reset_generation_cancel=cancelled.clear, generation_cancelled=cancelled.is_set, cancel_generation=cancelled.set)
    driver = FixturePreparedDriver(runtime, model_digest=MODEL, expected_tier="fixture",
        instructions=instructions,
        is_residency_current=lambda: current[0])
    return driver, llama, current
