import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from oscar_agent.web_engines import (
    FIRST_WAVE,
    REST_BASE_SECONDS,
    EngineRouter,
    NoResults,
    TEXT_ENGINES_CYRILLIC,
    TEXT_ENGINES_LATIN,
    fuse,
)


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def rows(*urls):
    return [{"href": url, "title": url, "body": "b"} for url in urls]


def make(behaviour):
    calls = []

    def runner(category, engine, query, region, timelimit, max_results):
        calls.append(engine)
        outcome = behaviour.get(engine, NoResults())
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    clock = Clock()
    return EngineRouter(timeout=1.0, runner=runner, clock=clock), calls, clock


def test_a_refusing_engine_rests_and_working_ones_answer():
    blocked = {engine: NoResults() for engine in TEXT_ENGINES_LATIN}
    blocked["yahoo"] = rows("https://a.example/1", "https://a.example/2", "https://a.example/3")
    router, calls, clock = make(blocked)
    assert len(router.search("text", "python asyncio timeout")) == 3
    # duckduckgo and google answered "nothing" while yahoo answered: they rest.
    assert set(calls) == set(TEXT_ENGINES_LATIN[:FIRST_WAVE])
    calls.clear()
    router.search("text", "another query")
    assert "duckduckgo" not in calls and "google" not in calls
    clock.now += REST_BASE_SECONDS + 1
    calls.clear()
    router.search("text", "third query")
    assert "duckduckgo" in calls


def test_an_empty_query_does_not_punish_engines():
    router, calls, _clock = make({})
    assert router.search("text", "zzqx nothing anywhere") == []
    assert all(health.failures == 0 for health in router.health.values())


def test_errors_and_timeouts_rest_with_a_growing_pause():
    router, _calls, clock = make({"duckduckgo": RuntimeError("blocked"), "google": rows("https://g.example")})
    router.search("text", "one")
    first = router.health["duckduckgo"].resting_until - clock.now
    clock.now += first + 1
    router.search("text", "two")
    second = router.health["duckduckgo"].resting_until - clock.now
    assert second > first


def test_second_wave_when_the_first_finds_too_little():
    behaviour = {engine: NoResults() for engine in TEXT_ENGINES_CYRILLIC}
    behaviour["brave"] = rows("https://b.example/1", "https://b.example/2", "https://b.example/3")
    router, calls, _clock = make(behaviour)
    results = router.search("text", "погода Варна")
    assert len(results) == 3
    assert set(calls[:FIRST_WAVE]) == set(TEXT_ENGINES_CYRILLIC[:FIRST_WAVE])
    assert "brave" in calls


def test_answers_are_cached_briefly():
    router, calls, clock = make({"yandex": rows("https://y.example/1", "https://y.example/2", "https://y.example/3")})
    router.search("text", "курс евро")
    count = len(calls)
    router.search("text", "Курс евро")
    assert len(calls) == count
    clock.now += 301
    router.search("text", "курс евро")
    assert len(calls) > count


def test_every_engine_resting_still_asks_one():
    router, calls, clock = make({})
    for engine in TEXT_ENGINES_LATIN:
        router._failed(engine, "test")
    router.search("text", "query")
    assert len(calls) == 1


def test_fusion_ranks_agreement_first():
    fused = fuse([rows("https://x.example/a", "https://x.example/b"), rows("https://x.example/b", "https://x.example/c")])
    assert fused[0]["href"] == "https://x.example/b"
    assert len(fused) == 3
