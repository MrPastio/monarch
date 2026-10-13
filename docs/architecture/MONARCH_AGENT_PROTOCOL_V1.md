# Monarch Astra V3 — Agent Protocol V1

Статус: **CONVERGENCE DRAFT — `agent-core-read.v1` SCHEMA LAB ONLY; NOT READY FOR GENERAL IMPLEMENTATION PLANNING**, companion specification к `MONARCH_AGENT_RUNTIME_V3.md`.  
**Scope update 2026-08-30:** owner разрешил исходную реализацию Astra V3. Новые компоненты
`src/agent-v3/` пока используют явно internal DTO и НЕ заявляют native protocol conformance;
см. `MONARCH_ASTRA_V3_IMPLEMENTATION_STATUS.md`. Старый implementation-only запрет
не останавливает эту работу; native admission/authority/Certifier gates не закрыты
самим фактом наличия нового кода.
Исходный draft: 2026-08-24. Последняя архитектурная ревизия: 2026-08-26.  
Цель: закрыть минимальную runtime-neutral read foundation до выбора product store/backend. Structural V1 package уже достиг `66/66`, но его legacy Manifest не способен выразить полный executable authority; поэтому следующий допустимый artifact — versioned 66-row authority-root replacement, затем retained manifest/ref closure и isolated durability/latency spike. Shadow/product state/effects пока не разрешены.

Последний, третий frozen-source prose PASS 3 завершился `FAIL (P0=0, P1=5, P2=1)`. Все шесть findings исправлены в текущем source после freeze, но эти author edits не считаются independently closed; их следующий и единственный closure gate — concrete generated schemas/profile instances/ID map/fixtures и независимый artifact review, не четвёртый prose pass.

---

## 0. Authority этого документа

До materialization этот файл — human-readable normative design owner, но **не machine-codegen input**. Runtime document владеет invariants/ownership, Migration — rollout, review logs — только evidence. Единственный допустимый machine-source и bootstrap boundary определены в §0.2. Ручные TypeScript fragments во всех architecture documents являются non-ABI review snapshots и MUST быть удалены либо заменены generated includes до closure. До любого shadow RFC MUST появиться digest-pinned package `monarch-agent-protocol` с JSON Schema 2020-12 + generated TypeScript, compiled rule tables и fixtures. Package proposal может закрыть поле только через отдельный reviewed schema decision, синхронно обновляющий machine definition и этот Protocol; он не может молча выдумать обязательное поле/transition. До artifact review любое расхождение оставляет feature unavailable. После ratification generated artifacts получают authority только как outputs exact retained machine definition; ни prose, ни TypeScript, ни generated schema не могут быть альтернативным codegen-source.

Нормативные слова **MUST/обязан**, **MUST NOT/запрещено**, **SHOULD/следует**, **MAY/может** используются в RFC 2119-смысле.

### 0.1. Closure profiles и запрет scope expansion

Единственный текущий closure profile — `agent-core-read.v1`. Он допускает deterministic local read на synthetic/disposable storage fixture и включает только:

- canonical parser/hash/ref/ID/clock/limit profiles;
- accepted command + persisted admission;
- deterministic minimum + one read GoalContract;
- one statically pinned interval-only `workspace.storage.audit.v2` contract, with no Catalog/Activation/Engine dependency;
- read Invocation + admitted Kernel read receipt;
- Evidence projection + pure completion assessment;
- deterministic structured result; legacy comparison remains a non-authority lab report outside the core manifest.

Он **не включает** V4 product journal/cutover, Approval/Arm, write/device/process, provider/cloud, Incognito operational read, encrypted lane, plugins as claim authority, children, jobs or compaction. Эти sections ниже — extension design notes. Их names/events/types не входят в base manifest и не являются protocol-ready.

First closure manifest is an exact allowlist of schema IDs; wildcard/range/prose inclusion is forbidden:

```text
monarch.accepted-command-context.v1
monarch.agent-capability-contract.v1
monarch.agent-client-command.v1
monarch.agent-command-receipt.v1
monarch.agent-command.v1
monarch.agent-event.v1
monarch.agent-protocol-error.v1
monarch.authority-scope.v1
monarch.canonical-windows-identity-body.v1
monarch.canonical-windows-path.v1
monarch.canonicalization-profile.v1
monarch.certification-key-body.v1
monarch.claim-template.v1
monarch.clock-attestation.v1
monarch.command-dedupe-record.v1
monarch.command-dedupe-scope-body.v1
monarch.command-fingerprint-body.v1
monarch.commit-event-digest-body.v1
monarch.commit-group-digest-body.v1
monarch.completion-assessment-body.v1
monarch.completion-assessment-input.v1
monarch.completion-certificate.v1
monarch.completion-certifier-contract.v1
monarch.completion-commit-assessment.v1
monarch.completion-denial.v1
monarch.completion-request.v1
monarch.completion-terminal-policy.v1
monarch.deterministic-goal-minimum.v1
monarch.evidence-admission-key-body.v1
monarch.evidence-graph-snapshot.v1
monarch.evidence-node.v1
monarch.evidence-view.v1
monarch.follow-up-admission-decision.v1
monarch.goal-admission-binding.v1
monarch.goal-contract.v1
monarch.goal-matcher-descriptor.v1
monarch.goal-matcher-result.v1
monarch.goal-semantic-body.v1
monarch.immutable-content-ref.v1
monarch.interaction-follow-up-payload.v1
monarch.interaction-intent-admission.v1
monarch.interaction-submit-payload.v1
monarch.invocation-dispatch-key-body.v1
monarch.invocation-transition.v1
monarch.invocation.v1
monarch.kernel-receipt-ref.v1
monarch.opaque-id-profile.v1
monarch.presentation-contract.v1
monarch.protocol-feature-schema-manifest.v1
monarch.requirement-attempt-selection.v1
monarch.runtime-feature-set.v1
monarch.selector-descriptor.v1
monarch.storage-exclusion-policy.v2
monarch.storage-exclusion-summary.v2
monarch.storage-inclusion-policy.v2
monarch.storage-temporal-proof.v2
monarch.storage-traversal-accounting-proof.v2
monarch.storage-traversal-budget-profile.v2
monarch.structured-result.v1
monarch.transport-limit-profile.v1
monarch.typed-value-literal.v1
monarch.typed-value.v1
monarch.verification-recipe.v1
monarch.volume-identity-digest-body.v1
monarch.workspace-storage-audit-input.v2
monarch.workspace-storage-audit-output.v2
```

Если хотя бы один listed body/schema/fixture отсутствует или любой unlisted authority schema нужен для trace, manifest compilation fails. Extension manifest version не может добавить variant/field в core authority object без payload/schema version bump.

Этот список теперь является frozen **legacy V1 structural closure**, а не promotion target. Проверяемый authority-root alignment заменяет в том же 66-row closure только `monarch.opaque-id-profile.v1 → monarch.protocol-authority-profile.v1`, `monarch.protocol-feature-schema-manifest.v1 → monarch.protocol-feature-schema-manifest.v2` и `monarch.runtime-feature-set.v1 → monarch.runtime-feature-set.v2`; остальные 63 schema ID сохраняются. До materialization и независимой проверки этих трёх документов V1 остаётся единственной фактически сгенерированной структурной формой, но sealing/activation V1 запрещены.

### 0.2. Единственный machine-authoritative codegen source

Первый artifact создаётся не из prose и не из TypeScript. Build-time file `protocol-definition.agent-core-read.v1.json` в canonical UTF-8 JSON является единственным input для protocol compiler. Он валидируется малым pinned bootstrap schema `monarch.protocol-definition.bootstrap.v1`, который не описывает и не генерирует сам себя. Bootstrap schema, compiler binary, strict parser and their finite pre-profile ceilings form an explicitly hand-reviewed trust root; expected hashes come from the repository/release trust-root record outside the candidate generated package. Product import additionally requires vendor-signed package admission. A candidate package cannot supply the expected hash that authorizes itself.

`ProtocolDefinitionV1` is build-time provenance, not an additional runtime authority schema. It contains only a closed data AST:

- the exact §0.1 schema/object/field/union AST and every `additionalProperties` decision;
- exact schema/variant/path ID rules, digest domains, omissions and bindings;
- closed primitive assertion programs for ref resolution, byte/set equality, cardinality, subset, integer arithmetic/comparison, state CAS and commit adjacency;
- the complete event/state/commit tables, transport/profile-derived constraints and canonical fixture manifest;
- one explicit enforcement owner per rule: `strict-token-prevalidator | json-schema-validator | identity-binding-evaluator | state-commit-reducer | capability-verifier | temporal-comparator`.

Named compound relations such as `goal-admission-authority-equal` are review labels only. The compiler MUST expand each label to a finite ordered primitive assertion program with exact endpoints; no label survives as a runtime callback or prose-only paragraph. The runtime manifest retains the compiled rows. `ProtocolBindingRuleV1.relation`/`ProtocolGuardRelationV1` fragments below are explanatory mnemonics until generated includes replace them; they are never sufficient codegen input by themselves.

The current partial Phase 0A definition materializes the first closed subset of that algebra as `BindingProgramV1`: sorted unique `binding-program.*.v1` IDs, `1..64` ordered instructions per program and no unknown keys/operations. Its six admitted operations are `assert-literal(endpoint,value)`, `assert-json-equal(left,right)`, `assert-domain-digest(source,result,domain,canonicalization='jcs-instance',omittedJsonPointers)`, `assert-canonical-set(endpoint,comparison,keyJsonPointers?)`, `assert-ref-schema-digest(endpoint,describedSchemaId)` and `assert-schema-digest(endpoint,describedSchemaId)`. Every endpoint names an exact materialized schema, RFC 6901 pointer and optional full nested `variantId` route; the compiler resolves the route against the closed AST, proves literal membership or exact scalar-domain equality, binds digest omission/domain/result to the retained `schemaClosure` row, and permits canonical-set comparison only on one finite `uniqueItems` array. `assert-ref-schema-digest` may target only a `contentSchemaDigest` occurrence, requires exactly one same-program sibling `contentSchemaId == describedSchemaId` literal, requires that described schema to be materialized, and binds the runtime value to its generated domain-separated schema-body row. `assert-schema-digest` is deliberately disjoint: it accepts only one non-variant top-level pointer matching exact `^/[A-Za-z][A-Za-z0-9]*SchemaDigest$`, explicitly rejects `/contentSchemaDigest`, requires the described schema to be materialized with a generated schema-body row, and needs no synthetic sibling schema-ID field. Both operations share one global duplicate-endpoint fence. Scalar sets use raw UTF-8 byte order; object sets use one ordered typed tuple of exact relative pointers. The independent Python oracle resolves the same instructions against emitted JSON Schema, compares candidate/registry rows back to the retained definition and runs separate sorted/reordered/duplicate scalar/tuple comparator cases.

The compiler now emits `schema-body-digests.candidate.json` and the same rows inside the generated registry for all materialized schema documents. Each row binds exact `schemaId == schemaVersion`, root `$id == urn:monarch:schema:<schemaId>`, generated artifact name, canonical byte length, audit-only raw SHA-256 and the §2.1.1 `schema-body` digest under retained profile `monarch-jcs-utf8-v1`. The raw hash and semantic digest are deliberately distinct. A separate Python stdlib oracle independently canonicalizes every emitted document, reconstructs the length-prefixed preimage and rejects row/registry drift or raw-SHA substitution. These `22/66` rows are a partial schema-document digest substrate, not retained `ProtocolSchemaRefV1` store objects: store generation/object/byte-length refs, bundled meta-schema binding and the exact 66-row manifest remain blockers.

The current retained candidate contains `25` programs / `93` instructions. It retains private instance/schema-ID/purpose/content-digest bindings for AcceptedContext, AuthorityScope, CompletionCertifier, RuntimeFeatureSet and the storage-input policy refs; exact schema-body bindings for the materialized targets; self-digest, canonical-set, TypedValue and canonical-Windows-identity programs. Each TypedValue digest program is bound to one exact source/result `variantId`; cross-variant digest routing is definition-invalid and independently oracle-rejected. The direct schema-digest primitive is compiler/oracle-closed, while CompletionCertifier's input/assessment bindings still wait for their two exact schema documents. Remaining identity/state/commit relations and every Store-issued `ProtocolSchemaRefV1` are blockers. No product evaluator or runtime admission path is enabled by these candidate rows.

Assessment materialization proceeds leaf-first. `StorageExclusionSummaryV2` is one exact four-row tuple, and both `TypedValueLiteralV1` and `TypedValueV1` are closed six-branch unions with exact type/encoding pairs, canonical integer/decimal strings, safe-integer bounds and an object branch restricted to that exclusion summary. The policy, temporal and `WorkspaceStorageAuditInputV2` leaves are retained, and the same pass now materializes the complete closed `AgentCapabilityContractV1` schema. That schema owns the exact capability/requirement IDs, 28 claim-template members, required ordered tuple, matcher, resolver, broker, walker, adapter, execution ceiling and all ref/digest surfaces. Consequently the retained endpoint map is `117/117` and the semantic substrate exercises `2/5` profiles. A separate isolated materializer produces one schema-valid, self-digest-valid `workspace.storage.audit.v2` candidate body, executes 55 semantic checks and rejects 50 mutations. The matcher, target resolver, walker, filesystem broker and adapter implementation identities all use the retained `raw-sha256` implementation-hash domain; a prior `sha256` spelling made byte-equal matcher binding to Admission impossible and is now mutation-tested. The materializer deliberately issues no Store refs and does not claim that output/EvidenceNode schemas, claim bodies, recipe or the capability instance are retained. `CompletionAssessmentInputV1` and `CompletionAssessmentBodyV1` also remain unmaterialized; their finite cross-body owner/projection bindings are still required.

The compiler deterministically emits JSON Schema 2020-12, TypeScript, manifest rule tables, profile instances, fixture metadata and a source/output hash manifest. Generated TypeScript is never read back as input. Generated JSON Schema is never used to reconstruct the definition. A second compiler/oracle independently derives expanded endpoints and semantic assertions from the retained definition, not from the first compiler outputs. Artifact review checks both structural parity and the semantics/counterexamples encoded by the definition; byte parity alone cannot close an incorrect rule.

The retained definition has exactly one union AST form: `variants: [{ variantId, schema }]`. Raw JSON Schema `oneOf`, `anyOf`, `allOf` and `if/then/else` are forbidden in this source AST. Every direct `variantId` is a lowercase ASCII token matching `[a-z0-9][a-z0-9-]*`, entries are strictly sorted and unique, every branch is one fully flattened closed object, and at least one shared `const` property has a distinct value in every branch. The compiler emits only the branch schemas as JSON Schema `oneOf`; it never emits `variants`, never reconstructs a flattened branch with `allOf`, and never relies on annotations to preserve branch identity. The independent endpoint oracle retains branch identity directly from the definition AST. If unions are nested directly or through `$ref`, the concrete endpoint `variantId` is the complete outer-to-inner route joined by `.`, so direct tokens cannot contain `.` and no inner branch can overwrite its parent identity.

To author a large closed union without duplicating one envelope in every branch, the source AST may use only the finite `objectVariantTemplate: { common, variants }` macro. `common` is one direct closed object; every sorted branch contains only `{variantId,required,properties}`, has at least one branch property, and may not overlap a common property. The compiler constructs each flattened branch by the exact sorted required-set union and disjoint property union, then runs the ordinary union/discriminator/reference/ID validation above. The macro is stripped before schema emission and cannot override a common field, inject a callback, choose a runtime branch or survive as an annotation. `ImmutableContentRefV1` is the first production proof: its three emitted branch documents remain byte-identical to the prior explicit form. Node mutations reject overlap, missing/reordered required rows, branch reorder and discriminator collision; the independent Python oracle expands the retained macro separately and rejects coordinated owner-domain widening. This primitive is the required substrate for the 40 exact event branches and their later commit-body parity projection; it does not by itself materialize either schema.

When a field accepts exactly one already-defined branch rather than the complete runtime union, the definition uses only `selectedVariantRef: { canonicalUri, variantId }`. Its target MUST be one materialized schema whose root is a direct `variants` union, and the named direct branch MUST resolve exactly once. The compiler inlines that branch as a closed object; `selectedVariantRef`, `oneOf` and a synthetic `variantId` do not appear in the consumer schema. No property override/refinement bag is allowed, so the selected bytes still have one source. Ordinary `$ref` retains the complete target schema and therefore retains any runtime union. The full materialized `$ref`/selected-variant document graph is resolved before codegen and MUST be a finite DAG; missing targets, selection from a non-union, missing/duplicate branches, cycles or edges above the compiled ceiling fail even when the referenced subtree contains no ID field. The independent oracle performs the same resolution from the retained AST rather than trusting generated inlining.

A fixed ordered array is represented only by source-AST `exactItems: [schema0, ...]`; it cannot also carry homogeneous `items`, cardinality or uniqueness keywords. Codegen lowers it to Draft 2020-12 `prefixItems`, `items:false` and exact equal `minItems/maxItems`, so reorder, duplicate substitution, omission and extension fail structurally. `CompletionTerminalPolicyV1` uses this form for the one partial code, all twelve blocked codes and exact `blocked → partial → verified` precedence. A separate Python oracle exercises all five tuple outcomes without importing compiler code. `exactItems` is source-only and never appears in emitted schemas.

An ID-bearing string whose property name is not exactly `id` and does not end in `Id|Ids` MUST carry source-only `idEndpoint: true` in the definition AST. For one scalar the marker is permitted only as literal `true` on a string node. For a bounded array of IDs it appears on the array node and its direct item schema MUST be one string/const-string/all-string-enum domain; the derived endpoint is the exact `each-array-item` path. The marker participates in independent ID-endpoint enumeration and is stripped before JSON Schema emission. It is not a JSON Schema annotation, runtime input or alternative classification: the same endpoint still requires exactly one `opaqueIdFieldRule`. Adding every `*Ref` by name is forbidden because structural content refs are objects rather than scalar identity tokens. An ID-named/marked array with exact `maxItems=0` has no reachable item endpoint and therefore no field-map row; removing or increasing that bound exposes the endpoint and fails compilation until an exact classification is added.

Bootstrap acceptance is exact: the reachable Monarch `$ref` document closure MUST equal the §0.1 allowlist, while validator-only closure may additionally contain only the pinned Draft 2020-12 root/vocabulary meta-schema set. A missing, extra, network-resolved, cyclic or differently identified document fails before schema compilation. The full definition digest, bootstrap schema digest, compiler hash and emitted-file hashes are published in the package provenance report. Until this object exists and passes independent review, the current source remains a correction candidate and no `P1=0`/schema-lab conformance claim is permitted.

Every allowlisted generated schema document has exactly one canonical URI: `urn:monarch:schema:` followed byte-for-byte by its full §0.1 schema ID; its root `$id` equals that URI. Relative aliases, mnemonic suffixes, redirects and network resolution are forbidden. The definition retains both `schemaId` and `canonicalUri`, and the compiler plus independent oracle reject any mismatch before `$ref` closure is evaluated.

---

## 1. Почему протоколов два

Monarch нужны две независимые versioned границы.

Sections 1.1/1.2 name the eventual protocol families, not the enabled `agent-core-read.v1` surface. For the current schema lab the exact allowlist in §0.1 wins: Client accepts only persisted submit/follow-up forms defined in §7.1/§7.2, and no Engine schema or operation is available. Snapshot/replay/attach, pause/resume/cancel, approval and progress families below remain extension vocabulary until a separate manifest admits their closed schemas.

### 1.1. Agent Client Protocol V1

Связывает Desktop/Voice/Telegram/API/Coder/UI с Agent Application Service. Он описывает:

- persist-first submit;
- snapshot/replay/attach;
- user follow-up и steering intent;
- pause/resume/cancel;
- exact approval response;
- progress и terminal outcomes;
- delivery ordering.

### 1.2. Agent Engine Protocol V1

Связывает Runtime Host с конкретным model/agent engine driver. Он описывает:

- open/submit/steer/cancel/close;
- context/catalog projection;
- normalized text/decision/tool-proposal/usage events;
- safe-boundary и runtime resume features;
- driver generation/failure.

Engine Protocol не доступен UI напрямую. Kernel API, persisted domain journal и Engine Protocol — разные контракты.

---

## 2. Общие правила

### P-01. Command/query separation

Command может изменить authoritative state и требует `commandId` + idempotency. Query ничего не меняет. Повтор command с тем же ID и тем же fingerprint возвращает исходный receipt; тот же ID с другим payload — conflict.

### P-02. Optimistic concurrency

State-changing command несёт `expectedRevision`, если он адресован уже существующему aggregate. Несовпадение не «исправляется» last-write-wins.

### P-03. Per-stream ordering

Events имеют contiguous monotonic `sequence` внутри stream. Timestamp не используется для authoritative ordering.

### P-04. At-least-once transport, idempotent admission

HTTP/SSE/outbox/mailbox transport может повторить доставку. Consumer deduplicates по `eventId`/`commandId`; effect invocation дополнительно использует stable idempotency key.

### P-05. Unknown is not success

Unknown command/event/payload version, missing sequence, stale generation или invalid digest не переводятся в success. Reader переходит в `upgrade-required`, resync или fail-closed state.

### P-06. No hidden authority fields

Никакой `confirmed: true`, prompt text, model role, UI badge или driver feature не авторизует effect. Approval имеет отдельный exact contract.

### P-07. Content digests

Canonical payloads, schemas, GoalContract, catalog snapshots, proposals, receipts, context и certificates имеют stable digest. Digest algorithm/version указывается явно.

### P-08. Bounded payloads and refs

Large attachments, screenshots, artifacts и raw tool output передаются по immutable ref + digest. Inline payload limits определяются transport profile.

### P-09. Privacy binding

Каждая command/event/snapshot несёт или наследует authoritative privacy/surface scope. Переезд persistent ↔ incognito/encrypted через обычную update-команду запрещён.

### P-10. No chain-of-thought

Protocol допускает public rationale/repair code, но запрещает hidden reasoning/system prompt/raw prompt persistence.

### P-11. Wire claims are not accepted authority

Public client input и internal accepted command — разные schemas. Principal, source/surface, effective privacy, owner authority и consent eligibility выводятся server-side из authenticated transport/session и сохраняются как attested context. Client не может объявить себя `desktop`, `system`, Incognito-owner или approver.

### P-12. Lossless typed values

Exact integer/decimal values используют `TypedValueV1` canonical encodings. JSON `number` принимается только при explicit safe-range validation; digest округлённого значения не восстанавливает точность.

---

## 2.1. Canonicalization, schemas and digest profile

До первого shadow RFC это section MUST быть материализовано одним generated package и cross-language fixture corpus. Применяется следующий baseline:

```ts
type JsonPrimitive = null | boolean | string | number;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };
type DigestV1 = string; // exactly `sha256:` + 64 lowercase hex chars
type ImplementationHashV1 = string; // exactly `raw-sha256:` + 64 lowercase hex chars

interface CanonicalizationProfileV1 {
  schemaVersion: 'monarch.canonicalization-profile.v1';
  id: 'monarch-jcs-utf8-v1';
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema';
  jsonSchemaMetaSchemaDigest: DigestV1;
  jsonCanonicalization: 'RFC-8785-JCS';
  textEncoding: 'UTF-8';
  digestAlgorithm: 'SHA-256';
  timestampProfile: 'rfc3339-utc-millisecond-v1';
  integerProfile: 'base10-integer-v1';
  decimalProfile: 'base10-decimal-minimal-v1';
  pathProfile: 'windows-handle-identity-v1';
  strictJsonParserImplementationHash: ImplementationHashV1;
  jcsCanonicalizerImplementationHash: ImplementationHashV1;
  schemaValidatorImplementationHash: ImplementationHashV1;
  digestImplementationHash: ImplementationHashV1;
  protocolIdentityBindingEvaluatorImplementationHash: ImplementationHashV1;
  protocolStateCommitReducerImplementationHash: ImplementationHashV1;
}
```

`ImplementationHashV1` is deliberately not `DigestV1`: it is SHA-256 over the exact loaded implementation artifact bytes, with no JSON/JCS/domain wrapper, and its distinct `raw-sha256:` prefix prevents semantic-content confusion. For parser/canonicalizer/schema-validator/digest/identity-binding/state-commit code, each artifact boundary is the exact generic production engine module plus embedded executable dependencies selected by the package lock; a filename, package version or source-tree hash is insufficient. The strict parser artifact additionally embeds one finite bootstrap ceiling tuple for bytes/depth/keys/arrays/string/refs/schema documents before any external profile is parsed; those exact constants are part of its loaded bytes/hash and cannot be raised by input. The schema-validator artifact additionally includes the exact Draft 2020-12 root/vocabulary meta-schema bytes and the closed URI resolver table it executes. The identity-binding evaluator resolves immutable content and runs only the generated digest/equality/projection programs. The state-commit reducer runs only generated aggregate-CAS, transition and commit-adjacency programs over one candidate commit plus its exact pre-state. Neither module contains a compound business-rule callback, physical store code, clock/network access or an escape to manifest-supplied executable names. Matcher, target resolver, filesystem broker, walker, adapter, projector, temporal comparator, Certifier and renderer hashes likewise cover the exact loaded bundled module plus all executable embedded dependencies selected by the lock; dynamic plugin/network code loading, filename/version-only identity and a dependency omitted from every boundary are invalid. Their declarative contracts/schemas/fixtures remain external content-addressed inputs so none hashes a constant that contains its own hash. Generated Monarch schemas, manifest, fixtures, profile instances and their hash constants remain external inputs and are excluded from the six generic engine artifacts, preventing a self-hashing bundle. Generated schemas/rule tables remain content-addressed by the manifest; the pinned generic engines interpret them. Admission recomputes every pinned first-party implementation hash before the component can act. Cross-language implementations may serve as fixture oracles, but they do not silently replace the one production implementation set pinned by the retained `CanonicalizationProfileV1`. An implementation hash proves byte identity/provenance only; it neither retains executable bytes nor grants trust. Missing/mismatched historical implementation blocks replay/recovery. Every semantic body around that hash still has its own allowlisted ref/domain digest.

Core shared schemas:

```ts
type SafeCounterV1 = number; // integer 0..9_007_199_254_740_991; overflow is never rounded

interface ImmutableContentRefBaseV1 {
  schemaVersion: 'monarch.immutable-content-ref.v1';
  storeGenerationId: string;
  objectId: string;                 // opaque random ID, not a path/bearer token
  contentDigest: DigestV1;
  byteLength: string;               // canonical unsigned base-10 integer
  classification: 'public' | 'private' | 'sensitive';
}

type ImmutableContentRefV1 = ImmutableContentRefBaseV1 & (
  | {
      contentKind: 'instance';
      contentSchemaId: string;
      contentSchemaDigest: DigestV1;
      describedSchemaId?: never;
      purpose: 'protocol-body' | 'raw-result' | 'evidence';
    }
  | {
      contentKind: 'json-schema';
      contentSchemaId: 'https://json-schema.org/draft/2020-12/schema';
      contentSchemaDigest: DigestV1;
      describedSchemaId: string;
      purpose: 'protocol-body';
    }
  | {
      contentKind: 'opaque-bytes';
      contentSchemaId?: never;
      contentSchemaDigest?: never;
      describedSchemaId?: never;
      mediaType: string;
      purpose: 'diagnostic' | 'artifact';
    }
);

interface ClockAttestationV1 {
  schemaVersion: 'monarch.clock-attestation.v1';
  bootId: string;
  monotonicOriginId: string;
  monotonicElapsedMs: SafeCounterV1;
  wallTime: string;
  continuity: 'continuous' | 'rebooted' | 'unknown';
}

interface TransportLimitProfileV1 {
  schemaVersion: 'monarch.transport-limit-profile.v1';
  id: 'agent-core-read-transport-limits.v1';
  maxPayloadBytes: SafeCounterV1;
  maxDepth: SafeCounterV1;
  maxTotalObjectMembers: SafeCounterV1;
  maxTotalArrayItems: SafeCounterV1;
  maxStringUtf8Bytes: SafeCounterV1;
  maxCommitEvents: SafeCounterV1;
  maxRefs: SafeCounterV1;
  maxSchemaDocuments: SafeCounterV1;
  maxResolvedRefDepth: SafeCounterV1;
  maxResolvedObjects: SafeCounterV1;
  maxResolvedEdges: SafeCounterV1;
  maxResolvedBytes: SafeCounterV1;
  bodyDigest: DigestV1;
}

interface ProtocolSchemaRefV1 {
  schemaId: string;
  schemaVersion: string;
  schemaRef: Extract<ImmutableContentRefV1, { contentKind: 'json-schema' }>;
  schemaDigest: DigestV1;
  role: 'command' | 'event' | 'query' | 'snapshot' | 'transition' | 'error' | 'body';
  contentIdentityRuleId: string;
  digestRuleIds: string[];
  bindingRuleIds: string[];
}

interface ProtocolValueEndpointV1 {
  schemaId: string;      // exact full schema ID from §0.1, never a mnemonic suffix
  variantId?: string;    // exact generated oneOf branch ID; absent only for a non-union schema
  jsonPointer: string; // RFC 6901; empty string means the whole instance
}

interface ProtocolContentIdentityRuleV1 {
  ruleId: string;
  sourceSchemaId: string;                 // exact full §0.1 schema ID
  domain: string;                         // exact manifest digest domain
  canonicalization: 'jcs-instance' | 'utf8-bytes';
  omittedJsonPointers: string[];          // exact, unique, sorted; often empty
}

interface ProtocolDigestRuleV1 {
  ruleId: string;
  domain: string;                       // exact member of manifest.digestDomains
  source: ProtocolValueEndpointV1;      // preimage owner; may differ from result owner
  canonicalization: 'jcs-instance' | 'utf8-bytes';
  omittedJsonPointers: string[];        // relative to source; exact, unique, sorted
  results: ProtocolValueEndpointV1[];   // one or more repeated DigestV1 bindings
}

interface ProtocolBindingRuleV1 {
  ruleId: string;
  left: ProtocolValueEndpointV1;
  right: ProtocolValueEndpointV1;
  relation: 'byte-equal' | 'canonical-set-equal' | 'ref-content-digest-equal'
    | 'ref-schema-digest-equal' | 'goal-admission-authority-equal'
    | 'goal-matcher-result-admission-projection' | 'goal-minimum-semantic-equal'
    | 'accepted-command-receipt-projection'
    | 'certificate-view-projection' | 'view-result-projection';
}

interface ProtocolStateTransitionRuleV1 {
  ruleId: string;
  machine: 'interaction-core' | 'execution-core';
  triggerEventType: keyof AgentCoreEventPayloadMapV1;
  triggerVariantId: string;
  from: string[];
  to: string;
  guardId: string;
}

type ProtocolGuardRelationV1 =
  | 'aggregate-create'
  | 'schema-bindings-and-state-cas'
  | 'invocation-transition-and-snapshot-cas'
  | 'single-core-invocation-create'
  | 'assessment-fence-freeze'
  | 'certificate-terminal-suffix'
  | 'typed-terminal-suffix'
  | 'presentation-projection';

interface ProtocolGuardRuleV1 {
  guardId: string;
  relation: ProtocolGuardRelationV1;
  bindingRuleIds: string[];
  commitInvariantRuleIds: string[];
}

interface ProtocolCommitInvariantRuleV1 {
  ruleId: string;
  triggerVariantId: string;
  guardId: string;
  requiredImmediatePrefixVariantIds: string[];
  requiredImmediateSuffixVariantIds: string[];
  bindingRuleIds: string[];
}

interface ProtocolFeatureSchemaManifestV1 {
  schemaVersion: 'monarch.protocol-feature-schema-manifest.v1';
  featureId: 'agent-core-read.v1';
  canonicalizationProfileRef: ImmutableContentRefV1;
  transportLimitProfileRef: ImmutableContentRefV1;
  opaqueIdProfileRef: ImmutableContentRefV1;
  schemas: ProtocolSchemaRefV1[]; // unique, ascending by schemaId; exact §0.1 set
  digestDomains: string[];        // unique ASCII ascending; exact §2.1.1 registry
  contentIdentityRules: ProtocolContentIdentityRuleV1[];
  digestRules: ProtocolDigestRuleV1[];
  bindingRules: ProtocolBindingRuleV1[];
  guardRules: ProtocolGuardRuleV1[];
  stateTransitionRules: ProtocolStateTransitionRuleV1[];
  commitInvariantRules: ProtocolCommitInvariantRuleV1[];
  minimumReaderProtocolVersion: '1';
  minimumWriterProtocolVersion: '1';
  bodyDigest: DigestV1;
}

interface RuntimeFeatureSetV1 {
  schemaVersion: 'monarch.runtime-feature-set.v1';
  generation: SafeCounterV1;
  manifestRef: ImmutableContentRefV1;
  manifestDigest: DigestV1;
  coreCapabilityContractRef: ImmutableContentRefV1;
  coreCapabilityContractDigest: DigestV1;
  completionCertifierContractRef: ImmutableContentRefV1;
  completionCertifierContractDigest: DigestV1;
  enabledFeatures: ['agent-core-read.v1'];
  unavailableFeatures: [
    'agent-catalog.v1', 'agent-children.v1', 'agent-compaction.v1', 'agent-effects.v1',
    'agent-encrypted.v1', 'agent-engine.v1', 'agent-incognito.v1',
    'agent-jobs.v1', 'agent-plugins.v1', 'agent-product-facade.v1',
    'agent-provider.v1'
  ];
  bodyDigest: DigestV1;
}
```

For both `ProtocolContentIdentityRuleV1` and `ProtocolDigestRuleV1`, the digest header's `schemaVersion` argument is exactly the `schemaVersion` of the manifest `ProtocolSchemaRefV1` selected by `sourceSchemaId` or `source.schemaId`; a nested JSON Pointer never substitutes a nested object's own literal or an implementation type name. The `profileId` argument is exactly the resolved `CanonicalizationProfileV1.id`. A missing/mismatched source manifest entry fails compilation. The only non-instance rules are the separately specified `json-schema` bootstrap and non-authority raw opaque-byte identity; neither is inferred from this default.

`ImmutableContentRefV1` is the only content reference allowed in core authority schemas, but its closed discriminator matters. Every ref is store-issued rather than caller-authored: resolver proves exact store generation/object identity, canonical unsigned `byteLength == exact stored byte count`, content identity and a classification no weaker than the stored object's/schema policy before returning bytes. A metadata mismatch is `integrity-failure`; it is never repaired from the enclosing object's expectations. An authority `instance` ref must resolve to a schema in the exact core manifest; transitive unlisted authority refs fail compilation. Every core authority instance ref is exactly `classification='private'`; schema-document refs are exactly `public`. A `json-schema` ref is legal only inside `ProtocolSchemaRefV1`: `describedSchemaId` equals its owner `schemaId`, `contentSchemaDigest` equals the retained canonical profile's pinned meta-schema digest, and `contentDigest/schemaDigest` is the domain-separated `schema-body` hash of the canonical schema document. It is not falsely validated as an instance of the schema it describes. `opaque-bytes` is never authority, carries only a validated bounded media type rather than a fictitious schema digest, and is limited to untrusted artifact/private diagnostic use. Every core `diagnosticRef`, classified-error summary and legacy shadow diagnostic MUST be the `opaque-bytes/purpose='diagnostic'` branch with `classification='private'|'sensitive'`; no unlisted diagnostic instance schema or content-identity rule enters the manifest. Its absence/content cannot change a selector, policy or verdict. Attachment/artifact opaque refs are `private|sensitive`, remain untrusted inputs and cannot enter core selectors until a future capability explicitly admits a content schema. Core refs cannot claim `secret`; encrypted/secret extension data requires a separately versioned protected ref. `ref + digest` never grants read authority; resolver rechecks kind/purpose plus the applicable ownership chain: public schema, installation feature/config, principal+Interaction, principal+Execution+Goal, or owner-scoped diagnostic/artifact. It never requires a fictitious Execution for installation-wide manifest/config bodies and never treats an opaque object ID as a bearer capability.

The bounded `opaque-bytes.mediaType` grammar is exact lowercase ASCII with one `/`, no parameters/whitespace and 1..64 characters per token:

```regex
^[a-z0-9!#$%&'*+.^_`|~-]{1,64}/[a-z0-9!#$%&'*+.^_`|~-]{1,64}$
```

Case folding, trimming or parameter stripping is forbidden; a producer that needs parameters must define a future versioned metadata schema rather than smuggle them into this field.

`ImmutableContentRefV1.contentDigest` is **not** universally `digestV1('immutable-content', bytes)`. Validated `instance` and `json-schema` objects are retained as their exact canonical UTF-8/JCS bytes, and `byteLength` counts those stored bytes; alternative whitespace/key order is not retained as a second representation. For an `instance`, its exact preimage/domain is the referenced schema's one `ProtocolContentIdentityRuleV1` selected by `ProtocolSchemaRefV1.contentIdentityRuleId`. That pure rule has no result endpoint and remains valid for inline schemas with no `bodyDigest`; a separate `ProtocolDigestRuleV1` exists only when some concrete field repeats the computed value. For a self-digested semantic body content identity equals the validated `bodyDigest`; for `CompletionCertificateV1` it equals `envelopeDigest`; for the storage output it is the `storage-output` digest of the full output; for a closed body without a semantic digest field it uses its declared semantic domain or `immutable-content`. For `json-schema`, it is the `schema-body` digest. For non-authority `opaque-bytes`, it is `digestV1(domain='immutable-content', schemaVersion='opaque-bytes.v1', canonicalization='raw-bytes', canonicalBytes=exact stored bytes)`; this digest-version literal is not a schema ID or manifest member, and media type is metadata that cannot change byte identity. Resolver first validates kind/schema bytes, canonical storage form, exact length/classification and the declared identity rule, then compares the ref. Thus `goalContractRef + goalContractDigest`, `resultRef + resultDigest` and `certificateRef + certificateEnvelopeDigest` are unambiguous without requiring one digest to equal hashes from two domains. A schema with zero/multiple content-identity rules, a rule whose source schema disagrees with its owner, or a self-digest occurrence rule whose domain/omissions disagree with content identity fails manifest compilation.

Schema bootstrap has one closed agreement rule. For every `ProtocolSchemaRefV1`, `schemaRef.describedSchemaId`, `schemaId` and the canonical schema document root `$id` are byte-equal; `schemaVersion` equals the document's root `properties.schemaVersion.const`. The `schema-body` digest invocation uses that exact `schemaVersion` argument and `CanonicalizationProfileV1.id`. For the Draft 2020-12 root meta-schema only, the digest invocation uses its exact `$id` as the schema-version argument; the canonical root bytes produce `jsonSchemaMetaSchemaDigest`, while the validator implementation hash pins the root, every referenced vocabulary meta-schema and the resolver table as one executable dependency boundary. Bootstrap first verifies the six generic engine artifacts and this bundled dialect set under compiled ceilings, then structurally validates canonicalization/transport-limit/opaque-ID profile bodies under those ceilings, then expands the exact ID map and materializes all numeric/profile-derived schema constraints, compiles the final Monarch schema manifest, and finally revalidates the byte-identical three retained profile instances under their generated final schemas plus cross-profile rules. The manifest's transport and opaque-ID refs must be the same retained instances used for generation; a second otherwise-valid profile is not interchangeable. A disagreement among ID/version/meta-schema/profile/hash/field-map fields is `manifest-invalid`; no latest network schema, package-registry lookup or implementation default may repair it.

Runtime dereference is a separately bounded graph operation. Object identity is the exact tuple `(storeGenerationId, objectId, contentDigest)`. Every ref occurrence is an edge, including duplicate edges; every successfully resolved identity is one object; root depth is `0`; and canonical stored bytes count once per unique resolved identity. The resolver enforces `maxResolvedRefDepth`, `maxResolvedObjects`, `maxResolvedEdges` and `maxResolvedBytes` before issuing the next fetch or allocating the rejected object/edge. Cycles, identity aliasing, a limit exceed, and any reachable authority schema outside the exact §0.1 allowlist fail closed. For a valid core instance the reachable authority-schema set equals the statically expected closure compiled for its root variant: neither a missing required object nor an extra reachable authority object is tolerated.

All durable counters/revisions/sequences/generations use `SafeCounterV1`. `MAX_SAFE_INTEGER` is a hard fail-before-write boundary; product stream rollover/new-generation migration must occur before exhaustion. Arbitrary byte totals, lengths and arithmetic accumulators use canonical unsigned decimal strings because their exact value is not a stream counter and may exceed `MAX_SAFE_INTEGER`; they reject a sign, exponent, leading zero and negative zero. No reader rounds or wraps. Array default is **ordered list whose order is hashed**. The only core canonical-set paths are listed below; they reject duplicates and sort by the stated key before hashing. No implementation may infer set semantics from a field name.

| Canonical-set path | Sort key |
|---|---|
| `manifest.schemas` | `schemaId` ASCII ascending |
| each `manifest.schemas[].digestRuleIds/bindingRuleIds` | rule ID bytes ascending |
| `manifest.digestDomains` | domain UTF-8 bytes ascending |
| `manifest.contentIdentityRules` | `ruleId` ASCII ascending; exactly one rule per schema and no unused rule |
| `manifest.digestRules` | `ruleId` ASCII ascending; every `results` list by `(schemaId,variantId-or-empty,jsonPointer)` |
| `manifest.bindingRules` | `ruleId` ASCII ascending |
| `manifest.guardRules` | `guardId` ASCII ascending; each binding/commit rule ID set sorted and duplicate-free |
| `manifest.stateTransitionRules` | `ruleId` ASCII ascending; every `from` list by state literal |
| `manifest.commitInvariantRules` | `ruleId` ASCII ascending; each `bindingRuleIds` set sorted by ID; prefix/suffix order is semantic and retained |
| `runtimeFeatureSet.unavailableFeatures` | literal ASCII ascending |
| `opaqueIdProfile.kinds` | `kind` ASCII ascending; exact registry in §3 |
| `opaqueIdProfile.idFieldRules` | `(endpoint.schemaId, endpoint.variantId-or-empty, encoded path segments)`; every endpoint unique |
| `acceptedContext.providerGrantIds` | ID bytes ascending; empty in core |
| `goalMatcherResult.candidateDrafts` | `ordinal` numeric ascending; ordinals are unique contiguous `0..n-1` |
| each `goalMatcherResult.candidateDrafts[].clauseIds/ambiguityCodes` | ID/code bytes ascending |
| `admission.matcherContracts` | `(matcherId, version, bodyDigest)` |
| `admission.candidates` | candidate ID bytes ascending |
| `admission.candidates[].clauseIds/ambiguityCodes`, `admission.selectedCandidateIds`, `admission.clauseRoutes[].selectedCandidateIds/dependencyClauseIds` | ID/code bytes ascending |
| `GoalRequirementV1.sourceCandidateIds/inputBinding.boundJsonPointers/claims`, Goal presentation keys and `EvidenceNodeV1.allowedSelectorIds` | ID/pointer/claim ID/key UTF-8 bytes ascending |
| Capability temporal classes, required claim-template IDs and claim template bindings | class literal / ID bytes / `(id, bodyDigest)` |
| `VerificationRecipeV1.claimTemplateDigests` | digest bytes ascending |
| Assessment claim bindings | `(requirementId, claimId)` |
| `CompletionAssessmentBodyV1.unresolved` | `(denial.scope,denial.code,denial.requirementId,denial.claimId,denial.evidenceId,denial.detailCode)` with absent values before present |
| `AuthorityScopeV1.capabilityIds/providerIds/dataClasses/eligibleSurfaces` | literal UTF-8 bytes ascending |
| `AuthorityScopeV1.pathTargets` | `(rootIdentityDigest,relation,operations,reparsePolicy)` |
| `PresentationContractV1.allowedPresentationKeys/requiredPresentationKeys` | key UTF-8 bytes ascending; required is a subset of allowed |
| `PresentationContractV1.denialMessages` | `(locale,scope,code,detailCode-or-empty)`; exact two-locale expansion of every §18.3 denial row |
| `EvidenceViewV1.fields/unresolved/requiredPresentationKeys` | `(requirementId,claimId)` / denial tuple / key bytes |
| `StructuredResultV1.fields/unresolved/disclosures` | `presentationKey` / denial tuple / `presentationKey` bytes ascending |

Source messages, clauses, clause routes, requirements, ordering edges, event commit bodies, output rows, the fixed one-node Evidence snapshot/selection/assessment tuples, the fixed Presentation template tuple `(en verified, en partial, en blocked, ru verified, ru partial, ru blocked)`, the fixed four-entry storage exclusion tuple and renderer disclosures remain ordered lists. Schema fixtures prove that permuting an ordered list changes its digest while permuting a set does not change its normalized body.

Normative rules:

1. Parser profile is RFC 8259 JSON constrained by this section. It MUST reject invalid UTF-8, a **leading transport BOM before the root JSON value**, duplicate object keys before object construction, trailing data, non-JSON tokens, `undefined`, NaN/Infinity, sparse arrays and resource-limit overflow before schema validation. It MUST NOT reject the UTF-8 byte sequence `EF BB BF` merely because it occurs inside a valid JSON string: decoded `U+FEFF` there is user content and remains byte-preserved unless the field schema separately forbids it; `U+FEFF` outside a string is rejected by JSON grammar. A parser that exposes only last-key-wins objects is ineligible. Schema lab pins the exact parser/JCS/schema-validator/digest/identity-binding/state-commit implementation hashes in `CanonicalizationProfileV1` and publishes positive/negative cross-language vectors before any shadow use.
2. Durable/authority schemas use JSON Schema 2020-12. Every object explicitly declares `additionalProperties`; authority objects default to `false`. An extension bag is allowed only when its schema declares that unknown values cannot affect authority, digest selection, routing, policy or completion. Unsupported required keyword/version fails `upgrade-required`. Closed discriminated unions compile as `oneOf` whose every branch is a fully flattened object with its complete properties/required set and `additionalProperties:false`; the generator MUST NOT translate TypeScript intersections to naive `allOf + additionalProperties:false`, depend on ambiguous unevaluated-property behavior, or use handwritten TS as schema input. Positive/negative compile fixtures prove every branch is satisfiable alone and rejects cross-branch fields.
3. Numeric authority admission happens **before IEEE-754 conversion**. The strict parser/pre-validator must retain each raw JSON number token and its JSON Pointer. A runtime instance number token is legal only when the generated schema maps that exact pointer to `SafeCounterV1`/another explicitly bounded safe-integer field; generic `JsonObject/JsonValue`, extension bags and unknown pointers may not smuggle numbers. A safe-integer field accepts only lexical `0|-?[1-9][0-9]*`, then proves the mathematical integer is within the safe range before conversion. Decimal/exponent tokens such as `1e-400` and `9007199254740990.9` are rejected for integer fields even if a host parser would round them to a safe integer. The separate `json-schema` document branch is package metadata, not a runtime instance: generated core schemas may use only meta-schema-valid integer-valued numeric keywords within the safe range; fractional/exponent numeric schema keywords are forbidden and exact decimal semantics stay in strings/custom rules. After kind/schema/type/range validation, objects serialize with RFC 8785 JCS. Unbounded integers and exact decimals MUST already be canonical strings; JCS/IEEE-754 numbers cannot carry them.
4. Raw user text, opaque provider bytes, secrets and attachment bytes are never silently Unicode-normalized. A schema may mark a derived authority field `normalization=NFC`; admission then stores the normalized derived value and the immutable raw source separately. Canonicalization rejects a marked field that is not already NFC. Object-key comparison follows JCS; visually equivalent keys are not merged.
5. Clause/target `sourceRange` is a half-open `[start,end)` range of UTF-8 byte offsets in the decoded-but-otherwise-byte-preserved `payload.content` string of the exact accepted command, not offsets in its JSON escape spelling. Admission re-encodes that scalar as strict UTF-8 once and rejects ranges that split a code point or exceed it. It never indexes normalized/model-rendered text.
6. Canonical timestamp is exactly `YYYY-MM-DDTHH:mm:ss.sssZ`; offsets, missing milliseconds and leap-second `:60` are rejected. Timestamp is observability/freshness input, never event ordering. Expiry/leases additionally persist a monotonic-duration attestation for the current boot; after reboot or unavailable monotonic continuity, recovery re-evaluates against wall time and fails closed on ambiguity.
7. `base10-integer-v1`: `0` or optional `-` followed by non-zero digit and digits; no `+`, exponent, whitespace, leading zero or `-0`. Unsigned schemas additionally forbid `-`.
8. `base10-decimal-minimal-v1`: optional `-`, canonical integer part, optional decimal point followed by digits ending in non-zero. No exponent, `+`, trailing zero, bare dot or `-0`; mathematically integral values encode as integer form (`1`, not `1.0`). Field schema declares allowed sign/scale/range; no implicit rounding is permitted.
9. `integer-range.minimum/maximum` are inclusive. Comparison parses canonical arbitrary-precision integers, never lexical strings or IEEE-754 numbers.
10. Before any external profile/schema/manifest is parsed, the strict parser enforces its finite compiled bootstrap ceilings from the hashed implementation artifact. Isolated parser/allocation preflight on disposable `E:` data freezes those ceilings first. Versioned `TransportLimitProfileV1` may then select only positive finite values no greater than the corresponding bootstrap ceiling; it cannot expand allocation authority. Counting is exact and shared by the bootstrap parser, runtime parser and fixture oracles: `maxPayloadBytes` counts the complete received byte sequence before parsing; root object/array depth is `1` and every nested object/array adds one while a primitive root is `0`; `maxTotalObjectMembers` is the sum of all property occurrences in one parsed top-level instance; `maxTotalArrayItems` is the sum of all element occurrences; `maxStringUtf8Bytes` is the decoded UTF-8 byte length of each individual string while the raw token remains covered by payload bytes; `maxRefs` counts every schema-recognized `ImmutableContentRefV1` object occurrence, including duplicates, before any dereference; `maxCommitEvents` is both the appender ceiling and exact generated `CommitGroupDigestBodyV1.events.maxItems`; and `maxSchemaDocuments` counts the exact root meta-schema plus every bundled vocabulary/meta-schema and every resolved Monarch schema document once by canonical URI during one manifest compilation. Each parsed profile/schema/instance independently obeys payload/depth/member/item/string ceilings; the manifest object additionally obeys its own ref count and the resolved schema closure obeys the schema-document ceiling. Exceeding either layer is typed validation failure before allocating the rejected child/member/string/ref or resolving it. Exact runtime values are frozen before final schemas are compiled: their numeric JSON Schema constraints and custom total/ref counters MUST be derived from the one retained profile, and a placeholder/zero/unbounded/over-bootstrap or differently counted profile fails compilation. The separate candidate product-store durability/latency benchmark may continue after schema compilation but must finish before any product-store choice. Shadow remains forbidden throughout Phase 0.
11. Every schema has one pure `ProtocolContentIdentityRuleV1`, independently of whether an instance physically stores that digest; every own/derived repeated digest is generated from one exact global `ProtocolDigestRuleV1`; every repeated ref/schema/value relation uses one exact `ProtocolBindingRuleV1`. Per-schema ID lists declare digest/binding participation, while a digest rule may deliberately read one schema and bind a result in another. Every endpoint uses a full §0.1 schema ID and, for a union, an exact generated `variantId`; mnemonic schema names, “every event field”, wildcard pointers and implicit branch selection are invalid. A top-level `bodyDigest` normally omits only its own exact pointer; nested fields with the same name are retained. `TypedValueV1.digest`, certificate envelope digest and derived candidate/view digests each have their own occurrence rule. Missing source/result, a pointer not declared by that exact schema/variant, domain outside the manifest registry, recursive field-name stripping, dangling rule ID or implementation-inferred exception fails manifest compilation. A schema without a self-digest is legal because its content identity is still executable; the generator must not invent a fake result field.
12. `manifest.stateTransitionRules` is the machine-readable Interaction/Execution transition table. Every closed event **variant/guard** appears in exactly one legal rule or in an explicit no-state-change rule; the certified and noncertified `execution.blocked` variants therefore have distinct IDs. An event/state/variant pair absent from the table is rejected. Prose diagrams never create an additional transition.
13. `manifest.commitInvariantRules` is the machine-readable cross-event atomicity/adjacency table. It owns receipt-link + first receipt-bearing lifecycle, terminal Invocation + Execution, Goal block + Execution block, and certificate + terminal suffixes. Prefix/suffix arrays are ordered, same-stream and same-commit; a missing/extra/interposed variant or failed listed binding rejects the complete commit before projection.

### 2.1.1. Domain-separated digest

Bare `sha256(canonicalJson)` is forbidden. Every digest is:

```text
SHA-256(
  UTF8("monarch-digest-v1\0") ||
  U32BE(len(domain)) || UTF8(domain) ||
  U32BE(len(schemaVersion)) || UTF8(schemaVersion) ||
  U32BE(len(profileId)) || UTF8(profileId) ||
  U64BE(len(canonicalBytes)) || canonicalBytes
)
```

Wire form is exactly `sha256:` followed by 64 lowercase ASCII hex chars; other case/prefix/URI/`0x` forms are invalid. The closed `agent-core-read.v1` domain registry is exactly:

```text
accepted-command
accepted-command-context
assessment-body
assessment-input
attempt-selection-body
authority-scope
candidate-set
canonical-input
capability-contract
certification-key
certifier-contract
claim-template
clock-attestation
command-dedupe-scope
command-fingerprint
completion-certificate-body
completion-terminal-policy
deterministic-goal-minimum
event-commit
event-payload
evidence-admission-key
evidence-graph-snapshot
evidence-node-body
evidence-view
follow-up-decision
goal-admission-binding
goal-contract-body
goal-matcher
goal-matcher-result
goal-semantic-body
immutable-content
intent-admission-body
invocation-body
invocation-dispatch-key
kernel-receipt-body
presentation-contract
protocol-manifest
runtime-feature-set
schema-body
selector-descriptor
storage-accounting-proof
storage-budget-profile
storage-output
storage-policy
structured-result
transport-limit-profile
typed-value
verification-recipe
volume-identity
windows-path-identity
```

Content identity is materialized in `manifest.contentIdentityRules`; repeated digest locations are materialized separately in `manifest.digestRules`. It is never inferred from a field name. The complete non-default instance mapping is:

| Content domain | Exact schema ID(s) |
|---|---|
| `accepted-command` | `monarch.agent-command.v1` |
| `accepted-command-context` | `monarch.accepted-command-context.v1` |
| `assessment-body` | `monarch.completion-assessment-body.v1` |
| `assessment-input` | `monarch.completion-assessment-input.v1` |
| `attempt-selection-body` | `monarch.requirement-attempt-selection.v1` |
| `authority-scope` | `monarch.authority-scope.v1` |
| `canonical-input` | `monarch.workspace-storage-audit-input.v2` |
| `capability-contract` | `monarch.agent-capability-contract.v1` |
| `certification-key` | `monarch.certification-key-body.v1` |
| `certifier-contract` | `monarch.completion-certifier-contract.v1` |
| `claim-template` | `monarch.claim-template.v1` |
| `clock-attestation` | `monarch.clock-attestation.v1` |
| `command-dedupe-scope` | `monarch.command-dedupe-scope-body.v1` |
| `command-fingerprint` | `monarch.command-fingerprint-body.v1` |
| `completion-certificate-body` | `monarch.completion-certificate.v1` |
| `completion-terminal-policy` | `monarch.completion-terminal-policy.v1` |
| `deterministic-goal-minimum` | `monarch.deterministic-goal-minimum.v1` |
| `event-commit` | `monarch.commit-group-digest-body.v1` |
| `evidence-admission-key` | `monarch.evidence-admission-key-body.v1` |
| `evidence-graph-snapshot` | `monarch.evidence-graph-snapshot.v1` |
| `evidence-node-body` | `monarch.evidence-node.v1` |
| `evidence-view` | `monarch.evidence-view.v1` |
| `follow-up-decision` | `monarch.follow-up-admission-decision.v1` |
| `goal-admission-binding` | `monarch.goal-admission-binding.v1` |
| `goal-contract-body` | `monarch.goal-contract.v1` |
| `goal-matcher` | `monarch.goal-matcher-descriptor.v1` |
| `goal-matcher-result` | `monarch.goal-matcher-result.v1` |
| `goal-semantic-body` | `monarch.goal-semantic-body.v1` |
| `intent-admission-body` | `monarch.interaction-intent-admission.v1` |
| `invocation-body` | `monarch.invocation.v1` |
| `invocation-dispatch-key` | `monarch.invocation-dispatch-key-body.v1` |
| `kernel-receipt-body` | `monarch.kernel-receipt-ref.v1` |
| `presentation-contract` | `monarch.presentation-contract.v1` |
| `protocol-manifest` | `monarch.protocol-feature-schema-manifest.v1` |
| `runtime-feature-set` | `monarch.runtime-feature-set.v1` |
| `selector-descriptor` | `monarch.selector-descriptor.v1` |
| `storage-accounting-proof` | `monarch.storage-traversal-accounting-proof.v2` |
| `storage-budget-profile` | `monarch.storage-traversal-budget-profile.v2` |
| `storage-output` | `monarch.workspace-storage-audit-output.v2` |
| `storage-policy` | `monarch.storage-exclusion-policy.v2`, `monarch.storage-inclusion-policy.v2` |
| `structured-result` | `monarch.structured-result.v1` |
| `transport-limit-profile` | `monarch.transport-limit-profile.v1` |
| `typed-value` | `monarch.typed-value.v1` |
| `verification-recipe` | `monarch.verification-recipe.v1` |
| `volume-identity` | `monarch.volume-identity-digest-body.v1` |
| `windows-path-identity` | `monarch.canonical-windows-identity-body.v1` |

Exactly these remaining schema IDs use domain `immutable-content` over the full validated instance with no omitted pointer: `monarch.agent-client-command.v1`, `monarch.agent-command-receipt.v1`, `monarch.agent-event.v1`, `monarch.agent-protocol-error.v1`, `monarch.canonical-windows-path.v1`, `monarch.canonicalization-profile.v1`, `monarch.command-dedupe-record.v1`, `monarch.commit-event-digest-body.v1`, `monarch.completion-commit-assessment.v1`, `monarch.completion-denial.v1`, `monarch.completion-request.v1`, `monarch.immutable-content-ref.v1`, `monarch.interaction-follow-up-payload.v1`, `monarch.interaction-submit-payload.v1`, `monarch.invocation-transition.v1`, `monarch.opaque-id-profile.v1`, `monarch.storage-exclusion-summary.v2`, `monarch.storage-temporal-proof.v2` and `monarch.typed-value-literal.v1`. This non-default table plus that exact default list must equal the §0.1 allowlist with no overlap/missing schema. A schema declaring top-level `/bodyDigest` omits exactly that pointer; `TypedValueV1` omits only `/digest`; `CompletionCertificateV1` omits only `/envelopeDigest`; every other content rule uses the full instance. Compiled JSON Schema documents separately use `schema-body`; event payload and closed commit-group, plus derived `candidate-set`, use their dedicated occurrence rules and are not alternate whole-instance identities. Inclusion/exclusion policies share `storage-policy` but remain non-interchangeable through required schema version. A `*Digest` without an exact manifest rule or explicit referenced-content equality is invalid; `ImplementationHashV1` is the separately prefixed raw-artifact hash defined in §2.1, not an exception disguised as `DigestV1`.

The following cross-schema rules are mandatory exact rule instances. Endpoint notation is ``full-schema-id[optional exact variantId]@RFC6901-pointer``; `@""` is the root. Event `variantId` follows the exact closed convention in §5: a non-union payload uses its event type; structural union/verdict branches append the discriminating reason/verdict. No row below is shorthand and no result may be replaced with “all matching fields”:

| Rule ID | Domain / exact source | Mandatory exact results |
|---|---|---|
| `accepted-command.follow-up.v1` | `accepted-command`; `monarch.agent-command.v1[interaction.follow-up]@""` | `monarch.goal-matcher-result.v1@/acceptedCommandDigest`; `monarch.interaction-intent-admission.v1@/source/acceptedCommandDigest`; `monarch.goal-admission-binding.v1@/acceptedCommandDigest`; `monarch.goal-contract.v1@/source/acceptedCommandDigest`; `monarch.agent-event.v1[interaction.follow-up-accepted]@/payload/acceptedCommandDigest` |
| `accepted-command.submit.v1` | `accepted-command`; `monarch.agent-command.v1[interaction.submit]@""` | `monarch.goal-matcher-result.v1@/acceptedCommandDigest`; `monarch.interaction-intent-admission.v1@/source/acceptedCommandDigest`; `monarch.goal-admission-binding.v1@/acceptedCommandDigest`; `monarch.goal-contract.v1@/source/acceptedCommandDigest`; `monarch.agent-event.v1[interaction.accepted]@/payload/acceptedCommandDigest` |
| `accepted-context.v1` | `accepted-command-context`; `monarch.accepted-command-context.v1@""` | `monarch.command-fingerprint-body.v1@/acceptedContextDigest`; `monarch.command-dedupe-record.v1@/acceptedContextDigest`; `monarch.goal-matcher-result.v1@/acceptedContextDigest`; `monarch.interaction-intent-admission.v1@/acceptedContextDigest`; `monarch.goal-admission-binding.v1@/acceptedContextDigest`; `monarch.completion-assessment-body.v1@/acceptedContextDigest`; `monarch.evidence-view.v1@/acceptedContextDigest` |
| `command-fingerprint.v1` | `command-fingerprint`; `monarch.command-fingerprint-body.v1@""` | `monarch.agent-command-receipt.v1@/fingerprint`; `monarch.command-dedupe-record.v1@/requestFingerprint` |
| `event-commit.v1` | `event-commit`; `monarch.commit-group-digest-body.v1@""` | `monarch.agent-event.v1[completion.certified:blocked]@/commitDigest`; `monarch.agent-event.v1[completion.certified:partial]@/commitDigest`; `monarch.agent-event.v1[completion.certified:verified]@/commitDigest`; `monarch.agent-event.v1[completion.requested]@/commitDigest`; `monarch.agent-event.v1[evidence.projected]@/commitDigest`; `monarch.agent-event.v1[execution.blocked:certified]@/commitDigest`; `monarch.agent-event.v1[execution.blocked:noncertified]@/commitDigest`; `monarch.agent-event.v1[execution.cancelled:cancelled-before-dispatch]@/commitDigest`; `monarch.agent-event.v1[execution.cancelled:kernel-confirmed-cancelled]@/commitDigest`; `monarch.agent-event.v1[execution.completed]@/commitDigest`; `monarch.agent-event.v1[execution.created]@/commitDigest`; `monarch.agent-event.v1[execution.failed:assessment-input-invalid]@/commitDigest`; `monarch.agent-event.v1[execution.failed:evidence-integrity-invalid]@/commitDigest`; `monarch.agent-event.v1[execution.failed:internal-error]@/commitDigest`; `monarch.agent-event.v1[execution.failed:kernel-failed]@/commitDigest`; `monarch.agent-event.v1[execution.failed:output-schema-rejected]@/commitDigest`; `monarch.agent-event.v1[execution.partial]@/commitDigest`; `monarch.agent-event.v1[goal.blocked]@/commitDigest`; `monarch.agent-event.v1[goal.compilation-requested]@/commitDigest`; `monarch.agent-event.v1[goal.contract-admitted]@/commitDigest`; `monarch.agent-event.v1[interaction.accepted]@/commitDigest`; `monarch.agent-event.v1[interaction.follow-up-accepted]@/commitDigest`; `monarch.agent-event.v1[interaction.follow-up-dispositioned]@/commitDigest`; `monarch.agent-event.v1[interaction.follow-up-intent-admitted]@/commitDigest`; `monarch.agent-event.v1[interaction.intent-admitted]@/commitDigest`; `monarch.agent-event.v1[interaction.routed]@/commitDigest`; `monarch.agent-event.v1[invocation.authorized]@/commitDigest`; `monarch.agent-event.v1[invocation.cancelled]@/commitDigest`; `monarch.agent-event.v1[invocation.cancelled-before-dispatch]@/commitDigest`; `monarch.agent-event.v1[invocation.dispatched]@/commitDigest`; `monarch.agent-event.v1[invocation.failed]@/commitDigest`; `monarch.agent-event.v1[invocation.indeterminate]@/commitDigest`; `monarch.agent-event.v1[invocation.observed]@/commitDigest`; `monarch.agent-event.v1[invocation.output-checked]@/commitDigest`; `monarch.agent-event.v1[invocation.output-rejected]@/commitDigest`; `monarch.agent-event.v1[invocation.prepared]@/commitDigest`; `monarch.agent-event.v1[invocation.receipt-linked]@/commitDigest`; `monarch.agent-event.v1[invocation.rejected]@/commitDigest`; `monarch.agent-event.v1[invocation.settled]@/commitDigest`; `monarch.agent-event.v1[presentation.completed]@/commitDigest` |
| `event-payload.completion-certified-blocked.v1` | `event-payload`; `monarch.agent-event.v1[completion.certified:blocked]@/payload` | `monarch.agent-event.v1[completion.certified:blocked]@/payloadDigest` |
| `event-payload.completion-certified-partial.v1` | `event-payload`; `monarch.agent-event.v1[completion.certified:partial]@/payload` | `monarch.agent-event.v1[completion.certified:partial]@/payloadDigest` |
| `event-payload.completion-certified-verified.v1` | `event-payload`; `monarch.agent-event.v1[completion.certified:verified]@/payload` | `monarch.agent-event.v1[completion.certified:verified]@/payloadDigest` |
| `event-payload.completion-requested.v1` | `event-payload`; `monarch.agent-event.v1[completion.requested]@/payload` | `monarch.agent-event.v1[completion.requested]@/payloadDigest` |
| `event-payload.evidence-projected.v1` | `event-payload`; `monarch.agent-event.v1[evidence.projected]@/payload` | `monarch.agent-event.v1[evidence.projected]@/payloadDigest` |
| `event-payload.execution-blocked-certified.v1` | `event-payload`; `monarch.agent-event.v1[execution.blocked:certified]@/payload` | `monarch.agent-event.v1[execution.blocked:certified]@/payloadDigest` |
| `event-payload.execution-blocked-noncertified.v1` | `event-payload`; `monarch.agent-event.v1[execution.blocked:noncertified]@/payload` | `monarch.agent-event.v1[execution.blocked:noncertified]@/payloadDigest` |
| `event-payload.execution-cancelled-cancelled-before-dispatch.v1` | `event-payload`; `monarch.agent-event.v1[execution.cancelled:cancelled-before-dispatch]@/payload` | `monarch.agent-event.v1[execution.cancelled:cancelled-before-dispatch]@/payloadDigest` |
| `event-payload.execution-cancelled-kernel-confirmed-cancelled.v1` | `event-payload`; `monarch.agent-event.v1[execution.cancelled:kernel-confirmed-cancelled]@/payload` | `monarch.agent-event.v1[execution.cancelled:kernel-confirmed-cancelled]@/payloadDigest` |
| `event-payload.execution-completed.v1` | `event-payload`; `monarch.agent-event.v1[execution.completed]@/payload` | `monarch.agent-event.v1[execution.completed]@/payloadDigest` |
| `event-payload.execution-created.v1` | `event-payload`; `monarch.agent-event.v1[execution.created]@/payload` | `monarch.agent-event.v1[execution.created]@/payloadDigest` |
| `event-payload.execution-failed-assessment-input-invalid.v1` | `event-payload`; `monarch.agent-event.v1[execution.failed:assessment-input-invalid]@/payload` | `monarch.agent-event.v1[execution.failed:assessment-input-invalid]@/payloadDigest` |
| `event-payload.execution-failed-evidence-integrity-invalid.v1` | `event-payload`; `monarch.agent-event.v1[execution.failed:evidence-integrity-invalid]@/payload` | `monarch.agent-event.v1[execution.failed:evidence-integrity-invalid]@/payloadDigest` |
| `event-payload.execution-failed-internal-error.v1` | `event-payload`; `monarch.agent-event.v1[execution.failed:internal-error]@/payload` | `monarch.agent-event.v1[execution.failed:internal-error]@/payloadDigest` |
| `event-payload.execution-failed-kernel-failed.v1` | `event-payload`; `monarch.agent-event.v1[execution.failed:kernel-failed]@/payload` | `monarch.agent-event.v1[execution.failed:kernel-failed]@/payloadDigest` |
| `event-payload.execution-failed-output-schema-rejected.v1` | `event-payload`; `monarch.agent-event.v1[execution.failed:output-schema-rejected]@/payload` | `monarch.agent-event.v1[execution.failed:output-schema-rejected]@/payloadDigest` |
| `event-payload.execution-partial.v1` | `event-payload`; `monarch.agent-event.v1[execution.partial]@/payload` | `monarch.agent-event.v1[execution.partial]@/payloadDigest` |
| `event-payload.goal-blocked.v1` | `event-payload`; `monarch.agent-event.v1[goal.blocked]@/payload` | `monarch.agent-event.v1[goal.blocked]@/payloadDigest` |
| `event-payload.goal-compilation-requested.v1` | `event-payload`; `monarch.agent-event.v1[goal.compilation-requested]@/payload` | `monarch.agent-event.v1[goal.compilation-requested]@/payloadDigest` |
| `event-payload.goal-contract-admitted.v1` | `event-payload`; `monarch.agent-event.v1[goal.contract-admitted]@/payload` | `monarch.agent-event.v1[goal.contract-admitted]@/payloadDigest` |
| `event-payload.interaction-accepted.v1` | `event-payload`; `monarch.agent-event.v1[interaction.accepted]@/payload` | `monarch.agent-event.v1[interaction.accepted]@/payloadDigest` |
| `event-payload.interaction-follow-up-accepted.v1` | `event-payload`; `monarch.agent-event.v1[interaction.follow-up-accepted]@/payload` | `monarch.agent-event.v1[interaction.follow-up-accepted]@/payloadDigest` |
| `event-payload.interaction-follow-up-dispositioned.v1` | `event-payload`; `monarch.agent-event.v1[interaction.follow-up-dispositioned]@/payload` | `monarch.agent-event.v1[interaction.follow-up-dispositioned]@/payloadDigest` |
| `event-payload.interaction-follow-up-intent-admitted.v1` | `event-payload`; `monarch.agent-event.v1[interaction.follow-up-intent-admitted]@/payload` | `monarch.agent-event.v1[interaction.follow-up-intent-admitted]@/payloadDigest` |
| `event-payload.interaction-intent-admitted.v1` | `event-payload`; `monarch.agent-event.v1[interaction.intent-admitted]@/payload` | `monarch.agent-event.v1[interaction.intent-admitted]@/payloadDigest` |
| `event-payload.interaction-routed.v1` | `event-payload`; `monarch.agent-event.v1[interaction.routed]@/payload` | `monarch.agent-event.v1[interaction.routed]@/payloadDigest` |
| `event-payload.invocation-authorized.v1` | `event-payload`; `monarch.agent-event.v1[invocation.authorized]@/payload` | `monarch.agent-event.v1[invocation.authorized]@/payloadDigest` |
| `event-payload.invocation-cancelled.v1` | `event-payload`; `monarch.agent-event.v1[invocation.cancelled]@/payload` | `monarch.agent-event.v1[invocation.cancelled]@/payloadDigest` |
| `event-payload.invocation-cancelled-before-dispatch.v1` | `event-payload`; `monarch.agent-event.v1[invocation.cancelled-before-dispatch]@/payload` | `monarch.agent-event.v1[invocation.cancelled-before-dispatch]@/payloadDigest` |
| `event-payload.invocation-dispatched.v1` | `event-payload`; `monarch.agent-event.v1[invocation.dispatched]@/payload` | `monarch.agent-event.v1[invocation.dispatched]@/payloadDigest` |
| `event-payload.invocation-failed.v1` | `event-payload`; `monarch.agent-event.v1[invocation.failed]@/payload` | `monarch.agent-event.v1[invocation.failed]@/payloadDigest` |
| `event-payload.invocation-indeterminate.v1` | `event-payload`; `monarch.agent-event.v1[invocation.indeterminate]@/payload` | `monarch.agent-event.v1[invocation.indeterminate]@/payloadDigest` |
| `event-payload.invocation-observed.v1` | `event-payload`; `monarch.agent-event.v1[invocation.observed]@/payload` | `monarch.agent-event.v1[invocation.observed]@/payloadDigest` |
| `event-payload.invocation-output-checked.v1` | `event-payload`; `monarch.agent-event.v1[invocation.output-checked]@/payload` | `monarch.agent-event.v1[invocation.output-checked]@/payloadDigest` |
| `event-payload.invocation-output-rejected.v1` | `event-payload`; `monarch.agent-event.v1[invocation.output-rejected]@/payload` | `monarch.agent-event.v1[invocation.output-rejected]@/payloadDigest` |
| `event-payload.invocation-prepared.v1` | `event-payload`; `monarch.agent-event.v1[invocation.prepared]@/payload` | `monarch.agent-event.v1[invocation.prepared]@/payloadDigest` |
| `event-payload.invocation-receipt-linked.v1` | `event-payload`; `monarch.agent-event.v1[invocation.receipt-linked]@/payload` | `monarch.agent-event.v1[invocation.receipt-linked]@/payloadDigest` |
| `event-payload.invocation-rejected.v1` | `event-payload`; `monarch.agent-event.v1[invocation.rejected]@/payload` | `monarch.agent-event.v1[invocation.rejected]@/payloadDigest` |
| `event-payload.invocation-settled.v1` | `event-payload`; `monarch.agent-event.v1[invocation.settled]@/payload` | `monarch.agent-event.v1[invocation.settled]@/payloadDigest` |
| `event-payload.presentation-completed.v1` | `event-payload`; `monarch.agent-event.v1[presentation.completed]@/payload` | `monarch.agent-event.v1[presentation.completed]@/payloadDigest` |
| `candidate-set.v1` | `candidate-set`; `monarch.interaction-intent-admission.v1@""`, omitting exactly `/id`, `/interactionId`, `/source`, `/acceptedContextDigest`, `/runtimeFeatureSetRef`, `/runtimeFeatureSetDigest`, `/matcherContracts`, `/matcherResultRef`, `/matcherResultDigest`, `/candidateSetDigest`, `/bodyDigest`, `/createdAt` | `monarch.interaction-intent-admission.v1@/candidateSetDigest`; `monarch.agent-event.v1[interaction.intent-admitted]@/payload/candidateSetDigest`; `monarch.agent-event.v1[interaction.routed]@/payload/candidateSetDigest`; `monarch.deterministic-goal-minimum.v1@/candidateSetDigest`; `monarch.goal-contract.v1@/source/candidateSetDigest` |
| `goal-admission-binding.v1` | `goal-admission-binding`; `monarch.goal-admission-binding.v1@""`, omitting exactly `/bodyDigest` | `monarch.goal-admission-binding.v1@/bodyDigest`; `monarch.deterministic-goal-minimum.v1@/admissionBindingDigest`; `monarch.goal-contract.v1@/admissionBindingDigest`; `monarch.agent-event.v1[goal.contract-admitted]@/payload/admissionBindingDigest` |
| `goal-matcher-result.v1` | `goal-matcher-result`; `monarch.goal-matcher-result.v1@""`, omitting exactly `/bodyDigest` | `monarch.goal-matcher-result.v1@/bodyDigest`; `monarch.interaction-intent-admission.v1@/matcherResultDigest` |
| `invocation-dispatch-key.v1` | `invocation-dispatch-key`; `monarch.invocation-dispatch-key-body.v1@""` | `monarch.invocation.v1@/dispatchIdempotencyKey`; `monarch.kernel-receipt-ref.v1@/dispatchIdempotencyKey` |
| `evidence-admission-key.v1` | `evidence-admission-key`; `monarch.evidence-admission-key-body.v1@""` | `monarch.evidence-node.v1@/admissionKey` |
| `certification-key.v1` | `certification-key`; `monarch.certification-key-body.v1@""` | `monarch.completion-commit-assessment.v1@/certificationKey`; `monarch.completion-certificate.v1@/certificationKey`; `monarch.agent-event.v1[completion.certified:verified]@/payload/certificationKey`; `monarch.agent-event.v1[completion.certified:partial]@/payload/certificationKey`; `monarch.agent-event.v1[completion.certified:blocked]@/payload/certificationKey`; `monarch.evidence-view.v1@/certificationKey` |
| `assessment-input.v1` | `assessment-input`; `monarch.completion-assessment-input.v1@""`, omitting exactly `/bodyDigest` | `monarch.completion-assessment-input.v1@/bodyDigest`; `monarch.agent-event.v1[completion.requested]@/payload/assessmentInputDigest`; `monarch.certification-key-body.v1@/assessmentInputDigest`; `monarch.completion-commit-assessment.v1@/keyBody/assessmentInputDigest`; `monarch.completion-assessment-body.v1@/assessmentInputDigest`; `monarch.completion-certificate.v1@/assessmentInputDigest` |
| `assessment-body.v1` | `assessment-body`; `monarch.completion-assessment-body.v1@""` | `monarch.completion-commit-assessment.v1@/assessmentBodyDigest`; `monarch.completion-certificate.v1@/assessmentBodyDigest`; `monarch.agent-event.v1[completion.certified:verified]@/payload/assessmentBodyDigest`; `monarch.agent-event.v1[completion.certified:partial]@/payload/assessmentBodyDigest`; `monarch.agent-event.v1[completion.certified:blocked]@/payload/assessmentBodyDigest` |
| `certificate-envelope.v1` | `completion-certificate-body`; `monarch.completion-certificate.v1@""`, omitting exactly `/envelopeDigest` | `monarch.completion-certificate.v1@/envelopeDigest`; `monarch.agent-event.v1[completion.certified:verified]@/payload/certificateEnvelopeDigest`; `monarch.agent-event.v1[completion.certified:partial]@/payload/certificateEnvelopeDigest`; `monarch.agent-event.v1[completion.certified:blocked]@/payload/certificateEnvelopeDigest`; `monarch.agent-event.v1[execution.completed]@/payload/certificateEnvelopeDigest`; `monarch.agent-event.v1[execution.partial]@/payload/certificateEnvelopeDigest`; `monarch.agent-event.v1[execution.blocked:certified]@/payload/certificateEnvelopeDigest`; `monarch.evidence-view.v1@/certificateEnvelopeDigest`; `monarch.structured-result.v1@/certificateEnvelopeDigest` |
| `evidence-view.v1` | `evidence-view`; `monarch.evidence-view.v1@""`, omitting exactly `/bodyDigest` | `monarch.evidence-view.v1@/bodyDigest`; `monarch.structured-result.v1@/evidenceViewBodyDigest`; `monarch.agent-event.v1[presentation.completed]@/payload/evidenceViewBodyDigest` |
| `structured-result.v1` | `structured-result`; `monarch.structured-result.v1@""`, omitting exactly `/bodyDigest` | `monarch.structured-result.v1@/bodyDigest`; `monarch.agent-event.v1[presentation.completed]@/payload/structuredResultBodyDigest` |
| `transport-limit-profile.v1` | `transport-limit-profile`; `monarch.transport-limit-profile.v1@""`, omitting exactly `/bodyDigest` | `monarch.transport-limit-profile.v1@/bodyDigest`; `monarch.agent-capability-contract.v1@/transportLimitProfileDigest` |

Every top-level self digest has a same-schema occurrence rule whose source is the whole instance and whose only omission is its own result pointer unless this section states otherwise; that occurrence rule must compute the same function as its schema's content-identity rule. The 40 exact `event-payload.*` rows are a bijection with the 40 event/commit-body variants; generated `CommitEventDigestBodyV1` is derived only from an already payload-validated event and carries byte-equal payload/payloadDigest through the parity projection, never an independently caller-authored digest. Every repeated `instance ref + digest` pair has a binding rule from the repeated digest to the ref's schema-selected `contentDigest`; every repeated digest naming the instance schema binds to `ref.contentSchemaDigest`. `ProtocolSchemaRefV1.schemaDigest` is the described JSON Schema body's identity and therefore binds to `schemaRef.contentDigest`, while that ref's `contentSchemaDigest` separately binds to `CanonicalizationProfileV1.jsonSchemaMetaSchemaDigest`. A repeated semantic field is not automatically a ref digest: its exact binding rule must name both endpoints. Every core event variant also has an exact binding rule from `stream.id` to its payload aggregate ID. The compiler emits the complete rule table and lints that every `DigestV1` field is either a rule result, a rule source component, or an explicitly named ref/schema/value equality. This closes cross-object derivations such as fingerprint/key bodies without pretending their result field lives in the source schema.

At minimum, `manifest.bindingRules` contains these exact semantic rules in addition to the mechanically enumerated ref-content/ref-schema/event-stream pairs:

| Rule ID | Left | Right | Relation |
|---|---|---|---|
| `goal-matcher-result-admission.v1` | `monarch.goal-matcher-result.v1@""` | `monarch.interaction-intent-admission.v1@""` | `goal-matcher-result-admission-projection`: exact command/context/matcher/clauses, the complete §9.1 candidate-legality matrix and one-to-one ordinal drafts; Application may add only allocated IDs, a closed target-resolver result, static contract/feature eligibility and mechanically derived route/cohort fields; no negated, prohibited, unknown, target-ambiguous or temporally ambiguous/current/stable clause may coexist with an execution route |
| `accepted-command-receipt.submit.v1` | `monarch.agent-command.v1[interaction.submit]@""` | `monarch.agent-event.v1[interaction.accepted]@""` | `accepted-command-receipt-projection`: resolve exact command/dedupe-scope/dedupe/receipt refs; one-event first commit; stable principal/context/fingerprint/command ID/interaction ID/revision/event ID/accepted time and retained receipt binding as defined in §6 |
| `accepted-command-receipt.follow-up.v1` | `monarch.agent-command.v1[interaction.follow-up]@""` | `monarch.agent-event.v1[interaction.follow-up-accepted]@""` | same closed projection plus exact follow-up message/target/revision branch binding |
| `goal-admission-authority.v1` | `monarch.goal-admission-binding.v1@""` | `monarch.goal-contract.v1@""` | `goal-admission-authority-equal` as exhaustively defined in §9.2, including command/context/locale, selected candidate, explicit interval + partial admission, exact required claim suite, feature/matcher/capability/certifier/terminal policy, target/root, AuthorityScope, policy/budget and semantic input |
| `goal-minimum-semantic.v1` | `monarch.deterministic-goal-minimum.v1@""` | `monarch.goal-contract.v1@""` | `goal-minimum-semantic-equal`: all repeated admission-binding/matcher/semantic refs and digests byte-equal |
| `transport-limit-profile-core.v1` | `monarch.protocol-feature-schema-manifest.v1@/transportLimitProfileRef` | `monarch.agent-capability-contract.v1@/transportLimitProfileRef` | `byte-equal`; the capability cannot select a second valid profile, and its repeated digest is separately bound to this ref's content identity |
| `certificate-view-projection.v1` | `monarch.completion-certificate.v1@""` | `monarch.evidence-view.v1@""` | `certificate-view-projection`, including embedded Goal/admission/context/locale/contract and exact empty artifacts |
| `view-result-projection.v1` | `monarch.evidence-view.v1@""` | `monarch.structured-result.v1@""` | `view-result-projection`, including status/fields/locale/contract/renderer and exact empty artifacts |

The named projection relations are human review labels for finite generated assertion programs, not evaluator callbacks. Each compiled row contains the ordered primitive operations, exact endpoints and terminal predicate; the identity-binding evaluator covered by `CanonicalizationProfileV1.protocolIdentityBindingEvaluatorImplementationHash` can execute only that closed instruction set. `accepted-command-receipt-projection` may additionally read only the complete candidate commit containing its right-hand event, the command/dedupe/receipt refs explicitly named by that event and the one dedupe-scope ref explicitly named by that dedupe body; its generated program proves the commit has exactly that one event and that all §6 equality/atomicity predicates hold. Adding an instruction requires a Protocol/profile revision; changing exact endpoints requires a manifest/schema revision. Evaluation may dereference only the bounded finite ref closure named by the compiled program and may not query a current registry or projection.

`manifest.guardRules` closes the previously implicit state/commit guard boundary. Every `guardId` used by a state or commit rule resolves exactly once; every listed binding/commit rule resolves; unused or duplicate guards fail compilation. The eight `ProtocolGuardRelationV1` literals are review labels expanded by the compiler into finite state/commit programs. The reducer covered by `CanonicalizationProfileV1.protocolStateCommitReducerImplementationHash` has no label dispatch: it executes only the expanded primitives. Those programs prove, respectively, aggregate absence plus bindings; exact branch/state/revision CAS; closed Invocation transition plus resulting snapshot; zero prior core Invocation plus the single Goal requirement; the complete §18.2 assessment-fence snapshot; exact certificate or typed-terminal suffixes; and the certificate/view/result presentation projection. A program reads only the complete candidate commit, the fixture appender's current retained aggregate state/revision tuple derived by the exact event reducer, and immutable refs explicitly named by those objects. It cannot consume or hash an unlisted rolling stream-prefix/snapshot body, and cannot consult wall clock, current registry, network, model, product store or arbitrary code. The generated package must publish one positive and one single-predicate-negative fixture for every guard row.

No `such as`/free-form domain is permitted. Extension manifest registers a new versioned domain list and cannot reuse core domains for another semantic object. A digest is accepted only together with its expected domain, schema version and profile ID. Reusing equal bytes across domains never yields an interchangeable authority token.

Signatures/MAC are a separate threat-model decision. These digests prove deterministic identity and corruption detection under the trusted local writer; they MUST NOT be described as protection against a local attacker able to rewrite the store and recompute hashes.

### 2.1.2. Auth context epoch

`authContextEpoch` is a server-issued opaque generation of one authenticated attestation/session, stable across idempotent retries and ordinary access-token refresh. It changes on logout/login, principal/authority/surface attestation change, session revocation, ownership transfer or explicit security rotation. It MUST NOT be generated per request. Replaying in the same epoch returns the original receipt. A later epoch cannot reuse old authority, but the same stable principal/installation may resubmit the exact original closed command branch with its client request ID and receive the old receipt without creating a new command; it needs a fresh client ID for new work. Core defines no separate `command.lookup` query.

### 2.1.3. Windows path identity

String lowercasing is not path canonicalization. An authority-bearing existing root is represented by:

```ts
interface CanonicalWindowsPathV1 {
  schemaVersion: 'monarch.canonical-windows-path.v1';
  displayPath: string;
  identityDigest: DigestV1;
  volumeIdentityBodyRef: ImmutableContentRefV1;
  volumeIdentityDigest: DigestV1;
  fileId128Hex: string; // exactly 32 lowercase hex chars from FILE_ID_INFO.FileId bytes in API byte order
  reparsePolicy: 'exclude-no-follow';
  observedAt: string;
}

interface CanonicalWindowsIdentityBodyV1 {
  schemaVersion: 'monarch.canonical-windows-identity-body.v1';
  volumeIdentityDigest: DigestV1;
  fileId128Hex: string;
  reparsePolicy: 'exclude-no-follow';
}

interface VolumeIdentityDigestBodyV1 {
  schemaVersion: 'monarch.volume-identity-digest-body.v1';
  volumeGuidPathUpper: string;
  volumeSerialNumberHex16: string;
  filesystemNameUpper: string;
}
```

`volumeIdentityDigest` hashes the exact retained `VolumeIdentityDigestBodyV1` under domain `volume-identity`; `volumeIdentityBodyRef.contentDigest` and the repeated digest are bound by the manifest. `identityDigest` hashes the exact `CanonicalWindowsIdentityBodyV1` under domain `windows-path-identity`. `displayPath` and `observedAt` are presentation/provenance and are deliberately absent from the identity body. Every field duplicated between `CanonicalWindowsPathV1` and its identity body MUST be byte-equal before admission. NT-path spelling is deliberately not another authority digest: existing-root identity is volume identity + 128-bit file ID + the literal no-follow policy. A direct drive-letter, extended-length or volume-GUID spelling may therefore name one identity only after the support-profile checks below prove the same direct local-volume device and handle identity. A DOS 8.3 spelling, when the OS accepts it, is only an ingress alias to that handle: enumeration and evidence use the long name returned by the pinned information class and never create a second short-name entry. Unsupported/unstable identity makes the capability ineligible. API byte order is preserved exactly and fixture-pinned; numeric/endian reinterpretation is forbidden.

Admission rejects drive-relative `E:`, NUL, DOS device aliases, trailing-dot/space aliasing and alternate data streams unless a capability schema explicitly supports them. Generic canonicalization normalizes only separators and absolute syntax; it does not case-fold, trim components, Unicode-normalize names or use display spelling for equality. It opens the root through the Kernel path gate, obtains volume + file identity from the handle, and records the versioned reparse policy.

The first storage slice is narrower than generic path identity: only a non-volume-root directory on a local fixed NTFS volume with a direct DOS-device→local-volume mapping is eligible. The generated admission program requires `GetDriveTypeW=DRIVE_FIXED`; `QueryDosDeviceW`/volume-GUID resolution to one direct local volume device rather than MUP or another DOS path; `GetVolumeInformationByHandleW` filesystem name exactly `NTFS`; one disk extent from `IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS`; and `IOCTL_STORAGE_QUERY_PROPERTY(StorageDeviceProperty)` with `DeviceType=DIRECT_ACCESS_DEVICE`, `RemovableMedia=FALSE` and `BusType` exactly one of `{BusTypeAta, BusTypeSata, BusTypeNvme, BusTypeSas, BusTypeRAID}`. Every other current or future `STORAGE_BUS_TYPE` literal is denied, including `Unknown`, `Scsi`, `Atapi`, `1394`, `Ssa`, `Fibre`, `Usb`, `iScsi`, `Sd`, `Mmc`, `Virtual`, `FileBackedVirtual`, `Spaces`, `SCM`, `Ufs`, `Nvmeof`, `Max` and reserved/unknown values. Every ancestor/root handle is queried with `FileAttributeTagInfo` and must lack `FILE_ATTRIBUTE_REPARSE_POINT`; root handle must be a directory and not the volume root. Failure/unsupported API, multiple/spanned extents or an unknown classification denies eligibility. It therefore rejects drive roots, UNC/SMB, mapped drives, `SUBST` aliases, removable media, iSCSI/NVMe-oF/Fibre/USB, VHD/VHDX/Storage-Spaces-backed/unknown device classes, ReFS/FAT/exFAT, directory mount points and any reparse ancestor or root. An extended-length or volume-GUID spelling is accepted only when it resolves to that same direct fixed local device and exact handle identity; alias spelling never expands support. This is a closed support matrix, not “best effort”; another filesystem/root or bus class requires a new profile plus hardware fixtures.

Kernel opens each child relative to the already admitted parent handle through the broker's pinned `NtCreateFile` wrapper with `OBJECT_ATTRIBUTES.RootDirectory=parent`, exact single-component name, `FILE_READ_ATTRIBUTES|SYNCHRONIZE`, share read/write/delete and `FILE_OPEN_REPARSE_POINT|FILE_OPEN_FOR_BACKUP_INTENT|FILE_SYNCHRONOUS_IO_NONALERT`; it never reconstructs/reopens a full path or follows a child reparse point. Status/options outside the compiled wrapper table fail the broker request. Enumeration is pinned to `GetFileInformationByHandleEx(FileIdExtdDirectoryInfo/FileIdExtdDirectoryRestartInfo)` and `FILE_ID_EXTD_DIR_INFO`; first request alone uses Restart, all later requests continue the same iterator, and each admitted directory receives exactly one iterator until exhaustion. Only its long `FileName` is an entry name. `FILE_ID_BOTH_DIR_INFO`, Win32 find APIs, ambient current directory, wildcard expansion, short-name enumeration and a restart after the first batch are forbidden. Root and child reparse state is rechecked from handles before traversal/length admission. For a not-yet-existing write target a future effect profile binds parent handle identity and exact normalized leaf separately.

Informative platform anchors for review: Microsoft documents the long-name/128-bit-ID fields of [`FILE_ID_EXTD_DIR_INFO`](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-file_id_extd_dir_information), the distinct short-name fields of [`FILE_ID_BOTH_DIR_INFO`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_both_dir_info), drive classification in [`GetDriveTypeW`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getdrivetypew), DOS-device mapping in [`QueryDosDeviceW`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-querydosdevicew), the closed [`STORAGE_BUS_TYPE`](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ne-winioctl-storage_bus_type) literals, and handle reparse attributes/tags in [`FILE_ATTRIBUTE_TAG_INFO`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_attribute_tag_info). These links support the API choice; generated support-profile fixtures remain the conformance authority.

Protected-zone policy runs inside the Kernel path gate **before capability dispatch** and is checked again on every child handle before descent. A walker may see a directory entry only inside the trusted Kernel boundary; it MUST NOT emit/log its name/path/identity and MUST NOT enumerate descendants when the handle matches a protected identity. Public output uses only generic `policy-restricted` exclusion, never a label that reveals Monarch Safe exists. Production Safe itself is outside schema-lab roots and is never used to validate this rule.

---

## 3. Идентификаторы

Идентификаторы opaque, stable и не содержат user content.

```ts
type CoreOpaqueIdKindV1 =
  | 'store-generation' | 'content-object'
  | 'client-request' | 'conversation' | 'message' | 'correlation'
  | 'command' | 'event' | 'commit' | 'interaction' | 'execution'
  | 'admission' | 'candidate' | 'follow-up-decision' | 'goal-minimum' | 'goal-contract'
  | 'invocation' | 'receipt' | 'dispatch-attempt' | 'evidence'
  | 'completion-request' | 'certificate' | 'trace';

interface ProtocolIdFieldEndpointV1 {
  schemaId: string;       // exact §0.1 schema ID
  variantId?: string;     // required for every union branch
  path: Array<
    | { kind: 'property'; name: string }
    | { kind: 'each-array-item' }
  >;                      // exact instance path; no string wildcard
}

type ProtocolIdFieldClassificationV1 =
  | { kind: 'opaque-random'; opaqueKind: CoreOpaqueIdKindV1 }
  | { kind: 'reference'; ownerRuleId: string }
  | { kind: 'reference-union'; ownerRuleIds: string[] }
  | { kind: 'semantic'; rule: 'closed-literal' | 'schema-rule-identifier' |
      'protocol-rule-identifier' }
  | { kind: 'semantic'; rule: 'pinned-contract-member' | 'ordinal-derived';
      profileId: string }
  | { kind: 'authenticated-external'; profile: 'ascii-opaque-token-1-to-128.v1' };

type ProtocolSemanticIdProfileV1 =
  | {
      profileId: string;
      kind: 'pinned-contract-member';
      ownerSchemaId: string;
      ownerPath: ProtocolIdFieldEndpointV1['path'];
      members: string[];
    }
  | {
      profileId: 'semantic-id.clause-ordinal.v1';
      kind: 'ordinal-derived';
      ordinalSource: 'nearest-containing-array-index';
      minimumOrdinal: 0;
      maximumOrdinal: 99999;
      numericEncoding: 'canonical-unsigned-decimal';
      prefix: 'clause.';
      suffix: '.v1';
      valuePattern: '^clause\\.(0|[1-9][0-9]{0,4})\\.v1$';
    };

interface ProtocolIdFieldRuleV1 {
  ruleId: string;
  endpoint: ProtocolIdFieldEndpointV1;
  classification: ProtocolIdFieldClassificationV1;
}

interface OpaqueIdKindRuleV1 {
  kind: CoreOpaqueIdKindV1;
  prefix: string;
  generationOwner: 'application-store' | 'client-adapter' | 'content-store';
}

interface OpaqueIdProfileV1 {
  schemaVersion: 'monarch.opaque-id-profile.v1';
  id: 'agent-core-read-opaque-ids.v1';
  bodyRegex: '^[0-7][0-9a-hjkmnp-tv-z]{25}$';
  encoding: 'crockford-base32-lower-no-ambiguous';
  entropySource: 'os-csprng';
  randomBits: 128;
  maximumUtf8Bytes: 64;
  kinds: OpaqueIdKindRuleV1[];
  semanticIdProfiles: ProtocolSemanticIdProfileV1[];
  idFieldRules: ProtocolIdFieldRuleV1[];
}
```

`ascii-opaque-token-1-to-128.v1` is exact `^[!-~]{1,128}$`: 1..128 printable ASCII bytes, excluding space, DEL, controls and every non-ASCII code point. No trimming, Unicode normalization, case folding or replacement is permitted. A generated endpoint classified `authenticated-external` must carry this exact structural pattern; a wider `string` or a token accepted only by application prose fails ID-map compilation.

Internal matcher, binding-program and digest-rule identifiers are not authenticated external input. Their semantic rule is `protocol-rule-identifier`, with exact pattern `^(binding-program|digest-rule|matcher)\.[a-z0-9][a-z0-9.-]{0,111}\.v[12]$`; the compiler and independent endpoint oracle require the same closed pattern. Treating one of these fields as printable opaque text, allowing an unknown namespace/version, or relabelling it as `authenticated-external` fails before schema emission.

The core semantic-ID registry has exactly five sorted profiles and is itself generated into both the ID-map candidate and protocol registry. `semantic-id.claim-template-member.v1` is the exact 28-row §9.4 claim-template ID set owned by `AgentCapabilityContractV1.claimTemplates[].id`; `semantic-id.selector-member.v1` is the exact one-to-one `selector.<claim-template-id>.v1` set owned by `ClaimTemplateV1.claim.selector.id`; `semantic-id.requirement-member.v1` is the singleton `storage.audit.requirement.v1` owned by `AgentCapabilityContractV1.requirementId`; `semantic-id.presentation-template-member.v1` is the six-member set `presentation.storage.audit.<en|ru>.<blocked|partial|verified>.v1` owned by the corresponding `PresentationContractV1.templates[].templateId`; and `semantic-id.clause-ordinal.v1` derives `clause.<canonical-unsigned-decimal-array-index>.v1` from the nearest containing array index, bounded by the pre-profile `maxTotalArrayItems=100000` ceiling. A pinned-member schema endpoint is exact `const`/sorted `enum` equality to its complete profile set, never a subset or regex. An ordinal endpoint must be the direct ID property of an array item and use the exact profile pattern; a leading zero, owner-path substitution, member reorder/add/remove, profile substitution or looser decimal regex fails compilation. Cross-body equality and exact owner membership still require the later finite projection/binding programs: the profile substrate does not pretend an unmaterialized owner schema is already runtime-verified.

The exact core random-kind registry is fixed; an artifact may choose bytes, never another prefix/owner:

| Kind | Exact prefix | Generation owner |
|---|---|---|
| `store-generation` | `storegen_` | content-store |
| `content-object` | `object_` | content-store |
| `client-request` | `request_` | client-adapter |
| `conversation` | `conversation_` | client-adapter |
| `message` | `message_` | client-adapter |
| `correlation` | `correlation_` | client-adapter |
| `command` | `cmd_` | application-store |
| `event` | `evt_` | application-store |
| `commit` | `commit_` | application-store |
| `interaction` | `turn_` | application-store |
| `execution` | `task_` | application-store |
| `admission` | `admission_` | application-store |
| `candidate` | `candidate_` | application-store |
| `follow-up-decision` | `followup_` | application-store |
| `goal-minimum` | `goalmin_` | application-store |
| `goal-contract` | `goal_` | application-store |
| `invocation` | `invocation_` | application-store |
| `receipt` | `receipt_` | application-store |
| `dispatch-attempt` | `attempt_` | application-store |
| `evidence` | `evidence_` | application-store |
| `completion-request` | `completion_` | application-store |
| `certificate` | `certificate_` | application-store |
| `trace` | `trace_` | application-store |

`manifest.opaqueIdProfileRef` resolves this exact retained profile before final schema compilation. Its `idFieldRules` is a canonical set by `(schemaId,variantId-or-empty,path segments)` and is the exhaustive application map, not documentation examples. Canonical endpoint ordering compares `schemaId`, then complete `variantId` or empty, then the slash-joined segment encoding where a property is `property:<exact ASCII field name>` and an array item is the literal `each-array-item`; no length-prefix, locale collation or decoded wildcard is allowed. After every exact `oneOf` branch and `$ref` is expanded, the package generator emits reachable concrete endpoints for every instance field named `id`, ending in `Id`/`Ids`, or explicitly carrying the source-only `idEndpoint: true`; an exact empty ID array emits no item endpoint. It then compares that independently enumerated endpoint set to the profile set. Each reachable endpoint MUST occur in exactly one rule as random, reference, finite reference-union, finite reference-set, semantic or authenticated-external; a missing/duplicate/dangling endpoint, an owner that does not terminate at one exact random rule, a reference cycle, a semantic field using the random regex, or a random/reference field emitted as unconstrained `string` fails compilation. A `reference-union` contains `2..256` strictly sorted unique owner rule IDs, every owner chain terminates at one retained random owner, and the terminals must span at least two opaque kinds. Its scalar schema pattern must equal the compiler-derived canonical union of those exact sorted prefixes plus the common 128-bit body; a redundant same-kind list, manual wider regex, union-as-owner, dangling/cyclic chain or unsorted list fails. It is used only when one wire field can lawfully reference multiple opaque kinds, notably event `causationId`. A `reference-set` also contains `2..256` sorted unique owner rules terminating at random owners, but all terminals must have exactly one opaque kind and the endpoint must retain that kind's single exact scalar pattern; it represents a finite set of mutually exclusive same-kind owners, not a wider wire domain. Mixed-kind sets, singleton sets, set-as-owner, cycles, reorder or regex widening fail closed. Ordinary repeated IDs remain single-owner `reference`. Array items use the explicit `each-array-item` segment; a prose `*`, field-name heuristic at runtime or branch-implicit rule is invalid. ID ownership uniqueness is evaluated per concrete `(schema, full variant route, path)`: the same store-issued field in mutually exclusive `ImmutableContentRefV1` branches is an owning random endpoint in each branch, not a reference to an endpoint that cannot coexist in that instance. This paragraph is deliberately not a substitute for the map: schema-lab readiness requires the generated, diffable profile instance containing every concrete schema/variant/path row and its retained content digest. Until that artifact exists and passes the independent set comparison, ID closure remains an artifact gate rather than a prose claim.

At minimum the exact map expands all submit/follow-up client/accepted command IDs; immutable-content store/object IDs; dedupe/receipt IDs; every common envelope ID in all 40 event and commit-body variants; every ID-bearing event payload; Admission/candidate/follow-up-decision IDs; Goal minimum/contract and their references; Invocation/transition/receipt/dispatch-attempt IDs; Evidence node/snapshot/selection IDs; Completion request/assessment/certificate/view/result IDs; and ProtocolError trace ID. `causationId` is a reference union to an existing command/event rule, `stream.id` is a reference to the branch's Interaction/Execution rule, and repeated IDs are `reference` rules to their unique owning random rule. Clause/requirement/claim/selector/template/capability/matcher/projector/schema/variant/rule/guard/profile IDs are semantic and must satisfy their closed literal or pinned-contract rule; boot/origin/auth/principal/provider-supplied tokens are authenticated-external only where their exact core schema permits them. Thus `CompletionRequestV1.requestId`, Admission/candidate/follow-up-decision IDs and every other application identity cannot remain a bare string merely because a TypeScript review fragment says `string`.

For an `opaque-random` field, wire value is exactly the registered prefix plus `bodyRegex`. The 26-character/130-bit container has two zero leading padding bits, so the first body digit is limited to `0..7`; `8..z` is rejected rather than truncated. The full value is ASCII and at most 64 bytes. Client не выводит identity or ordering from it. Generation uses the named trusted owner and OS CSPRNG; uniqueness is inside the fixed installation generation. Collision returns `id-collision` and generates no event; idempotent retry returns the original ID. Legacy IDs remain opaque compatibility values and never enter a new core digest without an explicit tagged legacy-ID schema.

---

## 4. Public input и accepted command envelope

```ts
interface AgentClientCommandInputV1<TType extends string, TPayload> {
  schemaVersion: 'monarch.agent-client-command.v1';
  clientRequestId: string;
  type: TType;
  payloadVersion: SafeCounterV1;
  target?: { interactionId?: string; executionId?: string };
  expectedRevision?: SafeCounterV1;
  requestedPrivacyMode?: 'persistent' | 'incognito' | 'encrypted';
  correlationId?: string;
  payload: TPayload;
}

interface AcceptedCommandContextV1 {
  schemaVersion: 'monarch.accepted-command-context.v1';
  principalRef: string;
  authContextEpoch: string;
  surface: 'desktop' | 'voice' | 'telegram' | 'api' | 'coder' | 'system';
  privacy: {
    mode: 'persistent';
  };
  presentationLocale: 'ru' | 'en';
  authorityScopeRef: ImmutableContentRefV1;
  authorityScopeDigest: DigestV1;
  runtimeFeatureSetRef: ImmutableContentRefV1;
  runtimeFeatureSetDigest: DigestV1;
  providerGrantIds: [];
}

interface AgentAcceptedCommandEnvelopeV1<TType extends string, TPayload> {
  schemaVersion: 'monarch.agent-command.v1';
  commandId: string;
  type: TType;
  payloadVersion: SafeCounterV1;
  target: {
    interactionId?: string;
    executionId?: string;
  };
  expectedRevision?: SafeCounterV1;
  clientRequestId: string;
  acceptedContext: AcceptedCommandContextV1;
  correlationId: string;
  causationId?: string;
  createdAt: string;
  payload: TPayload;
}

interface CommandFingerprintBodyV1 {
  schemaVersion: 'monarch.command-fingerprint-body.v1';
  type: string;
  payloadVersion: SafeCounterV1;
  target: { interactionId?: string; executionId?: string };
  expectedRevision?: SafeCounterV1;
  clientRequestId: string;
  acceptedContextDigest: DigestV1;
  authContextEpoch: string;
  orderedAttachmentRefs: [];
  payload: JsonValue;
}
```

In `agent-core-read.v1`, `principalRef` and `authContextEpoch` are exact `authenticated-external` scalar endpoints under `ascii-opaque-token-1-to-128.v1`; both are authenticated before this context is constructed and neither is normalized by Core. `authorityScopeRef` and `runtimeFeatureSetRef` are exact `ImmutableContentRefV1.instance` branches; their schema/body/digest equality remains an explicit binding-program obligation rather than an ambient lookup. `providerGrantIds` is the exact empty canonical set (`minItems=0,maxItems=0`), not an optional provider lane. Because no item can exist, it has no ID-field-map endpoint in this profile. Widening the bound exposes a new endpoint and fails the package before codegen unless a separately versioned provider profile supplies its schema, classification, consent and egress rules.

For the core manifest, none of the three generic review helpers above is emitted as an open ABI. Generated `monarch.agent-client-command.v1` and `monarch.agent-command.v1` are exact closed `oneOf` schemas of only `interaction.submit` + `InteractionSubmitPayloadV1` and `interaction.follow-up` + `InteractionFollowUpPayloadV1`, with `payloadVersion=1` and `additionalProperties=false` at every object. Both payloads and the fingerprint projection require the exact empty attachment tuple. A non-empty attachment array is `feature-unavailable` before an accepted command, receipt, Interaction or content retention is created; attachment semantics require a future versioned capability input. The accepted branch additionally fixes privacy to `persistent` and provider grants to empty. Generated `monarch.command-fingerprint-body.v1` is the exact branch projection of that accepted command/context: its `type`, payload version, target/CAS shape, empty attachments and payload use the same closed branch schema rather than `string`/`JsonValue`. Submit forbids outer target/expected revision. Follow-up requires exactly outer `target.interactionId + expectedRevision`, forbids outer execution target, and any payload `targetExecutionId` is only a semantic candidate inside that Interaction. The exact two public client branches also forbid both generic `correlationId` and `causationId`: neither is part of the command fingerprint, so accepting either from an untrusted caller would create an unfenced trace-link input. After authentication and dedupe reservation, the trusted client-adapter allocates the accepted submit `correlationId` once; accepted follow-up copies the already retained target-Interaction root correlation and never allocates or accepts another. Accepted core commands forbid `causationId`; causation starts on the first persisted Event with that retained command ID. Every other command/profile returns `feature-unavailable` before aggregate lookup.

Public adapter authenticates transport, authorizes requested privacy and derives `AcceptedCommandContext`; it does **not** parse message prose to discover an operational target. The accepted `AuthorityScopeV1` body/ref/digest comes only from server-attested session/workspace grants already bound to that surface/principal and may list the exact pre-authorized workspace roots. Later the one matcher supplies a target source range and the pinned target resolver proves that resolved handle identity is an exact admitted scope member; missing membership blocks. This ordering prevents ingress from becoming a second target parser. Before acceptance the adapter also validates and pins the exact `RuntimeFeatureSetV1` ref/digest; that set in turn pins the sole core capability contract, matcher, policies, recipe, presentation suite, Completion Certifier contract and its terminal policy. Admission, Goal and Assessment must repeat that historical chain and may not read current flags/manifest/contract registry. Thus a crash or package upgrade between `interaction.accepted`, intent sealing and assessment cannot change matcher, eligibility or verdict policy for the already accepted fingerprint. The adapter freezes the accepted `presentationLocale`, creates server command ID and hashes exact `CommandFingerprintBodyV1` under domain `command-fingerprint`. Locale is admitted from the authenticated surface preference with an explicit `ru|en` fallback before persistence; Presentation never reads mutable OS/UI locale later. `acceptedContextDigest` is the domain `accepted-command-context` digest of the exact inline `AcceptedCommandContextV1`; every later repeated value MUST recompute to it. `principalRef + authContextEpoch + surface` are the closed core transport binding; no unlisted transport-attestation body is hidden behind a digest. Attachment order is the persisted user order. Omitted optional fields remain omitted and are never defaulted differently by a retry. `createdAt` — server observability field, не ordering authority. In another auth/source epoch the old authority cannot be reused: same stable principal/client ID may only obtain the prior receipt by exact original-command retry; new work requires a new client ID and fresh admission. Same client ID with changed body/context/locale/feature set is conflict, never an implicit second command.

`system` surface доступна только a statically registered Application port object created by the process composition root; serializing `surface='system'` never creates that object. Desktop/Voice/Telegram/API/Coder adapters each bind an authenticated adapter instance, OS/process/session attestation and allowed surface set. This is consistency under the trusted writer profile, not a sandbox against compromised in-process code. Incognito доступен только authenticated Desktop-owner lane; API cannot self-select it. In the core manifest any explicit `requestedPrivacyMode='incognito'|'encrypted'` is rejected as `feature-unavailable` at the public adapter before accepted-command construction, dedupe retention, receipt or Interaction creation. Omitted/`persistent` alone may proceed. Existing answer adapters stay outside this profile and cannot smuggle a non-persistent request into Astra core.

---

## 5. Common event envelope

```ts
interface AgentDomainEventV1<TType extends string, TPayload> {
  schemaVersion: 'monarch.agent-event.v1';
  eventId: string;
  stream: {
    kind: 'interaction' | 'execution' | 'job';
    id: 'workspace.storage.audit.verification-recipe.v1';
  };
  sequence: SafeCounterV1;
  revision: SafeCounterV1;
  commitId: string;
  commitDigest: DigestV1;
  commitIndex: SafeCounterV1;
  commitSize: SafeCounterV1;
  type: TType;
  payloadVersion: SafeCounterV1;
  commandId?: string;
  causationId?: string;
  correlationId: string;
  activation?: {
    id: string;
    generation: SafeCounterV1;
  };
  producer: 'application' | 'interaction' | 'scheduler' | 'runtime-host' | 'workflow'
    | 'invocation' | 'kernel' | 'evidence' | 'certifier' | 'presentation' | 'migration';
  occurredAt: string;
  payloadDigest: DigestV1;
  payload: TPayload;
}

interface CommitEventDigestBodyV1<TPayload> {
  schemaVersion: 'monarch.commit-event-digest-body.v1';
  eventId: string;
  stream: AgentDomainEventV1<string, TPayload>['stream'];
  sequence: SafeCounterV1;
  revision: SafeCounterV1;
  commitId: string;
  commitIndex: SafeCounterV1;
  commitSize: SafeCounterV1;
  type: string;
  payloadVersion: SafeCounterV1;
  commandId?: string;
  causationId?: string;
  correlationId: string;
  activation?: { id: string; generation: SafeCounterV1 };
  producer: AgentDomainEventV1<string, TPayload>['producer'];
  occurredAt: string;
  payloadDigest: DigestV1;
  payload: TPayload;
}

interface CommitGroupDigestBodyV1<TClosedCommitEventBody> {
  schemaVersion: 'monarch.commit-group-digest-body.v1';
  events: TClosedCommitEventBody[]; // generated schema: minItems=1, maxItems=TransportLimitProfileV1.maxCommitEvents
}

interface EventEnvelopeOwnerGrammarV1 {
  schemaVersion: 'monarch.event-envelope-owner-grammar.v1';
  causationOwnerOpaqueKinds: ['command', 'event'];
  commitIdOwner: 'first-event';
  commandIdOwnerMode: 'shape-retained-or-first-event';
  eventVariantIds: string[]; // exact sorted 40-variant set
  commitShapes: CommitShapeV1[]; // exact sorted 30-shape set below
}

interface CertifiedExecutionTerminalPayloadV1 {
  executionId: string;
  certificateId: string;
  certificateEnvelopeDigest: DigestV1;
  verdict: 'verified' | 'partial' | 'blocked';
}

type CoreGoalBlockReasonCodeV1 =
  | 'admission-ambiguous' | 'target-required' | 'temporal-intent-required'
  | 'capability-unavailable' | 'authority-scope-empty'
  | 'manifest-invalid' | 'goal-minimum-mismatch';

type CoreExecutionBlockReasonCodeV1 = CoreGoalBlockReasonCodeV1
  | 'policy-denied' | 'budget-exceeded';

interface AgentCoreEventPayloadMapV1 {
  'interaction.accepted': {
    interactionId: string; acceptedCommandId: string; acceptedCommandRef: ImmutableContentRefV1;
    acceptedCommandDigest: DigestV1; dedupeRecordRef: ImmutableContentRefV1;
    dedupeRecordDigest: DigestV1; commandReceiptRef: ImmutableContentRefV1;
    commandReceiptDigest: DigestV1;
  };
  'interaction.follow-up-accepted': {
    interactionId: string; acceptedCommandId: string; acceptedCommandRef: ImmutableContentRefV1;
    acceptedCommandDigest: DigestV1; dedupeRecordRef: ImmutableContentRefV1;
    dedupeRecordDigest: DigestV1; commandReceiptRef: ImmutableContentRefV1;
    commandReceiptDigest: DigestV1;
    messageId: string;
  };
  'interaction.intent-admitted': {
    interactionId: string; admissionId: string; admissionRef: ImmutableContentRefV1;
    admissionBodyDigest: DigestV1; candidateSetDigest: DigestV1;
  };
  'interaction.follow-up-intent-admitted': {
    interactionId: string; admissionId: string; admissionRef: ImmutableContentRefV1;
    admissionBodyDigest: DigestV1; previousAdmissionId: string;
    previousAdmissionRef: ImmutableContentRefV1; previousAdmissionBodyDigest: DigestV1;
  };
  'interaction.follow-up-dispositioned': {
    interactionId: string; decisionId: string; decisionRef: ImmutableContentRefV1;
    decisionBodyDigest: DigestV1;
  };
  'interaction.routed': {
    interactionId: string; aggregateRoute: InteractionIntentAdmissionV1['aggregateRoute'];
    candidateSetDigest: DigestV1; cohortDecision: InteractionIntentAdmissionV1['cohortDecision'];
  };
  'execution.created': {
    executionId: string; interactionId: string; admissionId: string;
    admissionRef: ImmutableContentRefV1; admissionBodyDigest: DigestV1;
    runtimeProfile: 'agent-core-read.v1'; runtimeFeatureSetRef: ImmutableContentRefV1;
    runtimeFeatureSetDigest: DigestV1;
  };
  'goal.compilation-requested': {
    executionId: string; admissionId: string; admissionBodyDigest: DigestV1;
    matcherRef: ImmutableContentRefV1; matcherBodyDigest: DigestV1;
    matcherImplementationHash: ImplementationHashV1;
  };
  'goal.contract-admitted': {
    executionId: string; goalContractId: string; goalRevision: 1;
    goalContractRef: ImmutableContentRefV1; goalContractDigest: DigestV1;
    deterministicMinimumDigest: DigestV1;
    admissionBindingRef: ImmutableContentRefV1; admissionBindingDigest: DigestV1;
    semanticBodyRef: ImmutableContentRefV1; semanticBodyDigest: DigestV1;
  };
  'goal.blocked': {
    executionId: string; reasonCode: CoreGoalBlockReasonCodeV1;
    admissionBodyDigest: DigestV1;
  };
  'invocation.prepared': Extract<InvocationTransitionPayloadV1, { to: 'prepared' }>;
  'invocation.authorized': Extract<InvocationTransitionPayloadV1, { to: 'authorized' }>;
  'invocation.dispatched': Extract<InvocationTransitionPayloadV1, { to: 'dispatched' }>;
  'invocation.observed': Extract<InvocationTransitionPayloadV1, { to: 'observed' }>;
  'invocation.output-checked': Extract<InvocationTransitionPayloadV1, { to: 'output-checked' }>;
  'invocation.output-rejected': Extract<InvocationTransitionPayloadV1, { to: 'output-rejected' }>;
  'invocation.settled': Extract<InvocationTransitionPayloadV1, { to: 'settled' }>;
  'invocation.rejected': Extract<InvocationTransitionPayloadV1, { to: 'rejected' }>;
  'invocation.cancelled-before-dispatch': Extract<InvocationTransitionPayloadV1, { to: 'cancelled-before-dispatch' }>;
  'invocation.cancelled': Extract<InvocationTransitionPayloadV1, { to: 'cancelled' }>;
  'invocation.failed': Extract<InvocationTransitionPayloadV1, { to: 'failed' }>;
  'invocation.indeterminate': Extract<InvocationTransitionPayloadV1, { to: 'indeterminate' }>;
  'invocation.receipt-linked': {
    executionId: string; invocationId: string;
    receiptRef: ImmutableContentRefV1; receiptDigest: DigestV1;
  };
  'evidence.projected': {
    executionId: string; evidenceNodeId: string; evidenceNodeRef: ImmutableContentRefV1;
    evidenceNodeBodyDigest: DigestV1;
  };
  'completion.requested': {
    executionId: string; completionRequest: CompletionRequestV1;
    assessmentInputRef: ImmutableContentRefV1;
    assessmentInputDigest: DigestV1;
  };
  'completion.certified': {
    executionId: string; certificateId: string; certificationKey: DigestV1;
    certificateRef: ImmutableContentRefV1; certificateEnvelopeDigest: DigestV1;
    assessmentBodyDigest: DigestV1; verdict: 'verified' | 'partial' | 'blocked';
  };
  'execution.completed': CertifiedExecutionTerminalPayloadV1 & { verdict: 'verified' };
  'execution.partial': CertifiedExecutionTerminalPayloadV1 & { verdict: 'partial' };
  'execution.blocked':
    | (CertifiedExecutionTerminalPayloadV1 & { verdict: 'blocked' })
    | { executionId: string; verdict: 'blocked'; reasonCode: CoreExecutionBlockReasonCodeV1;
        certificateId?: never };
  'execution.failed':
    | { executionId: string;
        reasonCode: 'kernel-failed' | 'output-schema-rejected' | 'evidence-integrity-invalid';
        invocationRef: ImmutableContentRefV1; invocationBodyDigest: DigestV1;
        receiptRef: ImmutableContentRefV1; receiptDigest: DigestV1;
        diagnosticRef?: ImmutableContentRefV1; diagnosticDigest?: DigestV1 }
    | { executionId: string; reasonCode: 'assessment-input-invalid';
        invocationRef: ImmutableContentRefV1; invocationBodyDigest: DigestV1;
        receiptRef?: never; receiptDigest?: never;
        diagnosticRef?: ImmutableContentRefV1; diagnosticDigest?: DigestV1 }
    | { executionId: string; reasonCode: 'internal-error';
        invocationRef?: never; invocationBodyDigest?: never;
        receiptRef?: never; receiptDigest?: never;
        diagnosticRef?: ImmutableContentRefV1; diagnosticDigest?: DigestV1 };
  'execution.cancelled':
    | { executionId: string; reasonCode: 'cancelled-before-dispatch';
        invocationRef: ImmutableContentRefV1; invocationBodyDigest: DigestV1;
        receiptRef?: never; receiptDigest?: never }
    | { executionId: string; reasonCode: 'kernel-confirmed-cancelled';
        invocationRef: ImmutableContentRefV1; invocationBodyDigest: DigestV1;
        receiptRef: ImmutableContentRefV1; receiptDigest: DigestV1 };
  'presentation.completed': {
    executionId: string; evidenceViewRef: ImmutableContentRefV1;
    evidenceViewBodyDigest: DigestV1; structuredResultRef: ImmutableContentRefV1;
    structuredResultBodyDigest: DigestV1;
  };
}

type CoreEventProducerV1<K extends keyof AgentCoreEventPayloadMapV1> =
  K extends `interaction.${string}` ? 'application' :
  K extends 'execution.created' | `goal.${string}` | 'completion.requested'
    | 'completion.certified' | `execution.${string}` ? 'application' :
  K extends 'invocation.receipt-linked' ? 'kernel' :
  K extends `invocation.${string}` ? 'invocation' :
  K extends 'evidence.projected' ? 'evidence' :
  K extends 'presentation.completed' ? 'presentation' : never;

type CoreEventStreamKindV1<K extends keyof AgentCoreEventPayloadMapV1> =
  K extends `interaction.${string}` ? 'interaction' : 'execution';

type AgentCoreDomainEventV1 = {
  [K in keyof AgentCoreEventPayloadMapV1]:
    Omit<AgentDomainEventV1<K, AgentCoreEventPayloadMapV1[K]>,
      'activation' | 'producer' | 'stream' | 'payloadVersion' | 'payload' | 'commandId' | 'causationId'> & {
        activation?: never;
        causationId: string;
        commandId: string;
        producer: CoreEventProducerV1<K>;
        stream: { kind: CoreEventStreamKindV1<K>; id: string };
        payloadVersion: 1;
        payload: AgentCoreEventPayloadMapV1[K];
      }
}[keyof AgentCoreEventPayloadMapV1];
```

Generated `monarch.agent-event.v1` is the closed `oneOf` represented by `AgentCoreDomainEventV1`: exact `type`, exact producer owner, required internal/public `commandId`, `payloadVersion=1` and the corresponding closed payload. Every state-changing core commit is submitted through one idempotent appender command; an asynchronous receipt/projector/presentation fact therefore has a server-generated internal command ID rather than an absent owner. The later vocabulary lists are reserved names, not permissive payload schemas. If a trace needs another event, the core manifest/schema revision must change first.

Generated `monarch.commit-event-digest-body.v1` is a second mechanically projected closed `oneOf` over those same variants with only the envelope's `/commitDigest` absent. Generated `monarch.commit-group-digest-body.v1` is the closed non-empty ordered array wrapper over that exact oneOf; the generic helpers are never emitted with `type:string`, generic producer/stream, unknown body or arbitrary payload. Event-schema and commit-body branch IDs are identical, and a generator parity lint rejects any field/requiredness/variant difference other than the one omitted digest. Group validation requires one stream/revision/commandId/commitId/commitSize, unique contiguous sequences and exact `commitIndex=0..size-1` before hashing.

| Core event types | Required `producer` |
|---|---|
| `interaction.*`, `execution.created`, `goal.*`, `completion.requested` | `application` |
| every `invocation.<lifecycle-state>` event | `invocation` |
| `invocation.receipt-linked` | `kernel` |
| `evidence.projected` | `evidence` |
| `completion.certified` | `application` (atomic store commit of the Certifier-produced assessment) |
| certified `execution.completed|partial|blocked` | `application` in the same commit immediately after certification |
| noncertified `execution.blocked|failed|cancelled` | `application`, with typed reason/receipt and no certificate ID |
| `presentation.completed` | `presentation` |

The generated event `oneOf` also fixes stream ownership: every `interaction.*` event has `stream.kind='interaction'` and `stream.id=payload.interactionId`; every other core event has `stream.kind='execution'` and `stream.id=payload.executionId`. `stream.kind='job'` has no core variant. A payload ID/stream mismatch is schema/admission failure, not a cross-stream link.

`execution.created.payload.interactionId` is the sole core owner of the Interaction↔Execution relationship. Follow-up target validation resolves that retained event and requires exact Interaction equality; any Interaction-side execution list/index in a fixture is a replay-derived non-authority view. A future product materialization may copy the relationship only through its versioned outbox/inbox contract and receiver-owned projection; it cannot create a second writable link truth.

`execution.failed` requires every optional diagnostic ref/digest pair together or neither. `kernel-failed` cites a failed receipt; `output-schema-rejected` cites the completed receipt whose output failed schema/binding admission; `evidence-integrity-invalid` cites the completed receipt whose internally contradictory output/proof prevented an EvidenceNode. `assessment-input-invalid` is a pre-freeze failure from `running` and MUST cite the exact already settled Invocation snapshot, so it cannot terminate around an active/unknown dispatch. `internal-error` exists only from `certifying` after a retained request when the pinned pure certifier cannot produce a valid assessment; it forbids Invocation/receipt/certificate fields and cannot be relabelled blocked/verified. Invocation `settled` means only that the invoked port reached a known completed output; it does not certify evidence integrity. Therefore a later Execution failure for assessment-input or evidence-integrity invalidity is consistent and never rewrites the immutable Invocation snapshot. Any post-dispatch path without an admitted known receipt is only `invocation.indeterminate` and cannot terminalize Execution. Presentation failure is post-terminal and never rewrites immutable Execution to failed. `execution.cancelled(cancelled-before-dispatch)` forbids a receipt, while `kernel-confirmed-cancelled` requires the exact cancelled Kernel receipt. The generated schema encodes these as closed `oneOf` branches. Free-form transition/result codes are not admitted merely because the explanatory extension sections use `string`.

Core Invocation terminal facts cannot strand a hidden `running` Execution. The manifest commit rules require these exact ordered suffixes in one atomic commit:

| Invocation fact | Required following Execution fact |
|---|---|
| `invocation.rejected(policy-denied|budget-exceeded|authority-scope-empty|manifest-invalid)` | matching noncertified `execution.blocked` reason |
| `invocation.cancelled-before-dispatch` | noncertified `execution.cancelled(cancelled-before-dispatch)`, receipt forbidden |
| `invocation.failed` | noncertified `execution.failed(kernel-failed)` with the same failed receipt |
| `invocation.output-rejected` | noncertified `execution.failed(output-schema-rejected)` with the same completed receipt |
| `invocation.cancelled` | noncertified `execution.cancelled(kernel-confirmed-cancelled)` with the same cancelled receipt |

`invocation.indeterminate` is deliberately the sole exception: it retains the exact unknown receipt and leaves the schema-lab Execution nonterminal/unsuccessful. The pure simulator returns an explicit unresolved-trace result; no certificate/presentation follows. A product cohort may not import this profile until a separately generated recovery state/event/store profile gives that state a durable owner and finite user-visible handling. Omitting either member of a required suffix, changing the receipt/reason, or inserting another event between them invalidates the whole commit.

The schema-lab has no `queued` Execution state at all. A successful `goal.contract-admitted` is a `preparing → preparing` fact immediately followed by the one `invocation.prepared` `preparing → running` event in the same complete commit under `commit.goal-admit-and-prepare.v1`. If the direct host cannot construct the exact Invocation, neither event is committed; the trace returns a typed pre-commit protocol failure and retains no admitted Goal. A future product profile may introduce a durable queue only with a new state/schema version, liveness owner, deadline, terminal failure outcome and recovery fixtures.

The schema-lab in-memory aggregate fixture is the single appender/allocator for these traces; no product backend is selected by this statement. Components named in `producer` submit facts/commands; they do not choose `sequence/revision/eventId`. An absent aggregate has virtual `lastSequence=0,lastRevision=0`; its first committed event has `sequence=1`, its first commit has `revision=1`, and no stored event uses sequence/revision zero. Every later commit uses `priorRevision+1`; its events use consecutive `priorSequence+1..+commitSize`, while `commitIndex` is exactly zero-based `0..commitSize-1`. Appender uniqueness key is `(stream.kind, stream.id, commandId)`. For an allowlisted command body (`AgentAcceptedCommandEnvelopeV1` or `CompletionCommitAssessmentV1`) equality is its exact validated content identity. For an internal lifecycle append intent with no separate wire command, equality is the closed ordered tuple `(expectedRevision, variantId, producer, correlationId, causationId-or-absent, exact payload)`; on retry the appender substitutes the first commit's retained allocator-owned envelope fields and recomputes every payload/commit digest, so no generic `JsonValue` or current state is an input. That tuple is fixture-only appender input covered by the later simulator artifact, not a persisted product schema or new authority ref. First use atomically records it with the complete commit; same key/equality returns that exact commit, while same key/different input is corruption and appends nothing. One command ID cannot own two commits in one stream. One accepted command/atomic commit increments `revision` once and may append multiple contiguous events sharing revision/commit ID/digest. `commitDigest` hashes ordered canonical event bodies excluding the digest field. `expectedRevision` compares aggregate revision, not last event count. A “crash” fixture is a deterministic cut/restart over the simulator's explicit retained-state model and proves protocol replay/atomicity only; it is not evidence that an OS process, filesystem buffer or real database survived power loss. A future product store must replace the fixture-only tuple with a generated, reviewed product command schema and prove the same semantics under real process/power-loss fault tests before importing the package.

Every structural event payload branch has one exact generated variant ID. A non-union payload uses its event type; execution terminal unions/verdict branches use `execution.blocked:certified|noncertified`, `execution.failed:<reasonCode>`, `execution.cancelled:<reasonCode>` and `completion.certified:<verdict>`. Each Invocation event already selects exactly one `InvocationTransitionPayloadV1.to` structural branch, so its variant ID is the event type; any enum `reasonCode` inside that branch is checked and cross-bound by its guard/commit rule rather than creating a second implicit payload branch. These literals, not a nested permissive `oneOf`, are used by digest/binding/state/commit endpoints.

The generated manifest contains, at minimum, these exact `execution-core` state-transition rules; event variants are exact schema branches and every guard ID resolves through the closed manifest guard table, never a free-form callback:

| Trigger | From | To | Guard |
|---|---|---|---|
| `execution.created` | absent | `created` | `guard.execution-created-binding.v1` |
| `goal.compilation-requested` | `created` | `preparing` | `guard.goal-compilation-admission-cas.v1` |
| `goal.contract-admitted` | `preparing` | `preparing` | `guard.goal-admission-binding-equality.v1` |
| `invocation.prepared` | `preparing` | `running` | `guard.single-invocation-create.v1` |
| `completion.requested` | `running` | `certifying` | `guard.assessment-fence-freeze.v1` |
| `execution.completed` | `certifying` | `completed` | `guard.verified-certificate-suffix.v1` |
| `execution.partial` | `certifying` | `partial` | `guard.partial-certificate-suffix.v1` |
| `execution.blocked:certified` | `certifying` | `blocked` | `guard.blocked-certificate-suffix.v1` |
| `execution.blocked:noncertified` | `preparing|running` | `blocked` | `guard.noncertified-block-suffix.v1`; immediate same-commit `goal.blocked` prefix from preparing or `invocation.rejected` prefix from running, with exact reason equality |
| `execution.failed:kernel-failed`, `execution.failed:output-schema-rejected`, `execution.failed:evidence-integrity-invalid` | `running` | `failed` | one emitted rule per exact reason with required receipt/Invocation guard |
| `execution.failed:assessment-input-invalid` | `running` | `failed` | `guard.assessment-input-failure-settled-invocation.v1`; exact settled Invocation ref, no active/unknown dispatch |
| `execution.failed:internal-error` | `certifying` | `failed` | `guard.internal-failure-no-invocation-receipt-certificate.v1` |
| each `execution.cancelled:<reasonCode>` | `running` | `cancelled` | one exact pre/post-dispatch receipt guard |

The remaining exact state rules are generated only from this closed expansion table:

| Variant(s) | From → To | Guard ID |
|---|---|---|
| `interaction.accepted` | absent → `accepted` | `guard.interaction-create.v1` |
| `interaction.intent-admitted` | `accepted` → `routing` | `guard.initial-admission.v1` |
| `interaction.routed` | `routing` → `open` | `guard.initial-route.v1` |
| `interaction.follow-up-accepted`, `interaction.follow-up-intent-admitted`, `interaction.follow-up-dispositioned` | `open` → `open` | one rule per listed variant with its exact payload/ref binding guard |
| `goal.blocked` | `preparing` → `preparing` | `guard.goal-block-pending-terminal.v1` |
| `invocation.authorized`, `invocation.dispatched`, `invocation.receipt-linked`, `invocation.observed`, `invocation.output-checked`, `invocation.output-rejected`, `invocation.settled`, `invocation.rejected`, `invocation.cancelled-before-dispatch`, `invocation.cancelled`, `invocation.failed`, `invocation.indeterminate`, `evidence.projected` | `running` → `running` | one rule per listed variant; exact lifecycle/ref/commit guard |
| each `completion.certified:<verdict>` | `certifying` → `certifying` | one rule per verdict branch with matching certificate guard |
| `presentation.completed` | certified `completed|partial|blocked` → same state | `guard.certificate-view-result-projection.v1` |

The grouped rows are finite generator expansion syntax: each comma-separated literal emits its own rule ID and no wildcard. No state/event wildcard exists.

The mandatory commit-invariant expansion is likewise closed:

| Rule family | Trigger | Immediate prefix | Immediate suffix |
|---|---|---|---|
| `commit.receipt-link.<state>.v1` | first receipt-bearing `invocation.observed|failed|cancelled|indeterminate` | `invocation.receipt-linked` | none |
| `commit.goal-admit-and-prepare.v1` | `goal.contract-admitted` | none | exact one `invocation.prepared` bound to the admitted Goal/Execution |
| `commit.goal-block.v1` | `goal.blocked` | none | `execution.blocked:noncertified` with the same Goal reason |
| `commit.invocation-rejected.v1` | `invocation.rejected` | none | `execution.blocked:noncertified` with the same Invocation reason |
| `commit.invocation-cancel-before-dispatch.v1` | `invocation.cancelled-before-dispatch` | none | `execution.cancelled` pre-dispatch branch |
| `commit.invocation-failed.v1` | `invocation.failed` | required receipt-link when first receipt-bearing | `execution.failed` kernel branch |
| `commit.invocation-output-rejected.v1` | `invocation.output-rejected` | none | `execution.failed` output branch |
| `commit.invocation-cancelled.v1` | `invocation.cancelled` | required receipt-link when first receipt-bearing | `execution.cancelled` Kernel-confirmed branch |
| `commit.certificate.<verdict>.v1` | `completion.certified` exact verdict | none | exact `execution.completed|partial|blocked:certified` branch |

Each `<state>`/`<verdict>` family expands only over the literals shown and carries exact receipt/reason/certificate binding rule IDs. `goal.blocked` cannot leave a hidden nonterminal projection, and certificate cannot exist without its matching terminal suffix. These tables plus the closed event union are the sole state/commit generator input.

Guard relation assignment is also closed generator input: `guard.interaction-create.v1` uses `aggregate-create` and must list `accepted-command-receipt.submit.v1`; `interaction.follow-up-accepted` uses `schema-bindings-and-state-cas` and must list `accepted-command-receipt.follow-up.v1`; Execution creation uses `aggregate-create`; `invocation.prepared` uses `single-core-invocation-create` and is also the mandatory suffix of `commit.goal-admit-and-prepare.v1`; every later Invocation lifecycle row uses `invocation-transition-and-snapshot-cas`; `completion.requested` uses `assessment-fence-freeze`; certification and its three terminal suffix rows use `certificate-terminal-suffix`; receipt-link, Goal block, Invocation reject/fail/cancel/output-reject and their noncertified terminal rows use `typed-terminal-suffix`. The noncertified blocked terminal guard accepts only an immediate same-commit `goal.blocked` prefix from preparing or `invocation.rejected` prefix from running and requires exact reason equality; no standalone/queued branch exists. Assessment-input failure uses `schema-bindings-and-state-cas` plus the exact settled-Invocation ref/body equality, while internal failure is certifying-only and proves no Invocation/receipt/certificate field in its branch; `presentation.completed` uses `presentation-projection`; every remaining nonterminal state row uses `schema-bindings-and-state-cas`. A generated guard with another relation or an omitted required binding/commit rule fails manifest lint.

`CommitEventDigestBodyV1` above is exact through its generated closed projection and excludes only `commitDigest`; it does not inherit a mutable envelope implicitly. Appender wraps the ordered projected bodies in the allowlisted `CommitGroupDigestBodyV1`, validates group equalities/indices, and computes its `event-commit` content identity; every actual event in that group repeats the result through the exact 40-variant `event-commit.v1` occurrence rule. Refs are hashed as their canonical ref objects, never dereferenced bytes. Export/rebuild recomputes every complete group in sequence; mismatch stops at the prior valid group. Random IDs/timestamps remain stable retained facts and therefore do not make replay nondeterministic.

The event-envelope owner grammar is finite generator input, not prose guidance. Its canonical JSON SHA-256 is `sha256:0d883c35cacaef141bb0d11f444bd9e118f982c5fe89952e965f6c6bafceb9a5`. `commitId` is allocated only by the first ordered event occurrence in a commit shape; every later occurrence is an exact reference to that owner. `commandId` is allocated by the first event in 25 internal shapes and is an exact reference to one retained command in five ingress/certification shapes. Every core Event requires `causationId`, whose scalar domain is the exact command/event reference union. The first fact in the two accepted-command ingress shapes cites the retained `AgentCommand.commandId` and copies its correlation; the first fact in the other 28 shapes cites an already retained Event and inherits that Event's correlation; all 14 later same-commit occurrences cite the immediately previous occurrence and copy its correlation. The sole correlation root is accepted `interaction.submit`; a follow-up command must copy the target Interaction root correlation instead of allocating a new trace. A branch, owner, order or ambient/fresh correlation absent from this table is invalid.

| Commit shape | Ordered event variants | `commandId` owner |
|---|---|---|
| `completion-certified-blocked` | `completion.certified:blocked` → `execution.blocked:certified` | retained `monarch.completion-commit-assessment.v1@/commandId` |
| `completion-certified-partial` | `completion.certified:partial` → `execution.partial` | retained `monarch.completion-commit-assessment.v1@/commandId` |
| `completion-certified-verified` | `completion.certified:verified` → `execution.completed` | retained `monarch.completion-commit-assessment.v1@/commandId` |
| `completion-requested` | `completion.requested` | first event |
| `evidence-projected` | `evidence.projected` | first event |
| `execution-created` | `execution.created` | first event |
| `execution-failed-assessment-input-invalid` | `execution.failed:assessment-input-invalid` | first event |
| `execution-failed-evidence-integrity-invalid` | `execution.failed:evidence-integrity-invalid` | first event |
| `execution-failed-internal-error` | `execution.failed:internal-error` | first event |
| `goal-blocked` | `goal.blocked` → `execution.blocked:noncertified` | first event |
| `goal-compilation-requested` | `goal.compilation-requested` | first event |
| `goal-contract-admitted` | `goal.contract-admitted` → `invocation.prepared` | first event |
| `interaction-accepted` | `interaction.accepted` | retained `monarch.agent-command.v1[interaction.submit]@/commandId` |
| `interaction-follow-up-accepted` | `interaction.follow-up-accepted` | retained `monarch.agent-command.v1[interaction.follow-up]@/commandId` |
| `interaction-follow-up-dispositioned` | `interaction.follow-up-dispositioned` | first event |
| `interaction-follow-up-intent-admitted` | `interaction.follow-up-intent-admitted` | first event |
| `interaction-intent-admitted` | `interaction.intent-admitted` | first event |
| `interaction-routed` | `interaction.routed` | first event |
| `invocation-authorized` | `invocation.authorized` | first event |
| `invocation-cancelled-before-dispatch` | `invocation.cancelled-before-dispatch` → `execution.cancelled:cancelled-before-dispatch` | first event |
| `invocation-cancelled` | `invocation.receipt-linked` → `invocation.cancelled` → `execution.cancelled:kernel-confirmed-cancelled` | first event |
| `invocation-dispatched` | `invocation.dispatched` | first event |
| `invocation-failed` | `invocation.receipt-linked` → `invocation.failed` → `execution.failed:kernel-failed` | first event |
| `invocation-indeterminate` | `invocation.receipt-linked` → `invocation.indeterminate` | first event |
| `invocation-observed` | `invocation.receipt-linked` → `invocation.observed` | first event |
| `invocation-output-checked` | `invocation.output-checked` | first event |
| `invocation-output-rejected` | `invocation.output-rejected` → `execution.failed:output-schema-rejected` | first event |
| `invocation-rejected` | `invocation.rejected` → `execution.blocked:noncertified` | first event |
| `invocation-settled` | `invocation.settled` | first event |
| `presentation-completed` | `presentation.completed` | first event |

The table contains at most three events per shape. Its occurrence multiset contains each of the 40 variants once except `invocation.receipt-linked` four times and `execution.blocked:noncertified` twice. Compiler and independent Python oracle prove the exact 40↔payload-rule bijection, 30-shape ordering, `25+5` owner split, retained-owner endpoints and pinned canonical digest.

The finite machine source is `eventSchemaSource`, canonical SHA-256 `sha256:7f947dd2d9ea398cac7a0162f16909e1c50367d2ce297e5150af670292e7798a`: 40 sorted variants, 45 structural payload branches, five strict diagnostic absent/present unions and twelve Invocation-transition payloads. It mechanically emits candidate Draft 2020-12 documents with 40 `AgentEventV1` branches and 40 `CommitEventDigestBodyV1` branches. All 40 pairs require causation and are byte-structurally equal after exactly removing `/commitDigest` and replacing `/schemaVersion`; their canonical candidate sizes/hashes are `95847` / `sha256:166524dcd17bb77f268a9878f5a3926d68d3ea1408b0cc0221e9684006f38d95` and `93100` / `sha256:c4b289feaa3eeb0e2b84e68928229f641e220dc61d89c4c9dac9099a0d248239`.

The 30 shapes expand to 44 concrete event occurrences. `event-occurrence-bindings.candidate.json` assigns 30 allocator-owned `commitId` occurrences plus 14 intra-commit references, 25 allocator-owned internal `commandId` occurrences plus 11 intra-commit references and eight retained-command references, and 44 allocator-owned `eventId` occurrences. Its trace graph additionally expands exact `2` ingress-command, `28` prior-retained-event and `14` immediate-suffix causations, with the matching `2+28+14` correlation propagation rows. Every occurrence also binds `/stream/id` to its exact payload aggregate and `/payloadDigest` to its exact `event-payload.*` rule; the AgentEvent→CommitEvent projection retains sixteen direct pointers byte-equal.

`commit-group.candidate.json` mechanically wraps the same 40 CommitEvent branches in exact `1..64` `events`, retains all 30 ordered branch-index shapes, and fixes the callback-free group invariants: one `/stream`, `/revision`, `/commandId`, `/commitId` and `/commitSize`; array length equals commit size; `commitIndex` equals array index; and sequence is strictly contiguous by one. Its current causation-required candidate is `100156` canonical bytes / `sha256:2fc8dade6ad415a7b668fab2fa7782ab993c83f342d8e1c001a206f24fd81c2c`. The exact `event-commit.v1` source is the full validated CommitGroup instance under `jcs-instance`, with no omissions, and its result endpoint is `/commitDigest` in each of all 40 AgentEvent variants.

Registry promotion has an exact endpoint preflight rather than a guessed row count. Each of AgentEvent, CommitEvent and CommitGroup contains `240` direct envelope/stream ID endpoints, `79` direct payload ID endpoints and `58` embedded `ImmutableContentRefV1` occurrences. The retained ref schema expands to exactly nine concrete ID endpoints across its three branches, so each future structural document requires `240 + 79 + 58×9 = 841` concrete ID rows and the three-document closure requires exactly `2523`. All 40 protocol variant IDs additionally have one collision-checked structural route: `:` is mechanically replaced by `.` (for example `completion.certified:blocked` → `completion.certified.blocked`) while already segmented IDs remain unchanged; branch index, protocol ID and schema route are retained together. The finite direct-payload owner grammar is now generator input with canonical SHA-256 `sha256:2b980cbe46c9185c42c9aa6df94c46dc85ae1b8aef946a40069f089f39699c3c`: its exact 79 rows contain two aggregate-creating random owners (`interaction.accepted.payload.interactionId` and `execution.created.payload.executionId`), 75 direct references, one pinned requirement semantic ID and one reference to the five-member same-kind `FollowUpAdmissionDecision` owner set. The compiler mechanically expands those rows plus all `58×9` embedded-ref endpoints into `601` payload rows per document and `1803` across the three documents; embedded store/object random owners are demoted to references while semantic classifications are preserved. The independent Python oracle reconstructs the same table and rejects owner or projection drift. The finite `reference-set` algebra can lower a same-kind owner set without widening its wire domain, and rejects a mixed-kind, singleton, reordered, cyclic or non-random terminal list.

The Event-retained owner chain is separately finite and pinned at `sha256:07fc6aeadb862ba1305e3278975485497f02cefbc04dae24a1bc1d7efc005a7c`. It imports only the two source-owned AgentEvent aggregate endpoints, closes exactly 15 Event/envelope root endpoints through 17 dependency rows, and terminates at 15 random owners across 11 schema IDs and nine opaque kinds; the only two bridges are accepted follow-up `messageId → AgentClientCommand.messageId` and `CompletionCommitAssessment.commandId → CompletionAssessmentInput.completionCommitCommandId`, so maximum reference depth is one. Node derives the root set from the payload and envelope grammars rather than trusting the table, and a separately pinned Python stdlib oracle reconstructs the exact chain and rejects coordinated definition/candidate/registry drift. This closes ID provenance only: none of the 11 owner schemas is thereby counted as a structural schema or field/binding rule. The 1803 projected rows, the 17 dependency rows and current 117 retained field rules are still candidate/substrate evidence, not retained `OpaqueIdFieldRuleV1`/`BindingProgramV1` closure. Promotion remains blocked on materializing the full structural and ID surfaces of those 11 owner schemas, the remaining `720` envelope/stream endpoints, occurrence-contextual commit/command/trace rules and Event/CommitEvent/CommitGroup documents. Any promotion with fewer than the exact `2523`, an ambient owner, or candidate rows counted as registry authority fails closed.

The owner-schema side now has one digest-pinned atomic-promotion preflight, not sixteen independently promotable candidates. Source `sha256:fd0fa6555f15ff70247c7178856167af73c5d0fac2bdeff316e97ade0ab4c597` closes the exact union of ingress plus layered sources: 16 candidate documents, 11 owner schemas, five support schemas, five retained boundary schemas, 51 real root structural variants, 158 direct and 931 transitive projected ID endpoints (`1089` total), `26 random / 74 reference / 9 same-kind reference-set / 49 semantic`, 24 direct AgentEvent import references and maximum owner depth three. It also derives 16 canonical schema-body digest rows and 16 future schema-authority plan rows, all still marked `required-not-materialized`. Application is defined as one compare-and-swap unit containing structural schemas, ID rules, the required joint owner+Event cohort, binding programs, schema-body rows and Store-issued `ProtocolSchemaRefV1` objects; any partial application must leave retained authority unchanged. The independent Python stdlib oracle recomputes the union, owner/projection lowering, retained `$ref` boundary and every domain-separated schema-body digest, and rejects both ID substitution and coordinated source/candidate/registry weakening. It also caught and corrected a prior false ingress count: four ingress documents contain six root variants, so the combined total is 51 rather than 49.

The preflight now feeds one deterministic candidate-only rule-ID lowering source, canonical SHA-256 `sha256:7dd49249dee514a6a35574f884b6458cce462cb60f8eee9e0fef2645f82a2d79`. Every rule ID is `id-field.astra-owner.<64 lowercase SHA-256 hex>.v1`, where the digest uses `monarch-digest-v1`, domain `event-owner-rule-id`, schema version `monarch.event-owner-rule-id-lowering.v1`, profile `monarch-jcs-utf8-v1` and the exact JCS tuple `(schemaId, variantId-or-absent, jsonPointer)`. The compiler allocates 1089 candidate endpoint IDs plus five explicit external-owner IDs (two Event aggregate imports and three retained logical-owner rows), yielding `1094/1094` unique generated IDs with zero endpoint, digest, retained-ID or unresolved-owner collisions. It translates endpoint owners into rule IDs, retains 16 already-authoritative rule-ID references, sorts every finite owner set and proves every candidate/import/retained chain terminates at the correct opaque-random authority. Candidate classification is exact: `542` random, `135` reference, `11` reference-set, `8` authenticated-external and `393` semantic rows; the 11 sets contain 24 members. The external `EvidenceNodeV1 /id` and dotted accepted-command variants are intentional namespace imports from the retained owner-dependency grammar, not dangling candidate endpoints. The source pins 15 stable allocation/topology counters while the generated artifact additionally reports all dynamic classification counters, allowing valid retained-rule evolution without weakening full artifact coverage. Any endpoint/digest/retained collision, unresolved owner, reorder or partial output rejects the entire lowering candidate. The independent Python stdlib oracle recomputes the framing, all 1094 IDs, imports, classifications, chains, provenance and registry equality and rejects coordinated source+candidate+registry weakening.

The next dependency audit proved that the two Event imports cannot be closed by standalone equality programs. §2.3 requires every retained ID rule to target a materialized schema, but neither retained `22/66` nor the 16-document owner cohort contains `AgentEventV1`; conversely the Event trio depends on those owner schemas. Owner-only promotion is therefore `forbidden-unmaterialized-event-owner-rules`, Event-only promotion is `forbidden-unmaterialized-owner-rules`, and standalone Event-import bindings are `forbidden-insufficient-authority`. The only admitted topology is one joint owner+Event promotion cohort: `16 + 3 = 19` structural documents and `1089 + 2523 = 3612` concrete ID endpoints. The exact Event trio is `AgentEventV1`, `CommitEventDigestBodyV1` and `CommitGroupDigestBodyV1`; 24 direct plus four projected owner references converge on two Event aggregate owners. This audit also caught a real projection defect: CommitGroup's 601 payload rows were emitted under nonexistent `monarch.commit-group.v1` and lacked their array location. They now target `monarch.commit-group-digest-body.v1` with exact prefix `property:events / each-array-item`; Node and the independent Event-source oracle agree. Four topology attacks reject standalone-import, owner-only, `3611`-row and CommitGroup-prefix weakening, and the independent atomic oracle separately rejects a mutated candidate topology. The following passes close the joint ID-rule, Event-binding and Completion-binding sides as candidates; Store authority, retained binding ABI and the atomic durable transaction remain open. `promotionReady=false`, `retainedMutationApplied=false` and `conformanceReady=false` are mandatory.

The full joint rule-ID cohort is now mechanically lowered without changing retained authority. The same domain-separated allocation contract produces exactly `3612` candidate rules: `1089` owner/support endpoints plus `2523` Event endpoints (`720` envelope/stream and `1803` payload/ref projections), with `841` rules for each of AgentEvent, CommitEvent and CommitGroup. The two former external Event aggregate anchors reconcile byte-for-byte with their real AgentEvent rules; complete dependency traversal additionally exposes two dotted logical `messageId` anchors, so the true non-structural retained logical-import set is five and the complete generated-ID set is `3617/3617`, with zero endpoint, digest, retained-ID or unresolved-owner collisions. Static classification is `633 opaque-random / 1898 reference / 35 same-kind reference-set / 120 two-kind reference-union / 8 authenticated-external / 918 semantic`. All 40 causation fields use the schema-exact 42-owner union of two ingress command authorities and 40 Event authorities; occurrence bindings still narrow each concrete value to retained ingress, prior retained Event or immediately previous occurrence. All correlations terminate at the submit-correlation allocator, repeated command/commit owners become exact finite sets, and five diagnostic stream IDs become two-owner same-kind sets. Ninety-six projected references that would otherwise point at a set/union rule are flattened to the identical terminal owner set because §2.3 permits scalar reference chains only through scalar references; projection equality remains a separate required binding proof. The `2060078`-byte artifact is `sha256:c6c5b43adab4567f18b855555f9bc52c17489a7c697ab04ee1a21390118915fb` and stays below every strict parser ceiling. An independent Python stdlib oracle reconstructs endpoint union, framed IDs, payload lowering, occurrence-derived command/commit ownership, trace unions, diagnostic streams, projection flattening, CommitGroup prefix and terminal chain closure; ID substitution, causation-owner removal, group-prefix mutation and logical-import omission fail closed. Event ID-rule lowering is therefore candidate-closed; the next paragraph closes Event-specific cross-object bindings without claiming retained authority.

The Event binding lowering now emits `114` candidate programs / `1376` exact instructions: `40` AgentEvent→CommitEvent projection programs, `44` occurrence programs and `30` ordered commit-shape programs. Its operation inventory is `640` direct projection equalities inside `749` total exact JSON-value equalities, `99` fresh allocator checks, `44` payload-domain digests, `28+28` prior-Event ID/correlation lookups, `30` exact variant sequences, `30` event-count checks, `30` index checks, `150` same-commit equality checks, `30` contiguous-sequence checks and `30` shared event-commit digests; `128` exact literals close schema-version and occurrence index/size. The candidate is `503503` bytes / `sha256:d73a1032632e2b43eb82895a775d11d25da04baf8e82373de652105264954c8e`, source identity `sha256:d88fc136290e6d7cbe5bc52b5356359a5ddd52240a8943a241a349b59ac1b228`. A composed Python stdlib oracle independently reconstructs every program from the separately verified occurrence/projection/group sources, executes seven connected programs for the three-event `invocation-failed` commit and rejects seven payload/projection/allocation/causation/stream/sequence/commit-digest mutations; four artifact attacks additionally reject projection omission, occurrence-owner substitution, result-set truncation and readiness escalation. This is a candidate-only executable language layered beside the retained 25-program substrate, not a silent extension of retained `BindingProgramV1`; `retainedBindingProgramsApplied=0`. Completion closure and the combined candidate ABI are specified immediately below; retained adoption and Store authority remain open, so `promotionReady=false` and `conformanceReady=false`.

Completion cross-object lowering is now materialized separately as `9` candidate programs / `151` instructions: one request fence, three verdict-specific assessment programs, one commit fence, one certificate fence and three typed terminal suffixes. It binds `28` claim IDs to their exact selector IDs and byte-equal presentation keys, enforces `private` TypedValue classification, the exact `16` required presentation keys, blocked/partial/verified verdict policy, `20` immutable-ref resolutions, `84` exact JSON-value copies, assessment-input/assessment-body/certification-key/certificate-envelope digest domains, once-only command/certificate allocation, byte-stable retry and the adjacent two-event terminal commit. The candidate is `68887` bytes / `sha256:3c9044b18a8c42923a7efafc9e853955f9c7ee975d9091ed1f7e94ef9561fa75`, source identity `sha256:c153a1412f2783200f8bb65d22d59d4e36f166f0da455d9e5b4ad09a97260e98`. A second Python stdlib implementation (`59377` bytes / `sha256:680d12539b0a14498a7080aaccbebbf807a7cbfc9d18048112c16c5af8001a11`) reconstructs all nine programs from the definition, executes every program across the three verdict fixtures and rejects `10` coordinated artifact mutations plus `12` command/time/ref/selector/classification/verdict/digest/certificate/terminal execution mutations. A disposable filesystem Store lab (`24791` bytes / `sha256:9e0ae337b5871cd076ffe42d285fa3938e81e6124edc90b04996b11e05d6105e`) runs only under an `E:`/`D:` scratch root and passes `12` issued-ref/CAS/retry/rollback/recovery scenarios, including three clean pre-commit failpoints and exactly-once recovery after state commit. It explicitly reports `powerLossDurabilityProven=false`: this closes candidate completion semantics and logical transaction behavior, not retained `25/93` authority. `retainedBindingProgramsApplied=0`, `promotionReady=false`, `conformanceReady=false`.

The two candidate languages now have one exact combined ABI rather than an implicit union. `combined-binding-language-abi.candidate.json` is `16362` bytes / `sha256:d7751f2e914be4d0c221b171f5a391ab28bc00b96ec35a5a2445f0026e33e6be`; its self-digest is `sha256:2819ef38d4f3264ae64e84e898ab1c0aacbfc23dda5b7277772d7e8e82015721` and its two-source identity is `sha256:5a54e797f2de454dc308f19c7a55d709593e33acbd75f82f98ec2eaa107f8f29`. It closes exactly `123` programs / `1527` instructions / `26` unique operations, eight scope kinds, 13 endpoint roles and `2519` endpoint references. Every instruction admits one exact operand-key form (two explicit forms only for canonical array order), unknown/missing operands and roles reject before authority change, type coercion and skipped instructions are forbidden, allocator authority is Store-owned, and Event/Completion sets plus every program and instruction are one all-or-zero CAS cohort. The independent Python oracle (`25939` bytes / `sha256:cf37707d7d42b95a08311efa006530f6448a9ce9236e902715304ea40b49da0e`) re-counts every source instruction/role/scope, recomputes source and ABI digests and rejects 12 readiness, widening, substitution, omission and partial-activation attacks. This is still a candidate ABI; retained `BindingProgramV1` remains `25/93` and applies none of these programs.

#### Versioned authority-root correction (plan-only)

The structural `66/66` result is not authority closure. `ProtocolFeatureSchemaManifestV1` retains bounded mnemonic `bindingRules`, while the actual candidate evaluator is expressed as ordered binding programs; `RuntimeFeatureSetV1` has no ref to their ABI or exact program cohort. Worse, the Event+Completion ABI above covers only `123/1527/26` and explicitly assumes no retained compatibility, while complete authority is the union of retained `25/93/6` plus candidate `123/1527/26`: exactly `148` unique programs, `1620` instructions and `30` unique operations. The same activation needs all `3617` generated ID rules. Sealing the current Manifest V1 would therefore produce a structurally valid but semantically incomplete authority root and is forbidden.

The selected correction is one versioned, cycle-free chain:

```text
RuntimeFeatureSetV2
  -> manifestRef/digest: ProtocolFeatureSchemaManifestV2
       -> authorityProfileRef/digest: ProtocolAuthorityProfileV1
```

`ProtocolAuthorityProfileV1` owns the exact opaque/semantic ID profiles, all `3617` ID-field rules, one unified 30-operation ABI, all `148/1620` binding programs and the guard/state/commit authority. It MUST NOT contain a Manifest ref or digest. `ProtocolFeatureSchemaManifestV2` owns the exact 66 schema refs, content-identity/digest rules, one authority-schema-set digest and the exact Store-issued profile ref/digest; legacy mnemonic binding rules are absent and minimum reader/writer protocol versions are both `2`. `RuntimeFeatureSetV2` has exactly one authority root, `manifestRef`; ambient ABI lookup and mixed V1/V2 authority are forbidden. Profile and Manifest may repeat only the independently computed authority-schema-set digest, preventing a cryptographic ref/digest cycle.

The three replacements are `OpaqueIdProfileV1 → ProtocolAuthorityProfileV1`, `ProtocolFeatureSchemaManifestV1 → V2` and `RuntimeFeatureSetV1 → V2`; the other 63 schema IDs remain byte-identical, so active closure remains exactly 66. Historical V1 objects remain retained for replay but are unreachable from the V2 root. Activation order is schema documents → AuthorityProfile instance → Manifest V2 instance → RuntimeFeatureSet V2 instance → one root-pointer CAS/epoch advance, followed by reopen/replay before reader activation. Any missing object, V1/V2 mixture, profile back-reference, ABI/program/rule omission or partial commit rejects with zero authority change.

The isolated alignment source is `4893` canonical bytes / `sha256:0736b023e4d8174b3efd3f3da73f134619cf64654b08fec16aa0ac69a2b0d063`; its artifact is `9582` bytes / `sha256:5918ecff921a1fb6795ca71f92a30c9839115b7748a672be99edad27361eef96`. Node and independent Python reconstruct `66 → 66`, the three replacements and `148/1620/30 + 3617`, rejecting `20+22` false-seal, count, cycle, ambient-lookup and partial-activation mutations. This selects the architecture only: unified ABI, the three replacement schemas, recompilation, definition seal, Store cohort and retained authority remain false.

The first artifact under that decision now materializes the unified ABI without rewriting retained
program bodies. Program-set discrimination occurs before envelope/instruction decoding:
`retained` admits the exact V1 `{programId,instructions}` envelope and unroled
`schemaId/variantId?/jsonPointer` endpoints, while `event|completion` admit the exact scoped
candidate envelope and 13 explicit endpoint roles. Thus retained compatibility is finite ABI data,
not ambient fallback. The result contains three sets, `148` unique program-index rows, `1620`
instructions, `30` operations and `2640` endpoint references (`121` retained + `2519` candidate),
with eight explicit candidate scope kinds plus one retained implicit-scope form. Both overlapping
operations carry all exact set-specific operand forms; the four retained-only operations are
explicitly defined. Unknown set/op/operand, coercion, skipped instruction, partial activation and
ABI/index digest drift fail before or with zero authority change. Source is `3315` bytes /
`sha256:cccbdb3ab6a0deb69dee6ac84aca71c14d670e7f22bf3df9cbcd61cfd3403efe`;
ABI `50221` / `sha256:d507ec656486aa45f761dd9aab873227001418f5f97c73a0580473a2538f9956`;
artifact `51392` / `sha256:633d07f559c5045026823c19140621fe6081ce1eb8c59ff919e56ade138b8897`.
Node/Python reject `23+25` mutations. AuthorityProfile instance, three replacement schemas,
RuntimeFeatureSet V2 program remap, ID recompilation, definition seal and Store activation remain
false.

The full cohort also runs through a disposable real SQLite backend (`36842` bytes / `sha256:0ebd24f3f501c3451bac823c1183f340510978fc30133c0f07103465ef9ca39e`) under `.test-tmp` on `E:`/`D:` with `WAL`, `synchronous=FULL`, foreign keys and `integrity_check`. One transaction stores the exact 19 canonical schema documents, 19 Store-issued **candidate** schema refs, 3612 ID rules, all 123/1527 programs/instructions and the ABI, then advances one authority epoch by CAS. Three separate worker processes terminate via `os._exit` after schema, ID-rule and program insertion and reopen with zero partial rows; a fourth exits after commit-before-response and recovers the byte-identical receipt exactly once. Two concurrent processes prove same-request receipt identity and one-winner behavior for differing same-epoch requests; stale epoch, idempotency-body conflict, three partial cohorts and a foreign-key violation reject. Reopen/readback, `integrity_check` and SQLite backup reproduce the exact cohort; the measured database is `4628480` bytes. The result truthfully reports `processCrashDurabilityProven=true`, but `powerLossDurabilityProven=false` and `tornWriteRecoveryProven=false`. Its meta-schema digest is an explicit lab-only placeholder and schema role/content-identity/digest/binding rule assignments are not retained manifest authority, so `retainedProtocolSchemaRefsIssued=0`, product persistence and Monarch Safe remain untouched, and no 0A promotion gate is closed.

A separate Python stdlib oracle reconstructs both 40-branch schemas, the 79-row direct payload owner grammar, all 1803 payload/embedded-ref endpoint projections, all 44 occurrence/trace rows and the CommitGroup schema/invariant/digest source. The pure Event simulation accepts five exact schema instances, rejects eleven structural mutations, passes three ordinary plus three CommitGroup checks, rejects two ordinary, eight group and seven trace-relation mutations. The first multi-event fixture deliberately exposed a reason-code mismatch (`policy-denied` was valid for the terminal event but not its `goal.blocked` antecedent); the final exact pair uses the shared admitted `authority-scope-empty` code. A second pure simulator derives all twelve lifecycle transitions plus the one receipt-link fact from the same source, reaches `settled@5` with one stable dispatch attempt/port call, exercises rejected/cancelled/failed/indeterminate/output-rejected paths and rejects eleven CAS/key/receipt/terminal mutations. The layered owner catalog now closes all three structural source layers. `InvocationV1` has the exact twelve lifecycle branches, inline dispatch-key body, 18 direct ID rows and 138 retained projections. `InteractionIntentAdmissionV1` has an exact 19-field root, closed submit/follow-up source union, one pinned matcher tuple, bounded clause/candidate/route collections, informational/operational-capability/operational-unknown candidates, closed partial/unavailability unions, 27 direct rows and 108 retained projections. `CompletionAssessmentBodyV1` is a closed blocked/partial/verified union: blocked has no claims or presentation keys and at least one denial; verified has exactly 28 bindings and no denials; partial has 0..28 safe observed bindings and at least one denial; verified/partial carry the exact 16-key presentation tuple. `CompletionCommitAssessmentV1` is a closed seven-field command over retained `CertificationKeyBodyV1` and two immutable refs. `CompletionCertificateV1` is one closed 12-field local-trusted-writer envelope with exact issuer/trust literals, Store-owned ID, immutable input ref, embedded assessment body, copied assessment clock/frozen time and separate assessment/certification/envelope digest domains. The compiler preserves projected endpoint classifications across structural layers, so the certificate projection includes all 178 direct and nested ID endpoints of `CompletionAssessmentBodyV1`, plus two ClockAttestation and nine ImmutableContentRef endpoints; none is silently reclassified as a direct owner. The schema surface deliberately leaves cross-field claim→selector→presentation bijection, private classification, verdict selection, frozen commit/certificate copies and domain-separated digest calculation to semantic bindings rather than falsely calling them JSON-Schema-only proof. Its clause message chain deliberately resolves through Admission source → accepted AgentCommand → AgentClientCommand, so the exact maximum owner-reference depth is three rather than a flattened false owner. The layered simulator accepts 68 exact instances, rejects 1175 structural mutations plus 28 schema-valid semantic mutations, proves 133 positive plus 133 negative owner bindings and checks all 915 retained/transitive projection endpoints. It computes the assessment-body, certification-key and completion-certificate-body digests, rejects schema-valid frozen-copy/digest/id substitutions and proves byte-stable certificate retry. These are generated/pure candidates, not retained structural registry rows: one atomic lowering/promotion of all eleven owner dependencies, every direct/projected ID rule, completion binding, Event import and schema-body/ProtocolSchemaRef authority remains required before Event/CommitEvent/CommitGroup promotion. `conformanceReady=false`.

Core deliberately has no snapshot or rolling `streamDigest` authority schema/domain. Sequence + revision + exact complete-group digest are sufficient for the fixture simulator. A future product-facade snapshot may add a separately allowlisted prefix-digest body/domain only after backend selection; prose §25 cannot make it part of this manifest.

`producer` is provenance, never authentication. In the core schema-lab fixture, the single in-memory appender accepts proposals only from Application admission/terminal commit (the latter carrying a pure Certifier assessment), the direct Invocation coordinator, Kernel Receipt Admission, Evidence Projector and deterministic Presentation; each may propose only the closed variants/refs whose frozen inputs it recomputes. The pure Certifier never appends or owns an event. Scheduler/lease, runtime-host/Engine, provider, migration, child, job and compaction producers have no core branch. Interaction/Execution/event clients never append directly. A future product profile must publish its own closed owner/authentication matrix; cross-process producers then require an authenticated local IPC session bound to OS principal/process identity, random session nonce, monotonic message sequence and manifest digest. Unauthenticated JSON claiming any producer is rejected. Exact IPC signing/sandbox requirement is a later threat-model gate.

### 5.1. Event immutability

Event не обновляется. Исправление — новый compensating/correcting event с causation ref. Redaction не переписывает authority fields: sensitive payload изначально хранится по protected ref либо crypto-erased отдельно согласно retention policy.

### 5.2. Replay

Replay first buffers and validates the complete commit group described below. Only inside that already complete candidate group does Projection validate each event:

- stream ID совпадает;
- `sequence == lastSequence + 1`;
- payload version поддержан;
- digest валиден;
- referenced prior entity существует либо event type допускает creation;
- state transition разрешён.

No event is applied when merely `sequence == lastSequence + 1`. Replay validates indices `0..size-1`, same command/revision/commit ID/digest/size, contiguous sequences and group digest for the complete buffered group, then applies the group atomically to the projection. Incomplete tail/missing middle/inconsistent group is corruption; projection stops at prior verified commit and preserves/quarantines raw tail for explicit repair. Duplicate exact **complete group** ignored; same sequence/different event is corruption.

### 5.3. Schema admission manifest

An event/command/query name in prose is not enabled ABI by itself. `ProtocolFeatureSchemaManifestV1` is defined in §2.1 and must contain the exact §0.1 schema-ID set with immutable refs/digests. Schema-lab validates the manifest before any RuntimeFeatureSet; flags never select schemas first. Only after manifest validation may an atomic RuntimeFeatureSet enable exactly `agent-core-read.v1`. Missing/extra schema, variant or transition fails startup of the lab artifact. Product/shadow runtime does not import the package until a later explicit gate. Extension event vocabulary remains unavailable even if named below.

Core has no generic public details object. Public protocol wording uses the stable error `code` and the separately closed completion-denial code/detail table; raw path/provider/credential/stack/payload fields are never inserted. Authorized diagnostics use an immutable private ref, and the public renderer may omit it entirely.

---

## 6. Command receipt

```ts
interface AgentCommandReceiptV1 {
  schemaVersion: 'monarch.agent-command-receipt.v1';
  commandId: string;
  fingerprint: DigestV1;
  acceptedAt: string;
  disposition: 'accepted';
  interactionId: string;
  executionId?: never;
  committedRevision: SafeCounterV1;
  eventIds: string[]; // generated schema: minItems=1, uniqueItems=true, persisted order
  error?: never;
}
```

`accepted` означает authoritative admission, не terminal success. In the schema lab, `commit`, `retained`, `persisted` and `stored` in this command path refer only to the simulator's explicit in-memory retained-state boundary; they do not claim process-kill, filesystem, `fsync` or power-loss durability. A future product surface may expose this accepted receipt only after the selected backend proves that stronger durable boundary and atomically commits the same closed object group. Receipt exists only after strict client-schema parsing, authentication, accepted-context/fingerprint construction, dedupe capacity reservation and one atomic authority commit of accepted-command body + dedupe record + receipt + first Interaction event. That commit has exactly one `interaction.accepted|interaction.follow-up-accepted` event. Its payload resolves the exact dedupe/receipt refs; dedupe resolves its exact scope body; accepted-context `principalRef` equals `stablePrincipalRef`, record/client/auth-context fields equal the command/context, and no installation/session input is ambient. Event `commandId/stream.id/revision/eventId/occurredAt` equal receipt `commandId/interactionId/committedRevision/eventIds[0]/acceptedAt`; `eventIds` is an exact singleton; command ID/ref/digest and fingerprint/context/scope fields equal the accepted command and dedupe record; dedupe `receiptRef/digest` equals the event's receipt ref/digest. All objects become visible together or none do. Any failure before that boundary—including invalid schema, unauthorized caller, unavailable feature, manifest/upgrade failure, storage pressure or same-client-ID/different-body conflict—returns the closed `AgentProtocolErrorV1` directly and creates no command/receipt/aggregate fact. Exact retry of the same accepted fingerprint returns the byte-identical retained receipt, including original IDs/revision/time; it never mutates the authority body to say `replayed`. A transport may expose a non-authority cache-hit flag outside this schema. The retained receipt contains no localized error and is immutable across template changes.

Dedupe/receipt capacity reservation failure is exactly `storage-capacity-exceeded/storage/after-runtime` with no diagnostic pair; it is never misreported as user traversal `budget-exceeded`, generic `internal-error` or an accepted receipt.

Receipt acceptance also creates a liveness obligation. In the pure schema-lab harness, the deterministic Application coordinator must enumerate every `accepted` Interaction lacking intent admission at startup/after each commit, recompute only with the pinned retained matcher/context and idempotently seal the one Admission; a quiescent harness with such an Interaction is a failed trace. This is simulator liveness, not product durability. Before a product receipt is exposed, a generated durable continuation inbox/recovery owner, historical implementation retention and process-generation fence must provide the same guarantee; exact client retry is never the mechanism that starts work a second time.

```ts
interface CommandDedupeRecordV1 {
  schemaVersion: 'monarch.command-dedupe-record.v1';
  dedupeScopeRef: ImmutableContentRefV1;
  dedupeScopeDigest: DigestV1;
  clientRequestId: string;
  requestFingerprint: DigestV1;
  acceptedContextDigest: DigestV1;
  authContextEpoch: string;
  commandId: string;
  riskClass: 'no-effect';
  retention: 'installation-generation';
  receiptRef: ImmutableContentRefV1;
  receiptDigest: DigestV1;
}
```

```ts
interface CommandDedupeScopeBodyV1 {
  schemaVersion: 'monarch.command-dedupe-scope-body.v1';
  installationGenerationId: string;
  stablePrincipalRef: string;
  protocolNamespace: 'agent-core-read.v1';
  bodyDigest: DigestV1;
}
```

For the fixed core schema-lab profile, both `installationGenerationId` and `stablePrincipalRef` are `authenticated-external` under exact profile `ascii-opaque-token-1-to-128.v1`; neither is a new store-generated opaque-ID kind. The trusted fixture composition root provisions and authenticates one exact installation-generation token before the store contains retained state, and every public adapter authenticates the exact stable principal token before scope construction. Core never mints, normalizes or rotates either value. The installation token is frozen for the entire lifetime of that isolated fixture store; missing attestation or any change while retained state exists fails before dedupe lookup/acceptance. This profile makes no cross-installation uniqueness or product-rollover claim: a product backend still requires the versioned client-visible generation fence, authenticated generation record and migration/restore rules specified below.

`dedupeScopeDigest` is domain `command-dedupe-scope` over this exact retained allowlisted body with only `/bodyDigest` omitted; `dedupeScopeRef` resolves that body. No process ID, auth token or current session is an implicit scoping input.

IDs are unique inside `dedupeScopeDigest`, not globally and not only per process. Admission first looks up `(dedupeScopeDigest, clientRequestId)`. When absent, it derives current accepted context, computes/stores the fingerprint and may accept. When present, it does **not** derive current locale/feature/contract context: after authenticating the same stable principal/installation, it reconstructs `CommandFingerprintBodyV1` from the incoming exact client branch plus the record's original `acceptedContextDigest/authContextEpoch`; requested privacy must still be omitted/`persistent`. Same reconstructed fingerprint returns the old byte-identical retained receipt and never creates work again; a different client body conflicts. A later auth epoch may perform only that exact original-command retry and cannot create new work under the old context. Another principal learns no record. Core retains the complete record + receipt for the lifetime of its single fixed fixture installation generation; it has no query, compacted-receipt or lookup-response branch. A client ID is never reusable in that generation, so GC cannot turn an old retry into new work. Core has no generation rollover/reset operation. A future product rollover MUST add a versioned client-visible generation fence to the public command and fingerprint, validate it before dedupe lookup and reject an old-generation retry before it can enter the new scope; merely changing the server-derived `dedupeScopeDigest` is insufficient. Until that ABI, authenticated rollover and retention migration pass fixtures, rollover/product import is unavailable. Receipt compaction, effect-command tombstones and any future public lookup response require a versioned product-facade/effect schema and are not optional variants here.

The schema lab uses a finite manifest fixture corpus and tests byte-identical exact retry/conflict plus permanent retention in one fixed generation; it does not claim an unbounded product dedupe store or rollover protocol. Before any persistent product facade, the chosen backend MUST define installation-generation lifecycle, the explicit client generation fence, authenticated rollover, old-request rejection, capacity accounting, backup/restore and fail-closed storage-pressure behavior. Exhaustion blocks new command admission before authoritative acceptance; it never evicts a current-generation record/receipt or silently permits ID reuse.

Before product import, every nonterminal accepted command pins a retained executable package record, not only `ImplementationHashV1`. Upgrade admission proves the exact historical bytes remain locally admitted/reproducible until all work that may execute them is terminal or migrated by a separately reviewed semantic transition. Removing/quarantining referenced bytes blocks the upgrade or produces a typed product recovery outcome; it never substitutes the latest matcher/adapter/Certifier. Mixed-version processes carry a package generation fence, and an old writer cannot append after the active generation changes.

### 6.1. Canonical typed value

```ts
type TypedValueV1 =
  | { schemaVersion: 'monarch.typed-value.v1'; semanticType: 'boolean';
      encoding: 'json-canonical'; value: boolean; classification: 'public' | 'private'; digest: DigestV1 }
  | { schemaVersion: 'monarch.typed-value.v1'; semanticType: 'safe-integer';
      encoding: 'json-canonical'; value: SafeCounterV1; classification: 'public' | 'private'; digest: DigestV1 }
  | { schemaVersion: 'monarch.typed-value.v1'; semanticType: 'integer';
      encoding: 'base10-integer'; value: string; classification: 'public' | 'private'; digest: DigestV1 }
  | { schemaVersion: 'monarch.typed-value.v1'; semanticType: 'decimal';
      encoding: 'base10-decimal'; value: string; classification: 'public' | 'private'; digest: DigestV1 }
  | { schemaVersion: 'monarch.typed-value.v1'; semanticType: 'string';
      encoding: 'json-canonical'; value: string; classification: 'public' | 'private'; digest: DigestV1 }
  | { schemaVersion: 'monarch.typed-value.v1'; semanticType: 'object';
      encoding: 'json-canonical'; value: StorageExclusionSummaryV2;
      classification: 'public' | 'private'; digest: DigestV1 };
```

`base10-integer` grammar: `0 | -?[1-9][0-9]*`; unsigned claim additionally rejects `-`. No exponent, plus, whitespace, locale separators or `-0`. `digest` is the `typed-value` domain digest of the exact closed branch with only `/digest` omitted, including classification and canonical value. Numeric adapters reject unsafe JS numbers instead of coercing them.

JSON Schema uses `oneOf`; cross-type encoding/value combinations are impossible. Core has no artifact/secret TypedValue and no generic naked protected ref. A future artifact or secret value requires a new TypedValue/schema version plus the corresponding artifact/protected-object profile; it cannot be added as an optional base-manifest branch.

---

## 7. Agent Client Protocol commands

Only §7.1/§7.2 are in `agent-core-read.v1`. Sections §7.3–§7.13 are reserved future product/extension semantics and return `feature-unavailable` in the schema lab; their prose is not permission for schema generator to invent payloads.

### 7.1. `interaction.submit`

Создаёт Interaction до routing/model работы.

```ts
interface InteractionSubmitPayloadV1 {
  schemaVersion: 'monarch.interaction-submit-payload.v1';
  conversationId: string;
  messageId: string;
  content: string;
  attachmentRefs: [];
  clientIntent: 'auto' | 'answer-request' | 'execution-request';
  requestedProfile: 'auto' | 'answer-only' | 'agent-core-read.v1';
  replyToMessageId?: string;
}
```

`clientIntent/requestedProfile` are untrusted routing hints. Server recomputes content bytes digest, accepted privacy/context and eligibility; a hint cannot force V3 or broaden scope. The core operational matcher consumes exactly this command's one message body. Non-empty attachments are rejected before acceptance rather than retained and ignored; any attachment/history-dependent operational meaning needs a future payload version. Answer-only behavior stays outside the execution profile.

Результат core: accepted command receipt + retained Interaction event prefix. Тот же in-memory fixture appender затем детерминированно применяет admission/routing и при eligible operational candidate создаёт linked Execution; никакой product/durable outbox этим профилем не заявлен.

### 7.2. `interaction.follow-up`

Адресуется существующему Interaction и никогда не является shortcut вокруг semantic admission:

```ts
interface InteractionFollowUpPayloadV1 {
  schemaVersion: 'monarch.interaction-follow-up-payload.v1';
  messageId: string;
  content: string;
  attachmentRefs: [];
  clientIntent: 'auto' | 'answer-request' | 'add-constraint';
  targetExecutionId?: string;
}

interface FollowUpAdmissionDecisionBaseV1 {
  schemaVersion: 'monarch.follow-up-admission-decision.v1';
  id: string;
  admissionId: string;
  admissionRef: ImmutableContentRefV1;
  admissionBodyDigest: DigestV1;
  bodyDigest: DigestV1;
}

type FollowUpAdmissionDecisionV1 = FollowUpAdmissionDecisionBaseV1 & (
  | { relation: 'new-execution'; reasonCode: 'semantic-operational-follow-up';
      targetExecutionId?: string }
  | { relation: 'answer-only'; reasonCode: 'informational-follow-up';
      targetExecutionId?: string }
  | { relation: 'clarify'; reasonCode: 'ambiguous-follow-up';
      targetExecutionId?: string }
  | { relation: 'reject'; reasonCode: 'ineligible-follow-up';
      targetExecutionId?: string }
  | { relation: 'reject'; reasonCode: 'target-outside-interaction';
      targetExecutionId: string }
);
```

Application first persists the follow-up input, exact accepted context and a new full `InteractionIntentAdmissionV1` whose source points to the prior admission and any user-cited Execution. Only then may it persist the closed `FollowUpAdmissionDecisionV1` one-of under domain `follow-up-decision`. The generated command branch requires outer Interaction target + CAS revision. For every non-`target-outside-interaction` branch, an optional `targetExecutionId` MUST resolve to an Execution already linked to that same Interaction; it remains provenance and never changes the aggregate target or supplies authority. The `target-outside-interaction` branch requires the untrusted user-cited ID solely to explain typed rejection and cannot dereference/import that Execution. Relation/reason/target combinations outside the five branches are schema-invalid.

- Core has no Engine steer, in-place Goal revision or pending-input protocol. Every semantic operational follow-up creates a new linked Execution; the existing Execution and Goal remain immutable.
- Informational follow-up records only the non-operational `answer-only` admission decision; it creates and queues no core work. Any independently ordered answer row belongs to a separately admitted product-facade ABI outside this execution profile. Ambiguity clarifies; ineligibility rejects.
- New constraint, target, attachment used as input, requested output field, capability, relaxed evidence policy or widened authority can never be folded into an existing Execution.
- `clientIntent` is an untrusted hint. It cannot choose the relation, generation or policy.

### 7.3. `execution.pause`

Запрашивает остановку на ближайшей safe boundary. Если invocation dispatched, pause ждёт settle/reconciliation. Receipt различает `accepted` и `paused`.

### 7.4. `execution.resume`

Создаёт новую Activation generation после Recovery Service evaluation. Нельзя resume terminal execution или stale goal revision.

### 7.5. `execution.cancel`

Cancellation mode:

- `graceful` — safe boundary;
- `immediate-runtime` — abort model/driver, но не подменяет Kernel cancel;
- exact effect cancellation возможна только если capability advertises support.

Terminal `cancelled` допускается только после known settle/reconcile всех dispatched invocations. Unknown outcome переводит Execution в visible nonterminal `blocked-indeterminate`; disclosure не превращает неизвестность в cancelled.

### 7.6. `execution.provide-input`

Отвечает на exact `inputRequestId`. Request declares schema/choices/expiry. Free text сохраняется как untrusted input и проходит goal/argument admission.

### 7.7. `approval.resolve`

```ts
interface ApprovalResolvePayloadV1 {
  approvalId: string;
  executionId: string;
  invocationId: string;
  invocationAuthorizationRevision: number;
  approvalExpectedRevision: number;
  capabilityId: string;
  canonicalProposalHash: string;
  decision: 'approve-once' | 'deny';
  armAttestationId?: string;
  armAttestationExpectedRevision?: number;
}
```

Outer command `target.executionId + expectedRevision` CAS-ит Execution aggregate. Payload дополнительно CAS-ит Approval child entity и, для armed approve, exact ArmAttestation child entity. Arm fields запрещены для deny и для approve при `requiredArm=false`; при `requiredArm=true` оба arm fields обязательны. Нет generic text confirmation. `approve-task` в начальном V1 отсутствует; reusable grants являются отдельной policy feature.

### 7.8. `approval.arm-request`

```ts
interface ApprovalArmRequestPayloadV1 {
  approvalId: string;
  executionId: string;
  invocationId: string;
  invocationAuthorizationRevision: number;
  approvalExpectedRevision: number;
}
```

Создаёт short-lived one-use server attestation только после trusted UI/hardware interaction. Outer `expectedRevision` CAS-ит Execution aggregate, payload CAS-ит current pending Approval child entity; principal/surface/auth epoch берутся только из AcceptedCommandContext. Arm attestation не передаётся другому client и после approve/revoke/expiry становится consumed/revoked/expired отдельным durable event.

### 7.9. `execution.request-retry`

Unavailable in `agent-core-read.v1`: core always represents a retry as a new linked Execution/Goal and never creates a second Invocation in the same Execution. A future recovery/effect profile may introduce an explicit bounded attempt/supersession schema only with its own event/state/selection/retention rules. A terminal Execution is never revised back to running. For non-idempotent indeterminate effect, user may acknowledge/archive/abandon future work but cannot assert applied/not-applied by button; only registered admitted reconciliation evidence resolves truth, and command never repeats the source effect automatically.

### 7.10. `delivery.consume`

Подтверждает, что durable child/job/cross-session delivery прочитана exact consumer revision. Повтор idempotent.

Revision conflict требует перечитать parent и повторить consume с тем же delivery ID; receiver inbox dedupe не зависит от старой revision и предотвращает double apply.

### 7.11. `provider-grant.resolve`

Extension-only command; unavailable and rejected as `feature-unavailable` in `agent-core-read.v1`.

Создаёт/отклоняет server-owned ProviderExecutionGrant после exact consent card. Payload ссылается на prepared grant request: provider/driver identity, terms/agreement version, execution + Goal revision, data classes/immutable refs, expiry. Client не может заменить эти поля при resolve. Incognito и encrypted lanes не получают grant в V3 foundation.

### 7.12. Incognito admission profile

Extension-only privacy design. Core schema lab accepts only disposable persistent fixture state; it makes no operational Incognito claim.

V3 foundation accepts only answer-only or local read invocations whose frozen effect profile has `mutation=none`, `communication=none`, no external/provider egress and no durable credential/job/child requirement. Any write/execute/device mutation/external/financial/identity/security effect returns `privacy-mode-incompatible` and can only continue as a **new explicitly accepted persistent Interaction**. Server never silently changes privacy mode.

Allowed Incognito read additionally requires `IncognitoStorageProfileV1`: Interaction/Execution journal, Kernel read receipts, Evidence Store, certificates/TypedValues, attachments/artifacts, context/cache and logs are scope-bound memory-only. No durable ref/digest/path/content/correlation residue is allowed. Capability whose adapter cannot prove no-persist is Incognito-ineligible.

```ts
interface IncognitoStorageProfileV1 {
  schemaVersion: 'monarch.incognito-storage-profile.v1';
  scopeId: string;
  persistence: 'memory-only';
  ports: {
    interaction: 'memory'; execution: 'memory'; evidence: 'memory'; receipts: 'memory';
    certificates: 'memory'; artifacts: 'memory'; attachments: 'memory'; context: 'memory';
    driverCache: 'memory'; logs: 'ephemeral-redacted-ring';
  };
  durableMetricsPolicy: 'aggregate-unlinkable-only';
  denyDurableDereference: true;
  closePolicy: 'release-and-best-effort-zeroize';
}
```

This profile makes a bounded claim about Monarch-managed persistence ports. It does not promise physical erasure of immutable JS strings, allocator copies, pagefile/hibernation/crash dumps, GPU/model memory, antivirus/ETW or OS diagnostics. Secret-bearing implementations use mutable secure buffers where available and best-effort zeroization, but unsupported residual channels must be disclosed and may make a capability/platform Incognito-ineligible. Product wording is “не сохраняется Monarch после закрытия в поддерживаемые хранилища”, never “на устройстве не останется ни одного байта”.

### 7.12.1. Encrypted lane boundary

Extension-only privacy design. Encrypted operational execution is unavailable in core.

Encrypted mode is not Incognito and cannot reuse the generic persistent profile. V3 foundation keeps it answer-only and provider/operational disabled. Before any V3 execution in that lane, `EncryptedStorageProfileV1` must bind conversation/vault/key generation, encrypted journal/message/attachment refs, local-driver context/cache policy, decrypted-buffer lifetime, log/crash redaction, backup/rotation and close behavior across every port. A plain `privacy.mode='encrypted'` field does not supply those controls. Until that schema and residue/restore fixtures pass, existing encrypted answer behavior remains behind its current adapter and no V3 Execution is admitted.

### 7.13. Recovery case commands

- `recovery.request-reconciliation(caseId, expectedRevision)` — run only frozen read-only reconciliation recipe; never repeat source effect.
- `recovery.acknowledge(caseId)` — mark uncertainty seen; truth state unchanged.
- `recovery.archive-view(caseId)` — hide from active UI; minimal tombstone and truth remain.
- internal `recovery.receipt-observed` — exact late Kernel/provider receipt admission.
- internal `recovery.mark-permanently-unknown` — only after unsupported/exhausted frozen recipe; late receipt may still resolve.

`execution.request-retry` is not valid for unknown non-idempotent source effect. Any new source effect requires resolved `not-applied` fact or separate explicitly admitted goal/invocation under frozen policy.

---

## 8. Client queries

> **Future product-facade vocabulary; unavailable in `agent-core-read.v1`.** None of these query/snapshot/SSE schemas is in the base manifest. A separately compiled/reviewed product-facade manifest is required before Phase 1 may persist or serve them.

Target family:

- `interaction.get(id)`;
- `interaction.list(conversation, cursor)`;
- `execution.get(id)`;
- `execution.events(id, afterSequence, limit)`;
- `execution.attach(id, afterSequence)` через SSE/stream;
- `execution.approvals(id)`;
- `execution.artifacts(id)`;
- `delivery.list(owner, cursor)`;
- `job.get/list` после job phase.

Query response содержит `snapshotRevision`, `lastSequence`, `oldestAvailableSurfaceSequence`, feature descriptor и server protocol version.

---

## 9. Interaction events

> **Reserved product projection vocabulary.** The only enabled Interaction events are the exact entries of `AgentCoreEventPayloadMapV1` in §5. The wider list below is not core ABI.

Target family:

```text
interaction.accepted
interaction.intent-admission-started
interaction.intent-admitted
interaction.routing-started
interaction.routed
interaction.execution-link-requested
interaction.execution-linked
interaction.answer-started
interaction.answer-chunk-appended       (surface event, может не храниться полностью)
interaction.answer-completed
interaction.follow-up-accepted
interaction.follow-up-intent-admitted
interaction.follow-up-dispositioned
interaction.steer-queued
interaction.output-row-closed
interaction.output-row-opened
interaction.outcome-projected
interaction.message-persist-requested
interaction.message-persisted
interaction.delivery-applied
interaction.blocked
interaction.failed
interaction.cancelled
```

In a future product-facade manifest, `interaction.outcome-projected` with `verified|partial|blocked` must cite the exact certified/noncertified outcome branch. It is deliberately absent from the schema lab, which ends at deterministic `StructuredResultV1` and cannot mutate a user-visible Interaction/message.

### 9.1. Persisted intent admission

```ts
interface MatcherContractBindingV1 {
  matcherId: 'workspace.storage.audit.intent-matcher.v1';
  version: '1';
  bodyRef: ImmutableContentRefV1;
  bodyDigest: DigestV1;
  inputSchemaDigest: DigestV1;
  outputSchemaDigest: DigestV1;
  implementationHash: ImplementationHashV1;
}

interface IntentTargetBindingV1 {
  schemaId: 'monarch.canonical-windows-path.v1';
  schemaDigest: DigestV1;
  bodyRef: ImmutableContentRefV1;
  bodyDigest: DigestV1;
  canonicalIdentityDigest: DigestV1;
  provenanceCode: 'windows-existing-root-handle';
}

interface IntentClauseV1 {
  id: string;
  sourceMessageId: string;
  sourceRange: { start: SafeCounterV1; end: SafeCounterV1 };
  negated: boolean;
  modality: 'question' | 'request' | 'command' | 'prohibition' | 'unknown';
  targetCompleteness: 'complete' | 'missing' | 'ambiguous';
  temporalMeaning: 'none' | 'interval-observation' | 'point-in-time-snapshot'
    | 'stable-window' | 'ambiguous';
}

type OperationalUnavailabilityV1 =
  | { code: 'target-missing' | 'target-ambiguous' | 'target-ineligible'
        | 'temporal-intent-ambiguous' | 'capability-unavailable';
      requestedTemporalClass?: never }
  | { code: 'temporal-class-unavailable';
      requestedTemporalClass: 'point-in-time-snapshot' | 'stable-window' };

type GoalMatcherDispositionCodeV1 = OperationalUnavailabilityV1['code'];

type GoalMatcherCandidateDraftV1 =
  | { ordinal: SafeCounterV1; kind: 'informational'; clauseIds: string[];
      ambiguityCodes: [] }
  | { ordinal: SafeCounterV1; kind: 'operational-unknown'; clauseIds: string[];
      ambiguityCodes: [GoalMatcherDispositionCodeV1]; unavailability: OperationalUnavailabilityV1;
      targetSourceRange?: { start: SafeCounterV1; end: SafeCounterV1 } }
  | { ordinal: SafeCounterV1; kind: 'operational-capability'; clauseIds: string[];
      capabilityId: 'workspace.storage.audit.v2';
      targetSourceRange: { start: SafeCounterV1; end: SafeCounterV1 };
      temporalClass: 'interval-observation'; temporalAdmission: 'explicit-interval';
      partialPolicy:
        | { mode: 'forbid'; admission: 'default-forbid' | 'explicit-forbid' }
        | { mode: 'allow-disclosed'; admission: 'explicit-allow-disclosed' };
      ambiguityCodes: [] };

interface GoalMatcherResultV1 {
  schemaVersion: 'monarch.goal-matcher-result.v1';
  acceptedCommandDigest: DigestV1;
  acceptedContextDigest: DigestV1;
  matcherBodyDigest: DigestV1;
  matcherImplementationHash: ImplementationHashV1;
  clauses: IntentClauseV1[];
  candidateDrafts: GoalMatcherCandidateDraftV1[];
  bodyDigest: DigestV1;
}

type InteractionIntentCandidateV1 =
  | { id: string; matcherResultOrdinal: SafeCounterV1;
      kind: 'informational'; clauseIds: string[];
      matcher: MatcherContractBindingV1; ambiguityCodes: [] }
  | { id: string; matcherResultOrdinal: SafeCounterV1;
      kind: 'operational-unknown'; clauseIds: string[];
      matcher: MatcherContractBindingV1; ambiguityCodes: [GoalMatcherDispositionCodeV1];
      targetBinding?: IntentTargetBindingV1;
      unavailability: OperationalUnavailabilityV1 }
  | { id: string; matcherResultOrdinal: SafeCounterV1;
      kind: 'operational-capability'; clauseIds: string[];
      matcher: MatcherContractBindingV1; capabilityId: 'workspace.storage.audit.v2';
      capabilityContractRef: ImmutableContentRefV1;
      capabilityContractDigest: DigestV1; targetBinding: IntentTargetBindingV1;
      temporalClass: 'interval-observation'; temporalAdmission: 'explicit-interval';
      partialPolicy:
        | { mode: 'forbid'; admission: 'default-forbid' | 'explicit-forbid' }
        | { mode: 'allow-disclosed'; admission: 'explicit-allow-disclosed' };
      ambiguityCodes: [] };

type InteractionAdmissionSourceV1 =
  | {
      kind: 'submit';
      acceptedCommandId: string;
      acceptedCommandRef: ImmutableContentRefV1;
      acceptedCommandDigest: DigestV1;
      inputMessageId: string;
    }
  | {
      kind: 'follow-up';
      acceptedCommandId: string;
      acceptedCommandRef: ImmutableContentRefV1;
      acceptedCommandDigest: DigestV1;
      inputMessageId: string;
      previousAdmissionId: string;
      previousAdmissionRef: ImmutableContentRefV1;
      previousAdmissionBodyDigest: DigestV1;
      targetExecutionId?: string;
    };

interface InteractionIntentAdmissionV1 {
  schemaVersion: 'monarch.interaction-intent-admission.v1';
  id: string;
  interactionId: string;
  source: InteractionAdmissionSourceV1;
  acceptedContextDigest: DigestV1;
  runtimeFeatureSetRef: ImmutableContentRefV1;
  runtimeFeatureSetDigest: DigestV1;
  matcherContracts: [MatcherContractBindingV1];
  matcherResultRef: ImmutableContentRefV1;
  matcherResultDigest: DigestV1;
  clauses: IntentClauseV1[];
  candidates: InteractionIntentCandidateV1[];
  clauseRoutes: Array<{
    clauseId: string;
    selectedCandidateIds: string[];
    route: 'answer' | 'execution' | 'clarify' | 'blocked';
    executionEligibility: 'v3-only' | 'none';
    dependencyClauseIds: string[];
  }>;
  aggregateRoute: 'answer-only' | 'execution-only' | 'mixed-rows' | 'clarify' | 'blocked';
  selectedCandidateIds: string[];
  cohortDecision: 'single-v3' | 'not-applicable' | 'clarify' | 'blocked';
  candidateSetDigest: DigestV1;
  bodyDigest: DigestV1;
  createdAt: string;
}
```

The core admission schema applies a hard structural ceiling of `64` to each of `clauses`, `candidates`, `clauseRoutes`, every candidate `clauseIds`, every route `selectedCandidateIds`/`dependencyClauseIds`, and the aggregate `selectedCandidateIds`; required top-level collections are non-empty, while selected/dependency collections may be empty. The retained matcher descriptor may impose lower `maxClauses`/`maxCandidates` values, and the projection program enforces those lower limits plus exact array-count/membership/ordinal relations. No descriptor or input may raise the schema ceiling.

JSON Schema expresses matcher drafts and `InteractionIntentCandidateV1` as closed `oneOf` branches with `additionalProperties=false`; capability fields/ref/digest/target plus exact interval/partial admission are required only in the executable capability branch and forbidden elsewhere. An unavailable current/stable request retains its requested class in the unknown branch, while ambiguous temporal meaning has its own reason and cannot carry a guessed class.

Candidate legality is a closed authority matrix evaluated both on the pure result and again by `goal-matcher-result-admission-projection`:

| Candidate kind | Exact clause/candidate gate | Codes and route |
|---|---|---|
| `informational` | non-empty unique clause set accepted only by the descriptor's bounded informational rules; it contains no operational capability/target/temporal request under that same frozen rule table | `ambiguityCodes=[]`; answer row only, never an execution fallback |
| `operational-unknown` | non-empty unique clause set; the structured clause facts and/or failed Application target/feature admission prove the exact `unavailability` branch | `ambiguityCodes` is the exact singleton `[unavailability.code]`; missing/ambiguous target or temporal intent/class clarifies, target-ineligible/capability-unavailable blocks |
| `operational-capability` | every cited clause exists and has `negated=false`, `modality='question'|'request'|'command'`, `targetCompleteness='complete'`, `temporalMeaning='interval-observation'`; `targetSourceRange` is non-empty, inside one cited clause range and resolves to the one admitted root; temporal/partial fields are exact; no clause anywhere in the same admission may have `negated=true`, `modality='prohibition'|'unknown'`, `targetCompleteness='ambiguous'`, or `temporalMeaning='ambiguous'|'point-in-time-snapshot'|'stable-window'` while aggregate route contains execution—such a mixed message clarifies/blocks before Execution | `ambiguityCodes=[]`; exactly one selected operational candidate; execution route only |

Every clause ID is the exact `semantic-id.clause-ordinal.v1` value derived from its zero-based position in the ordered `clauses` array: `clause.0.v1`, `clause.1.v1`, and so on without leading zeros. The matcher-result and sealed-Admission clause arrays are byte-equal under the mandatory projection, so an ID cannot be regenerated from a different order or moved to another clause. Every clause ID is unique, every candidate `clauseIds` member resolves, every operational clause belongs to exactly one candidate, and every clause route repeats that membership. A prohibition/negation cannot be hidden in an unselected informational row while another row executes. An unknown code, non-singleton/mismatched code, empty positive clause set, overlapping incompatible operational candidate, unsafe clause fact or positive branch with any ambiguity fails the result before target resolution. The sealed Admission may convert a structurally legal positive draft only to its exact target-ineligible/capability-unavailable unknown branch after the frozen resolver/FeatureSet/scope checks; it cannot repair any other illegal matcher result.

The matcher's mathematical input is the exact validated accepted-command body plus the retained descriptor and canonicalization profile as immutable configuration; the command data schema digest equals `GoalMatcherDescriptorV1.inputSchemaDigest`. It emits only `GoalMatcherResultV1`, whose schema digest equals `outputSchemaDigest`. The pure result repeats the computed command/context and descriptor/implementation identities and contains clauses + ordinal candidate drafts, but no store refs, newly allocated admission/candidate IDs, timestamps, feature eligibility or handle-derived target identity. Application first rejects any result that violates the matrix above, then retains it, resolves the exact target source range through the capability's pinned target resolver, allocates IDs/time once, and seals `InteractionIntentAdmissionV1`. The mandatory `goal-matcher-result-admission-projection` relation binds the result's otherwise naked input/configuration digests to the Admission's retained command/matcher refs and proves: command/context/matcher equality; Admission RuntimeFeatureSet equality to the one inside the accepted context; byte-equal clauses; the complete clause/candidate legality matrix; unique contiguous draft ordinals; exactly one sealed candidate per ordinal; matcher binding equality; and no semantic field change. A positive operational draft becomes a capability candidate only when target resolution, that frozen RuntimeFeatureSet, accepted scope and static contract all admit it; otherwise it may change only to the exact `target-ineligible|capability-unavailable` unknown branch. Routes are mechanical: informational→answer; missing/ambiguous target or temporal intent and unavailable temporal class→clarify; ineligible target/capability→blocked; admitted operational capability→execution. Aggregate/cohort/selected IDs are the deterministic reduction of those rows, with at most one and exactly one selected operational candidate whenever execution is present. No other Application interpretation is legal.

Every candidate matcher binding must equal one exact member of `matcherContracts`; core-read has exactly the closed ID/version pair `workspace.storage.audit.intent-matcher.v1@1`, never a free-form matcher namespace. Each matcher `bodyRef/bodyDigest` resolves to the allowlisted `GoalMatcherDescriptorV1`, and the repeated ID/version/schema/implementation fields MUST byte-match that body. `matcherResultRef/digest` resolves the one result and its dedicated domain digest. Every operational capability ref resolves to the allowlisted `AgentCapabilityContractV1` and equals `RuntimeFeatureSetV1.coreCapabilityContractRef/digest`. Static core eligibility is reproduced solely from that retained RuntimeFeatureSet/contract and accepted AuthorityScope; there is no hidden cohort-policy/catalog/eligibility body. Core source contains exactly one message: `inputMessageId` MUST equal the message ID inside the cited accepted command and every clause range/target source range is relative to UTF-8 bytes of that exact persisted payload `content`; no second message digest/owner exists. `bodyDigest` uses manifest digest metadata; `candidateSetDigest` uses domain `candidate-set` over ordered clauses, canonical-set candidates, clause routes, selected IDs and cohort decision. Full bounded result/admission bodies are stored by `ImmutableContentRefV1`; digest-only admission is invalid. The fixture appender seals result + Admission + `interaction.intent-admitted` atomically; a crash before that commit may recompute the same pure result and allocate fresh uncommitted IDs, while after commit every retry returns the retained IDs/time/bodies. Disposition and Goal Compiler accept only exact admission body/ref/digest. Crash/contract upgrade cannot trigger raw-text reparse or committed-admission resealing; missing/corrupt history fails `admission-history-unavailable`.

`aggregateRoute='mixed-rows'` means independent informational rows plus at most one selected `workspace.storage.audit.v2` operational candidate. Core has neither V2, split cohort, catalog nor model variants. Product coexistence decides legacy routing outside this schema and may never reinterpret a V2 result as V3. One Interaction may link multiple immutable V3 Executions over time through follow-up/retry, so a future product projection uses ordered `executionLinks[]`.

#### Native Admission V5 target-resolution candidate — 2026-08-30

The isolated V5 candidate embeds `targetResolution` in Admission; there is no new independent
eligibility authority or orphan request/receipt schema. The field is required and nullable:
null for nonoperational input or unavailable capability; otherwise it owns matcher ordinal,
positive safe-integer attempt ordinal, capability ref, resolver descriptor digest, exact UTF8
source range/raw-path digest/byte length, contextual request digest and a closed outcome
(`admitted` + full target binding, or `ineligible` + null binding). Timeout/unknown is NOT
silently converted to ineligible; pending/indeterminate precommit recovery is not implemented
by this candidate. Attempt ordinal validation is not monotonicity/CAS proof.

Request digest uses domain `admission-target-request` and schema argument AdmissionV5 over
Admission/Interaction IDs, accepted-command/matcher-result/runtime refs and request fields,
excluding outcome/requestDigest. The outcome and request are sealed together by Admission
body identity; V5 candidate-set identity also includes `targetResolution` as its eighth field.
No V4 digest reinterpretation is permitted. All four affected schema owners are versioned
(Admission5, AuthorityProfile4, FeatureSchemaManifest5, RuntimeFeatureSet5), inventory remains
66 schemas. This closure does not regenerate executable ID-rule/ABI/root instance authority.

Initial admission may recognize source and resolve a target before its single commit. Cold
read of a committed selection MUST NOT call the recognizer or resolver again. It validates
selected immutable bytes and their refs, checks source ranges by bounded byte slicing (not
NL recognition), and mechanically reduces the stored structured matcher result. A separate
read-only Python process has exercised this against a small marked SQLite fixture. Its
external checkpoint is a test-controller trust anchor, NOT Monarch Store membership, native
CommitGroup/event adjacency or historical implementation admission. The database cannot
supply its own trusted checkpoint. Self-consistent alternate target/outcome bytes can pass
structural semantics but cannot replace the externally selected committed snapshot.
Detailed evidence and remaining native authority/recovery gates are in Migration.

#### Admission5 ID identity transfer and clause-reference obligation — 2026-08-30

Changing an endpoint owner's schema version changes its allocated rule ID. A schema-string
replacement alone is insufficient: recompute endpoint rule identities and every incoming
ownerRuleId/ownerRuleIds link, reject collisions/dangling links/cycles. The isolated transfer
candidate enumerates169 Admission5 ID endpoints (125 inherited,44 added,10 old removed),
including targetResolution and five candidate branches. Both selectedCandidateIds occurrence
rules name all five candidate ID owners; execution eligibility is still checked separately.
Other owners are identity-rebased, NOT asserted to have a completely reconciled new surface.

This candidate is NOT an installable authority shard. Eight copied clause-reference
classifications still use the legacy containing-array ordinal profile: four candidate
clauseIds branches, operationClauseId, sourceFactBindings.clauseId, clauseRoutes.clauseId and
dependencyClauseIds. Those are uses of a clause ID, not allocations. In the retained106
scenarios,87 of436 valid references differ from their containing-array ordinal. A lexical
clause-ID match or rehashed rule cannot certify membership or the intended operation.

Required next semantic contract: allocation occurs only at clauses[*].id; references resolve
inside the exact selected immutable Admission, not another Admission with equal clause IDs.
sourceFactBindings also bind factOrdinal to the selected matcher result's matching clause;
operationClauseId must select its operation fact, and dependency/route bindings must preserve
the structured decision. The member profile/dialect, its schema-owner versions and generated
state-commit programs must be lowered together. Do not reinterpret the old ordinal profile,
cast semantic IDs into opaque-ID references, or silently treat template classifications as
validated. Existing decision checks do not close the missing native authority contract.

#### Owner-local clause-member semantic candidate — 2026-08-30

The eight obligations above now have an isolated executable semantic candidate, not a native
Store admission. Their classification is exactly `{kind:'semantic', rule:'owner-local-member',
profileId:'semantic-id.admission-clause-member.v1'}`. The original ordinal profile and allocation
at clauses[*].id are unchanged. The extension is an exact required `semanticProfileExtensions`
member of AuthorityProfile5's root variant, schema-pinned to the complete closed profile body.
It is not a detached mutable registry. AuthorityProfile4 cannot accept the new classification;
AuthorityProfile5, FeatureSchemaManifest6 and RuntimeFeatureSet6 are versioned together, with
66 schemas retained. No complete root instance or ABI/state-commit cohort is materialized here.

The profile selects clauses[*].id in the exact selected Admission5; its typed source is that
Admission's immutable MatcherResult3 ref. Missing/cross-owner lookup is forbidden. Limits:
8 clauses,2 candidates,520 facts per clause,512 fact bindings. Admission/result clause arrays
are equal; allocations remain canonical ordered clause IDs. Every candidate clause set matches
its selected draft. Positive operationClauseId owns the one operation-bearing clause, not
necessarily one verb: the supported scan-plus-measure compound request must remain valid.
sourceFactBindings resolve exact fact ordinals and equal the selected structured fact set;
negative/ambiguous/unparsed facts cannot become positive authority through an ID substitution.
Routes remain in source order, with exactly the operation anchor selecting work and other
contributing clauses represented as dependencies, not duplicate invocations.

Read-time validation performs no recognition or target lookup. Native shape/digest/ref selection
precedes the pure member check. A different Admission with equal local IDs can independently
have valid semantics; substituting its body under the original selected ref MUST reject. Both
Node and Python exercise that distinction,106 retained scenarios and16 native-valid resealed
mutations. This closes the eight semantic-lab obligations, not the new AuthorityProfile owner's
whole ID surface, generated member-check instructions, native root/index/commit adjacency,
live capability/scope/OS authority or product activation. Migration records exact evidence.

#### Initial Admission commit-selection gate (isolated candidate, 2026-08-30)

`astra-v3-admission-commit-gate.mjs` binds member validation to the pending initial event,
not a caller-supplied `verified` flag. A controller-captured synthetic accepted cursor and
Admission5 ref precede event selection. The gate checks native Event2 shape, one-event group,
revision/sequence/predecessor/correlation, event-payload and CommitGroup2 digests, exact captured
Admission ref, payload projection, recomputed candidate-set digest and command/context binding.
It then resolves that Admission's exact MatcherResult3 and runs the member checks inside apply.
Only after validation does the synchronous private model publish accepted→routing plus one
event. Exact canonical-event-byte retry returns the old receipt without reads/member checks; conflicting retry
rejects. Injected failure before publication leaves the cursor/event state unchanged.

The selected plan contains seven explicit compound review stages, NOT lowered primitive ABI
instructions. No new opaque semantic opcode is claimed complete. Native Store/index membership,
actual predecessor history, cross-process CAS, crash durability, full capability/target/scope
admission and follow-up remain unproved. The synthetic cursor MUST NOT hide the ordinary V2 G1
predecessor defect. This gate does not replace the old event programs or authorize dispatch.
The prepared parent has three relevant initial-admission programs without an explicit
Admission-body selection; both their exact raw hash and manifest pin are checked before this
diagnostic is reported. Migration records the independent replay and bounds.

#### New-root surface inventory and unresolved authority (2026-08-30)

The identity-transfer/member layer does NOT cover the whole new root cohort. The exact
AuthorityProfile5, FeatureSchemaManifest6 and RuntimeFeatureSet6 owners have zero rules in the
transferred native rule set. Legacy RuntimeFeatureSet1 external rules do not prove coverage
of their new versions. Moreover AuthorityProfile5 still declares3617 rules while the current
transferred candidate already has3651, before materializing the missing root rules.

`astra-v3-native-root-surface.mjs` now inventories all reachable scalar schema alternatives,
not only fields guessed to be IDs, and records reference envelopes, fixed tuples and nested
literal containers. Node/Python agree on4254 scalar alternatives,1431 ID-like candidates,
77 reference alternatives,39 tuple schemas and10 constant containers. These are schema
locations across branches, NOT4254 runtime fields or1431 automatically justified new rules.
Analysis selectors preserve exact tuple indices, local/external schema locations and oneOf
branches. They are NOT native ID endpoint syntax. Do not fold heterogeneous tuple positions
into one each-array-item or silently discard IDs inside semanticProfileExtensions const data.

Reference role shapes are measured, not granted authority. Unknown applicators, open objects/
arrays, ref overlays/cycles and malformed ref envelopes reject instead of losing coverage.
An immutable-ref schema descriptor in Manifest.schemas is not itself a reference envelope.
Four source-drift controls detect extension omission, missing objectId, widened manifest target
and changed root rule count. Full root rule classifications, reference owners and branch/tuple
lowering remain open; changing a count or relabelling this inventory as an authority shard is
forbidden. Product, Store and coherent ABI readiness remain false.

#### Explicit root-reference role guards (2026-08-30, pre-lowering candidate)

`astra-v3-root-reference-roles.mjs` defines all77 observed reference roles: five exact shard
slots, three Manifest refs, three Runtime refs and66 exact schema slots. The five shard body
variants and the authority root variant are distinct even though their schema ID is shared.
Schema slots require their exact describedSchemaId; the entire registry must be covered.
Unknown/moved/duplicate roles reject. Role IDs and location strings are internal guard-plan
identities, not new native ID rules, wire selectors or opaque permission grants.

Manifest.canonicalizationProfileRef and transportLimitProfileRef currently admit broader
native schemas than their actual roles. Native schema acceptance of a Transport ref in the
canonicalization slot, or Capability ref in the transport slot, MUST NOT confer validity.
The new guard requires canonicalization-profile.v1 / transport-limit-profile.v1 respectively,
instance content and protocol-body purpose. It verifies the controller-selected exact ref,
generation, record identity/metadata/length, schema/body domain digests, native body shape and
the exact root/shard variant. JSON-schema records must equal the captured schema document and
root-meta digest. Strict-parser null-prototype maps are safely copied for Ajv const validation;
the parser and its limits remain unchanged. Store ordinal/role metadata is not copied into RefV2.

Node/Python prove68 positive edge checks:66 native schema objects assembled in memory and two
existing retained instances (Capability4 and Transport1). Nine remaining positive role cases
are explicitly absent: five shards, authority root, manifest, certifier and canonicalization.
Ten mutations reject, including both broad-schema wrong-target controls. These are typed-edge
checks, NOT authentication of owner root bodies or committed membership. Root ID rules, count
reconciliation, primitive lowering and full ABI/Store cohort admission remain open.

#### Containing-owner content binding (2026-08-30, isolated candidate)

`captureOwner` verifies an exact controller-captured root reference, its record/schema/body
identity and native shape, then privately snapshots that body. A bound role check selects its
child reference from this snapshot at the compiled exact location; callers cannot substitute
a child ref or a role belonging to another owner. This is content binding, NOT proof that the
controller selected an authorized or committed Store root. Public plan/caller mutations do not
change the captured selection. Selectors remain internal and are not a native endpoint ABI.

Runtime repeated digests, Manifest schema/authority descriptors and Profile shard descriptors
must agree with their selected bodies. Shard identityCanonicalBytes counts canonical body JSON
WITHOUT bodyDigest, not the larger transport record or the framed digest input. Shard payload
length, instruction total and array hash are recomputed; matching false declarations in a
descriptor and target are insufficient. Profile ID and shard count must match the owner.

Node/Python independently check68 selected edges using two SHARED synthetic native-schema owner
witnesses (Manifest6/Runtime6); eight additional owner mutations reject, including resealed
native-valid wrong digests and typed targets. Unresolved sibling refs remain unresolved; these
witnesses are not inserted into the retained DB and do not close any of the nine missing target
roles. Profile/shard selection and descriptor arithmetic have unit-shim coverage only, not a
native coherent-cohort proof. Native ID authority/ABI, Store/CAS/crash and product gates remain
open.324 focused tests pass; exact execution evidence is recorded in Migration.

#### Exact selector dialect candidate (2026-08-30, not installed native ID ABI)

`astra-v3-exact-selectors.mjs` introduces a separate versioned, registry-bound selector IR.
It does not overload nativeRuleId or reinterpret retained wildcard/property endpoints.
Each selector binds its owner, complete canonical schema-registry digest, dialect digest and
ordered typed steps into a domain-separated `exact-selector.*.v1` identity. The four steps are:

- `property {name}`: an actual named object field, including literal names `0` and `*`;
- `array-index {index}`: an exact closed tuple/constant-array position, never a numeric name;
- `each-array-item`: a bounded homogeneous array, not a heterogeneous fixed tuple;
- `schema-branch {index}`: a particular oneOf branch at the CURRENT instance occurrence.

Branches are interpreted against the bound schema, not concatenated variant-name strings.
The whole captured owner must validate before any result is returned; ambiguous/invalid oneOf
bodies reject. A valid inactive branch or absent optional property yields zero occurrences.
Object/ref role checks require EXACTLY one occurrence, so zero never means fallback selection.
Returned occurrence paths preserve concrete typed array indices for later correlation.
Local/external refs retain their schema-root context; constant containers remain literal data.
Audit locations are compiled only after branch location, target location and shape checks.

Owner bodies/compiled steps/schema registry are captured; returned data and public binding
descriptors are detached. Depth-first selection avoids intermediate fan-out tables. Limits:
128 steps,100000 visited work items, existing strict input-parser ceilings, and4MiB canonical
result bytes checked before retaining each output occurrence. This is a SERIALIZED result
limit, not a4MiB process-heap/RSS guarantee. No partial result escapes on limit failure.

The77 root-role checks now use this compiler/selector instead of ad-hoc string-pointer walks.
Independent Node/Python compilation agrees for all4254 inventoried scalar alternatives and
the77 role bindings. On the two existing shared synthetic owner witnesses,1573 leaf selectors
yield1490 scalar occurrences with identical typed paths/values. These are structural selectors,
NOT4254 ID rules,1431 justified ID classifications, or a completed authority cohort. Profile/
shard native execution, semantic owner allocation, ABI/index/count integration and Store
membership remain open.341 focused tests pass; Migration carries the exact artifact pins.

#### Root ID ownership and local Manifest symbols — isolated candidate, 2026-08-30

`astra-v3-root-id-ownership.mjs` classifies all1431 reachable ID-like scalar alternatives
of the three selected root schemas into18 explicit semantic categories. The134 policy entries
use owner plus typed selector paths; tuple positions are generalized only after schema-proven
array typing. Object names that look like positions remain object names. Unknown ID fields and
opaque-ID patterns assigned to semantic-symbol slots fail closed. Typed Ref fields retain their
exact root-role binding. Every category has `mintsOpaqueId:false`: this inventory introduces
ZERO opaque allocations in the examined root bodies, not a claim that Astra needs no ID allocator.

Schema references, Store-object/generation references, local definitions/references, binding
programs/rules, semantic profiles, event variants, commit occurrences and capability members
have different resolution authorities. A program-local instruction slot is not an opaque ID.
Classification does not establish that a referenced member exists or grants any permission.
Independent Node/Python traversal agrees over the SAME pinned policy; this is not an independent
semantic audit of that policy, nor installation of native endpoint/rule/VM authority.

`verifyManifestLocalSymbols` is a separate local namespace check. Its caller MUST authenticate
and select the owner first; generic `captureOwner` does not automatically run this check.
It checks unique definition names, exact schema/content-identity coverage, descriptor links,
digest schema/domain membership, bidirectional guard/invariant links and transition guard links.
Native JSON Schema alone does not reject two distinct rule objects sharing the same ruleId.
The nonempty native-shaped witness checks71 local references and rejects five resealed,
native-schema-valid substitutions in both implementations. Its binding-rule and event-variant
references remain TWO explicit external obligations. Empty native rule arrays are not treated
as evidence of nonempty semantic validation.

`allReferencesResolved`, `digestAndTransitionSemanticsProven`, `nativeAuthorityInstalled`
and `dispatchAllowed` remain false. JSON-pointer validity for an operation, digest semantics,
event/state-machine meaning, external ABI membership, Store membership and permission proofs
are separate obligations. Nine missing native positive targets and3617/3651 native rule-count
reconciliation remain open.358 focused tests pass; exact pins and scope are in Migration.

#### Event-symbol binding and surviving legacy binding references — 2026-08-30

An event type is not an exact variant ID: `completion.certified` has three distinct variants.
The isolated event-symbol index reconstructs Event2/CommitEventDigestBody2 from the pinned
event-schema source, with ONLY four explicit V1-to-V2 schema replacements (Event, CommitEvent
digest body, immutable Ref and embedded InvocationTransition). Full native schema equality,
including branch order, nested payloads and all required fields, precedes symbol registration.
Each symbol binds schema owner, normalized source variant, exact selector and branch digest.
The source's colon-to-dot mapping is explicit; incoming reference text is not normalized or
guessed. A matching name from another schema or an older registry cannot satisfy the reference.

Node/Python agree on80 schema-qualified symbols and80 native-valid synthetic body selections.
The additional Manifest fixture resolves four event/endpoint references, checks73 local links
and retains one unresolved binding reference. Four native-valid substitutions reject, including
an event-type alias for a variant and a transition whose trigger type contradicts its variant.
This proves symbol/shape binding, NOT event history, state-machine transitions or digest meaning.
Other schema variant indexes remain explicit unresolved obligations, not ambient lookups.

**Confirmed migration defect:** the authority-root replacement removed `Manifest.bindingRules`
and per-schema bindingRuleIds, but guardRules/commitInvariantRules still contain bindingRuleIds.
Those formerly named a local relation object with left/right endpoints; the active ABI names
programs with instructions/scope. There is no established name-to-program equivalence.
The earlier classification `selected-binding-abi` names the intended resolution dependency,
not proof that such a resolver or mapping exists. Even a real programId in bindingRuleIds MUST
remain unresolved. Do not restore the removed legacy interpreter or silently alias namespaces.

Final opcode review also corrects the prior ownership policy:18 instruction ruleId alternatives
refer to digest rules, not binding rules. The classifier now requires an enclosing supported
digest opcode (`assert-domain-digest`, `assert-shared-domain-digest`, or
`assert-domain-digest-resolved-object`); unknown operations reject even at the same path.
Current ownership has19 categories: binding-rule-reference2 and digest-rule-reference18,
with the other counts unchanged. The earlier18-category artifact is historical and superseded.
This correction reinforces that two engines sharing a policy do not independently audit its meaning.

The next coherent root/ABI revision MUST explicitly replace or lower these references from
source-authored guard/invariant contracts, bind exact program identity/content/set and validate
its scope and relationship to the guard. Mere program-index membership is insufficient.
Version affected native owners together and retain historical replay identities; do not patch
Manifest6 in place. Current isolated inspection always reports full authority/dispatch false.

#### Current-schema program binding candidate — 2026-08-30

Before guard lowering, the actual157-program parent set was compared with the selected native
schemas. Seven programs failed the current grammar: accepted-context Runtime ref, five Runtime
programs (canonical sets, certifier/capability/Manifest refs and self digest), and completion
request-freeze. They contained29 references to Runtime3/Manifest3/Capability3, now replaced by
Runtime6/Manifest6/Capability4. Parent root still pins the former projection ABI; therefore
current schemas and that unchanged ABI do not by themselves form an executable coherent cohort.

`astra-v3-program-binding-candidate.mjs` verifies parent ABI digest and every indexed program's
content, performs only the three explicit schema-ID replacements at reviewed operand/literal
positions, then validates all157 programs against the selected native grammar. Unreviewed text
positions reject.150 programs remain byte-identical; seven changed bodies receive deterministic
new IDs. The candidate records old/new body hashes and all29 changed locations. Both engines
derive the same candidate and157-program/1830-instruction set. This is not an installed ABI.

Exact selection binds candidate programId, program set, full body hash and exact declared scope;
caller mutation cannot redirect captured selection. It does NOT prove that a selected program
implements a guard's required relation. `rootAbiReplacementRequired` remains true, while
source-authored guard relations, digest-rule definitions, full native authority and dispatch
remain false. Pointer/operation semantic coverage and the earlier missing Admission-body checks
are not repaired by replacing schema IDs. Do not patch the old ABI digest or native Profile5
in place: coherent versioned root/shard/ABI integration is the next separate obligation.

#### 2026-08-30 — Partial native ABI/schema/program-shard closure

`astra-v3-binding-abi-closure.mjs` composes the reconciled157-program candidate into
`monarch.astra-v3-native-binding-abi.v1`, with Profile6/Manifest7/Runtime7 schemas. Exactly3
owners are versioned; the other63 documents remain byte-identical. Four native program shards
contain157 programs/1830 instructions/41 operations. This is an isolated candidate, not an
installed authority cohort: the fifth (ID) shard and root instances are not constructed.

The digest dependency is acyclic: pinned predecessors -> ABI/program index -> final root
schema -> external `monarch.astra-v3-final-schema-binding.v1`. The ABI names schema versions
but cannot contain the digest of the final registry whose root embeds that ABI digest.
The separate binding commits the66 schema body digests, ABI, program index and four shards.
Neither self-consistent hashes nor structural verification establish authenticated authority;
the runner reconstructs from pinned prepared inputs and an exact read-only DB checkpoint,
then independently rebuilds the complete candidate in Python.

All activation, dispatch, Store membership, constructed-root, guard-relation, digest-definition
and ID-resolution flags remain false. Profile6 still declares3617 ID rules; the current ID
candidate has3651. This is an explicit open reconciliation, not a count-only schema patch.
Four Profile6 program shards do not close old Profile5/Manifest6/Runtime6 reference-role tests
or their nine missing positive targets. Required source-authored semantic relations, initial
Admission-body checks and actual Store/CAS/crash behavior remain independent work.

#### 2026-08-30 — Full ID-rule grammar reconciliation, separate from root ID coverage

Checking all3651 current rules (not just the eight clause-membership changes) found152 rejected
by the current Profile5 rule grammar inherited by Profile6:32 reference-set and120 reference-
union classifications still face old owner-rule enum values after endpoint/schema-ID remapping.
`astra-v3-id-reference-grammar.mjs` derives a **detached** prospective grammar, changing only
the four ownerRuleIds array schemas (two kinds in two rule branches). Allowed owners come
from the reconstructed rules:32 set owners and42 union owners; max128 is retained and duplicate
owners are rejected. No installed/versioned Profile schema or rule content is modified.

This grammar is only representation validation. An owner selection can satisfy its enum while
being wrong for a particular endpoint. A separate private exact-content index binds each rule
ID to its complete expected body, rejects grammar-valid classification swaps, and verifies full
set membership without relying on input order. All current and117 retained owner references
are traversed for missing targets/cycles. Pinned predecessor reconstruction remains required;
source semantic correctness is NOT established by a self-hash or a terminating reference graph.

The3651 rules cover19 non-root schema owners and zero current Profile/Manifest/Runtime owners.
Consequently3617->3651 is not a final root-shard count migration. Root semantic fields must be
lowered with exact typed selectors and correct reference/symbol classifications before deriving
the final count. This prospective fragment must be integrated into a newly versioned coherent
ABI/schema cohort; do not overwrite Profile5/6 or declare their native grammar fixed in place.

#### 2026-08-30 — Exact root ID-rule candidate preserves exhaustive coverage

The exhaustive application-map requirement in the ID section is NOT waived for roots.
Profile6/Manifest7/Runtime7 contain1431 ID-like scalar alternatives in19 semantic categories;
none mints an opaque ID. `astra-v3-root-id-rule-candidate.mjs` materializes a prospective
`monarch.astra-v3-root-id-rule.v1` for each alternative: exact owner/selector identity,
constraint digest, reviewed classification/authority and content-derived rule ID. Its selector
index retains property, fixed array-index, each-array-item and explicit schema-branch steps.
Names, numeric object keys, tuple positions and mutually exclusive branches are not conflated.

This new rule format is deliberately NOT accepted as legacy `ProtocolIdFieldRuleV1`. It is an
isolated candidate with a closed native grammar and exact private body index; union/cohort
integration requires a versioned contract. Neither1431 nor3651+1431 is automatically the final
installed count. The future combined schema must itself pass exhaustive endpoint enumeration.
Missing/duplicate rules, grammar-valid selector/classification substitutions, opaque allocation
and shards outside the selected ABI cohort reject. Root-owner mapping admits exactly the old
Profile5/Manifest6/Runtime6 and new Profile6/Manifest7/Runtime7 cohorts, never guessed families.

On all four actual native program shards,6257 selected ID occurrences are unique by concrete
instance path.2895 have schema/profile/exact-program membership checks;3362 remain explicitly
unresolved (variants, occurrences, owner sets, digest rules, contract members and local slots).
Membership checks do not prove execution semantics. Root/ID-shard/Manifest/Runtime instances,
their Store references and semantic resolution remain separate gates; no activation is allowed.

#### 2026-08-30 — Source/native event namespaces and occurrence ownership

`astra-v3-program-event-bindings.mjs` binds actual program references to the pinned event
schema source and30 commit-shape definitions (44 occurrences). Protocol variant names such as
`completion.certified:blocked` and native branch names such as `completion.certified.blocked`
are distinct namespaces. Resolution uses their explicit catalog pair; arbitrary colon/dot
normalization, event-type aliases and cross-schema substitution are not accepted.

Event projection scopes must select the corresponding AgentEvent/CommitEvent branches. Commit
shape scope and ordered-variants instructions must match the source's complete order and native
branch indices. Occurrence scopes bind shape, position and variant. Endpoint role constrains its
schema and permitted scope. Source-defined first-event commit/command owners and immediately
previous causation/correlation owners are preserved: cross-occurrence access is not an arbitrary
same-group lookup. Completion certified/terminal pairs must agree with verdict and a source
commit shape; request links retain their correct freeze/assessment/commit roles.

The157 actual programs now resolve2201 variant references and771 occurrence references in both
Node and independent Python.78 non-event variants remain explicitly unindexed:12 TypedValue,
6 AgentCommand and60 CompletionAssessment references. This is source/reference consistency,
not execution of all instructions, validation of all JSON pointers or proof of historical
Store ownership/CAS/retry behavior. Native authority and product activation remain forbidden.

#### 2026-08-30 — Required digest operations, not merely resolvable rule names

A valid rule name MUST NOT substitute for the required operation. The isolated digest-binding
checker derives the required event scopes from the pinned event/envelope source and the four
completion bindings from reviewed compiler semantics. It checks exact operation bodies and
coverage: 30 commit digests, 44 payload digests and four completion digests across 123 scopes.
Missing/duplicate operations, missing/duplicate scopes and source/result/domain/schema/omission
substitutions are rejected. The two completion-commit digest operations retain their relative
order; this is not proof of ordering against every other instruction or actual atomic execution.

There are 45 distinct rule IDs. Fifteen retained digest operations without rule IDs remain
outside this new check. No Manifest rule index is installed or authenticated by this checker;
caller selection of the native cohort remains mandatory. Hash computation, resolved-object
Store selection, canonical byte handling and runtime execution are separate acceptance gates.
`requiredDigestCoverageVerified=true` MUST NOT imply `digestExecutionProven=true` or completion.

#### 2026-08-30 — Required claim relationships and verdict policy

The isolated claim-binding checker pins the claim-member profiles and assessment source AST.
All three assessment scopes MUST retain the exact claim-selector bijection, verdict policy and
claim ordering checks; request-freeze MUST retain the exact requirement/attempt/invocation fence.
Removing an operation or entire required scope, duplicating it or permuting valid selectors is
not allowed. Ten operations bind 172 member references to 28 source claim-selector pairs and
one source requirement. This is not capability-instance membership or evidence-value proof:
selected native Capability/ClaimTemplate bodies and actual evidence relations remain mandatory.

#### 2026-08-30 — Exact selected contract instances, not same-name substitutions

The isolated instance-binding pass links the checked program-member contract to the exact
Capability v4 selected by the pinned synthetic Admission v5, then resolves ClaimTemplate v1
objects through their complete immutable references. Source Capability v1 member profiles
retain their explicit lineage; this is not an implicit version alias or Runtime-root admission.
Descriptor IDs/digests, recipe membership, selector self-digests, source-schema digests and
presentation-contract digests MUST agree. Valid objects exchanged under the original descriptor
IDs are rejected even when schema validation and the recipe's unordered digest set still pass.

Selectors have two legitimate source roles:25 capability-output and3 evidence-node in this
corpus (completeness, evidence-proof-digest, walk-verdict). Resolve both selected schema objects;
do not flatten evidence-derived claims into raw output. This verifies selected synthetic member
ownership, not selector path/value semantics, verified verdicts or execution authority.

#### 2026-08-30 — Values derived from the exact selected synthetic contracts

The companion value probe reuses the existing isolated claim-derivation engine with an explicit
Capability v4 anchor selected independently from the pinned Admission v5. The v3 default is
retained for legacy callers; unknown versions and v4 without an anchor MUST fail before reads.
Selected Capability, recipe and28 templates are resolved unchanged, never regenerated to fit
the proposed result. Only ordinary synthetic execution/evidence bodies are created in memory.

Node independently derives84 bindings over three cases and validates111 native bodies. Preserve
`4103`, exact wide integer `9007199254740993`, and partial observation; missing values MUST NOT
be defaulted to zero. Resealing a typed value does not make it agree with its evidence source.
Strict JSON parsing precedes the plain-record compatibility conversion required by Ajv;
canonical bytes must remain identical across that conversion.

This establishes synthetic selector/value derivation, not accounting-proof validity, clock
freshness, admitted goal membership, committed-event membership, Runtime-root authority or a
final verdict. The source-only and instance-only reports retain their original narrower scope.

#### 2026-08-30 — Schema-valid budget is not workload admissibility

The exact selected synthetic budget is a minimum schema witness: positive limits1, depth0.
It is native-valid but does not admit the existing completed/cancelled storage transcripts.
The accounting companion resolves that same budget from Capability v4; replacing it with the
old simulator's larger budget is forbidden. Python and Node reject all three cases, identifying
11 exceeded dimensions each. Claim values may still be derived; accounting acceptance and final
completion MUST remain false. An unrelated schema/transcript/clock failure is not evidence of
the expected budget rejection and MUST retain its own failure reason.

This is not a blanket prohibition on small budgets: a deliberate restrictive budget may be valid
and require a correctly accounted refusal/incomplete outcome. Do not blacklist the number1 or
silently raise a limit. Completed and cancelled within-limits observations cannot conceal prior
budget exhaustion. A new positive operational fixture needs an explicitly authored budget with
known provenance and a new coherent dependent cohort, not mutation of the old checkpoint.
Synthetic transcript summaries do not authenticate broker execution or measure resident memory.

#### 2026-08-30 — Explicit positive budget proposal without replacing old evidence

`astra-v3-synthetic-read-budget.v1.json` owns a separate synthetic workload profile, with parent
Capability/budget digests and provenance from the existing bounded fixture. It is not a product
default or measured resource recommendation. The additive memory-only compiler creates five
objects in typed order: budget→budget ClaimTemplate→VerificationRecipe→Capability→proposed
Admission. Template predicate, recipe membership, capability references and Admission target-
request/candidate-set/body digests are recomputed; no global string rewriting or old-object edit.

Node/Python independently compile byte-identical proposals and rerun claim-instance/accounting
checks against the new selected contracts. This permits three synthetic accounting observations,
not a committed admission, authenticated target observation or final Completion. The copied target
observation is explicitly simulation-only; a real new request requires fresh target admission.
The old minimum-budget cohort and its rejection tests remain unchanged. All new references are
memory-lab objects only; borrowing the fixture generation field does not create Store membership.
Other abort/refusal branches, goal/event membership and Runtime-root authority remain mandatory.

#### 2026-08-30 — Late I/O result exclusion and truthful forced cleanup

The isolated accounting oracle now executes the closed `time-limit:io-return` branch. The
request was already admitted/issued, so its I/O and return checks remain counted and rejected
admission counters remain zero. Its late metadata buffer is observed for response accounting
but discarded before entry admission, length accumulation or evidence inclusion. No normal
operation may follow the refusal. This is distinct from a per-I/O timeout and pre-dispatch refusal.

The transcript records the first elapsed-limit crossing, exact discarded request ordinal and
synthetic process-exit cleanup. Outstanding handles released at exit do not increase issued
`closeHandle` counts. The bound proof requires forced termination for this scenario, partial
observation and `limit-refused`/`not-cancelled` terminal markers. A time-limit witness cannot claim
a detection later than the proof's finished monotonic interval. The default completed/cancelled
oracle does not silently accept the new trace mode or unknown abort types.

This proves synthetic late-result exclusion/cleanup accounting, not actual Windows process
termination, fresh clock provenance, new target admission or the goal's permission to accept
partial results. Those remain separate gates; the caller must not promote a partial observation
to Completion merely because the refusal and cleanup were correctly accounted.

**Selected source partial gate (2026-08-30, isolated only).** Partial permission is derived
from the exact selected Admission v5, its own MatcherResult v3 and owner-local fact bindings.
The retained ordinary command has no `partial-allow` fact: its only correct policy is
`forbid/default-forbid`. Candidate, matcher draft, requirement and overall-policy agreement
alone is insufficient: jointly changed copies must still be rejected against the selected
source. Explicit prohibitions retain their provenance; quoted informational permission is
not an operation-owned permission. Do not re-recognize raw command text at completion.

The existing goal-policy oracle now has an explicit selected-v4 source gate. Five native bodies
(Admission, result, command, matcher descriptor, Capability) are resolved against full immutable
refs; the positive synthetic budget proposal keeps the original command/result unchanged.
Before applying the partial rule, join the independently checked accounting proof to the same
receipt/measurement/evidence and Capability, including proof digest/ref, clocks, completeness
and byte accumulator. Matching array positions or matching `partial` labels is not this join.

`complete-observation`, `disclosed-partial` and `blocked` here are local partial-gate outcomes,
never Completion verdicts or permission to publish claims. The terminal `blocked` mapping is
a local contract rule, not an admitted Certifier instance. Whole Goal/semantic/input/authority
membership and committed source selection remain mandatory. The legacy mode-driven v3 Goal
fixture remains an isolated primitive, not evidence that the selected v4 Goal graph exists.

**Whole-Goal foundation correction (2026-08-30).** The pinned replay Admission's frozen
RuntimeFeatureSet ref identifies the historical wire schema `monarch.runtime-feature-set.v3`,
not an admitted current runtime. Its exact2329B object can be reconstructed from prepared
sources, but it selects Capability v3, whereas both the existing ordinary replay candidate
and positive-budget proposal select different Capability v4 objects. Recovery is not migration.
Neither graph contains GoalContract v2, GoalAdmissionBinding v2 or GoalSemanticBody v2 instances.
The root-selected historical Certifier and temporal comparator contain all-zero implementation
hash witnesses; finding their bodies does not prove an executable implementation.

The current partial ABI owner declares Profile v6 / Manifest v7 / RuntimeFeatureSet v7.
These are wire-schema versions within Astra V3, not another product/runtime generation.
Use the schema IDs exported by the ABI owner and verify they exist in its constructed schema
closure. Do not use an intermediate component RuntimeFeatureSet v4 as the current target.
The source-specific whole-Goal component preflight rejects old runtime roles before resolution,
requires exact runtime-to-selected-Capability binding, rejects placeholder Certifier hashes and
selects the terminal policy only through that Certifier. Even nonzero hashes do not attest code;
manifest/authority/implementation/Goal admission remain separate mandatory checks.

Required transition: first construct a coherent non-retained current root/manifest/authority/
Capability/Certifier cohort; then create a NEW synthetic command acceptance bound to it, its
matcher result and target-admission evidence; then derive Goal/source/semantic/input bindings.
Reusing the user's request text must not mean reparenting its old accepted-command identity.
Never merge reconstructed historical objects into the replay DB, edit frozen context refs,
or manufacture Goal/Certifier membership from schema-first witness selection.

#### Current component cohort — assembled, not admitted (2026-08-30)

`astra-v3-current-component-cohort.mjs` now assembles an actual in-memory object graph:
38 exact selected positive-budget Capability dependencies plus4 native Profile6 program
shards, against the same66-schema P6/M7/R7 registry. This is still **Astra V3**. The38-object
branch is closed and typed:3 schema documents,28 ClaimTemplates,5 policies/profiles,
VerificationRecipe and Capability.34 objects are reused byte-for-byte;4 positive-budget
objects and4 program-shard objects are new. No old admission, command, runtime, target or
placeholder Certifier is imported into this candidate.

The frozen component reader exposes `verifyCapability` (38 reads/93298 canonical body
bytes) while retaining the full existing40-read target-inclusive check. Exact object
inventory, duplicate IDs, nested unowned references, native schemas, generation, reference
metadata, content identities, schema/program binding and externally supplied source
anchors are checked. The source anchors must come from the pinned loader; caller-created
anchors plus self-hashes do NOT establish provenance. The assembled bundle has no roots,
and missing ID shard/root/manifest/runtime/implemented Certifier/new acceptance/whole Goal
remain explicit. Program bodies being native-valid does not close unresolved semantic
references or prove execution of all programs.

The cheap `verify-astra-v3-current-component-cohort.mjs` runner consumes exact prepared
inputs and the pinned synthetic replay DB, deriving only projection-program evidence,
not reconstructing the historical root graph. It returns a report; the1879933B candidate
exists only in memory, with701755 canonical record-body bytes. There is no retained write,
Store admission, product/shadow activation, fresh target permission or completion verdict.
Assembly verification is Node-side; existing independent source/seal checks must not be
reported as an independent Python verifier of the newly assembled whole candidate.

#### Prior-event owner references — source operations and synthetic execution (2026-08-30)

The56 `owner-set.all-core-event-ids.v1` references now have a source-owned required-operation
check in `astra-v3-prior-event-bindings.mjs`. The pinned envelope grammar determines28 first
internal event scopes; ingress-command and later-occurrence links are not silently treated
as prior-commit references. Each scope must contain both exact operations in order:
`assert-prior-event-reference` on `/causationId`, then `assert-prior-event-field-equal`
using that same causal event's `/correlationId`. The40-member native event namespace comes
from the checked source-to-schema projection, not a caller-provided owner-set name.

`freezeSyntheticPrefix` implements those two relations on copied, bounded synthetic data.
It validates native event bodies and payload digests, rejects duplicate event IDs and
inconsistent commit-ID/ordinal mappings, selects the exact causation ID (not the latest or
first event), requires a strictly earlier commit and equal correlation, and checks the
current native occurrence index against the selected program scope. Ordinals are canonical
uint64 decimal strings compared with BigInt; JS numbers are not accepted. Prefix budget:
at most128 prior events and4MiB canonical input. No provider callback or ambient read exists.

Node/Python agree on28 native synthetic cases/56 executed operations, including ordinal
values above2^53; Python also rejects7 corrupted prefixes. This proves only the two
relations under supplied synthetic order metadata. It does NOT authenticate a retained
prefix, validate full commit shapes/digests or state transitions, prove payload references,
install an ID-rule shard, or fix the real V2 predecessor gap. Remaining symbol inventory
is derived from current programs:78 non-event variants and6 local slots. Root authority,
Certifier, new acceptance and whole Goal remain open; historical140-observation reports
are preserved as historical, not rewritten into this narrower evidence.

#### Non-event variants and projection locals (2026-08-30)

The current component programs now bind78 non-event references to11 native branches
(TypedValue1 semanticType, Command2 type, AssessmentBody2 verdict) in6 exact source
program scopes. Full native-body selection is required; a known variant string alone is
insufficient. Projection programs bind6 contract declarations and24 consumers in9 scopes,
with source/scope checks before resolver reads. The isolated evaluator now respects the
declared slot ID instead of unconditionally assigning contract. Native grammar already
fixed that ID, so this is evaluator consistency, not a reproduced product vulnerability.
Both the pinned base presentation source and its exact existing frozen-reader overlay
are supported; arbitrary resealed overlays are rejected.

Together with the previous56 causal-owner links this checks140 selected observations,
NOT all instructions or root authority. Python independently checks the11 native branch
index entries and grammar witnesses only; Node owns scope/slot semantics. Witnesses
(including distinct assessment claim bindings) are not evidence-derived certification.
No Store, whole Goal, Certifier, product/shadow or real Computer Use readiness is claimed.

#### Native ID/root schema bridge (2026-08-30)

A NEW non-retained wire cohort Profile7/Manifest8/Runtime8 (still product Astra V3)
replaces the three prior root owners together. Prior Profile6/Manifest7/Runtime7 bodies
and schemas remain unchanged. Native binding ABI2 admits five actual shard bodies:
one ID shard and four retargeted program shards,157 programs/1830 instructions.

The ID shard separates3651 pinned legacy idFieldRules from1435 exact-selector rootIdRules.
ruleCount and root/descriptor declarations are5086; legacyRuleCount/rootRuleCount and both
array lengths are native-constrained. ruleArraySha256 hashes the canonical object with
BOTH arrays, not a concatenation or just the legacy array. This is a new ABI hash-input
contract: old readers must not silently consume this shard. Body identity retains the
protocol-authority-profile domain with the NEW schema version.

The1435 rules are derived from FINAL schema structural coverage, including four ID fields
in the new root-rule container. The exact false boolean metadata mintsOpaqueId is not an
ID; only that reviewed field is excluded and changing its closed false constraint rejects.
A cheap preliminary count is not evidence: final full ownership compilation must match.
Selectors bind the complete final registry after counts and ABI digest are installed.
Registry-dependent selector/rule hashes stay OUTSIDE the ABI and its embedded grammar;
the external report binds them, avoiding a self-hash cycle.

All66 schemas compile and all five bodies pass native validation, with each body <=4MiB.
The source constructor pins prior ABI AND external schema binding,3651 lowered rules and
117 retained owner rules. Exact-selection verification is relative to these captured inputs,
not trust from a self-hash. Source semantic classifications, full instruction semantics,
root objects/manifest/runtime instances, Certifier, Store membership and activation remain
unproved. No new accepted command or product/shadow runtime is created.

#### Native authority root construction and frozen readback (2026-08-30)

The pinned five-shard ABI2 cohort now feeds a real native Profile7 root BODY in an
isolated six-record candidate. The synthetic root uses authorityEpoch0 (no retained epoch
advance). Deterministic lab object IDs are collision-checked against the pinned fixture;
they are NOT Store-issued IDs. No old acceptance, target, schema version or record is
rewritten. The schema-index, ABI content and all five shard identities are pinned first.

The root binds exact ordered descriptors, including identityCanonicalBytes computed over
the body with only bodyDigest omitted. exactShardDescriptorDigest hashes descriptors
WITHOUT shardRef, matching the existing protocol convention. Both-rule-array hashing for
the ID shard is explicit ABI2 behavior; legacy-array-only hashing rejects. Native/full-ref
checks require exact generation/object/schema/schema-digest/content-digest/length/private
classification/protocol-body purpose and closed envelopes. Six distinct reads exhaust the
captured six-record pool; hidden/duplicate/missing records reject. Final total5086 rules,
157 programs1830 instructions agrees with native root declarations. Captured input and
selected root reference are copied privately before readback.

This proves only the selected synthetic root graph and native bodies. It does NOT prove
committed root authority, execution of all semantic rules, RAM/runtime budgets, Manifest,
Runtime, Certifier or whole Goal. Historical Manifest builders contain empty guard/state/
commit tables and a fabricated multisegment digest witness; these must NOT become the
new source-authored Manifest. Next required work is explicit guard/digest/state/commit
lowering from reviewed protocol/source contracts, with actual bindings, before Manifest.
A nonzero hash of a partial checker cannot substitute for the complete Certifier.

#### Explicit core state policy and symbolic atomic execution (2026-08-30)

The reviewed finite section5 expansion is now represented explicitly in
`config/agent-architecture/astra-v3-core-state-policy.v1.json`:40 event rows and their
guard relations. Compiler `astra-v3-core-state-policy.mjs` pins this source, the existing
40-event source and30-shape envelope. It emits42 state rules (presentation expands into
three same-state rules),40 guard relation descriptors, and derives12 Invocation transitions/
reason sets from the original payload definitions. All8 relation names must match exactly.

The pure session executes ONLY closed synthetic-core-commit-symbols inputs, not native
events. It starts absent, applies one complete named commit shape atomically, checks
revision/owner/state/reason and the linked Invocation state, and commits neither state
when any suffix fails. There is no queued state. Unknown Invocation outcome remains running/
indeterminate; it cannot reach evidence, certification or a fabricated terminal failure.
Evidence/completion and the input/evidence-integrity failure paths require the settled
Invocation stage in this isolated policy. Completion also needs an evidence variant;
presentation needs the matching prior certificate variant. These are symbolic prerequisites,
not proof of receipt/evidence/certificate truth or the complete guards.

The terminal-specific typed-suffix relation takes precedence over the general Invocation
lifecycle relation; Invocation state checks still run for those rows. Noncertified blocked
requires the appropriate immediate Goal/Invocation prefix and exact reason equality.
All sessions are bounded128 commits/512 events, with copied source/input/output state.

Guard bindingProgramsResolved/bindingProgramsExecuted remain FALSE, even for empty
requiredBindingRoles arrays. The two named accepted-command-receipt roles remain unresolved;
program IDs are not aliases for the removed binding-rule namespace. The42 state rules must
NOT be imported as a complete executable Manifest. Next: derive facts from full native
event/commit bodies, verify refs/digests/snapshot/CAS semantics, and bind every guard to
exact selected programs before forming Manifest or runtime authority.

#### Native-body to core-state adapter (2026-08-30, isolated only)

`astra-v3-native-core-commit.mjs` now accepts complete native event bodies, not
caller variant/shape/reason labels. It pins the exact unchanged Event2,
CommitEventDigestBody2, CommitGroupDigestBody2 and full ImmutableContentRef2 schemas
from the existing synthetic registry, then verifies Event2 projection against the
pinned source. Exactly one native branch determines each variant; the ordered
variant list determines one of30 whole commit shapes. Interaction IDs follow the
native `turn_` grammar, derived from the schema rather than an invented prefix.

Before the existing atomic reducer is called, checks cover payload and ordered
group digests, aggregate/payload identity, shared group metadata, contiguous
sequence/revision/index/size, session-local event/commit/command uniqueness,
stable correlation, immediate intra-group causation, ingress command-ID equality,
and Invocation identity/from/to/expected/resulting revision. Ref2 structure,
selected generation and4MiB reference length ceiling are checked without reads.
The reducer and all adapter metadata change only after the complete group passes.
Failed groups consume neither IDs nor revision. Session starts absent, with zero
sequence/revision; native counters remain safe JSON integers, not uint64 strings.
Invocation creation has revision0; the normal settled path reaches revision5.

This is native-body **state projection**, not native event **admission**. References
in tests are native-shaped witnesses, not resolved objects. An external prior
event may still be missing; only its lexical role/not-current-group property is
checked. Receipt/certificate contents, accepted-command membership, exact guard
programs, Store CAS and crash/retry durability remain unproven and explicitly false.
The in-process4MiB input cap is not a pre-allocation network parser guarantee.
The isolated session rejects duplicate commands; it is NOT the future idempotent
appender. All30 shapes/40 variants are exercised, but this does not close whole Goal.

#### Executable event programs and private synthetic predecessor index (2026-08-30)

`astra-v3-core-event-programs.mjs` composes the native adapter with execution of the
exact existing114 event programs/1376 instructions/12 operations. Its set is pinned
to `bdb5bc439c527796481d04e2f56713297a89f7b8a5d2aeb0ea94c355621217b5`; event programs
remain byte-identical through current native-root retargetings.40 guard IDs map to
44 occurrences, each requiring exact projection/occurrence/group program selections
with programSet, ID, content hash and scope. No caller-selected program list exists.
These are mandatory **event-envelope obligations**, not complete guard definitions.
Both accepted-command-receipt roles and every other semantic guard obligation remain
unproven; old binding-rule IDs are still not program aliases.

The executor evaluates the actual fixed instruction bodies: literal/equality,
ordered variants, count/index/shared-field/contiguous sequence, payload/group digest,
fresh-ID and both prior-owner operations. It validates ten exact native schemas:
the four event/Ref schemas plus complete AgentCommand2/CompletionCommitAssessment2
owner closure. Required command owner must match the exact native branch and program
operands; an unnecessary owner is rejected. Native shape is NOT retained authority.

Each isolated session owns its aggregate sessions, global fresh-ID sets and compact
prior-event index. Only successfully applied whole groups publish eventId,
correlationId and local commit ordinal into that index. First internal causation
must select an existing earlier event with matching correlation; neither a missing
owner nor a failed/current/future group can become a predecessor. Selection does not
mean "latest": an older matching event remains valid after an unrelated later one.
No input prefix, ordinal, resolver or callback can replace the private index.
All program checks run before the native adapter/reducer; any failure publishes
nothing. Bounds128 total groups/512 events apply across the whole session, not per
aggregate only. Raw event/owner bodies are not retained in this index.

`syntheticPriorMembershipChecked` now proves that limited local relation, while
`priorCausationAuthenticated`, native admission, reference contents, retained owner
authority, full guard execution and Store/CAS/crash/idempotency remain false. The
standalone native adapter remains structural-only and is not silently promoted.
This composition must still bind receipt/certificate/ref contents and real selected
authority before it can admit a whole Goal or resolve the actual V2 predecessor gap.

#### Resolved command/receipt ingress in the isolated core (2026-08-30)

`compileIngressReceiptBindings` composes the event-program executor with exact full-ref
resolution for four objects: AgentCommand2, CommandReceipt1, CommandDedupeRecord2 and
CommandDedupeScopeBody1. Four additional pinned schemas bring this closure to14.
Both submit/follow-up derive their owner from the acceptedCommandRef; an independently
supplied command owner is rejected. Record order is irrelevant. Native schema, schema
digest, domain content digest, canonical byte length, classification/purpose/generation
and every reference field must agree before its body can participate in a binding.

The two ingress roles bind command/client IDs, singleton event receipt/revision/time,
Interaction/correlation, full dedupe-to-receipt reference, provisioned installation/
principal scope, accepted context digest and independently recomputed request fingerprint.
Follow-up additionally binds target/revision/message. Scope/client keys and accepted
command IDs cannot be reused across session aggregates. Only byte-identical retained
objects can share an object ID; exactly four packet objects must be consumed.
All checks precede the event programs/native reducer; failed groups publish no records,
keys, IDs or state. Limits:4MiB canonical packet,4MiB retained record envelopes,512 objects;
these are data bounds, not a whole-process RAM or authenticated transport guarantee.

Descriptor1574B/`98b5b9dbff0efabbd295bd2b8bb5ed6394ae0e6f3d26e3459b8efbff9bf3ec43`.
Only `ingressReferenceContentsVerified` and `ingressReceiptProjectionVerified` are scoped
positive results. Context root references/principal authentication, complete native guards,
Manifest/Runtime/Certifier, durable retry receipt return and dispatch remain unproven.
This is append duplicate rejection, NOT an implemented idempotent client retry API.

The next boundary was reproduced through this composed session: two execution streams
can still reach Invocation `prepared` with the same Invocation ID and a nonexistent
resultingInvocationRef, with zero supplied Invocation bodies. Global `referenceContentsVerified`
and `nativeEventAdmission` correctly remain false. Close this with full Invocation snapshot
resolution, cross-execution identity ownership and immutable request continuity before
claiming a whole Goal; a valid event envelope/state transition alone is insufficient.

#### Native Invocation snapshots now bind the isolated execution state (2026-08-30)

`compileInvocationSnapshotBindings` composes the preceding ingress/program/native
state path with five additional unchanged native schemas (nineteen total): Invocation2,
InvocationTransition2, DispatchKeyBody1, WorkspaceStorageAuditInput3 and CanonicalWindowsPath2.
It requires one full body record for every Invocation transition; absent/extra records,
wrong full refs/schema/domain hashes/bytes and snapshot ID/execution/correlation/state/
revision disagreement fail before any state publication. This supersedes the preceding
missing-snapshot/shared-Invocation-ID diagnostic, not the broader admission limitations.

Execution creation binds a locally accepted/open Interaction. Snapshot creation copies
the exact Execution runtime/parent and co-committed Goal refs/IDs/digests. Each Invocation
ID belongs to one Execution; each dispatch attempt is fresh once and stable thereafter.
Every snapshot field except lifecycle/stateRevision/bodyDigest remains byte-identical
across transitions. Canonical input and dispatch-key bodies/digests are recomputed;
nested ref generations/digest projections, budget/root copies, receipt-link full-ref
identity and subsequent receipt continuity are checked. Referenced Goal/runtime/target/
authority/receipt contents are NOT thereby authenticated or resolved.

All checks precede the existing programs and reducer. Late program/reducer failures
leave snapshots, global IDs, object identities and state unchanged. A common object-ID
namespace covers ingress and snapshots; different bytes cannot reuse a committed ID.
Only latest full snapshots plus old record hashes are retained. Canonical packet and
cumulative declared-object bytes are each capped at4MiB, identities at512; these are
laboratory data bounds, not physical Store durability or whole-process RAM guarantees.
The new validator uses `inlineRefs:false` without changing native schema bytes or rules.

Descriptor1116B/`4df0c21c1cf9faa00ef45676035aef21c252275c5905142c110588946872ff28`.
54 new tests +175 lower-layer tests PASS. All12 native transition branches are exercised;
the composed trace applies15 groups/18 events/six snapshots and reaches synthetic
settled5/completed with `invocationAuthorityVerified`, `kernelReceiptContentsVerified`,
`nativeEventAdmission`, complete guards and dispatch still false. Next resolve actual
KernelReceipt bodies and result/proof contents before claiming verified outcomes.

#### Kernel receipt and output/proof bodies in the composed lab (2026-08-30)

`compileKernelReceiptBindings` adds six unchanged schemas to the snapshot-bound path
(twenty-five total). Each receipt-linked group must supply its exact native Receipt2
body; completed additionally requires native Output3 and AccountingProof3 bodies.
Full private protocol-body refs, schema/content identities, bytes, generation and all
record consumption are checked before publication. Failed/cancelled/unknown cannot
manufacture output/proof objects; optional diagnostics stay non-authoritative/unread.
Receipt IDs are unique within the session and object identities share the ingress/
snapshot namespace. Receipt Invocation/attempt/key/capability/input and lifecycle
disposition must match the existing dispatched snapshot, not caller replacement data.

Completed output/proof refs and result schema bind to the frozen Invocation. Target,
policy/budget/root/volume projections, proof attempt, logical-byte/count copies,
receipt/proof/output references and interval/clock-label continuity are compared.
Calendar validation reuses `epochMilliseconds` from the independent accounting oracle.
The resulting decision is private: a schema-valid projection mismatch can be observed,
but MUST move through output-rejected with `output-binding-mismatch`; output-checked/
settled are rejected. A matching projection cannot fabricate that rejection. Invalid
immutable body/schema/identity fails before observation; no fake admitted invalid native
instance is created merely to exercise `output-schema-rejected`. That raw-result/error
boundary still needs coherent Kernel admission/recovery integration.

Only receipt/result/proof BODY identity/structure and the listed cross-object copies
are verified. `kernelReceiptOriginAuthenticated`, `traversalAccountingVerified`,
`clockAuthorityVerified`, complete guards/native admission/dispatch remain false.
Counter agreement is not a transcript, ceiling, filesystem or authenticated-clock proof.
The existing result-admission-projection simulator is for MATCHER results, not Kernel
output; it is not reused as an output oracle. The real accounting oracle still requires
the exact selected budget, transcript and clock anchors before it can be composed here.

43 new +229 prior tests PASS; all seven native receipt structural branches exercised.
Direct synthetic trace:15 groups/18 events,three resolved Kernel bodies,13 identities,
72721 declared canonical record bytes. Descriptor1513B/
`89ebcc3d82b31d7a9f287294baa09ec9a03c14a346dffabb3b5fda27fe0d247e`.
No real Kernel call, broker observation, physical transaction or completed Goal is proven.

#### Frozen budget and synthetic accounting composition (2026-08-30)

`compileAccountingBindings` composes the preceding layers with the unchanged native
Budget2 schema (26 exact schemas total). Session construction freezes a full private
budget reference/body and provisioned assessment clock. Every Invocation and transcript
must retain that exact budget; its object ID is reserved across all packet record pools.
No budget is widened on rejection. The retained minimum witness has maxFileEntries=1,
maxDepth=0, maxIoOperations=1 and maxResidentBytes=1; it rejects the positive trace.
The existing synthetic-read budget proposal is a separate object, not a product default
or a newly admitted Capability/Runtime root.

A completed Kernel receipt now also requires an owner-bound, domain-hashed transcript
of at most256 events. Existing independent Python controls feed the Node accounting
oracle; counters, exact wide-integer totals, sequential I/O elapsed time and resource
ceilings must agree with the native proof. Receipt admission precedes the provisioned
assessment, which precedes the observation event. Only completed, cancelled and explicit
time-limit-on-return proofs are supported; this does not cover all14 proof dispositions.
Accounting state is published only after the entire inner commit succeeds, and returned
projections are copies. Checked/settled require the prior private accounting observation.

The constructor budget/clock and synthetic transcript are NOT authenticated authorities.
Resident-byte counts are supplied synthetic observations, not measured process RAM.
`syntheticAccountingChecked=true` never promotes `traversalAccountingVerified`, native
admission, complete guards, Store commit or dispatch: these remain false. Partial traversal
is recorded as partial, not as whole-Goal success. Completion still needs independent
Goal policy/evidence/assessment/certificate bindings before a real terminal claim.

323 focused tests pass on explicit Node22.23.1 (41 accounting composition,10 oracle,
272 lower-layer tests). Next compose the existing Completion obligations with these
private observations, preserving partial/refusal outcomes and the unresolved native
authority roots; do not add another disconnected happy-path simulator.

#### Evidence-to-Completion input fence in the composed route (2026-08-30)

`compileCompletionInputBindings` adds five unchanged native schemas (31 total):
EvidenceNode2, EvidenceGraphSnapshot2, EvidenceAdmissionKeyBody2,
RequirementAttemptSelection2 and CompletionAssessmentInput2. Evidence projection must
resolve the actual private node body and match the successfully settled Invocation,
receipt/output/proof refs and digests, recipe digest, observed times and private accounting
completeness/walk verdict. The admission key is recomputed in its own domain. Partial
accounting cannot be relabelled complete, including at a later `verified` terminal event.
This necessary single-core restriction is NOT sufficient Goal/Certifier certification.

Completion request consumes three actual bodies: graph, single-attempt selection and
assessment input. Its graph member must be the node admitted by the prior applied event;
cutoff is the actual prior execution sequence, not an arbitrary nonnegative counter.
The graph's first revision is1. Selection and input bind the exact settled snapshot/ref/
state revision, admitted Goal/runtime/scope/recipe copies from that Invocation, capability,
single requirement, frozen assessment clock and the request commit's resulting revision.
Request IDs and reserved future terminal command IDs are session-global and immutable.
Another execution cannot consume the reserved command. Terminal owner/event IDs and
input ref must match that fence; execution/revision/input/declared-assessment-body fields
of the certification key are compared and its domain-separated digest is recomputed.

Body/ref checks use the shared immutable-ID namespace, maximum512 identities/4MiB
declared records, and publish only after the inner whole commit succeeds. APIs return
copies. This is in-memory atomicity, not durable append/retry/CAS. Projector/selector
contract bodies, Goal admission and policy roots, predicates, assessment body contents,
certificate contents and execution authority are still unresolved. A well-formed
`application-kernel` label or agreeing declared assessment hashes cannot establish them.
Partial/blocked routes remain available but their policy choice is not certified yet.

40 final focused tests pass. The preceding358-test/9-suite regression also passed;
the final five added cases and terminal-key changes were then checked in the40-test
suite without rerunning unchanged lower layers. Next resolve native assessment and
certificate bodies against this frozen input and derive claims/policy from their actual
sources; do not copy the older first-candidate assessment acceptance gap.

### 9.2. Goal and capability ABI

The generated protocol package MUST expose the following closed types. These definitions own the explanatory mirrors in Runtime §10/§11.

```ts
type StorageTemporalClassV1 = 'interval-observation';

type CoreClaimTemplateIdV1 =
  | 'storage.abort-reason' | 'storage.accounting-proof' | 'storage.budget-profile'
  | 'storage.clock-class' | 'storage.completeness' | 'storage.error-count'
  | 'storage.evidence-proof-digest' | 'storage.exclusion-policy' | 'storage.exclusion-summary'
  | 'storage.finished-at' | 'storage.inclusion-policy' | 'storage.logical-bytes'
  | 'storage.metric-id' | 'storage.mutation-detection' | 'storage.nonprotected-exclusion-count'
  | 'storage.reparse-encountered-count' | 'storage.reparse-excluded-count'
  | 'storage.root-finish' | 'storage.root-start' | 'storage.skip-count'
  | 'storage.started-at' | 'storage.temporal-class' | 'storage.visited-directory-count'
  | 'storage.visited-file-count' | 'storage.volume-finish' | 'storage.volume-start'
  | 'storage.walk-verdict' | 'storage.walker-disposition';

type CoreSelectorIdV1 = `selector.${CoreClaimTemplateIdV1}.v1`;

type CorePresentationTemplateIdV1 =
  | 'presentation.storage.audit.en.blocked.v1'
  | 'presentation.storage.audit.en.partial.v1'
  | 'presentation.storage.audit.en.verified.v1'
  | 'presentation.storage.audit.ru.blocked.v1'
  | 'presentation.storage.audit.ru.partial.v1'
  | 'presentation.storage.audit.ru.verified.v1';

interface SelectorDescriptorBaseV1 {
  schemaVersion: 'monarch.selector-descriptor.v1';
  id: CoreSelectorIdV1;
  source: 'capability-output' | 'evidence-node';
  sourceSchemaDigest: DigestV1;
  jsonPointer: string;
  bodyDigest: DigestV1;
}

type SelectorDescriptorV1 = SelectorDescriptorBaseV1 & (
  | { valueType: 'boolean'; canonicalEncoding: 'json-canonical' }
  | { valueType: 'safe-integer'; canonicalEncoding: 'json-canonical' }
  | { valueType: 'integer-decimal'; canonicalEncoding: 'base10-integer' }
  | { valueType: 'decimal-string'; canonicalEncoding: 'base10-decimal' }
  | { valueType: 'string'; canonicalEncoding: 'json-canonical' }
  | { valueType: 'object'; canonicalEncoding: 'json-canonical' }
);

type TypedValueLiteralV1 =
  | { schemaVersion: 'monarch.typed-value-literal.v1'; valueType: 'boolean'; canonicalEncoding: 'json-canonical'; value: boolean }
  | { schemaVersion: 'monarch.typed-value-literal.v1'; valueType: 'safe-integer'; canonicalEncoding: 'json-canonical'; value: SafeCounterV1 }
  | { schemaVersion: 'monarch.typed-value-literal.v1'; valueType: 'integer-decimal'; canonicalEncoding: 'base10-integer'; value: string }
  | { schemaVersion: 'monarch.typed-value-literal.v1'; valueType: 'decimal-string'; canonicalEncoding: 'base10-decimal'; value: string }
  | { schemaVersion: 'monarch.typed-value-literal.v1'; valueType: 'string'; canonicalEncoding: 'json-canonical'; value: string }
  | { schemaVersion: 'monarch.typed-value-literal.v1'; valueType: 'object'; canonicalEncoding: 'json-canonical'; value: StorageExclusionSummaryV2 };

Selector/Literal→certificate conversion is the exact one-to-one table below; generated schemas and Projector fixtures reject every cross-row combination:

| Selector/Literal valueType + encoding | `TypedValueV1.semanticType + encoding` |
|---|---|
| `boolean + json-canonical` | `boolean + json-canonical` |
| `safe-integer + json-canonical` | `safe-integer + json-canonical` |
| `integer-decimal + base10-integer` | `integer + base10-integer` |
| `decimal-string + base10-decimal` | `decimal + base10-decimal` |
| `string + json-canonical` | `string + json-canonical` |
| `object + json-canonical` | `object + json-canonical`, only exact `StorageExclusionSummaryV2` |

type GoalConstraintV1 =
  | { kind: 'authority-scope'; bodyRef: ImmutableContentRefV1; bodyDigest: DigestV1 }
  | { kind: 'target-identity'; binding: IntentTargetBindingV1 }
  | { kind: 'temporal-intent'; value: 'interval-observation' }
  | { kind: 'budget'; bodyRef: ImmutableContentRefV1; bodyDigest: DigestV1 };

interface GoalCompletionPolicyV1 {
  mode: 'all-required';
  overallPartial: 'forbid' | 'allow-if-each-requirement-allows';
}

interface GoalSemanticBodyV1 {
  schemaVersion: 'monarch.goal-semantic-body.v1';
  requirements: [GoalRequirementV1];
  constraints: [
    Extract<GoalConstraintV1, { kind: 'authority-scope' }>,
    Extract<GoalConstraintV1, { kind: 'target-identity' }>,
    Extract<GoalConstraintV1, { kind: 'temporal-intent' }>,
    Extract<GoalConstraintV1, { kind: 'budget' }>
  ];
  completionPolicy: GoalCompletionPolicyV1;
  bodyDigest: DigestV1;
}

interface GoalAdmissionBindingV1 {
  schemaVersion: 'monarch.goal-admission-binding.v1';
  acceptedCommandRef: ImmutableContentRefV1;
  acceptedCommandDigest: DigestV1;
  acceptedContextDigest: DigestV1;
  presentationLocale: 'ru' | 'en';
  admissionId: string;
  admissionRef: ImmutableContentRefV1;
  admissionBodyDigest: DigestV1;
  selectedCandidateId: string;
  runtimeFeatureSetRef: ImmutableContentRefV1;
  runtimeFeatureSetDigest: DigestV1;
  matcherRef: ImmutableContentRefV1;
  matcherBodyDigest: DigestV1;
  matcherImplementationHash: ImplementationHashV1;
  capabilityContractRef: ImmutableContentRefV1;
  capabilityContractDigest: DigestV1;
  completionCertifierContractRef: ImmutableContentRefV1;
  completionCertifierContractDigest: DigestV1;
  targetBinding: IntentTargetBindingV1;
  temporalClass: 'interval-observation';
  temporalAdmission: 'explicit-interval';
  partialPolicy:
    | { mode: 'forbid'; admission: 'default-forbid' | 'explicit-forbid' }
    | { mode: 'allow-disclosed'; admission: 'explicit-allow-disclosed' };
  acceptedAuthorityScopeRef: ImmutableContentRefV1;
  acceptedAuthorityScopeDigest: DigestV1;
  goalAuthorityScopeRef: ImmutableContentRefV1;
  goalAuthorityScopeDigest: DigestV1;
  traversalBudgetProfileRef: ImmutableContentRefV1;
  traversalBudgetProfileDigest: DigestV1;
  inclusionPolicyRef: ImmutableContentRefV1;
  inclusionPolicyDigest: DigestV1;
  exclusionPolicyRef: ImmutableContentRefV1;
  exclusionPolicyDigest: DigestV1;
  semanticBodyRef: ImmutableContentRefV1;
  semanticBodyDigest: DigestV1;
  bodyDigest: DigestV1;
}

interface DeterministicGoalMinimumV1 {
  schemaVersion: 'monarch.deterministic-goal-minimum.v1';
  id: string;
  executionId: string;
  admissionRef: ImmutableContentRefV1;
  admissionBodyDigest: DigestV1;
  candidateSetDigest: DigestV1;
  admissionBindingRef: ImmutableContentRefV1;
  admissionBindingDigest: DigestV1;
  matcherRef: ImmutableContentRefV1;
  matcherBodyDigest: DigestV1;
  matcherImplementationHash: ImplementationHashV1;
  semanticBodyRef: ImmutableContentRefV1;
  semanticBodyDigest: DigestV1;
  bodyDigest: DigestV1;
}

interface GoalSourceBindingV1 {
  acceptedCommandId: string;
  acceptedCommandRef: ImmutableContentRefV1;
  acceptedCommandDigest: DigestV1;
  admissionId: string;
  admissionRef: ImmutableContentRefV1;
  admissionBodyDigest: DigestV1;
  candidateSetDigest: DigestV1;
}

interface GoalContractV1 {
  schemaVersion: 'monarch.goal-contract.v1';
  id: string;
  executionId: string;
  revision: 1;
  source: GoalSourceBindingV1;
  runtimeFeatureSetRef: ImmutableContentRefV1;
  runtimeFeatureSetDigest: DigestV1;
  capabilityContractRef: ImmutableContentRefV1;
  capabilityContractDigest: DigestV1;
  completionCertifierContractRef: ImmutableContentRefV1;
  completionCertifierContractDigest: DigestV1;
  admissionBindingRef: ImmutableContentRefV1;
  admissionBindingDigest: DigestV1;
  semanticBodyRef: ImmutableContentRefV1;
  semanticBodyDigest: DigestV1;
  deterministicMinimumRef: ImmutableContentRefV1;
  deterministicMinimumDigest: DigestV1;
  compiler: {
    matcherRef: ImmutableContentRefV1;
    matcherBodyDigest: DigestV1;
    matcherImplementationHash: ImplementationHashV1;
    canonicalizationProfileId: CanonicalizationProfileV1['id'];
    mode: 'deterministic-local-only';
  };
  bodyDigest: DigestV1;
}

interface GoalRequirementV1 {
  id: 'storage.audit.requirement.v1';
  sourceCandidateIds: string[];
  kind: 'inspection';
  required: true;
  partialPolicy: 'forbid' | 'allow-disclosed';
  capability: {
    id: 'workspace.storage.audit.v2';
    contractVersion: '2';
    contractRef: ImmutableContentRefV1;
    inputSchemaDigest: DigestV1;
    outputSchemaDigest: DigestV1;
    evidenceNodeSchemaDigest: DigestV1;
    contractDigest: DigestV1;
  };
  inputBinding: {
    normalized: WorkspaceStorageAuditInputV2;
    canonicalDigest: DigestV1;
    matchPolicy: 'exact';
    boundJsonPointers: string[];
    allowedNonAuthorityExtraPointers: [];
  };
  claims: GoalClaimV1[];
}

interface GoalClaimV1 {
  id: CoreClaimTemplateIdV1;
  selector: SelectorDescriptorV1;
  classification: 'private';
  predicate:
    | { kind: 'exists' }
    | { kind: 'equals'; expected: TypedValueLiteralV1 }
    | ({ kind: 'integer-range' } & (
        | { minimumInclusive: string; maximumInclusive?: string }
        | { minimumInclusive?: never; maximumInclusive: string }
      ))
    | { kind: 'canonical-path-equals'; expectedIdentityDigest: DigestV1 }
    | { kind: 'digest-equals'; expected: DigestV1 };
  evidencePolicy: {
    acceptedKinds: ['kernel-receipt'];
    acceptedAuthorities: ['application-kernel'];
    requireSettledInvocation: boolean;
    requireCompleteObservation: boolean;
    freshnessAnchor: 'observation-finished' | 'receipt-admitted';
  };
  presentationKey: string;
}
```

Goal `source` MUST bind the accepted command ref/digest and exact persisted admission ref/digest; those two retained bodies transitively bind the one message ID/content bytes, source ranges and candidate set. Candidate ID equality alone is insufficient. Raw user/message bytes remain owned by the Interaction/accepted-command store; Execution/Goal stores only immutable refs/digests and never creates a second prose owner. Core never mutates or revisions a Goal in place: `revision` is the literal `1`; a semantic follow-up creates a new linked Execution/Goal and its provenance is owned by the follow-up decision plus `execution.created.interactionId`, not an optional parent field.

`GoalAdmissionBindingV1` is the exact authority monotonicity witness, not a descriptive snapshot. Application constructs it only after all of these checks succeed: command/context/accepted locale equals Admission source/context; the complete §9.1 candidate-legality matrix has passed over the pure result and sealed Admission; `ambiguityCodes=[]`; every clause in the Admission is execution-safe under that matrix; and the sole selected candidate is the one admitted operational-capability branch. Negation/prohibition/unknown modality or any target/temporal ambiguity anywhere in the same Admission cannot be hidden as an ignored informational row; for every operational clause, missing/ambiguous target, ambiguous/current/stable temporal meaning, an unmatched unknown code or any other ambiguity makes this binding structurally impossible. A bounded independent informational clause may retain its intentionally absent operational target because it contributes no authority and its route remains answer-only. The selected candidate and every contributing operational clause persist `temporalClass='interval-observation'` admitted as `explicit-interval` (current/stable/ambiguous branches are structurally ineligible); its partial policy is either default/explicit forbid or an explicit user allow-disclosed admission, never a compiler default that widens completion; RuntimeFeatureSet refs/digests equal the accepted context, Admission and Goal, its embedded core capability ref/digest equals the candidate/binding/Goal contract, its embedded completion-certifier ref/digest equals Binding/Goal and transitively fixes the terminal policy, and matcher refs/digests/hashes equal that capability's descriptor plus Admission/candidate bindings; candidate target equals the semantic target constraint; requirement input `canonicalRoot.identityDigest` and `rootIdentityDigest` equal that target identity; `acceptedAuthorityScopeRef/digest` equals the accepted command context; and `goalAuthorityScopeRef/digest` is the canonical deterministic intersection of accepted scope with exactly the selected capability, target root/no-follow relation, read/no-provider/no-Safe constants, eligible accepted surface and stricter admitted budget. The Goal authority constraint and every Invocation/Assessment authority ref use only that narrowed Goal scope, never the accepted superset. Requirement partial policy, input temporal class, inclusion/exclusion/budget refs and digests equal the binding/candidate/capability contract; its claims instantiate every and only the capability's fixed `requiredClaimTemplateIds`; `GoalCompletionPolicyV1.overallPartial` is `forbid` unless that same admitted mode is `allow-disclosed`; the semantic budget equals the narrowed scope/capability/input traversal budget; and its semantic body equals the minimum. Empty/incomparable intersection blocks admission. The binding self-digest uses `goal-admission-binding`. `DeterministicGoalMinimumV1`, `GoalContractV1` and `goal.contract-admitted` MUST cite the same binding ref/digest. Invocation input MUST be byte-equal to that retained requirement input; it cannot independently rebuild a target, temporal class or policy. Invocation and Assessment inherit the binding transitively through the immutable Goal; no feature/capability/certifier/terminal-policy, claim, partial, target, temporal, locale or policy substitution can pass by making minimum and Goal agree with each other.

The deterministic minimum is a retained body, not a naked hash. Its `semanticBodyRef/digest`, `admissionBindingRef/digest` and the admitted Goal fields MUST be exactly identical. Admission, compilation event, binding, minimum and Goal compiler fields all repeat the same allowlisted matcher ref/body digest/implementation hash; there is no unlisted compiler-contract body or naked auxiliary contract digest. Any mismatch is `goal-minimum-mismatch`.

Core has exactly one required inspection requirement, so it has no ordering graph, dependency set or prior-evidence importer. Those features require another Goal semantic schema/version rather than optional fields here.

That requirement's `sourceCandidateIds` is the exact singleton `[GoalAdmissionBinding.selectedCandidateId]`; it cannot cite an informational/unknown candidate or hide a second operational source. Its canonical claim set is the exact instantiation of `AgentCapabilityContractV1.requiredClaimTemplateIds`, with every selector/template/body digest equality checked before Goal admission.

`matchPolicy='exact'` requires equality of the entire canonical invocation input and `canonicalDigest`. Core has no generic subset/mapping interpreter and cannot synthesize compatibility semantics. String/path prefix matching is never implied. Empty/missing binding fails `input-binding-undefined`.

`safe-integer` is legal only for fields whose contract proves a closed safe range. Unbounded counters, byte totals, file counts and arithmetic accumulators MUST use `integer-decimal`; adapters reject a `safe-integer` template for them. `integer-range` requires at least one canonical bound and, when both exist, proves mathematical `minimum <= maximum` during Goal admission.

Core claims are unconditional and have no freshness-duration field. Conditional dependency graphs and `maxAgeMs` require a new Goal/Claim schema with a pinned clock owner and generated evaluation program; they cannot leak in as optional fields. Selectors are immutable descriptors: their ID/body digest, exact `capability-output|evidence-node` source, source schema digest, RFC 6901 pointer, value type and canonical encoding are pinned by the capability contract and repeated in the Goal. A capability-output selector must use the contract output schema; an evidence-node selector must use the exact manifest `monarch.evidence-node.v1` schema and one of the recipe-allowlisted derived fields. Absent parent/index is `selector-missing`; arrays use exact zero-based indexes; wildcard/transform/coercion/multi-node reduce is forbidden. Every Goal claim has a unique `presentationKey` in the exact pinned `PresentationContractV1.allowedPresentationKeys`; required keys are its canonical subset. Duplicate/unknown keys deny certification/presentation rather than dropping or merging a fact.

The one core capability contract forbids selectors into diagnostic refs. Object TypedValues are allowed only for the exact bounded public exclusion-summary schema; their generic numeric descendants remain forbidden. The base TypedValue schema has no artifact branch at all, so a diagnostic/artifact ref cannot become a certified field through a permissive shared vocabulary.

### 9.3. Goal compilation boundary

`agent-core-read.v1` has no model-assisted Goal path and no egress during compilation. A deterministic, bounded, statically registered matcher either creates the exact minimum or returns `clarify|blocked`; missing target, temporal class or requested field never falls back to answer-only. A future model-assisted profile needs a new manifest, egress/data-flow/consent binding and a machine-checked monotonicity relation; it cannot appear as an optional field in this schema.

### 9.4. Capability-owned executable contract descriptors

```ts
interface GoalMatcherDescriptorV1 {
  schemaVersion: 'monarch.goal-matcher-descriptor.v1';
  id: 'workspace.storage.audit.intent-matcher.v1';
  version: '1';
  kind: 'registered-pure-matcher';
  bodyDigest: DigestV1;
  inputSchemaDigest: DigestV1;
  outputSchemaDigest: DigestV1;
  implementationHash: ImplementationHashV1;
  tokenizer: 'utf8-unicode-scalar-nfc-whitespace-v1';
  ruleTable: Array<{
    ruleId: string;
    priority: SafeCounterV1;
    fromState: SafeCounterV1;
    tokenPredicate:
      | { kind: 'literal'; utf8: string }
      | { kind: 'windows-absolute-path-token' }
      | { kind: 'end-of-input' };
    toState: SafeCounterV1;
    action: 'none' | 'mark-operational-read' | 'bind-root-source-range'
      | 'bind-explicit-interval' | 'bind-partial-forbid'
      | 'bind-partial-allow-disclosed' | 'emit-clarify' | 'emit-blocked';
  }>;
  acceptingStates: Array<{
    state: SafeCounterV1;
    outcome: 'eligible-single-core-read' | 'clarify' | 'blocked';
  }>;
  limits: {
    maxInputUtf8Bytes: SafeCounterV1;
    maxClauses: SafeCounterV1;
    maxCandidates: SafeCounterV1;
    maxRuleEvaluations: SafeCounterV1;
  };
}

interface ClaimTemplateV1 {
  schemaVersion: 'monarch.claim-template.v1';
  id: CoreClaimTemplateIdV1;
  version: string;
  sourceSchemaDigest: DigestV1;
  claim: Omit<GoalClaimV1, 'id'>;
  presentationContractDigest: DigestV1;
  bodyDigest: DigestV1;
}

interface VerificationRecipeV1 {
  schemaVersion: 'monarch.verification-recipe.v1';
  id: string;
  version: string;
  claimTemplateDigests: DigestV1[];
  projectorId: 'workspace.storage.audit.evidence-projector.v1';
  projectorVersion: '1';
  projectorImplementationHash: ImplementationHashV1;
  capabilityInputSchemaDigest: DigestV1;
  capabilityOutputSchemaDigest: DigestV1;
  evidenceNodeSchemaDigest: DigestV1;
  bodyDigest: DigestV1;
}

interface AgentCapabilityContractV1 {
  schemaVersion: 'monarch.agent-capability-contract.v1';
  id: 'workspace.storage.audit.v2';
  contractVersion: '2';
  runtimeProfile: 'agent-core-read.v1';
  inputSchema: ProtocolSchemaRefV1;
  outputSchema: ProtocolSchemaRefV1;
  evidenceNodeSchema: ProtocolSchemaRefV1;
  requirementId: 'storage.audit.requirement.v1';
  matcher: GoalMatcherDescriptorV1;
  claimTemplates: Array<{
    id: CoreClaimTemplateIdV1;
    bodyRef: ImmutableContentRefV1;
    bodyDigest: DigestV1;
  }>;
  requiredClaimTemplateIds: CoreClaimTemplateIdV1[];
  verificationRecipe: {
    id: string;
    bodyRef: ImmutableContentRefV1;
    bodyDigest: DigestV1;
  };
  targetResolver: {
    id: 'workspace.storage.audit.target-resolver.v1';
    version: '1';
    grammar: 'windows-absolute-path-from-accepted-source-range.v1';
    matcherDescriptorBodyDigest: DigestV1;
    implementationHash: ImplementationHashV1;
  };
  temporalClasses: ['interval-observation'];
  execution: {
    effectClass: 'read';
    mutation: 'none';
    communication: 'none';
    idempotency: 'idempotent';
    approval: 'not-required';
    cancellation: 'cooperative';
    reconciliation: 'not-required';
  };
  walker: { id: 'workspace.storage.audit.walker.v2'; version: '2'; implementationHash: ImplementationHashV1 };
  filesystemBroker: {
    id: 'windows-local-ntfs-read-broker';
    version: '1';
    implementationHash: ImplementationHashV1;
    processProfile: 'kernel-supervised-low-privilege-job.v1';
  };
  adapter: { id: 'workspace.storage.audit.adapter.v2'; version: '2'; implementationHash: ImplementationHashV1 };
  inclusionPolicyRef: ImmutableContentRefV1;
  inclusionPolicyDigest: DigestV1;
  exclusionPolicyRef: ImmutableContentRefV1;
  exclusionPolicyDigest: DigestV1;
  traversalBudgetProfileRef: ImmutableContentRefV1;
  traversalBudgetProfileDigest: DigestV1;
  presentationContractRef: ImmutableContentRefV1;
  presentationContractDigest: DigestV1;
  transportLimitProfileRef: ImmutableContentRefV1;
  transportLimitProfileDigest: DigestV1;
  bodyDigest: DigestV1;
}
```

`GoalMatcherDescriptorV1.bodyDigest` is the self digest of the exact finite descriptor above; the descriptor contains no self-ref, callback, regex engine or hidden rule-table body. The build definition fixes a bounded literal lexicon and the complete deterministic automaton rows; duplicate `(priority,fromState,predicate)`, unreachable states, ambiguous accepting paths or a rule count above `maxRuleEvaluations` fail compilation. Its input schema is exactly the closed accepted-command schema and its output schema is exactly `monarch.goal-matcher-result.v1`; it cannot claim the sealed Admission schema as its own output. The outer `MatcherContractBindingV1.bodyRef/bodyDigest` is the sole retained reference to the descriptor. `registered-pure-matcher` is trusted first-party code only after its exact implementation hash/version, closed limits and fixtures are frozen. It has no store, clock, network, model, Kernel or mutable global access. Target resolution consumes only the matcher-emitted accepted-command source range, executes the one literal grammar, and repeats the exact matcher descriptor body digest that covers the complete rule table; it cannot reparse the whole message or infer a target from ambient workspace state. The first manifest admits exactly one pinned `AgentCapabilityContractV1` instance and no Catalog snapshot/search/inspect dependency. Input/output/EvidenceNode schemas, one matcher, claim templates, verification recipe, target resolver, filesystem broker, walker, adapter, exact inclusion/exclusion/budget policies, presentation and transport limits are retained through allowlisted semantic refs/digests plus the exact raw implementation hashes defined in §2.1. `AgentCapabilityContractV1.requirementId` is the sole owner of `storage.audit.requirement.v1`; the Goal requirement, Invocation, Evidence selection, Completion request/input/denial/assessment and every presentation projection may only repeat that exact member through generated bindings. `AgentCapabilityContractV1.transportLimitProfileRef` MUST be byte-equal to `ProtocolFeatureSchemaManifestV1.transportLimitProfileRef`, and `transportLimitProfileDigest` MUST equal that exact retained profile's schema-selected content identity; an equal-looking second body, a capability-local counter convention or an ambient profile is invalid. The adapter artifact boundary includes Kernel target/policy admission, no-follow broker admission and receipt admission for this capability; it is not merely a DTO mapper. Accounting proof walker and broker hashes MUST equal this contract's pinned hashes; worker self-selection is invalid. `requiredClaimTemplateIds` is a canonical non-empty set equal to the one fixed core claim suite; Goal requirements instantiate every and only those templates. Each ClaimTemplate source digest equals its selector source schema, and the recipe repeats the exact capability input/output and EvidenceNode schema digests; a template cannot reinterpret a raw output pointer as a derived EvidenceNode fact. There is no generic legacy mapping, workflow interpreter or plugin authority in core. Legacy evidence remains diagnostic only. Workflows, effects, catalog discovery, retries beyond a new linked Execution and third-party plugins require separately versioned extension schemas/manifests.

The generated capability assertion program requires `targetResolver.matcherDescriptorBodyDigest == matcher.bodyDigest`; no independent rule-table digest/domain exists. That one descriptor content identity covers tokenizer, every ordered automaton row, accepting states and limits.

The fixed core claim suite is not package-author discretion. Let `O` be the exact manifest digest of `monarch.workspace-storage-audit-output.v2` and `E` the exact manifest digest of `monarch.evidence-node.v1`. Every core `ClaimTemplateV1` has `version='1'`. For every row, template ID = Goal claim ID = `presentationKey`; selector ID is `selector.<row-id>.v1`; `sourceSchemaDigest` is `O` or `E`; `classification='private'`; `condition` and `maxAgeMs` are absent; and evidence policy is exactly `{acceptedKinds:['kernel-receipt'], acceptedAuthorities:['application-kernel'], requireSettledInvocation:true, requireCompleteObservation:true, freshnessAnchor:'observation-finished'}`. `exists` still performs the declared type/encoding check. Static digest predicates are materialized from the already-retained policy bodies before claim/capability digests are computed.

| Fixed row ID | Source | JSON Pointer | valueType / encoding | Predicate |
|---|---|---|---|---|
| `storage.metric-id` | output `O` | `/audit/metricId` | string / JSON | equals `logical-namespace-entry-bytes.v2` |
| `storage.root-start` | output `O` | `/audit/scope/rootIdentityAtStartDigest` | string / JSON | exists; Projector/Input binding owns target equality |
| `storage.volume-start` | output `O` | `/audit/scope/volumeIdentityAtStartDigest` | string / JSON | exists; Projector owns retained volume equality |
| `storage.inclusion-policy` | output `O` | `/audit/scope/inclusionPolicyDigest` | string / JSON | digest-equals capability inclusion policy |
| `storage.exclusion-policy` | output `O` | `/audit/scope/exclusionPolicyDigest` | string / JSON | digest-equals capability exclusion policy |
| `storage.exclusion-summary` | output `O` | `/audit/scope/exclusionSummary` | object / JSON | exists |
| `storage.logical-bytes` | output `O` | `/audit/logicalBytes` | integer-decimal / base10 | integer-range minimum `0` |
| `storage.walker-disposition` | output `O` | `/audit/measurement/walkerDisposition` | string / JSON | exists |
| `storage.temporal-class` | output `O` | `/audit/measurement/temporalProof/class` | string / JSON | equals `interval-observation` |
| `storage.clock-class` | output `O` | `/audit/measurement/temporalProof/clockClass` | string / JSON | equals `kernel-local-attested` |
| `storage.started-at` | output `O` | `/audit/measurement/startedAt` | string / JSON | exists |
| `storage.finished-at` | output `O` | `/audit/measurement/finishedAt` | string / JSON | exists |
| `storage.mutation-detection` | output `O` | `/audit/measurement/temporalProof/mutationDetection` | string / JSON | equals `not-supported` |
| `storage.budget-profile` | output `O` | `/audit/measurement/traversalBudgetProfileDigest` | string / JSON | digest-equals capability budget profile |
| `storage.accounting-proof` | output `O` | `/audit/measurement/traversalAccountingProofDigest` | string / JSON | exists |
| `storage.root-finish` | output `O` | `/audit/measurement/rootIdentityAtFinishDigest` | string / JSON | exists; Projector owns start/finish equality for complete evidence |
| `storage.volume-finish` | output `O` | `/audit/measurement/volumeIdentityAtFinishDigest` | string / JSON | exists; Projector owns start/finish equality for complete evidence |
| `storage.visited-file-count` | output `O` | `/audit/measurement/visitedFileEntryCount` | integer-decimal / base10 | integer-range minimum `0` |
| `storage.visited-directory-count` | output `O` | `/audit/measurement/visitedDirectoryEntryCount` | integer-decimal / base10 | integer-range minimum `0` |
| `storage.nonprotected-exclusion-count` | output `O` | `/audit/measurement/nonProtectedPolicyExclusionCount` | integer-decimal / base10 | integer-range minimum `0` |
| `storage.skip-count` | output `O` | `/audit/measurement/traversalSkipCount` | integer-decimal / base10 | integer-range minimum `0` |
| `storage.error-count` | output `O` | `/audit/measurement/traversalErrorCount` | integer-decimal / base10 | integer-range minimum `0` |
| `storage.reparse-encountered-count` | output `O` | `/audit/measurement/reparseEncounteredCount` | integer-decimal / base10 | integer-range minimum `0` |
| `storage.reparse-excluded-count` | output `O` | `/audit/measurement/reparseExcludedCount` | integer-decimal / base10 | integer-range minimum `0` |
| `storage.abort-reason` | output `O` | `/audit/measurement/abortReason` | string / JSON | exists |
| `storage.walk-verdict` | EvidenceNode `E` | `/walkVerdict` | string / JSON | exists |
| `storage.completeness` | EvidenceNode `E` | `/completeness` | string / JSON | exists |
| `storage.evidence-proof-digest` | EvidenceNode `E` | `/traversalAccountingProofDigest` | string / JSON | exists; Projector owns equality to output/receipt proof |

`AgentCapabilityContractV1.requiredClaimTemplateIds` and its claim-template bindings contain exactly the 28 rows above, normalized by ID; `VerificationRecipeV1.claimTemplateDigests` contains their exact 28 body digests, normalized independently by digest bytes. The table's explanatory order is not wire order; the ID→body-digest mapping makes both arrays bijective, and omission/addition/substitution is `manifest-invalid`. Projector first enforces all dynamic target/root/volume/proof/counter/clock equalities and derives completeness; Certifier does not try to express sibling equality as a static claim predicate. Selector/type/predicate success may retain a safe observed TypedValue even when the node is partial, but `requireCompleteObservation=true` means that binding does not satisfy its claim for a verified verdict. Certifier emits one requirement/evidence `partial-evidence` denial for the whole node instead of 28 duplicates: admitted `allow-disclosed` uses the no-detail row and yields `partial`; a forbidden partial uses only `detailCode='partial-not-admitted'` and yields certified `blocked`. It never emits both rows for the same node. A partial certificate/view/result must carry that denial and status, so no retained value can be rendered as verified. Core claim templates intentionally have `maxAgeMs` absent: same-Execution clock/continuity checks apply, but there is no wall-age freshness denial. `PresentationContractV1.allowedPresentationKeys` is exactly all 28 row IDs. Its global data-bearing `requiredPresentationKeys` is exactly this canonical 16-key subset: `storage.abort-reason`, `storage.clock-class`, `storage.completeness`, `storage.error-count`, `storage.exclusion-summary`, `storage.finished-at`, `storage.logical-bytes`, `storage.metric-id`, `storage.mutation-detection`, `storage.reparse-excluded-count`, `storage.root-start`, `storage.skip-count`, `storage.started-at`, `storage.temporal-class`, `storage.walk-verdict`, `storage.walker-disposition`. Verified/partial assessment carries that exact 16-key set; blocked carries `requiredPresentationKeys=[]`, `claimBindings=[]` and renders only its exact unresolved denial rows. Values and unresolved tuples, never raw output or diagnostics, are renderer inputs under the verdict-specific grammar in §18.2.

### 9.5. Authority/effect algebra

```ts
interface EffectProfileV1 {
  mutation: 'none';
  communication: 'none';
  identityImpact: 'none';
  financialImpact: 'none';
  reversibility: 'not-applicable';
  protectedZoneAccess: 'forbidden';
}

interface AuthorityScopeV1 {
  schemaVersion: 'monarch.authority-scope.v1';
  capabilityIds: ['workspace.storage.audit.v2'];
  effectCeiling: EffectProfileV1;
  pathTargets: Array<{
    rootIdentityDigest: DigestV1;
    relation: 'exact-root' | 'descendants';
    operations: ['read'];
    reparsePolicy: 'exclude-no-follow';
  }>;
  providerIds: [];
  dataClasses: ['filesystem-metadata'];
  eligibleSurfaces: AcceptedCommandContextV1['surface'][];
  privacyMode: 'persistent';
  maxBudgetProfileRef: ImmutableContentRefV1;
  maxBudgetProfileDigest: DigestV1;
  safeAuthority: 'none';
  bodyDigest: DigestV1;
}
```

All arrays are canonical unique sorted sets. `pathTargets` contains `1..64` exact entries; `eligibleSurfaces` contains `1..6` members of the closed surface enum; capability/data arrays are exact singletons and provider IDs are exactly empty. These are source/profile ceilings, not product defaults that a package may widen. For `agent-core-read.v1`, canonical scope intersection is deliberately simpler than a general path algebra: accepted scope must contain the exact selected root identity with `relation='descendants'`, `operations=['read']` and `reparsePolicy='exclude-no-follow'`; the Goal scope emits exactly that one entry and never proves containment from path strings or an ambient parent walk. Accepted eligible surfaces must contain the current surface and Goal scope emits the singleton current surface. Capability/data/privacy/effect/provider/Safe constants must equal this closed schema. The exact capability traversal budget is admitted only when each of its numeric limits is component-wise no greater than the accepted max-budget body; Goal scope then cites that exact capability budget. Any missing, incomparable or wider component yields empty scope. Future ancestor/descendant algebra, effects, children or providers require a new schema version and fixtures; they cannot add literals or a permissive relation to this V1 object.

---

## 10. Execution events

> **Reserved target vocabulary unless an entry exists in `AgentCoreEventPayloadMapV1`.** The schema lab accepts only that closed map; Catalog, Activation, runtime-host, provider, approval, recovery and workflow names below are unavailable design notes.

### 10.1. Admission/goal

```text
execution.created
goal.compilation-requested
goal.candidates-produced
goal.clarification-requested
goal.contract-admitted
goal.contract-revised
goal.blocked
```

### 10.2. Planning/context/catalog

```text
plan.proposed
plan.admitted
plan.revised
context.compiled
catalog.snapshot-bound
catalog.search-requested
catalog.search-completed
catalog.inspected
capability.missing
```

### 10.3. Activation/runtime

```text
activation.requested
activation.started
activation.lease-renewed
activation.safe-boundary-reached
activation.pause-requested
activation.paused
activation.cancel-requested
activation.cancellation-pending
activation.ended
runtime.bound
runtime.event-observed
runtime.steer-requested
runtime.steer-delivered
runtime.steer-deferred
runtime.failed
provider.grant-requested
provider.grant-resolved
provider.grant-revoked
egress.permit-issued
egress.permit-consumed
egress.permit-expired
egress.permit-revoked
egress.denied
egress.attempt-prepared
egress.attempt-aborted-before-send
egress.attempt-started
egress.attempt-completed
egress.attempt-failed
egress.attempt-unknown
provider.ingress-started
provider.ingress-completed
provider.ingress-failed
provider.ingress-unknown
provider.ingress-rejected
```

Lease renewal может храниться compact administrative stream, но current lease/generation должен быть crash-observable.

### 10.4. Decision/workflow

```text
decision.proposed
decision.rejected
decision.admitted
workflow.started
workflow.transition-proposed
workflow.transitioned
workflow.blocked
workflow.completed
progress.stalled
```

### 10.5. Invocation/approval/evidence

```text
invocation.proposed
invocation.prepared
invocation.awaiting-approval
approval.requested
approval.arm-issued
approval.resolved
approval.expired
approval.revoked
invocation.authorized
invocation.dispatched
invocation.cancel-requested
invocation.cancelled-before-dispatch
invocation.cancelled
invocation.receipt-linked
invocation.observed
invocation.output-checked
invocation.reconciliation-requested
invocation.indeterminate
invocation.settled
invocation.failed
invocation.rejected
recovery.case-opened
recovery.reconciliation-requested
recovery.case-blocked
recovery.case-permanently-unknown
recovery.receipt-observed
recovery.case-resolved
recovery.case-acknowledged
recovery.case-view-archived
observation.recorded
artifact.recorded
evidence.projected
```

### 10.6. Completion/presentation

```text
completion.requested
completion.denied
completion.certified
presentation.requested
presentation.completed
presentation.failed
execution.completed
execution.partial
execution.blocked-indeterminate
execution.blocked
execution.failed
execution.cancelled
```

`execution.completed` causal chain обязан включать `completion.certified`. `presentation.completed` не является его заменой.

### 10.7. Child/job/compaction extensions

```text
child.requested
child.admitted
child.delivery-available
child.delivery-consumed
child.cancel-requested
job.run-linked
compaction.requested
compaction.started
compaction.completed
compaction.failed
```

---

## 11. Interaction state machine

Interaction is a conversation aggregate, not a single execution-shaped state machine. In `agent-core-read.v1` its exact fixture lifecycle is only `accepted -> routing -> open`, matching §5. `closed-by-user|retention-closed` and every output-row/product outcome below are future `agent-product-facade.v1` vocabulary and have no core event/transition:

```text
accepted
  -> routing
  -> open
  -> closed-by-user | retention-closed     (future product-facade only)
```

Operational/user-visible progress is an ordered row projection, not Interaction state:

```ts
interface InteractionOutputRowV1 {
  rowId: string;
  clauseIds: string[];
  kind: 'answer' | 'execution' | 'recovery-correction';
  executionLinkId?: string;
  status: 'pending' | 'answering' | 'waiting-user' | 'waiting-approval'
    | 'waiting-runtime' | 'paused' | 'cancellation-pending' | 'blocked-indeterminate'
    | 'answered' | 'source-grounded' | 'verified' | 'partial' | 'blocked'
    | 'failed' | 'cancelled';
  outcomeRef?: ImmutableContentRefV1;
  outcomeDigest?: DigestV1;
}
```

`executionLinks[]` and rows are append-ordered and independently projected. `aggregateRoute='mixed-rows'` may therefore answer one independent clause while an operational row waits/runs, without pretending the whole Interaction has one `running/completed` state. `outcomeSummary` is a rebuildable UI summary only and cannot authorize transitions.

User-visible outcomes сохраняют текущую taxonomy:

- `answered` — informational answer, no execution authority;
- `source-grounded` — answer based on allowed source, но не local effect;
- `verified` — Completion Certificate verified;
- `partial`;
- `blocked`;
- `failed`;
- `cancelled`.

`answered` не повышается до `verified` из-за уверенного текста.

Legacy Execution uses a separate diagnostic/public subtype `legacy-completed|legacy-partial|legacy-failed|legacy-cancelled|legacy-unknown`. It may render a familiar «Завершено (legacy runtime)» label, but MUST NOT populate V3 `verified`, `completion.certificateId` or synthetic EvidenceNode. `source-grounded` is answer-only provenance with an admitted source citation, never an operational Execution verdict/certificate. Only a real current Certifier transaction may produce V3 `verified`.

Interaction `blocked` может закрыть текущую user-facing row с explicit «runtime stopped; effect outcome unknown», пока linked Execution остаётся `blocked-indeterminate`. Late recovery публикует новую correction/delivery row; старая row не переписывается молча.

---

## 12. Execution state machine

This is the exact schema-lab projection. Waiting/approval/Activation/recovery states belong to unavailable profiles and cannot be inserted into this graph by a generator.

```text
created -> preparing -> running -> certifying
preparing -> blocked
running -> certifying | blocked | failed | cancelled
certifying -> completed | partial | blocked | failed(internal-error only)
```

### 12.1. Transition guards

- `created -> preparing`: exact accepted admission is bound and `goal.compilation-requested` starts; Goal is not yet admitted.
- `preparing -> preparing` + immediate `preparing -> running` in one commit: GoalContract, exact semantic body, RuntimeFeatureSet, static capability, authority, budget and presentation refs/digests all resolve, then the direct fixture host creates the sole admitted Invocation. No committed queue, Catalog/Activation/Engine object or product lease exists.
- `running -> certifying`: the single Invocation reached a known settled/output-checked state and assessment input was atomically frozen once for the CompletionRequest ID.
- `certifying -> completed`: assessment verdict is `verified`, a matching Completion Certificate is atomically committed and no required dependency is unresolved. Answer-only has no Execution/certificate and cannot enter this transition.
- `certifying -> partial`: only when the requirement has `partialPolicy='allow-disclosed'` and Goal `overallPartial='allow-if-each-requirement-allows'`; partial is factual terminal outcome, never verified success. Otherwise the same evidence deterministically maps to certified `blocked`.
- `certifying -> blocked`: deterministic terminal policy maps an unresolved non-partial denial to `blocked` and commits the matching certificate.
- `certifying -> failed`: only the receiptless `internal-error` branch when the pinned pure Certifier cannot produce a schema-valid assessment; no certificate/presentation is created and retry of the same deterministic operation is attempted before choosing this terminal fixture fact.
- Any noncertified `blocked|failed|cancelled` transition carries its exact reason/receipt branch and cannot include a certificate ID. Unknown post-dispatch outcome does not become any terminal state; the schema lab reports an indeterminate Invocation and fails the trace. Product recovery requires its own manifest before such an Execution can be admitted.

Terminal state is immutable. Any retry/follow-up creates a new linked Execution and never reopens/revises the terminal aggregate. Presentation is a deterministic post-terminal fixture stage, not an Execution state and not a user-visible product write.

Normative projection table:

| Source truth | Execution state | Interaction outcome | Certificate |
|---|---|---|---|
| answer-only route | none | `answered` or `source-grounded` | forbidden |
| V3 assessment `verified` | `completed` | product projection unavailable | required |
| V3 allowed disclosed partial | `partial` | product projection unavailable | required local assessment/certificate |
| pre-cert policy/capability/input block | `blocked` | product projection unavailable | forbidden; typed reason only |
| certifier-assessed block | `blocked` | product projection unavailable | required local assessment/certificate, never `verified` |
| known cancellation/infrastructure failure | `cancelled`/`failed` | product projection unavailable | forbidden; typed receipt/reason |
| unknown dispatched read | no Execution terminal in core | product projection unavailable | forbidden; product recovery profile required |
| legacy adapter | no V3 state | explicit `legacy-*` | forbidden unless separately re-assessed by current V3 |

Goal phase is a projection, not another writable owner: draft/admitted/active maps from Goal existence + Execution state; certifying/terminal mirror the table. No component writes Goal phase independently.

### 12.2. RecoveryCase state machine

> **Future product/effect recovery design; unavailable in `agent-core-read.v1`.** None of the following entities/transitions is a base-manifest dependency.

```ts
interface RecoveryCaseV1 {
  schemaVersion: 'monarch.recovery-case.v1';
  id: string;
  executionId: string;
  invocationId: string;
  actionLedgerId?: string;
  state: 'opened' | 'reconciling' | 'blocked' | 'permanently-unknown' | 'resolved';
  presentation: 'visible' | 'acknowledged' | 'archived';
  frozenSemanticsDigest: string;
  reconciliationRecipeDigest: string;
  canonicalInputDigest: string;
  providerCorrelationRef?: string;
  evidenceFingerprint?: string;
  fullEvidenceRetainUntil: string;
  minimalTombstoneRetainUntil: string | null; // null while unresolved; resolved retention may set a policy deadline
  nextWakeAt?: string;
  resolution?: {
    kind: 'reconciliation' | 'late-receipt';
    exactEvidenceRef: string;
    exactEvidenceDigest: string;
    resolvedAt: string;
  };
  revision: number;
}
```

Transitions: `opened -> reconciling -> resolved|blocked`; `blocked -> reconciling|permanently-unknown`; `permanently-unknown -> resolved` on exact late receipt. State `resolved-on-late-receipt` не существует: для resolved case обязателен `resolution`, а late receipt кодируется `resolution.kind='late-receipt'` с exact admitted receipt ref/digest. Acknowledge/archive are orthogonal presentation transitions. Full sensitive payload may be crypto-erased after recorded deadline only when automated reconciliation no longer needs it; immutable minimal tombstone stays while truth unresolved. V1 не имеет `recovery.erase-data`; будущая общая erasure policy требует отдельного ADR и не считается resolution. Quotas/backpressure могут блокировать новые non-idempotent effects, но никогда silently не GC-ят cases. Resolution emits idempotent `interaction.append-recovery-correction` delivery.

---

## 13. Activation protocol

> **Future `agent-engine.v1` / product-runtime design; unavailable in `agent-core-read.v1`.** The core schema lab has no Activation, lease, runner generation or activation event. Its deterministic fixture dispatcher binds one admitted Invocation directly to the Kernel read adapter through the immutable refs listed in §16.

```ts
interface ActivationLeaseV1 {
  schemaVersion: 'monarch.activation-lease.v1';
  id: string;
  executionId: string;
  generation: number;
  ownerId: string;
  driverId: string;
  driverVersion: string;
  goalRevision: number;
  catalogRevision: number;
  contextDigest: string;
  acquiredAt: string;
  expiresAt: string;
  safeBoundaryId?: string;
}
```

Rules:

1. Generation strictly increases.
2. Stale generation events rejected even if event arrives later.
3. Lease expiry is not automatic permission for another process to replay effects; Recovery Service classifies current invocation states first.
4. Goal revision/catalog incompatible change invalidates activation.
5. Pause/cancel command persisted before signalling driver.
6. Approval authorization belongs to stable Invocation authorization revision. Generation change alone neither invalidates nor reuses it blindly: Recovery validates frozen goal/schema/policy/scope/expiry/revocation and dispatch state.

---

## 14. Plan and decision protocol

> **Future `agent-engine.v1` / workflow design; unavailable in `agent-core-read.v1`.** The core manifest contains no Plan, model/runtime decision, wait request, proposal envelope or decision event. A core trace is admitted command → fixed Goal semantic body → fixed static capability → Invocation; no field or rule below is a transitive core dependency.

### 14.1. Plan

Plan is model/runtime-authored proposal with deterministic admission:

- every step maps to GoalRequirement/workflow transition or presentation;
- capability refs exist in bound catalog;
- effect order obeys constraints;
- budgets bounded;
- no hidden subgoal widens scope;
- plan revision monotonic.

Plan is not proof and may be revised.

### 14.2. Normalized decision kinds

```text
inspect-capability
search-capabilities
propose-invocation
ask-user
request-wait
revise-plan
request-completion
report-failure
```

`respond` may exist only in presentation/answer context. Engine-specific `tool_use`, function-call or JSON shapes normalize to these kinds.

```ts
interface WaitRequestV1 {
  condition:
    | { kind: 'runtime-available'; laneId: string }
    | { kind: 'timer'; notBefore: string }
    | { kind: 'capability-availability'; capabilityId: string; catalogRevisionAfter: number }
    | { kind: 'credential-state-change'; credentialClass: string; stateRevisionAfter: number }
    | { kind: 'policy-change'; policyScopeDigest: DigestV1; policyRevisionAfter: number }
    | { kind: 'provider-grant'; grantRequestId: string }
    | { kind: 'child-delivery'; deliveryId: string }
    | { kind: 'recovery-evidence'; recoveryCaseId: string };
  expiresAt: string;
  maxWaitPolicyDigest: DigestV1;
  onExpiry: 'ask-user' | 'block' | 'fail';
}

type NormalizedDecisionV1 =
  | { kind: 'inspect-capability'; capabilityId: string; catalogRevision: number }
  | { kind: 'search-capabilities'; query: string; requiredCapabilityId?: string }
  | { kind: 'propose-invocation'; requirementId: string; capabilityId: string;
      inspectReceiptId: string; input: JsonObject }
  | { kind: 'ask-user'; inputRequestId: string; requestSchemaDigest: DigestV1; expiresAt: string }
  | ({ kind: 'request-wait' } & WaitRequestV1)
  | { kind: 'revise-plan'; expectedPlanRevision: number; planProposalRef: string; planProposalDigest: DigestV1 }
  | { kind: 'request-completion'; proposedRequirementIds: string[]; publicRationaleCode?: string }
  | { kind: 'report-failure'; code: string; recoverability: 'ask-user' | 'retry-runtime' | 'none' };
```

Every `request-wait` has a concrete externally observable condition and finite `expiresAt` bounded by the cited policy. A model cannot request a free-form wait. Scheduler subscribes to runtime, timer, catalog/capability, credential, policy, provider-grant, child and recovery revisions; an event with unchanged condition fingerprint is not progress. Expiry produces the declared typed outcome and cannot silently renew itself. Renewal is a new admitted decision and consumes no-progress budget.

```ts
interface NormalizedDecisionEnvelopeV1 {
  schemaVersion: 'monarch.normalized-decision-envelope.v1';
  decisionId: string;
  engineSessionId: string;
  engineSubmitId: string;
  driverEventSequence: number;
  driverDescriptorDigest: DigestV1;
  activationId: string;
  activationGeneration: number;
  contextDigest: string;
  goalRevision: number;
  goalContractDigest: string;
  planRevision: number;
  planDigest: DigestV1;
  catalogRevision: number;
  catalogDigest: string;
  safeBoundaryId: string;
  steeringEpoch: number;
  compactionEpoch: number;
  decision: NormalizedDecisionV1;
}
```

Admission CAS-ит все refs против current projection. Любой buffered pre-steer/pre-goal/pre-compaction decision получает `stale-context` до prepare, даже если activation generation не менялась.

Deterministic fast path with no plan uses `planRevision=0` and the registered domain-separated `empty-plan.v1` digest; missing/empty arbitrary string is not a sentinel. Every other revision cites a persisted plan body/digest. Driver descriptor digest binds the event to exact loaded driver identity.

### 14.3. Admission denial

Typed denial examples:

- `stale-context`;
- `schema-not-inspected`;
- `capability-not-in-goal-or-workflow`;
- `input-schema-invalid`;
- `input-binding-mismatch`;
- `authority-scope-exceeded`;
- `approval-required`;
- `duplicate-without-progress`;
- `budget-exceeded`;
- `stale-activation-generation`.

Driver получает bounded repair payload, не внутренний stack trace.

---

## 15. Catalog protocol

> **Future `agent-catalog.v1` design; unavailable in `agent-core-read.v1`.** Static core binds the one capability contract directly through Admission → Goal → Invocation → Assessment. No catalog snapshot/search/inspect schema, event or synthetic receipt may appear in a core trace.

### 15.1. Snapshot

```ts
interface CapabilityCatalogSnapshotV1 {
  schemaVersion: 'monarch.capability-catalog-snapshot.v1';
  id: string;
  revision: number;
  digest: string;
  createdAt: string;
  indexProfile: {
    corpusDigest: DigestV1;
    tokenizerDigest: DigestV1;
    scorerImplementationHash: ImplementationHashV1;
    embeddingModelDigest?: DigestV1;
  };
  entries: Array<{
    capabilityId: string;
    contractVersion: string;
    inputSchemaDigest: DigestV1;
    outputSchemaDigest: DigestV1;
    contractDigest: DigestV1;
    contractBodyRef: string;
    effectSemanticsDigest: string;
    availability: 'available' | 'runtime-missing' | 'credential-missing' | 'source-ineligible' | 'disabled';
    effectClass: string;
    trust: 'first-party-admitted' | 'untrusted-invocation-only';
  }>;
}

interface CatalogSearchReceiptV1 {
  schemaVersion: 'monarch.catalog-search-receipt.v1';
  executionId: string;
  goalRevision: number;
  catalogSnapshotId: string;
  catalogDigest: DigestV1;
  queryDigest: DigestV1;
  indexProfileDigest: DigestV1;
  orderedCandidateIds: string[];
  eligibilityCodes: string[];
  bodyDigest: DigestV1;
}
```

### 15.2. Search result

Search returns summaries only and records `CatalogSearchReceiptV1`; it never executes or authorizes. Required Goal capability remains visible with exact ineligibility reason so UI can truthfully block; ordinary discovery may filter ineligible entries but cannot replace a required ID. `untrusted-invocation-only` may be exposed only in a non-certifying diagnostic/manual lane; it cannot satisfy V3 operational Goal or publish matcher/claim/verifier authority until admitted as first-party/trusted contract.

### 15.3. Inspect receipt

```ts
interface CatalogInspectReceiptV1 {
  schemaVersion: 'monarch.catalog-inspect-receipt.v1';
  id: string;
  executionId: string;
  goalRevision: number;
  catalogSnapshotId: string;
  capabilityId: string;
  catalogRevision: number;
  catalogDigest: DigestV1;
  contractVersion: string;
  inputSchemaDigest: string;
  outputSchemaDigest: string;
  contractDigest: string;
  inspectedByActivationId: string;
  inspectedAt: string;
  bodyDigest: DigestV1;
}
```

Invocation proposal must cite this exact receipt/digest unless capability was pre-pinned with full schema in initial context. Receipt validity is Execution + Goal revision + catalog/contract scoped, not Activation scoped; `inspectedByActivationId` is provenance. A new Activation can reuse it only when all pinned fields remain exact. Goal/catalog/contract change makes it stale and requires a new inspect; crash alone does not waste a model turn.

Catalog/content store retains exact contract/workflow bodies by digest while any prepared/nonterminal invocation or certificate retention pin references them. Recovery never substitutes latest catalog semantics for missing historical body.

---

## 16. Invocation protocol

```ts
type InvocationLifecycleV1 =
  | { state: 'prepared' }
  | { state: 'authorized' }
  | { state: 'dispatched'; dispatchAttemptId: string }
  | { state: 'observed'; dispatchAttemptId: string; receiptRef: ImmutableContentRefV1;
      receiptDigest: DigestV1 }
  | { state: 'output-checked'; dispatchAttemptId: string; receiptRef: ImmutableContentRefV1;
      receiptDigest: DigestV1; outputCheck: 'accepted' }
  | { state: 'output-rejected'; dispatchAttemptId: string; receiptRef: ImmutableContentRefV1;
      receiptDigest: DigestV1; reasonCode: 'output-schema-rejected' | 'output-binding-mismatch' }
  | { state: 'settled'; dispatchAttemptId: string; receiptRef: ImmutableContentRefV1;
      receiptDigest: DigestV1; knownOutcome: 'completed' }
  | { state: 'rejected';
      reasonCode: 'policy-denied' | 'budget-exceeded' | 'authority-scope-empty' | 'manifest-invalid' }
  | { state: 'cancelled-before-dispatch'; reasonCode: 'cancel-requested-before-dispatch' }
  | { state: 'cancelled'; dispatchAttemptId: string; receiptRef: ImmutableContentRefV1;
      receiptDigest: DigestV1; knownOutcome: 'cancelled' }
  | { state: 'failed'; dispatchAttemptId: string; receiptRef: ImmutableContentRefV1;
      receiptDigest: DigestV1; knownOutcome: 'failed' }
  | { state: 'indeterminate'; dispatchAttemptId: string;
      receiptRef: ImmutableContentRefV1; receiptDigest: DigestV1;
      reasonCode: 'dispatch-outcome-unknown' };

interface InvocationDispatchKeyBodyV1 {
  schemaVersion: 'monarch.invocation-dispatch-key-body.v1';
  executionId: string;
  invocationId: string;
  goalContractDigest: DigestV1;
  capabilityContractDigest: DigestV1;
  canonicalInputDigest: DigestV1;
}

interface InvocationV1 {
  schemaVersion: 'monarch.invocation.v1';
  id: string;
  executionId: string;
  interactionId: string;
  traceId: string;
  correlationId: string;
  goalContractRef: ImmutableContentRefV1;
  goalContractId: string;
  goalRevision: 1;
  goalContractDigest: DigestV1;
  goalSemanticBodyRef: ImmutableContentRefV1;
  goalSemanticBodyDigest: DigestV1;
  requirementId: 'storage.audit.requirement.v1';
  runtimeFeatureSetRef: ImmutableContentRefV1;
  runtimeFeatureSetDigest: DigestV1;
  capability: {
    id: 'workspace.storage.audit.v2';
    contractVersion: '2';
    inputSchemaDigest: DigestV1;
    outputSchemaDigest: DigestV1;
    evidenceNodeSchemaDigest: DigestV1;
    contractRef: ImmutableContentRefV1;
    contractDigest: DigestV1;
  };
  input: WorkspaceStorageAuditInputV2;
  canonicalInputDigest: DigestV1;
  dispatchKeyBody: InvocationDispatchKeyBodyV1;
  dispatchIdempotencyKey: DigestV1;
  effectClass: 'read';
  authorityScopeRef: ImmutableContentRefV1;
  authorityScopeDigest: DigestV1;
  traversalBudgetProfileRef: ImmutableContentRefV1;
  traversalBudgetProfileDigest: DigestV1;
  cancellationPolicy: 'cooperative';
  verificationRecipeRef: ImmutableContentRefV1;
  verificationRecipeDigest: DigestV1;
  lifecycle: InvocationLifecycleV1;
  stateRevision: SafeCounterV1;
  bodyDigest: DigestV1;
}

interface InvocationTransitionCommonV1 {
  schemaVersion: 'monarch.invocation-transition.v1';
  executionId: string;
  invocationId: string;
  goalRevision: 1;
  resultingInvocationRef: ImmutableContentRefV1;
  resultingInvocationBodyDigest: DigestV1;
}

type InvocationTransitionPayloadV1 = InvocationTransitionCommonV1 & (
  | { from: 'none'; to: 'prepared'; expectedStateRevision?: never;
      resultingStateRevision: 0; reasonCode: 'invocation-created' }
  | { from: 'prepared'; to: 'authorized'; expectedStateRevision: SafeCounterV1;
      resultingStateRevision: SafeCounterV1; reasonCode: 'authority-admitted' }
  | { from: 'authorized'; to: 'dispatched'; expectedStateRevision: SafeCounterV1;
      resultingStateRevision: SafeCounterV1; reasonCode: 'dispatch-linearized' }
  | { from: 'dispatched'; to: 'observed'; expectedStateRevision: SafeCounterV1;
      resultingStateRevision: SafeCounterV1; reasonCode: 'completed-receipt-admitted' }
  | { from: 'observed'; to: 'output-checked'; expectedStateRevision: SafeCounterV1;
      resultingStateRevision: SafeCounterV1; reasonCode: 'output-schema-accepted' }
  | { from: 'observed'; to: 'output-rejected'; expectedStateRevision: SafeCounterV1;
      resultingStateRevision: SafeCounterV1;
      reasonCode: 'output-schema-rejected' | 'output-binding-mismatch' }
  | { from: 'output-checked'; to: 'settled'; expectedStateRevision: SafeCounterV1;
      resultingStateRevision: SafeCounterV1; reasonCode: 'completed-read-settled' }
  | { from: 'prepared' | 'authorized'; to: 'rejected'; expectedStateRevision: SafeCounterV1;
      resultingStateRevision: SafeCounterV1;
      reasonCode: 'policy-denied' | 'budget-exceeded' | 'authority-scope-empty' | 'manifest-invalid' }
  | { from: 'prepared' | 'authorized'; to: 'cancelled-before-dispatch';
      expectedStateRevision: SafeCounterV1; resultingStateRevision: SafeCounterV1;
      reasonCode: 'cancel-requested-before-dispatch' }
  | { from: 'dispatched'; to: 'cancelled'; expectedStateRevision: SafeCounterV1;
      resultingStateRevision: SafeCounterV1; reasonCode: 'kernel-confirmed-cancelled' }
  | { from: 'dispatched'; to: 'failed'; expectedStateRevision: SafeCounterV1;
      resultingStateRevision: SafeCounterV1; reasonCode: 'kernel-confirmed-failed' }
  | { from: 'dispatched'; to: 'indeterminate'; expectedStateRevision: SafeCounterV1;
      resultingStateRevision: SafeCounterV1; reasonCode: 'dispatch-outcome-unknown' }
);
```

Canonical state graph:

```text
prepared -> authorized
authorized -> dispatched -> observed -> output-checked -> settled
                                  \-> output-rejected

pre-dispatch terminals: rejected | cancelled-before-dispatch
post-dispatch known terminals: settled | failed | cancelled
post-observation integrity terminal: output-rejected
post-dispatch unknown terminal-for-invocation: indeterminate
```

`verified` is deliberately not an Invocation state: verification belongs to Evidence admission/Completion Certificate. The discriminated `lifecycle` forbids receipt/state combinations that a flat optional object would admit. `cancelled-before-dispatch` proves the dispatch linearization point was not crossed. In `agent-core-read.v1` it is produced only by the direct fixture coordinator's injected cancellation token before dispatch; there is no public core cancel command. A product surface may expose cancellation only through the separately generated product-read command/profile. `rejected(budget-exceeded)` is a pre-dispatch admission result, not a traversal outcome; once the read is dispatched, budget exhaustion is represented by the Kernel output/proof and can only yield partial/blocked certification. `cancelled|failed|indeterminate` each require an admitted Kernel receipt whose disposition is respectively `cancelled|failed|unknown`; no receipt or mismatched branch is an integrity failure, not a guessed outcome. A completed receipt whose output schema/bindings fail moves `observed -> output-rejected` and can only produce noncertified `execution.failed(reasonCode='output-schema-rejected')`; it can never reach Evidence or `settled`. Core never supersedes one Invocation with another: retry/semantic change creates a new linked Execution, while a pre-dispatch cancellation uses the explicit cancelled branch.

Every transition uses the closed `InvocationTransitionPayloadV1` one-of above, aggregate/state CAS and an immutable resulting Invocation snapshot ref/digest. `none -> prepared` is the only creation branch and starts at state revision `0`; every later branch requires `resultingStateRevision = expectedStateRevision + 1`, checked mathematically before conversion. Event names map one-to-one to the `to` state; `receipt-linked` is an admitted lineage fact emitted in the same commit as the first lifecycle snapshot that cites that receipt. Same `invocationId + resultingStateRevision` with another body is corruption.

`dispatchKeyBody` fields MUST byte-equal the enclosing Invocation. `dispatchIdempotencyKey = digestV1('invocation-dispatch-key', JCS(dispatchKeyBody))`; concatenated strings, random retry keys and adapter-generated replacements are forbidden. Every Kernel receipt repeats that exact key in addition to invocation/attempt/capability/input bindings. Same key with another body/Invocation is corruption; the key is dedupe identity, while `dispatchAttemptId` is the once-created fact naming the actual linearized dispatch.

### 16.1. Canonicalization

Canonical input produced server-side after schema validation/target resolution. Driver-provided serialization не является canonical hash authority.

### 16.2. Dispatch fence

Core read dispatch semantics have one logical owner: the schema-lab fixture validates expected Execution revision plus the exact immutable Goal/scope/policy-bound Invocation `authorized` lifecycle/body/state revision, appends `authorized -> dispatched`, creates the stable `dispatchAttemptId` and schedules exactly one in-memory read-port call under the frozen `dispatchIdempotencyKey` as one fixture step. Core has no independently mutable authorization revision. Duplicate injection reuses the same attempt/key and never creates a second port call. No product outbox/store layout or durability is asserted. A future product-store manifest must define and fault-test the physical commit/outbox record before admission.

Frozen authority proves what was admitted; it does not override a newer deny. Any product-read profile MUST add a Clock/Revocation-owned start-by/deadline and current ceiling for principal, workspace grant, policy, protected-root generation, protocol package and implementation. It is checked at continuation, at dispatch linearization, before/after every blocking broker I/O, before Evidence admission, before assessment/certification and before delivery. The current snapshot may only narrow/block the frozen scope. Logout/revocation after admission therefore prevents further work/evidence/delivery, while an ambient current allow can never widen the Goal. Known-bad package/implementation produces typed quarantine/invalidation/correction flow; it is not silently retried with latest code. The core lab has immutable fixture policy/package and makes no product-revocation claim.

The in-memory fixture step is not representable product crash recovery. A product profile MUST choose either an atomic co-located dispatch+receipt boundary or a durable outbox/claim protocol that survives process death after dispatch intent but before receipt. It must represent a receiptless `dispatch-status-unknown` case with one finite read-specific recovery/user-visible owner and prove no second port call. Existing `InvocationLifecycleV1.indeterminate` covers only an admitted unknown receipt; it cannot be used to fabricate a receipt after a kill.

Action Ledger is not a second atomic participant in `agent-core-read.v1`. A future effect profile MUST first choose one executable physical ownership design (co-located transaction, ledger-owned invocation stream, or a formally specified outbox/claim protocol) and prove every crash point. Until that separate ADR/schema/benchmark exists, the protocol makes no cross-store atomic promise and effects remain unavailable.

### 16.3. Receipt

```ts
interface KernelReceiptBaseV1 {
  schemaVersion: 'monarch.kernel-receipt-ref.v1';
  receiptId: string;
  invocationId: string;
  dispatchAttemptId: string;
  dispatchIdempotencyKey: DigestV1;
  capabilityId: 'workspace.storage.audit.v2';
  capabilityContractDigest: DigestV1;
  canonicalInputDigest: DigestV1;
  sourceClockClass: 'kernel-local-attested';
  kernelAdmittedAt: string;
  bodyDigest: DigestV1;
}

type KernelReceiptRefV1 = KernelReceiptBaseV1 & (
  | {
      disposition: 'completed';
      resultSchemaDigest: DigestV1;
      resultRef: ImmutableContentRefV1;
      resultDigest: DigestV1;
      traversalAccountingProofRef: ImmutableContentRefV1;
      traversalAccountingProofDigest: DigestV1;
      outcomeCode?: never;
      diagnosticRef?: never;
      diagnosticDigest?: never;
    }
  | {
      disposition: 'failed';
      outcomeCode: 'kernel-read-failed';
      resultSchemaDigest?: never;
      resultRef?: never;
      resultDigest?: never;
      traversalAccountingProofRef?: never;
      traversalAccountingProofDigest?: never;
      diagnosticRef?: ImmutableContentRefV1;
      diagnosticDigest?: DigestV1;
    }
  | {
      disposition: 'cancelled';
      outcomeCode: 'kernel-read-cancelled';
      resultSchemaDigest?: never;
      resultRef?: never;
      resultDigest?: never;
      traversalAccountingProofRef?: never;
      traversalAccountingProofDigest?: never;
      diagnosticRef?: ImmutableContentRefV1;
      diagnosticDigest?: DigestV1;
    }
  | {
      disposition: 'unknown';
      outcomeCode: 'dispatch-outcome-unknown';
      resultSchemaDigest?: never;
      resultRef?: never;
      resultDigest?: never;
      traversalAccountingProofRef?: never;
      traversalAccountingProofDigest?: never;
      diagnosticRef?: ImmutableContentRefV1;
      diagnosticDigest?: DigestV1;
    }
);
```

For a completed read, Kernel Result Admission first materializes the immutable allowlisted `WorkspaceStorageAuditOutputV2` and accounting-proof bodies in the fixture content resolver, verifies they are resolvable, and only then appends `KernelReceiptRefV1` referencing them. Core schema-lab claims ordering/resolvability, not disk durability or `fsync`; its in-memory crash matrix may leave collectible unreferenced fixture objects before receipt but can never expose a completed digest-only outcome. A future selected product backend must strengthen the same boundary to durable write/fsync + atomic receipt visibility and prove it by fault injection before import. Receipt invocation/dispatch-attempt/idempotency key, `resultRef.contentSchemaId`, `resultSchemaDigest`, capability/input bindings and the output/proof duplicated bindings must all match the exact Invocation and admitted dispatch. Failed/cancelled/unknown receipts forbid result/proof fields instead of inventing an output. Their optional diagnostic ref/digest is all-or-none and non-authoritative. Evidence admission accepts only the completed branch. The schema lab injects every fixture boundary and proves retry never reruns the read merely to reconstruct bytes already named by a committed receipt.

Freshness never trusts an untrusted provider/worker timestamp alone. Goal policy declares anchor (`observation-finished` or `receipt-admitted`); Projector carries both source interval and Application/Kernel admission time with clock class. Late receipt stays late even if its source clock claims an earlier future/past value.

`KernelReceiptBaseV1.sourceClockClass` and `StorageTemporalProofV2.clockClass` deliberately use the same sole core literal `kernel-local-attested`. It means that the pinned Kernel adapter validated the corresponding clock attestation under the same boot/origin/continuity profile; it does not make wall time an ordering source. Any other/mismatched literal is schema failure, so no implicit `trusted -> attested` mapping exists.

### 16.4. Frozen read semantics

Core freezes the allowlisted capability contract, input/output schemas, exact input, Goal semantic body, AuthorityScope, inclusion/exclusion/budget policies, verification recipe, adapter/projector implementation hashes and RuntimeFeatureSet through the refs/digests/hashes in Goal + Invocation. There is no unlisted `EffectSemanticsSnapshotV1` in this profile. Missing body or incompatible current interpreter blocks the trace instead of substituting latest semantics.

An implementation hash proves which bytes originally ran; it does **not** promise those executable bytes remain installed or safe to execute. General effect/reconciliation snapshots remain future `agent-effects.v1` work with a separate supply-chain/retention decision.

### 16.5. Dispatch guarantee

Для non-idempotent invocation protocol гарантирует один admitted Kernel dispatch transition/attempt. После ambiguous external outcome второй Monarch dispatch запрещён. Global external exactly-once не заявляется; provider retry требует frozen supported idempotency key/protocol.

---

## 17. Approval protocol

> **Extension note — unavailable in `agent-core-read.v1`.** These shapes are threat-model inputs, not manifest ABI. Approval/Arm becomes protocol only with an `agent-effects.v1` schema package, trusted-human-interaction profile and executable dispatch transaction.

### 17.1. Request

```ts
interface ApprovalRequestV1 {
  schemaVersion: 'monarch.approval-request.v1';
  approvalId: string;
  executionId: string;
  invocationId: string;
  invocationAuthorizationRevision: number;
  goalRevision: number;
  capabilityId: string;
  capabilityContractDigest: string;
  canonicalProposalHash: string;
  effectProfileDigest: string;
  policyAuthoritySnapshotDigest: string;
  privacyProviderScopeDigest: string;
  eligibleApproverContextDigest: string;
  previewTemplateId: string;
  previewTemplateVersion: string;
  previewTemplateDigest: DigestV1;
  deterministicPreview: JsonObject;
  deterministicPreviewDigest: DigestV1;
  requiredArm: boolean;
  requiredArmMechanismId?: string;
  requiredArmMechanismDigest?: DigestV1;
  expiresAt: string;
  revision: number; // Approval child-entity revision, not Execution aggregate revision
  state: 'pending' | 'approved' | 'denied' | 'expired' | 'revoked';
}
```

### 17.2. Resolution guards

Resolution valid, только если:

- request pending/not expired/revoked, CAS revision matches;
- exact execution/invocation/authorization revision/goal/capability/contracts/hash совпадают;
- principal/surface имеет право approve;
- one-use arm attestation valid and atomically consumed, только если `requiredArm=true` и decision=approve;
- GoalContract и policy snapshot не изменились incompatibly.

### 17.3. Crash/replay

Pending Approval, issued ArmAttestation и approved Invocation authorization survive restart как durable child entities/facts Execution aggregate. Model/runtime не перезапускается только ради отображения карточки. Новая activation revalidates frozen authorization snapshot; generation change сама по себе approval не инвалидирует. Deny terminal для invocation; дальнейшая goal судьба решается workflow/planner policy.

### 17.4. Arm, expiry and revocation

```text
approval request:
  pending -> approved                 when requiredArm=false
  pending -> approved                 when requiredArm=true + valid arm consumed atomically
  pending -> denied | expired | revoked
  approved -> expired | revoked       only while invocation dispatchState=not-dispatched

arm attestation (separate entity):
  issued -> consumed | expired | revoked
```

```ts
interface ArmAttestationV1 {
  schemaVersion: 'monarch.arm-attestation.v1';
  armAttestationId: string;
  approvalId: string;
  approvalRevisionAtIssue: number;
  executionId: string;
  invocationId: string;
  invocationAuthorizationRevision: number;
  principalRef: string;
  surface: AcceptedCommandContextV1['surface'];
  authContextEpoch: string;
  mechanismId: string;
  mechanismVersion: string;
  mechanismDigest: DigestV1;
  trustedInteractionProofDigest: string;
  issuedAt: string;
  expiresAt: string;
  state: 'issued' | 'consumed' | 'expired' | 'revoked';
  revision: number; // Arm child-entity revision
}
```

Approval и ArmAttestation — разные child entities одного Execution aggregate, а не два независимо коммитящих store. Arm issuance не меняет Approval state, но одним Execution commit создаёт `ArmAttestationV1`; crash replay восстанавливает `issued`. Approve commit обязан одновременно проверить outer Execution `expectedRevision`, pending Approval `approvalExpectedRevision`, exact authorization bindings, совпадение `principalRef/surface/authContextEpoch` Arm с server `AcceptedCommandContextV1` resolve-команды и, если arm нужен, issued Arm `armAttestationExpectedRevision`, затем атомарно записать `arm.consumed + approval.approved`. Ни `approved`, ни `consumed` не видны отдельно. No-arm approve не создаёт Arm. Deny проверяет pending Approval CAS, arm не требует и атомарно revoke-ит оставшиеся issued arms этой Approval. Expiry/revoke Approval тем же commit invalidates issued arms. Auth-epoch change делает старый Arm непригодным, но не превращает Approval в approved.

The preview shown to the human MUST byte-match `deterministicPreviewDigest` and template ID/version/digest stored in the request; UI acknowledgement of a re-rendered/different preview is stale. Arm proof is accepted only from the exact registered `requiredArmMechanismId/digest` and eligible surface.

This draft intentionally does not pretend that a UI boolean/hash is a trusted interaction. Before any effect RFC, a separate reviewed surface matrix MUST define the real main-process/OS/hardware interaction mechanism for Desktop and whether Voice/Telegram/API/Coder are ineligible or require another mechanism. Until that mechanism passes spoof/replay/accessibility tests, every capability requiring arm is unavailable; no prompt or renderer event may synthesize the proof.

Arm expiry оставляет Approval pending до его собственного expiry и позволяет новую arm request. Server timer/policy change append-ит `approval.expired|revoked` и wake-ит workflow. Background/headless execution без eligible live approver не может оставаться скрыто waiting: оно блокируется и создаёт bounded notice.

---

## 18. Evidence and completion protocol

### 18.1. Evidence projection

```ts
interface EvidenceAdmissionKeyBodyV1 {
  schemaVersion: 'monarch.evidence-admission-key-body.v1';
  executionId: string;
  goalRevision: 1;
  sourceReceiptRef: ImmutableContentRefV1;
  sourceReceiptDigest: DigestV1;
  resultRef: ImmutableContentRefV1;
  resultDigest: DigestV1;
  verificationRecipeDigest: DigestV1;
  projectorImplementationHash: ImplementationHashV1;
}

interface EvidenceNodeV1 {
  schemaVersion: 'monarch.evidence-node.v1';
  id: string;
  executionId: string;
  goalRevision: 1;
  kind: 'kernel-receipt';
  invocationId: string;
  capabilityId: 'workspace.storage.audit.v2';
  capabilityContractDigest: DigestV1;
  canonicalInputDigest: DigestV1;
  outputSchemaDigest: DigestV1;
  outputDigest: DigestV1;
  sourceRef: ImmutableContentRefV1;
  sourceDigest: DigestV1;
  traversalAccountingProofRef: ImmutableContentRefV1;
  traversalAccountingProofDigest: DigestV1;
  projectorId: 'workspace.storage.audit.evidence-projector.v1';
  projectorVersion: '1';
  projectorImplementationHash: ImplementationHashV1;
  verificationRecipeDigest: DigestV1;
  admittedAt: string;
  observedFrom: string;
  observedUntil: string;
  completeness: 'complete' | 'partial';
  walkVerdict: 'walk-completed-without-local-error' | 'walk-incomplete';
  authority: 'application-kernel';
  allowedSelectorIds: CoreSelectorIdV1[];
  redactionClass: 'private';
  payloadRef: ImmutableContentRefV1;
  payloadDigest: DigestV1;
  admissionKey: DigestV1;
  bodyDigest: DigestV1;
}

interface EvidenceGraphSnapshotV1 {
  schemaVersion: 'monarch.evidence-graph-snapshot.v1';
  executionId: string;
  revision: SafeCounterV1;
  cutoffExecutionSequence: SafeCounterV1;
  orderedNodes: [{
    id: string; bodyRef: ImmutableContentRefV1; bodyDigest: DigestV1;
  }];
  bodyDigest: DigestV1;
}
```

Projection is idempotent by `admissionKey = digestV1('evidence-admission-key', JCS(EvidenceAdmissionKeyBodyV1))`. String concatenation or reuse of `evidence-node-body` is forbidden. Core Projector never mutates result bytes: `EvidenceNode.sourceRef/sourceDigest` resolve the Kernel receipt, `payloadRef/payloadDigest` equal its `resultRef/resultDigest`, the repeated accounting-proof ref/digest equal the same receipt branch, `admittedAt` equals receipt `kernelAdmittedAt`, and `observedFrom/observedUntil` equal output start/finish wall labels whose attestations were validated. It validates output/proof/counter/root/volume/policy bindings under the pinned recipe, then records `walkVerdict`, completeness and allowed selectors in the immutable EvidenceNode. `complete` is legal iff the derived verdict is `walk-completed-without-local-error`; a structurally consistent incomplete proof yields `partial|walk-incomplete`; any proof mismatch creates no node. Selectors with `source='capability-output'` read only the retained output, while `source='evidence-node'` may read only allowlisted derived node fields such as `/walkVerdict`, `/completeness` and `/traversalAccountingProofDigest`. Same key/different node body is corruption. Core has exactly one node and no edge record/retry lineage; derived/child/corroboration graphs require another manifest.

Operational claim additionally declares accepted authority. Core accepts only Application/Kernel-admitted read receipts. Engine/worker/provider self-declared `verified` is untrusted and those evidence profiles are unavailable.

### 18.1.1. Deterministic attempt/evidence selection

```ts
interface RequirementAttemptSelectionV1 {
  schemaVersion: 'monarch.requirement-attempt-selection.v1';
  executionId: string;
  goalContractId: string;
  goalRevision: 1;
  requirementId: 'storage.audit.requirement.v1';
  invocationId: string;
  invocationStateRevision: SafeCounterV1;
  eligibleEvidence: [{
    id: string; bodyRef: ImmutableContentRefV1; bodyDigest: DigestV1;
  }];
  selectionPolicy: 'single-core-invocation';
  bodyDigest: DigestV1;
}
```

Core admits exactly one Invocation and one EvidenceNode for its single Goal requirement. `RequirementAttemptSelectionV1` freezes that exact invocation revision and node ref/digest; it is not a generic chooser. Zero or two nodes, another invocation ID, another Execution/Goal revision, or multiple values for one selector is `conflicting-evidence|evidence-graph-incomplete`. Retry always creates a new linked Execution/Goal and cannot import the prior node. “Latest timestamp”, first convenient value and model-suggested evidence selection do not exist.

### 18.2. Completion request

```ts
interface CompletionCertifierContractV1 {
  schemaVersion: 'monarch.completion-certifier-contract.v1';
  id: 'agent-core-read-certifier.v1';
  version: '1';
  inputSchemaDigest: DigestV1;
  assessmentBodySchemaDigest: DigestV1;
  implementationHash: ImplementationHashV1;
  temporalComparator: {
    id: 'rfc3339-utc-millisecond-order.v1';
    implementationHash: ImplementationHashV1;
    rule: 'verify-clock-attestations-then-compare-exact-utc-ms';
  };
  terminalPolicyRef: ImmutableContentRefV1;
  terminalPolicyDigest: DigestV1;
  bodyDigest: DigestV1;
}

interface PresentationContractV1 {
  schemaVersion: 'monarch.presentation-contract.v1';
  id: 'workspace-storage-audit-presentation.v1';
  allowedPresentationKeys: string[];
  requiredPresentationKeys: string[];
  templates: [
    { locale: 'en'; verdict: 'verified'; claimKeyMode: 'required-set'; unresolvedMode: 'forbidden'; templateId: 'presentation.storage.audit.en.verified.v1'; templateVersion: '1'; templateText: string },
    { locale: 'en'; verdict: 'partial'; claimKeyMode: 'required-set'; unresolvedMode: 'required'; templateId: 'presentation.storage.audit.en.partial.v1'; templateVersion: '1'; templateText: string },
    { locale: 'en'; verdict: 'blocked'; claimKeyMode: 'none'; unresolvedMode: 'required'; templateId: 'presentation.storage.audit.en.blocked.v1'; templateVersion: '1'; templateText: string },
    { locale: 'ru'; verdict: 'verified'; claimKeyMode: 'required-set'; unresolvedMode: 'forbidden'; templateId: 'presentation.storage.audit.ru.verified.v1'; templateVersion: '1'; templateText: string },
    { locale: 'ru'; verdict: 'partial'; claimKeyMode: 'required-set'; unresolvedMode: 'required'; templateId: 'presentation.storage.audit.ru.partial.v1'; templateVersion: '1'; templateText: string },
    { locale: 'ru'; verdict: 'blocked'; claimKeyMode: 'none'; unresolvedMode: 'required'; templateId: 'presentation.storage.audit.ru.blocked.v1'; templateVersion: '1'; templateText: string }
  ];
  denialMessages: Array<{
    locale: 'en' | 'ru';
    scope: CompletionDenialV1['scope'];
    code: CompletionDenialCodeV1;
    detailCode?: CompletionDenialDetailCodeV1;
    message: string;
  }>;
  rendererImplementationHash: ImplementationHashV1;
  maxRenderedUtf8Bytes: SafeCounterV1;
  bodyDigest: DigestV1;
}

interface CompletionRequestV1 {
  schemaVersion: 'monarch.completion-request.v1';
  requestId: string;
  executionId: string;
  goalRevision: 1;
  requirementIds: ['storage.audit.requirement.v1'];
}
```

Core Application creates this request from the exact Goal requirements after the direct host settles; no model-selected evidence IDs or free-form rationale enter assessment. Presentation template grammar is plain UTF-8 text plus only exact tokens `{{<allowed-presentation-key>}}` and reserved `{{@unresolved}}`; conditionals, loops, code/HTML execution, dynamic field names, alternate escaping and any other brace token are invalid. Verified/partial templates contain every global `requiredPresentationKeys` member exactly once; verified forbids `@unresolved`, partial requires it once, blocked contains no claim token and requires `@unresolved` once. `denialMessages` contains exactly one static message for each legal §18.3 `(scope,code,detail-or-absent)` row in each locale—54 unique entries—and no `{`/`}`, raw IDs, diagnostic content or free-form detail placeholder. Renderer tokenizes the selected template exactly once before substitution, expands unresolved in canonical denial order, formats TypedValues from their declared canonical encoding and inserts every value/message as inert plain text; inserted bytes are never tokenized or interpreted again. Final output is exposed through a plain-text/text-node surface, never reparsed as Markdown/HTML/code, and `maxRenderedUtf8Bytes` is enforced before exposure.

Before assessment, Application freezes:

```ts
interface CompletionAssessmentInputV1 {
  schemaVersion: 'monarch.completion-assessment-input.v1';
  completionRequestId: string;
  completionCommitCommandId: string;
  executionId: string;
  expectedExecutionRevision: SafeCounterV1;
  goalContractRef: ImmutableContentRefV1;
  goalContractId: string;
  goalRevision: 1;
  goalContractDigest: DigestV1;
  goalSemanticBodyRef: ImmutableContentRefV1;
  goalSemanticBodyDigest: DigestV1;
  evidenceGraphSnapshotRef: ImmutableContentRefV1;
  evidenceGraphRevision: SafeCounterV1;
  evidenceGraphSnapshotDigest: DigestV1;
  attemptSelections: [{
    requirementId: 'storage.audit.requirement.v1';
    selectionRef: ImmutableContentRefV1;
    selectionBodyDigest: DigestV1;
  }];
  invocationStates: [{
    invocationId: string;
    stateRevision: SafeCounterV1;
    invocationRef: ImmutableContentRefV1;
    invocationBodyDigest: DigestV1;
  }];
  authorityScopeRef: ImmutableContentRefV1;
  authorityScopeDigest: DigestV1;
  capabilityContractRef: ImmutableContentRefV1;
  capabilityContractDigest: DigestV1;
  verificationRecipeRef: ImmutableContentRefV1;
  verificationRecipeDigest: DigestV1;
  terminalPolicyRef: ImmutableContentRefV1;
  terminalPolicyDigest: DigestV1;
  runtimeFeatureSetRef: ImmutableContentRefV1;
  runtimeFeatureSetDigest: DigestV1;
  certifierContractRef: ImmutableContentRefV1;
  certifierContractDigest: DigestV1;
  canonicalizationProfileRef: ImmutableContentRefV1;
  canonicalizationProfileDigest: DigestV1;
  canonicalizationProfileId: CanonicalizationProfileV1['id'];
  assessedAt: string;
  clockAttestation: ClockAttestationV1;
  presentationContractRef: ImmutableContentRefV1;
  presentationContractDigest: DigestV1;
  bodyDigest: DigestV1;
}
```

Application creates the inline `CompletionRequestV1`, allocates one future `completionCommitCommandId`, retains the exact assessment input body/ref and appends `completion.requested` in one idempotent fixture commit keyed by `(executionId, requestId)`. That request-freeze commit has its own appender `commandId`, stable on retry and byte-distinct from the reserved future terminal-commit ID; one command ID can never name two different commit fingerprints. Event `payload.executionId`, request `executionId/requestId` and assessment-input `executionId/completionRequestId` MUST be byte-equal. `assessedAt` MUST byte-equal `clockAttestation.wallTime`; the attestation, wall label and future commit command ID are allocated once by the fixture appender, never supplied by Certifier or read again from a current clock. Every `CompletionCommitAssessmentV1.commandId` and both resulting certification/terminal event `commandId` values equal that frozen future ID; the earlier `completion.requested` event does not. Retry returns the same frozen body/time/IDs; same key with another body or either ID substituted is corruption. `requirementIds` must exactly equal the single Goal semantic requirement.

All arrays are sorted by protocol-defined stable keys before hashing. `bodyDigest` uses domain `assessment-input`. Every authority digest is paired with an allowlisted retained immutable ref or a fully inline bounded body. Before freezing, Application proves: Goal/capability/runtime/AuthorityScope refs equal the admitted Goal and its GoalAdmissionBinding; recipe and presentation refs equal that exact capability contract; Certifier ref/digest equals `RuntimeFeatureSetV1.completionCertifierContractRef/digest`, Goal and GoalAdmissionBinding; terminal policy equals that Certifier contract; canonicalization profile equals the RuntimeFeatureSet manifest; each Invocation input/policy/contract equals the one Goal requirement; and every selection/node belongs to that Invocation/Execution/Goal revision. Selectors come only from the Goal semantic body and pinned claim templates; predicates are the closed Protocol union evaluated by the pinned Certifier implementation; projector identity comes only from `VerificationRecipeV1`. There is no ambient selector/projector/predicate registry or dependency set in core. The Certifier reads only this immutable fence and referenced content; current mutable projections, current clock or feature flags are not implicit inputs.

JSON Schema performs structural timestamp validation only. Cross-field temporal order is owned by the pinned `temporalComparator`: it validates start/finish/assessment `ClockAttestationV1` boot/origin/continuity and monotonic order first, proves the elapsed budget without wall subtraction, then parses exact UTC-millisecond strings to mathematical epoch-millisecond integers and evaluates wall-label equality/order plus assessment freshness. Application-process restart on the same proven boot/origin may resume from retained evidence. OS reboot or unknown continuity between observation and assessment fails closed with `clock-boot-mismatch|clock-continuity-unknown`; old evidence is not certified and product recovery must create a newly admitted Execution/read if the user still wants it. A generator MUST NOT claim JSON Schema 2020-12 itself compares sibling values. Future stable/snapshot coverage needs a new certifier/schema contract.

### 18.3. Denial

```ts
type CompletionDenialCodeV1 =
  | 'required-claim-missing' | 'wrong-capability' | 'input-binding-mismatch'
  | 'selector-missing' | 'selector-contract-mismatch' | 'predicate-failed'
  | 'partial-evidence' | 'invocation-unsettled'
  | 'conflicting-evidence' | 'evidence-graph-incomplete'
  | 'policy-changed' | 'clock-attestation-invalid' | 'presentation-claim-missing';

type CompletionDenialDetailCodeV1 =
  | 'goal-ref-mismatch' | 'runtime-feature-set-mismatch' | 'authority-scope-mismatch'
  | 'capability-contract-mismatch' | 'recipe-mismatch' | 'presentation-contract-mismatch'
  | 'zero-evidence-node' | 'multiple-evidence-nodes' | 'evidence-ref-mismatch'
  | 'invocation-ref-mismatch' | 'selector-source-mismatch' | 'selector-type-mismatch'
  | 'predicate-bound-failed' | 'partial-not-admitted'
  | 'clock-boot-mismatch' | 'clock-origin-mismatch' | 'clock-continuity-unknown'
  | 'clock-wall-label-mismatch' | 'required-presentation-key-missing'
  | 'policy-digest-mismatch';

type CompletionDenialV1 =
  | {
      schemaVersion: 'monarch.completion-denial.v1';
      scope: 'global';
      code: 'evidence-graph-incomplete' | 'policy-changed' | 'clock-attestation-invalid';
      detailCode?: CompletionDenialDetailCodeV1;
      recoverability: 'retry-read' | 'revise-plan' | 'ask-user' | 'not-recoverable';
    }
  | {
      schemaVersion: 'monarch.completion-denial.v1';
      scope: 'requirement';
      code: Exclude<CompletionDenialCodeV1,
        'evidence-graph-incomplete' | 'policy-changed' | 'clock-attestation-invalid'>;
      requirementId: 'storage.audit.requirement.v1';
      claimId?: CoreClaimTemplateIdV1;
      evidenceId?: string;
      detailCode?: CompletionDenialDetailCodeV1;
      recoverability: 'retry-read' | 'revise-plan' | 'ask-user' | 'not-recoverable';
    };
```

The generated denial `oneOf` is the following exact row expansion; a row with `—` requires `detailCode` to be absent. `R/C/E` means required `requirementId/claimId/evidenceId`; every ID not named by that row is forbidden:

| Scope + code | Required detailCode | Required IDs | recoverability |
|---|---|---|---|
| global `evidence-graph-incomplete` | `goal-ref-mismatch` | — | `not-recoverable` |
| global `evidence-graph-incomplete` | `zero-evidence-node` | — | `retry-read` |
| global `evidence-graph-incomplete` | `multiple-evidence-nodes` | — | `revise-plan` |
| global `evidence-graph-incomplete` | `evidence-ref-mismatch` | — | `not-recoverable` |
| global `evidence-graph-incomplete` | `invocation-ref-mismatch` | — | `not-recoverable` |
| global `policy-changed` | `runtime-feature-set-mismatch` | — | `revise-plan` |
| global `policy-changed` | `authority-scope-mismatch` | — | `ask-user` |
| global `policy-changed` | `capability-contract-mismatch` | — | `revise-plan` |
| global `policy-changed` | `recipe-mismatch` | — | `revise-plan` |
| global `policy-changed` | `presentation-contract-mismatch` | — | `revise-plan` |
| global `policy-changed` | `policy-digest-mismatch` | — | `revise-plan` |
| global `clock-attestation-invalid` | `clock-boot-mismatch` | — | `retry-read` |
| global `clock-attestation-invalid` | `clock-origin-mismatch` | — | `retry-read` |
| global `clock-attestation-invalid` | `clock-continuity-unknown` | — | `retry-read` |
| global `clock-attestation-invalid` | `clock-wall-label-mismatch` | — | `not-recoverable` |
| requirement `required-claim-missing` | — | R+C | `retry-read` |
| requirement `wrong-capability` | — | R+E | `revise-plan` |
| requirement `input-binding-mismatch` | — | R+E | `revise-plan` |
| requirement `selector-missing` | — | R+C+E | `revise-plan` |
| requirement `selector-contract-mismatch` | `selector-source-mismatch` | R+C+E | `revise-plan` |
| requirement `selector-contract-mismatch` | `selector-type-mismatch` | R+C+E | `revise-plan` |
| requirement `predicate-failed` | `predicate-bound-failed` | R+C+E | `ask-user` |
| requirement `partial-evidence` | — | R+E | `retry-read` |
| requirement `partial-evidence` | `partial-not-admitted` | R+E | `ask-user` |
| requirement `invocation-unsettled` | — | R | `not-recoverable` |
| requirement `conflicting-evidence` | — | R+E | `revise-plan` |
| requirement `presentation-claim-missing` | `required-presentation-key-missing` | R+C | `revise-plan` |

Free-form/localized `detail` is forbidden inside deterministic assessment. The union above plus this table is the complete legal `(scope, code, detailCode, ID presence, recoverability)` source; the generator may not invent another combination. Public wording maps stable denial/detail codes through versioned templates.

The core verdict mapping is itself immutable certifier input, not prose or implementation convention:

```ts
interface CompletionTerminalPolicyV1 {
  schemaVersion: 'monarch.completion-terminal-policy.v1';
  id: 'agent-core-read-terminal-policy.v1';
  verifiedWhen: 'all-required-claims-satisfied';
  partialCodes: ['partial-evidence'];
  partialGateFailure: 'blocked';
  blockedCodes: [
    'required-claim-missing', 'wrong-capability', 'input-binding-mismatch',
    'selector-missing', 'selector-contract-mismatch', 'predicate-failed',
    'invocation-unsettled', 'conflicting-evidence',
    'evidence-graph-incomplete', 'policy-changed', 'clock-attestation-invalid',
    'presentation-claim-missing'
  ];
  verdictPrecedence: ['blocked', 'partial', 'verified'];
  bodyDigest: DigestV1;
}
```

The certifier first validates that every assessment denial code occurs in exactly one terminal bucket. No denials means `verified`. Otherwise the first non-empty terminal bucket in `verdictPrecedence` wins. `partial` is available only when every unresolved denial is the no-detail `partial-evidence` row **and** the exact Goal partial gates allow it. When the evidence is partial but the Goal gate forbids it, Certifier emits the single `partial-evidence/partial-not-admitted` row; `partialGateFailure='blocked'` makes that a certified blocked verdict, and any listed blocked code dominates. It then performs one bounded presentation-key pass: a preliminary verified/partial assessment must contain each of the contract's 16 global required keys exactly once; every missing key adds its exact `presentation-claim-missing/required-presentation-key-missing` denial, after which verdict is recomputed once and must be blocked. The blocked presentation profile requires no claim key, so this cannot recurse. Final verified has empty unresolved + exact 16-key requirement, final partial has only no-detail partial-evidence unresolved + exact 16-key requirement, and final blocked has at least one unresolved + `requiredPresentationKeys=[]` **and `claimBindings=[]`**. Satisfied/observed values remain reachable only through the retained private assessment-input/Evidence refs; they cannot leak as unqualified API/UI fields on a blocked result. A denial's `recoverability` is disclosure/planning metadata only; it never authorizes an automatic repeat, and core retry is always a new linked Execution admitted separately. Core assessment has no `failed` verdict: infrastructure/output-integrity failure is a typed noncertified Execution failure, not a locally certified Goal assessment. `assessment-fence-stale` is not an assessment denial at all: Store returns it as a non-terminal compare-and-swap protocol error and appends no terminal events. Adding/reclassifying a denial code requires a new policy ID/body digest and fixture.

### 18.4. Certificate ordering

Pure Certifier returns an assessment, then Application submits the following exact command body. Store fixture revalidates that Goal/evidence/invocation/authority revisions still match. One atomic Execution commit creates the local certificate envelope once and appends `completion.certified` immediately followed by matching `execution.completed|partial|blocked`. Stale fence appends nothing and returns `assessment-fence-stale`.

```ts
interface CertificationKeyBodyV1 {
  schemaVersion: 'monarch.certification-key-body.v1';
  executionId: string;
  expectedExecutionRevision: SafeCounterV1;
  assessmentInputDigest: DigestV1;
  assessmentBodyDigest: DigestV1;
}

interface CompletionCommitAssessmentV1 {
  schemaVersion: 'monarch.completion-commit-assessment.v1';
  commandId: string;
  keyBody: CertificationKeyBodyV1;
  certificationKey: DigestV1;
  assessmentInputRef: ImmutableContentRefV1;
  assessmentBodyRef: ImmutableContentRefV1;
  assessmentBodyDigest: DigestV1;
}
```

`certificationKey = digestV1('certification-key', JCS(CertificationKeyBodyV1))`. It never reuses the `assessment-body` domain and never hashes string concatenation. `CompletionCommitAssessmentV1.commandId` must equal the frozen assessment-input commit command ID; a new random retry ID is invalid. A unique constraint creates the certificate ID exactly once inside the atomic commit; the certificate copies the already frozen assessment time/attestation and never reads a second verdict clock. Both terminal events get their once-allocated non-authority `occurredAt` from the appender and do not feed assessment freshness. Every retry returns that byte-identical retained envelope/events; same key with any other command/key/body/ref is corruption. A simulator cut cannot create two certificate IDs or a retained certificate disconnected from its terminal transition; process/power-loss durability remains the separate backend gate. Presentation occurs after this commit; a future Interaction terminal row publishes only through the unavailable product-facade delivery saga.

### 18.5. Deterministic assessment and retained values

```ts
interface CompletionAssessmentBodyV1 {
  schemaVersion: 'monarch.completion-assessment-body.v1';
  executionId: string;
  goalContractRef: ImmutableContentRefV1;
  goalContractId: string;
  goalRevision: 1;
  goalContractDigest: DigestV1;
  admissionBindingRef: ImmutableContentRefV1;
  admissionBindingDigest: DigestV1;
  acceptedContextDigest: DigestV1;
  presentationLocale: 'ru' | 'en';
  assessmentInputRef: ImmutableContentRefV1;
  assessmentInputDigest: DigestV1;
  terminalPolicyDigest: DigestV1;
  presentationContractRef: ImmutableContentRefV1;
  presentationContractDigest: DigestV1;
  verdict: 'verified' | 'partial' | 'blocked';
  claimBindings: Array<{
    requirementId: 'storage.audit.requirement.v1';
    claimId: CoreClaimTemplateIdV1;
    invocationId: string;
    evidenceId: string;
    evidenceBodyDigest: DigestV1;
    selectorId: CoreSelectorIdV1;
    selectorBodyDigest: DigestV1;
    typedValue: TypedValueV1;
    presentationKey: string;
  }>;
  unresolved: Array<{
    denial: CompletionDenialV1;
  }>;
  requiredPresentationKeys: string[];
}

interface CompletionCertificateV1 {
  schemaVersion: 'monarch.completion-certificate.v1';
  trustProfile: 'local-trusted-writer.v1';
  issuer: 'monarch-local-runtime';
  id: string;
  certificationKey: DigestV1;
  assessmentInputRef: ImmutableContentRefV1;
  assessmentInputDigest: DigestV1;
  assessmentBody: CompletionAssessmentBodyV1;
  assessmentBodyDigest: DigestV1;
  assessmentFrozenAt: string;
  assessmentClockAttestation: ClockAttestationV1;
  envelopeDigest: DigestV1;
}
```

`assessmentBodyDigest = digestV1('assessment-body', JCS(CompletionAssessmentBodyV1))`. Goal/admission-binding/context/locale/presentation fields are exact copies resolved from the frozen assessment input; Certifier cannot substitute current registry/UI values. Request event, assessment body, commit command and certificate retain the same resolvable `assessmentInputRef`, and every repeated digest equals that ref's schema-selected content identity plus `keyBody.assessmentInputDigest`; no digest→object query or ambient current-stream search is permitted. Certificate `assessmentFrozenAt` MUST byte-equal input `assessedAt`, while `assessmentClockAttestation` MUST be byte-equal to the input attestation and its `wallTime`; no caller/current clock can replace either during certification. Terminal event `occurredAt` remains non-authority observability and cannot change the verdict. `envelopeDigest` uses domain `completion-certificate-body` over the full envelope with only `/envelopeDigest` omitted; it is not the assessment digest. Claim bindings are sorted by `(requirementId, claimId)` and unresolved entries by stable scope/code tuple. Each binding stores one reproducible `TypedValueV1` whose classification equals the fixed Goal claim classification (`private` in core); digest-only claims or Certifier-selected reclassification cannot be certified. A blocked assessment has an exact empty binding array regardless of safe intermediate observations; verified/partial retain only the bindings permitted by their final verdict. `requiredPresentationKeys` obeys the final-verdict rule above, not an implementation default. The object is a local trusted-writer completion record, not a cryptographic third-party attestation. Canonical assessment and the once-created retained envelope are byte-stable across retries.

### 18.6. Presentation and streaming truth fence

For an operational Execution, raw `engine.text-delta` is not user-visible operational prose. It may enter a private ephemeral buffer or a bounded public non-factual status such as “Проверяю…”, selected by code; it MUST NOT expose counts, paths, effect success, percentages derived from operational output or terminal wording before certification.

```ts
interface EvidenceViewV1 {
  schemaVersion: 'monarch.evidence-view.v1';
  trustProfile: 'local-trusted-writer.v1';
  issuer: 'monarch-local-runtime';
  executionId: string;
  goalContractRef: ImmutableContentRefV1;
  goalContractId: string;
  goalRevision: 1;
  goalContractDigest: DigestV1;
  admissionBindingRef: ImmutableContentRefV1;
  admissionBindingDigest: DigestV1;
  acceptedContextDigest: DigestV1;
  certificateId: string;
  certificateRef: ImmutableContentRefV1;
  certificationKey: DigestV1;
  certificateEnvelopeDigest: DigestV1;
  verdict: CompletionAssessmentBodyV1['verdict'];
  fields: Array<{
    requirementId: 'storage.audit.requirement.v1';
    claimId: CoreClaimTemplateIdV1;
    presentationKey: string;
    typedValue: TypedValueV1;
  }>;
  unresolved: CompletionDenialV1[];
  artifactRefs: [];
  requiredPresentationKeys: string[];
  locale: 'ru' | 'en';
  presentationContractRef: ImmutableContentRefV1;
  presentationContractDigest: DigestV1;
  bodyDigest: DigestV1;
}

interface StructuredResultV1 {
  schemaVersion: 'monarch.structured-result.v1';
  trustProfile: 'local-trusted-writer.v1';
  issuer: 'monarch-local-runtime';
  executionId: string;
  evidenceViewRef: ImmutableContentRefV1;
  evidenceViewBodyDigest: DigestV1;
  certificateId: string;
  certificateEnvelopeDigest: DigestV1;
  status: 'verified' | 'partial' | 'blocked';
  fields: Array<{ presentationKey: string; typedValue: TypedValueV1 }>;
  unresolved: CompletionDenialV1[];
  disclosures: Array<{
    presentationKey: string;
    parameters: Array<{ key: string; value: TypedValueLiteralV1 }>;
  }>;
  artifacts: [];
  locale: 'ru' | 'en';
  templateId: CorePresentationTemplateIdV1;
  templateVersion: '1';
  rendererImplementationHash: ImplementationHashV1;
  presentationContractDigest: DigestV1;
  bodyDigest: DigestV1;
}
```

Application creates `EvidenceViewV1` only from the exact retained `certificateRef`. The embedded assessment body supplies the exact Goal/admission-binding/accepted-context/presentation-contract refs, digests and frozen locale; no current Interaction, UI/OS locale, contract registry or digest→ref search is read. View and result repeat exact `trustProfile='local-trusted-writer.v1'` and `issuer='monarch-local-runtime'`; a missing, changed or stronger-sounding value fails projection. These fields explicitly deny third-party/notarial interpretation: the chain is deterministic local evidence under the trusted local writer threat model, not hostile-writer protection. View certificate identity/envelope/verdict, Goal/admission/context bindings, locale, fields, unresolved entries and required presentation keys are a lossless sorted projection of that envelope. It cannot choose another value/status/locale. For `blocked`, the certificate, EvidenceView and StructuredResult therefore all have exact `fields=[]`; a client cannot recover observed scalars from the public result and mistake them for satisfied claims. Core storage has no artifact claim, so both artifact arrays are exact empty tuples. `bodyDigest` is then computed and retained.

Presentation receives only that retained EvidenceView ref/body digest and the exact pinned `PresentationContractV1`. The contract contains exactly one unique template for each `(en|ru, verified|partial|blocked)` pair and no fallback lookup; frozen view locale + verdict select one. `StructuredResultV1.evidenceViewRef/bodyDigest`, trust profile/issuer, certificate identity/envelope, status, fields, **unresolved denials**, locale and empty artifacts MUST equal the view under manifest binding rule `view-result-projection`; template ID/version/modes must equal that selected contract row. Disclosures are the deterministic expansion of the selected data keys and exact unresolved code tuples through the 54-entry locale table and `rendererImplementationHash`. Verified requires 16 data tokens and no unresolved token; partial requires the same 16 plus one unresolved token; blocked requires only one unresolved token and never substitutes missing claim data. Duplicate/missing/unknown placeholders, omitted/changed unresolved item, new scalar/artifact, status/locale/template change or output beyond `maxRenderedUtf8Bytes` fails. The `presentation.completed` event cites both retained bodies. Core has no optional language model rendering. Mandatory window/temporal/exclusion disclosures are Goal claims and required keys, not uncertified renderer reads. Renderer failure retries only presentation and cannot change terminal Execution. Any legacy comparison remains an explicitly untyped, non-authority lab report outside the manifest and cannot update Execution/Interaction truth or be imported as a protocol instance.

---

## 19. Agent Engine Protocol

> **Extension note — unavailable in `agent-core-read.v1`.** The schema lab invokes the deterministic capability fixture directly. Engine negotiation is retained as future design and cannot be required by the base manifest.

### 19.1. Negotiation

```ts
type EngineFeatureIdV1 =
  | 'streaming' | 'structured-decision' | 'safe-boundary-steering'
  | 'resume-token' | 'usage' | 'compaction-notification'
  | 'cancellation-acknowledgement';

interface EngineDescriptorV1 {
  schemaVersion: 'monarch.engine-descriptor.v1';
  driverId: string;
  driverVersion: string;
  loadedPackageDigest: DigestV1;
  executableIdentityDigest: DigestV1;
  sbomDigest: DigestV1;
  publisherAttestationRef?: string;
  publisherAttestationDigest?: DigestV1;
  protocolVersions: string[];
  features: Record<EngineFeatureIdV1, boolean>;
  maxContextTokens?: number;
  providerClass: 'local' | 'cloud' | 'hybrid';
  providerId: string;
  runtimeIdentity: string;
  termsProfileRef?: string;
  dataFlowProfileRef?: string;
}

interface EngineResumeTokenMetadataV1 {
  schemaVersion: 'monarch.engine-resume-token-metadata.v1';
  tokenRef: string;
  tokenDigest: DigestV1;
  encrypted: true;
  driverId: string;
  driverVersion: string;
  loadedPackageDigest: DigestV1;
  providerId: string;
  termsVersion?: string;
  executionId: string;
  goalRevision: number;
  contextDigest: DigestV1;
  issuedAt: string;
  expiresAt: string;
  maxBytes: number;
  invalidationEpoch: number;
}
```

Host verifies loaded bytes/identity against trusted registration, selects exact version and records descriptor digest in `runtime.bound`. Descriptor self-declaration alone is insufficient. Package/signature/SBOM admission and automatic quarantine on sequence/cancel/schema violations are release fixtures; an unverified driver cannot join an operational cohort.

### 19.1.1. Engine DTOs

```ts
interface EngineHandleV1 {
  engineSessionId: string;
  driverId: string;
  driverVersion: string;
  protocolVersion: 'monarch.agent-engine.v1';
  activationId: string;
  activationGeneration: number;
}

interface EngineOpenV1 {
  schemaVersion: 'monarch.engine-open.v1';
  executionId: string;
  activationId: string;
  activationGeneration: number;
  goalContractRef: string;
  goalContractDigest: DigestV1;
  goalRevision: number;
  contextProjectionRef: string;
  contextDigest: DigestV1;
  planRevision: number;
  catalogSnapshotRef: string;
  catalogRevision: number;
  catalogDigest: DigestV1;
  authoritySummaryRef: string;
  authoritySummaryDigest: DigestV1;
  privacyScopeDigest: DigestV1;
  providerGrantId?: string;
  egressPermitId?: string;
  resumeTokenRef?: string;
  resumeTokenDigest?: DigestV1;
  selectedFeatures: EngineFeatureIdV1[];
}

interface EngineTurnInputV1 {
  schemaVersion: 'monarch.engine-turn-input.v1';
  engineSubmitId: string;
  kind: 'initial' | 'follow-up' | 'repair' | 'resume' | 'workflow-continuation';
  publicInputRefs: string[];
  publicInputDigest: DigestV1;
  allowedDecisionKinds: NormalizedDecisionV1['kind'][];
  denialCodes?: string[];
  contextDigest: DigestV1;
  goalRevision: number;
  goalContractDigest: DigestV1;
  planRevision: number;
  catalogRevision: number;
  catalogDigest: DigestV1;
  safeBoundaryId: string;
  steeringEpoch: number;
  compactionEpoch: number;
}

interface EngineDecisionResolutionV1 {
  schemaVersion: 'monarch.engine-decision-resolution.v1';
  resolutionId: string;
  decisionId: string;
  engineSubmitId: string;
  disposition: 'admission-denied' | 'awaiting-input' | 'awaiting-approval'
    | 'invocation-result' | 'cancelled' | 'stale';
  publicResultRef?: string;
  publicResultDigest?: DigestV1;
  denialCodes?: string[];
  contextDigest: DigestV1;
  goalRevision: number;
  goalContractDigest: DigestV1;
  planRevision: number;
  planDigest: DigestV1;
  catalogRevision: number;
  catalogDigest: DigestV1;
  safeBoundaryId: string;
  steeringEpoch: number;
  compactionEpoch: number;
}

interface EngineSteerV1 {
  schemaVersion: 'monarch.engine-steer.v1';
  steeringCommandId: string;
  admittedFollowUpId: string;
  admittedFollowUpDigest: DigestV1;
  expectedSafeBoundaryId: string;
  expectedSteeringEpoch: number;
  contentRef: string;
  contentDigest: DigestV1;
}

interface EngineCancelV1 {
  schemaVersion: 'monarch.engine-cancel.v1';
  cancellationCommandId: string;
  engineSessionId: string;
  activationId: string;
  activationGeneration: SafeCounterV1;
  reasonCode: string;
  deadlineAt: string;
}

interface EngineCancelReceiptV1 {
  schemaVersion: 'monarch.engine-cancel-receipt.v1';
  cancellationCommandId: string;
  engineSessionId: string;
  activationId: string;
  activationGeneration: SafeCounterV1;
  disposition: 'acknowledged' | 'already-ended' | 'unsupported' | 'deadline-exceeded';
  lastDriverEventSequence: SafeCounterV1;
  receivedAt: string;
}

type EngineEventPayloadV1 =
  | { kind: 'started' }
  | { kind: 'text-delta'; text: string; visibility: 'private-operational-buffer' }
  | { kind: 'public-rationale'; code: string; parameters: JsonObject }
  | { kind: 'decision'; decision: NormalizedDecisionV1 }
  | { kind: 'safe-boundary'; boundaryId: string }
  | { kind: 'usage'; inputTokens?: number; outputTokens?: number; providerUsageRef?: string }
  | { kind: 'resume-token'; tokenRef: string; tokenDigest: DigestV1 }
  | { kind: 'completed'; finishReason: string }
  | { kind: 'cancelled'; receipt: EngineCancelReceiptV1 }
  | { kind: 'failed'; code: string; retryability: 'same-activation' | 'new-activation' | 'never' };

interface EngineEventV1 {
  schemaVersion: 'monarch.engine-event.v1';
  engineSessionId: string;
  engineSubmitId: string;
  driverEventSequence: number;
  activationId: string;
  activationGeneration: number;
  contextDigest: DigestV1;
  goalRevision: number;
  goalContractDigest: DigestV1;
  planRevision: number;
  catalogRevision: number;
  catalogDigest: DigestV1;
  safeBoundaryId: string;
  steeringEpoch: number;
  compactionEpoch: number;
  payload: EngineEventPayloadV1;
}
```

Handle is process-local and not an authority token. Every event fence is checked before journal admission; unknown fields/sequence gaps/stale submit/context/boundary/generation are rejected. Driver never receives Kernel handles, approval tokens, protected-store keys or unrestricted effect authority.

Native tool/function callback pauses after one admitted `engine.decision`. Host responds through `engine.resolve-decision(EngineDecisionResolutionV1)`; the driver then emits a new ordered event stream/submit continuation. Public result is a bounded admitted projection, never Kernel handle/approval token/raw protected value. Resolution is idempotent by `resolutionId + decisionId`; stale fences return `stale`. A driver lacking this bidirectional operation cannot advertise native tool callbacks and is limited to answer-only/deterministic proposal mode.

### 19.2. Open

`engine.open` gets:

- execution/activation IDs and generation;
- neutral context projection ref/digest;
- Goal/plan/catalog revisions;
- permission/effect summary, never raw authority token;
- protocol feature selection;
- optional opaque resume token ref;
- required ProviderExecutionGrant/EgressAdmissionPermit refs for cloud/hybrid; Host creates EgressAttempt at actual send-start boundary;
- abort signal outside persisted payload.

### 19.3. Submit

Submit input contains user/steering message or continuation reason and bounded available commands. Driver emits ordered events with driver-local sequence; Host maps them to journal events.

### 19.4. Normalized engine events

```text
engine.started
engine.text-delta
engine.public-rationale
engine.decision
engine.safe-boundary
engine.usage
engine.resume-token
engine.completed
engine.cancelled
engine.failed
```

For answer-only Interaction a separate answer renderer may expose admitted text under Claim Integrity. For operational Execution every driver text delta is private and never evidence. Only Host-owned finite status codes may project bounded non-factual progress such as “Проверяю…”. `engine.completed` means driver turn ended, not Execution completed.

Every engine event is wrapped with engine session/submit ID, monotonic driver event sequence, activation generation, exact context/goal/plan/catalog digests and safe-boundary/steering/compaction epochs. Host assigns domain event IDs only after admission.

### 19.5. Tool proposal

Если native SDK вызывает tool callback, driver преобразует его в `engine.decision(propose-invocation)` и ждёт Host result. Callback не получает Kernel handle. Approval lifecycle остаётся снаружи driver.

### 19.6. Steering

`engine.steer` допустим только после persisted `runtime.steer-requested` и safe-boundary fence. Receipt:

```ts
interface EngineSteerReceiptV1 {
  schemaVersion: 'monarch.engine-steer-receipt.v1';
  steeringCommandId: string;
  activationId: string;
  generation: number;
  disposition: 'delivered' | 'deferred' | 'unsupported' | 'stale-generation';
  boundaryId?: string;
  receivedAt: string;
}
```

### 19.7. Resume token

Opaque token:

- encrypted/ref-only;
- driver/provider/version bound;
- invalidated on privacy/provider/goal-incompatible change;
- never treated as authority or proof;
- optional; absence implies context replay into fresh runtime.

### 19.8. Cancellation receipt

`cancel()` returns exact `EngineCancelReceiptV1` with session/activation generation, `acknowledged | unsupported | already-ended | deadline-exceeded`, last admitted sequence and receipt time. Runtime acknowledgement only proves driver stop; it never proves dispatched Kernel/external effect cancellation.

---

## 20. Steering command state machine

```text
accepted
  -> queued
  -> awaiting-safe-boundary
  -> delivered
  -> acknowledged

alternative terminal:
  deferred-to-next-turn | superseded | rejected | cancelled
```

Если crash после `delivered`, но до acknowledgement, Host не redeliver blind в новую generation. Recovery проверяет driver resume semantics; иначе command становится queued next-turn с visible continuity marker.

### 20.1. Provider grant and egress

> **Extension note — unavailable in `agent-core-read.v1`.** Provider entities/events below are not base-manifest schemas and confer no authority until `agent-provider.v1` plus data-flow/consent/threat-model artifacts exist.

```ts
interface ProviderExecutionGrantV1 {
  schemaVersion: 'monarch.provider-execution-grant.v1';
  id: string;
  executionId: string;
  goalRevision: number;
  providerId: string;
  driverIdentity: string;
  termsVersion: string;
  agreementVersion: string;
  endpointPolicyDigest: DigestV1;
  credentialBindingDigest: DigestV1;
  allowedDataClasses: string[];
  allowedRefDigests: string[];
  allowedDerivationPolicyDigest: DigestV1;
  issuedToPrincipalRef: string;
  issuedAt: string;
  expiresAt: string;
  revokeEpoch: number;
}

interface EgressAdmissionPermitV1 {
  schemaVersion: 'monarch.egress-admission-permit.v1';
  id: string;
  grantId: string;
  executionId: string;
  activationId: string;
  engineSubmitId: string;
  providerId: string;
  termsVersion: string;
  contextDigest: string;
  egressManifestDigest: string;
  endpointPolicyDigest: DigestV1;
  credentialBindingDigest: DigestV1;
  dataLineageManifestDigest: DigestV1;
  permittedDataClasses: string[];
  permittedRefDigests: string[];
  checkedRevokeEpoch: number;
  expiresAt: string;
  admittedAt: string;
  state: 'ready' | 'consumed' | 'expired' | 'revoked';
}

interface EgressAttemptV1 {
  schemaVersion: 'monarch.egress-attempt.v1';
  id: string;
  permitId: string;
  grantId: string;
  executionId: string;
  activationId: string;
  engineSubmitId: string;
  egressManifestDigest: string;
  attemptNumber: number;
  parentAttemptId?: string;
  retryReasonCode?: string;
  providerIdempotencyProofRef?: string;
  providerIdempotencyProofDigest?: DigestV1;
  endpointOrigin: string;
  resolvedEndpointDigest?: DigestV1;
  tlsPeerDigest?: DigestV1;
  redirectChainDigest?: DigestV1;
  state: 'not-started' | 'aborted-before-send' | 'started' | 'completed' | 'failed' | 'unknown';
  attemptedDataClasses: string[];
  attemptedRefDigests: string[];
  attemptedBytes?: string; // base10 integer, optional transport observation
  startedAt?: string;
  finishedAt?: string;
  transportOutcomeCode?: string;
  providerAcknowledgementRef?: string;
}

interface ProviderIngressReceiptV1 {
  schemaVersion: 'monarch.provider-ingress-receipt.v1';
  id: string;
  egressAttemptId: string;
  grantId: string;
  providerId: string;
  engineSessionId: string;
  engineSubmitId: string;
  providerRequestId?: string;
  state: 'started' | 'completed' | 'failed' | 'unknown' | 'rejected';
  firstByteAt?: string;
  finishedAt?: string;
  receivedBytes: string;
  receivedDataClasses: string[];
  chunkSequenceHighWatermark: number;
  rawResponseProtectedRef?: string;
  rawResponseDigest?: DigestV1;
  responseSchemaDigest?: DigestV1;
  admissionDisposition: 'not-assessed' | 'admitted' | 'rejected';
  admissionCode?: string;
  transportOutcomeCode?: string;
}
```

Egress Gate creates a short-lived one-use permit and companion `EgressAttempt(state='not-started')` in one commit; permit means admission only. Expiry/revoke/cancel before send atomically consumes/closes it as `aborted-before-send` with no bytes. Immediately before giving the first byte to transport, broker CAS-checks grant expiry/revoke epoch and atomically consumes permit + transitions the same attempt to `started`; this is the send linearization point. Revoke committed before this transition prevents send. Revoke after it prevents new attempts and triggers best-effort cancel, but cannot promise recall of in-flight bytes.

Cloud/hybrid driver sends/receives only through a brokered transport. In-process code with ambient `fetch/socket` authority is not a security boundary and is ineligible for trusted cloud registration. Effect/provider release requires a separate least-privilege process whose outbound network is OS/firewall/AppContainer-equivalent restricted to the broker policy; the driver has authenticated bounded IPC only, and the main Runtime cannot hand it a general network handle. If this confinement cannot be demonstrated on a supported Windows build, cloud/hybrid V3 stays disabled. The broker/OS policy/IPC become explicit TCB and are covered by the threat model.

Broker endpoint policy uses exact HTTPS origins/ports, validates DNS result and private/link-local/loopback ranges against provider profile, revalidates every redirect, forbids scheme downgrade/userinfo and enforces system trust plus provider policy for TLS/proxy. SSRF/DNS-rebinding/redirect/proxy fixtures are mandatory. Credential is broker-resolved by opaque ID/scope/rotation epoch bound in the grant; driver never receives reusable credential or provider session store. Derived context/summaries are permitted only when `dataLineageManifest` lists every source ref/class and an allowed deterministic derivation policy; otherwise a new consent/grant is required.

Crash/error after `started` without trustworthy transport outcome produces `unknown`; partial stream is never called completed. `completed` means local transport completed, while provider delivery/acceptance is claimed only with separate provider acknowledgement ref. Driver/provider/terms swap, revoke, new data class/ref or goal-incompatible context requires new grant/permit. A new activation may reuse an unexpired grant only for exact same provider/terms/goal scope and a subset manifest; every submission gets a new permit/attempt. Retry is a distinct attempt and must follow provider idempotency/data policy. Incognito/encrypted foundation denies grant.

Retry chain is explicit and bounded by frozen policy. Revoke after start wipes queued unsent broker buffers and local response/cache/resume-token state where technically possible, blocks new bytes/attempts and emits a disclosure of `bytesMayHaveLeft=true`; it never claims recall. Any retained buffer/ref follows grant retention and protected-object policy.

Ingress starts at first provider response byte and is correlated to one exact egress attempt. Chunks have contiguous broker sequence and bounded size; gap/unknown transport yields `unknown`, never a fabricated complete response. Raw response is untrusted and stored only by protected ref. It becomes model input only after data-class/size/schema/redaction admission and becomes EvidenceNode only after capability-specific evidence projection. Revoke cannot recall bytes already sent/received; UI disclosure says so. A provider acknowledgement is delivery evidence, not proof that response content or requested effect is correct.

### 20.2. Protected object reference target model

Generic content hashes are not public object IDs for sensitive values. Target persistent protected storage uses:

```ts
interface ProtectedObjectRefV1 {
  schemaVersion: 'monarch.protected-object-ref.v1';
  objectId: string; // cryptographically random opaque ID, not plaintext hash
  storeGeneration: number;
  classification: 'private' | 'sensitive' | 'secret';
  ownerScopeDigest: DigestV1;
  authorityScopeDigest: DigestV1;
  ciphertextDigest: DigestV1;
  encryptionProfile: 'aes-256-gcm-envelope-v1';
  keyEnvelopeId: string;
  createdAt: string;
  retainUntil?: string;
  erasureState: 'live' | 'crypto-erased';
}
```

Each object gets a random 256-bit DEK and unique 96-bit nonce; AES-256-GCM authenticated associated data binds object ID, store generation, classification and owner/authority scope. DEK is wrapped by a versioned KEK rooted in the Windows protected key store; rotation rewraps DEKs without exposing plaintext. Plaintext equality digest, when needed, is HMAC-SHA-256 with a separate scoped key and remains encrypted metadata, preventing public dictionary tests against short secrets/paths. Ciphertext digest is only corruption identity.

Resolution requires server-side principal/execution/goal/purpose authorization and audit; refs are not bearer capabilities. Writer fsyncs authenticated ciphertext + key envelope before atomically publishing metadata/ref. Backup/restore must capture ciphertext, wrapped keys, metadata and journal as a consistent generation. Crypto erasure atomically destroys the wrapped DEK and marks the non-sensitive tombstone; GC never changes an unresolved effect outcome. Secret is never inline. Generic protected store cannot resolve or enumerate Monarch Safe: Safe remains a separate authority/key domain.

Persistent profiles are scoped to one Windows OS principal (SID + app profile generation); refs/keys are not shared across users. ACL/DPAPI-equivalent protection and cross-user fixtures are mandatory. The declared core trust model is narrower: hashes/digest chains detect accidental corruption and inconsistent writes while the Monarch process/store writer is trusted. They do not defend against a compromised same-user process, administrator, kernel, debugger or hostile OS. Any future effect/provider claim of tamper resistance requires an authenticated append anchor/key custody outside the writer, executable/package admission and an explicit attacker matrix; without it effects/provider remain unavailable.

This is a target contract, not a claim about current storage. Before effects/provider/persistent sensitive evidence, threat model + key lifecycle + crash/backup/rotation/ACL/erasure fixtures and security review MUST pass. Until then those cohorts are unavailable.

---

## 21. Workflow protocol

> **Extension note — unavailable in `agent-core-read.v1`.** Core directly invokes the one pinned deterministic read capability; no free-form workflow mapping/interpreter is admitted.

Workflow instance events всегда ссылаются на definition ID/version/digest.

Transition proposal содержит:

- from state;
- proposed transition ID;
- required evidence/invocation refs;
- expected instance revision.

Workflow Engine validates guard and allowed capability, пишет `workflow.transitioned`, затем side effect отдельно проходит Invocation protocol. Transition, которая требует effect result, не считается completed до receipt/evidence predicate.

Definition drift не меняет active instance. Новая version используется только новой Goal/Workflow revision.

---

## 22. Child execution protocol

> **Extension note — unavailable in `agent-core-read.v1`; reserved for `agent-children.v1`.**

### 22.1. Admission

`child.requested` содержит proposed descriptor. Application Service пересекает scopes и записывает admitted descriptor digest. Child получает отдельный command ID/execution stream.

### 22.2. Mailbox

```ts
interface ChildDeliveryV1 {
  schemaVersion: 'monarch.child-delivery.v1';
  id: string;
  parentExecutionId: string;
  childExecutionId: string;
  childCertificateId: string;
  admittedParentRevision: number;
  delegatedDescriptorDigest: string;
  delegatedParentClaimIds: string[];
  aggregationPolicyDigest: string;
  evidenceIds: string[];
  reportRef?: string;
  state: 'accepted' | 'available' | 'consumed' | 'rejected' | 'expired';
  createdAt: string;
  expiresAt: string;
  expiryPolicyDigest: DigestV1;
  retentionPinSetDigest: DigestV1;
}
```

CAS consume prevents double application. Parent restart reconstructs pending mailbox. Report text untrusted; only evidence refs/certificate feed Certifier.

Consume command несёт **current** expected parent revision и stable delivery ID. Parent aggregate в том же commit записывает inbox fingerprint/apply receipt и `DelegatedClaimBinding`. При revision conflict consumer перечитывает parent и повторяет; creation-time revision не делает delivery вечным stale. Unrelated lineage/claim IDs и child certificate без underlying admitted evidence reject.

Parent certificate creates transitive retention pins to child certificate/values/underlying receipts. A late child correction cannot rewrite an existing parent certificate: it creates a new visible parent recovery/reassessment case and, if policy allows, a new correction delivery. Parent cancel/delivery/certificate races and typed derivation remain schema-gated; `agentChildrenV1` is unavailable until their fault matrix passes.

### 22.3. Cancellation/orphan

Parent cancel policy recorded at admission:

- `cancel-with-parent` default;
- `allow-finish-no-delivery` only for read-only bounded child;
- detached external-effect child prohibited initially.

---

## 23. Job protocol

> **Extension note — unavailable in `agent-core-read.v1`; reserved for `agent-jobs.v1`.**

### 23.1. Schedule and fire

```text
job.created
job.schedule-updated
job.fire-due
job.run-admitted
job.run-skipped-busy
job.run-completed
job.notice-available
job.cancelled
```

Future `agent-jobs.v1` MUST define a closed `JobFireKeyBodyV1 { jobId, scheduleRevision, intendedFireTime, scheduleContractDigest }` and compute `fireKey = digestV1('job-fire-key', JCS(body))`. String concatenation such as `hash(jobId + scheduleRevision + intendedFireTime)` is forbidden. Run создаёт обычный Execution с exact template revision.

### 23.2. Side effects

Schedule не является approval. Каждый run заново проходит current policy/approval. Non-idempotent external effect не retry после ambiguous crash.

### 23.3. Delivery

Notice bounded, durable и отделён от run proof. `run-completed` ссылается на certificate; notification failure не повторяет run.

---

## 24. Compaction protocol

> **Extension note — unavailable in `agent-core-read.v1`; reserved for `agent-compaction.v1`.**

`compaction.started` фиксирует base sequence, target token budget и source surface digest. `compaction.completed` содержит:

- covered sequence range;
- summary ref/digest;
- retained evidence/journal refs;
- compiler/model identity class;
- resulting surface digest.

Summary event не supersede raw events в evidence replay. Incomplete bracket ignored. `compaction.started` фиксирует exact surface revision/base sequence/source digest. Любой accepted steering, Goal/plan/workflow revision или authority/context change после start делает result `superseded`; `completed` CAS проходит только при неизменившемся fence.

---

## 25. Snapshot contracts

> **Future `agent-product-facade.v1` design; unavailable in `agent-core-read.v1`.** Core has no snapshot schema, attach endpoint or `streamDigest` domain. Every field below requires a separately generated product manifest/backend before use.

### 25.1. Public Interaction snapshot

Содержит только user-visible state:

- IDs/source/privacy/status/outcome/revision;
- message refs;
- `executionLinks[]`, где каждый link содержит execution ID, relation, clause IDs,
  independent runtime/persistence lanes, immutable composition profile/manifest,
  cohort, status и creation sequence;
- truthful progress stage;
- pending input/approval card public projection;
- structured certified facts/artifacts;
- error/block codes safe for user;
- last event sequence.

Не содержит raw capability outputs, secrets, hidden prompts или internal repair trace.

```ts
interface InteractionExecutionLinkV1 {
  executionId: string;
  relation: 'initial' | 'split-clause' | 'follow-up' | 'retry' | 'recovery-correction';
  clauseIds: string[];
  runtimeLane: 'legacy-runtime-v2' | 'astra-v3';
  compositionProfile: 'legacy-runtime-v2' | 'agent-core-read.v1' | 'astra-core-experience.v1';
  compositionManifestDigest: string;
  cohortId: string;
  persistenceLane: 'agent-task-v3' | 'astra-evidence-sidecar-v1' | 'execution-store-v4';
  status: 'queued' | 'running' | 'waiting' | 'terminal' | 'blocked-indeterminate';
  createdSequence: number;
}
```

Cross-field binding is exact: `legacy-runtime-v2` permits only the matching legacy
composition; `astra-v3` requires one retained Astra composition manifest. An effect
Requirement/Invocation is invalid under `agent-core-read.v1`; it cannot be hidden by
the persistence lane or cohort name. Composition profile, manifest digest, runtime
lane, persistence lane and cohort ID are immutable for the Execution. A new profile
requires a versioned schema/manifest expansion, not a free-form string.

The array is ordered by Interaction event sequence. No field named `linkedExecutionId` may be authoritative; a compatibility adapter may expose it only when the array has exactly one link and labels it deprecated.

### 25.2. Execution diagnostic snapshot

Owner/dev-authorized view может содержать:

- GoalContract summary/revisions;
- plan/workflow state;
- invocation states;
- evidence/certificate refs;
- driver descriptor;
- budgets/recovery state;
- corruption/upgrade warnings.

Sensitive payloads остаются refs с policy-controlled read.

### 25.3. Projection consistency

Future snapshot указывает `lastAppliedSequence`, `lastAppliedRevision`, `lastCommitId`, `lastCommitDigest` и separately versioned prefix digest. Attach сначала получает snapshot, затем **complete commit groups** strictly after sequence. Gap/incomplete group → full resync or corruption repair, не guessing/partial apply. Название `streamDigest` в этом future sketch не регистрирует core domain/field.

### 25.4. Cross-aggregate terminal delivery saga

> **Future product-facade design; unavailable in `agent-core-read.v1`.** The schema lab never projects `StructuredResultV1` into an Interaction or message store. `AggregateDeliveryV1` below remains a review sketch and is not a base-manifest schema.

Execution terminal/certificate commit creates stable outbox delivery:

```ts
interface AggregateDeliveryV1 {
  schemaVersion: 'monarch.aggregate-delivery.v1';
  deliveryId: string;
  sourceStream: { id: string; sequence: number; revision: number };
  targetStreamId: string;
  commandType: 'interaction.project-execution-outcome';
  payloadFingerprint: string;
  outcome:
    | { kind: 'certified'; certificateId: string; structuredResultRef: string; structuredResultDigest: DigestV1 }
    | { kind: 'terminal-noncertified'; terminal: 'blocked' | 'failed' | 'cancelled';
        outcomeRef: string; outcomeDigest: DigestV1; reasonCode: string };
  state: 'pending' | 'applied' | 'acknowledged' | 'rejected';
  receiverInboxReceipt?: {
    targetRevision: number;
    targetSequence: number;
    appliedCommitId: string;
    receiptDigest: DigestV1;
  };
  rejectionCode?: string;
}
```

State meanings are single and normative:

- `pending`: source outbox committed; source has no durable receiver receipt yet;
- `applied`: receiver atomically committed inbox + outcome row/event + message outbox, and source has recorded the returned inbox receipt;
- `acknowledged`: source has durably closed retry/retention bookkeeping after `applied`;
- `rejected`: receiver returned a permanent typed incompatibility/corruption result; it is user/dev-visible and never treated as delivered.

Interaction receiver atomically records inbox `{deliveryId, source stream/sequence, fingerprint, appliedRevision}` together with outcome event, output row and message outbox. Redelivery after receiver commit/before source records `applied` returns the same inbox receipt and cannot create a duplicate row. Source `acknowledged` is cleanup, not correctness prerequisite. Source sequence/fingerprint mismatch for reused delivery ID is corruption. Message persistence has its own stable outbox ID; failure leaves visible recoverable delivery state, not a second terminal synthesis/effect. Blocked/failed/cancelled deliveries MUST NOT invent a certificate ID.

---

## 26. SSE/stream semantics

1. Event ID stable across reconnect.
2. `Last-Event-ID`/afterSequence supported.
3. Server может coalesce text/progress deltas, но не authority events.
4. Approval, receipt, certificate, terminal и gap events никогда не silently dropped.
5. Slow consumer получает `resync-required` с latest snapshot cursor.
6. Terminal event не гарантирует, что UI message already rendered; snapshot является recovery truth.
7. Incognito stream не становится durable от одного reconnect.

---

## 27. Error model

```ts
interface AgentProtocolErrorV1 {
  schemaVersion: 'monarch.agent-protocol-error.v1';
  code: 'invalid-command' | 'schema-invalid' | 'payload-limit-exceeded'
    | 'unauthorized' | 'not-found' | 'feature-unavailable'
    | 'revision-conflict' | 'idempotency-conflict' | 'id-collision'
    | 'manifest-invalid' | 'upgrade-required' | 'integrity-failure'
    | 'admission-history-unavailable' | 'admission-ambiguous'
    | 'goal-minimum-mismatch' | 'input-binding-undefined'
    | 'capability-unavailable' | 'path-ineligible'
    | 'budget-exceeded' | 'storage-capacity-exceeded' | 'assessment-fence-stale'
    | 'evidence-integrity-invalid' | 'presentation-invalid' | 'internal-error';
  category: 'validation' | 'conflict' | 'policy' | 'runtime' | 'capability'
    | 'storage' | 'corruption' | 'upgrade-required';
  retryability: 'never' | 'same-command' | 'new-command' | 'after-user' | 'after-runtime';
  detailCode?: never;
  diagnosticRef?: ImmutableContentRefV1;
  diagnosticDigest?: DigestV1;
  traceId: string;
}
```

The core generated schema expands exactly this table; `detailCode` is forbidden until a new Protocol version enumerates its literals and meanings. `optional-pair` means both diagnostic fields or neither; `forbidden` means both properties are absent:

| code | category | retryability | diagnostic pair |
|---|---|---|---|
| `invalid-command` | `validation` | `never` | forbidden |
| `schema-invalid` | `validation` | `new-command` | forbidden |
| `payload-limit-exceeded` | `validation` | `new-command` | forbidden |
| `unauthorized` | `policy` | `after-user` | forbidden |
| `not-found` | `validation` | `new-command` | forbidden |
| `feature-unavailable` | `capability` | `after-runtime` | forbidden |
| `revision-conflict` | `conflict` | `new-command` | forbidden |
| `idempotency-conflict` | `conflict` | `new-command` | forbidden |
| `id-collision` | `conflict` | `same-command` | forbidden |
| `manifest-invalid` | `corruption` | `after-runtime` | optional-pair |
| `upgrade-required` | `upgrade-required` | `after-runtime` | forbidden |
| `integrity-failure` | `corruption` | `after-runtime` | optional-pair |
| `admission-history-unavailable` | `storage` | `after-runtime` | optional-pair |
| `admission-ambiguous` | `validation` | `after-user` | forbidden |
| `goal-minimum-mismatch` | `corruption` | `after-runtime` | optional-pair |
| `input-binding-undefined` | `validation` | `new-command` | forbidden |
| `capability-unavailable` | `capability` | `after-runtime` | forbidden |
| `path-ineligible` | `policy` | `after-user` | forbidden |
| `budget-exceeded` | `policy` | `after-user` | forbidden |
| `storage-capacity-exceeded` | `storage` | `after-runtime` | forbidden |
| `assessment-fence-stale` | `conflict` | `new-command` | forbidden |
| `evidence-integrity-invalid` | `corruption` | `after-runtime` | optional-pair |
| `presentation-invalid` | `runtime` | `after-runtime` | optional-pair |
| `internal-error` | `runtime` | `after-runtime` | optional-pair |

Arbitrary combinations are rejected. The core public schema has no free-form or server-authored `message`, cause, path, object label or localization field: clients render local text solely from the closed `code/category/retryability` tuple, and unknown codes fail closed. `retryability` only classifies which separately admitted future action could make sense; it never performs or authorizes a retry. An allowed `diagnosticRef/diagnosticDigest` pair is non-authority, opaque `private|sensitive` and inaccessible to selectors/presentation; optional never means a caller can request it. Stack trace/raw paths/provider errors do not enter the public fields. Authorization of the object/aggregate namespace precedes existence lookup: `not-found` is legal only for a caller already authorized to address that namespace, while a foreign principal receives the same generic unauthorized response regardless of whether the guessed ID exists. Protected-identity denial and every other non-admitted path use the byte-equivalent public `path-ineligible/policy/after-user/no-diagnostic` tuple; its product UI text, if a future versioned presentation facade is admitted, MUST be one generic cause-independent local template. No public `protected-boundary` code, server text, distinguishable ref presence or path-derived substitution exists. Any public error-message contract requires a separately versioned presentation schema before product exposure.

---

## 28. Compatibility and negotiation

### 28.1. HTTP/client

- version в URL или required body/header;
- server advertises supported protocol versions/features;
- deprecated endpoint имеет successor link и sunset;
- mutation не auto-downgrade на несовместимую версию.

### 28.2. Driver

- exact negotiated protocol recorded;
- unsupported required feature prevents binding;
- optional feature false drives explicit host behavior;
- driver upgrade не resume opaque token без declared compatibility.

### 28.3. Events

- core authority payload has no additive unknown-field rule: any new field requires a new schema/payload version; only a separately declared non-authority extension bag may evolve additively;
- changed required semantics → new payload version/event type;
- unknown authority event blocks replay;
- migration emits explicit `migration.*` event, не маскирует producer.

---

## 29. Canonical `logicalBytes` trace

`workspace.storage.audit` V3 capability output and certification value are deliberately different ABIs:

```ts
interface WorkspaceStorageAuditInputV2 {
  schemaVersion: 'monarch.workspace-storage-audit-input.v2';
  requestedRoot: string;
  canonicalRoot: CanonicalWindowsPathV1;
  rootIdentityDigest: DigestV1;
  temporalClass: 'interval-observation';
  inclusionPolicyRef: ImmutableContentRefV1;
  inclusionPolicyDigest: DigestV1;
  exclusionPolicyRef: ImmutableContentRefV1;
  exclusionPolicyDigest: DigestV1;
  traversalBudgetProfileRef: ImmutableContentRefV1;
  traversalBudgetProfileDigest: DigestV1;
}

interface StorageInclusionPolicyV2 {
  schemaVersion: 'monarch.storage-inclusion-policy.v2';
  metricId: 'logical-namespace-entry-bytes.v2';
  platformProfile: 'windows-local-fixed-ntfs-nonreparse-directory.v1';
  rootProfile: 'non-volume-root-direct-device-mapping.v1';
  enumerationApi: 'get-file-information-by-handle-ex-file-id-extd-directory-info.v1';
  enumeratedName: 'file-id-extd-long-file-name-only';
  relativePathProfile: 'exact-utf16-name-to-strict-utf8-backslash.v1';
  includedEntryKinds: ['regular-file'];
  lengthSemantics: 'win32-end-of-file-logical-length';
  hardLinkSemantics: 'count-each-included-namespace-entry';
  sparseSemantics: 'logical-not-allocated';
  alternateDataStreams: 'exclude';
  bodyDigest: DigestV1;
}

interface StorageExclusionPolicyV2 {
  schemaVersion: 'monarch.storage-exclusion-policy.v2';
  protectedBoundary: 'deny-before-enumeration';
  publicDisclosure: 'generic-policy-restricted-only';
  reparsePolicy: 'exclude-no-follow';
  filesystemMetadata: 'exclude';
  unmaterializedCloudPlaceholder: 'incomplete';
  accessOrStatError: 'incomplete';
  bodyDigest: DigestV1;
}

interface StorageExclusionSummaryV2 {
  schemaVersion: 'monarch.storage-exclusion-summary.v2';
  entries: [
    { class: 'policy-restricted'; disposition: 'excluded-by-policy';
      countDisclosure: 'withheld'; entryCount?: never },
    { class: 'filesystem-metadata'; disposition: 'excluded-by-policy';
      countDisclosure: 'exact'; entryCount: '0' },
    { class: 'reparse-point'; disposition: 'excluded-by-policy';
      countDisclosure: 'exact'; entryCount: string },
    { class: 'capability-policy'; disposition: 'excluded-by-policy';
      countDisclosure: 'exact'; entryCount: '0' }
  ];
}

interface StorageTraversalBudgetProfileV2 {
  schemaVersion: 'monarch.storage-traversal-budget-profile.v2';
  id: 'agent-core-read-storage-budget.v1';
  maxFileEntries: SafeCounterV1;
  maxDirectoryEntries: SafeCounterV1;
  maxDepth: SafeCounterV1;
  maxPathUtf8Bytes: SafeCounterV1;
  maxElapsedMs: SafeCounterV1;
  maxSingleIoMs: SafeCounterV1;
  maxIoOperations: SafeCounterV1;
  maxResidentBytes: SafeCounterV1;
  maxFrontierEntries: SafeCounterV1;
  maxOpenHandles: SafeCounterV1;
  maxDirectoryBatchBytes: SafeCounterV1;
  maxTotalBrokerResponseBytes: SafeCounterV1;
  cancellationCheckEveryEntries: SafeCounterV1;
  bodyDigest: DigestV1;
}

type StorageTraversalLimitWitnessV2 =
  | { abortReason: 'file-limit'; dimension: 'file-entries';
      detectedAt: 'entry-admission'; valueAtPreviousCheck: string;
      valueAtDetection: string; limit: string }
  | { abortReason: 'directory-limit'; dimension: 'directory-entries';
      detectedAt: 'entry-admission'; valueAtPreviousCheck: string;
      valueAtDetection: string; limit: string }
  | { abortReason: 'depth-limit'; dimension: 'depth';
      detectedAt: 'entry-admission'; valueAtPreviousCheck: string;
      valueAtDetection: string; limit: string }
  | { abortReason: 'path-limit'; dimension: 'path-utf8-bytes';
      detectedAt: 'entry-admission'; valueAtPreviousCheck: string;
      valueAtDetection: string; limit: string }
  | { abortReason: 'time-limit'; dimension: 'elapsed-ms';
      detectedAt: 'entry-admission' | 'io-admission' | 'io-return' | 'terminal';
      valueAtPreviousCheck: string; valueAtDetection: string; limit: string }
  | { abortReason: 'io-budget'; dimension: 'io-operations';
      detectedAt: 'io-admission'; valueAtPreviousCheck: string;
      valueAtDetection: string; limit: string }
  | { abortReason: 'resident-memory-limit'; dimension: 'resident-bytes';
      detectedAt: 'entry-admission' | 'io-admission' | 'io-return' | 'terminal';
      valueAtPreviousCheck: string;
      valueAtDetection: string; limit: string }
  | { abortReason: 'frontier-limit'; dimension: 'frontier-entries';
      detectedAt: 'entry-admission'; valueAtPreviousCheck: string;
      valueAtDetection: string; limit: string }
  | { abortReason: 'open-handle-limit'; dimension: 'open-handles';
      detectedAt: 'io-admission'; valueAtPreviousCheck: string;
      valueAtDetection: string; limit: string }
  | { abortReason: 'directory-batch-limit'; dimension: 'directory-batch-bytes';
      detectedAt: 'io-return'; valueAtPreviousCheck: string;
      valueAtDetection: string; limit: string }
  | { abortReason: 'broker-response-limit'; dimension: 'total-broker-response-bytes';
      detectedAt: 'io-return'; valueAtPreviousCheck: string;
      valueAtDetection: string; limit: string };

type BrokerTerminalResourceStateV1 =
  | { mode: 'graceful-exit'; jobKillOnCloseArmed: true;
      kernelObservedProcessExit: true; outstandingBrokerHandleCountAfterExit: '0';
      brokerSessionReusable: false }
  | { mode: 'forced-job-termination'; jobKillOnCloseArmed: true;
      kernelObservedProcessExit: true; outstandingBrokerHandleCountAfterExit: '0';
      brokerSessionReusable: false };

type StorageTraversalAccountingProofV2 = {
  schemaVersion: 'monarch.storage-traversal-accounting-proof.v2';
  dispatchAttemptId: string;
  walkerImplementationHash: ImplementationHashV1;
  filesystemBrokerImplementationHash: ImplementationHashV1;
  startedClockAttestation: ClockAttestationV1;
  finishedClockAttestation: ClockAttestationV1;
  rootIdentityAtStartDigest: DigestV1;
  rootIdentityAtFinishDigest: DigestV1;
  volumeIdentityAtStartDigest: DigestV1;
  volumeIdentityAtFinishDigest: DigestV1;
  inclusionPolicyDigest: DigestV1;
  exclusionPolicyDigest: DigestV1;
  traversalBudgetProfileDigest: DigestV1;
  visitedFileEntryCount: string;
  visitedDirectoryEntryCount: string;
  enumeratedDirectoryCount: string;
  maxDepthObserved: SafeCounterV1;
  maxPathUtf8BytesObserved: SafeCounterV1;
  ioOperationCount: string;
  ioOperationClassCounts: {
    adoptAdmittedRootHandle: string;
    queryRoot: string;
    openDirectoryIterator: string;
    enumerateDirectoryBatch: string;
    openChildNoFollow: string;
    queryChildIdentityAndMetadata: string;
    closeHandle: string;
  };
  iteratorOpenCount: string;
  iteratorExhaustedCount: string;
  frontierPushCount: string;
  frontierPopCount: string;
  frontierEmptyAtFinish: boolean;
  maxResidentBytesObserved: SafeCounterV1;
  maxSingleIoMsObserved: SafeCounterV1;
  maxFrontierEntriesObserved: SafeCounterV1;
  maxOpenHandlesObserved: SafeCounterV1;
  maxDirectoryBatchBytesObserved: SafeCounterV1;
  totalBrokerResponseBytes: string;
  includedLengthAccumulator: string;
  nonProtectedPolicyExclusionCount: string;
  traversalSkipCount: string;
  traversalErrorCount: string;
  reparseEncounteredCount: string;
  reparseExcludedCount: string;
  cloudPlaceholderEncounteredCount: string;
  entryAdmissionChecks: string;
  ioAdmissionChecks: string;
  ioReturnChecks: string;
  rejectedEntryAdmissions: '0' | '1';
  rejectedIoAdmissions: '0' | '1';
  cancellationChecks: string;
  maxEntriesBetweenCancellationChecks: SafeCounterV1;
  budgetChecks: string;
  budgetCheckCoverage: 'before-every-entry-and-io-after-every-io-plus-terminal';
  cancellationCheckCoverage: 'before-first-at-entry-cadence-around-every-io-and-terminal';
  terminalBrokerResourceState: BrokerTerminalResourceStateV1;
  classifiedErrorSummaryRef?: ImmutableContentRefV1;
  classifiedErrorSummaryDigest?: DigestV1;
  bodyDigest: DigestV1;
} & (
  | { disposition: 'completed'; abortReason?: never; limitWitness?: never;
      terminalBudgetCheck: 'within-limits'; terminalCancellationCheck: 'not-cancelled' }
  | { disposition: 'incomplete'; abortReason: 'cancelled'; limitWitness?: never;
      terminalBudgetCheck: 'within-limits'; terminalCancellationCheck: 'cancelled' }
  | { disposition: 'incomplete'; abortReason: 'root-changed' | 'volume-changed'
      | 'io-error' | 'io-timeout' | 'cloud-placeholder-unmaterialized';
      limitWitness?: never; terminalBudgetCheck: 'within-limits';
      terminalCancellationCheck: 'not-cancelled' }
  | { disposition: 'incomplete';
      abortReason: StorageTraversalLimitWitnessV2['abortReason'];
      limitWitness: StorageTraversalLimitWitnessV2;
      terminalBudgetCheck: 'limit-refused'; terminalCancellationCheck: 'not-cancelled' }
);

interface StorageTemporalProofV2 {
  schemaVersion: 'monarch.storage-temporal-proof.v2';
  class: 'interval-observation';
  mutationDetection: 'not-supported';
  clockClass: 'kernel-local-attested';
}

interface WorkspaceStorageAuditOutputV2 {
  schemaVersion: 'monarch.workspace-storage-audit-output.v2';
  audit: {
    metricId: 'logical-namespace-entry-bytes.v2';
    scope: {
      requestedRoot: string;
      canonicalRoot: CanonicalWindowsPathV1;
      rootIdentityAtStartDigest: DigestV1;
      volumeIdentityAtStartDigest: DigestV1;
      inclusionPolicyDigest: DigestV1;
      exclusionPolicyDigest: DigestV1;
      exclusionSummary: StorageExclusionSummaryV2;
    };
    logicalBytes: string;
    measurement: {
      startedAt: string;
      finishedAt: string;
      walkerDisposition: 'completed' | 'incomplete';
      temporalProof: StorageTemporalProofV2;
      traversalBudgetProfileDigest: DigestV1;
      traversalAccountingProofRef: ImmutableContentRefV1;
      traversalAccountingProofDigest: DigestV1;
      rootIdentityAtFinishDigest: DigestV1;
      volumeIdentityAtFinishDigest: DigestV1;
      visitedFileEntryCount: string;
      visitedDirectoryEntryCount: string;
      nonProtectedPolicyExclusionCount: string;
      traversalSkipCount: string;
      traversalErrorCount: string;
      reparseEncounteredCount: string;
      reparseExcludedCount: string;
      cloudPlaceholderEncounteredCount: string;
      abortReason: 'none' | NonNullable<StorageTraversalAccountingProofV2['abortReason']>;
      errorSummaryRef?: ImmutableContentRefV1;
      errorSummaryDigest?: DigestV1;
    };
  };
}
```

A `SelectorDescriptorV1(source='capability-output', jsonPointer='/audit/logicalBytes')` yields the canonical string. Evidence Projector validates it against the one capability output schema digest and only then the Certifier wraps it into `TypedValueV1(semanticType='integer', encoding='base10-integer')`; a capability output containing the wrapper is wrong-type. The derived completion claim uses `source='evidence-node', jsonPointer='/walkVerdict'` and can equal `walk-completed-without-local-error` only after proof validation. The same canonical JSON output fixture and exact EvidenceNode fixture/schema digests must be used by capability conformance, selectors, receipt, Projector, certificate and renderer tests.

Input semantic validation requires `rootIdentityDigest == canonicalRoot.identityDigest == GoalAdmissionBinding.targetBinding.canonicalIdentityDigest`; the target body identity fields must match the retained target ref, and narrowed Goal `AuthorityScope.pathTargets` must admit that same handle-derived root under `exclude-no-follow` while remaining a proven subset of the accepted scope. Inclusion/exclusion/budget refs must resolve to the exact allowlisted bodies whose digests are repeated in `AgentCapabilityContractV1`, GoalAdmissionBinding, requirement input/constraint, Invocation, accounting proof and output. Any mismatch blocks before dispatch or fails evidence admission. `requestedRoot` is retained input/display provenance only and never participates in path equality. The core fixture keeps the admitted root handle open from target resolution through the terminal walk; it never closes and later reopens solely by file ID. A process restart that cannot retain/recover the same handle invalidates this Execution and requires a newly admitted target/Execution. Any future cross-process resume profile must add an exact object-generation/USN-or-equivalent proof and expiry; bare volume+file-ID reuse is insufficient.

For the separate-process broker, Kernel duplicates that already admitted handle into a fresh per-dispatch supervised job/process exactly once and records one `adoptAdmittedRootHandle` request; the broker does not reopen it by path and no broker process/session is reused. Graceful completion requires that adoption count to equal `1` and every broker-owned duplicated/child handle to have one matched explicit close before process exit, while the Kernel's original target handle follows the enclosing Execution lifetime. On forced termination, exact pre-kill handle ownership may be indeterminate because an in-flight request has no admitted response; instead Kernel requires kill-on-job-close to have been armed before duplication, terminates the whole job, waits for the process handle to signal, discards every unadmitted buffer and only then emits `outstandingBrokerHandleCountAfterExit='0'`. A worker-authored exit claim or a merely requested kill is insufficient.

Exactness begins at the Kernel filesystem broker boundary: every length/counter is emitted as a canonical unsigned decimal/BigInt value, accumulation never uses JavaScript `number`, and the first serialized ABI is the decimal string above. A rounded legacy number cannot be repaired by hashing or later conversion and is rejected before projection. The retained traversal budget is closed. `maxFileEntries`, `maxDirectoryEntries`, `maxPathUtf8Bytes`, `maxElapsedMs`, `maxSingleIoMs`, `maxIoOperations`, `maxResidentBytes`, `maxFrontierEntries`, `maxOpenHandles`, `maxDirectoryBatchBytes`, `maxTotalBrokerResponseBytes` and `cancellationCheckEveryEntries` are positive safe integers; `maxDepth` alone may be zero. A zero cadence/timeout, placeholder, missing dimension or ambient replacement profile fails before dispatch.

Capability output does not own a success/coverage verdict. `walkerDisposition` is a raw orchestration assertion. The Evidence Projector derives `walk-completed-without-local-error` only when the Kernel-admitted broker proof matches every duplicated counter/digest, both broker/walker implementation hashes equal the capability contract, `disposition='completed'`, proof abort/witness are absent, output `abortReason='none'`, all iterators are exhausted, every pushed frontier entry was popped, the frontier is empty, terminal checks are `within-limits/not-cancelled`, every retained dynamic-budget inequality and check-count equation below holds, skip/error/cloud-placeholder counts are zero, accumulator equals `logicalBytes`, start/finish root **and volume** identities match, and the two clock attestations prove one continuous boot/origin with monotonic finish not before start and wall timestamps byte-equal to output. An incomplete proof requires one exact non-`none` abort code repeated by output and creates only `walk-incomplete|partial` evidence. Any contradiction between receipt/output/proof is `coverage-proof-mismatch|clock-attestation-invalid`, creates no EvidenceNode and terminates through noncertified `execution.failed(evidence-integrity-invalid)`; Certifier is not asked to bless corrupted evidence. An incomplete walk is never verified. The completed verdict says only that the broker-emitted namespace-entry observations under the frozen policy were accounted for during that traversal. It is not a stable-set or whole-volume claim.

Declared policy exclusions are not traversal skips, but they MUST appear in the certified fixed-order exclusion tuple. Kernel target admission checks the separately owned Protected Identity Registry before giving the walker any root/child observation or permitting descent; this check applies to aliases as well as directory ancestry. A hard-link or other namespace alias to a protected object is denied before length/counter admission even when its visible path lies outside the protected tree. The walker never receives a protected path/name/identity and cannot count its entries/bytes. The first tuple member is always the same `policy-restricted/countDisclosure='withheld'` disclosure whether or not a protected identity would otherwise have been encountered, so it reveals neither existence nor count nor which protected zone caused denial. In this profile `filesystem-metadata` and `capability-policy` each have literal count `0`: root is outside entry counts, directory structure is traversal rather than a byte entry, and alternate streams/unsupported object classes are outside the enumerated universe and abort instead of becoming silent exclusions. Consequently `nonProtectedPolicyExclusionCount == reparseExcludedCount`; summary reparse count equals it; and `reparseEncounteredCount == reparseExcludedCount + cloudPlaceholderEncounteredCount`. It never includes protected boundaries. If the platform cannot prove object-level protected alias denial, that filesystem/profile is ineligible; release fixtures simulate an external hard-link alias using disposable protected test data and never touch production Safe. Therefore the result is never worded as full physical/allocated volume usage.

The accounting proof schema above is the bounded read-proof ABI. The Kernel-supervised, separately pinned low-privilege filesystem broker—not the walker—owns directory batches, child handle/identity/metadata observations, operation-class counters, iterator exhaustion, resource maxima and the ordered observation commitment. The walker owns only deterministic frontier orchestration over broker frames. Kernel Receipt Admission recomputes the final proof body from the broker session summary plus walker frontier counters; a worker-supplied self-attestation is never accepted. The schema lab additionally retains the complete bounded broker request/response frame transcript as a fixture-only oracle and checks its independently recomputed commitment/counters, but transcript bytes are diagnostic test evidence and never a product protocol object. Certifier does not re-enumerate the filesystem; separation of duties is broker→receipt/projector→pure certifier, each with a distinct pinned boundary. The Projector resolves the one `traversalBudgetProfileRef` retained through capability→Goal→Invocation, proves its schema-selected content identity equals every repeated digest and performs mathematical decimal comparisons.

Traversal/check semantics are exact. Root depth is `0` and the root is never included in `visitedDirectoryEntryCount`; each emitted child frame adds one to its parent depth. Entry names are the exact long UTF-16 names from `FILE_ID_EXTD_DIR_INFO`. The two API sentinel names `.` and `..`, if ever emitted, are discarded before any entry/path/frontier/count effect. An ill-formed UTF-16 name, NUL, slash/backslash in a component or an object outside the closed file/directory classification aborts `io-error`. No NFC/NFD, case fold, trimming or 8.3 expansion is applied. A relative path is the exact sequence of emitted components joined by one `\`; its strict UTF-8 byte length is computed incrementally and checked before allocating the candidate path/frontier node. Display/NT/root-alias spelling never participates.

Every entry reaching admission already has one broker-attested `file|directory` class and no-follow handle identity; a reparse entry retains that base class, while an unclassifiable broker result aborts before entry admission and contributes only its issued broker request. One broker request increments `ioOperationCount` exactly once regardless of how many directory entries a bounded batch returns; the seven operation-class counts sum exactly to it. Each response is independently bounded by `maxDirectoryBatchBytes`, cumulative response bytes by `maxTotalBrokerResponseBytes`, the coordinator/frontier by resident/frontier ceilings, and live broker handles by `maxOpenHandles`. A Kernel watchdog measures every issued request against `maxSingleIoMs`; timeout terminates the broker job, discards its unadmitted response/buffers and yields only `io-timeout`. The walker performs a budget check before every candidate entry admission, before every broker request, after every response and once at terminal; cancellation is checked before the first action, after every `cancellationCheckEveryEntries` admitted entries, immediately before/after every request and once at terminal. Every coordinator/broker allocation capable of increasing measured resident memory is admitted only inside one of those four checkpoints: candidate path/frontier allocation at `entry-admission`, request-buffer/handle allocation at `io-admission`, bounded response-buffer adoption at `io-return`, and terminal materialization at `terminal`. No hidden allocation checkpoint exists. Shared checkpoints evaluate budget first and abort on the first failed gate. Checks are not coalesced for counters.

Generated arithmetic rules use mathematical integers: `entryAdmissionChecks = visitedFileEntryCount + visitedDirectoryEntryCount + rejectedEntryAdmissions`; `ioAdmissionChecks = ioOperationCount + rejectedIoAdmissions`; `ioReturnChecks = ioOperationCount`; and `budgetChecks = entryAdmissionChecks + ioAdmissionChecks + ioReturnChecks + 1`. `enumeratedDirectoryCount` counts only non-reparse child directories actually pushed for descent and is `<= visitedDirectoryEntryCount`. The operation-class sum equals `ioOperationCount`; on completion `adoptAdmittedRootHandle=1`, `queryRoot=1`, `openDirectoryIterator == iteratorOpenCount == iteratorExhaustedCount == enumeratedDirectoryCount + 1`, `closeHandle == adoptAdmittedRootHandle + openChildNoFollow`, and `frontierPushCount == frontierPopCount == enumeratedDirectoryCount + 1`, with the added `1` representing the root; `frontierEmptyAtFinish=true`; root remains outside the visited-directory count; and terminal broker mode is `graceful-exit`. `io-timeout` requires `forced-job-termination`; another incomplete outcome may be graceful only when the same explicit-close equation holds, otherwise it also requires the forced branch. Both branches require Kernel-observed process exit, zero post-exit broker handles and non-reusability before terminal proof admission. The `closeHandle` operation count contains only issued explicit close requests; OS process-exit cleanup is not fabricated as a broker request. At most one rejected-admission flag is `1`. A limit witness at `entry-admission` sets `rejectedEntryAdmissions=1` and `rejectedIoAdmissions=0`; one at `io-admission` sets the inverse; one at `io-return` or `terminal` sets both to `0` because the operation was already counted or no new operation exists. Thus response-buffer or terminal resident-memory refusal cannot invent a rejected entry/I/O. `cancellationChecks >= 2`, `maxEntriesBetweenCancellationChecks <= cancellationCheckEveryEntries`, and both exact coverage literals are mandatory. A completed proof requires both rejection flags zero; file/directory/depth/path/elapsed/I/O/resident/frontier/handle/batch/cumulative-response maxima are each `<=` the retained limit; and the terminal markers above. Entry/frontier/I/O/resource ceilings are pre-action: the violating entry/request/allocation is not admitted or issued; an `io-return` refusal discards the bounded returned buffer before adoption. Time is checked at every named point and may first exceed only while an already-admitted broker request is in flight; it still makes completion impossible. When elapsed or per-I/O timeout is detected on return/watchdog, the issued request remains counted, but returned metadata/length is discarded before inclusion and cannot change `logicalBytes`, exclusion counts or later evidence. This rule is shared by broker, Projector and fixture oracle.

Every limit abort is a generated closed `oneOf`: witness `abortReason` equals the outer code; dimension and `detectedAt` equal the corresponding branch; `limit` equals the resolved profile value; `valueAtPreviousCheck <= limit < valueAtDetection`; and rejected flags follow the exact checkpoint mapping above. None of the resource dimensions may be reported as generic I/O error. Cancellation, root/volume change, I/O error/timeout and cloud-placeholder aborts have no limit witness and use the exact first-failure code. Generated cross-field rules require exact output abort equality, forbid proof abort/witness for completed, require the classified diagnostic ref/digest together whenever traversal skip/error/cloud-placeholder count is nonzero and forbid the pair when all are zero, bind any public `errorSummaryRef/digest` to that same non-authority diagnostic, and reject non-canonical/negative decimals. Diagnostic contents never satisfy a claim or change the verdict beyond authoritative counters/codes already in proof/output.

Default V2 reparse policy is no-follow. Entry classification precedence is closed and deny-first: (1) protected-object/alias denial before public classification or counters; (2) a recognized unmaterialized cloud-placeholder tag increments `reparseEncounteredCount` and `cloudPlaceholderEncounteredCount`, leaves `reparseExcludedCount` unchanged and immediately aborts `cloud-placeholder-unmaterialized` without hydration; (3) every other recognized reparse tag increments `reparseEncounteredCount` and `reparseExcludedCount` and is a no-follow exclusion; (4) ordinary non-reparse file/directory processing. An unknown/ambiguous tag combination aborts `io-error` before any public reparse-counter admission. Access denied, disappearance, metadata error, timeout or unclassifiable entry aborts immediately on the first such observation; the walker never continues and later reports a selectively complete total. Thus a completed proof has skip/error/cloud-placeholder counts zero and `reparseEncounteredCount == reparseExcludedCount`; an incomplete cloud proof has the additive equality above. A future follow policy needs a new contract/version with handle-based containment, cycle and mount-change rules. Exact error paths live only in a protected diagnostic ref; public evidence binds code/count summary.

Public incomplete counters are a closed projection of the first abort, not worker discretion:

| Abort class | `traversalSkipCount` | `traversalErrorCount` | `cloudPlaceholderEncounteredCount` |
|---|---:|---:|---:|
| `cloud-placeholder-unmaterialized` | `1` | `0` | `1` |
| `io-error`, `io-timeout`, `root-changed`, `volume-changed` | `0` | `1` | `0` |
| `cancelled` or any typed limit witness | `0` | `0` | `0` |

Completed requires all three `0`. Immediate abort makes every incomplete value above exact, never “at least one”. Reparse policy exclusions are disclosed exclusions and do not increment skip/error.

Live mutation has deliberately narrow meaning. Each admitted directory is opened once, iterated forward without restart until exhaustion, and every broker-emitted frame occurrence is consumed exactly once. A rename/recreate may therefore appear under whatever name/identity the pinned iterator actually emits; two emitted occurrences are two interval observations even if they later resolve to the same object, while an entry that disappears before no-follow metadata admission causes immediate incomplete abort. No de-duplication against a “current” namespace, no retry that hides the error and no stable-set claim is permitted.

No u64 maximum is implied. Walk completion is not temporal stability proof. Core temporal schema has exactly `interval-observation + mutationDetection='not-supported'`; detector/snapshot fields are impossible. Legacy `mutationsObserved=0` is discarded rather than mapped to proof. Core may certify the exact arithmetic value of entries observed during the declared window, but cannot satisfy a point-in-time/current/stable namespace claim.

Core has no legacy compatibility mapping. Current legacy storage output may be used only as fixture/shadow diagnostic input when its number is a non-negative safe integer. Missing metric/hard-link/reparse/policy/root/volume/temporal/accounting semantics cannot be invented, so it cannot produce a V3 certificate. Diagnostic code is `legacy-semantic-proof-unavailable`, not zero/coercion/rerun.

`point-in-time-snapshot` and `stable-window` are requirements for a future capability/schema version, not branches of `StorageTemporalProofV2`. They remain unavailable until exact snapshot/detector bodies, implementation trust and semantic comparator fixtures exist. Repeated equal scans are still interval observations.

Temporal intent admission is normative:

| User/admission meaning | Required class | When only interval traversal exists |
|---|---|---|
| «сейчас», «текущее», «занято на диске», point-in-time total | unavailable future snapshot/stable profile | clarify before Execution or block; never silent downgrade |
| «проверь, что не менялось за измерение» | unavailable future stable profile | clarify/block before Execution |
| «просканируй/посчитай наблюдаемую сумму за проход/интервал» | `interval-observation` | allowed with mandatory scope/window/non-snapshot disclosure |
| ambiguous temporal wording | none | clarify; compiler cannot choose the easier class |

Only the explicit interval row can create a core Execution. The first allowed artifact is a compiled schema + pure fixture trace on an isolated disposable root such as `<repo-root>\.test-tmp\agent-core-read\case-logical-bytes`. It is not a live shadow RFC. Drive roots, production/user data and Monarch Safe are out of scope.

Normative decision table:

| Goal temporal requirement | Evidence | Verdict / deterministic wording |
|---|---|---|
| explicit interval | exact value + derived `walk-completed-without-local-error` + `mutationDetection=not-supported` | `verified` observed-interval claim; disclose scope/exclusions/window and «не снимок текущего состояния; стабильность не проверялась» |
| explicit interval | partial traversal/skips/errors/budget abort/root or volume change | `partial` only when both Goal gates allow; otherwise certified `blocked`; never verified |
| current/stable/ambiguous | no eligible core Goal/Execution | clarify/block during admission; no certificate |

Exact renderer meaning is: logical namespace-entry sum over the included policy scope observed during `<startedAt>–<finishedAt>`, not current, stable or allocated disk usage; mutation stability was not checked. Goal claims MUST bind metric ID, root/volume start-finish identity, logicalBytes, raw walker disposition + derived walk verdict/accounting proof, temporal class, started/finished, mutation status, traversal budget and inclusion/exclusion policy digests, generic exclusion summary object and skip/error/reparse/budget summary. Verification recipe/projector/presentation identities are bound by assessment contracts, not worker-supplied output fields. Renderer cannot read any scalar/object outside claim bindings.

Ожидаемый минимальный trace:

```text
interaction.accepted
interaction.intent-admitted(operational candidate set digest=I)
interaction.routed(aggregateRoute=execution-only, candidateSetDigest=I, cohortDecision=single-v3)
execution.created
goal.compilation-requested
goal.contract-admitted
  requirement: workspace.storage.audit(root=<repo-root>\.test-tmp\agent-core-read\case-logical-bytes)
  claims: /audit/scope/rootIdentityAtStartDigest, /audit/scope/volumeIdentityAtStartDigest,
          /audit/scope/inclusionPolicyDigest, /audit/scope/exclusionPolicyDigest,
          /audit/scope/exclusionSummary, /audit/metricId, /audit/logicalBytes,
          /audit/measurement/walkerDisposition,
          /audit/measurement/temporalProof/class,
          /audit/measurement/temporalProof/clockClass,
          /audit/measurement/startedAt, /audit/measurement/finishedAt,
          /audit/measurement/temporalProof/mutationDetection,
          /audit/measurement/traversalBudgetProfileDigest,
          /audit/measurement/traversalAccountingProofDigest,
          /audit/measurement/rootIdentityAtFinishDigest,
          /audit/measurement/volumeIdentityAtFinishDigest,
          /audit/measurement/visitedFileEntryCount,
          /audit/measurement/visitedDirectoryEntryCount,
          /audit/measurement/nonProtectedPolicyExclusionCount,
          /audit/measurement/traversalSkipCount,
          /audit/measurement/traversalErrorCount,
          /audit/measurement/reparseEncounteredCount,
          /audit/measurement/reparseExcludedCount,
          /audit/measurement/abortReason
  evidence-node claims: /walkVerdict, /completeness,
                        /traversalAccountingProofDigest
invocation.prepared(input root=<repo-root>\.test-tmp\agent-core-read\case-logical-bytes, digest=Y)
invocation.authorized(read)
invocation.dispatched
invocation.receipt-linked
invocation.observed
invocation.output-checked
invocation.settled
evidence.projected
completion.requested
completion.certified
  /audit/logicalBytes -> TypedValue(integer, base10-integer, exact decimal string)
  temporalProof.class -> interval-observation (never worded as point-in-time/allocated total)
  scope/exclusions/window/non-snapshot -> certified mandatory disclosures
execution.completed                  (same atomic Execution commit as certificate)
presentation.completed               (local deterministic StructuredResult fixture; no product write)
```

Недопустимые traces:

- `models.agent.synthesize` вместо storage receipt;
- `completion.certified` без selector binding;
- второй identical audit после уже достаточного evidence только из-за renderer failure;
- `verified` outcome до certificate;
- root mismatch, partial result hidden, missing `logicalBytes` coerced to zero.
- unsafe JSON number (`2^53+1` rounded), non-canonical decimal or changed metric definition.
- concurrent mutation presented as complete/current without snapshot or stability proof.

---

## 30. Protocol conformance requirements

### 30.1. Generated package and canonicalization

- manifest contains exactly the §0.1 allowlist and no transitive unlisted `$ref`;
- public/accepted command, fingerprint, event and commit-body schemas are closed branch-parity `oneOf` projections; generic TypeScript helpers never become permissive wire schemas, the authoritative receipt has only the atomically retained `accepted` branch, and every pre-admission/conflict failure is a direct closed ProtocolError without command/receipt IDs; schema-lab retention is not a physical durability claim;
- global digest/binding/state-transition/commit-invariant tables have no dangling full-schema/variant endpoint or rule ID, derive every digest header schema version from the exact source-schema manifest entry, contain exact 40/40 event-payload rules plus the exact 40-result commit-group rule, and express cross-schema results such as command fingerprint, certification key, GoalAdmissionBinding, terminal suffixes and certificate projections;
- every allowlisted runtime schema has exactly one owner `ProtocolSchemaRefV1.contentIdentityRuleId`, the manifest has exactly one pure `ProtocolContentIdentityRuleV1` for that schema and no unused identity rule; the non-default table plus default list is an exact disjoint cover of all 66 schemas, while repeated digest occurrences are checked only by separately listed `ProtocolDigestRuleV1` rows;
- `json-schema` refs bind described ID/version/root `$id`/root schemaVersion const, schema-body digest and pinned bundled meta-schema implementation without pretending schema documents are runtime instances; `opaque-bytes` use exact raw-byte identity and cannot enter authority/selectors;
- every diagnostic ref resolves only to `opaque-bytes/purpose='diagnostic'/private|sensitive`; core submit/follow-up/fingerprint schemas require attachments `[]`, and any non-empty public attachment request fails before accepted-command/receipt/Interaction creation;
- every authority union compiles to JSON Schema 2020-12 `oneOf` with `additionalProperties=false`;
- generated TypeScript is produced from those schemas, not maintained in parallel;
- the exact parser/JCS/schema-validator/digest/identity-binding/state-commit implementation bundle hashes are pinned and recomputed; compound review labels compile to finite callback-free primitive programs; strict parser's finite pre-profile bootstrap ceilings are inside its hashed bytes, Runtime limits can only stay within them, and it rejects a leading transport BOM while preserving valid in-string `U+FEFF`, rejects duplicate keys before object construction, trailing data, invalid Unicode and either-layer limit overflow; vectors separately prove complete-payload bytes, root depth, nested total member/item occurrences, per-string UTF-8 bytes, duplicate ref occurrences, commit-event count, exact schema-document closure and runtime ref depth/object/edge/byte ceilings, while manifest and capability bind the same retained profile instance/digest;
- opaque-ID generation vectors enforce every exact kind/prefix/owner, canonical 128-bit Crockford encoding (`[0-7]` high digit) and reject 130-bit aliases; generated `idFieldRules` is an exact exhaustive schema/variant/path application map whose random/reference/reference-union/semantic/authenticated-external classification covers every expanded ID endpoint exactly once, including request/admission/candidate/stream/causation and semantic rule IDs;
- raw-token numeric vectors reject `1e-400`, `9007199254740990.9`, `9007199254740992`, `-0`, leading zero, exponent spellings and every number at a generic/unmapped JsonValue pointer before any host-number conversion; exact decimal strings never pass through IEEE-754;
- JCS/digest/ref vectors match in at least two independent implementations;
- all counters and decimal values reject round/wrap/non-canonical encodings.

### 30.2. Admission and deterministic Goal

- accepted command ref/digest, its one message bytes/context, RuntimeFeatureSet and cohort are transitively bound without a second raw-message owner; the accepted RuntimeFeatureSet pins the sole capability contract plus matcher/policy/recipe/presentation/Certifier/terminal-policy suite before receipt publication, and a simulator cut/package upgrade cannot substitute any current feature, contract or verdict policy;
- pure matcher result has no allocated IDs/time/handle identity; retained result→Admission projection permits only exact ordinal sealing, pinned target resolution and mechanical eligibility downgrade, and simulator replay never reparses a committed Admission; negative fixtures reject a negated prohibition, ambiguous target with an otherwise resolvable range, non-empty positive ambiguity, mismatched/non-singleton unknown code and a prohibition hidden in an unselected informational row before Execution creation;
- the isolated matcher-policy simulator evaluates eleven exact Russian command cases with deterministic replay plus NFC and whitespace metamorphic checks: `2 execution / 6 clarify / 2 blocked / 1 not-applicable`. It rejects the legacy A11 wording because «занято ... сейчас» is point-in-time intent and because it omitted a literal absolute Windows path. The corrected A11 names the disposable root and explicitly asks for one interval observation, not a current snapshot. This proves only the candidate policy table: the retained descriptor still cannot encode an informational/not-applicable accepting outcome, the action algebra cannot emit an informational candidate, and the candidate-code algebra cannot express prohibition blocking; `matcherFunctionalSemanticsValidated=false` and `capabilityOperationalSemanticsValidated=false` remain mandatory;
- an additive, isolated `monarch.astra-goal-matcher-abi-candidate.v2` closes those four representation gaps without mutating V1. Its finite no-semantic-regex contract adds distinct `informational-answer` and zero-candidate `not-applicable` outcomes, explicit informational/not-applicable/block actions and an `operational-blocked` candidate. Matcher-owned blocking is exactly `operation-prohibited|matcher-input-limit-exceeded`; application eligibility alone may downgrade a positive capability draft with `capability-unavailable|target-ineligible`. Fourteen priority-ordered operational rows combine with one orthogonal informational dimension into eight exhaustive projections, including answer+blocked/clarify/execution `mixed-rows`; every row carries both the policy route and the exact Admission aggregate vocabulary (`answer-only|execution-only|...`). Facts are clause-scoped: informational-only segments cannot inject interval facts into a separate operational clause, while a non-informational policy-modifier segment may bind to it; path-internal dots are not clause boundaries. Ambiguous double negation clarifies instead of executing, Cyrillic drive-letter confusables fail the ASCII target grammar, and quoted/trailing-punctuation targets plus separate modifier clauses retain exact routing. Node and independent Python agree on `20/20` policy cases (`1 answer / 2 blocked / 8 clarify / 5 execution / 3 mixed-rows / 1 not-applicable`), four exact application-downgrade projections, replay/NFC/whitespace metamorphisms and `22` digest-recomputed ABI/readiness mutations. Candidate body is `12965` canonical bytes / `sha256:2d95bae3a15ed062fb0d4b2f5bc13d640ac947a4a925392ac75e7c31215b8d1f`; evidence is `sha256:45df76b857adacdae400eb0e61e091c571f3c17f731576e786442bc447f10904`. This is representation closure only: CapabilityContract V2, Descriptor V2, Result V2 and Admission V2 must be materialized/promoted atomically; V1 reinterpretation is forbidden, no matcher implementation exists and all operational/readiness flags remain false;
- exact dependency closure proves that even that three-schema wording is insufficient. `AgentCapabilityContractV1` embeds the V1 descriptor identity/action/outcome algebra, while RuntimeFeatureSet's retained binding asserts the V1 capability schema. The minimum schema candidate set is therefore CapabilityContract V2 + Descriptor V2 + Result V2 + Admission V2. A content-regeneration attempt exposed two additional immutable identities: changing the owners of `semantic-id.claim-template-member.v1` and `semantic-id.requirement-member.v1` under their existing `.v1` IDs would redefine retained semantics, so new V2 profile IDs are mandatory. Across the current definition the seven replaced identities occur exactly `167` times (`136+11+20`); the two profiles account for `31` total occurrences—two definitions and `29` downstream references. Activation still invalidates the same `16` generated artifacts and requires the same `15` surfaces. The `56` current Capability V1 rules are invalidated, but V2 independently derives `55` endpoints because Descriptor V2 removes `matcher.ruleTable[].ruleId`; that obsolete V1 rule must retire. Node and independent Python reproduce the closure and reject `17` digest-recomputed weakening/readiness mutations. Closure body is `7207` canonical bytes / `sha256:da3a1f429ed0041f7929c396fc085b0e9a7e176fbcd0b617b2ca30ef068c7b8e`; evidence is `sha256:de1c0b5cc286544c328d8c3aa62df9066d943c352c9277da1357504dac4394b1`. A new RuntimeFeatureSet generation and one Store epoch advance are mandatory; committed V1 Admissions replay as V1 and retained V1 semantic-profile IDs are never redefined. This immutable closure snapshot predates schema materialization;
- the following isolated pass materializes all four required candidate ASTs without adding them to retained `schemaAsts`, schema closure, ID rules, binding programs or Store. CapabilityContract V2 preserves the complete V1 frame but replaces the embedded matcher-algebra copy with the sole Descriptor V2 schema ref; Descriptor V2 freezes all seven ABI sections as exact finite values; Result V2 and Admission V2 each contain the same four ordered branches, allow zero candidates only for the semantic `not-applicable` projection, and retain explicit blocked/mixed outcomes. Rebinding the widened closure changes provenance identities but not the four schema pins. The source is `3413` canonical bytes / `sha256:6ce9bb978e44921c897f038d47667cd44237812beacdaa9a46cc72c92c8df757`; the four-AST artifact is `43773` canonical bytes / `sha256:2e709aa8ccdb93ce669109c6cbfe99f97b1c33e95aec8ceb4aba2a5ede531650`; evidence is `sha256:42a7a2b33bacf22b7b604dc089d3565d4b39d1db28810387469c4a5b6fe450a6`. Schema pins are Capability `68c75603...f4240`, Descriptor `a6bea4c0...8e20`, Result `43a3813d...a275`, Admission `fe328a91...6ffa`. Node rejects `17` semantic mutations and an independent Python full-artifact implementation rejects `19`, including V1 identity reintroduction, frame/policy drift, missing blocked/zero branches and matcher/version substitution. This closes candidate schema shape only: 15 authority surfaces, new RuntimeFeatureSet/Store cohort and matcher implementation remain false;
- an executable isolated Result V2→Admission V2 projection candidate now applies 17 finite operations across all eight base outcome rows and four application-eligibility downgrades. It allocates synthetic ordinal IDs/time only in the projection harness, invokes target resolution exactly twice and only for positive capability drafts, forbids resolver output after eligibility failure, preserves the informational row during a mixed downgrade and keeps not-applicable at zero candidates. Node rejects `24` output/program mutations; an independent Python reconstruction rejects `18` source mutations. Widened-closure provenance yields source `7136` canonical bytes / `sha256:2ba41637e41fbedd99d82eb057cb32ef5f66958138999e58dd4a3b3dbb8185ef`; evidence is `sha256:1fa65b01175fc34fb2b80fce31b5e1dc93170023881f7ecafede97863106ffbd`. The program is executable evidence only: it is not retained authority, regenerates none of the 15 surfaces, creates no Store authority and does not prove a matcher implementation;
- the next isolated package closes the regeneration contract for all 15 authority surfaces as one topologically ordered DAG. It binds four schema pins, 12 projection cases, seven identity substitutions—including two new semantic-profile IDs—and the exact 16 currently invalidated Phase 0A artifacts, then materializes a content-addressed envelope for every surface. Source is `14411` canonical bytes / `sha256:6390e1c850e16aa2f31c359e63ed117dd153f3cc706b7b4d124113cf7dc7a660`; the 15 envelopes total `26161` canonical bytes; package artifact is `29209` / `sha256:78810b9e8807a7ccac0ddb6e62c51df1e894adc9a83ba54ab844d2970779ff90`; evidence is `sha256:0979ada42752629b73578f289cb3d927458bcc3f6be0f174ec05e219ccaa740d`. Node rejects `25` and independent Python `24` dependency/coverage/identity/readiness attacks. The early RuntimeFeatureSet surface emits only the binding program: a generation cannot exist until manifest, capability-instance and Store-issued refs are available, so only the final layer emits a non-retained generation plan and any early-generation mutation fails closed. This closes only the regeneration contract/envelopes: authority artifact contents, RuntimeFeatureSet generation, combined retained ABI, Store cohort and matcher implementation remain ungenerated;
- the first direct content tranche then materializes the actual `schema-and-direct-bindings` contents without retaining them: four ASTs, two V2 semantic profiles, three direct profile-reference rewrites, `55` exact Capability V2 endpoint rules, one strengthened RuntimeFeatureSet binding program and all 12 projection cases. It accounts for all 31 profile occurrences and explicitly defers the remaining 26 layered/Event owner-import references. Source is `3368` canonical bytes / `sha256:91be34fc94017c8b7643c4ff03210f52d8fa2a7383d3cb6f8bb4058b1b42111b`; artifact is `85938` / `sha256:74dc21899030280fd21f22d8d34810bab3f07239a9ce4c8f2ba68612e7891cca`; Node evidence is `sha256:5f1e5e1ead02e5f9a1bf84d360178e746e82d4d997aaa1fdf789636c3bad4887`; independent evidence is `sha256:891117e4d8f954cf69b78815f627f107ae17e1795ad9d9a43fb18a53e1270747`. Both implementations reject `24` attacks. Owner/import content, regenerated authority, RuntimeFeatureSet generation, Store cohort, matcher implementation and promotion remain false;
- the first topological output-body package then assigns the four direct surfaces their exact named, content-addressed bodies bound to the corresponding authority-envelope digests: one binding program, two semantic profiles, 55 Capability rules and 12 projection cases. The four canonical bodies total `32855` bytes. Source is `2258` / `sha256:98f17eb070f8b4dc81bff8d82c0746f4860efa05df312891fc176e480fd1a1ea`; artifact is `34725` / `sha256:c398cea998f951443e88d4aae444d42f5f0d7dd5e080122fbf69d5d105ebbe37`; Node evidence is `sha256:14c292aeacf9b96e7d80aeb383d2709dbf02a5810a7df95fb969c1ab42936fa5`; independent evidence is `sha256:74be93aee9978859c1b9e79dd9d66d155cc6fb32ee797c29a740b71cfc86ade4`. Both implementations reject `20` attacks. These are complete surface-owned bodies, not composed legacy artifacts or a sealed candidate definition; partial authority promotion, owner-import content and RuntimeFeatureSet generation/plan remain forbidden;
- the second content tranche materializes the remaining semantic-profile owner/import changes as an exact overlay over the pinned V1 definition, never as a silent rewrite of existing catalog or grammar identity. Its 26 fail-closed JSON-pointer operations cover 25 layered-owner and one Event-payload reference. Composition with the five direct-tranche occurrences closes 31/31 candidate profile occurrences with zero unresolved. Source is `1665` canonical bytes / `sha256:1e5601432f91c9bcd555440584c375dfb2b0bf8a99eac07544e8335e5c5bad39`; artifact is `22856` / `sha256:07a598bd4ea76c039473b8d8b401fd01a68d92d2929cd33f0844882fc0391fdf`; Node evidence is `sha256:952487cc4fbb0d77786c55ece6df8bd5a3710bc20fb11b8fac0b734405811ca9`; independent evidence is `sha256:ebd0aae650d166499e794d1de93bd5a5db7b023cc01440c6b7ae876df8c7899d`. Both implementations reject 20 attacks. This closes combined non-retained candidate profile references only; regenerated authority artifacts, RuntimeFeatureSet generation, Store and runtime remain false;
- the owner-import output-body package materializes the next four DAG surfaces as five exact named outputs, each bound to upstream surface-body digests. The candidate Admission batch replaces 47 Admission and two matcher identities and uses the exact Admission V2 AST; follow-up and goal replace another `6+2` Admission owners; Event grammar and all three projection documents replace `5+5` Admission and `1+3` requirement-profile occurrences. With the 25 layered profile patches, the closed inventory is 63 Admission, two matcher and 29 profile occurrences with zero unresolved. Source is `2943` / `sha256:52acce8c2c259d1c702427fbdef3e8c75f31cd27a3f2a4e5be98c50cdf157715`; artifact is `1324765` / `sha256:8d871dd2dc4cd75b732c566051d5b1f92d45f941deb5e75786175a4e23e44c86`; four bodies total `1322793`; Node evidence is `sha256:acd4dd2e17642ea98585620e1eb73d00e168e6b2b5c243046abfa40e2afc8a54`; independent evidence is `sha256:e46ad97636047f63e6ee53dd28b1ae2ac0001cb84cb049d80b1641408592e7e9`. Node rejects 23 and independent Python 21 attacks. Whole legacy artifacts, candidate-definition seal, owner closure/rule lowering, retained authority, Store and runtime generation remain false;
- the owner-closure output-body package then materializes the next two DAG surfaces as four named source-level outputs. The first body binds the exact three predecessor body digests, replaces the final five structural Admission V1 occurrences, re-hashes the transformed preflight against a 16-node/16-edge acyclic graph and preserves reject-with-zero-authority-change. The second replaces the two remaining owner/authority occurrences, rederives four V2 content-identity rows and binds the indivisible four-schema cohort to exact canonical URIs and schema-body digests. Source is `2518` / `sha256:36dbc5e8f3a6a4433be5f68e3fce893f0ad878d38efbc559946d73e566268dc5`; artifact is `22605` / `sha256:ae62a4c2217e8aca1ffd09844439d044ea272b7b5cb9cb40adf3cd23394c726d`; two bodies total `20730`; Node evidence is `sha256:5d8fd849564d81c1cdedc2ffefb6508a2a3a45fcaac115811bbc2c6ff62ec0a2`; independent evidence is `sha256:7523f7a033df347c7711ec3f2b689527a75cae90c01efda71f3ed4fba06361cb`. Node rejects 28 and independent Python 23 attacks. This closes owner-closure surface content only: the 517-KB compiled preflight and other legacy artifacts are deliberately not string-rewritten; candidate-definition seal, rule-ID lowering, registry/provenance, RuntimeFeatureSet generation, Store and retained authority remain false;
- the Event-owner rule-ID body consumes that closure and independently recomputes all `1094` generated IDs from their allocation endpoints under the pinned domain contract. Exactly `135` Admission endpoints change schema identity; all `143` downstream reference bindings are recomputed and verified, while only `15` reference values actually change. The `34+67=101` semantic classifications bind the V2 profiles. All `1089` candidate rules, five external imports and `1089` provenance rows remain closed; generated IDs are unique, disjoint from all `117` retained IDs and have zero unresolved owners. Source is `2200` / `sha256:349f80ec4723c5d0ca9974af076393e0fbf0b2e9d08d907c2f11f8e9961dc24c`; artifact is `722660` / `sha256:89781085a98df26a85ff62397c1b5aacec2e9fec1c80a504329641693e364d0c`; surface body is `720855` / `sha256:284ebcba4f65da0953f65afa57cf3d01ef394d3b20aef9be5340421178ab3361`; Node evidence is `sha256:dc167cbbf6cee7821b27360e06fdb9c5edf0da32cdb9bd8382327e59e9d24cb4`; independent evidence is `sha256:9268f98d8eb10156ad067909fb1deef7e6962099c34217b93bb63571b44330c0`. Node rejects 24 and independent Python 19 attacks. The distinction between recomputed bindings and changed values is now part of the exact inventory, preventing inflated change claims;
- the joint Owner/Event rule-ID body then consumes that exact Event-owner body, recomputes all `3617` generated IDs (`3612` candidate rules plus five logical imports) and resolves all `6656` reference bindings. Only `20` reference values actually change, including exactly five direct AgentEvent-to-Admission-V2 links; `135` Admission endpoint identities and `34+70=104` semantic classifications are remapped. The `1089` Owner and `2523` Event candidate partitions remain complete; all generated IDs are unique, disjoint from `117` retained IDs and resolve with zero missing owners. Source is `2292` / `sha256:7f5f44f9ba838e1e8e93a7d4a7926c507d6df5f1dbea649eabbcc8573038ff80`; artifact is `2063281` / `sha256:e8c63d95dc95c883833e3a6201b23065f1ce72ff77c489a44bcccfb1fa2b04b3`; surface body is `2061465` / `sha256:0ba2fd18ddab9fa600e93ec5d2dbbb515e0ce47e1b1c1f5bb473b2fc2e042138`; Node evidence is `sha256:ac2eaeb3c9aa36552681828cf45a98e8e72fb692e3d1a1da21fd545775d9116b`; independent evidence is `sha256:64d670e43ad8b7c175facb712cef56856f960120b663ac9e1333c66b2386d438`. Node rejects 24 and independent Python 21 attacks. Full legacy-artifact regeneration, candidate-definition seal, completion bindings, registry/provenance, RuntimeFeatureSet generation, Store and retained authority remain false;
- the Completion binding body consumes both that exact joint rule namespace and the already materialized RuntimeFeatureSet-to-capability-V2 binding body. It rederives all nine Completion programs / 151 instructions, changes the one request-freeze capability target from `monarch.agent-capability-contract.v1` to V2 and gives that changed program a V2 identity. Across 292 instruction endpoint occurrences / 157 unique routes, exactly 47 occurrences map to 23 unique joint owner rules: 39 reference and eight opaque-random bindings. Every mapped rule ID is rederived from its allocation endpoint; unresolved matches and mixed V1/V2 capability-cohort occurrences are zero. The request-freeze program still binds one RuntimeFeatureSet V1 ref, whose pinned internal binding requires the same capability V2 schema/digest; no RuntimeFeatureSet generation is claimed. Source is `3122` / `sha256:e499cf200d222146a851310bef31fa624d1769560010d8a587d42e026e13572b`; artifact is `96626` / `sha256:94d247f9f4fa1291e66e25367ac36ce8c2578d68f63eecb39d1adfb0c6a3f948`; surface body is `94761` / `sha256:f70beaf18973499fa6bfa9c6aa9650d629b44d177544293bcda0255e9b0e83b7`; Node evidence is `sha256:a6e95298a7d19c16b8c0078505d3908c6bb50f7fd3b3b717c6d690441a0f4d4c`; independent evidence is `sha256:bed4ee5829750ad81fa270cc7067e4bd7c42f0af372415bd0a593d34aa7de839`. Node rejects 28 and independent Python 25 attacks. Definition seal, registry/provenance, combined ABI, RuntimeFeatureSet generation, Store and retained authority remain false;
- the registry/provenance body consumes the exact Completion body and reseals only the three authority-selected registry sections, rather than falsely claiming a whole-registry rewrite. Four V1 matcher-cohort closure rows become V2; the one materialized Capability V1 row is replaced and three missing matcher-cohort rows are added, so schema closure remains `66`, while structural documents and schema-body rows become `25` (`21` retained generated JSON schemas plus four canonical V2 schema AST candidates). Those four AST digests are not mislabelled as generated JSON Schema artifacts: generated matcher-V2 JSON schemas remain `0`, missing documents remain `41`, conformance and candidate-definition seal remain false. Provenance preserves all `45` retained replay outputs and binds the exact body digest, byte count, authority envelope and output names of all `13` predecessor surfaces. Selected registry rows contain zero replaced V1 identities. Source is `6775` / `sha256:1e538661b1d70c05e876a9d1da041461346bdbe7282180494ca071b468f5b4c7`; artifact is `55662` / `sha256:c5629187b9ffe586905121f9712d7364a7c8f5a67a23c1ddb61bf18abdebd71c`; surface body is `53943` / `sha256:2051556fd01dc9633aba7c66aa0fd354ea30be825481b421a8fd88ea2479eac5`; Node evidence is `sha256:7c0f2eebf66e6b8b2e100ab9d6aadbfec4b04599bc99aa03549c35abb769a089`; independent evidence is `sha256:9fad3b2801a617d107c6c084138f9d106a28727158bd422434ab9b41b2ca7309`. Node rejects 28 and independent Python 25 attacks. Whole-registry/provenance rewrite, definition seal, combined ABI, RuntimeFeatureSet generation, Store and retained authority remain false;
- the final combined-ABI/Store-plan body detects that the base ordinal-14 authority envelope incorrectly selects retained `binding-programs.candidate.json#/bindingPrograms` (25 programs), while the pinned combined ABI actually proves Event 114 plus Completion 9. The isolated correction selects `event-cross-object-binding-programs.candidate.json#/eventCrossObjectBindingPrograms`, changing the envelope identity from `sha256:13ab547f60f000642a3f022579918a2bbf0fe5e8ba138079c86d70eb6d86cbf4` / 2174 bytes to `sha256:5ca43967f68b8799b4f181cb17135863ee63a202e0873eca64a58012a69a5c1b` / 2210 bytes without falsely claiming that the whole authority package was regenerated. The candidate ABI independently reconstructs two sets, 123 programs, 1527 instructions, 26 operations, eight scope kinds, 13 endpoint roles and 2519 endpoint references, with ABI digest `sha256:60f11f1b8632bfe70c477b378c03e0c167c4bda0ce905008d4d0698f5f624e59`. RuntimeFeatureSet generation and Store cohort remain plan-only: four generated V2 JSON Schemas, four Store-issued refs, a sealed definition and one atomic CAS epoch are prerequisites, while executed generation/CAS/epoch/retained activation are all zero. Source is `4836` / `sha256:93d273036fadf7a4098e494db93e1ce6894e7c823e7c7668ec38d16cd2dbe9f1`; artifact is `26874` / `sha256:c187a34801c16a776ddeb65c258fd678be493711e5b3cd7b2a415cd27249b025`; surface body is `24997` / `sha256:8ea41c617005968347cd5b92915ba60b5fd456cc3e42b319295b130bf8c00787`; Node evidence is `sha256:22a916ee541f27cb5944095581dbd2ab2c2575e21c53084d4b2898416484d3fa`; independent evidence is `sha256:62524bcdeed02b603f92045bb7120fb091383d02411ca7e30189cd04383290a5`. Node rejects 30 and independent Python 25 attacks. Isolated content bodies now cover 15/15 authority-named surfaces, but whole-package regeneration, generated schemas, definition seal, output artifact creation, Store/runtime execution, retained authority and matcher implementation remain false;
- the corrected whole-package pass preserves the original faulty package as audit evidence and derives a new effective source graph instead of patching a digest. The first 14 surface definitions remain byte-identical; ordinal 14 carries the corrected Event source. The effective graph is `14446` / `sha256:1ba2f7bb3bcd90f19331435f0e2a2c16debca50acd2598cecae309b73f0024a7`. All 15 envelopes are recomputed: 14 match the base package exactly and one matches the independently proven corrected final envelope. The resulting full package candidate is `29248` / `sha256:b7a93867fb803d0e23ae668d500e091e48e9c922875189a59a090f3599e0b1d9` and binds exact content-body proofs for all 15 surfaces. Wrapper source is `5066` / `sha256:736c0e44d4021b1efcedccc357cfc068844601ad0025cf85ba8004a69ffe7e68`; artifact is `34150` / `sha256:94f1adb7ce3f597ba03f95acb9057c92f88af8b95917dd83ad3c342960857aed`; Node evidence is `sha256:5ade9a98283360ce18584c1479b26f6ba4e062cb34fa6900c972cd30703f6a7c`; independent evidence is `sha256:f3260fac5d8412ca310a473a9744e4be4573e3a76d6a9ba98f82c07cdcd41379`. Node rejects 25 and independent Python 22 attacks. `correctedAuthorityPackageRegenerated` and `allContentSurfaceProofsBound` are now true, but the 16 underlying output artifacts, four generated V2 JSON Schemas, definition seal, Store/runtime execution, retained authority and matcher implementation remain false;
- the schema-generation pass turns all four canonical V2 ASTs into actual Draft 2020-12 documents inside an isolated, non-persisted artifact. Ten selected-variant references resolve against the materialized base-plus-candidate AST graph; source-only `idEndpoint` keys emitted are zero. Strict AJV compiles 4/4 and independent Python separately expands object templates/selected variants and reproduces all bytes and digests. The schema-body rows are Capability `17845` / `sha256:34e92a3ee1edb58d7c62208b1d0a9229f3d11610c13a9b5b9143eceda195a888`, Descriptor `11019` / `sha256:c7182b5932449ff152e2e5235554a5fcc86594f60e1eee0a26380b1912ea8fe0`, Result `5571` / `sha256:32135e03f305e9ba2d35ac2f2dcab48742b0c13320d835fa78a0accdf183cc85`, and Admission `13296` / `sha256:016fd16c34c27037f0589d8e105b82725686b4a6db26e98e8ffc5e2dad0cbb46`, totaling `47731` canonical bytes. Source is `3615` / `sha256:d3c53b0a21065e58969b8a39f5fdb76cabc5cec4912189a41ebadd2460924742`; artifact is `53525` / `sha256:26c208fc539664f0ad0d760804be242fdd0b779f658ee66d43c94000abb4ef3e`; Node evidence is `sha256:eef5d3b68a3857c8232a9be76a1ce27773d8e736eb51be02c5df45cefa2a1095`; independent evidence is `sha256:8b5ae032da7746dce540e1e3dae4228de97eff655359d726ed3f03a87ff0de8a`. Node rejects 28 and independent Python 25 attacks. Generated documents and their digests are now real artifact content, but persisted files, registry recomposition, candidate-definition seal, Store refs/runtime generation, retained authority and implementation remain false; composition still leaves 41 of 66 schema documents missing;
- the first registry composition replaces exactly the four matcher AST placeholders with those generated-document identities while preserving the 21 retained generated rows byte-for-byte. Registry rows, schema-body set and composition provenance are resealed as an isolated candidate: source `4180` / `sha256:25260bd93d3939d60ac4d8aad769afdb2477c28abb564911fa7bcd64b376b25f`; artifact `59582` / `sha256:af54ab476f95b89d0f2e42dba8ffed7d6e749ab2035083b223fc9b7ffd3a7e2d`; Node evidence `sha256:526980095febd669ac92cddea39ca68c06349d8fd8a187182d1aa1d0e6b55cc9`; independent evidence `sha256:cb3ad7803da7fbb795ba8eaf0d0cc2cdd072fa47190352357ff40339a759d860`. This composition still reports `25/66` materialized and `41` missing because it has not yet adopted the already compiled Event/Completion cohort;
- the missing-set audit proves that the `41` count was a composition deficit, not 41 absent schema bodies. Four pinned Phase 0A artifacts contain 19 exact Draft 2020-12 candidate documents with matching canonical bytes, raw SHA-256, domain-separated schema-body digests and authority-plan rows. One is superseded Admission V1; the other `18` are members of the current 66-row closure and were merely uncomposed. Node and independent Python partition all 41 rows as `18 generated-candidate-document-available-not-composed + 23 actually unmaterialized`, reject `22+20` attacks and bind artifact `44823` / `sha256:6190f7cd07b44b1e102e7b2af9011ea09640843f0955cb4577f87e1fb3cd36be` with evidence `sha256:107c4916d3d03f212fdce9634bed14c3b67ad0af3c36c50c7e317b25385ddbc1` and independent evidence `sha256:7f1a7a28af7da90b9e6607f3837638bab4aea58c3c2db43769fda373f98785fe`;
- the subsequent append-only candidate tranche composes those exact 18 rows into registry documents, schema-body rows and candidate content identities while preserving every prior row and the 66-row closure exactly. The isolated result is `43/66` materialized, `23` explicitly unmaterialized and `22` candidate content-identity rows; source is `2354` / `sha256:b886fca4a8cb228e45d8be0c686fb80a1aa47c17535568827d451d45d3797713`, artifact `118940` / `sha256:7bd6f9f2d969dcf624a3c597fdc4697c2a8748742c01b62bfac4d1ed260f02d3`, Node evidence `sha256:e5a4bada2c50414495273289953e51fc4dbd77ef1a6e404cd879a16fc512c182`, independent evidence `sha256:3920c5f6573a622b78c6bd1d578d1d2069c1053d58b84dd94689126f569b8e8e`; `24+22` mutations fail closed. The container artifacts remain candidate-only, no standalone document was persisted, no Store ref/epoch/definition seal exists and retained/product authority remains unchanged;
- the embedded-schema attack finds two more exact roots inside that already proven cohort instead of inventing new shapes from prose. `InvocationDispatchKeyBodyV1` is byte-identical inside both atomic and layered `InvocationV1`; `InvocationTransitionV1` is reconstructed from 12 unique `to` branches that agree across AgentEvent, CommitEvent and CommitGroup. Source-only keywords are stripped, the sole transition `$ref` closes through retained ImmutableContentRef, and strict AJV compiles both roots. Dispatch is `774` bytes / raw `sha256:87b342c5c66838d79111559d74ea137097ccff02ffbafbb969713f4457b4c2f6` / schema-body `sha256:8512bfff16ab92baf1f4ff4a6c05da002bf0250758eb996a8e0ba8bc8985b821`; Transition is `11639` / raw `sha256:a382c021e171e2e8b1d9a1c4e80fdc225a6b70a947f93cadf9ea09d22bdeaf4e` / schema-body `sha256:fe642af8eb3e128fc72abbb9e6d81e774c2f3e05effe19313990f2d402842e0f`. The append-only result is `45/66` with `21` open and `24` candidate content identities. Source is `3967` / `sha256:9733b5ee85ed6d21341083d605002c610ab5db3f7391cb3acd7b09d45428a5a9`; artifact `142359` / `sha256:34cb24c9ca4fb4a6b8ca8780db16f6c953f785499965ad6381f5b5f1abd283df`; Node evidence `sha256:c31275a7a394b92f921ad95c840a920619204bf9e9e27108e7e4abb9793db823`; independent evidence `sha256:444740f9548cb9572f7f6a47a8fe38f3f525ae7278c55a02b9db200fcdc7b074`; `26+22` attacks fail closed. These are inline candidate documents, not persisted/Store-issued/retained authority;
- the next topological tranche refuses to infer three remaining bodies from nearby descriptors. Instead it pins the exact `AgentCommandReceiptV1`, `CommandDedupeRecordV1` and `RequirementAttemptSelectionV1` TypeScript declaration blocks, pins the current compiler source, and compiles three closed source ASTs against the same base-plus-candidate graph. Strict AJV compiles all three; independent Python separately expands the selected ImmutableContentRef branches and the one-item Evidence tuple and reproduces the documents byte-for-byte. Receipt is `984` bytes / raw `sha256:b542cc09bfd09f1f65d3937831706b2fc069e9e7ec44a48c4c26fb8fe6e6a59b` / schema-body `sha256:6e7fdd7ef3e43c22ec148022fdd8cf9ad2d5ebe17abfd33b8d92ce7f38b4f0b0`; Dedupe is `2873` / raw `sha256:2f03633f76e5b58b61947ee6be43f3f0aea4e090809a64e990a8625fe029f9c1` / schema-body `sha256:19456f341b51fb9e0be357f1203154cac996c86708ed59a098f97afd5569e817`; AttemptSelection is `2211` / raw `sha256:f9f6e9e7880e7ceea555fe0fa7fab5ff76efa81c45bdb3f241e9ed8323ab2dbd` / schema-body `sha256:4dd44d5742d60af772270445b8cd7ab86428f367dac097de1452e37a1547ac53`. Append-only composition becomes `48/66`, leaves exactly `18` unmaterialized and carries `27` candidate content identities. Source is `7766` / `sha256:d5b619e430c0abd2fa66a31c857236e353cc637ad8d9eba34b8e2dfac8205629`; artifact `148592` / `sha256:5367f8f5f59f9e696f41217c9da2a9bd791ee2b89ff91e374ba70c79ad7f6de6`; Node evidence `sha256:fcb0ca42aa9d6edb689f63eecee6f1e6f855ec12f522be05a9f52df44bd6d7b1`; independent evidence `sha256:d6fa926014136d436e3271fb78486f345640e684adf97c6732817dc02ccd3b4f`; `27+23` attacks fail closed. The structural documents are inline only, and their new ID endpoints deliberately have no composed authority rows yet; standalone persistence, definition seal, Store refs, retained authority and product readiness remain false;
- the evidence-foundation tranche keeps that boundary and compiles only `EvidenceAdmissionKeyBodyV1` plus `EvidenceGraphSnapshotV1` from their exact shared normative block. It preserves the distinct `raw-sha256` implementation identity instead of accepting a semantic `sha256` digest, expands both immutable refs to the exact instance branch and lowers the graph's ordered node list to an exact one-item tuple. AdmissionKey is `2671` bytes / raw `sha256:cb19792c4b96eaf484f47453f6d1ba329e6e2dbfd9a074389b1ca81f544ac516` / schema-body `sha256:20f886520b4e8113044a42edf12c50d9918869de770de0383bf798ef9d020b57`; EvidenceGraph is `1885` / raw `sha256:573feb9c72b8521474cfaaeddb5978bf540df038789349d7aa75b07560985be5` / schema-body `sha256:439317d9529679a623ee78cd1857d4a199ad760c24d843215fa9cc5b8984276b`. Append-only composition becomes `50/66`, leaves exactly `16` unmaterialized and carries `29` candidate content identities. Source is `5734` / `sha256:dcfcfa8289b70ed2780ea96e989c4c0a848440db8e3d0ba1400d412a6ddc2f24`; artifact `154913` / `sha256:d03e1da56fe65f094bb2db11b069805a0dae5e1ade0e9e9f10ff5bbcf5912b86`; Node evidence `sha256:e54a82663480b51e80092a8841f289dfe5a680db6098c9663db2a7d4bf020b11`; independent evidence `sha256:6d33f19686cca31f9a3d7f2cc22802aaa37f3c55a8c27a68b07586a74e38c745`; `26+22` attacks fail closed. ID authority, standalone persistence, definition seal, Store refs, retained authority and product readiness remain false;
- the goal-foundation tranche then materializes only `DeterministicGoalMinimumV1` and `GoalAdmissionBindingV1` from their shared exact normative block. It does not re-invent the nested target or partial policy: their raw AST nodes must be byte-equal to the already proven schema-cohort helpers before compilation. The target retains the full immutable-content `$ref` at schema level; semantic narrowing to the intended retained instance remains a later binding-authority obligation. GoalMinimum is `4841` bytes / raw `sha256:cca1f678e44d539b33bad6358ad8ce7e9ee88685b2bab9ce98654a32b137a5f5` / schema-body `sha256:f12aa403ca6a98eb7dc75d6e3d31db4915fe43b768982610575962b01803e328`; GoalAdmissionBinding is `14519` / raw `sha256:7b3f80644b865e39957c73dc0e0f13d726fcb0339459a6b22eb6358c1d28f61d` / schema-body `sha256:fd2cddeb20199c3c7abe956ce921019756496642e727e8eef22e85e2ea8914c0`. Append-only composition becomes `52/66`, leaves exactly `14` unmaterialized and carries `31` candidate content identities. Source is `10934` / `sha256:976beea1c3ebbdbf1a820e421281eb990efab0a063c40b400fcb29f7585b13e3`; artifact `178451` / `sha256:a3635f306dda5e2d88ca78413ea7125ed9f60c203d945492f956ada63fcf1c26`; Node evidence `sha256:354193b8b4551f821f6c908ad3d911177381967300ccfe103080ecf19acc7a02`; independent evidence `sha256:a9d8dd1937a04ceecf56518817f2c97f1f89ece24288ae247f6ff51d50532fe1`; `28+25` attacks fail closed. Its new ID endpoints still have no composed authority, and standalone persistence, definition seal, Store refs, retained authority, matcher implementation and product readiness remain false;
- the command-fingerprint projection tranche refuses to compile the generic review-time `string`/`JsonValue` interface directly. It pins the exact 2267-byte generated `AgentCommandV1` source from the atomic-preflight artifact and mechanically projects both accepted branches. Payload refs, target shape and follow-up CAS are copied exactly; accepted context, command ID, correlation and creation time are discarded; only the accepted-context digest, authenticated epoch, exact empty attachment tuple and new schema discriminator are added. The result is `1970` bytes / raw `sha256:e4b15649d2982da922b1a6ec35830b90b42cdf40a95dd6c01c0c4f3882431f6a` / schema-body `sha256:dd55a50a92131f5d107bb9b88a923b7f2ca2fc92472b014e98fc4fd8c2dcb9f0`. Append-only composition becomes `53/66`, leaves exactly `13` unmaterialized and carries `32` candidate content identities. Source is `4730` / `sha256:a8f1675a68b4743ba4421dc7814aee22649b9863d6f2f076acde8aafb1d7073e`; artifact `167166` / `sha256:97be93b19a4798326d858de820023091b9d4debb0ed1244835ade5da39172dad`; Node evidence `sha256:1b22064ad356f23956e36720e447592f4b37f3f51c960c80627604d69b8fe6e2`; independent evidence `sha256:eeb7e96b7d30e8b7691f1b827946456ce6177c340e1574850e789ae17227422b`; `30+27` attacks fail closed. ID-endpoint/binding authority, persistence, definition seal, Store refs, retained authority and product readiness remain false;
- the protocol-error tranche pins both the `AgentProtocolErrorV1` declaration and the exact 24-row normative error table, then expands the seven `optional-pair` rows into absent/present diagnostic branches for 31 disjoint branches total. A present diagnostic ref is derived from the pinned retained ImmutableContentRef opaque-bytes branch and narrowed to `purpose='diagnostic'` with only `private|sensitive` classification; half-pairs, artifact purpose, public classification and all `detailCode/message/path/cause` properties are structurally forbidden. The result is `18318` bytes / raw `sha256:c11aeb85149ac6dc360c0dfffe15552feff6e3bb9c8a89b0c2343a513e05a45c` / schema-body `sha256:7c8dafa1fbb1b2c80a71e89718028e2059bd1f080b16db4a34ece73f02ac91ee`. Append-only composition becomes `54/66`, leaves exactly `12` unmaterialized and carries `33` candidate content identities. Source is `6754` / `sha256:033e776fb5f09d2c1d5762f91d4117bd6825b3b0970df34edb3b538fc6339db6`; artifact `191819` / `sha256:f681e928542adad29bbab9258b9eb950c65360aafcc23f3243c4764dd26d0f51`; Node evidence `sha256:e25e474f3d32ee11fa746b7d4f2cd1a3c57a33d24f16aaffe45d58d7ee33d252`; independent evidence `sha256:0c16679d459447bf684338c601820748721b7f5f73ae068578a47718c9738de1`; `30+26` attacks fail closed. Its `traceId` endpoint still needs exact ID authority; persistence, definition seal, Store refs, retained authority and product readiness remain false;
- the selector/recipe tranche derives the exact 28 selector IDs one-to-one from the separately pinned 28 claim members and requires byte-equality with the protocol definition's selector semantic profile; no ambient selector ID can enter through a regex. `SelectorDescriptorV1` expands the six legal value-type/encoding pairs into six disjoint branches, retains only `capability-output|evidence-node` sources and an RFC 6901 structural pointer. `VerificationRecipeV1` is narrowed to the sole capability-owned recipe/projector identity, raw implementation-hash domain and exactly 28 unique claim-template digests. Selector is `10158` bytes / raw `sha256:c3f97896e3312e7cc881c70c83fe9691f390f446c6184d189d1f717018914835` / schema-body `sha256:d93e1bdb904e04d358140c0b9be865683ee2f29287b9f13fbba3a3966cf9cf70`; Recipe is `1201` / raw `sha256:a0628ae5009f8cd93fa6bf36d7d8b85bae3af08aab9eba4b12e65f6eff0007b5` / schema-body `sha256:bfbc1b746b8e616a2262318536780c1e135434d77d45dd79b7fb14bf4cc0ef3f`. Append-only composition becomes `56/66`, leaves exactly `10` unmaterialized and carries `35` candidate content identities. Source is `5067` / `sha256:82f75d1dcc97dc93369aa8983bdd6cdb938d27cd7485f38ae1432c8205b5176e`; artifact `196828` / `sha256:a5b9559671ea4e09cc7281e4fd38c7f45b43361f22c087b4734604674669b8c7`; Node evidence `sha256:45fa153099baa6742d4850083097e07a955f6223d5158654f8759793b4e0d8f1`; independent evidence `sha256:9cf1ef608503fe3eb6db755c21922a3808602c19e4702977a559e073b41d6b21`; `29+27` attacks fail closed. Claim-template bodies, ID/binding authority, persistence, definition seal, Store refs, retained authority and product readiness remain false;
- the claim-template tranche treats the pinned §9.4 table as executable normative input instead of maintaining a third hand-written list. It exact-pins the declaration, fixed-suite paragraph and all 28 table rows, derives one disjoint schema branch per row and proves table IDs/selectors equal both semantic profiles. Core templates now explicitly use `version='1'`; every branch fixes source, RFC 6901 pointer, type/encoding pair, predicate form, private classification, presentation key and the complete settled/observation evidence policy. `condition`, `maxAgeMs`, embedded claim `id`, alternate authorities/kinds and type/predicate substitutions are structurally impossible. The document is `60830` bytes / raw `sha256:99ca66ac43e93d1c300e93b18e435aa619a7e588aacafb9724000688fc54d988` / schema-body `sha256:6a84181445fc506cf0f021741b96784fb8932b060aa0f47199e9565c94542a7f`. Append-only composition becomes `57/66`, leaves exactly `9` unmaterialized and carries `36` candidate content identities. Source is `5245` / `sha256:f9daa74d4bb58e443a4b23b0025bede6163805cd5310e674dfe0517497a48bdc`; artifact `262388` / `sha256:cfd1143a2362ef8d04e08895b140d0dcaf5bc002db47ad171cb29e3b548b948c`; Node evidence `sha256:03c34d220dfbb1c74e642b399cd72191c6a7adbeebf250f07501c03be5186f5a`; independent evidence `sha256:9c927527166b9c27f4be68b8ca7def62d66d31203ac96bccbacad3867e92de79`; `28` direct schema attacks plus `31+28` artifact attacks fail closed. Equality of the repeated source/presentation/selector/policy digests still belongs to the later finite binding-authority program; ID authority, persistence, definition seal, Store refs, retained authority and product readiness remain false;
- the identity/receipt tranche projects the exact pinned ID configuration into one immutable `OpaqueIdProfileV1` instance schema: `23` random kinds, `5` semantic profiles and `117` endpoint rules remain unique and primary-ID sorted. `KernelReceiptRefV1` expands into seven disjoint branches: completed, plus absent/present diagnostic pairs for cancelled/failed/unknown. Completed alone owns result/proof refs; non-completed branches cannot fabricate them. The first compiler attempt exposed a real structural widening: reusing the retained opaque-bytes branch without narrowing still admitted `purpose='artifact'`. The final receipt schema closes that field to diagnostic and `private|sensitive`; half-pairs, public/artifact diagnostics, result injection and disposition/outcome substitutions fail. Opaque profile is `44680` bytes / raw `sha256:ba11bd1ee3acf42fe4c630e8e694ebaf248fba76ae67668645b52544282689a0` / schema-body `sha256:2defa63f3e52e10f809ec102603900fd202b4887a565deb738bebdd8cfb9613c`; receipt is `12104` / raw `sha256:0d264961072b5c851a343af7b72ca42bf09dd783e912cc45e6818ea2392b4e68` / schema-body `sha256:98da5961a3630632d74f364887479b97b73e3c5cd0a97dd545306ce41ddfd332`. Append-only composition becomes `59/66`, leaves exactly `7` unmaterialized and carries `38` candidate content identities. Source is `5817` / `sha256:54ccb684933ec367e9bbbd39b22f9f4a5c97e714221bbfdd7ab1ff1ee24b3c0d`; artifact `313284` / `sha256:5d9323441ea3a5061b14f50716479506dcf0ce8642665965660b34d70ac75135`; Node evidence `sha256:8e6f73b0b4ddedb239ff72ced9911e441042ddd82eb067d68756b101f5de64a2`; independent evidence `sha256:3dbe6ef85b7a08d9f6b3155c0db3ce00e5ff30bd336b0f4f47e45b8a4368f01d`; `17` direct schema attacks plus `27+26` artifact attacks fail closed. Completed ref content-kind/schema equalities still belong to receipt binding authority; ID authority, persistence, definition seal, Store refs, retained authority and product readiness remain false;
- the storage proof/output tranche materializes the first complete schema pair for a real read-capability result surface. `StorageTraversalAccountingProofV2` has `14` disjoint disposition branches: completed, cancelled, one exact five-reason non-limit branch and eleven limit branches, each of which requires its matching limit witness and forbids every other witness. All potentially unbounded counters are canonical decimal strings, implementation identities remain `raw-sha256`, terminal broker resource state is exact and the diagnostic ref+digest pair is absent iff skipped/error/cloud-placeholder counters are all zero, otherwise required and narrowed to diagnostic/private-or-sensitive. `WorkspaceStorageAuditOutputV2` preserves the retained canonical-path, exclusion-summary, temporal-proof and immutable-ref shapes, admits exactly `18` abort reasons (`none`, cancelled, five non-limit and eleven limit), and enforces the same diagnostic coupling. Proof is `25711` bytes / raw `sha256:6f6a22190d8dba7551d87d670feaec006cd14cc8b343a9d71d48a60c4ea48ae3` / schema-body `sha256:3fffd836b29d8910a6f7a3978294b8bf8ccf0f1594b26c94c0568b70f6a8794e`; output is `6259` / raw `sha256:04778c1c1645cd7f9aa3228ccfd9ca70985d4ca3886ceabeda2054d4d84aa7c8` / schema-body `sha256:7b9f8043ffde35bbb34d5fe75cec6223ff1a6507fda8e08c4f7d0eac594e01bd`. Append-only composition becomes `61/66`, leaves exactly `5` unmaterialized and carries `40` candidate content identities. Source is `8269` / `sha256:089ee7f06a6628628e13260f26ed2e7d03fe2374e50c004f7ff2dd8607871ae5`; artifact `256724` / `sha256:92f6d8878fbca1592c6f7fa07865c21def9b31235e4ca56951483c18dbaef2cc`; Node evidence `sha256:396c63e7ff60e3acf1e200b4291db33bb672c584576d3884bc2cde4005821103`; independent evidence `sha256:dcec6e4d588ee777ce4ec5a46ba832949ee79ff18fe897ab4c08e764d33041f9`; both implementations reject `25` artifact mutations in addition to `9+7` direct schema attacks. Cross-object root/policy/proof equality and exact output-ref content bindings remain generated binding-authority obligations; ID authority, persistence, definition seal, Store refs, retained authority and product readiness remain false;
- the goal/presentation tranche closes the next dependency layer without inventing a generic planning language. `GoalSemanticBodyV1` contains one exact storage requirement, one candidate source, the exact ordered 28-claim tuple mechanically projected from the already generated ClaimTemplate branches, exact normalized WorkspaceStorageAuditInput, the four ordered authority/target/temporal/budget constraints and the closed completion policy. `PresentationContractV1` fixes all 28 allowed and 16 required presentation keys, the ordered six locale×verdict template branches and the exact two-locale expansion of all 27 denial rows into 54 ordered message slots. Template strings admit only plain text and their verdict-specific allowlisted double-brace tokens; denial messages reject braces; renderer identity remains `raw-sha256`. Schema shape intentionally does not prove that every required token occurs exactly once or that Goal ref/digest/policy repetitions equal their retained sources—those remain finite binding/instance-validation obligations. Goal is `53885` bytes / raw `sha256:f5569a00d8373efc4976b91d61eca564393a8538b6e83a940c492bb937ae13f6` / schema-body `sha256:045769a38430829ffd6791fcf93f033f908027bc78d73982bded6ffe9c3c58b6`; presentation is `25189` / raw `sha256:22af1dde508c6b2c701ed2a5c2797135845daaba56939819b8f780b7c210ab9b` / schema-body `sha256:fb2f0010a2880d5b0e3ec69ae766eff5975dd85544a12f687d34d15a2e7e3a63`. Append-only composition becomes `63/66`, leaves exactly EvidenceView, StructuredResult and ProtocolFeatureSchemaManifest open, and carries `42` candidate content identities. Source is `7090` / `sha256:d0a936c6e88a136b96add22f4190a0da535fbd36a7d2e2d9121a36787253c34d`; artifact `315347` / `sha256:d87be485a343d05ec94a2fbf8cea6bc3054d69564fe966eb29e386e7d806e3b6`; Node evidence `sha256:9e315c6750c15022882586d19291179d15e9215655c24d6fc0a3d3e9e633ba6d`; independent evidence `sha256:694dbbc1fde44370791beb2ece3ab50eda5da5f4e1b24684f218c385720bfb54`; direct schemas reject `6+8` attacks and both artifact implementations reject `22`. ID/cross-object binding authority, persistence, definition seal, Store refs, retained authority and product readiness remain false;
- clause ranges bind exact accepted-command payload bytes; candidate branches reject impossible optional-field combinations;
- mixed informational rows plus one homogeneous operational cohort project independently;
- split V2/V3 execution is absent; missing eligibility/target/temporal meaning clarifies or blocks;
- GoalAdmissionBinding proves exact accepted context/locale/admission candidate → explicit interval + partial policy + exact 28-row claim suite and 28-allowed/16-required presentation-key sets → RuntimeFeatureSet/matcher/capability/target/root/AuthorityScope/inclusion/exclusion/budget/normalized input/semantic equality; current/stable/ambiguous or silently widened partial branches cannot create an Execution; minimum and Goal cite the same binding;
- retained deterministic minimum, finite allowlisted matcher ref/body/implementation and final Goal compare byte-semantically;
- every authority-bearing ref resolves through the bounded exact expected closure; every path equality resolves through the canonical identity body/digest, while extended/GUID/8.3 ingress aliases are accepted only when the local-fixed-NTFS direct-device support gate proves the same handle identity;
- schema lab has no Catalog, Activation, Plan, Decision, model, network, provider or product-facade path.

### 30.3. Pinned capability and storage fixture

- exactly one `workspace.storage.audit.v2` contract is admitted by digest;
- all reads use a newly created disposable fixture root; drive roots, user data and production Safe are forbidden;
- deny-before-enumeration fixture proves a protected boundary produces only generic `policy-restricted` disclosure;
- support fixtures admit only a non-volume-root, non-reparse directory reached through a direct local fixed NTFS device; UNC/SMB, mapped, `SUBST`, removable, VHD/VHDX, ReFS/FAT/exFAT, mount-point/reparse ancestor/root and alternate enumeration APIs deny before traversal;
- enumeration fixtures pin `FILE_ID_EXTD_DIR_INFO` long names, first-call-only Restart, strict UTF-16→UTF-8 component/path accounting, sentinel removal before counts, no short-name row and no normalization/case-fold/trim; handle aliases retain the exact volume identity body and path identity contains no display/NT-path-derived or undefined reparse digest;
- accumulator remains exact at `2^53±1`, max-u64+1 and multi-entry sums above u64;
- the separately pinned supervised broker owns observation/counter facts and schema-lab transcript oracle; a walker self-attestation, non-exhausted iterator, nonempty frontier, operation-class sum mismatch, unclosed handle, root counted as a child directory or broker/walker hash substitution denies;
- accounting proof, output counters, accumulator, exact capability policies and root/volume/target identities match or projection denies; completed vectors additionally prove every retained file/directory/depth/path/elapsed/per-I/O/I/O-count/resident/frontier/handle/batch/cumulative-response limit, nonzero cancellation cadence, exact entry/I/O/return/terminal budget-check equations, cancellation maximum gap and terminal markers, while zero cadence/timeout, omitted check coverage, over-limit completed proof, forged witness or any limit/reason mismatch denies;
- first access/stat/disappearance/unknown-object/cloud-placeholder error aborts immediately; cloud count is exactly `1` only for `cloud-placeholder-unmaterialized` and otherwise `0`, and `reparseEncounteredCount = reparseExcludedCount + cloudPlaceholderEncounteredCount`; no fixture continues to a selectively complete total;
- core temporal schema accepts only `interval-observation + mutationDetection='not-supported'`; snapshot/stable/detector fields and current/stable user intent are negative admission/schema vectors, not hidden branches;
- completed receipt simulator-cut vectors prove `resultRef/resultDigest` and accounting proof are resolvable before receipt publication without claiming physical durability; failed/cancelled/unknown branches forbid invented result bytes;
- Invocation dispatch key body/domain, once-created attempt ID and every receipt binding match exactly; duplicate injection never creates a second port call;
- incomplete/error/skip/budget/cancel never verifies; output/proof `abortReason` is exactly `none/absent` for completed or the same enumerated non-`none` code for incomplete, and diagnostic bytes cannot choose the branch.

### 30.4. Evidence, assessment, certificate and presentation

- graph snapshot and attempt selection commit the exact single node/Invocation IDs **plus immutable body refs and body digests**; zero/two/mismatched/conflicting inputs deny without ambient ID lookup;
- one explicit `RequirementAttemptSelectionV1` exists per requirement;
- assessment input resolves the exact Goal semantic body, attempt/Invocation refs, authority, capability, recipe, policy, runtime, certifier, canonicalization, presentation and attested time without ambient registries or dependency sets; its same immutable ref+digest is retained by request, assessment, terminal command and certificate with no digest-only lookup;
- global and requirement denial branches reject invalid field combinations; assessment-input failure requires the settled Invocation snapshot, certifying-only internal failure forbids Invocation/receipt/certificate, and no post-dispatch receiptless path can terminalize Execution;
- capability-output versus EvidenceNode selector source/schema, derived walk verdict, type/predicate, wrong capability/input/contract, partial/freshness/order and unresolved Invocation fixtures pass; the pinned temporal comparator, not JSON Schema, proves sibling timestamp order;
- canonical assessment body is deterministic; input `assessedAt`, input attestation wall label and certificate `assessmentFrozenAt/assessmentClockAttestation` are exact copies, terminal observability time cannot re-assess freshness, and the once-created envelope is byte-identical on retry;
- certification key uses only its dedicated body/domain; certificate and terminal event are one fixture commit;
- every core event requires an appender command ID; the `completion.requested` freeze commit has one stable ID and reserves a distinct `completionCommitCommandId`, while assessment commit and both certification/terminal events must repeat only the latter and simulator retry cannot allocate a replacement;
- the generated `CompletionDenialV1` and `AgentProtocolErrorV1` schemas accept only the exact code/detail/ID/recoverability and code/category/retryability tables in §§18.3/27; ProtocolError rejects every free-form `message`/path/cause property and renders only a local code template, with `path-ineligible` byte-equivalent across protected and ordinary denial causes; recovery labels never auto-authorize a retry;
- certificate→EvidenceView and EvidenceView→StructuredResult binding rules reject changed local trust profile/issuer, status, scalar, omitted/changed unresolved item, locale, disclosure, verdict-template row or ref; exact six locale/verdict templates and 54 brace-free denial-message rows make blocked renderable without missing claim values, one-pass inert plain-text substitution forbids template/Markdown/HTML re-entry, core artifact arrays are exactly empty and renderer implementation hash is pinned; UI wording never markets local trusted-writer evidence as third-party/notarial attestation.

### 30.5. Non-product store evidence

- the generated closed event union fixes payload branch, `payloadVersion=1`, producer and stream kind/ID; expanded manifest guard/state/commit programs are callback-free, separately identity-evaluator/state-reducer hash-pinned and prove every positive Interaction/Execution transition plus exact receipt-link, Invocation-terminal and certificate-terminal suffix, rejecting every illegal/negative transition, receipt-less post-dispatch terminal and reserved event;
- an in-memory fixture stream proves command/event sequence, full-commit replay, idempotency collision, accepted-command+dedupe+receipt+single-first-event all-or-none visibility and exact cross-field projection, fixed-generation retention of the complete dedupe record plus byte-identical receipt, retry after current locale/feature/contract/auth epoch changes without new work, and atomic certificate+terminal ordering; the core has no rollover, compacted-receipt or dedupe-tombstone response branch;
- a separate isolated durability/latency benchmark compares candidate stores without creating product schemas or touching user data;
- schema-lab success authorizes only a reviewed fixture artifact. Product shadow, V4 journal, Engine, Approval, effects, providers, Incognito, encrypted lane, children, jobs and compaction each remain unavailable until their own manifests and acceptance matrices exist.

---

## 31. Protocol decisions deliberately deferred

1. Wire encoding кроме canonical JSON baseline.
2. Physical event store.
3. Public API endpoint naming/version path.
4. Exact SSE coalescing thresholds.
5. Third-party capability trust signing format.
6. Multi-device replication; V1 предполагает single-owner local application.
7. Remote distributed scheduler consensus; core schema lab has no scheduler/lease at all.

Они не должны менять authority, ordering, idempotency и certification semantics.

---

## 32. Normative product/version glossary

| Term | Exact meaning / forbidden shortcut |
|---|---|
| Astra V3 | official target Agent Runtime architecture family; not persisted `monarch.agent-task.v3`, not current Astra Skills `0.1.0`, and not a claim of implementation |
| Monarch `0.3.0` | assigned target release train; readiness still requires exact enabled-profile and installed-release gates |
| Astra Skills | current `src/modules/astra` discovery/Agent Skills component; it is not execution authority and may only become a bounded Astra V3 adapter through migration |
| Execution Store V4 | future journal schema for Astra V3; never abbreviated to “V3 store” |
| Interaction | persisted user/surface conversation unit; may link zero/many Executions |
| Execution | one immutable V2 or V3 cohort aggregate; never mixed generation |
| Goal revision | typed contract bound to exact admission inputs; not mutable prompt text |
| Activation | one leased runner generation; not task authority or approval |
| Invocation | one exact capability attempt; `verified` is not its state |
| `verified` | V3 Completion Certificate verdict only |
| legacy completed | old runtime outcome, explicitly not V3 verified |
| `walk-completed-without-local-error` | projector-derived traversal verdict under exact policy/proof; not a stable set, whole disk, Safe or physical-byte claim |
| logical namespace-entry bytes | sum of included logical file-entry lengths; not allocated/physical disk usage |
| point-in-time / stable / interval | distinct temporal claims; only interval exists in core, while point-in-time/stable require a future schema/profile and are never silently substituted |
| `cancelled-before-dispatch` | dispatch linearization not crossed |
| `cancelled` | post-dispatch cancellation proven by admitted receipt |
| `indeterminate` / `blocked-indeterminate` | effect outcome unknown; acknowledgement/archive does not resolve truth |
| egress permit / attempt / ingress receipt | authorization to try / local send fact / response receive fact; none alone proves requested effect |
| protected ref | server-resolved encrypted object locator, not a bearer token or Safe handle |
| Incognito memory-only | app/runtime port contract with disclosed OS residual limits; not guaranteed physical zeroization of pagefile/GPU/crash infrastructure |

Public strings/badges and diagnostics map through versioned templates to these meanings. A UI label cannot collapse interval to “current”, policy-relative logical bytes to “disk used”, legacy completion to “verified”, permit to “sent”, or unknown cancellation to “cancelled”.
