from __future__ import annotations

import math
import threading
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(slots=True)
class SemanticRerankResult:
    scores: list[float] | None
    engine: str
    timed_out: bool = False


@dataclass(slots=True)
class QueryEmbedding:
    vector: Any | None  # normalised float32 numpy row, or None
    engine: str
    timed_out: bool = False


ENGINE = "multilingual-e5-small-int8-cpu"


class SemanticMemoryReranker:
    """Single CPU worker for bounded multilingual E5 inference.

    Imports and weights are lazy. The request thread waits only for its strict
    deadline; a timed-out warmup continues on the worker and callers fall back
    to deterministic FTS immediately.
    """

    def __init__(self, model_dir: Path, deadline_ms: int = 120):
        self.model_dir = Path(model_dir)
        self.deadline_ms = max(20, min(int(deadline_ms), 1000))
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="monarch-memory-e5")
        self._session: Any | None = None
        self._sentencepiece: Any | None = None
        self._load_error = ""
        self._lock = threading.Lock()
        self._warmup: Future[Any] | None = None
        self._admission_lock = threading.Lock()
        self._active: Future[Any] | None = None
        self._closed = False

    @property
    def files_present(self) -> bool:
        return self._model_path().is_file() and self._tokenizer_path().is_file()

    @property
    def diagnostic(self) -> str:
        if self._load_error:
            return f"unavailable:{self._load_error}"
        if self._session is not None:
            return "ready:" + ENGINE
        return "warming" if self._warmup else "not-loaded"

    def warmup(self) -> None:
        with self._admission_lock:
            if self._closed or not self.files_present or self._warmup is not None or self._session is not None:
                return
            if self._active is not None and not self._active.done():
                return
            self._warmup = self._active = self._executor.submit(self._load)

    @property
    def model_id(self) -> str:
        """Identity of the weights; stored vectors from other weights are stale."""
        try:
            return f"e5-small-int8:{self._model_path().stat().st_size}"
        except OSError:
            return ""

    def embed_query(self, query: str) -> QueryEmbedding:
        """One query vector within the request deadline, or a lexical fallback.

        Same admission rule as rerank: one task, no queue, overload falls back."""
        if not self.files_present:
            return QueryEmbedding(None, "fts:model-files-missing")
        with self._admission_lock:
            if self._closed:
                return QueryEmbedding(None, "fts:semantic-closed")
            if self._active is not None and not self._active.done():
                return QueryEmbedding(None, "fts:semantic-busy")
            future = self._active = self._executor.submit(self._embed, [f"query: {query}"])
        try:
            return QueryEmbedding(future.result(timeout=self.deadline_ms / 1000.0)[0], ENGINE)
        except TimeoutError:
            future.cancel()
            return QueryEmbedding(None, "fts:semantic-deadline", timed_out=True)
        except Exception as exc:
            self._load_error = type(exc).__name__
            return QueryEmbedding(None, f"fts:semantic-{type(exc).__name__}")

    def embed_passages(self, passages: list[str]) -> Any:
        """Vectors for stored records, computed on the caller's (background)
        thread. ONNX Runtime sessions accept concurrent runs, so this never
        takes the request slot that embed_query and rerank share."""
        if self._closed:
            raise RuntimeError("semantic-closed")
        return self._embed([f"passage: {passage}" for passage in passages])

    def rerank(self, query: str, passages: list[str]) -> SemanticRerankResult:
        if not passages:
            return SemanticRerankResult([], "semantic-empty")
        if not self.files_present:
            return SemanticRerankResult(None, "fts:model-files-missing")
        # A deadline bounds latency, not CPU work: a running ONNX invocation
        # cannot be cancelled. Admit only one task, with no pending queue.
        # Overload immediately uses lexical retrieval and retains no passages.
        with self._admission_lock:
            if self._closed:
                return SemanticRerankResult(None, "fts:semantic-closed")
            if self._active is not None and not self._active.done():
                return SemanticRerankResult(None, "fts:semantic-busy")
            future = self._active = self._executor.submit(self._score, query, passages)
        try:
            scores = future.result(timeout=self.deadline_ms / 1000.0)
            return SemanticRerankResult(scores, ENGINE)
        except TimeoutError:
            future.cancel()
            return SemanticRerankResult(None, "fts:semantic-deadline", timed_out=True)
        except Exception as exc:
            self._load_error = type(exc).__name__
            return SemanticRerankResult(None, f"fts:semantic-{type(exc).__name__}")

    def close(self) -> None:
        with self._admission_lock:
            self._closed = True
            self._executor.shutdown(wait=False, cancel_futures=True)

    def _load(self) -> None:
        if self._session is not None:
            return
        with self._lock:
            if self._session is not None:
                return
            import onnxruntime as ort
            import sentencepiece as spm

            options = ort.SessionOptions()
            options.intra_op_num_threads = 1
            options.inter_op_num_threads = 1
            options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            session = ort.InferenceSession(
                str(self._model_path()),
                sess_options=options,
                providers=["CPUExecutionProvider"],
            )
            processor = spm.SentencePieceProcessor()
            if not processor.load(str(self._tokenizer_path())):
                raise RuntimeError("SentencePiece model could not be loaded")
            # Publish only a complete pair; a tokenizer failure must not leave
            # a half-initialized model which every later request tries to use.
            self._sentencepiece = processor
            self._session = session
            self._load_error = ""

    def _score(self, query: str, passages: list[str]) -> list[float]:
        pooled = self._embed([f"query: {query}", *[f"passage: {passage}" for passage in passages]])
        query_embedding = pooled[0]
        return [float(max(-1.0, min(1.0, score))) for score in pooled[1:] @ query_embedding]

    def _embed(self, texts: list[str]) -> Any:
        self._load()
        import numpy as np

        encoded = [self._encode(text, 256) for text in texts]
        width = max(len(row) for row in encoded)
        input_ids = np.full((len(encoded), width), 1, dtype=np.int64)
        attention = np.zeros((len(encoded), width), dtype=np.int64)
        for index, row in enumerate(encoded):
            input_ids[index, :len(row)] = row
            attention[index, :len(row)] = 1
        session_inputs = {entry.name for entry in self._session.get_inputs()}
        feed: dict[str, Any] = {}
        if "input_ids" in session_inputs:
            feed["input_ids"] = input_ids
        if "attention_mask" in session_inputs:
            feed["attention_mask"] = attention
        if "token_type_ids" in session_inputs:
            feed["token_type_ids"] = np.zeros_like(input_ids)
        hidden = self._session.run(None, feed)[0]
        mask = attention[..., None].astype(hidden.dtype)
        pooled = (hidden * mask).sum(axis=1) / np.clip(mask.sum(axis=1), 1e-9, None)
        norms = np.linalg.norm(pooled, axis=1, keepdims=True)
        return (pooled / np.clip(norms, 1e-9, None)).astype(np.float32)

    def _encode(self, text: str, maximum: int) -> list[int]:
        # XLM-R keeps its fairseq special ids in front of SentencePiece:
        # <s>=0, <pad>=1, </s>=2, <unk>=3 and regular pieces use spm_id + 1.
        # Feeding raw SentencePiece ids shifts every token and produces almost
        # uniform cosine scores, so preserve the published tokenizer mapping.
        pieces = list(self._sentencepiece.encode(text, out_type=int))[:maximum - 2]
        mapped = [3 if piece == 0 else piece + 1 for piece in pieces]
        return [0, *mapped, 2]

    def _model_path(self) -> Path:
        return self.model_dir / "onnx" / "model_quantized.onnx"

    def _tokenizer_path(self) -> Path:
        return self.model_dir / "sentencepiece.bpe.model"


def cosine_to_unit(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return max(0.0, min((value + 1.0) / 2.0, 1.0))
