"""How long a loaded local model stays resident between generations.

Releasing a local model means exiting this process. An in-process unload does
not give device memory back on the measured hardware, so process exit is the
only reliable release and the backend recycles itself instead of unloading.

That release mechanism is sound. The policy built on top of it was not: the
recycle was scheduled five seconds after *every* generation, and no human types
the next message within five seconds. Interactive chat therefore paid a full
cold load on every single turn — around 5.6 s before the first token of a reply
to "привет", against 3.8 s of actual generation. The agent lane had already run
into this and bought itself a private 45 s delay, which is the same observation
made once, locally, for one caller.

Residency is a policy question, so it lives in one place and answers it once:

* Hold time is sized by what the resident model costs to keep. The fast tier is
  small and is the tier a conversation lives on, so it is held the longest. The
  large tiers are held for a fraction of that, because a held tier is memory the
  rest of the machine cannot use.
* Host memory pressure overrides the window. A machine that is short on RAM gets
  the memory back promptly, which is the behaviour the old fixed delay had by
  accident for every case.
* A lane that is known to continue — an agent session mid-task — never drops
  below the delay that lane already relied on.

Nothing here decides *whether* a model may load, which tier serves a request, or
whether a tier swap is allowed; those remain with the runtime and its admission
checks. This module only answers how long an already-finished generation leaves
its model in place.
"""

from __future__ import annotations

from dataclasses import dataclass

# The floor is the old fixed delay. It exists so a terminal SSE event can flush
# before Windows tears down llama.cpp/CUDA: closing a large model in-process can
# kill the native runtime before the final bytes reach the client.
MIN_RESIDENT_SECONDS = 5.0
# A window longer than an hour is indistinguishable from never recycling, and
# this backend still relies on process exit to reclaim native allocations.
MAX_RESIDENT_SECONDS = 3600.0
# An agent session is mid-task by construction: the next request is already
# owed. This is the delay that lane used before residency was a policy.
AGENT_SESSION_MIN_RESIDENT_SECONDS = 45.0

# What fraction of the configured window each tier earns. A tier that occupies
# most of the machine is held for a fraction of the time a small one is.
TIER_RESIDENT_SHARE: dict[str, float] = {
    "gemma4-fast": 1.0,
    "gemma4-balanced": 0.5,
    "deepseek-coder-v2-lite-instruct": 0.5,
    "qwen3-coder-30b-a3b-instruct": 0.25,
    "qwen3.8-27b-pro": 0.25,
}
DEFAULT_TIER_RESIDENT_SHARE = 0.25


@dataclass(frozen=True)
class ResidencyDecision:
    """How long to keep the model, and why — the reason is reported, not logged."""

    delay_seconds: float
    reason: str
    tier: str | None = None
    available_ram_gb: float | None = None

    def as_diagnostic(self) -> dict[str, object]:
        return {
            "delay_seconds": round(self.delay_seconds, 2),
            "reason": self.reason,
            "tier": self.tier,
            "available_ram_gb": self.available_ram_gb,
        }


def tier_resident_share(tier: str | None) -> float:
    if not tier:
        return DEFAULT_TIER_RESIDENT_SHARE
    return TIER_RESIDENT_SHARE.get(str(tier).strip().lower(), DEFAULT_TIER_RESIDENT_SHARE)


def plan_residency(
    *,
    configured_idle_seconds: float,
    min_free_ram_gb: float,
    tier: str | None = None,
    available_ram_gb: float | None = None,
    agent_session: bool = False,
) -> ResidencyDecision:
    """Decide how long a just-finished generation leaves its model resident.

    `available_ram_gb` of None means the host could not be measured. That is not
    evidence of pressure, so it does not shorten the window; a machine whose
    memory cannot be read is not thereby assumed to be full.
    """
    floor = AGENT_SESSION_MIN_RESIDENT_SECONDS if agent_session else MIN_RESIDENT_SECONDS

    try:
        configured = float(configured_idle_seconds)
    except (TypeError, ValueError):
        configured = 0.0
    if not configured > 0:
        return ResidencyDecision(floor, "residency-disabled", tier, available_ram_gb)

    if (
        isinstance(available_ram_gb, (int, float))
        and not isinstance(available_ram_gb, bool)
        and available_ram_gb < float(min_free_ram_gb)
    ):
        # Give the memory back now. Holding a model on a machine that is already
        # short of RAM trades a visible saving for an invisible cost elsewhere.
        return ResidencyDecision(floor, "host-ram-low", tier, available_ram_gb)

    window = configured * tier_resident_share(tier)
    delay = max(floor, min(window, MAX_RESIDENT_SECONDS))
    return ResidencyDecision(delay, "resident-idle-window", tier, available_ram_gb)
