"""Small real-model diagnostic, NO application, paths, writes or tool execution.

Compares prose ability with JSON composition using the same already admitted
pinned CPU resident. Expected output is used ONLY after generation. This is not
an end-to-end Astra success claim and cannot produce an execution certificate.
"""
from __future__ import annotations

import json
import threading
import time

from oscar_agent.astra_prepared_driver import AstraPreparedLlamaTextDriver


def run_owned_quality_probe(runtime, resident, model_digest):
    instruction = 'Using ONLY the selected materials, write exactly three lines: Project: <project>, Runtime: <runtime>, Release: <release>. Keep the periods and a final newline.'
    material = 'Project: Monarch.\nRuntime: Astra V3.\nRelease: 0.3.0.\n'
    other = 'Owner color: orange.\nStorage: local-first.\n'
    prompt = instruction + '\n\nSelected material 1:\n' + material + '\nSelected material 2:\n' + other
    expected = material
    cases = [
        ('plain-prose', 'You are a careful assistant. Follow the requested output format. Return only the requested text.', None),
        ('content-only-json', 'You draft file content. Return one JSON object with the requested text in the content string. Do not execute anything.',
         {'type': 'object', 'properties': {'content': {'type': 'string', 'minLength': 0, 'maxLength': 4096}},
          'required': ['content'], 'additionalProperties': False}),
        ('closed-draft-json', 'You draft file content. Return one JSON object with kind=create and the requested text in content. Copy requirementId=draft_file, capabilityHandle=create_file, targetHandle=selected_file. Do not execute anything.',
         {'type': 'object', 'properties': {'kind': {'const': 'create'}, 'requirementId': {'const': 'draft_file'},
             'capabilityHandle': {'const': 'create_file'}, 'targetHandle': {'const': 'selected_file'},
             'content': {'type': 'string', 'minLength': 0, 'maxLength': 4096}},
          'required': ['kind', 'requirementId', 'capabilityHandle', 'targetHandle', 'content'], 'additionalProperties': False}),
    ]
    results = []
    for name, instructions, schema in cases:
        driver = AstraPreparedLlamaTextDriver(runtime, model_digest=model_digest, expected_tier=runtime.active_tier,
            instructions=instructions, is_residency_current=lambda: runtime._llama_model is resident)
        started = time.perf_counter()
        if schema is None:
            framed = driver.formatter(messages=[{'role': 'system', 'content': instructions}, {'role': 'user', 'content': prompt}], enable_thinking=False)
            tokens = resident.tokenize(framed.prompt.encode('utf-8'), add_bos=not framed.added_special, special=True)
            assert len(tokens) + 256 + 96 <= resident.n_ctx()
            output = resident.create_completion(prompt=tokens, max_tokens=256, temperature=0.0, top_p=1.0,
                repeat_penalty=runtime.settings.repetition_penalty, stream=False,
                stop=[framed.stop] if isinstance(framed.stop, str) else list(framed.stop or []),
                stopping_criteria=framed.stopping_criteria)
            text = output['choices'][0]['text']; finish = output['choices'][0]['finish_reason']; content = text
        else:
            prepared = driver.prepare(prompt, schema, 256, threading.Event())
            assert prepared.fits
            output = driver.generate(prepared, threading.Event()); tokens = prepared.tokens
            text = output['text']; finish = output['finishReason']
            try:
                value = json.loads(text); content = value.get('content') if isinstance(value, dict) else None
            except ValueError:
                content = None
        results.append({'case': name, 'tokens': len(tokens), 'durationMs': round((time.perf_counter() - started) * 1000, 2),
            'finishReason': finish, 'output': text, 'exactPassed': content == expected,
            'factsAndLinesPassed': isinstance(content, str) and content.strip().splitlines() == expected.strip().splitlines()})
    return {'scope': 'synthetic-pinned-model-diagnostic-no-Astra-execution', 'modelDigest': model_digest,
            'sameMaterials': True, 'expectedNotInSystemOrSchema': True, 'results': results}
