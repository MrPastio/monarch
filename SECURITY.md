# Monarch security and authority model

## Scope

This document covers the supported Monarch Desktop runtime, local HTTP boundary, typed capabilities, Policy Kernel, Agent Runtime approvals, and the Public/Owner authority tiers. Monarch Safe is a separate protected data domain: product tests and release checks must use synthetic fixtures and must not inspect or reuse Production Safe data.

## Authority tiers

Monarch ships as one build. `MonarchAuthorityContext` is immutable for a runtime session.

- **Public** is the default. It retains the normal confirmation and denial behavior intended for public installations.
- **Owner** is available only to a local Desktop or Coder session after a vendor-signed, device-bound entitlement and a short-lived proof of possession are verified.
- Voice may initiate an action-card but cannot approve it. Telegram and external API sessions always evaluate as Public.

Owner cannot be enabled by a renderer switch, request body, ordinary environment flag, permission-profile update, or model text. `GET /api/permissions` exposes only a safe authority summary. `POST /api/permissions` cannot mutate authority.

The device private key is created under `%APPDATA%\Monarch\authority`, encrypted with Electron `safeStorage`, and kept separate from Monarch Safe. The repository contains only the vendor public verification key. Vendor signing material stays outside the repository in its dedicated release-key directory.

## Single policy verdict

Security components collect typed facts. They do not independently grant execution authority. One `PolicyKernel` combines the permission profile, source, risk vector, authority tier, proposal hash, and Security facts into the final verdict:

- `hard-deny` — cannot be overridden;
- `owner-confirmable` — may become one exact Owner action-card for a local Desktop/Coder session;
- `informational` — evidence only.

Security facts must not be hidden or broadly suppressed to make Owner actions pass. Owner removes unexplained blanket refusals; it does not disable Security review.

## Hard invariants

Neither Public nor Owner may use a confirmation to bypass:

- destruction of a drive root, workspace root, or broad filesystem scope;
- mutation of protected Windows system areas;
- access outside an approved path through traversal, symlink, junction, mount, or reparse-point escape;
- mutation or disclosure of Monarch Safe data;
- mutation or disclosure of protected credential, token, secret, or signing-key zones;
- external transmission of secret-like data through a general agent capability;
- arbitrary code that disables or controls Monarch or operating-system security boundaries;
- a changed proposal, policy verdict, Security evidence, source, or authority tier.

## Durable Owner confirmation

An Owner override is always a one-time durable approval bound to the exact capability and canonical proposal hash. Its persisted binding includes `purpose`, `policyDecisionHash`, and `authorityTierAtRequest`. The Desktop surface must arm sensitive cards before approval.

`securityOverrideConfirmed` is internal execution state derived only from a verified durable approval. It is never accepted from model text or an HTTP request body. Task leases are not issued for Owner overrides. A policy/evidence change, expired entitlement, lost Owner tier, or a new hard-deny requires a new verdict and card.

## Failure behavior

Invalid signatures, another device key, expired entitlement/proof, corrupted or partial device keys, unavailable protected storage, and ACL failures all fail to Public with a safe diagnostic. Corrupted or partial device keys are not regenerated automatically.

## Reporting

When reporting a security issue, include the affected Monarch version, authority tier, request source, capability ID, safe error code, and a minimal synthetic reproduction. Do not attach real credentials, signing keys, Production Safe data, or unrelated personal files.

## Development subordinate-agent boundary

External coding agents that operate on the Monarch checkout are untrusted execution clients, not extensions of the product `PolicyKernel`. The repository policy and controller in `config/subordinate-agents.policy.json` and `scripts/subordinate-agent-control.mjs` govern their admission and acceptance.

- Codex is the current controller and integrator. Grok is admitted as a worker. Antigravity and unknown agents are denied by default.
- The owner may explicitly grant a named agent `admitted`, `controller`, or `integrator`. The grant must name the agent and role; controller/integrator grants are task-scoped unless the owner explicitly says durable/global. A controller records the grant before it becomes effective. No grant is retroactive.
- The owner may explicitly grant an exception to any repository-level restriction. The authorization must identify the agent, restricted action or data, concrete target and purpose. A vague approval is invalid. Sensitive exceptions remain broker- or controller-mediated when a broad tool permission cannot technically represent the narrow target.
- Grok subagents are derivatively admitted only under a valid parent permit. They inherit the intersection of the parent restrictions, cannot expand scope/network/lifetime, cannot gain controller/integrator authority by inheritance, and cannot delegate further.
- A controlled task binds agent identity, policy digest, Git HEAD, dirty-worktree baseline, objective, allowed paths, expiry, task role grants and owner exceptions. A policy or HEAD change invalidates launch. Completion is only a candidate for the currently authorized integrator; it is never automatic acceptance. Codex is the current integrator unless the owner explicitly records another integrator for that task or durably/globally.
- Allowed paths are Windows-canonical and case-insensitive; traversal, NTFS alternate streams, ambiguous trailing components, symlink-backed scopes and task records outside the controller root fail closed. Acceptance also requires the live worktree to match the candidate-close snapshot, so stale evidence cannot authorize later changes.
- Direct or expired sessions are non-authoritative. Their output may be inspected as untrusted evidence, but changes require a fresh full authorized-integrator review before integration.
- Safe, credentials, release keys, destructive operations, publication and policy mutation are denied by default. An exact owner exception authorizes the narrowly described outcome, not broad removal of the surrounding guard.

Reportable failures include fail-open admission, an unrecorded role grant, a subordinate expanding or delegating scope, bypass of a protected-path/tool deny, acceptance without baseline/diff evidence, or an exception that grants materially broader access than the owner named.

## Limitations

Owner authority is a product trust boundary, not DRM against a computer owner who patches and rebuilds the executable. Release acceptance therefore validates both the signed runtime path and the public-export boundary; it does not claim resistance to a locally modified binary.

The development controller is defense in depth for cooperative tools, mistakes and prompt injection. Grok Build on Windows currently has no separate kernel sandbox, and all local agents run under the same Windows account. The policy therefore does not claim containment of a malicious same-account process. Protected CLI rules, isolated task records, baseline comparison and mandatory authorized-integrator acceptance are compensating controls; stronger hostile-process isolation would require a separate OS identity, VM or broker.
