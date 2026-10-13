"""Bounded, explicit JSON-schema subset for Astra's internal decision profile.

llama-cpp-python 0.3.30 expands bounded strings into N nested optional groups.
At maxLength=4096 the Windows native grammar parser overflows its stack before
inference starts. Large native {min,max} repeats are also rejected by this build.
Quotient/remainder blocks denote the same range with every repeat <=64 and no
deep parser nesting. Do not remove the bound, increase the
thread stack, monkey-patch the shared converter or fall back to generic JSON.

The upstream converter does not implement all of JSON Schema. Reject unsupported
keywords here instead of accidentally promising constraints it would ignore.
This is not a general JSON Schema compiler or the native Astra decision ABI.
"""
from __future__ import annotations

import json
import re

ASTRA_DECISION_GRAMMAR_PROFILE = "monarch.astra-bounded-decision-grammar.v1"


def bounded_character_repetition(low: int, high: int, char: str, block: str) -> str:
    """Exactly low..high character units, with disjoint remainder ranges.

    For N=64*q+r, [0,N] = [0,q-1]*64 + [0,63] OR q*64 + [0,r].
    This avoids both linear parse recursion and thousands of ambiguous x?'s.
    Bounds are validated by the schema admission before calling this helper.
    """
    def exact(count):
        quotient, remainder = divmod(count, 64)
        return " ".join(part for part in (f"{block}{{{quotient}}}" if quotient else "",
                                          f"{char}{{{remainder}}}" if remainder else "") if part)

    quotient, remainder = divmod(high - low, 64)
    prefix = exact(low)
    if not quotient:
        suffix = f"{char}{{0,{remainder}}}" if remainder else ""
    else:
        below = " ".join(part for part in (f"{block}{{0,{quotient - 1}}}" if quotient > 1 else "",
                                           f"{char}{{0,63}}") if part)
        last = " ".join(part for part in (f"{block}{{{quotient}}}",
                                          f"{char}{{0,{remainder}}}" if remainder else "") if part)
        suffix = f"({below} | {last})"
    return " ".join(part for part in (prefix, suffix) if part) or '""'


def compile_astra_decision_grammar(schema_json: str):
    from llama_cpp import LlamaGrammar
    from llama_cpp.llama_grammar import RESERVED_NAMES, SchemaConverter

    schema = json.loads(schema_json)
    nodes = 0

    def validate(item, depth=0):
        nonlocal nodes
        nodes += 1
        if nodes > 128 or depth > 12 or not isinstance(item, dict):
            raise ValueError("decision-schema-complexity")
        keys = set(item)
        if keys == {"const"}:
            if not isinstance(item["const"], str) or not 1 <= len(item["const"]) <= 96:
                raise ValueError("decision-schema-constant")
        elif keys == {"enum"}:
            values = item["enum"]
            if (not isinstance(values, list) or not 1 <= len(values) <= 32
                    or not all(isinstance(value, str) and 1 <= len(value) <= 96 for value in values)
                    or len(set(values)) != len(values)):
                raise ValueError("decision-schema-enum")
        elif keys == {"type", "minLength", "maxLength"} and item["type"] == "string":
            low, high = item["minLength"], item["maxLength"]
            if type(low) is not int or type(high) is not int or not 0 <= low <= high <= 4096:
                raise ValueError("decision-schema-string-bounds")
        elif keys == {"type", "properties", "required", "additionalProperties"} and item["type"] == "object":
            properties, required = item["properties"], item["required"]
            if (item["additionalProperties"] is not False or not isinstance(properties, dict)
                    # A decision branch must contain its discriminator. A nested
                    # schema-bound args object may legitimately be exactly {}.
                    or not (0 if depth > 0 else 1) <= len(properties) <= 16 or not isinstance(required, list)
                    or not all(isinstance(key, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", key) for key in required)
                    or len(required) != len(properties) or set(required) != set(properties)):
                raise ValueError("decision-schema-closed-object")
            for value in properties.values():
                validate(value, depth + 1)
        elif keys == {"type", "items", "minItems", "maxItems", "uniqueItems"} and item["type"] == "array":
            low, high = item["minItems"], item["maxItems"]
            if (type(low) is not int or type(high) is not int or not 1 <= low <= high <= 32
                    or item["uniqueItems"] is not True):
                raise ValueError("decision-schema-array-bounds")
            # The native converter bounds the array. Gateway validation remains
            # authoritative for uniqueness and receipt-group membership.
            validate(item["items"], depth + 1)
        elif keys == {"oneOf"}:
            branches = item["oneOf"]
            if not isinstance(branches, list) or not 2 <= len(branches) <= 8:
                raise ValueError("decision-schema-union")
            kinds = set()
            for branch in branches:
                validate(branch, depth + 1)
                # The converter implements alternation, not arbitrary oneOf
                # exclusion. Unique required discriminators make it exact.
                kind = branch.get("properties", {}).get("kind", {})
                if (branch.get("type") != "object" or set(kind) != {"const"}
                        or kind["const"] in kinds or "kind" not in branch["required"]):
                    raise ValueError("decision-schema-discriminator")
                kinds.add(kind["const"])
        else:
            raise ValueError("unsupported-decision-schema")

    validate(schema)

    class CompactStringConverter(SchemaConverter):
        def visit(self, item, name):
            if item.get("type") == "string":
                rule_name = name + "-" if name in RESERVED_NAMES else name or "root"
                # JSON forbids literal control characters. Keep escape sequences
                # atomic for length counting, matching the bounded schema units.
                char_rule = self._add_rule("astra-char", r'[^"\\\x00-\x1f] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F]{4})')
                block_rule = self._add_rule("astra-char-block", f"{char_rule}{{64}}")
                low, high = item["minLength"], item["maxLength"]
                repetition = bounded_character_repetition(low, high, char_rule, block_rule)
                return self._add_rule(rule_name, r'"\"" ' + repetition + r' "\"" space')
            return super().visit(item, name)

    # Canonical JSON hashing sorts property keys. Generation must still choose
    # the discriminator first; otherwise a branch with capabilityHandle sorts
    # ahead of kind and the first key choice accidentally preselects the action.
    converter = CompactStringConverter(prop_order={"kind": 0}, allow_fetch=False, dotall=False, raw_pattern=False)
    converter.visit(schema, "")
    grammar = converter.format_grammar()
    if len(grammar.encode("utf-8")) > 65536:
        raise ValueError("decision-grammar-size")
    return LlamaGrammar.from_string(grammar, verbose=False)
