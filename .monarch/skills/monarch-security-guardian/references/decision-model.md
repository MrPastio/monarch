# Agent Guard decision model

- `allowed`: deterministic checks found no violated boundary; read-only actions may continue.
- `approval_required`: the action changes state, has weak intent alignment, touches protected data, changes security posture, or comes from a remote source. Only an exact one-time Monarch Access confirmation can satisfy it.
- `blocked`: a hard invariant failed, such as workspace escape, deletion unrelated to user intent, catastrophic disk/system commands, invalid controller output, or a permanent local block.

Every decision should carry module, capability, risk, source, evidence codes, and a canonical input hash. Raw action input is not audit material.

If the Python protector is unavailable, local Agent Guard remains active. Report the degraded host-sensor state separately and fail closed for hard boundary failures.
