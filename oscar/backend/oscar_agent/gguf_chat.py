"""Bounded GGUF directory inspection before passing owner files to native code.

Reads metadata and tensor names, never weights. MTP-only heads are not chat
models; a full model may legitimately contain MTP tensors too.
"""
from __future__ import annotations

import re
import struct
from functools import lru_cache
from pathlib import Path

LIMIT = 64 * 1024 * 1024
CHUNK = 1024 * 1024
_U64 = struct.Struct("<Q")
WIDTHS = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}


class GgufChatError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def inspect_chat_gguf(path: Path) -> dict:
    with path.open("rb") as stream:
        size = path.stat().st_size
        bound = min(size, LIMIT)
        # The header is read forward in 1 MiB chunks and parsed from memory.
        # A tell/seek/read round per field made a tokenizer vocabulary of
        # ~500k strings cost ~5 s per model, and model status waited for it
        # on every Monarch start.
        buffer = bytearray()
        position = 0

        def ensure(n):
            if n < 0 or position + n > bound:
                raise GgufChatError("custom-model-format")
            end = position + n
            while len(buffer) < end:
                chunk = stream.read(min(CHUNK, bound - len(buffer)))
                if not chunk:
                    raise GgufChatError("custom-model-format")
                buffer.extend(chunk)
            return end

        def skip(n):
            nonlocal position
            position = ensure(n)

        def read(n):
            nonlocal position
            end = ensure(n)
            value = bytes(buffer[position:end])
            position = end
            return value

        def skip_strings(count):
            nonlocal position
            for _ in range(count):
                end = ensure(8)
                length = _U64.unpack_from(buffer, position)[0]
                position = end
                position = ensure(length)

        def uint(n):
            return int.from_bytes(read(n), "little")

        def string(keep=False):
            n = uint(8)
            if keep:
                if n > 65536:
                    raise GgufChatError("custom-model-format")
                try:
                    return read(n).decode("utf-8", errors="strict")
                except UnicodeDecodeError as exc:
                    raise GgufChatError("custom-model-format") from exc
            skip(n)
            return None

        def value(kind, keep=False):
            if kind == 8:
                return string(keep)
            if kind == 9:
                element, count = uint(4), uint(8)
                if count > 2_000_000:
                    raise GgufChatError("custom-model-format")
                if element == 8:
                    skip_strings(count)
                elif element in WIDTHS:
                    skip(count * WIDTHS[element])
                else:
                    raise GgufChatError("custom-model-format")
                return None
            if kind not in WIDTHS:
                raise GgufChatError("custom-model-format")
            raw = read(WIDTHS[kind])
            if not keep:
                return None
            return struct.unpack({0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f", 7: "<?", 10: "<Q", 11: "<q", 12: "<d"}[kind], raw)[0]

        if read(4) != b"GGUF" or uint(4) not in (2, 3):
            raise GgufChatError("custom-model-format")
        tensors, fields = uint(8), uint(8)
        if not 0 < tensors <= 200_000 or not 0 < fields <= 100_000:
            raise GgufChatError("custom-model-format")
        metadata = {}
        keys = set()
        for _ in range(fields):
            key = string(True)
            if key in keys:
                raise GgufChatError("custom-model-format")
            keys.add(key)
            keep = key in ("general.architecture", "general.type", "split.count") or key.endswith((".block_count", ".nextn_predict_layers"))
            result = value(uint(4), keep)
            if keep:
                metadata[key] = result
        architecture = metadata.get("general.architecture")
        if not isinstance(architecture, str) or not architecture:
            raise GgufChatError("custom-model-format")
        blocks = set()
        tensor_names = []
        for _ in range(tensors):
            name = string(True)
            if len(tensor_names) < 20:
                tensor_names.append(name)
            match = re.match(r"^blk\.(\d+)\.", name)
            if match:
                blocks.add(int(match[1]))
            dimensions = uint(4)
            if not 1 <= dimensions <= 4:
                raise GgufChatError("custom-model-format")
            skip(8 * dimensions + 4 + 8)
        return {"metadata": metadata, "blocks": sorted(blocks), "tensor_count": tensors, "tensor_names": tensor_names}


def assert_chat_gguf(path: Path) -> None:
    info = inspect_chat_gguf(path)
    metadata = info["metadata"]
    arch = metadata["general.architecture"]
    if arch == "clip" or metadata.get("general.type", "model") != "model":
        raise GgufChatError("custom-model-auxiliary")
    if metadata.get("split.count", 1) != 1:
        raise GgufChatError("custom-model-split")
    layers = metadata.get(f"{arch}.block_count")
    nextn = metadata.get(f"{arch}.nextn_predict_layers", 0)
    if layers is not None:
        if type(layers) is not int or not 1 <= layers <= 200_000 or type(nextn) is not int or not 0 <= nextn <= layers:
            raise GgufChatError("custom-model-format")
        base_layers = layers - nextn
        if nextn > 0 and (base_layers <= 0 or not any(block < base_layers for block in info["blocks"])):
            raise GgufChatError("custom-model-draft-only")
        if not set(range(base_layers)).issubset(info["blocks"]):
            raise GgufChatError("custom-model-format")


def chat_gguf_available(path: Path) -> bool:
    """Cheap status inspection; actual admission always rechecks the file."""
    try:
        stat = path.stat()
        return _cached_available(str(path), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    except (OSError, ValueError):
        return False


@lru_cache(maxsize=24)
def _cached_available(path: str, size: int, mtime: int, ctime: int) -> bool:
    try:
        assert_chat_gguf(Path(path))
        return True
    except (OSError, ValueError, OverflowError):
        return False
