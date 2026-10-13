# Astra

The isolated Astra V3 Computer effect work adapter is
`src/agent-v3/computer-action-work-adapter.ts`. This legacy module does not
register it; product/default/shadow startup remains unchanged.

Astra is the local skill layer inside Monarch for Oscar-facing capability discovery and explicit Agent Skill activation.

Naming boundary: the target next-generation Agent Runtime is called **Astra V3** and belongs to the Monarch `0.3.0` architecture plan. This existing `astra` module remains **Astra Skills 0.1.0**. It is a bounded discovery/context component, not the Astra V3 runtime, and the naming decision grants it no execution, policy, evidence, or completion authority.

It does not execute other modules directly. It creates compact agent cards and slot previews so Oscar can understand what Monarch can do while the kernel keeps routing, permissions, execution, events, and audit.

## Capabilities

- `astra.skills.index` - list Oscar-facing cards for active Monarch capabilities.
- `astra.skill.explain` - return one card for a selected capability.
- `astra.slot.preview` - build a read-only preview of the slot Oscar would receive.
- `astra.oscar.bridge.describe` - describe the local Oscar integration contract.
- `astra.agent.skills.list` - discover compatible local Agent Skills with source, trust and resource metadata.
- `astra.agent.skill.activate` - explicitly activate one unchanged skill and return its bounded instructions.

## Local Agent Skills

Astra borrows the useful filesystem contract from Gemini CLI without adding Gemini API or another cloud dependency:

- progressive disclosure: discovery loads only name, description and metadata; full `SKILL.md` is read on activation;
- compatible roots: `.agents/skills`, `.monarch/skills`, `.gemini/skills`, `.claude/skills` and `.codex/skills`;
- deterministic precedence: workspace overrides user, and `.agents` is the highest compatible workspace tier;
- trust evidence: every skill exposes its source tier, link status, resource count and content fingerprint;
- tamper resistance: activation rehashes `SKILL.md` and rejects content changed since discovery;
- local-only execution: skill text is context, never an authority bypass. All actions still pass through routing, permissions, Agent Guard and audit.

Workspace-owned Monarch skills live under `.monarch/skills/`. A skill should keep `SKILL.md` concise and move detailed material into `references/`, scripts or assets so Oscar loads only what the current task needs.

## Boundary

Astra can discover and activate instructions but does not execute skill resources directly. Real actions go through the target module capability and `MonarchExecutionEngine`.
