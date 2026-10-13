"""Opt-in native vocabulary/grammar tests, no generation and no file access."""
from __future__ import annotations

import ctypes
import json
import math

from oscar_agent.astra_decision_grammar import compile_astra_decision_grammar


def run_native_grammar_conformance(resident):
    from llama_cpp import llama_cpp as native

    def accepts(grammar, encoded):
        sampler = native.llama_sampler_init_grammar(resident._model.vocab, grammar._grammar.encode(), b"root")
        if not sampler:
            raise RuntimeError("native-grammar-admission-rejected")
        try:
            tokens = resident.tokenize(encoded, add_bos=False, special=False) + [resident.token_eos()]
            for token in tokens:
                data = (native.llama_token_data * 1)(native.llama_token_data(token, 0.0, 0.0))
                candidates = native.llama_token_data_array(data, 1, -1, False)
                native.llama_sampler_apply(sampler, ctypes.byref(candidates))
                if not math.isfinite(candidates.data[0].logit):
                    return False
                native.llama_sampler_accept(sampler, token)
            return True
        finally:
            native.llama_sampler_free(sampler)

    cases = []
    for low, high in [(0, 0), (1, 1), (0, 63), (1, 64), (31, 95), (64, 128), (1, 4096)]:
        grammar = compile_astra_decision_grammar(json.dumps({"type": "string", "minLength": low, "maxLength": high}))
        for count in sorted({0, max(0, low - 1), low, high, high + 1, 63, 64, 65}):
            expected = low <= count <= high
            actual = accepts(grammar, json.dumps("a" * count).encode())
            cases.append({"min": low, "max": high, "length": count, "expected": expected, "accepted": actual})
            if actual != expected:
                raise RuntimeError("native-grammar-bound-mismatch:" + json.dumps(cases[-1]))
    grammar = compile_astra_decision_grammar(json.dumps({"type": "string", "minLength": 1, "maxLength": 2}))
    for encoded, expected in [(b'"\\n"', True), (b'"\n"', False), ('"🟠"'.encode(), True), (b'"abc"', False)]:
        actual = accepts(grammar, encoded)
        cases.append({"jsonHex": encoded.hex(), "expected": expected, "accepted": actual})
        if actual != expected:
            raise RuntimeError("native-grammar-encoding-mismatch:" + json.dumps(cases[-1]))
    return {"tests": len(cases), "passed": len(cases), "actualNativeSampler": True,
            "actualModelGeneration": False, "maxStringCharactersTested": 4097}
