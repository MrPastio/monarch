"""Memory 4.1 phase 6: does a tiny CPU generative model beat the extractive memory?

Run from the repo root with the Oscar venv, one method per process so memory
numbers are per model:

    oscar/.venv/Scripts/python.exe docs/plans/memory-llm-bench/bench.py --method extractive --out <dir>
    oscar/.venv/Scripts/python.exe docs/plans/memory-llm-bench/bench.py --method llm --model <gguf> --out <dir>

The data is synthetic Russian (facts_ru.json, capsule_topics_ru.json).
Grading is rule based: value prefixes for facts, topic keywords for capsules,
and a grounding check (every content word of the output must come from the
input) for both. Nothing here touches Monarch state.
"""
from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "oscar" / "backend"))

from oscar_agent import memory_facts  # noqa: E402
from oscar_agent.memory_text import STOPWORDS, fold, stem, words  # noqa: E402

CAPSULE_BATCHES = 30
FACTS_FILE = "facts_ru.json"
CAPSULE_PROMPT_CEILING = 600  # memory_v4 caps one recalled item at 600 chars
GROUPS = ["name", "address", "address_form", "home_city", "hometown", "occupation", "languages", "pet",
          "language_pref", "answer_length", "preference", "rule"]
# Words a first-person paraphrase may add without inventing content.
FRAME_WORDS = {"я", "меня", "мне", "мой", "моя", "мое", "мои", "пользователь", "пользователя", "зовут", "живу",
               "работаю", "люблю", "предпочитаю", "говорю", "есть", "отвечай", "пиши", "обращайся", "называй",
               "запросы", "запрос", "темы", "тема", "вопросы", "вопрос", "спрашивал", "спрашивает", "интересовался",
               "интересуется", "про", "также", "о", "об", "как", "что", "и", "в", "на", "по", "с"}


def group_of(subject: str | None, category: str) -> str | None:
    if subject in {"work", "profession"}:
        return "occupation"
    if subject and subject.startswith("pref:"):
        return "preference"
    if subject:
        return subject
    return "rule" if category == "rule" else None


def has_terms(text: str, terms: list[str]) -> bool:
    parts = [piece for word in words(text) for piece in [word, *word.split("-")]]
    return all(any(part.startswith(fold(term)) for part in parts) for term in terms)


def content_words(text: str) -> list[str]:
    return [w for w in words(text) if len(w) >= 3 and w not in STOPWORDS and w not in FRAME_WORDS]


def grounding(output: str, source: str) -> tuple[int, int, list[str]]:
    source_stems = {stem(piece) for w in words(source) for piece in [w, *w.split("-")]}
    source_words = set(words(source))
    out = content_words(output)
    bad = [w for w in out if stem(w) not in source_stems and w not in source_words
           and not any(stem(p) in source_stems for p in w.split("-"))]
    return len(out), len(bad), bad


# ---------------------------------------------------------------- facts

def grade_facts(cases: list[dict], predictions: dict[str, list[dict]]) -> dict:
    tp = fp = fn = neg_fp = 0
    per_kind: dict[str, dict[str, int]] = {}
    ungrounded = total_words = 0
    errors = []
    for case in cases:
        preds = list(predictions.get(case["id"], []))
        used = set()
        hit = 0
        for group, terms in case["gold"]:
            match = next((i for i, p in enumerate(preds) if i not in used and p["group"] == group
                          and has_terms(p["text"], terms)), None)
            if match is None:
                fn += 1
                errors.append({"id": case["id"], "miss": [group, terms], "got": preds})
            else:
                used.add(match)
                hit += 1
        extra = [p for i, p in enumerate(preds) if i not in used]
        tp += hit
        fp += len(extra)
        if not case["gold"]:
            neg_fp += bool(extra)
        if extra:
            errors.append({"id": case["id"], "extra": extra})
        for p in preds:
            n, bad, _ = grounding(p["text"], case["text"])
            total_words += n
            ungrounded += bad
        k = per_kind.setdefault(case["kind"], {"gold": 0, "tp": 0, "fp": 0})
        k["gold"] += len(case["gold"])
        k["tp"] += hit
        k["fp"] += len(extra)
    precision = tp / (tp + fp) if tp + fp else 1.0
    recall = tp / (tp + fn) if tp + fn else 1.0
    return {
        "tp": tp, "fp": fp, "fn": fn, "precision": round(precision, 3), "recall": round(recall, 3),
        "f1": round(2 * precision * recall / (precision + recall), 3) if precision + recall else 0.0,
        "negativesWithFalseLearning": neg_fp,
        "negatives": sum(1 for c in cases if not c["gold"]),
        "perKind": per_kind,
        "ungroundedWordShare": round(ungrounded / total_words, 3) if total_words else 0.0,
        "errors": errors,
    }


def regex_facts(text: str) -> list[dict]:
    return [{"group": group_of(f.subject_key, f.category), "text": f.text}
            for f in memory_facts.extract_learnable(text) if group_of(f.subject_key, f.category)]


FACT_SYSTEM = (
    "Ты извлекаешь из сообщения человека устойчивые факты о нём самом для долгой памяти ассистента. "
    "Бери только то, что человек прямо утверждает о себе сейчас: имя, как к нему обращаться, город, где живёт, "
    "откуда родом, работа или профессия, языки, питомцы, на каком языке и какой длины отвечать, "
    "что он любит или не любит, постоянные правила для ассистента. "
    "Не бери: вопросы, фантазии и «если бы», чужие факты (друзья, родные, персонажи), просьбы перевести или "
    "написать текст, временное состояние (устал, в отпуске), здоровье, пароли и другие секреты. "
    "text — короткое утверждение от первого лица словами человека. Если фактов нет — пустой список."
)
FACT_SCHEMA = {
    "type": "object",
    "properties": {"facts": {"type": "array", "maxItems": 3, "items": {
        "type": "object",
        "properties": {"subject": {"type": "string", "enum": GROUPS}, "text": {"type": "string"}},
        "required": ["subject", "text"]}}},
    "required": ["facts"],
}
FACT_SHOTS = [
    ("Я живу в Варне, какая там погода завтра?",
     {"facts": [{"subject": "home_city", "text": "Я живу в Варне"}]}),
    ("Моя подруга работает юристом.", {"facts": []}),
]


def llm_facts(llm, text: str) -> tuple[list[dict], float, int]:
    messages = [{"role": "system", "content": FACT_SYSTEM}]
    for user, answer in FACT_SHOTS:
        messages += [{"role": "user", "content": user},
                     {"role": "assistant", "content": json.dumps(answer, ensure_ascii=False)}]
    messages.append({"role": "user", "content": text})
    started = time.perf_counter()
    out = llm.create_chat_completion(messages=messages, temperature=0.0, max_tokens=200,
                                     response_format={"type": "json_object", "schema": FACT_SCHEMA})
    elapsed = time.perf_counter() - started
    raw = out["choices"][0]["message"]["content"] or ""
    try:
        facts = json.loads(raw).get("facts") or []
    except (ValueError, AttributeError):
        facts = []
    result = [{"group": f.get("subject"), "text": str(f.get("text") or "")} for f in facts
              if isinstance(f, dict) and f.get("subject") in GROUPS and f.get("text")]
    return result, elapsed, int(out["usage"]["prompt_tokens"])


def guarded(text: str, preds: list[dict]) -> list[dict]:
    """The same hard guards the extractive path has, applied to model output."""
    if len(text) > 1200 or memory_facts.is_sensitive(text) or memory_facts._NOT_A_STATEMENT.search(text.replace("?", "")):
        return []
    return [p for p in preds if grounding(p["text"], text)[1] == 0]


NORMALIZE_SYSTEM = (
    "Перепиши факт о человеке коротко и аккуратно, от первого лица, на русском. "
    "Сохрани все имена, города и значения как есть, ничего не добавляй. Ответь только самим фактом."
)


def llm_normalize(llm, fact_text: str) -> tuple[str, float]:
    started = time.perf_counter()
    out = llm.create_chat_completion(messages=[{"role": "system", "content": NORMALIZE_SYSTEM},
                                               {"role": "user", "content": fact_text}],
                                     temperature=0.0, max_tokens=60)
    return (out["choices"][0]["message"]["content"] or "").strip(), time.perf_counter() - started


# ---------------------------------------------------------------- capsules

def capsule_batches() -> list[dict]:
    data = json.loads((HERE / "capsule_topics_ru.json").read_text(encoding="utf-8"))
    rng = random.Random(20261017)
    topics = data["topics"]
    batches = []
    for index in range(CAPSULE_BATCHES):
        chosen = rng.sample(topics, rng.choice([1, 2, 2, 3, 3]))
        size = rng.randint(15, 40)
        queries = []
        while len(queries) < size - 2:
            topic = rng.choice(chosen)
            queries.append(rng.choice(topic["queries"]))
        queries += rng.sample(data["noise"], 2)
        rng.shuffle(queries)
        batches.append({"id": f"c{index:02d}", "topics": chosen, "queries": queries})
    return batches


def current_summary(queries: list[str]) -> str:
    from oscar_agent.memory_v4 import compact_text
    return "\n".join(f"- {compact_text(q, 160)}" for q in queries)[:5000]


def diverse_summary(queries: list[str], limit: int = CAPSULE_PROMPT_CEILING) -> str:
    """Extractive alternative: greedily take the request that adds the most new stems."""
    pool = list(dict.fromkeys(queries))
    covered: set[str] = set()
    lines: list[str] = []
    while pool:
        gains = [(len({stem(w) for w in content_words(q)} - covered), -i, q) for i, q in enumerate(pool)]
        gain, _, best = max(gains)
        if gain == 0:
            break
        line = f"- {best}"
        if len("\n".join([*lines, line])) > limit:
            pool.remove(best)
            continue
        lines.append(line)
        covered |= {stem(w) for w in content_words(best)}
        pool.remove(best)
    return "\n".join(lines)


CAPSULE_SYSTEM = (
    "Ниже — запросы человека из старых чатов. Кратко перескажи по-русски, о чём они: назови все темы и "
    "главное по каждой, одним абзацем до 400 символов. Не добавляй ничего, чего нет в запросах."
)


def llm_capsule(llm, queries: list[str]) -> tuple[str, float, int]:
    text = "\n".join(f"- {q}" for q in queries)
    started = time.perf_counter()
    out = llm.create_chat_completion(messages=[{"role": "system", "content": CAPSULE_SYSTEM},
                                               {"role": "user", "content": text}],
                                     temperature=0.0, max_tokens=220)
    return (out["choices"][0]["message"]["content"] or "").strip(), time.perf_counter() - started, \
        int(out["usage"]["prompt_tokens"])


def grade_capsule(batch: dict, summary: str) -> dict:
    head = summary[:CAPSULE_PROMPT_CEILING]
    covered = [t["id"] for t in batch["topics"] if any(has_terms(summary, [k]) for k in t["keywords"])]
    covered_head = [t["id"] for t in batch["topics"] if any(has_terms(head, [k]) for k in t["keywords"])]
    probe_hits = [t["id"] for t in batch["topics"]
                  if {stem(w) for w in content_words(t["probe"])} & {stem(w) for w in words(summary)}]
    n, bad, bad_words = grounding(summary, "\n".join(batch["queries"]))
    return {"topics": len(batch["topics"]), "covered": len(covered), "coveredIn600": len(covered_head),
            "probeHits": len(probe_hits), "chars": len(summary), "contentWords": n, "ungrounded": bad,
            "ungroundedWords": bad_words[:12]}


def summarize_capsules(rows: list[dict]) -> dict:
    topics = sum(r["topics"] for r in rows)
    words_total = sum(r["contentWords"] for r in rows)
    return {
        "batches": len(rows),
        "topicCoverage": round(sum(r["covered"] for r in rows) / topics, 3),
        "topicCoverageIn600": round(sum(r["coveredIn600"] for r in rows) / topics, 3),
        "probeRecall": round(sum(r["probeHits"] for r in rows) / topics, 3),
        "meanChars": round(sum(r["chars"] for r in rows) / len(rows)),
        "ungroundedWordShare": round(sum(r["ungrounded"] for r in rows) / words_total, 3) if words_total else 0.0,
        "batchesWithInventedWords": sum(1 for r in rows if r["ungrounded"]),
    }


# ---------------------------------------------------------------- runs

def rss_mb() -> float:
    import psutil
    return round(psutil.Process().memory_info().rss / 2**20, 1)


def peak_mb() -> float:
    import psutil
    info = psutil.Process().memory_info()
    return round(getattr(info, "peak_wset", info.rss) / 2**20, 1)


def run_extractive(out: Path) -> None:
    cases = json.loads((HERE / FACTS_FILE).read_text(encoding="utf-8"))["cases"]
    started = time.perf_counter()
    preds = {c["id"]: regex_facts(c["text"]) for c in cases}
    fact_ms = (time.perf_counter() - started) * 1000 / len(cases)
    batches = capsule_batches()
    current, diverse = [], []
    started = time.perf_counter()
    samples = {}
    for b in batches:
        s = current_summary(b["queries"])
        current.append(grade_capsule(b, s))
    cur_ms = (time.perf_counter() - started) * 1000 / len(batches)
    started = time.perf_counter()
    for b in batches:
        s = diverse_summary(b["queries"])
        diverse.append(grade_capsule(b, s))
        samples[b["id"]] = s
    div_ms = (time.perf_counter() - started) * 1000 / len(batches)
    result = {
        "method": "extractive",
        "facts": {"msPerMessage": round(fact_ms, 3), **grade_facts(cases, preds), "predictions": preds},
        "capsulesCurrent": {"msPerCapsule": round(cur_ms, 3), **summarize_capsules(current), "rows": current},
        "capsulesDiverse": {"msPerCapsule": round(div_ms, 3), **summarize_capsules(diverse), "rows": diverse,
                            "samples": samples},
        "rssMb": rss_mb(),
    }
    (out / "extractive.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")


def run_llm(out: Path, model: Path, threads: int) -> None:
    from oscar_agent.model_runtime import configure_nvidia_dll_directories
    configure_nvidia_dll_directories()
    from llama_cpp import Llama
    base = rss_mb()
    started = time.perf_counter()
    llm = Llama(model_path=str(model), n_ctx=4096, n_threads=threads, n_threads_batch=threads,
                n_gpu_layers=0, verbose=False, seed=7)
    load_s = time.perf_counter() - started
    loaded = rss_mb()

    cases = json.loads((HERE / FACTS_FILE).read_text(encoding="utf-8"))["cases"]
    raw, safe, times, prompt_tokens = {}, {}, [], []
    for c in cases:
        preds, elapsed, ptoks = llm_facts(llm, c["text"])
        raw[c["id"]] = preds
        safe[c["id"]] = guarded(c["text"], preds)
        times.append(elapsed)
        prompt_tokens.append(ptoks)

    normalized, norm_times = [], []
    for c in cases:
        for fact in regex_facts(c["text"]):
            text, elapsed = llm_normalize(llm, fact["text"])
            norm_times.append(elapsed)
            gold_terms = next((terms for group, terms in c["gold"] if group == fact["group"]), None)
            normalized.append({"id": c["id"], "before": fact["text"], "after": text,
                               "valueKeptBefore": bool(gold_terms and has_terms(fact["text"], gold_terms)),
                               "valueKeptAfter": bool(gold_terms and has_terms(text, gold_terms)),
                               "inventedWords": grounding(text, c["text"])[2]})

    rows, cap_times, cap_tokens, samples = [], [], [], {}
    for b in capsule_batches():
        summary, elapsed, ptoks = llm_capsule(llm, b["queries"])
        rows.append(grade_capsule(b, summary))
        cap_times.append(elapsed)
        cap_tokens.append(ptoks)
        samples[b["id"]] = summary

    def stats(values: list[float]) -> dict:
        ordered = sorted(values)
        return {"meanS": round(sum(values) / len(values), 3), "p50S": round(ordered[len(values) // 2], 3),
                "maxS": round(ordered[-1], 3)}

    result = {
        "method": "llm", "model": model.name, "modelBytes": model.stat().st_size, "threads": threads,
        "loadS": round(load_s, 2), "rssBeforeMb": base, "rssLoadedMb": loaded, "rssEndMb": rss_mb(),
        "peakMb": peak_mb(),
        "facts": {"time": stats(times), "meanPromptTokens": round(sum(prompt_tokens) / len(prompt_tokens)),
                  "raw": {**grade_facts(cases, raw), "predictions": raw},
                  "guarded": {**grade_facts(cases, safe), "predictions": safe}},
        "normalize": {"time": stats(norm_times) if norm_times else None, "count": len(normalized),
                      "valueKeptBefore": sum(n["valueKeptBefore"] for n in normalized),
                      "valueKeptAfter": sum(n["valueKeptAfter"] for n in normalized),
                      "withInventedWords": sum(1 for n in normalized if n["inventedWords"]),
                      "rows": normalized},
        "capsules": {"time": stats(cap_times), "meanPromptTokens": round(sum(cap_tokens) / len(cap_tokens)),
                     **summarize_capsules(rows), "rows": rows, "samples": samples},
    }
    (out / f"llm-{model.stem}-t{threads}.json").write_text(json.dumps(result, ensure_ascii=False, indent=1),
                                                          encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--method", choices=["extractive", "llm"])
    parser.add_argument("--model", type=Path)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--facts", default=FACTS_FILE, help="facts set in this folder, e.g. facts_ru_holdout.json")
    args = parser.parse_args()
    globals()["FACTS_FILE"] = args.facts
    args.out.mkdir(parents=True, exist_ok=True)
    if args.method == "extractive":
        run_extractive(args.out)
    else:
        run_llm(args.out, args.model, args.threads)


if __name__ == "__main__":
    main()
