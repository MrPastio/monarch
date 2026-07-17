# Local Agent Skill compatibility

Discovery precedence from lowest to highest:

1. Bundled system skills.
2. Local extension skills.
3. User skills.
4. Workspace skills.

Within the same user or workspace tier, the portable `.agents/skills` alias wins over provider-specific copies with the same name.

Supported workspace roots are `.gemini/skills`, `.claude/skills`, `.monarch/skills`, and `.agents/skills`. Metadata is discovered first; the body and resource list are loaded only on activation.

Required SKILL.md frontmatter fields are `name` and `description`. Provider-specific fields may refine manual invocation, implicit activation, platforms, arguments, and advisory tool lists. Monarch's permission gate remains authoritative.

Do not activate an externally linked skill implicitly. Recalculate the SKILL.md fingerprint at activation and reject a changed file until discovery is refreshed.
