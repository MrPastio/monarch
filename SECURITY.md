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

## Limitations

Owner authority is a product trust boundary, not DRM against a computer owner who patches and rebuilds the executable. Release acceptance therefore validates both the signed runtime path and the public-export boundary; it does not claim resistance to a locally modified binary.
