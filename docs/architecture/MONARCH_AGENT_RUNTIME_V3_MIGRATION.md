# Monarch Astra V3 — migration and acceptance plan

Статус: **IMPLEMENTATION AUTHORIZED — FIRST EXECUTABLE V3 COMPONENTS IN ISOLATED VALIDATION; NOT NATIVE-CONFORMANT OR PRODUCT-INTEGRATED**.  
Исходный draft: 2026-08-24. Последняя архитектурная ревизия: 2026-08-29.  
Основная спецификация: `MONARCH_AGENT_RUNTIME_V3.md`.  
Фундаментальное агентское ядро: `MONARCH_ASTRA_V3_AGENT_CORE.md`.  
Protocol contract: `MONARCH_AGENT_PROTOCOL_V1.md`.

**2026-08-30 owner override:** Astra V3 implementation and directly related work are now
explicitly authorized; the earlier architecture-only restriction below is historical.
Executable journal/read/TaskGraph/context components exist in `src/agent-v3/`, with actual
disposable Kernel reads and focused fault tests. No default product/shadow activation,
native certificate or user-visible full Astra V3 verdict is implied. Current evidence:
`MONARCH_ASTRA_V3_IMPLEMENTATION_STATUS.md`. Target remains Monarch `0.3.0` and full
`astra-core-experience.v1`; a read-only slice is not product closure.

Третий и последний frozen-source prose PASS 3 завершился `FAIL (P0=0, P1=5, P2=1)`. Его шесть findings исправлены только как post-PASS3 source corrections; они остаются open artifact gates до generated package/fixtures и независимого artifact-level review. Четвёртого prose pass нет.

---

### Budget-prioritized V2 bridge — 2026-08-30, design only

**Later owner clarification / partial implementation:** the owner subsequently authorized
practical fixes; two existing-runtime boundaries were patched: raw+stored-projection
validation and normal assistant predecessor binding. Normalizer/Coordinator/Turn-runtime
136/136 focused tests PASS9.02s; no fresh real-route capture. Storage value presentation
is still defective. The owner then asked why V2 rather than V3: this bridge is **not**
the principal Astra deliverable or permission for an open-ended V2 modernization effort.
V3 remains unintegrated; the main objective is its first real end-to-end slice. Historical
capture source pins and the earlier seal do not certify these changed product sources.

Owner reports subscription/time pressure after 2–3 days of continuous preparation. This
changes **work order**, not the full Astra objective or product permissions. Stop expanding
the native certificate/schema/simulator chain as a prerequisite for fixing existing V2
consumer defects. No additional full audit, seal rebuild or model run is required to
understand the next patch. Product/shadow Astra remains disabled; changing existing V2
is a separate explicit scope decision, requested from the owner, not silently assumed.

**Fresh evidence:** `tests/oscar/turn-coordinator.test.ts`, suite
`Astra migration: known V2 storage presentation defects (NOT repair acceptance)`, runs
the real Coordinator/reconciliation/Turn store/outbox against synthetic completed Agent
checkpoints. Four cases PASS in 4.23s (assertions 89ms; 72 unrelated tests filtered out).
These assert the **current wrong behavior**, not repair success:

| Input at the Coordinator boundary | Current persisted and replayed result |
|---|---|
| `structuredData.output.audit`: 4103 bytes, 3 files, 3 directories | Verified zero bytes/files/directories; actual root lost |
| Same output, partial observation and entry-limit reason | Partial label survives, but counts/root and skip reason disappear |
| No `output` at all, otherwise completed/verifier-labelled checkpoint | Verified fabricated zero summary |
| Correct `output.audit` plus conflicting legacy `result.audit` | Conflicting 777 bytes / 9 files / 8 directories win |

All four first assistant deliveries lack `requiredPreviousMessageId`. The fixture calls
no Agent create/answer model/Kernel/filesystem/HTTP and does not claim a fresh G2 capture,
actual bad producer output, durable disk recovery or general model quality. Its role is
to isolate a production consumer defect already witnessed by the real storage capture.

**Smallest coherent product patch, when authorized:**

1. **Capability output contract.** Add explicit storage-audit output validation at the
   existing Workspace/Kernel verification boundary (`src/modules/workspace/manifest.ts`,
   `src/modules/workspace/index.ts`; audit result type is in `storage-audit.ts`). Cover
   root, counts, top directories, skips, budgets, timestamps and completeness. Reject
   missing/wrong/negative/non-finite/unsafe-integer counters; preserve valid zero.
   Current worker uses Numbers: do not imply lossless values above `2^53-1`. A schema
   checks shape, not actual traversal truth or access-policy authority.
   **Confirmed hidden dependency:** `observation-normalizer.ts` validates raw output
   before `redactAgentContextValue`, then stores the transformed output with the raw
   validation flag. A legal 65-element typed list becomes 64 objects plus the string
   `[TRUNCATED_ITEMS]`, still `status=success, outputSchema.valid=true`, although the
   stored value fails the same schema. The new existing-normalizer diagnostic proves
   this in11ms (481ms whole focused run,1/1 PASS,6 filtered out). This is not a failure
   of redaction: it is an invalid transfer of validation evidence between two values.
   Distinguish raw execution verification from stored/presented projection validity;
   revalidate the actual bounded consumer value and disclose truncation, or construct
   a dedicated privacy-safe typed projection before lossy context compression. Never
   disable secret redaction, raise global context ceilings, or persist raw secrets as
   a shortcut. Include this normalizer boundary in the first patch and its acceptance.
2. **Source-bound result and completion.** Select the successful/partial observation
   belonging to the requested capability/target before terminal reconciliation. Use only
   its canonical `structuredData.output.audit`, never `result`/flat fallback. Validate the
   required result before publishing a successful Turn. Missing/invalid result fails the
   presentation/completion boundary without erasing already observed Kernel evidence;
   partial/budget/cancel evidence must not become complete. Keep the current V2 task
   lifecycle; do not add a second owner or synthetic Astra certificate.
3. **One immutable presentation result.** In `src/oscar-turn/coordinator.ts` (extract a
   small typed helper only if useful), derive counts/root/denials from that selected
   result once. Display exact logical bytes alongside human-readable units, retain
   partial/skips and bound output size. Turn outcome, delta/replay and outbox must use
   the same text. Model synthesis may explain the result but cannot replace its typed
   facts or acquire `kernel-verified` solely by citing an observation ID. Merely changing
   `record.result` to `record.output` leaves missing-data/partial/synthesis problems open.
4. **Causal delivery.** Bind every normal assistant outbox row to the current Turn's
   committed `inputMessageId` inside `messageOutbox`, not only startup repair. Reuse the
   existing predecessor receipt checks, stable message identity and retry behavior.
   Check normal answer and agent paths plus failure/cancel/clarification; do not overwrite
   historical messages or bypass ordering to make delivery appear fast.

**Acceptance for this patch:** replace the four diagnostic wrong-result assertions with
correctness assertions when production changes land. Add valid-empty-root zero, malformed
counts, partial reasons, conflicting wrapper, unrelated/latest-failed observation, forged
synthesis value, and delayed predecessor/restart retry cases. Use the existing Coordinator
and Workspace test suites. Run one permitted synthetic real route only after source pins
and exact fixture permit have been deliberately revised; retain the old failing capture
as historical evidence rather than editing its outcome/digest. No user-directory scan.

This fixes a concrete V2 result-to-answer failure; it is **not Astra V3 implementation**
and does not solve tool selection, model quality, long-task recovery or Computer Use.
Subsequent priorities are one ordinary multi-step task (cancel/resume/no duplicate effects),
then one exact-window Computer Use task with fresh readback. Choose their patch scopes from
their failures, not from more generic schema coverage. Memory/automatic compaction remain
required workstreams, but are not dependencies of this storage consumer fix.

**Parked, not discarded:** native Assessment/Certificate contents checker exists with
31/31 focused tests (13.61s, exact Node22). Claim values, selected policies and durable
authority remain unproven; all broad authority flags are false. Its three new files and
the changed completion fixture are not yet incorporated into a refreshed candidate seal.
The previous 253-generator seal/Canvas must not be represented as certifying this worktree.
Do not restart that chain automatically while the practical V2 scope decision is pending.

### Isolated Presentation integrity follow-up — 2026-08-30

`scripts/architecture/simulate-astra-v3-presentation-integrity.mjs` exercises the existing
Protocol §18.2 renderer obligations with four exact generated schema bodies. A mechanically
generated `45068`-byte schema fixture is pinned by each schema's raw identity; regeneration
reads only those four exact files from an explicitly provided prepared package. Its raw hash is
`sha256:1a406022f26f6cf3249ff8679fb128f040f39108f5c216efc8fcf02a7d99e163`.
No upstream materializer chain or V2 capture runs as part of the new focused test.

The lab checks schema-valid missing/duplicate required tokens (including unselected locale),
malformed templates, missing/reordered/duplicate fields, stale TypedValue digests, private
classification, unsupported locale/verdict, denied blocked scalars, exact denial lookup,
inert inserted brace/HTML text and UTF-8 budget boundaries. It preserves `4103`, `0`, integers
above `2^53`, canonical decimals and boolean false without Number conversion or truthy defaults.
The 4103 oracle comes from a BigInt sum over the separately identity-checked synthetic storage
permit; no legacy observation is imported as a certified value. Result: `46/46` tests PASS,
`1.56s`, via `npm run astra:presentation-integrity:test`.

Scope is deliberately **renderer fragment only**. The synthetic projection is not a protocol
instance or retained EvidenceView. The lab does not prove per-claim semantic types/source
selection, certificate → View equality, durable presentation retry, StructuredResult issuance
or plain-text DOM delivery. It has no execution/model/dispatch/sink hooks and only retries its
pure render method. An explicit boundary test supplies a correctly re-digested but wrong zero:
the renderer preserves it, demonstrating why the upstream binding oracle cannot be omitted.
Schema-valid templates can omit a required token, so schema PASS alone never closes this gate.

Next narrow gate: resolve one exact retained synthetic certificate and its frozen contract/
locale/input through the existing Store and binding-program substrate, then independently
compare source claims → View → StructuredResult → delivered scalar. Never use this fragment's
PASS to rewrite the V2 failure, hide the predecessor gap, or activate product/shadow runtime.

### Projection authority gap and unadmitted value/meta tranche — 2026-08-30

The exact prepared active ABI has `148` programs (`25` retained, `114` event, `9` completion),
but **zero programs address `monarch.evidence-view.v1` or `monarch.structured-result.v1`**.
Its candidate endpoint roles contain neither `evidence-view` nor `structured-result`.
Historical schema-manifest support for the names `certificate-view-projection` and
`view-result-projection` does not supply these executable rules. `66/66` schemas and the
`148/1620/30` ABI counts therefore do not close the delivered-value path.

The shape difference is already normative, not a new protocol decision:
`CompletionAssessmentBody.unresolved` contains `{denial: CompletionDenialV1}` rows, while
View/Result contain flat `CompletionDenialV1[]`. Whole-array copying fails schema validation.
Application must project exactly `/denial`, preserving count/order/all denial fields, with
no wrapper guessing or fallback.

`probe-astra-v3-presentation-bindings.py` reuses the existing Store schema/witness helper and
Completion equality interpreter. It proposes `9` **unadmitted value/meta** programs with
`571` instructions: three Certificate→View and six View→Result variants. A proposed closed
`assert-array-element-projection` operation handles only `/denial`, `maxItems=64`, exact order.
Its experimental evaluator is separate: the active ABI still has 30 operations and neither
new role. This is not arbitrary code, model projection or a compatibility admission path.

`verify-astra-v3-presentation-bindings.mjs` independently pins the prepared manifest/ABI/
program shards, reconstructs the proposals, validates all three witness bodies against 10
exact native schema documents with Ajv, recomputes body/TypedValue identities and compares
actual values directly. On `34` schema-valid cases: `6` preserved branches pass and `28`
scalar/context/certificate/denial mutations fail projection. In particular, `4103` remains in
the certificate while the result contains `0` **with valid recomputed hashes**. Denial
reordering/dropping also fails. Six report/program/schema/readiness mutations are rejected
for the expected reason; unrelated parser/I/O failures are not counted as valid rejection.
Probe: `sha256:64c2e56e98a28b284bd500235f747b38a599977bcb03ff6c981051ad411e0114`.
Report: `sha256:aa9b248a0aed85a2072f5bba6f13c4243912582df0175d21c569524548f83e78`.

Reproduce: `npm run astra:presentation-bindings:check -- --prepared <existing-package>`.
The explicit prepared argument prevents an accidental full regeneration. This check is not
silently appended to the aggregate. No database/temp child is created; the counterexamples
travel through bounded subprocess stdout, not a stored evidence corpus.

**Not proven:** witnesses are schema-shaped, not valid retained certificates; refs are
placeholders and are NOT resolved. No Certifier runs; source/selector/claim-type truth,
disclosure parameters, renderer/contract-ref identity, allocation/retry, presentation events
and UI delivery remain open. Other witness claims are shape-only. Do not insert these proposals
into an active profile or advertise them as complete projection bindings.

Required repair order:

1. Finish projection entry contracts: exact retained source refs, trusted snapshot scope,
   frozen locale/contract, full field/denial/disclosure mapping, no ambient lookup; pin program
   selection and roots rather than reusing a completion-commit root by name.
2. Define closed role/scope and bounded-array additions in a versioned lowering tranche with
   signatures, applicable schemas, limits and independent semantics. Regenerate ABI/index/
   authority shards/schema bindings as one candidate cohort; do not edit the old authority
   silently or relax its fail-closed enums.
3. Prove retained reference resolution and source claim equality through Store, then compose
   Certificate→View→StructuredResult→plain-text delivery. Attack object ID/generation/schema/
   digest, stale context/locale, zero substitution, lost disclosures and presentation-only retry.
   A correct scalar alone does not prove an “only the number” task.
4. Only then reconsider native projection closure. Product/shadow runtime stays unauthorized;
   real V2 failure, missing predecessor and incomplete full-task baseline stay unchanged.

### Frozen projection entry candidate — 2026-08-30

`config/agent-architecture/astra-v3-presentation-entry-contract.v1.json` is a machine-readable
**architecture candidate, not an admitted protocol instance**. Source identity: `8509` bytes /
`sha256:74d5b406e92b788d45341c91fa9f8a79d7a716601fe8ff1f6f46f955c59eca06`.
It supplies exact output ownership for all 24 View and 19 Result fields without changing
their current schemas or the normative Protocol declarations.

Application selects the certificate ref only from prior validated completion membership;
Presentation selects the View ref only from prior validated projection membership. Neither
caller-selected objects nor valid self-computed hashes establish that membership. The entry
snapshot freezes execution/context/certificate identity, certification key and the exact
presentation-contract ref/digest. It validates the whole ref, Store generation/object ID,
schema identity, private/protocol-body classification, byte length before decoding, strict
JSON/schema and schema-selected content digest; lookup-by-digest/current-locale fallback is
forbidden. The frozen authority plan follows admitted RuntimeFeatureSet `/manifestRef` →
Manifest `/authorityProfileRef`, with their explicit digest fields and profile ABI/schema/shard
checks. Named hop properties are checked against current schemas; native resolution is not run.

The new disclosure convention is an explicit candidate design choice requiring lowering:
each required data key has exactly one `value` parameter, converted losslessly from TypedValue
to its matching TypedValueLiteral branch. Integer/decimal strings never become JS numbers.
The `@unresolved` row has one `denial.00` … `denial.63` string-literal parameter per original
denial, containing only the exact frozen locale-table message. Original typed denials remain
unchanged in `unresolved`; no IDs/diagnostics become message parameters. Entry producer identity
covers disclosure production, not merely the text helper. The lab hashes its entry script;
imports are bound by the candidate-definition seal, **not** a packaged renderer acceptance.

`simulate-astra-v3-presentation-entry.mjs` runs this proposal against exact native schemas,
synthetic content-addressed in-memory records and the existing plain-text renderer fragment.
Six locale/verdict scenarios pass; first projection reads exactly three application bodies
(Certificate, View, contract) after metadata preparation. This is a logical lab read count,
not measured disk I/O, cold authority resolution, memory use or product latency. Repeat uses
the same retained fixture ref/bytes. 23 supplied-ref/namespace/schema/context/contract/body/
budget attacks fail before retaining an output; 5 resealed changes fail the frozen source pin.
Six literal branches preserve object/string/boolean/safe-integer/integer/decimal values.
Current report: `sha256:742ef87dd1c3f36ea5b1eca4e51974694bb8c2b51d7617e03ccef71e9d938373`.
Earlier reports remain historical evidence: exporting the fixture observer and subsequently
making Ref/schema-authority parameters explicit changed the self-pinned producer source hash,
and consequently output/report identities. Frozen source design and default semantics remain.

Run `npm run astra:presentation-entry:check -- --prepared <existing-package>`; it also checks
the exact predecessor binding probe. No full materialization, DB, scratch child, model, Kernel
dispatch or user data is needed. Renderer focused regression remains 46/46 PASS.

The fixture supplies the trusted snapshot assumption; it does not prove real committed
membership, upstream claim semantics, native authority traversal, durable retry, presentation
events or UI delivery eligibility. Those readiness fields remain false. The separate executable
extension below covers field-binding lowering, not native authority/root-profile admission.
Do not insert the earlier 571-instruction value/meta proposals as a complete entry contract.

### Executable projection binding extension — 2026-08-30

`verify-astra-v3-projection-extension.mjs` exports a pure compiler producing a versioned
`projection-v1-candidate` program package and closed JSON Schema. It derives all 43 field
assertions from the frozen entry source, rather than manually repeating a second field map.
The package has **9 programs / 210 instructions / 11 operations**: three certificate verdict
scopes and six View verdict/locale scopes. These are ASSERTION programs, not output producers.
Their instruction count is not comparable as a coverage metric with the earlier 571-row
proposal: finite whole-array assertions replace per-index expansion, and source preflight
is an explicit host operation. They do not replace or change the old 148 native programs.

The closed operations require the selected source and frozen seven-field binding, enforce
scope, resolve the exact contract ref, and assert literal/copy/selected-ref/array-member/
unwrapped-denial/template-member/disclosure/output-digest equality. Source reads delegate
to the existing native-shaped fixture ref validator. The source snapshot is HOST INPUT:
no new fake native snapshot schema is introduced, and its committed membership is NOT proven.
Independent disclosure verification indexes keys and exact denial identities (including
whether optional detailCode is absent), preserves typed values and denial order without
coercion, and compares every resulting literal/parameter to the producer output.

Admission first requires the separate program-set discriminator, then closed operand schema,
body identity and equality with the complete frozen compiler output. Unknown/mixed programs,
extra operands, instruction omission/duplication/reordering and changed readiness fail closed,
even if the attacker reseals the package. Executing a known program must consume all its
instructions; successful bindings additionally require the native output schema. No callbacks,
dynamic code, ambient registry, model calls, output retention or execution mutation are allowed
inside the verifier. This finite exact-cohort dialect is NOT a general extensible plugin ABI.

`npm run astra:projection-extension:check -- --prepared <existing-package>` reuses the existing
bounded predecessor fixtures. All 9 programs run across 6 locale/verdict pipelines; 288 positive
instructions execute. Rejected cases: **12 package/admission mutations, 258 field mutations,
56 behavioral mutations**. The 258 cases replace each output field with null; these test
assertion coverage, NOT schema-valid attack coverage. Behavioral cases include schema-valid
re-digested 4103→0 field substitutions and disclosure substitutions, wrong exact refs, wrong
trusted-context binding, wrong verdict and wrong locale. Entry's own 23 negative cases, 5 pin
changes and 6 literal forms also rerun. No verifier test creates records or cache entries.

- Canonical program package: 21640 bytes /
  `sha256:7f9807418c0ca04bcd9df3b8d93df9dcd5e2ea2c3c532636b05def47f579eba8`.
- Generated closed schema: 8223 bytes /
  `sha256:2b14c993bac0c1920bda887f5423843a64b7a544a7324dbddd0882e1aae4ffb6`;
  shared instruction definition avoids ninefold schema duplication.
- Current report after producer refactor:
  `sha256:9f9bad9839ba8412f77900494f028740a59fe320e7c0e8e4a388fb9b0b5f5f61`.

Artifacts are generated in memory, reproducible through the exported compiler; the CLI emits
only the compact report. There is no new DB/scratch root or full materialization. Positive
entry read counts exclude verifier re-reads and must not be quoted as total checker I/O.
The schema is an architecture-package schema, NOT a 67th admitted protocol schema.

**Remaining boundary:** actual frozen RuntimeFeatureSet→Manifest→AuthorityProfile traversal,
versioned native roles/program-set/operation admission and the coordinated replacement
schema/root/shard cohort, real committed source membership, durable retain/retry/CAS, event
settlement and delivery causation. The current four-shard profile admits three program sets;
adding these nine programs to it would be invalid. No fifth shard or replacement root has
been produced/admitted in that tranche. The following tranche builds an isolated versioned
candidate, still without Store/reader admission. Further work must address that transition, not keep
adding field-only mutation counts or claim the V2 rendering bug is fixed in the product.

### Versioned projection cohort and Ref V1 version ceiling — 2026-08-30

The first three-root candidate failed independent whole-ref validation. The cause is concrete:
`ImmutableContentRefV1` restricts both instance `contentSchemaId` and schema-object
`describedSchemaId` to `^monarch\.[a-z0-9-]+\.v[12]$`. A new Profile V2 requires a versioned
Manifest V3 and RuntimeFeatureSet V3, but Ref V1 cannot describe them. Checking only inlined
root schemas missed this: their specialized const targets could accept V3 while the standalone
ref schema still rejected it. The initial “three changed schemas” estimate is therefore
superseded, not evidence of a small compatible extension.

`materialize-astra-v3-projection-cohort.mjs` now compiles a separate candidate with Ref V2,
Profile V2, Manifest V3 and RuntimeFeatureSet V3. Ref V2 permits positive canonical version
syntax (`v[1-9][0-9]*`); this is lexical validity only. Exact selected schema/ref/object identity
and closed frozen manifest membership remain required: a syntactically valid unknown `v999`
reference is rejected by the independent resolver. Ref V1 is not changed or silently upgraded.

Every schema whose closed body changes receives its own next version. A fixed-point traversal
of exact IDs, canonical schema URIs, content-identity IDs and the version grammar finds
**37 changed schemas in layers 4 + 32 + 1**, with **29 byte-identical schemas**, still 66 total.
This is a compatibility-impact candidate, not approval to migrate production. The complete map
is generated into the ABI and bound by
`sha256:f3b14d7021c54dc8eddfee328cabec7bba20a1f95b60c1ccc1fdcc9a46401b33`.

Of the parent 148 binding programs, 142 require schema-reference retargeting in the NEW
candidate; they receive new `projection-cohort.*` IDs with before/after hashes. Six remain
byte-identical. Parent files/programs remain untouched. This mechanical retargeting is not
semantic conformance evidence for those 142 programs. The nine new programs use namespaced
`projection.*` operations to avoid colliding with an older `assert-literal` dialect. The composed
candidate contains **157 programs / 1830 instructions / 41 operations / five shards**. Its
minimum reader/writer protocol version is 3; no actual reader has been admitted here.

The builder reconstructs an **85-object synthetic in-memory graph**, including 66 schema
objects, five shards, profile, manifest, runtime and dependency fixtures. It allocates new refs,
recalculates body/schema/array/descriptor/index hashes and checks each body's strict limits.
This is not a data migrator: it must never rewrite user history, evidence or real certificates.
The fixture dependencies remain structural witnesses, not proof of task/claim correctness.

Node/Ajv validates all instance bodies. `probe-astra-v3-projection-cohort.py` independently
validates full refs, generation/object identity, schema/body/declared digests, exact root chain,
manifest schema tuple, five shard descriptors and the ABI index/counts. It imports only the
existing read-only schema/witness helpers; it never opens a DB. Five native-schema negatives
cover partial roots, mixed program sets and invalid version syntax. Five independent negatives
re-seal the envelope/ABI and still reject foreign generations, missing projection shards,
unknown schema types, changed instruction indexes and mixed Ref versions. Repeated builds
in one process produce identical cohort identity and dependency layers.

- Current ABI after the native-reference correction below:
  `sha256:8febd39c84f63bc6d43903b1de06b007c57d67598875653438549c51ae879d27`.
- Cohort: `sha256:db030a69755f6f77dfc035a3d503954582ad39e21997cc4047cf4bcfc02f003e`.
- Schema digest set: `sha256:7949b62c8b0c657448d87fbc6d57df7de18c33c85de144bdcf34314ba110c19d`.
- Report: `sha256:888a563a534999aa44fd2bfd078412a8ffe436a1f8c7b591de9b50d879063109`.

Run `npm run astra:projection-cohort:check -- --prepared <existing-package>`. It creates no
DB/scratch/output package; compiler exports allow later controlled materialization. The CLI
emits a compact report; complete replacement/program maps remain available in the returned ABI.
Windows Python transport is ASCII JSON to preserve Russian constants across console code pages;
canonical identity computation remains UTF-8.

**Still open:** versioned interpreter/reader conformance (including the 142 retargeted programs),
projection entry execution against this actual frozen authority rather than the old prepared
snapshot, real committed source membership and crash-safe Store settlement, replay of old
authority generations and UI delivery causation. Old-schema rejection is not a live-reader
test. The parent prepared package, its four-shard native authority and all product/shadow
runtime paths remain unchanged. Next work must prove frozen reader/interpreter selection and
new-cohort semantics before promoting this graph into a durable Store proof.

### Frozen candidate reader and projection execution — 2026-08-30

`simulate-astra-v3-frozen-projection-reader.mjs` goes beyond the preceding graph validation:
it admits a synthetic catalog by exact cohort/ABI/schema-set pins, resolves Runtime V3 →
Manifest V3 → Profile V2, reads the 66 schema objects and five shards, validates full refs,
native schemas/content identities and the complete program index, then selects projection
programs from that frozen shard. Startup performs 74 logical metadata-body reads; this is
not a disk-I/O or latency result and excludes subsequent source/evaluator reads.

Program selection uses entry index plus verdict/locale from the resolved certificate/View;
caller-selected program IDs, current locale and registry fallback are not inputs. The entry
overlay is separately identity-checked. Its `authoritySnapshotDigest` holds the new cohort
identity, while the original `preparedInputDigest` remains unchanged lineage: the two domains
are not interchangeable. Overlay identity:
`sha256:5d2fb3aa40daf1092a109e1fba26a299bc6d2bc937bbc3d312a0780318e6a61b`.

The existing EntryLab now accepts explicit reference-schema and frozen-authority parameters;
its default old-closure behavior remains covered by the original regressions. The assertion
evaluator is shared, with an explicit `projection.` namespace chosen only after reader admission;
the exported low-level evaluator is NOT an authority/admission API. The producer pins this
new fixture adapter's source hash; imported implementations remain in the definition seal.
That is source identity, not a packaged renderer or OS isolation proof.

All **nine programs execute** across en/ru × blocked/partial/verified paths with actual
EvidenceView V2 / StructuredResult V2 objects. Nonblocked paths preserve 4103 into plain text;
in-memory retries return the same ref/bytes. **50 binding mutations** reject (extra ambient
arguments, resealed entry-source changes, wrong authority snapshot, schema-valid re-digested
zero values and altered disclosures). **Six authority cases** reject unsupported reader
version, unselected runtime ref, missing profile/manifest/projection shard and missing startup
objects. An already-admitted reader retains its frozen program copy after its input map is
cleared, while a fresh reader fails; this is memory-cache behavior, NOT restart/deletion policy.

Run `npm run astra:frozen-projection-reader:check -- --prepared <existing-package>`.
Current report with corrected native-reference authority:
`sha256:aa6472af14178279b07438880fa83d1bc996439f2b52164b24466c78c0b5f94c`.
Old extension regression still passes 12/258/56 rejection cases; renderer regression 46/46 PASS.
No full aggregate/Store proof, DB, new scratch root, network, model or Kernel call is needed.

**Boundary:** the authority catalog is trusted synthetic input, not a committed Store index.
Source certificates originate in the predecessor shape-witness corpus; their non-read
dependencies can still contain placeholder refs. The reader checks selected source/contract
bindings, not true completion membership or upstream claim correctness. This is a Node
reader/interpreter test; the preceding independent Python graph proof is not an independent
execution proof for this reader. The other 142 retargeted programs remain unexecuted here.
Next work must check their versioned conformance and build valid committed source membership
plus durable/restart settlement. Do not persist placeholder certificates as native evidence or
claim that production V2, Computer Use, source truth, or release readiness is fixed.

### Retargeted program conformance and native Completion ref correction — 2026-08-30

The predecessor's Completion interpreter uses a three-field lab ref with `schemaId`.
Twenty pinned `assert-ref-resolves-to` instructions also advertise `/schemaId`, while native
ImmutableContentRef V1/V2 uses `/contentSchemaId`. An actual native RuntimeFeatureSet ref
passed into the old interpreter reproducibly raises `KeyError('schemaId')`. This is a
confirmed dialect mismatch; the error is recorded as predecessor incompatibility, not a
successful rejection of malicious input or a valid native Completion execution.

Only the new, still-unadmitted projection cohort is corrected: all twenty instruction
operands use `/contentSchemaId`, its Profile V2 instruction schema rejects `/schemaId`, and
the ABI explicitly records the native reference contract and each correction's program/index.
This changes the candidate ABI, profile/schema-set, root refs and cohort identities above.
The frozen reader's pins were explicitly advanced after Node/Python cohort verification;
there is no fallback accepting both revisions. The old prepared package remains untouched.

`verify-astra-v3-retargeted-bindings.mjs` plus an independent Python probe reconstruct the
allowed transformations of **all 148 parent programs**, including instruction order, exact
version replacements, renamed IDs and only the twenty declared reference corrections.
Both before and after transformation, **all 114 event programs execute across 30 commit
shapes**, with 60 damaged payload/commit digests rejected on each side. These fixtures test
binding algebra and relational preservation; event payloads/owner objects are synthesized
from the binding constraints and are NOT native event-schema or retained-commit fixtures.
This closes representative-only algebra coverage, not real event/owner admission.

The strict native-reference adapter separately validates generation, kind/target, private
protocol-body classification, declared byte budget before object lookup, complete record
binding, byte length, frozen schema digest, native target schema, content identity and its
declared digest. **Seven real native-shaped target bodies in the synthetic authority graph**
pass. Eight negative cases reject wrong generation/type/object/schema/classification/length,
oversized declared bytes, and a changed declared digest even though that field is omitted
from content hashing. This proves reference validation, not committed source membership.

**Thirteen instruction cases lack positive native fixtures**, spanning nine schema IDs:
AuthorityScope V2, CompletionAssessmentBody V2, CompletionAssessmentInput V2,
CompletionCertificate V2, EvidenceGraphSnapshot V2, GoalContract V2, GoalSemanticBody V2,
Invocation V2 and RequirementAttemptSelection V2. They are explicitly reported as missing,
not skipped successes. Whole Completion programs (including wildcard cardinality, allocation,
retry and claim policy) and the 25 retained programs remain unexecuted by this probe.

Run `npm run astra:retargeted-bindings:check -- --prepared <existing-package>` (~7s with the
assessment counterexamples below). Earlier pre-counterexample report:
`sha256:b0dda95c33e24a9ded6dd91db492df5e73f63ae13613aee9a84c82279556cb5f`.
The corrected cohort also passes six native-schema negatives plus five independent resealed
mutations; frozen reader still executes all nine projection programs and rejects 50/6 cases.
No DB/new scratch root/model/network/Kernel/product writes are involved.

The next gate is strengthened by the first-candidate semantic failure below. Construct valid
native dependencies AND enforce deterministic source-to-assessment derivation before testing
complete Completion/retained programs under a Store-owned resolver/allocation snapshot.
Do not rebrand shape witnesses as native evidence, claim all 142 retargeted programs are fully
conformant, or jump to durability with semantically invalid source data. Product gates stay open.

### Completion first-candidate authority and value gap — 2026-08-30

`assert-assessment-authority-freeze` currently checks that four fields exist, not that their
values come from the frozen Goal/Admission. `assert-claim-selector-presentation-bijection`
checks identifiers/classification, but does not derive a claim's value, Invocation or evidence
binding from the selected source. Retry identity preserves an already chosen body; it cannot
prove that the first body was correct. This is an interpreter/semantic coverage gap, not a new
product exploit claim and not fixed by the preceding twenty native-ref operand corrections.

`probe-astra-v3-completion-authority-gap.py` executes all three current assessment programs.
22 first-candidate substitutions pass: four authority/context mutations for all three verdicts,
and five claim mutations for partial/verified, including a correctly rehashed TypedValue
changing `storage.logical-bytes` from `4103` to `0`. Each altered body and assessment input
passes native schema validation. The same 22 changes fail against the original retry bytes:
the probe distinguishes missing first-attempt semantics from working retry immutability.
Independent Node/Ajv also validates 34 baseline/source/counterexample bodies.

These are native-shaped boundary witnesses, NOT a fully valid evidence chain or admitted
completion. Request event is an endpoint fixture, other source dependencies are unresolved,
and claim values are not yet derived from evidence. In particular, this does not close the
13 missing reference cases in the separate original 85-object authority corpus.

An experimental, separately callable subcheck in `astra-v3-native-reference-lab.py` follows
input.goalContractRef -> Goal.admissionBindingRef and Goal.capabilityContractRef through the
strict native resolver. It binds Goal identity, policy/source copies, accepted context and
locale; presentation contract comes from CapabilityContract (AdmissionBinding has no such
field). Three positives pass; 12 authority substitutions and 21 source-binding mutations
are rejected. All ten claim-value/evidence substitutions deliberately remain reported as
accepted by this authority-only check. It is NOT integrated into frozen programs and is NOT
a public admission API, committed-input selector, full transitive verifier or Certifier.

Required correction before a complete native Completion gate:

1. Select the assessment input from the committed request/owner index in one frozen revision;
   caller-supplied refs, expected claims or current registry values cannot establish authority.
2. Resolve exact Goal and Admission refs and repeated digests, including source/policy/locale
   binding. A matching hash is necessary, not proof of committed membership or authorization.
3. Resolve the frozen Invocation, attempt selection and evidence graph to the exact receipt,
   capability output, claim templates and selectors. Check execution/goal/requirement IDs,
   revisions, cutoff membership, settled state, authority, freshness/clock and partial policy.
4. Derive each TypedValue from the pinned selector and validated source body, preserving exact
   type/encoding (decimal integers are not floating-point Numbers). Missing or wrong-shaped
   source yields a typed denial, never `0`, an empty collection or copied model text. Compute
   predicates, unresolved entries and final verdict; compare the entire proposed assessment
   with that independently derived result, not with another copy of the proposed assessment.
5. Only this admitted first result may seed retry snapshots and atomic certification. Cache
   decoded immutable source bodies within the frozen snapshot; do not re-read a receipt/output
   once per claim. A source revision change must fail the fence, not silently select new data.
6. Exercise the same resealed substitutions at the real native entrypoint. The counterexample
   is a pinned predecessor control, not an instruction to preserve broken behavior forever.
   Fail closed if resolver/semantic context is absent; no fallback to the old boolean-only op.

This is a correction to the candidate's executable semantics, not an extra presentation-only
filter. Frozen parent schemas/programs and the new cohort ABI remain unchanged in this pass;
integration/versioned authority and full evidence-derived fixtures remain required work.
The report before the claim-derivation extension had status
`event-conformance-with-open-assessment-semantics-gap`, digest
`sha256:26ddcc2f162ed4f8c4414b0e84d2a67effa17693c87b3e15e5ef8a60bff45ec3`.

### Native observed-claim derivation — 2026-08-30

`probe-astra-v3-claim-derivation.py` now consumes exact native refs selected by a synthetic
assessment input, rather than accepting proposed TypedValues. Its session resolves the
CapabilityContract, Invocation state, attempt selection, graph node, receipt, output,
VerificationRecipe and 28 separate ClaimTemplate bodies. It checks the consumed cross-object
IDs/revisions/refs/digests, settled/completed Invocation, receipt attempt/dispatch key,
canonical input identity, output/root/policy/schema links, projector identity, selector
allowlist and the recipe's exact template digest set. Recipe order is **digest-byte order**;
capability template order is independently **claim-ID order** (§9.4), not the same ordering.

The original authority cohort reused its first template witness in all 28 rows. That witness
graph is not reused as a semantic source: this lab creates 28 actual schema-specific template
bodies and a matching recipe/capability, without changing the original cohort or claiming
that its witnesses were already semantically valid. Consumed templates and source records
are native-schema validated and content-bound; remaining Goal/Admission/proof dependencies
are explicitly not promoted into validated evidence.

All 28 observed claim bindings are derived by their pinned source/schema/JSON pointer,
type/encoding and predicate. Each binding retains the selected Invocation/evidence/selector
identities. Comparison against a proposed binding array is exact, including order, values,
TypedValue digests and provenance. A missing pointer rejects; it cannot become `0` or an
empty collection. No candidate assessment, model text or caller-provided expected claim is
used as the value oracle. The input-ref still needs a future committed-owner selection gate.

Three synthetic source cases pass: ordinary `4103`, decimal `9007199254740993` (beyond safe JS
Number precision), and an incomplete/partial observation. Python and independent Node
selector/predicate/TypedValue derivation agree on all **84 bindings**; Node/Ajv validates
**111 source bodies**. 28 schema-valid, rehashed value substitutions, four provenance changes
and six rehashed source-state/binding changes reject. The missing-value primitive also rejects.
Partial observation retains only *observed* values here: this session does not grant a verified,
partial or blocked Completion verdict or emit a certificate.

Each case reads **37 distinct source bodies** with a snapshot-local cache; the ordinary case
accounts for **102205 canonical body bytes**. Output/evidence are decoded once, not once per
selector. These are logical body-read metrics, NOT process RSS, disk/latency benchmarks or
schema-metadata memory measurements. The experimental bound is 64 bodies / 8 MiB per session,
in addition to the resolver's 4 MiB per-body cap. Duplicate oracle transport bodies were
removed after the 1 MiB Python stdout cap was reached; that cap was not raised.

Remaining mandatory gates: compare with GoalSemanticBody's exact claims and Admission;
prove committed input/event membership, accounting-proof and dynamic completeness validity,
clock continuity/freshness and partial policy; derive final verdict/unresolved tuples; integrate
the combined authority/value checks into versioned frozen Completion semantics before its first
write. None is replaced by source-schema acceptance or by this observed-value derivation.
The old 22 assessment counterexamples remain reproducible against the unchanged interpreter.

Focused command remains `astra:retargeted-bindings:check -- --prepared <existing-package>`
(~8s); overall status remains `event-conformance-with-open-assessment-semantics-gap`.
Report `sha256:465b38f0e0740c430ced2fd0ceead709fde1b3ea77702edc6dce50c1f38fa36f`.
No product/shadow activation, native Store commit, real Kernel/model/network call or user-data
read occurs. These observations do not close the old authority corpus's 13 missing ref cases.

### Native accounting/clock relationship lab — 2026-08-30

`astra-v3-accounting-proof-lab.py` extends the observed-claim session with two additional
native-resolved bodies: the exact receipt-bound accounting proof and capability-bound budget.
It checks repeated output counters/accumulator, root/volume and policy bindings, implementation
hashes, attempt identity, operation/check arithmetic, iterator/frontier exhaustion, exclusion
counts, abort/resource relationships and dynamic limits before accepting completeness claims.
Continuous start/finish/assessment boot and monotonic origin, timestamp labels/calendar/order
and monotonic elapsed budget are checked separately from JSON Schema. A cancelled result with
`within-limits` cannot conceal an over-budget observation: shared checkpoints evaluate budget
before cancellation. The result remains an observation, never a Completion certificate.

`probe-astra-v3-accounting-proof.py` supplies bounded synthetic operation/check transcripts;
`verify-astra-v3-accounting-oracle.mjs` independently reconstructs their sums/maxima with BigInt,
validates native proof/budget/assessment-clock shapes and proof/budget body identities, and
compares derived completeness and elapsed duration. The previous simulator constant
`maxEntriesBetweenCancellationChecks=2` was wrong for these actual transcripts: their observed
maximum is `1`. The retained cadence limit remains `2`; a limit is not an observed value.
`maxDirectoryBatchBytes` intentionally bounds **all broker responses**, not only directory
enumeration, per §18; metadata responses remain part of this maximum. The tests pin that rule.

Three fixtures pass: `4103`, `9007199254740993`, and cancellation with a nonempty frontier.
Transcript lengths are 171/171/138 events under a 256-event cap. Python rejects 15 schema-valid
rehashed proof relation mutations, three malformed transcripts and six pure temporal mutations;
Node independently rejects 14 mutations and validates nine native bodies (proof/budget/clock
per case). A wall-label jump is not mistaken for monotonic elapsed compute time. Ten cheap
primitive Vitest tests cover exact wide sums, real cadence, response maximum and strict dates.
The complete focused runner retains the prior 84 claim comparisons, 22 known first-candidate
counterexamples, and 114 before/after event-program checks. Its report is
`sha256:14e1265b15156c0f3ae8bcc40c12457cb28f35d346e393685fa18d2d1eb8bc3b`, still
`event-conformance-with-open-assessment-semantics-gap`. Raw oracle cases are removed before
report emission (9370 compact JSON bytes); Python transport remains capped at 1 MiB.

Proof-bound sessions use 39 distinct body reads, 106015/106039/106025 canonical source bytes;
these are logical fixture metrics, not RSS, native broker overhead or storage benchmarks.
Synthetic records do not authenticate a broker, model handle identity/lifetime, observe actual
RSS or prove Kernel admission. The checker contains other incomplete branches, but those
branches have NOT been executed by this tranche. No first-candidate/frozen-ABI integration,
committed input/event membership, GoalSemantic claim satisfaction, admitted partial-policy or
final verdict has been established. Do not promote these fixtures into product evidence.
Next: close the Goal/Admission/semantic-claim and partial-policy path over the same derived
values, then version and test the integrated first-assessment gate, preserving old negatives.

### Goal semantic / partial-policy candidate and Certifier schema binding — 2026-08-30

The next source-bound session (`probe-astra-v3-goal-semantics.py`) now resolves the Goal,
GoalSemanticBody, GoalAdmissionBinding, CompletionCertifierContract, terminal policy and
PresentationContract on top of the proof-bound observed values. It checks exact Goal/source/
capability/input/policy bindings, the selected candidate, target/temporal/budget constraints,
and all 28 Goal claims against the exact native ClaimTemplate bodies. Whole normalized input
matching is explicit (`boundJsonPointers=['']`); no pointer-subset matcher is claimed.

The first run found a real generated-candidate defect: Certifier V2 retained legacy input and
assessment-body schema hashes. Ref retargeting and generic sibling-digest repair could not
detect these fields because they have no sibling ref. The cohort generator now maps those two
contract roles to the exact active schema bodies before retention; the independent Python
cohort verifier checks them and rejects both actual historical hashes after resealing. This is
not a harness-only replacement Certifier. Current non-retained cohort identity is
`sha256:5473c6337e04c906749f4c4f0508459f3a1038ecc3bebc352342bf59b19a3a12`; its previous
`db030a69...` identity remains historical evidence, not the current pin. Frozen reader's exact
candidate pin was updated and rechecked: 9 programs / 6 scenarios / 50 binding + 6 authority
mutations PASS, report `sha256:c952b36425fb117c8191ff8213979b510ffc423b602dc09f6ef751e2e38429a8`.
Parent prepared files, ABI/schema versions and durable authority were not rewritten.

The semantic lab derives three **local assessment candidates**, not retained assessments:

| Proof and bound policy | Local verdict | Bindings | Denials | Required presentation keys |
|---|---|---:|---:|---:|
| Complete observation, default forbid-partial | verified | 28 | 0 | 16 |
| Partial observation, explicit allow-disclosed | partial | 28 | 1 no-detail partial-evidence | 16 |
| Partial observation, default forbid-partial | blocked | 0 | 1 partial-not-admitted | 0 |

The forbidden-partial row never also emits the allowed-partial row. Blocked candidates expose
neither observed scalars nor presentation data keys. Partial/overall policies must equal their
GoalAdmissionBinding source even when observation happens to be complete; a coincidentally
successful read cannot validate widened authority. Native schema-valid, fully resealed source
mutations cover changed Goal predicate, requirement/overall partial policy, normalized input/
digest, target, selected candidate, budget and authority constraint (9 rejections).

Independent Node resolves/validates 62 deduplicated native source bodies, independently
derives 84 bindings and all three candidate shapes, and rejects 12 proposed-candidate changes.
Two cheap Vitest files (partial policy + accounting primitives) pass 20/20. Each semantic
session uses 45 source-body reads / 161068, 161132, 161078 canonical bytes; these are not RSS or
performance metrics. To avoid ENOBUFS, the runner uses two separately bounded Python payloads
from one already-built input bundle; each retains the 1 MiB cap, no repeated heavy preparation.
Raw source pools are stripped from final reports. Retargeted report:
`sha256:2c5e80df095a825c928847547680764b30b527ad3a54d35cdcb0570612d7888a`.

**Remaining hard boundary:** these records do not authenticate the accepted command, actual
Admission/matcher/minimum, authority intersection, real broker observations or committed
input/event membership. Schema witnesses for those unresolved dependencies remain witnesses.
The lab does not emit CompletionAssessmentBody, a certificate or a terminal event, and does
not implement the complete denial matrix for all infrastructure/evidence failures. The old
22 first-candidate counterexamples still exist in unchanged frozen Completion programs.
Next is upstream command/Admission/minimum and committed-selection closure, followed by
integrated first-assessment validation; no product/shadow activation follows from these rows.

### Capability dependency cohort prerequisite for Admission — 2026-08-30

Upstream Goal provenance work exposed a limitation in the old authority-shape witness:
28 capability template rows resolved to one body (27 ID mismatches), matcher input/output
schema digests were zero, and all three recipe schema digests plus its template digest list
were placeholders. These were NOT product execution findings. That witness could validate
reference shape, but could not support semantic Admission evidence.

The projection-cohort generator now materializes all 28 native template branches, binds
their source schemas, selector identities and presentation contract, and binds the three
static digest predicates to retained inclusion/exclusion/budget policies BEFORE execution.
Recipe schema identities and sorted template digest list are rebuilt; matcher input/output
schema identities, its own digest and TargetResolver binding are retargeted explicitly.
The claim laboratory also no longer obtains expected policy values from observed output.
No schema relaxation or generic global digest replacement was used.

The independent cohort checker follows RuntimeFeatureSet -> capability -> dependencies.
17 mutated dependency graphs remain native-valid after ref/content/length resealing and
are rejected for their exact semantic fault: matcher schemas/self-digest/target binding,
template alias/swap/schema/selector/presentation, all three static predicates, and recipe
schemas/template list. These are rooted dependency tests, NOT Store commit/replay tests.

Current cohort: `sha256:4a71ac9fc374a63c46f8e64b7a025926c65fbb63302dd668f59366d9fe0f37df`,
112 objects (85 historical + 27 distinct template bodies), 66 schemas, 5 shards.
Runtime root: `sha256:79dc8265a9428858d528a959b8b9b9690a427a9e1ee13e49355697f1cd518433`.
ABI/schema-set/profile/manifest identities remain unchanged; `5473c633...` is historical.
Checker report: `sha256:a739fca8891985317c9eab6e677f9f6bfb20b7970683f2df764d8755d95de1a9`.
Retargeted report: `sha256:2affc62ad2a6569dafdb6bfba7f5849993de8ee31ba2da8bed58f17ecd778071`;
reader report: `sha256:66ea7436c76de1d66bffc9056855e713da7d3088e9dc3f5a8816760fae2006a9`.
The 22 old first-assessment substitutions remain accepted by the old frozen programs.

Current definition seal: 112239 bytes,
`sha256:7ad7ceba26f49d50a13f03fd728b67676d28e3709225696578c9378949b9062e`;
envelope: 113264 bytes, `sha256:6f8eef36fc0492ae622679c86856b26a63a6b997a726ce64ff00747ccc66c41d`;
independent evidence: `sha256:f0833810ff9126e45f729d13255871adb24e068956aa2c971d9e8205c2c479e9`.
Inventory stays 65 config / 112 generator / 2 toolchain; Node19/Python17 seal negatives pass.
Existing prepared input was reused read-only, no DB/scratch generation or external calls.

Still open: implementation hashes are synthetic witnesses; no native matcher source-range
execution, AcceptedCommand/Admission/minimum chain, scope intersection, committed selection,
or first-assessment integration was proven. Local proof fixtures replace budget/capability
dependencies and still do NOT authenticate their upstream RuntimeFeatureSet. Do not infer
Admission readiness merely from this corrected base cohort. Next: exact command bytes and
native matcher result -> Admission/minimum -> narrowed authority under the same selected
capability root. Product/shadow activation and G1/G2/storage product fixes remain out of scope.

### Exact source provenance and required matcher semantic correction — 2026-08-30

Status: source subcheck implemented in the isolated lab; **semantic Admission NOT closed**.
The retained descriptor's legacy evaluator was exercised on native-valid AcceptedCommand V2
bodies. Five counterexamples now block using its decisions as authenticated intent:

| Counterexample | Actual legacy decision | Required property |
|---|---|---|
| Scan + `Не разрешаю частичный результат` | explicit-allow-disclosed | negative permission cannot grant partial acceptance |
| Scan + `Нет, не надо` | operational-capability | withdrawal/conflict must prevent automatic execution |
| Target named `D:\сейчас` | temporal-intent-ambiguous | path data must not supply temporal intent |
| Informational question + path containing `просканируй` | mixed-answer-execution | path data cannot create an action |
| Decomposed `и` + combining breve in target | target rewritten to NFC `й` | exact source spelling/bytes must survive |

These are current architecture-simulator defects, not claims that a product command ran.
Matcher descriptor digest: `sha256:d83f8b8395e4498b22a4eb7ebc7527e737c7486cc3912bc7150a33ed78cbac51`.
The underlying error is capability inference over normalized concatenated substrings,
without an instruction/data partition or polarity/scope ownership. Correct reference hashes
cannot repair this interpretation. Adding individual negative phrases is not closure.

Required next versioned matcher contract (design correction, not a generated/admitted V3 ABI):

1. Preserve one exact accepted payload and its UTF-8 source coordinate system. Bound raw
   bytes before normalization. Reject malformed Unicode and split-scalar ranges. A normalized
   lexical view may classify language but must not replace paths or generate source offsets.
2. Produce a bounded source token/region inventory BEFORE matching: directive text, paths,
   quoted/code/data regions, delimiters. Path/quoted data cannot emit action, temporal or
   permission facts. Unsupported quoting/path grammar yields an explicit unresolved target,
   never a guessed prefix or an ambient workspace fallback.
3. Evaluate finite grammar atoms within their original clause boundaries. No `join(' ')`
   may manufacture a multiword lexeme across clauses or erase a prohibition. Each action,
   target, temporal request and partial policy needs an unambiguous owning source span and
   association with the single selected operation, not an aggregate bag of word matches.
4. Positive partial permission requires a complete, unnegated, in-scope expression; negative,
   withdrawn or conflicting permission cannot be widened by another substring. Default is
   forbid. Cancellation and contradictory later clauses participate in whole-request reduction;
   they cannot disappear because they lack a capability keyword. Unsupported/ambiguous scope
   requires clarification and no dispatch, not a best-effort execution decision.
5. Keep the inexpensive deterministic fast path for supported ordinary requests. The bounded
   grammar must explicitly reject unsupported constructions rather than claim full natural-
   language understanding. If a model proposes intent, it remains untrusted until the same
   source-bound constraints or an exact new user confirmation authorize it. Do not disable
   answer-only chat or silently downgrade execution requests to purported successful answers.
6. Freeze a NEW descriptor/implementation/source-binding profile and atomically version every
   changed owner. Existing committed Admission/Goal history is never reinterpreted. Actual
   matcher result -> Admission/minimum closure may proceed only after the five counterexamples,
   paired legitimate positives, quoting/path cases, multi-clause conflicts, resource ceilings
   and negative permission matrix pass under that exact candidate. Keep this gate open until
   the executable semantics and native result projection exist; prose is not implementation.

Implemented source primitive: `astra-v3-source-spans.mjs` keeps original ranges and verifies
clause coverage/order/message ownership, candidate clause membership, exact whole path-token
membership and UTF-8 scalar boundaries. It deliberately does NOT resolve an OS path, authenticate
scope, or interpret consent. A token such as `D:\Synthetic\X:\inner` can be inventoried but is
not thereby an eligible Windows target. Empty/over-clause-limit behavior still belongs to the
future complete matcher; the native source-result fixtures are not its semantic output.

`verify-astra-v3-source-admission.mjs` reuses the existing prepared cohort and runs a separate
Python source checker: 5 native command/result fixtures, 12 schema-valid resealed substitutions
rejected, original byte counts 77/101/115/95/86. Cases include non-BMP prefix, NFD target, CRLF,
NBSP, FEFF versus U+0085 and nested drive substring. Python uses the frozen ECMAScript whitespace
set, not its broader `isspace()`. Report:
`sha256:1851103cc6a2fb3d455dcd20d2661dc144e4fbb740558a7e92604533a0a09f7b`.
Source + partial/accounting Vitest: 3 files / 36 tests PASS. The five semantic failures remain
explicit `unresolved: true`; no native matcher/Admission/Store commit/product activation occurred.
Source labels in result fixtures are intentionally synthetic; passing source ownership does
NOT validate their modality, temporal meaning, partial permission or actual user authorization.

Seal source: 7412 bytes, `sha256:d0820b19e80c5e3f186fec50fb4f5bc991d25de0096415c73282bd3f70560e25`.
Definition: 113238 bytes, `sha256:789f7801efbad22764cf67b02002c13f5a29cd31ce63394c94cce1571371ff23`;
envelope: 114263 bytes, `sha256:0f5e2e167438b3c12f7412fafc252e918f841ee27b0022d146b16af8624ab102`;
independent: `sha256:9b96dc4d9e681d63cca640d1f108ab876410bfe2a79d9606f8314d2e4da38e94`.
Inventory 65 config / 117 generator / 2 toolchain (4 new files plus newly reachable legacy
evaluator); Node19/Python17 seal negatives pass. No new DB/scratch files or external calls.

### Source-aware matcher executable candidate — 2026-08-30

The required intent correction now has an isolated executable candidate, not merely a prose
proposal: `astra-v3-source-aware-matcher.mjs`, ID
`workspace.storage.audit.source-aware-matcher.v3`, profile schema
`monarch.astra-v3-source-aware-matcher-profile.v1`. This is **not** a native retained
GoalMatcherDescriptor V3 or an admitted replacement for Descriptor V2.

The candidate tokenizes original UTF-8 spans before language matching, preserves exact path
spelling, treats quoted/code data as inert, and admits a quoted path only as a path operand.
Language-only NFC/lowercase feeds a bounded literal trie. Whole-clause atoms retain source
spans; no phrase is matched across clause boundaries. One explicit operation clause owns
the target and associated modifiers; ambiguous extra owners/targets, unknown clauses and
unsupported conditions clarify. A scan+measurement composition within one clause is supported.
An unattached path in another clause is not silently adopted as the target.

Partial policy is parsed from a complete verb+subject or subject+state expression with local
negation: negative allow becomes explicit-forbid, negated forbid/double negation is ambiguous,
allow+forbid conflicts clarify. Standalone withdrawal participates even without a capability
keyword; unrecognized cancellation/conditions become unknown clauses and prevent execution.
Path words cannot grant permission or change temporal intent. Informational clauses cannot
supply operational modifiers. Explicit accepted payload `answer-request`/`answer-only`
prevents an execution candidate even when the prose contains an imperative.

All five previous counterexamples are corrected **in this candidate**. The unchanged retained
Descriptor V2 evaluator still reproduces its five failures. The new grammar deliberately does
not claim full natural-language understanding; extending ordinary-language coverage remains
separate from weakening permission checks. Unparsed work requests clarify; unrelated chat
returns not-applicable. No source-only candidate may become a dispatch authorization.

Evidence: 58 curated cases including verbatim existing A11; 57 native-valid command bodies
plus one invalid-Unicode rejection before native acceptance. Outcomes: 20 execution candidates,
22 clarify, 10 blocked, 2 answer, 4 not-applicable. Additional 58 native path-data cases exercise
every grammar phrase in a path; 2 native answer-only metadata cases refuse escalation.
Vitest source-aware/source-span/partial/accounting: 4 files / 100 tests PASS, 2.16s, including
case/whitespace/NFD, negative permission and clause-split metamorphic controls. These authored
tests are not a new independent LLM audit or a proof over arbitrary natural language.

Report: `sha256:3a01fa9ea8542ca68cacf3e2b8ce26ed24d6370ac4921c6a55cb7171df96dcdb`.
Profile: `sha256:4121bb7a0c4da373d37a9af2fd1ed8968980db5f66fe280614d4c001824a4733`.
Matcher raw source: `sha256:36819824092552833e789f24b84b931cea2d4b466292c4055557ee3817dd8c86`.
Limits are 65536 input bytes, 8 clauses, 512 tokens, 4096 target bytes, 8192 trie steps;
the curated run observed max 23 trie steps and 512 materialized tokens, including bounded
rejections. These are algorithm counters, NOT RSS, production latency or model benchmarks.

Next gate is native versioning/projection: compute the complete changed schema-owner closure,
freeze the exact descriptor/implementation/profile, express the new source/data ownership and
denial cases, project native MatcherResult, then prove Admission/minimum authority narrowing.
Do not coerce `command-withdrawn`, `partial-policy-conflict`, new source regions or empty results
into V2 shapes or preserve old semantic IDs after changing their meaning. Legacy clause ranges
split punctuation without recognizing quotes; the new coordinate profile therefore cannot be
quietly substituted into the old source verifier. Whole old cohorts/history stay immutable.

Current seal source 7535 bytes /
`sha256:ef7438f6e994d941e5e5518f26c896659316f71e173312e99e208a2af2926135`;
definition114047 / `sha256:0f96a660a4289aa8c25e6fd8cad83babc8a8387b0acb1eb6957e321452629f4b`;
envelope115072 / `sha256:276f9cfd0590595927e468919a25d2130e95f19b164d83c0f140437d398d84d3`;
independent `sha256:4ae1ff5262af6720f869c09510b96214cdf94f2afe855ccb4cc584cba83700ad`.
Inventory65/121/2; Node19/Python17 seal negatives PASS. Existing prepared cohort reused;
no new DB, scratch tree, OS target reads, model/network calls or product/shadow changes.

### Native matcher descriptor/result projection tranche — 2026-08-30

The source-aware candidate now produces native-shaped Descriptor V3 / MatcherResult V3.
All 66 schema documents compile under strict Ajv. A fixed point computes seven changed
schema owners in two layers (4 direct, 3 transitive), without editing the frozen parent:

| Owner | Prior | Candidate |
|---|---|---|
| goal-matcher-descriptor | V2 | V3 |
| goal-matcher-result | V2 | V3 |
| interaction-intent-admission | V3 | V4 |
| agent-capability-contract | V3 | V4 |
| protocol-authority-profile | V2 | V3 |
| protocol-feature-schema-manifest | V3 | V4 |
| runtime-feature-set | V3 | V4 |

**This closes a schema-owner/projection tranche, not authority admission.** Authority ID-field
indexes and binding programs have not been regenerated; new profile/manifest/runtime bodies
have not been assembled. Their schemas remain provisional until those derived structures
match. Native command fixtures still carry the old parent context witness: no matching new
RuntimeFeatureSet/capability authority, Admission body, OS target or Store commit is claimed.

Result V3 retains per-fact source spans instead of a coarse clause-wide `negated` flag.
A scan and a refusal of partial results can coexist in one clause: the scan stays positive,
the policy is explicit-forbid. Source facts distinguish `literal-expression` from the
`clause-reduction` diagnostic for multiple operations; only the latter may cover a whole
clause containing inert path data. Literal facts cannot overlap path spans. The bound is
512 literal atoms plus at most one derived diagnostic per each of 8 clauses, not an unlimited
trace. Raw request/path text is not duplicated into the result; its owner remains the exact
AcceptedCommand, and the result stores ranges/fact bindings and domain-framed identities.

Input rejection (limits, malformed region/source) is a distinct `input-rejected` draft with
`sourceInspection: not-completed`, no fabricated clauses. Empty ordinary input can yield an
empty not-applicable result; explicit answer-only mode has a typed informational origin even
for empty content. New native clarification/block codes are versioned, not forced into V2.
Admission V4 candidate schemas share the same generated clause shape, without introducing
unsupported remote-fragment `$ref` syntax into the independent schema validator.

The descriptor binds exact input/output schemas, the full source-aware profile, and a raw
hash of a canonical source bundle containing matcher + native projector + strict canonical
JSON helper (36874 bytes). This is an inspectable source artifact, **not proof of an admitted
OS executable**, installed implementation or live Runtime registry selection.

Verification: 61 native result fixtures under Node and independent Python; 16 schema-valid
resealed mutations rejected. Exact projection is recomputed from the selected command and
descriptor. Python independently checks schemas/digests/source ownership, whole-token ends,
fact/path separation, partial policy from selected facts and aggregate reduction; it is NOT
an independent implementation of all Russian-language parsing. Old Descriptor/Result V2
schemas reject the new bodies. Tests cover A11, same-clause positive+negative policy, empty
answer-only input, resource rejection, and 512 literal atoms plus a derived diagnostic.
Maximum result in this corpus: 50394 canonical bytes (stress case, not RSS/latency evidence).

The independent pass exposed and prevented false green twice: the initial pure digest helper
omitted the `monarch-digest-v1\0` prefix, and shared JS range objects made one mutation alter
both compared fields. The prefix now has fixed-vector parity tests; projected ranges are
independent DTO values. A joint target/path-span truncation is also tested and rejected by
source-token validation. No validation was disabled to obtain a pass.

Report `sha256:47b2b451748d9ecaa447b3a465d21429478e88daaea56d4a5b41a07fa5d36b7c`;
schema set `sha256:a0b9183b99c68e632f764be8f5fe9e651fbcabb7412a65fd605e9762b56460f2`;
descriptor `sha256:4edf1fbc1036eeb55d2637d2014c53f8e0a0820cc5c37ca36d87d6e16bdd29ae`;
implementation `raw-sha256:6b3c6853e92938e63190b32a58333bc7e5a48da91f55c81542ec5f6360140bcf`.
Case input/result identity set `sha256:bd1335ad4015aeba86d4e5cd4646e13c7f7dbb7288a6aa74e8d0b965ad2155a2`;
A11 fixture bytes `sha256:9d3a834a06ea31879c2010a7ba60e579b7b6aad4419cfa3457ab7d2a8ad663c4`.
Focused Vitest: 5 files / 105 tests PASS, 2.70s. Native schema/projection runner also passed.

Seal source7731 / `sha256:14e4ccade4168868db6f0e4c058f1980f755edb8b4f0d0ccb114b8e8a40c5667`;
definition115450 / `sha256:7b4ac61292ba3dd9df91476ae6c8e88414cd140b6a30a9004de9a092bef14eb0`;
envelope116475 / `sha256:315e9282fe66b9a985309036b3c542885603c3af66d00af74617705932c44fd6`;
independent `sha256:13cf25bf3eb1328b6eb268737c3b0c63a7c7e6f9dfc5ab356512ba5d2ce95f00`.
Inventory65/127/2 includes five new code/test files and the newly explicit A11 input fixture;
Node19/Python17 seal negatives PASS. Existing prepared input only; no new DB/scratch tree,
target-file access, model/network/Kernel calls or product/shadow activation.

Next: regenerate exact authority field rules and matching binding programs for the seven-owner
closure, assemble a new coherent root cohort, then prove matcher -> sealed Admission/minimum
-> narrowed authority. Native-shaped refs or an old parent context cannot substitute for that
chain. Old G1/G2/storage product defects and first-assessment gap remain open.

### Native Admission source-binding prerequisite — 2026-08-30

Authority inspection found two concrete contradictions before a complete new root could be
built: Admission required a clause route even when source inspection rejected the input with
zero clauses; operational-unknown required a target binding even for target-missing/ambiguous.
The unadmitted V4 candidate now allows zero routes and forbids targetBinding on unknown.
This revises provisional candidate schemas, not retained historical schema bytes. Seven-owner
closure remains4+3; all66 schemas compile. Current schema-set:
`sha256:4795124e8ed01e7df0ff884c4e9f06213be847190f9f8a420b44b3a60d640aae`.

`astra-v3-native-admission-source.mjs` derives a total31-field copy/request partition against
the exact Result/Admission schema digests. Missing branches, new unowned fields, optional
copies, open objects and schema drift reject. Clause facts and their qualified owners are
copied exactly; targetSourceRange becomes only a resolver request, never target authority.
The pure gate recomputes MatcherResult from the original command and descriptor, binds
source IDs/digests, candidate ordinals/unique IDs, matcher contracts, and fact/partial-policy
copies. It preserves selectedCandidateIds as selection of answer/refusal candidates too,
not an execution-only list. No-clause inputs cannot fabricate routes; nonoperational inputs
cannot acquire execution routing. Target/capability eligibility downgrades are NOT covered.

Runner `verify-astra-v3-native-admission-source.mjs --prepared
.test-tmp/astra-v3-authority-root-store-proof-g0xKSt/prepared` builds the parent only once.
61 native-shaped Admission witnesses PASS Node/Python,23 native-valid resealed source
substitutions reject;7 definition mutations reject; unknown target injection rejects by schema.
Only interaction.submit was covered; follow-up lineage remains unproved. Python independently
checks native schemas/digests/source relationships, not the full natural-language parser.
Report `sha256:b5e5680653591ec6cabb9fd4e5f09bcf9d73741e752a41c2f4e6537629acb799`;
binding manifest `sha256:92071cfceb0d42c47d2371aad21ae613584e43f7ef60c85c738ccc8549f8f55d`;
Admission case set `sha256:e050648c463b4c3e84348ff822dfa1b3d42d75c84d86d99d910239eae4ed448f`;
mutation set `sha256:c2e3c2a7ed8456c60f276d6c958cc76df12fbe3b70bee93f0b96568f502ff55d`.
Native matcher regression61/16 remains PASS, report `7ef0b118...`; matcher descriptor,
implementation and accepted command/result digest set are unchanged. Focused6files/113tests
PASS1.14s; node --check PASS. No full Store/aggregate/build/typecheck was rerun.

**Evidence boundary actively tested:** four resealed substitutions still pass this SOURCE
gate in both languages: runtime-root digest, candidateSetDigest, capability-contract digest,
target-binding reference. They are recorded open controls, NOT accepted execution. Context
uses the parent runtime; target/capability refs remain witnesses. No Store membership, OS
scope/target admission, coherent new root, minimum or narrowed authority was established.
The parent still has3617 ID-rules (135 Admission rows), and zero retained-set programs directly
referencing Admission3. The31 copy/request rules are NOT replacements for those ID-rules or
an active ABI extension. Existing completion/projection program references do not close this gap.
Next: finish route/selection/candidate-set and eligibility downgrade contracts, regenerate exact
ID ownership and executable binding authority, assemble a coherent root cohort, then admit
sealed Admission/minimum/narrowed scope. Product/shadow activation remains forbidden.

Seal inventory65config/131generator/2toolchain; Node19/Python17 negatives PASS. Source7860 /
`sha256:7221e0727146a8fabf06c4dc0afe3fa7769f7b1e0d1cb765ed2ec1db33973e6a`;
definition116277 / `sha256:7fcd2fc2a34e05ef511d909eab57dd372bdcf43397f08e8d7dfb7a2aa927b66b`;
envelope117302 / `sha256:adbc88de8f71dda149a9af2dd59a16f13864723fa25f333078d4fc820cb6d221`;
independent `sha256:7098e8e82d97c12658e5017ce96e2c931f4d267c868ac160501bd9daf64784fd`.
Prepared parent remains read-only; no scratch/DB copies, target reads, model/network or Kernel
dispatch. G1/G2/storage failures and22 old first-assessment acceptance flaws remain open.

### Native Admission decision reduction — 2026-08-30

`astra-v3-native-admission-decision.mjs` closes the local deterministic decision projection,
not eligibility authentication. Inspection of the historical projection simulator exposed
three contract mismatches: candidate physical position was treated as matcher ordinal even
though §2.1 orders candidates by ID; its candidate-set digest omitted schemaVersion despite
the exact12-field omission table; rejected target resolution was counted as zero calls.
Historical fixtures/simulators remain unchanged, not silently rewritten to hide these gaps.

The new candidate uses ID-ascending candidates with an explicit ordinal bijection. Runtime
ref/digest must repeat acceptedContext exactly. Candidate-set DigestV1 includes exactly
schemaVersion, clauses, candidates, clauseRoutes, aggregateRoute, selectedCandidateIds and
cohortDecision; unknown added fields reject rather than silently escape the digest. Admission
V4's unadmitted blocked branch now also permits capability-unavailable/target-ineligible;
the pure matcher still cannot emit those Application-only outcomes. The source-only gate
remains strict-copy and does not itself accept a positive-to-blocked transformation.

**Route reduction:** every source clause gets one row, but only the unique operation anchor
can execute. Its bound modifier clauses are nonexecuting dependencies, not additional work.
Dependencies exclude the anchor and pure informational clauses; there is no self/cross cycle
in the single-operation profile. A refusal/clarification anchors at its first noninformational
source clause; an input-rejected result has no invented clause rows. Informational candidates
and answer rows survive denial of the operational part. Candidate selection includes answer/
refusal IDs too; aggregate/cohort/selection are recomputed, not supplied independently.

Eligibility input is explicitly a **synthetic fixture**, NOT a new retained/hidden eligibility
body or authority source. Unavailable capability requires target=not-attempted and no admitted
binding, producing capability-unavailable with0 simulated resolver calls. Available capability
requires exactly an admitted/ineligible target observation: both consume1 simulated call.
Ineligible becomes target-ineligible with no target/capability fields; admitted copies only
the selected witness bindings. Nonoperational input forbids eligibility observations/bindings.
Observations bind the exact MatcherResult digest and positive ordinal; extra approval flags,
missing observations and stale/foreign ownership reject. Actual resolver calls remain ZERO.

Prepared-only runner `verify-astra-v3-native-admission-decision.mjs` passed106 native-shaped
cases, including all61 baseline source cases, both denial branches for every positive, and
three reverse-ID-allocation cases. Node/Python independently reject24 native-valid rehashed
substitutions: duplicate execution rows, dropped/foreign/self dependencies, selection/order,
lost informational route, wrong denial/aggregate/cohort, stale eligibility, runtime-context
substitutions and old six-field digest.44 simulated resolver calls agree; no real resolver.
At first the added runtime-context mutation survived Python (the new check was absent there);
that omission was corrected and the full focused runner repeated successfully. No failure
was recategorized as success. Focused7files/129tests PASS1.33s; node --check PASS.

Report `sha256:185340dbe7b4d0e74fe00726fc065117d07b6bff44dfc8df4f245c208eaac1b5`;
schema-set `sha256:2554e54ffebf5309012f3e1edc159d669565dea86cc918f0d696a061baae6f1e`;
case set `sha256:df955cfa00742b523843d77b9d2add1896909041a3f0f75cbbbea8a47827a955`;
mutations `sha256:8dca98717d6a0d03b07788b425a40c9f91a26d3c2ac5331e0db06adace9d8fc1`.
Source regression61/23: `8234f8c6...`; nested matcher61/16: `0bafd703...`.
Two deliberate controls still pass when both synthetic input and output substitute a capability
digest or target ref. This proves the remaining boundary: exact projection is not authenticity
of its selected inputs. Parent runtime/cohort remains `4a71ac9f...`, not a new native root.
No full ID-rule/active-ABI regeneration, new coherent root, follow-up lineage, minimum/narrowed
authority, OS admission, Store commit, product/shadow activation or release evidence is claimed.
Next: replace these witness assumptions with exact frozen root/capability/target evidence and
regenerate ID ownership plus executable binding authority as one coherent candidate cohort.

Seal source7993 / `sha256:0c977e9d94e370146b0e2a3b9d49d0124e3db325556f268aa33bfc1a75f277e0`;
definition117113 / `sha256:8e108b772a64bff91eb25ecefba527174099dfce09e51b6990cd55502dfd974e`;
envelope118138 / `sha256:abe15d23c01ab0fd2b6d50cf708e3993b66ae66cc551bcbc1b1a8e25da3fa06f`;
independent `sha256:9b208caed6933d611c2bc4f040694e817b7d29e0936d01e485425c73d3a753e7`.
Inventory65/135/2; Node19/Python17 seal negatives PASS. Reused exact prepared parent read-only,
one cohort build per runner; no DB/scratch copies, user/Safe/model/target/network access or
Kernel dispatch. Full Store/aggregate/build/typecheck not rerun. G1/G2/storage and22 historical
first-assessment flaws remain open; local decision verification does not repair V2 product code.

### Native component reference integrity — 2026-08-30

**Scope:** isolated frozen component selection, NOT a new runtime-root/cohort or permission
to dispatch. Hash-correct copies alone do not bind capability policies, schema descriptors,
claim templates or target volume identity to their intended roles. The native schemas allow
generic ImmutableContentRefV2 fields; the application must enforce these role relationships.

`astra-v3-native-reference-bindings.mjs` derives a closed manifest from six actual schema
owners: RuntimeFeatureSet4, Capability4, Admission4, CanonicalWindowsPath2, AuthorityScope2
and AcceptedCommandContext2. There are30 reference occurrences/25 distinct role paths.
Unknown roles and missing expected roles reject; schema references with sibling constraints,
conditional/dynamic positions and array/combinator branches cannot silently hide a new ref.
The table is specific to this workspace-storage-audit candidate, NOT every future capability.
Static role coverage is not executable verification of every runtime/scope/Admission field.

The executable component check captures copied schemas, identity rules, records and synthetic
selected anchors. It resolves40 records (94399 canonical body bytes): one native Capability4,
three JSON schemas, five policy/presentation/transport/budget records,28 claim templates,
one recipe, one synthetic path and one synthetic volume identity. Exact role/type/schema,
generation/object ID, classification/purpose, canonical length/schema/content digest and
body identity are checked. Descriptor input/output hashes and targetResolver link, template
ID/inventory/recipe digests, target identity and volume digest must agree. Caller mutation
after selection cannot change the session; returned bodies are copies. Read cap128,
individual body cap4MiB; no target filesystem resolution occurs.

`verify-astra-v3-native-reference-bindings.mjs --prepared
.test-tmp/astra-v3-authority-root-store-proof-g0xKSt/prepared` builds once in memory.
Independent Python reconstructs the record deltas and checks the same bindings separately.
12 negatives agree: capability/target co-substitution against frozen anchors, generation,
missing object, byte length, exclusion/inclusion swap, input/output-schema swap, matcher
descriptor link, claim-template alias, recipe kind swap, volume kind swap and resealed
target-identity substitution. Altered component bodies pass actual native Ajv validation
before semantic rejection. This does not claim a full native Admission or general-purpose
independent JSON Schema implementation.147 Vitest tests/8files PASS1.56s, including18 new
small unit tests; prepared integration supplies the actual native schema evidence.

The first independent-probe attempt hit its4MiB input cap, correctly failing the run.
The harness was corrected to retain only40 reachable component records and send mutation
deltas, not repeated parent authority shards; final input1424691bytes, cap unchanged.
No materialized DB/scratch copies, user/Safe/model/network reads or Kernel dispatch.

Report `sha256:41bf2e9c9b9910cd7112f4003b2db381e099fe68d2a7449cb7a6cd3a3354e1e9`;
role manifest `sha256:829baef99d773a84b506f2681f697a21fac4c46f2f3bf51f4c7b737e21e269aa`;
mutations `sha256:8b4ce1f7c94468007be91158a71f25b6e060730c8d96eaea7e721456bc207751`.
Native schema-set remains `2554e54f...`; parent cohort remains `4a71ac9f...`.
New synthetic Capability4 body `d6ab5f44...`, path body `9b72c39f...` are not retained roots.

**Still open:** selecting anchors from a validated runtime-root/index, actual OS target
provenance and scope inclusion, Store membership, full ID ownership/active ABI regeneration,
new runtime/manifest/cohort, integration into native decision/Admission and follow-up lineage.
The previous decision-only gate still accepts its two co-mutated fixture controls; this
separate checker rejects substitutions only relative to its captured component selection.
Changing the trusted synthetic selection itself remains outside this proof. Do not mark
the old22 first-assessment flaws or real V2 G1/G2/storage gaps fixed. Product/shadow off.

Seal source8126 / `sha256:8b241fd637b5e6c483de5555f636012d09bbc7126705e4874b4fd46d66b13c04`;
definition117949 / `sha256:f33659421f6aeb0d0e40217baf97107326633375effa5355b64dc928155f2bb8`;
envelope118974 / `sha256:3927ef2a61d02c3b9d17adb4cc9cbce1e4b881ebc504816dc3f6bef0d05fb44e`;
independent `sha256:39895f7b610d218b27d55e83af0f06bf2f498538e59704677be46243690b9ee6`.
Inventory65config/139generator/2toolchain; Node19/Python17 seal negatives PASS. Heavy
Store/aggregate/build/typecheck and completed G2 capture were not repeated.

### Joined native Admission + component path — 2026-08-30

The isolated `createFrozenNativeAdmissionLab` now composes native schema validation,
source/decision verification, exact source-record resolution and component integrity.
It snapshots the host-selected command/result/eligibility witness/ID allocation. The
selection API remains synthetic and is NOT an untrusted-input admission entrypoint.
Caller mutation after capture cannot retarget it. A failed component/reference check throws;
it is not converted into a successful denial, empty result or V2 fallback.

Accepted-command, matcher-result and descriptor refs now resolve real native objects in the
in-memory graph, not serialization-only witnesses. Resolved bodies must equal the captured
command/result/descriptor exactly. Candidate/source digests alone were insufficient: a
different well-formed source record could previously coexist with a correct repeated digest.
Positive candidates pass the40-record component gate; nonexecuting branches do not resolve
target components. Source batch3 + positive component batch40 =43 reads maximum per case;
nonexecuting cases use3. Each batch and combined count are bounded at128. This is read
accounting in memory, not OS access, a request budget proof or concurrent runtime scheduling.

Prepared runner `verify-astra-v3-native-admission-components.mjs` reuses one parent build and
all106 native decision scenarios:22 positive-component/84 nonexecuting cases.163 records,
1198 total logical reads/2947821 canonical bytes across the suite.44 simulated resolver
attempts (including ineligible outcomes),0actual resolver/Kernel calls. Node and independent
Python agree. Independent input2496479bytes within unchanged4MiB cap; it references shared
command/result records instead of repeating their bodies in every case/mutation.

14 native-valid resealed Admission negatives reject.11 deliberately still pass the old
decision-only gate: capability and target input/output co-substitutions, missing/different
command record, different result record, wrong source length/generation, descriptor role
swap, eligibility downgrade/escalation and ID-allocation co-substitution. Remaining3 confirm
partial-policy rewrite, extra execution route and runtime/context mismatch rejection.
The old gate was not weakened to manufacture a joined PASS.158 Vitest tests/9files PASS1.75s,
including10 composition unit tests and1 explicit reference-batch test; native106/14 evidence
comes from the real prepared runner, not mocks. No full Store/aggregate/build/typecheck rerun.

**Concrete surviving target gap:** the same synthetic target D:\Synthetic is accepted for
five differing requested source paths: `quoted-spaces-path:admitted`, `inline-path:admitted`,
`decomposed-path:admitted`, `path-time-word:admitted`, `A11:admitted`. Both implementations
report these as `knownUnboundTargetRequests`; they are NOT execution authorizations. Matching
display text alone would not prove canonical Windows identity either (aliases/reparse/handle
freshness remain separate). Next bind the exact source request/command/result/ordinal to a
frozen resolver outcome, preserving raw Unicode bytes; do not hide the gap by excluding these
cases or calling a synthetic identity an OS observation. Root/scope/Store admission remains
required after that. Source references are component-consistent, not committed membership.

Report `sha256:6340e81877a3b79cabccdd23ea38c31659a4e8edbb2b15b26ed62d8f9c127c9b`;
cases `sha256:3ae86071155d7a6f36344e7f33671dd5b017367639517002cb1e6ae366cefdc3`;
mutations `sha256:a6b3ce1a92b5ee6607813f739a0fff4537331de8d7be29644f01b3edfa202404`.
Native schema-set `2554e54f...` and parent cohort `4a71ac9f...` unchanged. Full native
runtime-root/manifest/cohort, authority ID rules/active ABI, follow-up lineage and real V2
G1/G2/storage/22 first-assessment gaps remain open; no product/shadow runtime activation.

Seal source8263 / `sha256:5b7c3a677d19c635be5b0c59b5464e54de69bb734351a856ee4baec60af9bd1b`;
definition118792 / `sha256:bfe7bf52ab1db6349249acbfc84f05152489fe0ef809e50231760d57e83bcca3`;
envelope119817 / `sha256:fe8c7d60edbf16683b1e829b9a508adaf63625f841848148497487dfb64fecd4`;
independent `sha256:c4845d9d29e7daf6cb970b69daa11c8cf446d43ef70203762dbb3101458212ce`.
Inventory65/143/2; Node19/Python17 seal negatives PASS. Exact prepared parent read-only;
no DB/scratch copies, user/Safe/model/target/network reads or deletion. Completed G2 not rerun.

### Exact source request → synthetic resolver outcome — 2026-08-30

`astra-v3-target-request-binding.mjs` adds a bounded resolver port with an immutable synthetic
namespace, plus a request-bound Admission wrapper. This is NOT a Windows resolver or a new
native retained protocol object. Request/receipt names explicitly end in `fixture.v1`.

Request identity covers accepted-command/context digests, source message, matcher result and
descriptor digests, candidate ordinal, operation clause, exact UTF8 range, raw path digest/
length, capability ref, resolver descriptor digest and host-selected attempt ID. The native
matcher/source result is recomputed before extracting the path. Bounds:64 namespace keys,
65536 source bytes,4096 target bytes; no NFC, lowercasing or path normalization. The port
checks that its actual raw argument matches the request's digest/length. A result from another
request/attempt cannot be accepted merely by recalculating its own digest.

The captured port derives admitted/ineligible from an exact namespace lookup, not from the
Admission's proposed target. Receipt binds request digest/attempt/status/provenance/target
binding. Admission input must repeat this independently selected result; then the existing
native source/decision/component checks run against its selected target ref. Receipt mismatch
rejects before component resolution. Missing eligibility rejects before resolver invocation;
unavailable capability and nonoperational source invoke it0times. Ineligible lookup consumes
1 attempt. Verification replay reuses the captured outcome, not another namespace lookup.

Synthetic namespace keys may explicitly alias one identity. Equal displayPath is neither
required nor sufficient as Windows identity evidence. NFC/NFD and case variants remain distinct
unless the test namespace explicitly maps them. Namespace/captured outcome/snapshot copies
prevent subsequent caller mutation. The namespace itself is still a trusted fixture assumption:
changing the selected namespace before capture is NOT prevented by this integrity proof.

Prepared suite106 cases/17 native-valid Admission negatives PASS independently Node/Python.
All5 old controls (quoted-spaces-path, inline-path, decomposed-path, path-time-word, A11,
each `:admitted`) still pass the historical joined gate but now fail `target-outcome-binding`.
They remain in the corpus. Other negatives exercise resealed request/attempt/status/identity
receipt swaps, extra fields, missing/unrequested receipts and eligibility co-substitution.
Receipt digest-corruption intentionally is not resealed; receipt fixtures are NOT claimed
native-schema objects. Six synthetic namespace entries/168 memory records,1198 logical reads,
44 simulated attempts/0actual resolver or Kernel calls. Independent payload2646485bytes <4MiB.
174 Vitest tests/10files PASS1.91s (16new). Alias/Unicode/no-call evidence includes focused
unit cases with real source matching; native106/17 evidence comes from the prepared harness.
Historical joined106/14 regression still has identical report `6340e818...` and5 open controls
at that older gate; it was not weakened or relabelled. No full Store/aggregate/build rerun.

Report `sha256:d2b8bfb90fe3ad3973123ab2f20219ac6ffc564ff4c7eb6e19845bc68b302ee0`;
cases `sha256:7edec1a187f5e91c8c9b1d72392098ba293eb43a77d954ad43f76b29c4ebdad2`;
mutations `sha256:c742b47d6ec1f2fc78ebb818cb44fe7d2e5403c3f613a78fe69338d59ed6e78f`.

**Next architectural boundary:** move the request/outcome relationship from fixture-only
capture into native schema/identity/retention occurrences and executable authority bindings,
within a coherent runtime-root/index/ABI candidate. Prove replay from persisted evidence, not
the closure that originally selected the outcome. Actual Windows handles/reparse/freshness,
scope membership, live capability availability, Store membership and cross-restart admission
remain unproven. Root/manifest/full ID-rule/ABI regeneration and follow-up lineage remain
open; product/shadow off; real V2 G1/G2/storage/22 first-assessment flaws are not repaired here.

Seal source8390 / `sha256:e4e9ab1fb537cfb126c8cfa5e7f6d40e3b82ebcf704d371c9303f825b1244200`;
definition119614 / `sha256:13d9f99f9545977639aee50fb364a2dc2474038c29093c0db2a4b256ab8dcd49`;
envelope120639 / `sha256:0610c5a5640e89a2582c03e73056cb7ae20773d21e7353e769bb39b8b62a6335`;
independent `sha256:655bd1c4c7ffa0d448158506f59a854301ce786814a6ab7b55b1264f3f9563ac`.
65config/147generator/2toolchain; Node19/Python17 seal negatives PASS. Exact prepared parent
reused; no DB/scratch copies, user/Safe/model/target/network reads or deletion; G2 not repeated.

### Native target-resolution ownership and cold SQLite read — 2026-08-30

Protocol §9.1 already forbids post-commit recognition/resealing. The previous in-memory
helpers recomputed matching, so reusing their capture path for recovery would violate that
boundary. Initial admission and cold replay are now explicitly separate candidates.

Native Admission5 embeds targetResolution instead of introducing sidecar authority. Request
identity includes immutable source/runtime refs and a scoped numeric attempt ordinal; the
old fixture attempt string is not promoted into a fictitious native opaque-ID class. Exact
range/raw-byte digest and resolver descriptor are preserved; the closed admitted/ineligible
outcome is covered by Admission body and the new eight-field candidate-set digest. The
schema fixed point versions Admission4→5, AuthorityProfile3→4, Manifest4→5, Runtime4→5;
all66 schemas compile. Existing source schemas/bodies and historical fixtures are unchanged.
Full ID-field/ref-role occurrence lowering and executable ABI/root instances remain pending.

Writer and cold reader are separate Python processes. One marked child under resolved D:
.test-tmp receives metadata,274 immutable test records and106 independently indexed fixture
scenarios in SQLite. These scenarios share fixture IDs and are NOT106 admissions in one
production Interaction journal. Rollback after inserting metadata/objects but before index
publication leaves0 rows; one transaction then commits all three tables. Writer closes;
reader reopens read-only/query_only, checks SQLite integrity, bounded row/byte inventory and
an external controller-pinned checkpoint. No current namespace or original closure is sent
to the reader. Recognizer entrypoints are trapped; only structured decision projection is
reused. Bounded source-byte slicing validates offsets/digests without re-recognizing intent.

Cold106 cases/8 native-schema-valid resealed negatives PASS: missing/unrequested resolution,
request/raw-byte/resolver digest substitutions, mismatched target outcome, selected-ID drop
and runtime/context mismatch.512 logical object resolutions across106 cases; recognition0,
resolver0. A deliberately co-mutated target/outcome still passes structural semantics but
changes the externally selected checkpoint: it cannot replace the committed snapshot. This
is the actual trust boundary, not proof of OS provenance from self-consistent hashes.
187 Vitest tests/11files PASS2.15s (13new). Warm request/outcome106/17 regression retains
report `d2b8bfb9...`. Final cold read rerun reused the same DB after path-preflight tightening.

Report `sha256:903caf444968855761f9c0f47f41373b91b2de8e332edbb43c13959395fa4eb9`;
native schema set `sha256:6321988704b54d23f42e344f060be5798709048a7e1e27e7408e2c421675f059`;
external checkpoint `sha256:0d12c9cf66c33b4b5d5f3c0364dbe06e560591a81ee79c78cebe71bf987fa85d`.
Prepared payload2444254bytes; DB2785280bytes (~2.66MiB), kept for cheap read-only reuse:
`D:\Monarch-test-tmp-astra-v3\astra-v3-native-target-replay-5HFxLG\admission.sqlite`.
Read-only command: `python -B scripts/architecture/probe-astra-v3-native-target-replay.py read`
followed by that exact DB path and checkpoint above. Do NOT rerun the writer to inspect it.
Both Node and Python check exact resolved D: parent/marked child; no target/user/Safe/model/
network reads. No large copies/builds or manual deletion; SQLite owns its temporary journal.

**Still unproven:** actual native CommitGroup/event/index adjacency, runtime-root membership,
full ID-rule/ABI/cohort regeneration, historical executable identity, live feature/scope/OS
handle freshness, pending/indeterminate target recovery, attempt monotonicity and follow-up
lineage. SQLite transaction rollback is not process-crash, power-loss or torn-write proof.
An unknown resolver outcome must not be relabelled ineligible. Next lower the complete
Admission5/new-owner ID/ref-role delta and state-commit selection bindings into one coherent
candidate; do not treat the controller checkpoint or schema compilation as runtime admission.
Product/shadow remains off; V2 G1/G2/storage/22 first-assessment flaws remain unfixed.

Seal source8516 / `sha256:a1a338f88e04f4ec1e558bc0927f1a321993045db41b47622017a6ccf572460d`;
definition120436 / `sha256:3a3404dfcc443c0da86f77d308c7d17dd6d31822225efa57f60682031da0cf5b`;
envelope121461 / `sha256:19df468b74fdfde321bf44d270fc194535ddf78730f7348b9b8fa819f027c823`;
independent `sha256:537d98ef7b849050bf9f20892d6ef21ed7619acc87a2528b35e695f0d05b8156`.
65config/151generator/2toolchain; Node19/Python17 seal negatives PASS. Existing prepared
parent read-only, no legacy full materialization/Store aggregate/typecheck/build or G2 repeat.

### 2026-08-30: Admission5 ID identity transfer candidate — semantics explicitly open

`verify-astra-v3-native-id-authority.mjs` requires explicit `--prepared`, `--db`, `--checkpoint`.
Reuse exactly the prepared directory and retained DB/checkpoint in the previous entry.
The old parent shard is additionally pinned by raw hash547f11c3...; no new writer/materializer.
The cold probe now exports only metadata after full read-only checkpoint verification.

The pure `astra-v3-native-id-authority.mjs` and independent Python probe enumerate169
Admission5 ID endpoints:135 old =125 surviving +10 removed, with44 added. The removed old
operational-unknown targetBinding surface is not kept. Five candidate ID owners replace the
old three-owner selectedCandidateIds sets. All3617 parent rule IDs pass original allocation
validation; transfer changes3562 rule IDs across13 schema owners, retaining117 external
rules. Output3651 rules, payload2074421bytes; no installed/persisted authority shard. Other
schema-owner endpoint surfaces and semantic profiles have NOT been reconciled by this pass.
Unknown ID endpoints, unsupported schema applicators/type unions, open objects/arrays,
unowned tuple positions, collisions, dangling references and cycles fail closed.

**Found, not hidden:** eight clause-reference endpoints inherit an ordinal-derived template
that is not a valid membership contract. The candidate returns them as unresolved obligations
and must not be installed. Independent analysis of106 retained bodies checks436 real clause
references against their owning clauses;87 valid references differ from containing-array
ordinal. For example ordinary-scan has two source facts referring to clause.0.v1: the second
fact is NOT a reference to clause.1.v1. Protocol specifies the next owner-local member and
fact/operation binding contract; no semantic profile or state-commit program was activated.

Evidence:211 focused tests/12files PASS2.21s (24new); Python exact-rule comparison +8 mutation
controls PASS; readonly cold106/8 regression PASS,0recognition/0resolver. Transfer rule digest
`sha256:7fb4a5b616b8ca571333c88d2e686bc45c37c69b367211419ea724b261d5f603`;
report `sha256:b9a35fb9e455c5141faf2813250b587c1d20d44c60a8b8bb10bd776a0460f2aa`.
This is identity/shape evidence, NOT semantic/full ABI/root/CommitGroup admission. Full
aggregate/build not run; product/shadow/V2 repairs remain off. No DB duplication or network.

Seal source8637 / `sha256:731e0cb7203e3df7ff2e82dfa604dc21f142f5bd227abafc5f3dfcc2e8a51fb6`;
definition121248 / `sha256:d4bee9867e531827db03a7048c3b853fadcb0e1b71258549a821e9df97c41357`;
envelope122273 / `sha256:b0150e494553916e8e5227e8390d63d8d88db7414079a2d520105e45210dd28e`;
independent `sha256:a66c5b80e9167c5890b0fc2cfa5bad6162694a8203f73128eeca3e8484db4aa7`.
65config/155generator/2toolchain;19Node/17Python seal negatives PASS. Prepared parent inventory
3617/148/1620 remains unchanged and is not the newer3651-rule identity draft.

Next: lower the explicit owner-local clause-member semantics before declaring the ID shard
usable, then complete native ref-role/state-commit adjacency and coherent ABI/root/index.
G1 predecessor, G2 missing output schema, storage audit unwrap/counter loss and old22 controls
remain separate product gaps; this pass does not claim to fix them.

### 2026-08-30: owner-local clause-member semantics for the eight Admission5 endpoints

`astra-v3-clause-membership.mjs` adds a separate versioned member profile instead of changing
`semantic-id.clause-ordinal.v1`. Only the exact eight obligations are lowered; unknown/preexisting
extension classifications reject. The profile's complete body is pinned as required root
semanticProfileExtensions in AuthorityProfile5. Native version closure changes3 owners:
AuthorityProfile4→5, FeatureSchemaManifest5→6, RuntimeFeatureSet5→6; inventory remains66.
Both native ID-rule variants support the new closed classification; eight new rules validate
under V5 and all eight reject under V4. Original schemas/profile/parent rules remain unchanged.

Typed validation binds Admission5 to its selected immutable MatcherResult3 and command/context
digests, checks clause allocation and owner-local membership, selected draft clause sets,
operation owner and exact sourceFactBindings, and ordered route/dependency/selection bindings.
One operation-owning clause may contain scan+measure facts; a naive one-verb check was rejected
after the real compound-scan-measure fixture exposed that incorrect assumption. No recognizer
or resolver is called. Eligibility/target admission remains the separate captured-outcome gate.

Evidence:240focused tests/13files PASS2.34s (29new);106 retained scenarios,679 logical member
checks including repeated draft checks,212 selected immutable Admission/Result reads. Node and
independent Python reject16 native-valid resealed mutations: absent/foreign clauses, fact index,
fact omission/reorder, route omission/reorder, wrong dependency/selection, wrong result, wrong
operation owner, co-mutated source-fact omission, unsafe facts/unparsed input and bad allocation.
Semantic copy with another Admission ID is valid in isolation, but both actual selected-ref
readers reject substitution under the original ref. No claim that semantics alone proves Store
membership. Prior cold106/8 regression remains green with0recognition/0resolver.

Profile `sha256:480d7f6e9156a6dafd9d48d8050fac4c80ef9f80a8593f1c02ebf54479aa6f64`;
schema set `sha256:844a1071b83885faf0c3c28064b35b3f5cd51c043d164d1717a10ce52794e8eb`;
eight-rule digest `sha256:6a47803a76f88d88f146009d22d08981414d8549693048a0e3a6e1a9c85c28ae`;
report `sha256:35cca510009affb667739862883f8ba28f8781baad533f3f9f6246128fab202c`.
Run `node scripts/architecture/verify-astra-v3-clause-membership.mjs` with the exact --prepared,
--db and --checkpoint from the preceding ID-transfer entry. Existing2.66MiB D: DB reused without
writes/copies; independent probe input462810bytes. Export-snapshot uses separately bounded JSON
documents inside the4MiB aggregate cap, then verifies the original whole checkpoint. The native
parser's50000-member ceiling is NOT raised; raw/user/Safe/model/target/network reads remain off.

Seal source8754 / `sha256:b2a1fef4a066787d3b70be3efa23365da8b36899df8605973680941f79e4b92b`;
definition122053 / `sha256:0cf3bae3dfd35455a27c7266832d98f399ecb1338819fe3fac6126dee1123f6a`;
envelope123078 / `sha256:9b8f6e82303c9dc843ae418c47510e7722f3df325842bba77e1a34e4e49b0bd3`;
independent `sha256:cc991d9c9e203fad4ae521d2aad2708b3b3d9078c1a19d13198718723ae9185b`.
65config/159generator/2toolchain;19Node/17Python seal negatives PASS. Prepared parent unchanged.

Remaining integration is explicit: complete new-owner ID occurrence/ref-role reconciliation
(including the root's new extension fields), finite semantic member-check program lowering,
selection/adjacency bindings and one coherent native ABI/root/index candidate. Eight local
semantic checks are not permission to install a partial authority shard. Live root/scope/OS,
pending target recovery, G1/G2/storage/old22 product defects and product/shadow acceptance are
still open. No full aggregate/build, model inference, release or production persistence change.

### 2026-08-30 — Initial admission member checks inside an isolated commit gate

The prior member verifier now exposes a read-only fixture loader; its original report remains
`35cca510...`. New `astra-v3-admission-commit-gate.mjs`, its Node runner and independent Python
probe test acceptance through one captured Admission5/MatcherResult3 selection. The seven-stage
plan is explicitly pre-lowering: it is not an installed native reducer, semantic opcode or full
authority cohort. Event/commit digest correctness alone is insufficient to admit lost facts.

263 focused tests/14files PASS2.74s (23 new unit tests with explicitly limited schema shims).
Actual native schemas and checkpoint-bound bodies are covered by the separate Node/Python
106-case replay:106 exact retries perform no repeated member verification;13 native-valid
resealed event/selection mutations reject. An additionally resealed native-valid Admission with
a missing source fact rejects inside apply. Injected pre-publication failure leaves no event,
then a retry validates anew; conflicting committed retry rejects. Unit tests also cover captured
input isolation, candidate-set recomputation, foreign generation and malformed/digest errors.
Both implementations also reject two JSON-type substitutions in retry/plan selection: Python
previously conflated true/1 under ordinary object equality; canonical JSON byte comparison fixes
that probe defect. These two controls are not counted as native-valid event mutations.
The old member106/16 and cold106/8 regressions pass. No recognition, target resolver or dispatch.

Use `node scripts/architecture/verify-astra-v3-admission-commit-gate.mjs` with the same explicit
--prepared/--db/--checkpoint as the preceding member entry. Input382574bytes; the existing D: DB
is reused read-only. Python captures the274-record bundle once per variant, not per journal.
Report `sha256:a95d1ad73522658e260c8c254b67ccaabb006932134bfcc9ad273ea7b7a9a15c`;
plan `sha256:2ed7a96c30d1bf01f22ac893a0e1fbf8fb83774c9fef0e911235f207a62a83d7`;
parent event shard raw `sha256:d7cbad210f8b9471b77ec176eb5205b54b66cfd291a9b36ee8669792b5212b2f`
also matches its prepared manifest. Its three initial-admission programs do not explicitly
select Admission bodies; the candidate does not silently rewrite or replace that parent.

Seal source8879 / `sha256:1dd1d0eb070cda818fe2751a9e8925c709f81bdeaa55f454f85e01696f017736`;
definition122873 / `sha256:cc2199b061f5720b83c6256cfd5148538e5d60226c3e95f109cc2e77a2a7ff1c`;
envelope123898 / `sha256:06081bffe86fc2a7d5a2d9b2b70885575ba62d784f0c9dee41b51c02f0d99b9f`;
independent `sha256:072a3d58d857a169662b3cffd8c5af0ce297846bd1848e761f3610071153eb98`.
65config/163generator/2toolchain;19Node/17Python seal mutations reject, prepared parent unchanged.

Next remains finite member/selection/adjacency lowering and complete new-owner ID/ref-role
reconciliation into one coherent native ABI/root/index candidate. The cursor is synthetic,
not real accepted-command/predecessor history; G1 is NOT fixed. No Store transaction, concurrent
CAS, crash durability, follow-up, full target/scope/OS authority or ordinary-route acceptance is
proved. Product/shadow flags remain off; G2 output contract, storage projection and old22
product gaps remain open. No new DB, heavy aggregate/build, model or external data access.

### 2026-08-30 — Full reachable surface inventory exposes missing root authority

The earlier transfer only rebased its existing owner set; it produced no new native rules for
AuthorityProfile5, FeatureSchemaManifest6 or RuntimeFeatureSet6. Eleven legacy RuntimeFeatureSet1
external rows are not coverage for the new root chain. AuthorityProfile5 exactIdRuleCount still
equals3617; the transferred candidate has3651. Do not merely replace the number: missing rules,
their classifications and program/ABI/index integration must be resolved together.

New `astra-v3-native-root-surface.mjs` + Node runner + independent Python probe produce the
same structural inventory from the existing checkpoint's schemas plus the exact verified
three-owner member extension. No materializer chain, target reads or new SQLite allocation.
Reachable alternatives per owner (leaves / ID-like candidates / refs / tuples):
AuthorityProfile5 =2681/799/5/1; Manifest6 =1535/621/69/38; Runtime6 =38/11/3/0.
Total4254/1431/77/39 plus10 literal containers. Counts include schema branches and are neither
runtime field counts nor a claim that1431 new authority rules can be added without analysis.
The collector exposes every scalar, making naming-based ID candidates a convenience only.

Fixed tuple positions and nested const data remain explicit; unknown applicators/open shapes,
cyclic/overlay refs and malformed ref envelopes fail rather than disappear. Analysis location
selectors are not the native ID-path ABI. Immutable-ref schema descriptors in the manifest are
distinguished from reference envelopes. Node/Python each detect4 structural drifts: omitted
extension, removed objectId, broadened manifest target and changed root count. These are drift
controls, not proof of effect or semantic authority.19 new focused tests;282/15files PASS2.87s.

Run `node scripts/architecture/verify-astra-v3-native-root-surface.mjs` with the same explicit
--prepared/--db/--checkpoint above. Python input283871B. Inventory remains in memory:
`sha256:8876fed155290cfdd03b8f5a153395bdfdb34b54d5dab36d8b354389de344355`;
report `sha256:778741cc8c9a0f59f0c4c67370dbb4fb8c8243938877d8ee5bf01ba2ee2243fc`.
Seal source9000 / `sha256:7675ba5bc225cd03be55a75e415c5c04e6581017d5b87130c370c230a066aaa1`;
definition123684 / `sha256:658945682610221655d341a71aececa9ee384ae4edcbccca841397b49ef41366`;
envelope124709 / `sha256:66a0058a9ab5ff46658eef87d230fcb3c62bdac91f3be3e978915da01dd1d824`;
independent `sha256:5fded8277f635a548a03ace257f7c152b0d4f7bde877554ae05372ea1423d091`.
65config/167generator/2toolchain;19Node/17Python seal controls PASS. Prepared parent untouched.

Next: explicit per-owner classification/owner maps, native representation for exact tuple/
branch selections, and consistent rule/ABI/root/index construction. Do not copy opaque object
authority from field names, turn const schema IDs into grants, or allocate native rule IDs from
these analysis-only selectors. Finite member/selection lowering and source/target composition
remain pending. This pass measures the missing contract, not its completed implementation;
G1/G2/storage/old22 and all product/Store/OS readiness boundaries remain unchanged.

### 2026-08-30 — Explicit executable role guards for all77 root references

New `astra-v3-root-reference-roles.mjs`, Node runner and independent Python probe replace
name-based assumptions with an explicit finite role map over all77 inventoried reference
locations. Five shard slots require distinct variants, Manifest authority requires root,
Runtime requires exact Manifest6/Capability4/Certifier2, and66 schema slots require the exact
described schema. Manifest canonicalization/transport slots have broad native schema shapes;
guard semantics require Canonicalization1/Transport1 and protocol-body purpose. Both native
schemas accept a wrong typed target in the control; both role guards reject it.

Edge verification binds exact controller-selected ref, store generation, record identity,
metadata, byte length, schema/body identity, native body validation and body variant. Actual
native testing exposed Ajv's object-const comparison failing on strict-parser null-prototype
maps; structuredClone at the guard boundary preserves data while normalizing the validator
input, without parser relaxation. Record ordinal/role fields no longer leak into strict RefV2.
The shared Python schema-extension pin now compares canonical JSON bytes rather than object
equality; false-for-zero shard ordinal substitution is rejected by an explicit control.

299focused/16files PASS3.34s (17new unit schema-shim tests). Independent Node/Python agree on
77 roles and68 positive edge checks:66 exact native schema bodies created in memory and two
retained DB instances (Capability4, Transport1). Nine missing positive roles remain listed,
not skipped as successes: five shards, authority root, manifest, certifier, canonicalization.
Ten negatives cover wrong selection/generation/purpose/object/length/body identity/meta schema,
resealed schema substitution and two broad-schema wrong targets. Prior member106/16 regression
retains report35cca510... after strict Python pin correction. No full Store/build chain rerun.

Use `node scripts/architecture/verify-astra-v3-root-reference-roles.mjs` with the same explicit
--prepared/--db/--checkpoint above; input283866B. Existing DB remains read-only, no new DB/copy.
Role plan `sha256:eff5be3549d2e623b2df69bc48b422543a140e9f2d6a6006dd8485dedb1fc8bc`;
report `sha256:35c47248bc0dd71e653e793bfb208646134864c09f693eaca91157f6b3818ac6`.
Seal source9123 / `sha256:7cf0ad3f809f4efcba691e279a93389082dd47ccd5ef018bc3f756d33504eb0a`;
definition124500 / `sha256:5235e718eab4811bdfee0a76f554ac7b275b0f15a6d1dc97b51283b28eb97cf2`;
envelope125525 / `sha256:900aa0ec84ab89410e716ab0845dc212d1d1b75c38dc686a72d75a29f64dbb16`;
independent `sha256:302f8bf8466dbe493dc2548a8bf5977ff99141b8852501d71ea95878d1f3ed64`.
65config/171generator/2toolchain;19Node/17Python seal controls PASS, prepared parent unchanged.

This is explicit role semantics, not authentication of the containing root bodies or native
opaque-ID authority. Role IDs/selectors are not installed ABI instructions. Next build root
ID classifications and exact branch/tuple lowering, reconcile3617/3651 only with complete rules,
then authenticate whole selected roots and supply the nine missing positive objects in one
coherent native cohort. Source/target/member composition, Store/CAS/crash and actual G1/G2/
storage/old22 ordinary-route defects remain open; all product/shadow/dispatch flags remain off.

### 2026-08-30 — Exact owner-body selection, without Store-root authority

Existing root-reference guard now captures the containing owner record/reference and selects
the child from a private body snapshot. Role IDs cannot choose another owner; callers no longer
supply the child reference on this path. Native body/ref/digest verification precedes selection.
Repeated Runtime digests, Manifest schema/authority bindings and Profile descriptors are checked.

Source review caught an incorrect unfinished comparison: identityCanonicalBytes is NOT the
transport byteLength. It is canonical shard JSON without bodyDigest, as in the existing cohort
generator and independent projection-cohort probe. Corrected this and added direct regression
coverage. Shard payload count, instruction count and array hash are recomputed, not trusted from
two agreeing declarations; profile identity and shard count are also bound to the owner.

324 focused tests/16files PASS4.42s, including42 role/owner tests (25 added this pass). Small
Profile/shard unit shims prove branch/descriptor logic only. Native Node/Python checks bind68
edges to two shared Python-generated native-schema owner witnesses (Manifest6/Runtime6); they
independently check selection/digests, not independently sourced fixtures. Eight owner-negative
controls reject, in addition to10 prior edge controls and the schema-type substitution control.
Four resealed owner-negative bodies first pass native schema validation. Mutation after capture
cannot change selection. The9 missing positive target roles remain9: synthetic owner witnesses
do not establish those targets or resolve their sibling dependencies. DB remains read-only.

Same explicit --prepared/--db/--checkpoint command as above; input283866B. A mistyped checkpoint
on one retry failed the format preflight; it was not accepted or used as substitute evidence.
Owner fixture digest `sha256:83012adc16ad3eda67c239be11f65c2ff816e303a6584fc4012485e3c5568d41`;
report `sha256:7c5d80bd037210f657a5b65cc5a3d58d209e28ab531145f7b8773419201db770`.
Role-plan/source hashes unchanged. Definition124502 /
`sha256:e750b53404e9f61d548930bb92ba788840f5be9406022f530a957563e9e9979f`;
envelope125527 / `sha256:951d2d593332dbc20a6a1a5f23d5204223b3b5768cb5a09498a95c0ad363c6c8`;
independent `sha256:23041f37dff712fce9ccedf634784adb6f126071abfb422aba5649715f57e425`.
Seal65config/171generator/2toolchain,19Node/17Python controls PASS. No heavy chain rerun.

Owner content integrity is not Store membership, authorization or full-cohort authentication.
The native ID endpoint format still lacks exact array-index selection and new root owners;
internal numeric location segments MUST NOT be reinterpreted as native property-name selectors.
Next: coherent exact selector/owner classification ABI plus actual native root/shard objects,
then journal/CAS/recovery and ordinary-route acceptance. Keep3617/3651 unresolved until the
complete rule set is derived. No product/shadow activation, model/network or user/Safe access.

### 2026-08-30 — Typed, occurrence-local selectors replace root pointer walks

New `astra-v3-exact-selectors.mjs` and17 focused tests define an isolated versioned selector
dialect: property, exact array-index, homogeneous each-array-item, and oneOf schema-branch at
the current occurrence. Identity binds ordered typed steps, owner, complete registry digest
and dialect digest. Numeric/star object names remain distinct from array operations; branch
choices are schema-bound, not ambiguous concatenated tags. Retained native ID allocation code
and parent rules are untouched; nativeRuleId still rejects the new array-index operation.

Compilation verifies schema/ref/literal/branch locations. Full captured owner validation runs
before selection, and data/steps/metadata are privately captured. Missing optional/inactive
branch yields zero occurrences; root-role checks require exactly one and cannot fall back.
Local/external schema refs and literal const containers preserve their context. The existing
77 root-role guards now execute the typed selectors, including schema/shard descriptor parents.
Public selector-binding mutation cannot redirect captured checks.

Depth-first selection avoids per-step fan-out arrays and accounts canonical result bytes before
retaining each occurrence. Limits are128 steps,100000 work items and4MiB serialized results,
in addition to the unchanged strict input parser. No4MiB heap claim is made. A small input with
long repeated occurrence paths demonstrates the independent result-size limit; no partial
selection result escapes on overflow. This is bounded candidate behavior, not a product speed
or total-memory benchmark.

341 focused tests/17files PASS7.97s. Independent Node/Python compilers agree on4254 scalar
selector identities/target locations and77 role bindings; all those reachable alternatives
compile without collapsing tuples/branches. Two shared synthetic Manifest6/Runtime6 witnesses
exercise1573 leaf alternatives, yielding1490 scalar occurrences with identical values/typed
paths. Existing68 root edges/8 owner negatives/10 edge negatives stay green, with9 missing
positive native targets still explicit. Source identity checks preserve the retained parent;
no new roots/shards/DBs or product execution are claimed.

Same explicit --prepared/--db/--checkpoint command as above, input283866B. Selector table:
`sha256:c56b1cf67288b9189869f2067bd102682164dfa6814e6b461cf1e6f1b5fa9dca`;
role bindings `sha256:708589450d5fc2189a5a00cfed9853b1265fbb12cd4bab01b56284a4d3de9509`;
selected values `sha256:2ed3b318708e7dbacbe98b6ad8744ec02d255e62d86215bf22b55c7e9c39f892`;
runner report `sha256:1b4ae89754c72e76ea16be962303c0dba87689cd0effad0f744bce2ffe6df2f1`.
Role plan and owner fixture digests are unchanged from the preceding pass.
Seal source9177 / `sha256:8ccbec00990833483bdb85bcfaddc6ed038169a8fb39ae98c5b23458c3766395`;
definition124895 / `sha256:6e4faa5ea52bf1cb49ed61d17ad8be3460b25939cce12f05db2649ce124e4052`;
envelope125920 / `sha256:6a8e1efc03ac35b908bb8fa63277107a9db68218a233107f38f1fe1d9e3dba5d`;
independent `sha256:8a1e108f33e40f67c38fda884d4b160614137a90d2f4555d6c698489ab211ee0`.
65config/173generator/2toolchain,19Node/17Python seal controls PASS. Store-proof source pin
updated for its next legitimate run; the expensive full Store/materializer chain was not run.

This closes the executable structural-selector representation gap in the isolated root guard,
NOT installation in the native authority-profile schema or binding VM. Next classify the root
ID fields by actual allocation/reference/semantic owners, using these exact selectors, then
build/version a coherent native rule/profile/ABI/index closure and its missing root/shard
fixtures. Keep3617/3651 count mismatch and Store/CAS/recovery/product gaps explicit; never turn
all ID-like names into opaque allocations. No product/shadow/runtime activation or G2 rerun.

### Root ID semantics and nonempty Manifest namespace evidence — 2026-08-30

Isolated `astra-v3-root-id-ownership.mjs` and its17 unit tests distinguish actual root symbols
from opaque allocations. All1431 ID-like scalar alternatives are classified using134 explicit
owner/path policies plus77 typed reference roles; unclassified fields or opaque-shaped semantic
slots reject. Policy paths generalize typed tuple positions, never numeric-looking object names.
These are alternative schema locations, NOT1431 runtime rules or allocations.

The18 categories are: schema-reference700; store-object-reference77; store-generation-reference77;
binding-rule-reference20; local-reference135; variant-reference197; local-definition70;
feature-symbol3; id-rule-reference6; semantic-profile-reference5; id-rule-definition2;
profile-symbol6; contract-member-reference24; occurrence-reference72; program-local-slot9;
owner-set-reference12; binding-program-definition15; semantic-profile-definition1.
All have `mintsOpaqueId:false`; their external resolution authorities remain distinct and open.

Ownership artifact:
`sha256:a4285829296c1df3093626b5be6f6cff8b4f5fdf2be10ea3a8fd10a1e9f93bc4`.
Shared134-entry policy27251B:
`sha256:21d3b4cdac03e1f11ed90e08aab0b06950f7812ac45f760d5b643b4a6f0357aa`.
Python independently traverses schemas and computes classifications/digests over this pinned
policy. Agreement is NOT an independent semantic audit of the policy itself.

The runner explicitly captures/authenticates an additional synthetic Manifest owner before
calling the new pure local namespace checker. Generic owner capture does not imply this check.
The nonempty witness has66 schema/content definitions,1 digest,1 guard,1 invariant,0 transitions;
71 local references checked. It retains two unresolved external references: the synthetic
`binding.unresolved.v1` binding rule and `interaction.accepted` event variant. No actual binding
program, pointer operation, digest operation or state-machine semantics is thereby certified.
Witness digest:
`sha256:35d304d85a2b83807d38ee8e28984a85b21714cc8be0201ac1bb2f102824954a`.
It is separate from the two existing role-owner witnesses, memory-only, not inserted into Store.

Five independently reproduced controls first pass resealing/native schema validation, then
reject: duplicate digest ruleId with different body, missing digest reference, unrelated digest
schema, absent guard-to-invariant reference, and missing reverse invariant-to-guard link.
This demonstrates a real gap beyond JSON Schema uniqueItems, not only empty-array success.
Unit tests additionally exercise transition guards, domain/coverage errors and duplicate refs.

358 focused tests/18files PASS7.38s;17 new ownership/local-symbol units. Existing68 positive
target edges,8 owner negatives,10 edge negatives,4254 compiled selectors and1490 selected scalar
occurrences remain passing. Nine missing native positive targets remain nine. Python list-index
handling was corrected during the pass; the generic witness generator's unsupported JSON-pointer
regexp was not relaxed. Explicit valid synthetic digest-rule data is used instead.

Runner input311133B; report:
`sha256:4629779b5feef6f74c3d5209488342ee7021d3f881dbed7a5c6e5ee15d4f17ef`.
Seal source9233B / `sha256:ab910e531f09c1a1312a5609b206b5aa0727624e1790cfabd1e1dd8a111070a2`;
definition125292B / `sha256:838532074ed82034f2f05cf561537672ba55b50e73eecbb7d13fad8d7a677ae0`;
envelope126317B / `sha256:e30a63cf2760d896c29aea36425e1a3e6ea2b822282a6c4da751916e1f18425a`;
independent `sha256:18e2a9c387026c56329275c0d665596b8e1f388bf0bc00f95b8f76b75f00c3ea`.
65config/175generator/2toolchain,19Node/17Python controls PASS. No heavy Store proof or G2 rerun.
Same prepared input/DB/checkpoint as the preceding pass; no DB or product writes.

Next resolve external symbols against selected native ABI/event/commit-shape/profile/member
indexes, then construct a coherent root/shard/rule set. Do not repeat the completed inventory or
manufacture allocations to close3617/3651. Native rule/selector installation, Store/CAS/crash,
G1 predecessor, G2 declared-output and storage-result acceptance remain independent open work.
No product/shadow activation, native authority or release-readiness claim.

### Exact event symbols and binding namespace migration gap — 2026-08-30

New `astra-v3-event-symbols.mjs` and Python probe reconstruct the two complete native event
schemas from source `sha256:7f947dd2d9ea398cac7a0162f16909e1c50367d2ce297e5150af670292e7798a`.
Python reuses the independent source oracle's pure projection routine; no compiler/materializer
chain runs. Four explicit V1-to-V2 schema replacements include embedded InvocationTransition;
the first exact comparison correctly rejected its missing rename before correction.
No relaxed schemas, guessed branch names or caller-provided symbol lists are accepted.

80 exact schema-qualified symbols (40 per schema) bind the full selected66-schema registry,
typed branch selector and branch digest. Python generates80 bodies validated against the original
native schemas; Node independently selects the matching branch. The old witness cannot synthesize
the causationId union-prefix regexp, so this fixture supplies an explicit valid cmd_ ID without
changing any schema or the generic witness engine. This is body-shape coverage, not80 accepted
events or a committed causal history; unused nested payload alternatives are not exhaustively run.

Index `sha256:d9211522c3f868634a1830dab7d97e1bd149147a8035904cf924812b81cba49b`;
80-body witness digest `sha256:fd8ec116c6392b6834e8934df1f76107ed8333cb2a5b767286540c6d1eb6afcf`;
additional Manifest fixture `sha256:958d091b59a48cd4025fb1aa83bae77a11c1981dfefdddda1c32c9fbe29e1620`.
That fixture has73 local references,4 resolved event/endpoint symbols and1 unresolved binding
reference. Four resealed/native-valid mutations reject independently: unknown variant, ambiguous
event-type alias, wrong endpoint variant and inconsistent transition event type. Prior three
Manifest/Runtime fixtures retain their hashes and counts. Nine missing native positive targets
remain nine; the additional witness is not promoted into the root target set or written to Store.
Final runner report `sha256:8d1336739f4bf5980a089464ea3b7e5093c3d23ad051ad27caf8354a0f4fbf2d`;
probe input311138B after the opcode-sensitive ownership correction below.

95 focused tests/4files PASS7.04s, including17 new event units and2 ownership correction tests.
The preceding358-test pass is historical,
not claimed rerun; no heavy Store/G2/aggregate work. Exact source pin, native schema drift/order,
cross-schema/old-version lookup, invalid body, public mutation and unresolved authority covered.
Seal source9285B / `sha256:80805a03a9449b3c5d5557be3331f2b645c832b0940614208f01e16a71ea3986`;
definition126091B / `sha256:9f6edc0e31a84f3fb7eb712e69a0f93b59dfd81f18f35d561fe51edfdaaf48c0`;
envelope127116B / `sha256:49db8512a15f5c0f23be5149025ca545dfb10357ba0db90a3fadd8be6c61b430`;
independent `sha256:2154cacae70b1412a51c311cefcc72a674a123ab03370079f72f43180da8813a`.
65config/179generator/2toolchain,19Node/17Python controls PASS. Existing prepared/DB/checkpoint only.

Source evidence of the outstanding mismatch: `materialize-astra-v3-authority-root-replacement-
schemas.mjs` removes bindingRules and descriptor bindingRuleIds, but the predecessor Manifest
tranche's guard/invariant schemas keep references to that removed namespace. The ABI has program
IDs, not the former left/right/relation definitions. Explicit source-authored lowering with
program content/set/scope/guard relation checks is required in the next coherent versioned
closure. Do not pass these refs by matching programId text or restore legacy authority implicitly.
Other schema-variant indexes, commit shapes, semantic profile/member indexes, count reconciliation,
native ID integration, Store/CAS/crash and real G1/G2/storage acceptance remain open.

Final opcode audit CORRECTS the earlier shared134-entry ownership policy:18 instruction ruleId
alternatives address digest rules, not binding rules. Enclosing exact opcode now must be one of
assert-domain-digest/assert-shared-domain-digest/assert-domain-digest-resolved-object; an unknown
operation at the same structural path rejects. Current1431 fields span19 categories, with
binding-rule-reference2 and digest-rule-reference18; all other category counts are unchanged.
Policy digest `sha256:3236e753eb94b94d9fcf4ce1baf7f953d4b1b23d1fc08476b99a933507062fca`;
ownership `sha256:de5e466e4ea18baf9d9f9802237a2065b3b6a3aadc1271dfb447edc71606aafb`.
This supersedes the earlier18-category policy, not the source schemas or native ID authority.
Actual digest-rule definition resolution remains open. Two-engine policy agreement alone was
insufficient to establish these semantics; keep opcode-sensitive tests and this correction.

### Program schema-version reconciliation before guard lowering — 2026-08-30

The new program-only path in `materialize-astra-v3-projection-cohort.mjs` shares the existing
ABI/program derivation, but stops before root/object witnesses or the Python cohort probe.
It checks the exact D: junction/marked prepared child, realpath of every prepared input and
manifest raw pin `sha256:b1083733bfcc5b808b9027b61032f92739ed56073c66fd4a02af616491759218`.
The72 prepared files (manifest, ABI,66 schemas and4 shards) are
read-only; per-schema/shard hashes are still verified. The new mode takes about1s in this run.
The full historical cohort mode is preserved, not executed or newly claimed verified.

Parent ABI `sha256:8febd39c84f63bc6d43903b1de06b007c57d67598875653438549c51ae879d27`
contains157 programs/1830 instructions. Seven programs fail Profile5's selected grammar with29
stale schema references:26 Runtime3,2 Capability3,1 Manifest3. Candidate retargets exactly these
to Runtime6/Capability4/Manifest6, preserving the other150 programs and assigning seven new
content-derived IDs. The root's ABI constant is NOT rewritten and native activation stays off.
Native grammar acceptance checks program representation, not all pointer/operation semantics.

Candidate `sha256:6fe548781f3dcc0b01ef3cb044da7fb84a4dd0878848187108b85eb1b173b8b6`;
full candidate sets `sha256:a7a1276eded6f116d40b921761e18ff17687bb18ae51dfa23489e3b12c44de6c`;
selected registry `sha256:fc9591ae763fb8d3a821e77d6df3e3acebabf8195dd53d78476d2d291037cafc`.
Python independently loads the same checkpoint and verifies the exact native schema extension,
reconstructs all changed programs/IDs and validates all157 resulting bodies. Input1045702B,
no new Store fixture or persisted program body. The Node runner exercises157 exact selections.

52 focused tests/3files PASS2.89s,16 new tests. They cover parent ABI/content tampering, missing
schemas, unreviewed replacements, input isolation, root preflight, changed set/hash/scope/ID and
public-output mutation. Unit grammar shims are not native evidence; the independent runner is.
No full aggregate, G2 or Store-proof rerun. Seal source9418B /
`sha256:1cbf99a6b0d8b593f2680fa8a195a8be5c5aefa6bb1b8b45e83b71079d29918c`;
definition126925B / `sha256:48a59bccbe0be67b902d12e06278229bf69c80d32c39a50ea328cd99d504b826`;
envelope127950B / `sha256:f8c308e2bae762af90a91eba50ccab7efe26b0015a595f3804b73f1086279eaa`;
independent `sha256:3eae13c53cc21306d8d4400e3abe1df69eb97e57721b659617d4f88718b2492c`.
65config/183generator/2toolchain,19Node/17Python controls PASS.

Next compose these program identities into a versioned ABI/root/shard candidate alongside ID
rule/selector/count reconciliation. Then lower actual source-authored guard/digest contracts,
checking required semantic operations rather than accepting program names alone. The initial
Admission-body gap, old22 substitutions, Store/CAS/crash and real G1/G2/storage acceptance remain
open; this pass does not silently close any of them or the nine missing positive root targets.

### 2026-08-30 — Acyclic native ABI/schema/program-shard candidate

New builder/verifier `scripts/architecture/astra-v3-binding-abi-closure.mjs` and independent
`probe-astra-v3-binding-abi-closure.py` extend the existing program-binding runner. Prepared
inputs and DB checkpoint are unchanged. No full predecessor materialization, DB mutation,
product/shadow runtime, G2 rerun, user/Safe/model/target/network access or new authority root.

Profile5 ->6, Manifest6 ->7, Runtime6 ->7 are the only changed schemas among66. Programs
retarget reviewed schema operand/literal positions, retaining content-derived identities.
Four native shards: retained25/93, event114/1376, completion9/151, projection9/210
(programs/instructions). Total157/1830,41 used operations. Schema versions and operation/
endpoint/program contracts are in the ABI; final schema body digests are in a separate
binding, avoiding ABI -> schema -> ABI digest recursion. Its parent candidate remains
6fe54878...; parent ABI and prepared/retained objects are never patched in place.

Reproduced by JavaScript and Python from the checked predecessor:

- ABI `sha256:0aa56209772ed7396226011883e0d49452b0fb3f482d65dc4116bcdfaaab17e8`.
- External binding `sha256:2e69abe2c457fd44b96e6abfa115e8639a41fdbd31a0c9c50491d9dde497c0ff`.
- Schema index `sha256:7002ab7a5d63ef3e829cb5d0e58e7c41229e36ac4d0a7a0eceb16af86200dcac`.
- Program index `sha256:d41f1e634889f20819770ec822eae04e2427ca609e3c7497308214a2eb4dd05a`.

Independent probe input1046590B; four native bodies validated in both implementations.
Internal consistency verifier is not an authority authenticator: pinned predecessor replay
is required.39 focused tests/2files PASS21.68s,23 new cases. Controls include resealed wrong
root anchors, program substitution, missing/swapped shards, ABI count/operation duplication,
digest backedges, authority-flag promotion, invalid version maps and changed-registry cache
isolation. Initial run had5 timeouts from repeatedly compiling the full66-schema registry;
one private exact-content cache entry now reuses grammar compilation only, never results or
authorization, with copied inputs and no unbounded registry accumulation.

Seal source9476B / `sha256:dd8d34479601ca49b01c47439e5bd9a4e4cbc9854f0960347d149de4fa4d3d27`;
definition127530B / `sha256:ef1145dce7a1dcf7681ec4f605ed5eb36ecec6c5d95291869b8aafd81c7194e8`;
envelope128555B / `sha256:fab12fa6a88b6cab1bda2f306f502afc9615c206e2a70a7f537159aa1c68b325`;
independent `sha256:0d5230113858eaaaf71e1206063f539fcd4b1a98cc8e3500ff03024c53b74acb`.
65config/186generator/2toolchain;19Node/17Python controls PASS with `--prepared`.
The seal's148-program retained baseline is unchanged; sealing candidate source files does
not install the new157-program ABI.

Unclosed: Profile6 declares3617 ID rules versus3651 current candidate rules; exact root ID
ownership/selector lowering must precede final ID shard, counts, roots and cohort installation.
Guard/digest semantics and initial Admission-body checks remain unproven. Newly constructed
Profile6 shards are not positive targets for old Profile5 role fixtures. Keep their nine
missing targets, old22 substitutions, Store/CAS/crash and real G1/G2/storage acceptance open.
No product or release readiness is claimed.

### 2026-08-30 — All-rule validation finds152 stale owner-enum failures

New `astra-v3-id-reference-grammar.mjs`, `verify-astra-v3-id-reference-grammar.mjs`, independent
`probe-astra-v3-id-reference-grammar.py` and focused test. Actual checkpoint-derived3651 rules
include152 native-invalid classifications:32 reference-set,120 reference-union. The previous
clause-membership probe validated its eight changed rules, not this entire rule set. Profile6
inherits the same ID grammar from Profile5, so four new program shards did not fix this issue.

The detached grammar replaces exactly four stale owner-array constraints, deriving32 set and
42 union owners from actual reconstructed bodies. It preserves128 maximum, requires uniqueness,
and leaves rules and retained schemas untouched. All3651 now pass prospective grammar. Full
body selection independently rejects grammar-valid ownership swaps under unchanged rule IDs;
full-set checking rejects omissions/duplicates. Graph checking covers117 retained dependencies,
missing targets and cycles. It does not prove reference-instance scope or source semantics.

Python independently reads the exact prepared ID-shard pin and synthetic DB checkpoint,
reconstructs versioned schemas and ID rules, performs the eight clause-member corrections,
derives the same grammar/index and validates every rule. Input285710B; no serialized full-rule
payload or new fixture/database. Two independent negatives: duplicate owners rejected by native
grammar and a native-valid wrong classification rejected by exact-rule comparison. The stronger
negative initially exposed an exception-class mismatch between independently loaded helpers;
catch now uses the exact originating helper's class. Final repeat PASS8.75s, no failure masked.

Hashes:

- Source definition `sha256:23c9976ba4f40c774a8a818ea65860e43169c33128ebd4041a650324a5396dc0`.
- Prospective grammar `sha256:b143739c6d9f4dde50eaa6e6337d25a4361319f8b32fc8ed73ce13437e11f379`.
- Exact3651 rules `sha256:9bcdf63063175cd438db935743d99de0b01fbf5818d30507ad518cc82a38bf54`.
- Rule index `sha256:9c5ce2fcf20d5ef23570f3ad272bc52f3cb7053d068721078026f51a134e82e8`.
- Reconciliation `sha256:223832fbc20aeced17a50474eb239940e1f18910a3e61d0b916ed42cee195039`.

67 focused tests/3files PASS8.72s,14 new cases. Source/rule/output immutability, graph errors,
stale identity, unrelated malformed semantic rule, reference-set substitution and rule-set
completeness covered. Tests also confirm19 owners and zero Profile/Manifest/Runtime coverage.
Do not relabel these3651 rules as complete native root authority or change the3617 root count.

Seal source9599B / `sha256:c30ed86a50fd195f4f4573f14a39633b2d35c7ed211dc9105c1d8ad570d6938a`;
definition128344B / `sha256:c6619db9fdeb53d4121d086185b00c068c1bcbc1d06d279f5ffd95cbff9b8e4c`;
envelope129369B / `sha256:4062ef784dbf18dc13ddf47655c17c0bfff3de3815d8ddf77d28c3bcbbb26b5d`;
independent `sha256:70c7f79e6ccd102a94cdccfdeaaf3548ee1bb447bc88dfa596595b42c195fa82`.
65config/190generator/2toolchain;19Node/17Python controls PASS with prepared inputs. No full
aggregate/Store-proof/G2 rerun or product changes. Profile6/Manifest7/Runtime7 ABI closure stays
unchanged; this prospective grammar is not silently inserted into those immutable versions.

Next: derive root rules from semantic ownership and exact selectors, combine with this checked
non-root rule set, then compose a new versioned grammar/ABI/root cohort. Do not add1431 field
alternatives as1431 allocations or alias references to opaque generators. Admission/program/
guard semantics, nine old missing positive targets, Store/CAS/crash and G1/G2/storage stay open.

### 2026-08-30 — Exact root rule materialization and actual program-shard observations

New `astra-v3-root-id-rule-candidate.mjs`, `probe-astra-v3-root-id-rule-candidate.py` and test.
Existing root surface/role/ownership helpers explicitly support two exact version cohorts;
old defaults/digests stay unchanged. `compileRootIdOwnership` shares its selector compiler
instead of traversing/compiling all leaves again. Per-capture WeakMap caches repeated branch
validation only on its private immutable objects: no authorization/result cache or cross-capture
reuse. Existing resource limits remain; no new claim about heap usage or product performance.

The proposed closed rule schema binds exact owner+selector, constraint digest and semantic
classification.1431 unique rules/selectors cover19 categories with0 opaque allocations. Rule
IDs use domain `astra-root-id-rule`, schema `monarch.astra-v3-root-id-rule.v1`, body without
ruleId. A private exact index rejects valid-shaped altered selectors/authority labels. This
is prospective root-ID grammar, not the legacy rule ABI or an installed mixed rule shard.

The program-binding runner accepts opt-in `--root-id-rules`. It rebuilds the same pinned ABI,
constructs the root rules and examines all four exact native shard bodies. Independent Python
rebuilds ABI/schemas/shards, traverses schemas, checks the normalized reviewed policy pin and
reconstructs the same complete rules/selectors. Input1077033B. Policy semantics remain shared
reviewed input, not a fresh independent semantic audit. Dynamic occurrence/resolution counts
below are Node evidence; Python independently verifies rule construction and native shard
representation, not all dynamic observation rows.

| Program shard | Selected ID occurrences | Schema/profile/program memberships checked | Unresolved |
|---|---:|---:|---:|
| Retained |170|158|12|
| Event |5402|2398|3004|
| Completion |663|323|340|
| Projection |22|16|6|

Total6257/2895/3362. Unresolved categories:2279 variant references,771 occurrence references,
56 owner-set references,78 digest-rule references,172 contract-member references,6 local slots.
These are occurrences, not unique symbol-definition counts. No unresolved category is marked
resolved by representation validation or membership in a program name index.

- Root candidate `sha256:3cc3993521f021868cd0b67684c523a5d3a94db6424e2150ef29f8eb49706db2`.
- Rule schema `sha256:38c68e42fd7941068e7002370499a6f6073e46534412ac4285162f3f03e5a658`.
- Rule index `sha256:57ec2d9010264547796ab589ca47cf7b844529d6be3de3c4b8691930cd50ac73`.
- Selector index `sha256:815e96816cbf65e481941b140bba492efd4b62b4268c456d2529c12d0d41f4bc`.
- New ownership `sha256:bdb3ebd462121e2e36c11023874d8e717ddbb6a3d39c55b3a1f1e3f2c95a9439`.

90 focused tests/4files PASS19.88s,12 new cases (11 root +1 branch-cache isolation). Negative
cases cover missing/duplicate rule coverage, mixed/future owner cohorts, native-valid altered
classification/selector, allocation promotion, rehashed different shard and public mutations.
Native old-role runner repeated successfully: report8d133673..., ownershipde5e466e...,
selectorTablec56b1cf6..., values2ed3b318... unchanged. No full aggregate, Store-proof or G2 rerun.

Seal source9660B / `sha256:7300a6343a4b977917286d99c6ddd2acb95543754ec22ec72aa8540c69f3e692`;
definition128957B / `sha256:9110eb11a754f8ddb314c960ca564ecc2a8268689a14b898ea35a95581ff5b6b`;
envelope129982B / `sha256:85fc6989c4720cbbafcfef1ba1a7ec4e951f4c7ae433e41ed78ea04f6af893f5`;
independent `sha256:1dc47ec26f483cbcdbcc1ef6b703975971fc5b59a9177d653aad33ebcf6063f0`.
65config/193generator/2toolchain,19Node/17Python controls PASS with prepared inputs.

Next resolve the concrete program references against source-authored event/scope/digest/
capability contracts and lower required semantic relations. Compose both rule dialects and
the detached non-root grammar into a new coherent schema/ABI cohort, then re-enumerate that
actual final schema before deriving counts/ID shard/root instances. No count-only patch or
automatic5082-rule activation. Store/CAS/crash, initial Admission semantics, nine old missing
targets, G1/G2/storage and product/model/Computer Use acceptance remain open.

### 2026-08-30 — Source-bound program events and exact occurrence relations

New `astra-v3-program-event-bindings.mjs`, `probe-astra-v3-program-event-bindings.py` and test.
Existing program-binding runner adds opt-in `--event-bindings`; independent closure details
are reused without Store materialization. The event-symbol Python helper has an index-only
path: no unnecessary80 witness/Manifest fixture generation for this pass.

Source envelope `sha256:0d883c35cacaef141bb0d11f444bd9e118f982c5fe89952e965f6c6bafceb9a5`
contains30 exact commit shapes/44 occurrences. Existing pinned event source supplies40 protocol
variant names and80 schema-qualified native branches. Programs legitimately use both source
colon names and native dot names; they are paired by exact lookup, not global text rewriting.
Neither original programs nor their IDs/ABI/schema definitions were changed by this pass.

Checks cover role/schema, projection pairs, commit order/native branch indices, scope position/
variant, first-event ownership, previous-event causation/correlation and completion terminal
pairs. Initial current-occurrence-only checking rejected53 legitimate links; inspection of
the pinned source and existing lowering showed first/previous owner rules, which are now
explicitly enforced including the target field. Two completion-commit-freeze request links
to assessmentInputDigest/Ref are also legitimate and preserved. These initial rejections were
checker assumptions, not reported product defects or reasons to weaken source constraints.

Actual157-program native runner and independent reconstruction agree:

- 2201 protocol/native variant bindings and771 occurrence bindings.
- 78 non-event variants remain unresolved (12 TypedValue,6 AgentCommand,60 Assessment).
- Native event index `sha256:9d7d53d7074dacd7a185ad8c248f7904631b3e1f3a480f0a20c1d8b5a1be2ced`.
- Binding rows `sha256:217a86d8f92952915643fee3b10cdfd478dc22a70e1055bbd6ae62e861297444`.
- Unresolved rows `sha256:4778591f2cf552f62529315b9e33fccca2f75b680cac89e0de254df41599ce73`.
- Report `sha256:cfff34c0f5c99b4151271a42a8379fc169d34501ec9498073438475e87382d55`.

Probe input1047319B; binding rows sort by canonical bytes, independent of traversal key order.
Python derives native schemas from the checked predecessor and source compiler, resolves the
same namespaces and first/previous positions, and recomputes the report. Earlier tiny Ref-shim
exploration is not native evidence; the successful final runner uses all66 actual schemas.

50 focused tests/3files PASS20.06s,17 new cases. Tests distinguish native-schema rejection from
semantic rejection of native-valid pairs/positions/fields. The initial suite wrongly labelled
three enum-invalid mutations as native-valid; two are now explicitly tested as grammar-level
rejections and the terminal test uses two individually allowed but incompatible variants.
Production grammar was not weakened. Native-valid wrong branch indices, order, event ordinal,
causation owner/field, projection variant and completion suffix are rejected.

Relative to the preceding3362 unresolved program-symbol occurrences,2972 now have source-bound
event/occurrence checks. Remaining390 comprise78 non-event variants,56 owner-set references,
78 digest-rule references,172 contract-member references and6 local slots. This accounting
does not rewrite the older root-observation report or prove full instruction semantics.

Seal source9721B / `sha256:136b18f9a7174064fca79906d27d8188c6a217ddf43a2b5b298af9cc82115e5a`;
definition129572B / `sha256:bab034f7a635d354cce0c98c45970209af4cdbd4a04abeaedf951cd352e4a9e6`;
envelope130597B / `sha256:7d8b248f1d6318042823741f3be55fcc86a8035c205b83c68820fde2bb9b0bc3`;
independent `sha256:ab8534589fa509b03f6d4229bbe15963f6b79aeb39424a1ab8fa053fa488cfee`.
65config/196generator/2toolchain,19Node/17Python controls PASS prepared. No full aggregate,
Store-proof/G2 rerun, data access or product/shadow activation. Initial Admission checks,
actual instruction execution/pointer semantics, retained prior-event lookup, Store/CAS/crash,
rule-dialect/schema composition and real G1/G2/storage acceptance remain open.

Next resolve the remaining symbol families from their defining sources and check their required
relations. In particular a known owner-set ID is not proof that a prior event is selected from
the correct history, and a known digest-rule name is not proof that its digest operation is
executed. Keep these distinctions before final root/ABI composition and runtime integration.

### 2026-08-30 — Required digest-operation coverage and exact semantic parameters

New `astra-v3-program-digest-bindings.mjs`, independent Python probe and 21-test suite;
program-binding runner adds `--digest-bindings` and includes existing event checks automatically.
Only the selected in-memory native cohort is inspected. No runtime, Store or prepared-input write.

The previous reference inventory could identify a rule name but did not establish that every
required digest check was present. Current negative tests confirm that removal of required
event/completion checks can leave a native-schema-valid program. The new checker rejects this,
as well as removal of a whole required scope, duplicate checks/scopes, wrong valid rule/domain/
schema/omission combinations, wrong completion source/result fields and reversed commit digest
checks. Source scopes are derived independently of inspected programs, so omissions cannot
silently redefine the expected inventory. Arbitrary caller-supplied programs are not authority.

Results on all 157 current native programs: 123 event/completion scopes, 78 checked digest
operations, 45 distinct rule IDs. Composition: 30 shared commit +44 payload +4 completion.
Fifteen retained digest operations (including projected/TypedValue checks) are explicitly
outside scope. The four completion expectations are review-derived compiler contracts with
explicit native schema versions, not a newly installed Manifest digest-rule registry.

- Payload-rule source `sha256:9ea03769b37c963d6ae9cbfe7682397f5911fe6a5869a378652793bfb199bec4`.
- Domain source `sha256:5f0b057b9e4bc2d4b6419f56dcc41b09e31eb160e46b20653442a1d7139afa66`.
- Expected contract `sha256:7dc0e4ec479c3d675c972a14481c645bd674b87380bba619b1ef7650e6693fed`.
- Observed bindings `sha256:ace1ef4e453c1612a8084aa86a5ad183a0c495f3d4c83ef7d94cada49d384c69`.
- Report `sha256:ff97c961e1725098f2423be319905176569799566d736f571bb4eda3bf6ff16c`.

Independent native reconstruction agrees; input1048135B. Python additionally rejects four
mutations with exact expected error codes: missing operation, wrong result, duplicate operation,
missing scope. Existing event report remains cfff34c0.... Native repeat after strengthening
the error-code assertions passes; no stale session was restarted.

Final focused evidence: 21 new tests PASS22.97s; 33 adjacent event/program tests passed in the
preceding three-file run. This is 54 focused tests across final runs, not a new full aggregate.
Initial new-suite failures misclassified six grammar-rejected substitutions as native-valid.
The final suite separates four explicit grammar-level rejections from native-valid semantic
negatives; no schema was loosened. Event payload source and shared commit destination pointers
are already constants in the native grammar. Tests do not claim those guards as new behavior.

Seal source9783B / `sha256:a12f281a740f1c0f04f105db4bbee717577a00ad1b446b5b43cc0df83c9171df`;
definition130188B / `sha256:282428b2a7b567605af18a9cd1f3060a62dd208bcc1b140ed1b802393587961e`;
envelope131213B / `sha256:01bfe62113e029540f072eced4e3ca3ef15acbba654c0b1c623f757714faad31`;
independent `sha256:3110ef0e3148cfcf4a243cd036f5f671cde4738f6607a5d1e7bf7c08ac932dae`.
65config/199generator/2toolchain,19Node/17Python seal controls PASS prepared. Store-test pin/count
updated only; full Store/aggregate/G2 not rerun. DB2785280B/last write11:03:50 unchanged.

Of the preceding390 symbol observations, these78 digest references now have exact reviewed
operation checks;312 other observations are untouched. This does NOT close their Manifest
definition membership or rewrite the older reference report. Digest execution, authentic
resolved-object selection, remaining symbols, source guard coverage, retained15 digest checks,
root/dialect composition, Store/CAS/crash and real V2 gaps remain open. Next prioritize required
contract-member/claim-selector relations and their omission cases, not merely known-name lookup.

### 2026-08-30 — Required claim/selector/verdict operations

New `astra-v3-program-claim-bindings.mjs`, Python probe and focused suite; runner option
`--claim-bindings` also retains event checking. Pin claim IDs, semantic member profiles and
the exact Assessment source AST; derive requirements and presentation keys from those sources.
The existing independent Python Completion compiler reconstructs expectations, with only two
explicit selected-operation schema renames (AssessmentBody/Input v1→v2). Its fixture generator
and instruction executor are NOT run or admitted as native authority.

All 157 actual programs inspected: four required scopes, ten required operations,172 member
references,28 claim-selector pairs,one requirement. Check presence/order/exact parameters for
three bijections, three verdict policies, three claim canonical-order checks and the request
authority fence. Native-valid deletion, duplicate operations, removed scopes, wrong selector
pairs and reordered pairs are rejected. Native capability-instance membership and evidence
values are explicitly unproven. Fourteen new tests plus16 adjacent tests PASS15.86s (30/2files).
Initial wrong-field test incorrectly expected native acceptance; `/claimBindings` is already
a const. Final test explicitly records grammar-level rejection; no schema loosened.

- Expected contracts `sha256:2a3f20cd239802cda9f1e638208c41c4d6e5b50ec48cc37a1086cf2fb9a6557f`.
- Observed bindings `sha256:c8fc23dd39f4befdaf0b7e42172896ae6d3ea0427ec184e75a23d648c380c973`.
- Report `sha256:6be27edcfa64f3c52a71a20e0e861d6d7200ab82ac7cfd30d8e89ad4f93795d3`.

Node and independent Python agree; claim-only input1047958B. Combined claim/digest/event
verification also passes with unchanged preceding digest/event reports. This does not update
old root-observation reports or install a Manifest. Of preceding312 otherwise unhandled symbol
observations,172 now have source-operation checks;140 others remain (78 variants,56 owner-sets,
6 slots), in addition to still-open instance/execution authority for these checked references.

Prepared seal19Node/17Python controls PASS;65config/202generator/2toolchain.
Source9844B / `sha256:5f1753073377d9da72714337295925fa665eb97c8eea8c939b0130a9865b5470`;
definition130801B / `sha256:5021cd4b5ea3cb7dcb8e9267906ab1bc1461c3adb61614df16e71d34ab89d62c`;
envelope131826B / `sha256:ff531f59f5c238e57e0debe41fbc32784be7e24c5efcc6753cb6a1f2afb5761b`;
independent `sha256:f9e9a4f1c929bf22f20ea46104c9097420281c9414ec3e7e097b17a9b3c7d450`.
Store-test pin/count updated, full Store/aggregate/G2 NOT rerun. No product/shadow/data changes.
Next bind these source members to exact selected synthetic Capability/ClaimTemplate instances,
then evidence-value relations; do not let source-name agreement substitute for instance authority.

### 2026-08-30 — Program members bound to selected synthetic contract instances

New `astra-v3-claim-instance-bindings.mjs`, Python probe and13 tests; runner option
`--claim-instances` includes source claim/event verification. Node selects the sole operational
candidate of the checked `ordinary-scan:admitted` case. Python independently selects and reads
that Admission from the exact read-only checkpoint; no caller-supplied object list chooses
the authority anchor. The exported in-memory factory still requires caller authentication of
its selected anchor and does NOT itself admit a RuntimeFeatureSet.

Existing Node frozen-component reference validation is reused. Python's existing nested reader
was extracted into `frozen_reader`, capturing a private copy; its original full component check
still matches Node (40 reads, same canonical-byte count) on the same synthetic snapshot. This
regression inspects stored synthetic target records only, never observes a filesystem target.
The new member graph itself has no target reference traversal:33 reads/87429 canonical bytes
for Capability, two source schemas, PresentationContract, VerificationRecipe and28 templates.

Checks bind descriptor/member IDs, body digests, source schema objects, nested selector digest,
presentation contract and recipe's exact template digest set. Initial all-output assumption was
wrong:three existing claims legitimately select EvidenceNode. Kept25 output/3 evidence roles;
the initial rejection was a checker error, not a product/source defect. Both sources' digests
must match the selected Capability schema descriptors, not an arbitrary caller schema.

- Selected Capability content `sha256:d6ab5f443b76b6c786f05a7b78f133a725afa48fb9ef0b7937f444e767bc8159`.
- Member graph `sha256:51dc8ac4c208a5f235472b9febc5e929d8b0619aea97ff63dc54f0c29ab2d475`.
- Report `sha256:9bcda30fbcef683dd9d90750e48adbe20883c9e5fbd51e58c2bc7b71657bb794`.

Native runner and independent Python agree; input1049412B.43 focused tests/3files PASS17.73s,
13 new. Includes coherently resealed/native-valid wrong source/presentation/nested-selector
digests, swapping whole valid template references while retaining descriptor IDs and the recipe
digest set, missing objects, wrong generation, capture isolation and required-program removal.
Three initial single-name mutations were already rejected by ClaimTemplate branch constants;
final tests record native rejection separately. No schema weakening or phantom new guard claim.

Prepared seal19Node/17Python controls PASS;65config/205generator/2toolchain.
Source9906B / `sha256:eb4f9de42656fe8fa9ac1fa01c488c469c32121d6cb6ae1672bb10676faccae2`;
definition131417B / `sha256:f0155c14ea77c3389af07600ad3480132311da6b6a8c55b450f059bb3388139d`;
envelope132442B / `sha256:48e65c86ce6195db0b5d19fdd0986695ed98c39d6b23b2096e81002188175c9f`;
independent `sha256:d0460f72991ea3072a5bada1edb364213ad0b1b6436ece1cfb5cb254f1aa8eea`.
Store-test pin/count updated, no full Store/aggregate/G2 rerun or database write.

This companion proof strengthens the172 already source-checked member references; it does not
reduce the140 remaining symbol observations or rewrite old source-only reports. Selector path/
value derivation, evidence freshness/ownership, final verdict, Runtime-root/Manifest admission,
new-cohort Store/CAS/crash and legacy product gaps remain open. Next reuse the existing isolated
`probe-astra-v3-claim-derivation.py`/reference lab with an explicitly reviewed Capability v3→v4
lineage; do not duplicate its engine or globally rename schema IDs to make old fixtures pass.

### 2026-08-30 — Selected-contract synthetic claim value derivation

New `probe-astra-v3-current-claim-values.py`, `verify-astra-v3-current-claim-values.mjs` and
10 focused tests. Reused `probe-astra-v3-claim-derivation.py` with explicit selected Capability
v4 support instead of another derivation engine. Default v3 remains explicit; unknown versions
and unanchored v4 are rejected before any read. No claim of rerunning the full historical v3
mutation chain. Extracted the existing Node value oracle without changing its derivation logic;
the old retargeted runner consumes the same helper. The program runner can return its already
loaded native schemas for this companion check, avoiding another materialization/load chain.

The Python probe independently selects the sole operational candidate of the exact checked
`ordinary-scan:admitted` Admission v5 checkpoint. Capability v4, recipe and28 ClaimTemplates
remain byte-identical to selected objects; only synthetic ordinary execution/evidence bodies
are retained in memory. Snapshot unchanged; no DB writes or target observation. The selected
Capability and instance-binding report remain d6ab5f44... and9bcda30f... respectively.

- Three cases: `4103`/complete, `9007199254740993`/complete, `4103`/partial.
- 28 claims per case; Node independently derives84 bindings and validates111 native bodies.
- 37 source-body reads per case; bounded Python output349582B under1048576B.
- Report `sha256:15c737d794791e88e96a7f951704bae7315c7391b17a32d230e94df0e00b2223`.
- Binding digests: normal `sha256:fc8ff6e7077d02e6dbbfcbb50d42ceeb6a095e4629bb8d19545a005651dc88a8`;
  wide `sha256:dee0299b806dcb77cd8b538cb1efdc68480525179d1ae2090197f40196c7b10c`;
  partial `sha256:0c3bcd778830724258bea91ce02269a14393bea8f5821b0b2fc3da03fdaf33d0`.

Python retains28 resealed-value,4 provenance and6 resealed-source negative controls plus missing
selector rejection without default. Node rejects native-valid/rehashed wrong values, swapped
provenance, duplicate/missing bindings and missing required output. Wide integers stay strings;
partial evidence does not become complete. Initial integration failed in Ajv's deep-equal helper
on strict-parser null-prototype objects (`a.valueOf is not a function`). Fixed only that boundary
with structuredClone after strict parsing; regression proves canonical-byte identity and native
validation. No relaxed parser/schema or dependency replacement.

Verification:22 tests/2files PASS29.64s before adding the version-guard test; final new-file run
10/10 PASS25.76s. Thus23 distinct focused tests across these runs, not a fresh aggregate pass.
Prepared seal19Node/17Python controls PASS;65config/208generator/2toolchain.
Source9965B / `sha256:64c3dcd5059fb1af75234f2460ca40e42a5ba5649a6c57fbc630dc9c216c8269`;
definition132031B / `sha256:c8a4d9af593180f3ce69b47bbca9572a5923038d31937472974ba09f3fb7a71f`;
envelope133056B / `sha256:a2f5397b92ebad1de8ecefc194c8ec8daa298fcb25cbce758d250a3d389440eb`;
independent `sha256:7e817b4986cb65d7a5b15a5b82b243ce833decbbbced1645c7671e85d06f75ae`.
Store-test source pin/count updated only; no full Store/aggregate/G2 rerun.

Actual synthetic value derivation is now proven for these selected contracts. Accounting proof,
goal Admission/semantic comparison, clock freshness, committed-event membership, frozen ABI
integration, Runtime-root authority, new-cohort Store/CAS/crash and final verdict remain open.
The140 other symbol observations are unchanged. No product/shadow activation or user/Safe/model/
real-target/network access. Next inspect/reuse existing accounting/goal/clock oracles with exact
selected-contract lineage, not another duplicate engine or unprepared historical materializer.

### 2026-08-30 — Selected minimum budget rejects the accounting workload

`verify-astra-v3-current-claim-values.mjs --accounting-budget` reuses the current selected-contract
loader, existing accounting engine and Node oracle. ProofBoundClaimSession now forwards explicit
v3/v4 selection to its base class; selected fixture setup resolves the original budget unchanged.
Legacy default fixture setup remains separate. No new engine or historical materializer.

The pinned budget object000079 is479 canonical bytes,
`sha256:6cf70db4c0fec39cfd12b2a665ef5215d72bee0eb128ee3c2e6bbb72afd8eb0a`.
It contains1 for each positive limit/cadence, depth0. Native schema acceptance therefore did NOT
prove that ordinary storage work could complete. This is a synthetic witness limitation, not a
discovered production configuration, and does not invalidate the narrower prior value derivation.

Actual selected-contract runs preserve Capability/templates/recipe/budget and the checkpoint.
Each resolves37 claim sources then39 accounting sources, rejecting at `maxFileEntries` in Python
and Node. The independent transcript summaries also expose all11 exceeded limits per case.
171/171/138 events,84 claim bindings/111 native bodies plus9 native accounting/clock bodies;
391086B probe output under1MiB. Three accounting rejections, zero accounting admissions.
Report `sha256:c2ca387d3e31e92c61d808e8b4dfe1eb153f11cc41506f65513d0c3ce4fcb3cd`.

The transcript-derived requirements below are only lower bounds for these exact synthetic cases,
not production defaults or real performance measurements:

| Budget dimension | Current witness | Largest observed across three cases |
|---|---:|---:|
| File / directory entries | 1 / 1 | 3 / 3 |
| Depth / UTF-8 path bytes | 0 / 1 | 1 / 9 |
| I/O operations | 1 | 29 |
| Resident bytes (fixture-declared, not measured) | 1 | 4096 |
| Frontier entries / open handles | 1 / 1 | 3 / 4 |
| Single response bytes / total response bytes | 1 / 1 | 77 / 458 |
| Monotonic elapsed ms | 1 | 1000 |

Single I/O duration and cancellation cadence both stay1 and do not exceed this witness. The
oracle preserves exact wide integers and partial output; neither becomes permission to certify.
It validates native bodies/digests/transcript/clock before counting the expected budget rejection.
Wrong clocks, rehashed false accumulators, missing transcript/cases, altered budget anchors or
truncated violation inventories cannot be disguised as successful rejection controls.

30 tests/3files PASS30.22s before adding the anchor-consistency test; the final11-test new-file
suite passes.31 distinct focused tests across these runs, not a full aggregate. A separately
labelled pure Node fixture control uses the old larger test budget and still passes its3 cases/
14 mutation controls; the selected-budget verifier rejects those same substituted bodies.
This tests the extracted common oracle validator, NOT selected-cohort admission or the full
legacy Python integration chain. Product/DB/G2 were not rerun or changed.

Prepared seal19Node/17Python controls PASS;65config/209generator/2toolchain.
Source10029B / `sha256:466fc988364f9193e64c20558d5bd689d3e4ee2938ef14e7e907151177ff7209`;
definition132238B / `sha256:9d0eeaa65ef5a0be438b0e24bd297d7e3cf7a349aa107273c6f0588b2f5ee661`;
envelope133264B / `sha256:0e8c4e45bc2b1381fa196067017a1a8ba53e34aa9fccaa4f02b1df377b6a2dbe`;
independent `sha256:16d5ed148c0d61e26edc6bb3efe41230866c953494ce2cf044d7b8c2f3124e89`.

#### Required next construction, not permission to rewrite the selected checkpoint

Read-only dependency inventory over the exact snapshot finds48 affected objects including this
budget: direct consumers are the budget claim template (`/claim/predicate/expected`) and
Capability v4; transitive consumers include VerificationRecipe and44 Admission v5 bodies.
This is a textual object-ID/content-digest dependency inventory, not typed authority proof,
permission, a complete future root graph, or an automatic rewrite plan.

1. Retain the current minimum budget as an explicit rejection fixture. Add a correctly accounted
   budget-exhausted/refused outcome separately; do not report a within-limits cancellation after
   an earlier budget failure or fabricate a dispatched receipt for a pre-dispatch refusal.
2. Author a separate positive synthetic workload profile as explicit source data with rationale,
   not `witness()` defaults. The old16-entry/128-I/O/1MiB/10s fixture budget is only a candidate
   test profile, not a measured recommendation or production default. Freeze its exact body/hash.
3. Construct a new memory-only candidate cohort first: budget→budget predicate/template→recipe
   and Capability→Admission references/digests/IDs, then dependent goal/execution/evidence bodies.
   Recompute by typed ownership and canonical identity rules, never raw global string replacement.
   Preserve every old object and do not imply that old admission evidence authenticates the new
   selected contract. Root/Manifest/Store membership and later persistence stay separate gates.
4. Validate native bodies, required program/instance links, exact selected budget, transcript
   accounting, cancellation/elapsed behavior and contradictory negatives together. Require a
   positive result AND rejection controls; this pass has only the old-cohort rejection result.
5. Any later retained fixture must have its own exact marked child onD:, realpath preflight and
   explicit new checkpoint/lineage. No overwrite of the current prepared fixture/DB. Goal,
   committed-event membership, real clock/broker admission, frozen ABI and final verdict remain
   open. The140 remaining symbol observations and real V2 gaps are unchanged.

### 2026-08-30 — Additive positive budget component proposal and accounting proof

New source `config/agent-architecture/astra-v3-synthetic-read-budget.v1.json`, independent
`astra-v3-positive-budget-candidate.mjs`/`.py` compilers and15 focused tests. The current value
runner adds `--positive-budget`, mutually exclusive with `--accounting-budget`. It reuses the
same exact prepared fixture/checkpoint, selected-instance checker and accounting engines;
no database materialization, real route, model/network/target observation or product activation.

The source profile explicitly captures the old bounded test values (16 file/directory entries,
128 I/O operations,1MiB resident ceiling,10s elapsed ceiling and all other dimensions). Provenance
and parent Capability/budget digests participate in its canonical identity. Missing dimensions,
non-integer limits, native-invalid zero positive limits or wrong parents fail; witness defaults
are never filled in. These are test parameters, not measured RAM/runtime performance or defaults.

Typed construction is additive and limited to a proposal for the ordinary-scan source case:

| New object | Required change |
|---|---|
| Budget | Explicit profile limits; new canonical identity |
| Budget ClaimTemplate | Exact digest predicate points to the new budget; selector unchanged |
| VerificationRecipe | Replace the one owned template digest; preserve the remaining set |
| Capability v4 | Exact new budget/template/recipe references and digests |
| Proposed Admission v5 | New proposal ID; selected Capability, target request, candidate-set and body digests |

Both compilers generate identical five records/references and recheck the deterministic route
projection from the existing frozen structured result. Node additionally checks all28 selected
claim instances through existing complete-reference validation. The new Admission is a PROPOSAL,
not an authenticated admission: target data is reused solely as a synthetic observation and
`freshTargetAdmissionRequired=true`. No old command/result is re-recognized; no real resolver is
called. Existing44 Admission objects and every old record remain unchanged. The previous48-object
dependency inventory would matter for a broad replacement; this additive proposal does NOT
claim to replace those objects, instantiate the whole Runtime root or close goal dependencies.

The memory lab uses the fixture's reference generation for compatibility only. New object IDs
are absent from the parent snapshot; neither generation reuse nor matching hashes imply Store
membership. The original minimum budget still rejects its workloads. A valid new proposal for
a different coherent profile is also rejected when compared with the selected source proposal.

- Profile `sha256:b931b72c82854bc2937bbdec6cafda77b3616060c234cfc934aab537a645b9ed`.
- New budget509B: `sha256:e2562f2de0c5e59f33ca14dace926681d2faf95e1c95fcc7cef38e632e33aa57`.
- New Capability: `sha256:9675283b389fcdf05d0f628be2a0abfd7652cc4c22fc87011cce60197bc61b8d`.
- Proposed Admission: `sha256:545791a08220d744e3b7c9e36f43fc3d07006f6dde79c22114e4a886252ba2e2`.
- Five-record digest: `sha256:f48c78dc66afd0f355e1f0a1e727595aac8c2d4ce9d0ad4f64b92d184582628d`.
- Instance report: `sha256:5889e4257e69fe1ab39986b10709091d6b68083dc294b1274c09bcffc4d36c1a`.
- Combined report: `sha256:d1e62bb8937359618311ab91efa6eea0a2c4c796444ca9abad79688ed5f069d6`.

Three positive accounting observations (complete/complete/partial),84 derived values,111+9 native
bodies;171/171/138 transcript events,39 source reads/case and98716/98740/98726 canonical source
bytes. Python rejects15 relational,3 transcript and6 temporal mutations; Node rejects14 controls.
Ceiling mutations now derive from the selected budget, not hardcoded old numbers. Probe output
437374B under1MiB. `syntheticAccountingRelationsProven=true` does not change the false authoritative
accounting/goal/clock/Runtime-root/final-verdict flags. Other incomplete branches remain unexecuted.

46 tests/4files PASS35.05s,15 new; old minimum-budget rejection, value-only and primitive suites
pass together. Initial integration reached successful accounting but failed strict report
serialization on `undefined` left in the summary. Fixed explicit omission of the bulky record
field; no canonical parser relaxation. Regression proves strict report serialization and the
separate record digest. No full historical chain, Store/aggregate/G2 rerun.

Prepared seal19Node/17Python controls PASS;66config/212generator/2toolchain. The new Python
compiler uses a dynamic relative loader, which the static dependency scan did not discover;
added an explicit seed and confirmed all8 required compiler/accounting dependencies are present.
Do not use a guessed count in place of path coverage. Source10154B /
`sha256:a7c7b57ddc4312cf55df47d37a382262eb208693bd5d23660d1616f3df606e37`;
definition133243B / `sha256:b4b10f25d33311ceefc8f0004ed61da0191456ce5a9f0b5ab39a79dadd9a2ab6`;
envelope134269B / `sha256:9e1fd1e53c7ccb48c8b93ada998577c2e8a10967f18c9f17eaabd7f730c51eaa`;
independent `sha256:8ea5c3f088e664b46b04050e3baa6170d3878b866465f08a10db2f126140d115`.
Store-test pin/count updated only; original DB2785280B/last write11:03:50 unchanged.

Next: a legitimate resource-budget refusal/incomplete proof (not within-limits cancellation),
then concrete goal/Admission/event membership against the proposed contracts. Reuse existing
accounting `limitWitness` semantics; do not duplicate a scheduler or fabricate a receipt for
work never dispatched. Fresh real target/clock admission, frozen ABI/root/Store/CAS/crash and
product acceptance remain open.140 other symbol observations and known real V2 gaps unchanged.

### 2026-08-30 — In-flight I/O crosses elapsed limit; returned data is discarded

The existing current-claim runner adds explicit `--positive-budget --time-limit`; time-limit mode
without the positive profile is rejected before loading inputs. No profile/new-component change:
the previously compiled5-object proposal and instance report5889e425... are reused unchanged.
Existing Python/Node transcript/accounting engines are extended with a closed mode, not another
walker. The native contract already specifies `time-limit`, `elapsed-ms`, `io-return` and forced
cleanup; no schema widening or additional product state was introduced.

Each73-event synthetic trace issues12 I/O operations. First11 take909ms each (9999ms total),
the final metadata request takes2ms and returns at10001ms against the10000ms selected limit.
Each individual I/O remains below the1000ms per-request limit. The last issued request and its
return check are counted; its metadata is NOT admitted as an entry. Two files are included,
zero child directories; rejected entry/I/O admissions are both0 because rejection was on return.

| Already included lengths | Late discarded length | Retained logical bytes |
|---|---:|---:|
| 3 + 4 | 4096 | 7 |
| 3 + 4 | 9007199254740993 | 7 |
| 9007199254740993 + 4 | 4096 | 9007199254740997 |

There are2 issued close requests and2 still-open simulated handles (root and last child). A
terminal job-exit observation releases those2; it does not fabricate additional close requests.
Tail order is fixed: return checks→limit refusal→discard this return→forced job exit→terminal
checks. Any late entry, wrong discard ordinal, false outstanding count, earlier crossing or
invented witness is rejected. Temporal durations and job exit are synthetic; real execution,
cleanup latency, Windows handle identity and Kernel attestation are not measured/proven here.

The retained proof/output/evidence chain is built against the exact selected contracts and native
validated.39 reference reads/case,84 independently derived claims,111+9 native bodies. All three
observations remain partial. Python rejects8 trace/relationship mutations; Node rejects10. The
generic proof subcheck also now requires time-limit detection no later than the finished elapsed
interval. Native-valid relabelling to within-limits cancellation is separately rejected by the
active time-limit oracle. Default legacy transcript mode still rejects forced-exit trace events.

Combined report `sha256:d2a52c99e94e2b7af4ffda059a8449ba48cbfc36facd96a1d030cfe606b40552`;
probe output425887B under1MiB. Per-case binding digests:
`sha256:fd8445a2005fc2218339985f652390b5cc31f0fb5a0a2618000e09cb88d789d1`,
`sha256:1abb35e183fe47f083ed5a105e90845bb7b2db438d0947bc4aba041c8fed65ea`,
`sha256:dd5eaf1be976d3c26d4feecd82f83a2cb2cf015c302ba49e3fc2d1052057d51e`.
47 tests/4files PASS34.65s,11 new, including positive-budget, old-budget rejection and primitive
regressions. Direct compact report also passes. The first integrated attempt failed due to a
helper name shadowed by an existing loop's `wall` string; renamed the helper `civil_at`. This was
a simulator implementation error, not a product failure or an acceptable rejected test outcome.

Prepared seal19Node/17Python controls PASS;66config/213generator/2toolchain.
Source10210B / `sha256:5bfe617f5106a5381ff60a50504090c9dc197710cd365a5947b0177edf15c9cb`;
definition133442B / `sha256:432c84170a7e0c8aff38c82831ad65a7341b9d02beb34f8f8eea88ed01f0537c`;
envelope134468B / `sha256:1c698f96d107621ad7a062c3ed746d21a79085b8de2f3d7156e8832ff672dd19`;
independent `sha256:3797b2f5e88925191caedde9ebdec2ec11274ac9f7122b2cdbc3f022cff40415`.
Store-test source pin/count updated only. Original DB2785280B/11:03:50 unchanged; no retained
cohort, G2 recapture, full Store/aggregate/historical materializer, product or user-data mutation.

Next prioritize goal/partial-policy binding against the proposed Admission, not merely more
independent resource labels. Existing `probe-astra-v3-goal-semantics.py`/`verify-astra-v3-goal-oracle.mjs`
already implement a local goal-policy candidate, but GoalSemanticSession hardcodes Capability v3,
and its setup creates legacy fixtures. Preserve explicit selected v4/budget lineage and derive
partial permission from the exact selected source, not a test `mode` argument or a new reading of
raw text. Correct stopping does not imply goal completion. Goal/source/committed-event membership,
fresh target/clock admission, remaining abort branches, root/ABI/Store/CAS/crash and real V2 gaps
remain open;140 unrelated symbol observations unchanged.

### 2026-08-30: selected-source partial gate, not whole Goal admission

`verify-astra-v3-current-claim-values.mjs --positive-budget --time-limit --goal-partial`
now feeds the existing goal-policy primitive from the exact proposed Admission v5 rather
than a test-selected mode. Five native source bodies are checked once (45143 canonical bytes):
Admission, its MatcherResult, accepted command, matcher descriptor and selected Capability v4.
The old frozen command/result remain unchanged. The existing owner-local clause verifier
supplies fact membership; partial permission is then derived only from bound `partial-allow`
or `partial-forbid` facts. No permission fact means `forbid/default-forbid`. Both draft and
candidate must equal this derivation, including provenance labels. Descriptor bindings and
the Capability's embedded full descriptor are compared in their correct DTO roles.

Node and Python independently derive the same selected source binding and three outcomes.
The existing time-limit observations (7,7,9007199254740997 bytes) all remain locally blocked
with `partial-not-admitted`. Native-valid coordinated draft/candidate permission inflation
does not override the frozen source. Node also joins accounting proof identity to the exact
receipt/output measurement/evidence, input Capability and clocks before using completeness;
substituting another valid case with the same partial status is rejected. A complete observation
only yields `complete-observation`, not a certified terminal result. Denial fields in this local
report are a projection, not a full native CompletionDenial bound to a Goal requirement.

Evidence:48 tests/3files PASS35.48s (23 selected-policy,10 primitive,15 positive-budget), plus
the11 unchanged time-limit tests passed in the preceding run. Python3 native-valid resealed
policy mutations rejected. The first direct attempt exposed an incorrect comparison of the
embedded full matcher descriptor to its reference DTO; corrected by comparing full descriptor
to full descriptor. The first test run then had one wrong expected diagnostic (`resolve-target`
instead of the actual whole-ref rejection); fixed the expectation, not the gate. Final direct
compact report passes:429245B Python output,84 claims/111+9 accounting bodies unchanged,
39 source reads per value/proof case plus5 policy bodies once. Report:
`sha256:1fc26e3f4c97195a0038bad464b4a87a86880e5e4b9b873cc8b2ac71b88191b9`.

Prepared seal19Node/17Python controls PASS;66config/214generator/2toolchain. The dynamic Python
goal dependency is explicitly seeded; five consumed executable dependencies verified present.
Source10333B / `sha256:166b9f15b35f9e436c6444618e36c50d606464477af68b78cc12bd47f3929be1`;
definition133652B / `sha256:c9ef8d4f7a632650299f6be3deb7b8769f0963c377435af4456275aee0aca8da`;
envelope134678B / `sha256:c0dc018d284197be9fd9ecdbe45c00130763d20b6536c7bfff48984127152e6a`;
independent `sha256:16c606320a529a5f51ac03eec1eff9ca3ebf80d5895032bfc1e612fafe9ca0b7`.
Store-test pin/count updated only; no full Store/aggregate/historical materializers repeated.

Still NOT proven: whole Goal/GoalSemanticBody source membership, selected input/target/
authority/Certifier/runtime-root coherence, committed source/Store/CAS/crash, broker or clock
authentication, real V2 predecessor/schema/count gaps and Computer Use. The legacy
`GoalSemanticSession`/`goal_fixture_setup(mode)` remains a v3 local fixture, not a selected-v4
Goal compiler. Next: inspect the exact root-to-Capability/Certifier and source-to-Goal edges
before constructing the selected-v4 Goal candidate; do not select the first Certifier record,
invent authorization by copying a witness, or silently retarget the frozen command/root.
Keep current positive proposal additive and old minimum-budget rejection intact.

### 2026-08-30: exact historical root recovery and mandatory new source cohort

`inspect-astra-v3-selected-goal-foundation.mjs` uses the existing marked/checkpoint loader,
then reconstructs the historical in-memory graph from prepared inputs only. This bounded
reconstruction was necessary to distinguish a missing retained object from an unavailable
or incompatible historical dependency. It is not a historical full-verifier/materializer run,
Store merge or new acceptance. The source-selected runtime is absent from the replay DB but
matches the reconstructed root EXACTLY, including all ref fields, schema/content digests and
2329B length: `sha256:79dc8265a9428858d528a959b8b9b9690a427a9e1ee13e49355697f1cd518433`.

Four historical native bodies/40898B are checked in Node and an independent Python process
that reloads the pinned replay anchor itself: runtime v3, its Capability v3, exact Certifier v2,
and that Certifier's terminal policy. The old Capability digest is
`sha256:d09dfc5a21478ad28d3a38a3e3744ce3c664032e122a88458f5f7ae5ea6624bb`, not the ordinary
selected v4 `d6ab5f44...` or positive proposed v4 `9675283b...`. Its Certifier digest is
`sha256:b905212fb39fd005ed6bbddde3ce0e1fab393267b367e8075c7b0301dc11e7d3`;
both implementation and temporal-comparator hashes are all-zero witnesses. The replay AND
historical graph contain zero GoalContract v2 / GoalAdmissionBinding v2 / GoalSemanticBody v2
instances. This is evidence about these synthetic graphs, not a newly discovered product bug.

The target is the current ABI's Profile v6 / Manifest v7 / RuntimeFeatureSet v7 wire-schema
cohort, still within Astra V3. Schema roles now come from the ABI owner's exported constants
and are checked against its derived schema closure; the ABI digest remains
`sha256:0aa56209772ed7396226011883e0d49452b0fb3f482d65dc4116bcdfaaab17e8`.
The intermediate component RuntimeFeatureSet v4 is NOT the current whole-Goal target.
`requireSelectedGoalRuntime` is a component precondition only: exact current runtime role,
full selected-Capability ref/digest, current manifest role, runtime-selected Certifier without
zero-hash witnesses, exact Certifier-selected terminal policy. It does not authenticate the
manifest/authority or attest a nonzero implementation hash. White-box component tests isolate
these relations; their DTOs are explicitly NOT new native/admitted runtime objects.

Required work order is now concrete: coherent non-retained current root/manifest/authority/
Capability/Certifier graph → NEW synthetic accepted command bound to that graph → its matcher
result and fresh synthetic target admission → Goal/source/semantic/input bindings → joined
evidence/completion verification. Keep old accepted command/context/result/checkpoint immutable.
Do not attach the old source identity to a new runtime, select the first Certifier by schema,
or call restored historical witnesses executable implementations. Creating this transition
candidate remains in isolated scope; product/shadow activation is still prohibited.

Evidence:48 tests/3files PASS33.26s (15 foundation,23 selected-partial regressions,10 primitives).
Mutations cover stored metadata/body changes, missing exact Certifier, other generation,
legacy/intermediate runtime roles, wrong Capability, both zero-hash witnesses, and false
authority claims from nonzero DTO hashes. Final direct report:
`sha256:bb052a3d9a8160b2221c56e8f6853de40bd3a22cb9b2b2692e2ac74d477b1678`;
independent `sha256:0b2e8e0a590041157abf8db85e501ee2d8ed8bf6e799580813d3396bbe7bc275`;
1131454B independent bounded input,4 native bodies. One manual compact invocation had a
mistyped checkpoint and correctly failed preflight; corrected command passed, DB unchanged.

Prepared seal19Node/17Python controls PASS;66config/217generator/2toolchain.
Source10462B / `sha256:1b0eafcd288acc2b926072f2d80f96b80c95ea30f848ce89c9c722c9d9542237`;
definition134280B / `sha256:2cfd73745606c61c60a7cf050a2e841d5490033db1fafab7de89c30723eb2f13`;
envelope135306B / `sha256:0729f12af4e25a1062589d770d1830997caa4280a53af4331eb67069f5436fd6`;
independent seal `sha256:a854f5eedfc90eadfae2530ef228e9d162c781cf1851fa753d3bbf5a9ea24815`.
Five changed executable/test dependencies verified included. Node syntax3/Python AST1 and
whitespace checks pass. Store-test source pin/count updated only; no full Store/aggregate/G2,
new scratch child or retained writes. Original DB2785280B/last write11:03:50 unchanged.
All root/implementation/committed/whole-Goal/product acceptance flags remain false.

### Current component cohort evidence (2026-08-30)

Implemented the non-retained assembly stage using current prepared ABI/schema derivation,
not a reconstructed historical root.42 records:38 selected Capability dependencies and4
Profile6 program shards.66 schemas,157 programs,1830 instructions,41 operations; P6/M7/R7
are schema versions within **Astra V3**, not another product runtime generation.34 exact
source records are reused;4 positive-budget proposal records and4 shard records are new.
The proposal's stale-root admission is deliberately absent. The candidate is1879933B in
memory; its record bodies total701755B. Capability-only verification consumes38 bodies/
93298B, while the existing target-inclusive40-read verifier retains its checks.

- Candidate: `sha256:11720b13880d18e4b8648b64e41e82cb6562c2cdc309371d524ee0adf98edc39`.
- Report: `sha256:340f584020e7e98afe7f2fccdf5e19491f8bf422ff63d9a1be523d37212e3b91`.
- ABI unchanged: `sha256:0aa56209772ed7396226011883e0d49452b0fb3f482d65dc4116bcdfaaab17e8`.
- Schema binding: `sha256:2e69abe2c457fd44b96e6abfa115e8639a41fdbd31a0c9c50491d9dde497c0ff`.
- Tests:37/2files PASS32.50s:18 new assembly controls and19 existing reference-reader
  controls. Includes full40-read regression, byte-preserved sources, missing/duplicate/extra
  objects, old Capability substitution, generation/schema/identity/shard-length/body
  tampering, unowned nested refs and false activation/root flags. Direct cheap runner PASS.
- Source seal10593B: `sha256:ba147d241d66dc7350a756a89ba40bfb7e9fc2b68ea74c1b9fdebaa3028fa2ea`.
- Definition134901B: `sha256:31877b74ea37006be736c7e1220f203aa00ebe1f45dbf21567715966f3b4987e`.
- Envelope135927B: `sha256:ecaa7651a5fa7a0d3d819b51397c57cb4f516652f7566f41d8259de16bb4df6d`.
- Independent seal: `sha256:c5332295698938aff2c805f90420a399bbba7d9a922b78dc7e2d7e3c6ec7dfb1`;
  19Node/17Python mutation controls,66config/220generator/2toolchain. These are source-seal
  checks, NOT an independent execution or whole-candidate semantic certification.

Reproduce without full Store/materialization/G2 chain:

```powershell
node scripts/architecture/verify-astra-v3-current-component-cohort.mjs --prepared .test-tmp/astra-v3-authority-root-store-proof-g0xKSt/prepared --db D:/Monarch-test-tmp-astra-v3/astra-v3-native-target-replay-5HFxLG/admission.sqlite --checkpoint sha256:0d12c9cf66c33b4b5d5f3c0364dbe06e560591a81ee79c78cebe71bf987fa85d
```

Next blocker is substantive: native ID-rule shard and authority-root semantics are not
closed. Do not install the prospective exact-selector rule artifact into an incompatible
legacy grammar, manufacture the fifth shard, or use an arbitrary hash as Certifier
implementation identity. Finish those contracts/implementation in isolation, build root/
manifest/runtime, THEN issue a new synthetic command acceptance. Existing frozen commands
must never be reparented. Store/CAS/crash, authenticated broker/clocks, whole Goal and
actual V2/CU fixes remain unproven. No DB writes or product activation occurred.

### Prior-event owner binding and synthetic-prefix execution (2026-08-30)

The current42-record component candidate is unchanged. Its56 prior-event owner references
are now checked against28 exact source-required operation pairs. Node/Python separately
derive those pairs from the pinned envelope source and agree on their digest. Both execute
exact predecessor/correlation selection for28 native synthetic event cases. Other symbol
observations are counted from current programs (78 non-event variants +6 local slots),
not decremented by a readiness flag. This is not full-root authority or Store proof.

- Contract: `sha256:fbcf09f742de07e15c7fef31d4c60b638b58c933d47ac875c2cc56ba6cd9f17d`.
- Required operation bindings: `sha256:341ad1beca2c4ce73ad4dd9d28f4162c82dd5f711a246d2f1e1308ca692c772c`.
- Program report: `sha256:c17879fdada775f754e4b5ec80b617fffc2f5394968255d09130b2676dc0701d`.
- Independent evidence: `sha256:e412c6cd50c887dc58854e31bd4302bd75366e1d64b866beed7cb0e2dddd588a`;
 1737913B bounded input/140635B output;28 native cases,7 rejected prefix mutations.
- Node observations: `sha256:d415ee27fb9b489c3662a6cc17eefed571f179d1c77693b0822631cfd5d6b70b`.
- Combined report: `sha256:64bfb928a9facb7a422b64c7edee7ffc004fe2f0395d90bba9619e1de732ee47`.
-42 tests/2files PASS34.72s (25 new,17 existing event bindings). Coverage includes removed/
  reordered operations, missing/duplicate scopes, wrong fields, wrong causal/correlation
  identities, same/future commit, duplicate events, canonical/overflow/unsafe ordinals,
  commit aliases, generation, native body/payload integrity, occurrence index and frozen
  input ownership. A strengthened newer-unrelated-event counterexample is checked separately.
- Source seal10714B: `sha256:31d5a0510466b2b3d3a0fad04ba6ad2f369ee6e3d2790eedf1650c7e8fba3022`.
- Definition135508B: `sha256:d17014c7fab4991fcdd598f06bac099d3d57b297f901deffe8c3a384072db400`.
- Envelope136534B: `sha256:f7d1fa9030d9c04a5043b5ae4b2e1696f04ad29c31b21af78d95ae341e45caad`.
- Independent seal: `sha256:00c883650819808bc2df251983f5f6548017371d23b1b4915300a9d97f809cdd`;
 19Node/17Python seal controls,66config/223generator/2toolchain.

Run the same explicit prepared-input command from the preceding section with `--prior-events`.
No DB writes, historical-root materialization, G2 recapture, model, user target, Safe, network,
product/shadow runtime or full aggregate run is involved. Initial failures were preserved:
the old witness generator lacks the command-or-event causation regex, so a valid explicit
fixture command ID is supplied before validation against the unchanged native schema;
two mutated instruction fields are already schema-fixed, and unsafe JS numbers fail at
canonicalization. Tests now report those actual boundaries instead of calling them native-valid.

Next: bind the78 non-event variants and6 local slots to their exact schema/program scopes,
then reconcile native ID/root grammar and complete real isolated Certifier semantics.
Keep3617/3651 and prospective root-selector incompatibility explicit; no count-only repair.
Actual committed-prefix authenticity, commit/state semantics, Store/CAS/crash, new source
acceptance, whole Goal and real V2/CU defects remain independent unclosed obligations.

### Current variant/local bindings (2026-08-30)

Use the explicit prepared-input current-component command above with `--symbol-bindings`.
Direct run PASS:78 native endpoint selections;6 source scopes/11 branches;9 projection
scopes/6 declarations/24 consumers;56 prior-owner links reused,140 selected observations.
Candidate remains11720b13...; all-instruction/root/whole-Goal/Store/product/dispatch flags FALSE.
Python independently verifies branch-index/native-witness grammar only, not program scopes.

- Combined report: sha256:34d45b96ddeaa0eb028fc2e0f6bd362bcaf4b40f4adcef1db91aa138a9b59437.
- Variant bindings: sha256:c57c6d25f1a4f45ed0ea2143f145c9eb2287f00e1fe9ac5a46f37eb9a7400654.
- Slot bindings: sha256:f8c1b7519e4cae7040346d38b4363ccf9fe78d6927607c8a51b2b53186b9e930.
- Independent: sha256:53b6c3bd5dc15dc2370d2476a8e5967397af178edd75a47fd6ddfaa3e4126edb;
  input1083590B/output36552B.
- Exact existing overlay source: sha256:d709bf244ee6effa2ff5c6e4897b8220419ce426f753318cf9fded47014a7292.
- Tests22 new PASS41.06s;18 assembly PASS separately. First combined run18PASS/22SKIPPED
  because generic Python witnesses duplicated unique claim bindings. Corrected witnesses,
  a shadowed loop variable, and the command operand comparison field; no failed run promoted.
- Evaluator preflight tested before any resolver read; base/unprefixed and overlay/prefixed
  paths reach first resolver. Full historical frozen-reader chain NOT rerun.
- Seal66config/227generator/2toolchain,19Node/17Python controls PASS.
  source sha256:07914e73eee2e52e72b2a63830a7d2fe0d65b3931846e7413b0309d80c12eb10;
  definition sha256:adc245c8bc6babebfba1522c6b6dedf8f2aaf869d1e8701b41ed8f1422c8b6b8;
  envelope sha256:4c182b1a7aa9d1bb8f254d7f17e205b717ea9f97d4c139bfa0a6691f8997f18c;
  independent sha256:1ee9d3605c884030be7dc44eab188b89b65b427b7d5387dec30853f0ad9d6af9.

Remaining critical path: native ID/root grammar and complete coverage, implemented
Certifier, NEW coherent acceptance, then whole Goal with failure/recovery. Old source
reports keep their scoped unresolved counts; this checker does not rewrite their evidence.

### Native five-shard ID/root bridge (2026-08-30)

`verifyCurrentNativeIdRootClosure(prepared,db,checkpoint,true)` returns
`{candidate,report,verify,selectRule}` from the same pinned prepared-only route.
CLI: same explicit current-component command above, with `--id-root`.
It does NOT reconstruct historical roots or write the synthetic DB.

- Wire cohort Profile7/Manifest8/Runtime8; native binding ABI2. Product remains Astra V3.
- Actual ID shard3651 legacy +1435 final-root structural rules =5086 total; four further
  native program shards,157 programs1830 instructions,66 schemas.
-1435 includes the four new root-rule-container ID fields; not the old1431 blindly appended.
  Exact closed false mintsOpaqueId metadata excluded from ID count, with constraint checking.
- Source pins: prior ABI0aa56209..., external binding2e69abe2..., rules9bcdf630...,
  retained117 rules sha256:d34fb320dc83410f9e5708408364b7e17296c318f53d3a86b625e0b0e82ad024.
- Report sha256:add37793ab20bfd06a7a3f1db77e92d5a2ee057bc1f25959df35700427f96b4c.
- ABI sha256:bed71c1a04264d4a0b284644fd2c150c0f80462162937c0e5040cf6cabee24cc.
- Schema index sha256:d72094ef1b63e0e5f36c785bab7d5925f5e830500ee9ffe2ff24d0de77181b57.
- Final registry sha256:8995d31ee8cc58a07694f441d8ca006ce9c753b1b5b72c307d0a1098f13ef264.
- Selectors sha256:fb8947fb6dc2631a2b75a697d07c40a9ff32f80b9e10dc2228dc2c3245ee7c5a.
- BOTH rule arrays sha256:2bef902b487fced7a9981303efbaa083817414cf48f6e3182ddf603327ae6bb6.
- ID shard sha256:529cbefcbbfacd92b8d7968ad8bc1c901ed17753840359833c39d8741b54da0f.
  Bytes by ordinal:2849727,22377,496969,65277,23834; all below4194304B.
- Prior152 native enum failures are resolved in the NEW legacy-rule grammar. Existing
  Profile6/Manifest7/Runtime7 component11720b13... is unchanged, not silently promoted.
- Direct runner PASS; initial15 focused tests PASS57.79s. First run15SKIPPED because boolean
  metadata was misclassified by name; corrected exact policy exclusion, not a hidden waiver.
  Expanded run39PASS/11SKIPPED91.74s (20 new +19 ownership passed;11 old candidate tests
  skipped by a30s setup-hook timeout). Setup ceiling increased locally to60s, not product
  deadlines; isolated old-candidate rerun11PASS33.36s. No claim of a single50-test green run.

Remaining: construct correctly selected root/manifest/runtime instances and source-owned
digest/guard semantics; implement/attest the real Certifier before NEW acceptance and whole
Goal. Existing readers/schema constants/hash-input assumptions need explicit ABI2 support.
Do not pass the new shard through old legacy-array-only hash logic or alias these bodies
into the old accepted command. Structural native acceptance is not semantic authority.
The229-source prepared seal remains a historical-source envelope, NOT proof that this new
five-shard cohort is retained or admitted; Python seal verification is not an independent
verification of the new bridge algorithm.

Current prepared seal:66config/229generator/2toolchain,19Node/17Python mutation controls
PASS. Source10897B sha256:676a967a987fd904525e2752bd7c41253736a3fb979db0655adea2da041465af;
definition136733B sha256:41e44ff7a9ab5190d30daaf4ef6a4bc8e4629c41b763ff42f07a4195f476a29a;
envelope137759B sha256:ac3b218d989eceba89a54b0f962a8c6b7dcfa327acb02d72de8b0e7a1a2ab3b1;
independent sha256:0fdb5f087e8fab43931f749aec599aa4005b53070a6414ad0056011d0c3d5ed8.
Store proof test source pin/count updated only; the heavy Store chain was not rerun.

### Native authority root instance and frozen six-body readback (2026-08-30)

`verifyCurrentAuthorityRoot(prepared,db,checkpoint,true)` returns candidate/report plus
the pinned bridge and reserved source object IDs. CLI: existing explicit current-component
command with `--authority-root`. No historical root reconstruction or new scratch files.

- New synthetic Profile7 root object object_09a51f3f3bc1864814d4edc7b1,5335B.
  Body sha256:f8cfde7d7059edb14e881d1c0881768c72ecd8e0e8ea53101386f037cf96bdac.
- Root schema sha256:d9515565d5dace3e4255753c875c2c87799f7e2a38d36d6a9bf5e1973a8945db.
- Descriptor index sha256:eab3ffb9fba27138699e1f134e89b1da40b0f6753cac62b9a31ece396c85bb7e.
- Captured candidate sha256:493fbddea5b23c60d920e504836d9761ec852b8dd78c70f68e4b042f5c538ccf.
- Report sha256:f80434b265cbe9a727f57637cd468e1098686324a5cb0c72d8779e3cae8cac02.
- Exactly6 native body reads/3463519 canonical bytes;5086 rules157 programs1830 instructions.
  Synthetic epoch0; no retained epoch advance, Store IDs or committed membership.
-22 tests PASS70.63s, direct runner PASS. Exact record inventory, selected-root identity,
  schemas, ABI content, both ID arrays, descriptors with/without refs, generation/length/
  classification/purpose, resealed substitutions, collision rejection and capture isolation.
  No independent Python root-algorithm proof or product resource-budget acceptance.

Source review of `simulate-astra-v3-authority-root-store.py` reconfirmed historical
`guardRules/stateTransitionRules/commitInvariantRules=[]` and fabricated
`digest-rule.multisegment-pointer.v1`. These were witness data, not a source-authored
execution policy. Do NOT transform that historical Manifest into a new production-like
one just because it validates. Protocol section5 closed state/commit/guard expansion
tables (near `guard.interaction-create.v1`) and the pinned event envelope/variants are
the starting contracts for explicit reviewed lowering. The JSON definition currently has
8 relation names, not the complete executable Manifest mapping. Invocation reducer and
completion-store simulations may supply focused regression evidence, not substitute
authority. Correct Manifest and real Certifier must precede a Runtime object/new acceptance.

Seal66config/231generator/2toolchain;19Node/17Python controls PASS, all3 new/changed
executable/test paths covered. Source10957B
sha256:e67183d99241a607280495c0451cdbd04ddde2a9af308129f18814356e6eadd9;
definition137139B sha256:33a6e20a23a75e8936f6213d302a64ce90cdffaca0b871f04c21203365fa2333;
envelope138165B sha256:3a38ed488ba2bcb5514622594fb1d2188aef7746e513b69ca4b07d8ab0259e59;
independent sha256:03dd3955fab3eea7ac5dec4b191a583b88632c9c1b7e5c7c8f2ce8d771f04e3b.
Only Store-test pin/count updated; no full Store/aggregate/G2 rerun or product changes.

### Core state policy and bounded symbolic commit projection (2026-08-30)

New explicit source `astra-v3-core-state-policy.v1.json` and compiler/session
`astra-v3-core-state-policy.mjs`; no prepared input or database needed for these pure tests.
Direct `node scripts/architecture/astra-v3-core-state-policy.mjs` checks source/compilation
and prints bounded metrics. It is NOT an execution trace or full native-event admission.

- Source sha256:d73613830ab73f8e621f451d4a1ca794c60952906cc2c1c0fc0d5f982e0e4efd.
- Compiled policy25981B sha256:9ddc43aa4fd34732b344b09239587e58b2f206e3730963470163d937199a3cf8.
-40 variants/guard relation descriptors,42 state rules,30 exact shapes,12 source-derived
  Invocation transitions,8 relation kinds. No generic wildcard or queued state.
-31 new tests PASS583ms initially; final50/2files PASS1.39s (31 state +19 ownership).
  Full symbolic happy/partial/blocked lifecycles, Interaction/follow-up, cancellation,
  failure, unknown dispatch, missing/reordered/extra suffix, stale/malformed revision,
  source tampering, work caps and cross-machine rollback covered.
- Inputs explicitly `synthetic-core-commit-symbols`, with variant/reason only. They do
  NOT attest native payloads, retained owners, receipts, evidence, certificates or Store.
  Report keeps nativeEventAdmission/guardBindingsExecuted/manifestReady/dispatch FALSE.
  A completed projected state is NOT certified execution success.
- New isolated policy requires settled Invocation for evidence/completion and input/evidence
  integrity failure handling; it is an explicit candidate prerequisite, not proof that
  all real guard predicates or every product recovery path have been implemented.
- Next native-body adapter must derive variant/reason from the pinned full native body,
  check complete commit metadata/digests/refs and connect exact guard/program bindings.
  Do not turn the symbolic helper into a second authoritative journal or accept caller
  booleans/labels as completed verification.

Seal67config/233generator/2toolchain;19Node/17Python controls PASS. Source11013B
sha256:07baec07908a8f7538146b8733dabecf2398820571f75f960b999e4988e1f561;
definition138014B sha256:46a145c62ae5021b0f1bf7da716f318445e2add2a5b28cc00c90ad86ceab2187;
envelope139040B sha256:d1963047b2269d32e789ff7ef578ae0f6396c8ddc987b1c78fb2bea4d0f6403a;
independent sha256:953f256ab07671c27de406ca186d471d874313df759d47c55161b2a11a8e3705.
This independently checks the source envelope, not a second state-reducer implementation.
Store-test pin/count only; native registry stays66 schemas. No heavy Store/G2/full chain.

### Native-body whole-commit state projection (2026-08-30)

- New `astra-v3-native-core-commit.mjs` derives variant/reason/shape from full native
  bodies and feeds the existing atomic core reducer only after whole-group checks.
  No product source, schema version, Profile7 root, Manifest or Runtime is changed.
- Pins the actual four unchanged native schema bodies (Event2, projection2, group2,
  Ref2). No empty Ref shim and no full historical cohort rebuild. The shared
  `loadMemberFixtureSnapshot` extraction retains the existing exact realpath,
  parent pin, marked read-only SQLite export and full checkpoint verification.
  Old `loadMemberFixtureContext` still returns66 schemas,106 cases/212 selected
  reads; direct regression confirms the four schemas are byte-identical.
- Checks native branches,30 exact shapes, payload/group digests, aggregate identity,
  contiguous sequence/revision, index/count/shared metadata, intra-group causation,
  command/event/commit uniqueness, correlation and Invocation identity/state/revision.
  Rejected groups leave both FSMs and every adapter counter/ID unchanged.
- Full native-shaped normal path:12 groups/15 events, Invocation settles at revision5;
  verified/partial/blocked branches and all30 shapes/40 variants exercised. Focused
  `native-core-commit`55 + `core-state-policy`31 =86 tests PASS7.00s.
- Adapter descriptor1192B,
  `sha256:1e2c89a8863ef631018d8de815562672bcc938ced98d3df976c9d8b50fba7c2a`.
  This hash identifies the descriptor; implementation bytes are covered separately
  by the candidate-definition source inventory, not attested by this descriptor.
- Initial failures were real and fixed: malformed checkpoint literal; test witness
  lacked raw-sha256; test expected Invocation revision6 instead of5; implementation
  guessed `interaction_` instead of native `turn_`. Schema-derived stream validation
  replaces that guess; native schema pins/validation were not relaxed.
- Still false: native admission, resolved ref contents, authenticated prior causation,
  receipt/certificate truth, guard execution, Store, Manifest readiness and dispatch.
  Tests intentionally use full-shaped unresolved references. Internal first-event
  predecessor must eventually be selected from authenticated prior commits; a lexical
  `evt_` check is not membership proof. Existing G1/G2/storage/CU gaps remain open.
- Next: exact guard-to-program set/hash/scope mapping and receipt roles, authenticated
  prior-event selection and referenced-body validation must compose with this adapter.
  Do not promote the reducer or this native-shaped flow as a whole-Goal PASS, nor
  reuse the historical empty/fabricated Manifest or placeholder Certifier hashes.

### Exact event-program execution before native state publication (2026-08-30)

- New `astra-v3-core-event-programs.mjs` composes the exact114 existing event
  programs/1376 instructions/12 operations with `astra-v3-native-core-commit.mjs`.
  All40 guards receive event-program mappings for44 occurrences, pinned by complete
  set, program ID/content and scope. This does NOT claim all semantic guard roles.
- Ten unchanged native schema bodies include complete command-owner closure. No
  new schema versions, authority root, Manifest, Runtime or synthetic DB objects.
  The114 event bodies are explicitly unchanged under all current native retargetings.
- Owns a private multi-aggregate prior index populated only after a full group
  passes both programs and native reducer. Unknown/current/failed-group predecessor,
  wrong correlation, reused globally allocated IDs and wrong native owner operands
  fail before publication. Exact older owners are allowed; no latest-event fallback.
  Keeps only compact prior metadata/ID sets, no complete event bodies. Global lab
  bounds128 groups/512 events; no prefix/ordinal/program-list callbacks from callers.
-35 new tests +55 adapter +31 reducer = **121 PASS20.02s**. A dedicated test executes
  all114 programs and all1376 instructions across30 shapes/40 guards. Linked normal
  Interaction→Execution→presentation uses15 groups/18 events, two aggregates; still
  native-shaped witnesses, not genuine completed work. Late reducer failure proves
  no ID/prefix/counter publication; successful retry uses the same original input.
- Shared test-only native fixture generator extracted and old55 tests independently
  passed6.41s. Targeted2-test smoke passed before the full run; no failing test run
  in this pass. Other tests intentionally filtered in that smoke were not claimed PASS.
- Binding descriptor67359B,
  `sha256:233f4acb81c26270ce5d71b2b05f5ef6001f05bea6d21e6779365a918a17835f`.
  Implementation identity remains separately in the source seal. No independent
  interpreter proof or product performance/durability evidence is implied.
- Next: bind exact referenced bodies, especially accepted-command-receipt roles,
  Invocation snapshots and completion authority, into the remaining guard checks.
  Private synthetic prior membership is now executable; persisted/retained prefix
  authentication, full guards, whole Goal, real V2/G1/G2/storage/CU remain open.

### Ingress body/receipt composition verified (2026-08-30)

- `astra-v3-ingress-receipt-bindings.mjs` requires four exact native body records per
  submit/follow-up, derives command owner through the full ref and checks receipt,
  dedupe, scope/context/fingerprint and event projection before atomic publication.
  Independent caller owner, altered reference metadata, fully rehashed unrelated
  bodies, duplicate keys/command IDs and later program/reducer failures are rejected.
- Verification:54 ingress +35 event-program +55 native-core +31 state-policy tests =
  **175 PASS,33.03s**, serial files through the pinned Node wrapper. An earlier run had
  one5000ms negative-test timeout; cheap identity-source rejection was moved before
  core compilation, without increasing timeout or weakening semantic validation.
  The lost pre-refresh process handle was terminal/missing; its result is not claimed.
- Definition seal67config/241generator/2toolchain;19 Node +17 independent Python
  mutation checks PASS. Seal source `7e3e7215...`, definition `a59e4d82...`, envelope
  `fe801be7...`, independent evidence `b09af693...`. No retained authority change;
  the full Store suite was not rerun. Independent sealing is not semantic certification.
- In-memory diagnostics confirmed the NEXT gap: distinct execution aggregates can
  share an Invocation ID and reference nonexistent Invocation snapshots. Both remain
  `nativeEventAdmission:false`; do not promote this to a completed Goal. Next implement
  exact snapshot bodies/transition projections, immutable request continuity, global
  Invocation ownership and rollback, then receipt/result and completion authority.
- No V2 recapture, product/shadow activation, real targets, model/network or Safe data.
  Provisioned synthetic principals do not authenticate actual callers; durable retry,
  crash/CAS and real Computer Use acceptance remain separate work.

### Invocation snapshot composition verified (2026-08-30)

- New `astra-v3-invocation-snapshot-bindings.mjs` makes actual native Invocation2
  bodies mandatory over the ingress-bound session. It closes missing snapshots,
  cross-execution Invocation-ID reuse, mutable requests, changed attempts and receipt
  reference substitution; full-body and ID publication rolls back on later failure.
- Nineteen exact schemas, all12 transitions, latest full snapshot per Execution plus
  common ingress/snapshot identity hashes. Direct trace:15 groups/18 events/six snapshots,
  ten declared objects/62687 canonical envelope bytes, synthetic settled5/completed.
  This is not a real Kernel dispatch, authenticated receipt or a fully admitted Goal.
- **229 tests PASS36.74s** (54 new +175 lower-layer), serial files/pinned Node.
  First attempt failed before tests with V8 Zone Allocation OOM. The new validator now
  reuses referenced validators (`inlineRefs:false`); no native schema weakened or
  heap/timeout raised. The next run had51 PASS/one invalid positive-control fixture;
  its impossible state transition was corrected before the final five-file run.
- Seal67config/244generator/2toolchain,19Node/17Python negatives PASS; source398004ed...,
  definitiond66f5fc3..., envelope6b1aebfb..., independent3ead26ed.... No historic Store
  suite, V2 recapture or retained authority regeneration. Source seal is not semantics
  certification; DB/input checkpoint unchanged and no additional scratch created.
- Next: reuse native receipt/result contracts and existing result-admission projection
  semantics, not target-resolver receipt fixtures or schema-name-only promotion of the
  older Invocation simulator. Full receipt/result/Goal/authority/Certifier/durable Store
  work and real agent/Computer Use acceptance remain open. Product/shadow stays off.

### Kernel receipt/result projection composition verified (2026-08-30)

- New `astra-v3-kernel-receipt-bindings.mjs` resolves native Receipt2/Output3/Proof3
  before observation, binds Invocation/attempt/key/capability/input/outcome and computes
  a private output-copy verdict. Mismatched output cannot advance to checked/settled;
  native-invalid immutable records fail before any receipt becomes visible.
- All seven receipt branches (completed and three optional-diagnostic pairs), exact
  refs/IDs/digests, missing output/proof, fully rehashed receipt/output substitutions,
  contradictory outcomes, late program rollback, private verdicts and caps covered.
  **272 tests PASS52.33s** (43 new +229 lower-layer, six serial files/pinned Node).
  Initial38 PASS/3 failures were unsupported diagnostic MIME witness generation;
  test-only witness now supplies valid text/plain. No production/schema weakening.
- Shared Invocation fixture gained an optional test-only initializer for the real
  output schema digest before request freezing. No runtime callback was introduced.
  Independent seal67config/247generator/2toolchain;19Node/17Python mutations PASS.
  Sourcec781d7b1..., definitiondf8d6062..., envelope83e12cbc..., independent27a437fb....
- Correct next dependency: `verify-astra-v3-accounting-oracle.mjs` needs selected budget,
  transcript and clock bindings. `simulate-astra-v3-goal-matcher-result-admission-projection`
  checks matcher output and MUST NOT stand in for Kernel result verification. Current
  receipt-content flag is not origin authentication/accounting/clock authority. Counter
  copies alone do not close traversal semantics, and raw-invalid-output recovery remains
  separate. Complete authority/Goal/Certifier/durable Store and real product testing follow.
- No V2 recapture, full historical reconstruction, DB writes, external reads, product/
  shadow activation or additional scratch. The synthetic completed trace is not rollout.

### Budget/transcript composition verified (2026-08-30)

- The composed isolated core now consumes an exact frozen Budget2 body/ref and a bounded
  owner-bound transcript. Four Python controls cover completed, wide-integer, cancelled
  and time-limit-on-return accounting; Node independently derives the counters.
- 323/323 focused tests on explicit Node22.23.1. Budget substitution, restrictive caps,
  exact-cap acceptance versus overrun, temporal ordering and private-state rollback
  checked. The actual retained minimum budget remains rejected, never silently widened.
- Prepared-input seal:67config/250generator/2toolchain;19 Node/17 Python mutations PASS.
  No historical root rebuild, new database, real target reads or runtime activation.
- Next integration gate is Completion from the existing Goal policy and private
  accounting/result observations, not from caller-labelled success. Native root
  coherence, authenticated Kernel/clock/budget provenance, durable recovery and genuine
  V2/Computer Use acceptance remain open. Do not claim all14 accounting outcomes covered.

### Source-bound Evidence and Completion input (2026-08-30)

- Same composed route,31 unchanged native schemas: Evidence node, graph, single-attempt
  selection and frozen assessment input now require actual native record bodies and
  match the applied receipt/Invocation/accounting prefix. Graph cutoff/state revisions
  and selected node membership cannot be caller-invented.
- Freeze request/time/future command once, reserve its ID across executions, and bind
  the terminal owner and certification-key digest back to that exact input. Partial
  accounting cannot produce a verified terminal event; partial/blocked remain separate.
- 40 final focused tests PASS; earlier358/358 across9 serial suites. Prepared seal
  67config/253generator/2toolchain,19Node/17Python negative checks PASS. No full Store
  rebuild, new DB or product activation. Remaining stage: actual assessment/certificate
  bodies, source-derived claims and Goal policy/root verification, then durable integration.

## 1. Стратегия

Миграция не является переписыванием Agent Runtime V2 за один проход. Она строится как последовательность independently reversible vertical slices:

```text
freeze current truth
  -> parser/limit/implementation preflight
  -> compile read-substrate manifest/schemas/fixtures
  -> freeze P01-P20 replay/full-task/efficiency baseline
  -> independent artifact review
  -> measured persistence ADR (additive V3 | sidecar | V4)
  -> pure fixture simulator
  -> minimum no-behavior-change AgentLoop seam extraction
  -> [separately approved typed goal/certifier shadow]
  -> mandatory product-read foundation gate
  -> separately approved selected-store Astra read cohort
  -> exact read substrate vertical
  -> one Admission/Goal + Decision Gateway + Context/Scheduler seams
  -> mandatory coherent core compaction + context handshake
  -> representative read/effect/desktop/browser workflows
  -> extract God-loop branches by proven vertical parity
  -> real-model full-task and fault acceptance
  -> lifecycle/steering
  -> optional child/jobs/advanced compaction profiles
  -> release cutover
```

Главное правило: один Execution при admission независимо фиксирует `runtimeLane` и `persistenceLane`; ни одна из осей не переключается mid-flight и не выводится из названия Astra V3.

---

## 2. Неподвижные migration constraints

1. Production Monarch Safe не перечисляется, не читается и не изменяется ни в одном migration/test шаге.
2. Current chats/config/models/Turn/AgentTask data сохраняются.
3. Existing `monarch.agent-task.v3` active tasks либо завершаются текущим runtime, либо явно pauses; semantic in-place conversion запрещена.
4. Completed legacy tasks остаются read-only доступными через protocol adapter минимум два release cycles после V3 default.
5. Новые большие runtime/cache/test artifacts размещаются на `E:`/`D:`.
6. Kernel/Application остаётся единственным execution authority на каждой фазе.
7. Current exact approval hash contract не ослабляется ради compatibility.
8. Feature fallback не может превращать failed V3 operational task в answer-only success.
9. Shadow result не влияет на user-visible outcome до cutover gate.
10. Старый код удаляется только после measured parity и rollback window.
11. Нельзя создать два authoritative stores одним best-effort dual write.
12. Каждый phase имеет entry, changes, tests, exit и rollback criteria.
13. Public client DTO не содержит authoritative principal/surface/privacy; accepted context создаётся server-side.
14. `agent-core-read.v1` rejects operational Incognito/encrypted; existing answer lanes stay outside V3. Operational privacy profiles require separate exhaustive port manifests/fixtures.
15. Exact numeric value не может пройти через unsafe JSON/JavaScript number.
16. `agent-core-read.v1` никогда не повышается до product closure: default Astra cohort требует `astra-core-experience.v1` и Agent Core release gates.
17. Deterministic recipe/registered workflow проверяются до model planning; обязательный plan call для простой exact task считается performance defect.
18. Decision syntax может bounded canonicalize benign drift, но capability/input/Goal/secret/untrusted/authority semantics остаются fail-closed.
19. Schema/mock/unit green не заменяет current-model ordinary-route full-task holdout.

---

## 3. Current baseline to freeze

### 3.1. Runtime path

```text
surface
  -> OscarTurnCoordinator
  -> OscarTurnStore V1/outbox
  -> AgentRuntime
  -> AgentTaskStore V3
  -> AgentLoop
  -> KernelExecutionAdapter
  -> Kernel/Action Ledger
  -> observation/verifier
  -> Turn reconciliation/persistence
```

### 3.2. Baseline contracts

| Contract | Current version |
|---|---|
| Oscar Turn store/entity/event | V1/V1/V1 |
| Agent Task store/entity/checkpoint | V3/V3/V3 |
| Agent Task event | V2 |
| Agent observation | V2 |
| Agent approval | V2 |
| execution profile | V1 |
| Kernel capability/action proposal | current `src/core/contracts.ts` contracts |

### 3.3. Baseline evidence required before implementation

- current branch/commit and dirty diff inventory;
- focused Turn/Agent/Kernel tests green;
- ordinary Desktop and at least one non-Desktop surface route proof;
- persisted sample fixtures for legacy Task V2→V3 migration and current V3;
- crash fixtures for runner claim/outbox;
- exact `logicalBytes` failure benchmark captured as a regression test, not only prose;
- current latency/decision/tool-call counts;
- no production Safe path in fixture/log output.
- current Action Ledger interrupted-execution semantics explicitly recorded as insufficient for V3 effect recovery, not mistaken for reconciliation proof.

---

## 4. Target physical coexistence

This is a future coexistence hypothesis, not a selected backend/schema. Phase 0 benchmark and schema artifact review precede any product persistence decision.

```text
Agent Application Protocol Facade
  ├── InteractionStoreV1/V2 (existing Turn lineage)
  ├── LegacyExecutionAdapter
  │     └── AgentTaskStoreV3 + RuntimeV2
  └── selected Astra persistence lane (exactly one)
        ├── additive AgentTaskStoreV3
        ├── AgentTaskStoreV3 lifecycle + evidence/certificate sidecar
        └── ExecutionStoreV4 + read-only V3 legacy adapter
```

Product coexistence admission records four immutable bindings:

- `runtimeLane: legacy-runtime-v2 | astra-v3`;
- `compositionProfile: legacy-runtime-v2 | agent-core-read.v1 | astra-core-experience.v1`;
- exact retained `compositionManifestDigest` + `cohortId`;
- `persistenceLane: agent-task-v3 | astra-evidence-sidecar-v1 | execution-store-v4`.

Only the one Phase 0E-selected Astra persistence literal is enabled in a build; UI
reads a common projection. `agent-core-read.v1` cannot carry effect Requirements or
Invocations, while `astra-core-experience.v1` cannot be projected as the read
substrate. No task silently migrates between runtime, composition or persistence
lanes.

### 4.1. Selected persistence write rule

For an Astra Execution, authoritative lifecycle append, idempotency receipt and updated projection must be one atomic logical commit owned by the selected lane. A sidecar may own only immutable evidence/certificate facts and must couple them through an exact transactional/outbox recovery rule without duplicating lifecycle authority. If a candidate cannot provide that property, it is not eligible regardless of convenience.

### 4.2. Cross-aggregate write rule

Interaction ↔ Execution linkage uses existing/evolved transactional outbox and idempotent inbox. Simultaneous mutation of two JSON files is never assumed atomic.

### 4.3. Rollback rule

Rollback can:

- stop admitting new V3 executions;
- keep common readers for already-created selected-lane data;
- allow safe V3 tasks to finish/pause/cancel;
- route a new task to V2 only when a capability-specific reviewed equivalence decision proves every requested claim/target/temporal/effect/safety semantic. Otherwise block; product availability is not evidence of equivalence.

Rollback cannot reinterpret selected-lane Astra events/certificates as legacy completion, convert sidecar/V4 facts into a synthetic V3 checkpoint or repeat an indeterminate effect.

### 4.4. Mixed multi-clause cohort rule

`runtimeLane`, `compositionProfile`, its manifest digest/cohort and `persistenceLane`
are immutable per Execution, not per capability call.
`InteractionIntentAdmissionV1.clauseRoutes` computes all clause dependencies before
any Execution is created.

Product coexistence wrapper (outside the closed core schema) uses this policy:

1. If every selected operational clause is V3-eligible under one frozen registry/policy, create one V3 Execution.
2. Otherwise V2 is allowed only by an explicit capability-specific equivalence decision proving every required claim/input/target/temporal/effect/safety field. For `workspace.storage.audit.v2` no such decision exists: current `logicalBytes:number`, coverage and mutation fields are insufficient, so default is block/clarify.
3. Otherwise return explicit `clarify`/`blocked` for the whole operational set. It is forbidden to run an eligible subset and silently omit/answer the rest.
4. Informational clauses may be projected as linked answer rows only when their dependency graph is independent of operational results; otherwise they wait for the same Execution outcome.
5. Split V2/V3 operational cohorts are absent from core and from this migration plan; a feature flag cannot create the variant. Any future split design requires a separately versioned admission/projection/delivery schema and its own review.
6. Follow-up reruns the same admission/cohort algorithm. It cannot steer a V2/V3 mixture into an existing Execution.

Per-capability flags only affect admission eligibility. They never choose a different runtime after Goal admission or fallback mid-flight. Rollback of one capability therefore moves a **new whole operational cohort** to an explicitly equivalent V2 route or, by default, block; it cannot create a half-V2/half-V3 Goal.

### 4.5. Legacy outcome mapping

Compatibility projection uses a separate taxonomy:

```ts
type LegacyOutcomeV1 =
  | 'legacy-completed'
  | 'legacy-partial'
  | 'legacy-failed'
  | 'legacy-cancelled'
  | 'legacy-unknown';
```

Legacy adapter stores `runtimeLane='legacy-runtime-v2'`,
`compositionProfile='legacy-runtime-v2'`, exact compatibility manifest/cohort,
`persistenceLane='agent-task-v3'`, source task/status/verifier refs and a mapping code.
It MUST NOT create `CompletionCertificateV1`, certificate ID, V3 EvidenceNode or
public V3 `verified`. Familiar UI may say «Завершено (legacy runtime)» and, when an
old verifier record exists, «есть legacy verification record», but it may not use the
V3 verified badge/semantic.

The only upgrade to V3 `verified` is a separate current Certifier assessment over imported Application/Kernel evidence that satisfies exact current Goal/input/schema/metric/temporal/authority rules and produces a real atomic V3 certificate. Missing fields remain legacy; no synthetic certificate and no replay of effect/read solely to improve a badge.

---

## 5. Phase 0 — architecture freeze and benchmark corpus

### Entry

- Architecture docs reviewed.
- Product/runtime implementation has not started.
- A non-product Phase 0A compiler/tooling candidate exists; its own output is explicitly non-conformant and cannot authorize any later phase.

### Planned work

Phase 0 is one authorization boundary but not one implementation monolith. It is split into independently generated/reviewable artifact sets; each may land without enabling the next runtime phase:

| Sub-gate | Artifact set | Exit evidence |
|---|---|---|
| **0A Canonical Core** | sole `ProtocolDefinitionV1`, bootstrap schema/compiler, strict parser, JCS, transport/ref-graph limits, digest/content identity and exhaustive ID map | definition/output provenance + cross-language vectors + independent semantic endpoint/set oracle |
| **0B Event/Admission Core** | command/event unions, appender/state/commit rules, dedupe and pure intent/Goal admission corpus | exhaustive model-based transition exploration + matcher safety/recall corpus |
| **0C Storage Capability** | disposable-root Windows adapter contract, accounting proof, temporal/alias/reparse rules | differential walker oracle + platform corpus; no production/user/Safe roots |
| **0D Completion/Presentation** | Evidence, assessment, certificate, blocked/partial/verified projection and deterministic templates | independent certificate/projection oracle + no-field-leak fixtures |
| **0E Store Evidence** | real-hardware additive V3 vs sidecar vs V4 durability/latency/resource/backup benchmark | measured comparison and explicit least-complex passing decision/blocker |
| **0F Agent Core Evidence** | P01–P20 map, A01–A35 exact acceptance contracts, release matrix, admission/decision/workflow/fault/context/full-task corpus, V2 baseline and efficiency telemetry | every problem has owner/disposition and every scenario has fixture/oracle/artifact spec; unmaterialized contracts remain explicitly non-executable and cannot claim product evidence |
| **0G Open-source Reference Lab** | pinned OpenHands seam/provenance map, isolated OpenHands/Mastra/current-V2 comparison and optional non-authoritative ACP spike | per-pattern `adopt/adapt/reject`, copied-byte count, license/footprint/offline/Windows evidence; no framework gets authority or product-dependency status |

No sub-gate authorizes shadow/product import. Phase 1 becomes eligible only when
0A–0F all pass exact source/package hashes and independent artifact review. 0G is
not a blocker for clean-room Astra work, but it is mandatory before any OpenHands,
Mastra, ACP or other external runtime adapter/dependency RFC. 0A success alone does
not advance the product program.

### Current Phase 0A evidence — 2026-08-29

The first machine artifact is now materialized without changing Astra runtime/product behavior:

- sole candidate definition: `config/agent-protocol/protocol-definition.agent-core-read.v1.json`, canonical digest `sha256:103055032f7abd4d5212057508eaa05637627940b8b6daf7d6e60f584e7a7f08` (raw source `511753` bytes / SHA-256 `6b737363a9cff56158da71a75296280916c631531fc2cd4107a90cb46c7c2610`);
- pinned bootstrap schema/compiler trust root; compiler bundle digest `sha256:b4c1e4574aa6686fdbecbeaf7228b8b39714f9888c61a16e2bbf3947696ec5e1`, bootstrap digest `sha256:fb0c1af64e1815cb06da18d921ecd186ee327e0d8d35b65a0f4e2fe329bbbea6`;
- strict UTF-8/JSON parser and deterministic canonicalizer reject duplicate keys before object construction, BOM/trailing data, non-integer/unsafe numeric forms, invalid Unicode and compiled resource-ceiling violations;
- exact inventory closure is machine-checked at `66` schemas (`19` immutable-content + `47` non-default identity), `40` event-payload rules, `28` claim templates and `8` guard relations;
- six byte/digest vectors pass both the Node implementation and an independently implemented Python stdlib oracle, including UTF-16 key ordering and Unicode content;
- exact 23-kind opaque-ID prefix/owner registry is retained; the materialized-schema field map currently covers `117/117` reachable derived endpoints and an independently implemented Python oracle derives the same set from the retained definition before comparing generated documents. The twelve new occurrence-specific rows cover the nested canonical-volume ref and three policy/budget refs in `WorkspaceStorageAuditInputV2`; object/store IDs point to the exact `ImmutableContentRefV1.instance` owner rules and each content schema ID remains semantic, never generated. Source-only `idEndpoint:true` covers both non-suffixed scalar IDs and bounded arrays such as RuntimeFeatureSet feature IDs, is stripped before JSON Schema emission, and loses its map endpoint fail-closed when removed. `StorageInclusionPolicyV2.metricId` is an explicit closed-literal endpoint. Exact `maxItems=0` ID arrays emit no unreachable item endpoint, while widening exposes a missing map row and fails;
- exact five-profile semantic-ID substrate is retained in the definition, generated ID-map candidate and registry: 28 claim-template members, their 28 one-to-one selector IDs, singleton `storage.audit.requirement.v1`, six locale/verdict presentation-template IDs and `clause.<nearest-array-index>.v1` with canonical unsigned decimal and global ordinal ceiling `99999`. Compiler and independent Python oracle reject profile/member reorder, add/remove/substitution, owner-path drift, wider ordinal patterns and a coordinated definition/candidate/registry member substitution. Synthetic positive tests exercise exact pinned-member and ordinal endpoints, but current production-shaped materialized schemas exercise `2/5`; owner/projection bindings remain an explicit blocker rather than a false closure claim;
- internal matcher, binding-program and digest-rule IDs are now classified by the closed semantic rule `protocol-rule-identifier`, exact pattern `^(binding-program|digest-rule|matcher)\.[a-z0-9][a-z0-9.-]{0,111}\.v[12]$`. They are no longer mislabeled as `authenticated-external`; both compiler and independent endpoint oracle reject opaque printable widening, unknown namespaces and version drift;
- closed JSON Schema AST/codegen substrate now emits `22/66` canonical Draft 2020-12 documents with exact `urn:monarch:schema:<full-schema-id>` identities. In addition to Authority/Runtime/storage/certifier closure, the leaf-first assessment substrate materializes exact `StorageExclusionSummaryV2`, `TypedValueLiteralV1`, `TypedValueV1`, `StorageInclusionPolicyV2`, `StorageExclusionPolicyV2`, `StorageTemporalProofV2` and `WorkspaceStorageAuditInputV2` and the full closed `AgentCapabilityContractV1`. The capability schema fixes exact matcher/resolver/broker/walker/adapter IDs, 28 claim-template members and all read-only/ref surfaces. The input binds display-only `requestedRoot`, canonical handle identity, exact interval temporal class and selected private instance refs for inclusion/exclusion/budget policies; JSON Schema intentionally cannot prove its repeated digest equalities. `selectedVariantRef` remains source-preserving, raw `oneOf`/`allOf` cannot enter the definition AST, and source-only `exactItems` lowers to `prefixItems + items:false + exact min/max`; this is partial 0B artifact work and does not open the 0B gate;
- the callback-free `objectVariantTemplate` source macro now factors one direct closed common object across `2..64` sorted disjoint branch deltas, materializes ordinary flattened branches, and then passes the unchanged discriminator/ref/ID validators. Common/branch overlap, branch reorder, required omission/reorder and discriminator collision fail. `ImmutableContentRefV1` is the production proof: its generated schema stayed byte-identical at `2773` bytes / SHA-256 `c05ec88fc9c50f9f27e22bb18e2979d1e77990204efd7736e75b0389d789eda1`; the independent Python endpoint oracle separately expands the macro and rejects coordinated owner-domain widening. This is finite authoring substrate for the later 40-event/commit parity closure, not event materialization;
- finite ID classification now includes exact `reference-union`: `2..256` sorted owner-rule IDs, every chain terminating at an opaque-random owner, at least two distinct opaque kinds, and one compiler-derived canonical prefix-union regex over the common 128-bit body. Its same-kind counterpart `reference-set` requires the same finite sorted terminal closure but exactly one opaque kind and therefore the unchanged single-kind wire pattern. Redundant same-kind unions, mixed-kind/singleton sets, owner reorder, dangling/non-random chains and structural widening fail in Node; independent Python positive/negative coordinated cases agree. This closes the algebra needed by event `causationId` and the five-branch follow-up decision reference, but does not invent the five concrete decision owners, `commitId` owners or internal/public `commandId` owners;
- the exact event-envelope owner grammar is retained once and emitted as `event-owner-grammar.candidate.json`: 40 sorted event variants, 30 sorted ordered commit shapes, maximum three events per shape, `commitId` owned by the first event, and `commandId` split into 25 first-event/internal owners plus five exact retained-command owners. Its causation-required trace policy expands `2` accepted-command ingress, `28` prior-retained-event and `14` immediate same-commit suffix relations; correlation is rooted only at accepted submit and propagated along that chain. Its canonical digest is `sha256:0d883c35cacaef141bb0d11f444bd9e118f982c5fe89952e965f6c6bafceb9a5`. Node rejects shape/occurrence/owner/trace drift; the independent Python oracle rejects coordinated definition/candidate/registry substitution;
- one finite `eventSchemaSource` (`sha256:7f947dd2d9ea398cac7a0162f16909e1c50367d2ce297e5150af670292e7798a`) now supplies all 40 variants / 45 payload branches, including five strict diagnostic presence unions and twelve Invocation-transition payloads. It mechanically generates 40 causation-required AgentEvent plus 40 CommitEvent candidate branches and proves 40 exact projections with only `/commitDigest` removed and `/schemaVersion` replaced. The independent Python oracle reconstructs both documents; their canonical hashes are `sha256:166524dcd17bb77f268a9878f5a3926d68d3ea1408b0cc0221e9684006f38d95` and `sha256:c4b289feaa3eeb0e2b84e68928229f641e220dc61d89c4c9dac9099a0d248239`;
- the 30 shapes expand to 44 exact occurrence rows in `event-occurrence-bindings.candidate.json`: 30 `commitId` owners + 14 references, 25 internal `commandId` owners + 11 intra-commit references + eight retained-command references, 44 `eventId` owners, 44 stream↔payload aggregate equalities and 44 payload-digest rule selections;
- `commit-group.candidate.json` mechanically wraps the same 40 CommitEvent branches in exact `1..64` events, projects all 30 allowed ordered shapes, and fixes equal stream/revision/command/commit/size, count, array-index and contiguous-sequence invariants. Its current candidate is `100156` bytes / `sha256:37adfe2522fec59435b4615c40c88aa76ec6e4ee987d5957f12c0bd142e21cbd`; `event-commit.v1` binds the full group with zero omissions to `/commitDigest` in all 40 AgentEvent variants. The independent oracle reconstructs this artifact. The Event simulation accepts five schema instances, rejects eleven schema mutations, passes three ordinary + three CommitGroup + two trace-relation positives and rejects two ordinary + eight CommitGroup + seven trace mutations. An initially red multi-event fixture caught that `policy-denied` was terminal-valid but antecedent-invalid and was corrected to the shared exact `authority-scope-empty` code. A second pure simulator derives all twelve Invocation transitions and the receipt-link fact, proves one stable dispatch attempt/port call across retry, exercises all terminal classes and rejects eleven CAS/key/receipt/terminal mutations. These remain candidate outputs: structural registry/ID/binding promotion and retained Invocation/receipt schemas are still open;
- Event registry promotion now has an exact dependency/ID expansion gate: every one of AgentEvent, CommitEvent and CommitGroup requires `841` concrete endpoints (`240` envelope/stream + `79` direct payload + `58×9` from the three-branch `ImmutableContentRefV1` expansion), `2523` total. The compiler and independent oracle agree on all counts. A 40-row collision-checked route map converts protocol `:` discriminators to structural `.` segments and retains protocol ID + route + branch index. The source-owned direct payload grammar is pinned at `sha256:2b980cbe46c9185c42c9aa6df94c46dc85ae1b8aef946a40069f089f39699c3c` with exact classification `2 random / 75 reference / 1 same-kind owner-set reference / 1 semantic`; it and the 58 embedded refs now mechanically produce `601` candidate payload endpoints per document, `1803` total. A second finite grammar, pinned at `sha256:07fc6aeadb862ba1305e3278975485497f02cefbc04dae24a1bc1d7efc005a7c`, derives exactly 15 Event/envelope owner roots, two support bridges and 15 terminal random owners across 17 rows, 11 schemas and nine opaque kinds with maximum depth one. Node and an independent Python exact-table oracle reject missing roots, import substitution, reorder, dangling/kind-widened chains and coordinated candidate/registry drift. This proves owner provenance, not structural materialization: all 11 owner schemas and their complete ID/binding surfaces, `720` envelope/stream endpoints, occurrence-contextual rules and the three Event documents remain required; neither `1803`, `17` nor current `117/117` can be reused as proof for Event promotion;
- the first exact owner-schema surface batch is pinned separately at `sha256:9167e07972df7c14aadecdedc1b487886ab09a176ffe57e05b0b2b99a9fc35b1`. It covers two of the eleven owner schemas (`AgentClientCommandV1`, accepted `AgentCommandV1`), two new payload support documents and the retained `AcceptedCommandContextV1` dependency. The four documents contain six root structural variants and expand to `25` direct ID endpoints plus `16` mechanically projected retained-context endpoints, `41` total: `8` random owners, `14` references, `3` finite same-kind owner sets and `5` references to candidate AgentEvent aggregate owners. The public branches reject both `correlationId` and `causationId`; after authentication/dedupe reservation the trusted adapter allocates submit correlation once, while accepted follow-up copies the retained target-Interaction root correlation; accepted commands never carry causation. Node and an independently implemented Python oracle reject public trace-link smuggling, branch/tuple/owner/projection/import/order drift and coordinated candidate substitution. The pure ingress lab accepts four exact instances, rejects thirteen structural mutations, passes two projection bindings and rejects six binding mutations. Its current `21123`-byte artifact is `sha256:2055774e8b24907a3ff41f22d3fff29be487aca396d89295c2e9b4c631929f99`. Because five references still import unretained Event aggregate owners, none of these four documents or 41 endpoints is added to the retained `22/66`, `117/117` or `25/93` counts;
- the remaining owner structural boundary is no longer an assumed cycle. A separately pinned graph (`sha256:55d89496fb8e8c8a7a20f413dde27d0d2498abde271bfcdc44e00a3986753b64`) derives the exact nine remaining owner schemas from the 11-schema owner grammar minus the two ingress owners, then adds three required structural supports (`CertificationKeyBodyV1`, `CompletionAssessmentBodyV1`, `CompletionDenialV1`) and four already retained boundary schemas. Its `16` nodes / `16` direct `$ref` edges form `16` singleton SCCs with `0` cyclic SCCs. Mechanical materialization order has three non-retained layers: nine leaf nodes, then CompletionAssessmentBody + CompletionCommitAssessment, then CompletionCertificate. Node rejects node/edge/role/order/layer/digest drift; an independent Python Tarjan/topological oracle rejects coordinated definition/candidate/registry edge removal. The current `5357`-byte candidate is `sha256:6fc4092543309f543f6838108f5944fa030ec60228d3eda74798653a65b6fcd8`. This proves there is no structural `$ref` SCC among these twelve non-retained documents; it does not enumerate their complete ID endpoints or dissolve the separate Event ownership cycle, so materialized owner/support counts remain zero;
- the graph is now consumed by a reusable, digest-pinned layered schema-surface catalog (`sha256:d42b985a55be6c62130268cc8d03145176460889e1f10a597a51f0061ca7374f`) instead of one validator per schema. Ten batches cover all nine non-ingress owners and three supports as twelve closed Draft 2020-12 documents with 45 structural variants. The catalog derives `133` direct endpoints plus `915` retained/transitive projections, `1048` concrete endpoints total (`18` random, `60` reference, `6` finite same-kind reference sets, `49` semantic, `19` Event-import references, maximum owner depth `3`). Layers 0/1 retain their exact denial/evidence/goal/input/admission/Invocation/assessment/commit contracts. Layer 2 is separately pinned at `sha256:e3861f3ac78e1b1e4f8cd0e51e7f67525e625b855528baa42c15db72c086fa42`: `CompletionCertificateV1` is one exact 12-field local-trusted-writer envelope with a Store-owned certificate ID, immutable assessment-input ref, embedded exact assessment body, copied clock attestation/frozen time and separate assessment/certification/envelope digest domains. The compiler now carries projected endpoint classifications forward between structural layers; this is required to prove all `178` ID endpoints inside embedded `CompletionAssessmentBodyV1`, rather than misclassifying its nested refs as new direct owners. Certificate projections add those 178 endpoints, two ClockAttestation endpoints and nine ImmutableContentRef endpoints. Cross-object copies, domain-separated digests and retry byte identity remain semantic-binding obligations, not falsely encoded as JSON-Schema-only proof. The independent Python oracle pins and reconstructs all ten batches; oracle source SHA-256 is `5d5105cbdcf8045365a3dd95b0bfb408ed10b1ce37a3acb2ea25605fa58f2637`. The pure simulator accepts `68` exact instances, rejects `1175` structural mutations plus `28` schema-valid semantic attacks, passes `133` owner/domain bindings, rejects `133` binding mutations and checks all `915` projection endpoints. It computes all three certificate digest domains, checks frozen copies and proves byte-stable retry; simulator source SHA-256 is `02de3b1e9974a3b4c94a2d87926f6235631f21a04c003bf21ff4678830765a92`. The current `132987`-byte candidate artifact is `sha256:c99046b5590129d547c1c0f6b74db39ffa66cf7587d65425f71fbf26b1cc5f89`. It is still candidate-only: retained structural/ID/binding counts remain unchanged, and current retained semantic-profile exercised count is two of five;
- a digest-pinned atomic-promotion preflight (`sha256:fd0fa6555f15ff70247c7178856167af73c5d0fac2bdeff316e97ade0ab4c597`) mechanically unions ingress and all ten layered batches before any retained mutation. It derives 16 owner/support candidate documents, 11 owners, five supports, five retained boundary schemas, 51 actual root variants, `158` direct + `931` projected = `1089` concrete ID endpoints, maximum depth three, 16 domain-separated schema-body rows and 16 future authority rows. The preflight exposed and corrected the prior ingress metric bug (`4` documents were incorrectly reported as `4` structural variants; the exact branch count is `6`, making the union `51`, not `49`). A later dependency audit proved that those 16 documents cannot be promoted alone: §2.3 requires every retained ID-rule target schema to be materialized, but AgentEvent is absent from both retained authority and the owner cohort, while the Event trio depends back on owner schemas. The only admitted compare-and-swap unit is therefore the joint owner+Event cohort: `16 + 3 = 19` structural documents and `1089 + 2523 = 3612` ID endpoints, plus bindings, schema-body rows and Store-issued ProtocolSchemaRefs; owner-only, Event-only and standalone Event-import-binding paths are forbidden and partial application is zero-authority-change. The independent Python stdlib oracle (`33561` bytes / `sha256:3be06eb2694f3f2a05d275d9c54f8ee66de196d02b6e1c72ca2d04b81bec1e2d`) reconstructs the owner/projection table, exact `24` direct + `4` projected imports, both Event aggregate owners, the joint topology and all schema-body digests, then rejects coordinated weakening plus ID substitution. The generated preflight artifact is `517162` bytes / `sha256:c014bddc6d4d4e1ff979d26d63655d05e9c1961791718d90c173f600a1b3c830`;
- deterministic owner rule-ID lowering remains a separate pinned source (`sha256:7dd49249dee514a6a35574f884b6458cce462cb60f8eee9e0fef2645f82a2d79`) and candidate artifact (`719744` bytes / `sha256:e351cbe60ed67570e16013f04d75556eb0f0042201c34b9a06f2eea3d7a2d111`). Domain-separated full-SHA-256 allocation produces 1089 candidate rules plus five explicit external-owner anchors, `1094/1094` unique IDs, zero endpoint/digest/retained collisions and zero unresolved owners. Exact lowering yields `542` random, `135` reference, `11` reference-set, `8` authenticated-external and `393` semantic rules; it rewrites 119 scalar owner endpoints and 11 sorted owner sets containing 24 members, retains 16 pre-existing retained-rule references and proves every ownership chain terminates in random authority. The three retained logical-namespace anchors (including abstract Evidence `/id` and dotted command variants) are intentional imports, not dangling structural endpoints. Source coverage pins 15 stable allocation/topology counters; the artifact and independent oracle still verify all dynamic classification counters. The Python stdlib oracle (`21047` bytes / `sha256:b717a2b5685256c16a5089ea4b1e321dd19412f8045318760d70149f93ca83cb`) rejects allocation, import, owner, classification, collision and coordinated source/candidate/registry attacks. The Event projection pass also corrected a concrete defect: all 601 CommitGroup payload rows now target `monarch.commit-group-digest-body.v1` under `property:events / each-array-item`, rather than nonexistent `monarch.commit-group.v1`; the `1240797`-byte candidate is `sha256:257a09cdbbd2b53e0637fa17df9c4cf318036eae4f00d4e580845f2a284b752f` and the independent Event-source oracle agrees. The lowering is candidate-only and never mutates retained rules. Joint Event and cross-object Completion/Event lowering are closed by the following bullets; Store-issued ProtocolSchemaRefs remain open. Thus `promotionReady=false`, retained counts are unchanged and no product runtime or persistence was touched;
- the joint owner+Event lowering now closes the rule-ID side of the 19-document cohort without retaining it. It emits `3612` candidate rules (`1089` owner + `720` Event envelope/stream + `1803` Event payload/ref), exactly `841` per Event document. Both former Event imports reconcile to their actual AgentEvent rules; full dependency closure adds two dotted logical `messageId` authorities, producing five retained logical imports and `3617/3617` unique generated IDs. Classification is `633 random / 1898 reference / 35 same-kind set / 120 command-or-event union / 8 authenticated-external / 918 semantic`; 96 projected scalar references are deliberately flattened when their source authority is a set/union, because a scalar reference may not terminate at a set/union rule. The 40 causation rules contain the exact 42-owner union, correlations terminate at submit correlation, occurrence-derived command/commit sets and diagnostic two-branch stream sets are finite, and every reference chain terminates in random authority. The candidate is `2060078` bytes / `sha256:c6c5b43adab4567f18b855555f9bc52c17489a7c697ab04ee1a21390118915fb`, within the strict parser ceilings. The independent Python oracle (`25511` bytes / `sha256:a1bf76a9e798eec924100155e3a5508f4ef094a803f13186bdfbea8cd7c6b0a2`) independently rebuilds the endpoint union, allocation, payload and occurrence lowering and rejects ID, trace-set, group-prefix and logical-import attacks. Event rules are now candidate-closed; occurrence/projection/digest/frozen-copy binding programs, Store-issued refs and crash-safe retained CAS are still open;
- Event-specific cross-object binding lowering is also mechanically closed as candidate evidence. `event-cross-object-binding-programs.candidate.json` contains `114` programs / `1376` instructions: `40` projection, `44` occurrence and `30` commit-shape programs, including `749` exact JSON-value equalities (`640` direct projection parity), `99` fresh-ID checks, `44` payload digests, `28+28` prior-event ID/correlation lookups, `30` shape/count/index/sequence/commit-digest checks and `150` all-events-equal checks. Artifact identity is `503503` bytes / `sha256:d73a1032632e2b43eb82895a775d11d25da04baf8e82373de652105264954c8e`; source identity is `sha256:d88fc136290e6d7cbe5bc52b5356359a5ddd52240a8943a241a349b59ac1b228`. A composed independent Python implementation (`31218` bytes / `sha256:222d2697c0aa14bc263983f82e6d0cfb663bb577e53b91eefaab025aa527d118`) reconstructs the programs from separately verified lower-level sources, executes seven linked programs for a real three-event shape and rejects seven semantic mutations; artifact tests reject projection omission, occurrence-owner substitution, digest-result truncation and readiness escalation. The new language remains candidate-only beside the retained `25/93` program substrate and applies zero retained programs. Completion binding closure is recorded by the next bullet; Store-issued refs and crash-safe retained CAS remain open;
- Completion-specific cross-object lowering is now mechanically closed as a second candidate set rather than hidden inside the retained 25-program language. `completion-cross-object-binding-programs.candidate.json` contains `9` programs / `151` instructions: request-freeze, blocked/partial/verified assessment, commit-freeze, certificate-freeze and the three exact terminal suffixes. Coverage includes `84` byte-equal cross-object copies, `20` immutable-ref resolutions, exact 28 claim→selector→presentation mappings with `private` TypedValues, the 16-key presentation tuple, verdict policy, four digest domains, once-only command/certificate allocation, byte-stable retries and adjacent two-event terminal commits. Artifact identity is `68887` bytes / `sha256:3c9044b18a8c42923a7efafc9e853955f9c7ee975d9091ed1f7e94ef9561fa75`; source identity is `sha256:c153a1412f2783200f8bb65d22d59d4e36f166f0da455d9e5b4ad09a97260e98`. The independent Python oracle (`59377` bytes / `sha256:680d12539b0a14498a7080aaccbebbf807a7cbfc9d18048112c16c5af8001a11`) reconstructs all nine programs directly from the definition, executes all nine across three verdict fixtures, and rejects `10` artifact + `12` executable semantic attacks. `retainedBindingProgramsApplied=0`; candidate closure does not alter the retained `25/93` counts;
- the disposable Completion Store lab (`24791` bytes / `sha256:9e0ae337b5871cd076ffe42d285fa3938e81e6124edc90b04996b11e05d6105e`) is constrained to an `E:`/`D:` scratch root and passes `12` logical transaction scenarios. It proves issued immutable refs resolve only with matching generation/schema/digest, one CAS winner, byte-stable idempotent replay, body-conflict rejection, clean rollback after content-stage/state-stage/content-promotion failpoints, exactly-once recovery after committed-state response loss, and an inseparable two-event terminal logical commit. It touches neither product runtime nor production persistence and deliberately reports `powerLossDurabilityProven=false`; real backend fsync/locking/process/power-loss evidence and Store-issued `ProtocolSchemaRefV1` authority are still open;
- the combined candidate language is now explicit rather than inferred: `combined-binding-language-abi.candidate.json` is `16362` bytes / `sha256:d7751f2e914be4d0c221b171f5a391ab28bc00b96ec35a5a2445f0026e33e6be`, self-digest `sha256:2819ef38d4f3264ae64e84e898ab1c0aacbfc23dda5b7277772d7e8e82015721`. It binds the two source artifacts to `123/1527/26`, eight scope kinds, 13 endpoint roles and 2519 endpoint references, forbids coercion/widening/skips and admits activation only as one all-or-zero Store CAS. An independent `25939`-byte Python oracle (`sha256:cf37707d7d42b95a08311efa006530f6448a9ce9236e902715304ea40b49da0e`) rejects 12 ABI/source/partial-activation attacks. This is candidate closure, not a retained extension of `25/93`;
- a separate `36842`-byte SQLite full-cohort lab (`sha256:0ebd24f3f501c3451bac823c1183f340510978fc30133c0f07103465ef9ca39e`) now stores all `19` documents, `19` Store-issued candidate refs, `3612` ID rules and `123/1527` programs/instructions plus ABI in one `WAL`/`synchronous=FULL` transaction. Three forced process exits before commit reopen with zero partial rows; commit-before-response recovers exactly once; two-process same-request and conflicting-CAS tests prove byte-stable replay and one winner; stale epoch, body conflict, partial cohorts and foreign-key violation reject; reopen/integrity/backup readback is exact. This proves process-crash behavior for the disposable SQLite lab, not power-loss/torn-write behavior. Bundled meta-schema identity, final role/rule authority and retained `ProtocolSchemaRefV1` promotion remain deliberately false/zero;
- schema-document identity now has a generated `22/66` row substrate: exact ID/version/root `$id`, canonical byte count, raw audit hash and §2.1.1 `schema-body` digest under `monarch-jcs-utf8-v1`. A separate Python stdlib oracle independently canonicalizes all documents and reconstructs the complete length-prefixed digest preimage, passes `22/22`, proves every raw/domain digest pair distinct and rejects coordinated raw-SHA substitution. Retained `ProtocolSchemaRefV1` store objects/meta-schema bindings remain `0/66`, so this does not claim manifest closure;
- finite binding-program substrate emits `25` sorted production-candidate programs / `93` primitive instructions. The new callback-free `assert-projected-domain-digest` may construct only one direct closed target schema: its sorted member list must exhaust every required property exactly once, each source pointer is one direct field with byte-identical generated value domain or one target-valid literal, and the target's retained content domain/zero-omission identity fixes the digest header. It now proves `CanonicalWindowsPathV1.identityDigest = digestV1('windows-path-identity', JCS(CanonicalWindowsIdentityBodyV1))` from only `fileId128Hex`, `reparsePolicy`, literal identity-body schemaVersion and `volumeIdentityDigest`; `displayPath`, `observedAt` and the outer schemaVersion cannot enter the digest. Duplicate result binding, member omission/reorder, literal substitution, source-domain widening and target-domain substitution fail in Node and independent Python. The binding oracle executes four value fixtures: projection match/mismatch plus Workspace repeated-digest match/mismatch. Existing exact volume/body/policy refs, self-digests, canonical sets, ten ref→schema-body bindings and six TypedValue branch rules remain closed. The distinct direct `assert-schema-digest` primitive remains fail-closed;
- direct assessment dependency analysis now has a structurally closed candidate `CompletionAssessmentInputV1`, including exact repeated requirement/invocation members and retained ref/Clock projections. Layer-1/2 structural sources, the nine-program cross-body equality/digest/bijection candidate and the combined candidate ABI are materialized, but none is retained: bundled meta-schema/role/rule-authoritative Store refs, retained engine adoption and power-loss-safe atomic promotion remain open;
- focused suite: `317/317` tests pass, including trust-root, artifact, binding, ID/ref and closure mutations; exact owner/source/payload-projection/occurrence/trace reconstruction; retained-owner dependency, ingress owner-schema source, remaining structural graph and all ten layered batches; atomic promotion, deterministic owner and joint Event rule-ID lowering, Event plus Completion cross-object binding lowering/execution, the exact combined `123/1527/26` ABI, 12 ABI/source/partial-activation attacks, logical Store ref/CAS/rollback simulation and the SQLite full-cohort process-crash/concurrency/integrity/backup lab; public correlation/causation and attachment smuggling; independent Python candidate rejection; reference-set positive/negative/coordinated Python cases; coordinated source/owner/semantic drift; layered owner, Invocation, assessment and certificate simulations; claim/selector/presentation/private-classification attacks; frozen completion-commit mismatch; certificate layer/dependency/owner/projection/cardinality/digest/frozen-copy/retry attacks; GoalContract/CompletionAssessment freeze; Interaction source/matcher/limit/union/owner-chain/projection/depth attacks; Invocation lifecycle/dispatch/receipt/output attacks; Workspace ref/equality assertions; and unresolved generated-ref rejection;
- independent schema-subset simulation: `100/100` fixtures (`34` accepted, `66` rejected) over twenty-two generated documents, `4/4` bounded/unique-array primitives and `5/5` exact-tuple primitives. The corpus explicitly proves that root-digest mismatch is structurally valid and then the separate binding oracle rejects it; a wrong instance-vs-schema ref branch fails structurally. Its `$ref` resolver rejects missing targets and cycles; storage-summary reorder/extension, policy literal/field/tuple drift, temporal-proof mutation/extra-field drift, typed-value discriminator/encoding drift, non-canonical numbers, safe-integer overflow and object-branch drift all fail. The canonical byte/digest oracle remains `6/6`;
- repository-wide validation is green: TypeScript typecheck PASS; full Vitest `214` files passed / `1` skipped and `2391` tests passed / `4` skipped, failures `0`, with `TEMP/TMP=<qa-temp-root>\astra-v3-20260827\temp`. A first earlier default-`C:` run failed nine model-manager tests only because free temp space (`229322752` bytes) was below their conservative requirement (`268435479`); both affected files passed `23/23` in isolation on `E:`, then the complete `E:` runs passed;
- deterministic ignored artifacts are written only under `artifacts/generated/astra-v3/agent-core-read.v1/phase0a`; provenance and the gap report are verified after generation.

This is a **partial Phase 0 machine candidate**, not a 0A/0B pass. The generated gap report records the exact incomplete retained closure (`22/66` structural schemas and schema-body rows, `117` currently retained ID rules, `5/5` retained semantic-ID profiles but `2/5` exercised by current retained endpoints, `25/93` production binding programs/instructions, `0/66` retained ProtocolSchemaRef store bindings). Event source, 40+40 projection parity, the 44-row occurrence/trace map, CommitGroup, ingress `2/11`, the remaining-owner graph and all three layered source levels are machine-closed candidates, but deliberately not counted as retained structural schemas, opaque-ID rules or binding programs. Candidate source coverage is all eleven owner schemas (`2` ingress + `9` layered); retained coverage is still zero of eleven. Layers 0, 1 and 2 are source-complete, the atomic preflight closes their exact 16-document/1089-endpoint/16-digest owner inventory, the joint lowering assigns all `3612` owner+Event endpoints plus five logical imports stable collision-checked rule IDs, and candidate binding lowering materializes all `114/1376` Event plus `9/151` Completion programs under one exact `123/1527/26` candidate ABI without applying them. Disposable SQLite now proves full-cohort process-crash rollback/recovery and cross-process CAS, but the next blocker is still retained authority: bind the real bundled meta-schema, finalize every schema role/content-identity/digest/binding rule, issue retained Store refs, adopt the combined engine ABI and prove power-loss/torn-write behavior before the same 19/3612/123 cohort may advance authority. No owner, Event or binding subset may be promoted individually. The remaining 44 retained schema AST slots still include candidate-covered schemas until that atomic promotion, plus full manifest/ref and state/commit closure, event/claim negative fixtures, storage broker/oracle, three-store measurements and independent generated-artifact review. The simulators and SQLite lab are candidate evidence, not shortcuts around retained schemas or real durability. `promotionReady=false`; `conformanceReady=false`; shadow, product persistence and production Safe remain forbidden.

### Current Phase 0F evidence — 2026-08-29

- P01–P20, A01–A35, release matrix and pinned OpenHands/Mastra/LangGraph/Temporal
  dispositions are machine-readable and mutually verified.
- All `35/35` acceptance contract fixtures are physically materialized and byte-pinned;
  deterministic regeneration and an independent Python strict-JSON/hash/semantic
  oracle pass, including a negative mutation with a recomputed fixture digest.
- `EvaluationManifestV1` pins the stable ordinary public route
  `POST /api/oscar/turns`, current V2 internal owner `OscarTurnCoordinator.submit`,
  required Astra owner `ProductFacade.submit`, seeds, independent-cluster estimand,
  pack×language×risk minima, Wilson gates and zero-tolerance failures. Public route
  equality is required for baseline comparison; internal owner equality is forbidden,
  which removes the former Phase 0F→Product Facade prerequisite cycle.
- Three historical V2 benchmark candidates were re-read from `E:` and reverified by
  exact bytes/SHA-256, but eligible baseline count is `0`: the full v17 run predates
  current semantics and all three lack the new manifest/public-route/hardware+package
  binding and have `calibrationApproved=false`.
- Exact readiness is `8/13` gates PASS and `5/13` blocked. The oracle registry now
  projects all `57/57` specified oracle IDs from the acceptance contracts and has
  deterministic reference-only implementations for `7/57`, exercised by `14`
  positive/adversarial observations and independently re-evaluated in Python.
  These are synthetic harness checks only: required product/component-route oracle
  implementations remain `0/57`. Product-route execution is deliberately not a Phase
  0F prerequisite because it would require the still-forbidden Product Facade and
  recreate the prerequisite cycle. The remaining blockers are full-task population
  (`0` independent clusters today), fresh V2 baseline, same-manifest efficiency
  telemetry, contamination audit and full independent artifact/human security review.
- Therefore Phase 0F is **not ready**, Phase 1 is **not eligible**, Product Facade or
  product seam implementation is not authorized, and executable acceptance remains
  `0/35`. This status is machine-enforced by
  `astra-v3-phase0f-readiness.v1.json` + `npm run astra:agent-core:phase0f`.

1. Build the one canonical `protocol-definition.agent-core-read.v1.json`, a small pinned bootstrap schema/compiler trust root and non-product harness for the six generic strict parser/JCS/schema-validator/digest/identity-binding/state-commit engines. Definition is the only codegen input; generated TS/schema never feeds back. Every compound review label expands to a finite primitive assertion/state program with no callback escape. Parser/allocation preflight freezes finite compiled pre-profile ceilings inside the parser artifact/hash, eliminating profile-bootstrap recursion.
2. Run isolated parser/allocation/resource-limit preflight on disposable `E:` data, select positive finite `TransportLimitProfileV1` values no greater than those compiled ceilings, pin the six engine hashes + JSON Schema meta-schema digest, and pass cross-language positive/negative vectors: pre-profile and runtime-profile overflow, attempted profile expansion, leading transport BOM rejection plus valid in-string `U+FEFF` preservation, duplicate keys before construction, trailing data, invalid Unicode, runtime-vs-schema-document numeric rules, exact complete-payload bytes, root depth, nested total object-member/array-item occurrences, individual decoded-string UTF-8 bytes, every duplicate ref occurrence, exact commit-event ceiling and exact canonical-URI schema-document closure. Runtime ref fixtures separately hit edge occurrence, unique object, depth and resolved-byte ceilings before fetch/allocation, cycles and extra/missing authority objects. Manifest and capability bind the same retained transport profile; per-object-vs-total, primitive-vs-container-root-depth, unique-vs-occurrence refs and capability-local alternatives are negative fixtures. Materialize/lint the exhaustive `OpaqueIdProfileV1.idFieldRules` map with `follow-up-decision` identity. Vectors prove exact source-schema-version/profile selection, 40/40 event-payload rules, commit-group rule, expanded guard/state/commit programs and every domain. Every union compiles as satisfiable flattened `oneOf` with `additionalProperties:false`; naive TS-intersection/`allOf`, callback labels and cross-branch acceptance fail.
3. Only then emit the exact 66-schema Protocol §0.1 manifest, JSON Schema 2020-12, rule tables and generated TypeScript from the retained definition; no handwritten mirror, generated-input loop, placeholder limit, mnemonic/wildcard endpoint or transitive unlisted authority `$ref`.
4. Build pure admission/Goal fixtures in one fixed installation generation: exact command/message/context/locale/cohort provenance, accepted RuntimeFeatureSet→sole capability-contract/matcher/policy/recipe/presentation/Completion-Certifier/terminal-policy binding before receipt publication, deterministic matcher-result body without store IDs/time/handle identity, machine-checked ordinal result→Admission sealing, discriminated candidates, no V2/split/model route, retained deterministic minimum, explicit interval/partial admission, exact 28-row claim-template suite + 28 allowed/16 required presentation keys, accepted→narrowed Goal AuthorityScope proof, exact target/input/inclusion/exclusion/budget bindings and target/current/stable/ambiguous clarify cases. The legality suite must reject before Execution: a negated/prohibited operational clause, an ambiguous target even when a plausible range resolves, a positive candidate with non-empty ambiguity, a missing/non-singleton/mismatched operational-unknown code, two selected positive candidates and a prohibition hidden in an unselected informational row. Include simulator cuts/package-upgrade between `interaction.accepted` and intent sealing/assessment and same-client-ID replay after current locale/feature/contract/auth epoch changes; both must use the retained accepted context and create no second work or verdict-policy substitution. Invalid/auth/feature/manifest/capacity/conflicting commands must return direct closed ProtocolError before any command/receipt/Interaction fact; the only authoritative receipt branch is the atomically retained byte-identical `accepted` receipt. Generated ProtocolError rejects a malicious extra `message`/path/cause property, exposes only the exact tuple/trace/allowed diagnostic pair, and produces the same `path-ineligible/policy/after-user/no-diagnostic` authority body for protected and ordinary denied paths; presentation text is a local non-authority concern. Fault every simulator state boundary to prove accepted-command body + dedupe + receipt + exact singleton first event are all-or-none and that changing any receipt/event/ref/time/revision/fingerprint field fails the projection. Core rollover/reset is a negative unavailable case; a product profile must first add and test an explicit client generation fence so old retries cannot become new-scope commands. These fixtures make no process/power-loss durability claim; the separate backend harness must prove that before product receipt exposure.
   Capacity reservation has one exact pre-admission outcome: `storage-capacity-exceeded/storage/after-runtime` with diagnostics forbidden and no command/receipt/Interaction fact. It is never traversal `budget-exceeded` or generic `internal-error`.
   Admission fixtures additionally prove non-empty attachments and explicit Incognito/encrypted core requests fail before accepted-command/receipt/Interaction creation; Goal matcher uses the complete generated finite tokenizer/automaton table and target resolver consumes only its admitted source range—no hidden regex/callback/full-message reparse. Goal revision is literal `1`, core claims have no condition/freshness option, and follow-up provenance uses the exact follow-up-decision + `execution.created.interactionId` owner.
5. Build one static `workspace.storage.audit.v2` suite on newly created disposable roots. Support matrix admits only non-volume-root/non-reparse directories on direct local fixed NTFS and the exact `{BusTypeAta,BusTypeSata,BusTypeNvme,BusTypeSas,BusTypeRAID}` allowlist; UNC/SMB, mapped/`SUBST`, removable, iSCSI/NVMe-oF/Fibre/USB, virtual/Spaces, other/unknown bus, non-NTFS, mount/reparse-root and alternate Win32 enumeration APIs deny before traversal. Pin `FILE_ID_EXTD_DIR_INFO` long-name-only forward iterators; cover 8.3 ingress alias identity without short-name duplication, ill-formed UTF-16, strict UTF-8 relative-path accounting, `.`/`..` sentinels and concurrent rename/recreate/disappearance semantics. A separately hashed supervised one-dispatch broker job owns observation/iterator/I/O/resource facts; the walker owns frontier only; transcript oracle recomputes all counters without touching production/user/Safe roots. Fixtures hit exact integer `2^53±1`, max-u64+1, hard links/sparse/reparse/protected aliases, first-error abort, cloud-placeholder immediate abort, proof/root/volume/clock mismatch and interval-only semantics. Dynamic budgets hit file/directory/depth/path/elapsed/per-I/O/I/O-count/RAM/frontier/handle/batch/cumulative-response ceilings, exhaustion/frontier-empty equations and watchdog kill. They also prove graceful explicit-close/process-exit, forced kill-on-job-close/process-exit/zero-post-exit-handles, timeout-mandatory forced mode, session non-reuse and rejection of a requested-but-unobserved exit. Continuing after an error, a self-attested walker proof or a completed scan with any unexhausted iterator is a failure.
6. Build pure single-node Evidence/selection/assessment/certificate/structured-result fixtures, including output-vs-EvidenceNode selectors, accounting/clock proof bindings, transitive body digests, exact global-vs-requirement denial and protocol-error tables, dedicated certification key, frozen locale, one assessment time/attestation copied exactly into the certificate while terminal `occurredAt` remains non-authority, one resolvable assessment-input ref+digest repeated exactly through request/assessment/terminal-command/certificate, a stable request-freeze appender command ID distinct from the reserved `completionCommitCommandId`, exact latter-ID equality across the assessment command plus certification/terminal events, lossless unresolved-denial projection and byte-identical retry envelope. Negative lifecycle fixtures must prove `assessment-input-invalid` cites the exact settled Invocation, `internal-error` is certifying-only with no Invocation/receipt/certificate, any post-dispatch receiptless state remains indeterminate rather than terminal failed, and every noncertified block is an immediate reason-equal suffix of `goal.blocked` or pre-dispatch `invocation.rejected`—never standalone/queued/post-dispatch budget failure. The same incomplete fixture must prove that safe observed bindings remain visibly `partial` with one coalesced denial and cannot satisfy `requireCompleteObservation` or render as verified: no-detail `partial-evidence` only when `allow-disclosed`, `partial-not-admitted` only when forbidden, never both. Generate/validate six exact locale×verdict templates and 54 brace-free locale denial messages: blocked with zero claim bindings must render deterministically from unresolved codes, missing required data in a preliminary verified/partial result converges once to blocked rather than presentation deadlock, and malicious token/Markdown/HTML-looking field bytes remain inert after the one template parse.
7. Capture code ownership/current APIs/live legacy false-completion baseline without modifying product code.
8. Run the isolated candidate-store benchmark on disposable `E:` roots and representative Windows 10/11 low/median supported hardware. Compare additive AgentTask V3, lifecycle-V3 + evidence/certificate sidecar and full V4 against the same atomicity/replay/corruption/RAM/CPU/disk/backup/restore/rollback/source-complexity suite. Produce an explicit least-complex passing ADR or retain product persistence as a blocker; do not create any product schema in the benchmark.
9. Cross-cutting fixtures prove `goal.contract-admitted(preparing→preparing) + invocation.prepared(preparing→running)` is one all-or-none commit and `queued` is not a core state; protected-object aliases use disposable protected fixtures; cloud-placeholder is an immediate typed abort; a timed-out broker response cannot mutate accumulator/result; blocked certificate/view/result arrays contain no fields; same-process restart and OS reboot clocks differ; and a second oracle derives schema endpoints, primitive programs, state reachability, storage sums and certificate projection without sharing generator code.
10. Publish a traceability matrix from each `0.3.0` user need/failure class to invariant → schema/rule → fixture → release gate. Matcher acceptance reports harmful false-positive count, false-negative/recall, clarification rate, unsupported-intent rate, RU/EN/voice corpus balance and confidence interval; `zero false positives` achieved by blocking everything is not a pass.

### Tests/evidence

- exact manifest closure/lint and generated schema compile, including full schema/variant digest/binding/state/commit endpoints;
- cross-language canonical/digest vectors;
- fixture corpus reviewed with hashes and reproducible command/output;
- baseline suite/installed behavior recorded read-only;
- parser/store benchmark on disposable `E:` paths only; production Safe/user roots absent from logs.
- simulator crash cuts prove only the explicit retained-state model; actual process kill/power-loss/fsync/restore claims come only from the separate candidate-store harness and remain backend-specific.

### Exit

- Every core invariant maps to an executable fixture.
- Manifest has no missing/extra schema/transition/domain and generated TS has no manual divergence.
- Benchmark report names a product-store candidate or an explicit unresolved blocker; it does not silently choose by convenience.
- Definition/output provenance is one-way and the no-growth ceilings remain exactly 66 schemas, 40 event variants, 8 guard labels, 28 claims and 16 data keys.
- No unresolved core authority owner conflict.
- Independent reviewer who did not create the artifact inspects exact generated files, fixtures, hashes and outputs before any shadow proposal.

### Rollback

No runtime change.

---

## 6. Mandatory product-read foundation gate — only after the pure fixture simulator

> **UNAVAILABLE / NOT AUTHORIZED BY PHASE 0.** This is a future product-read foundation profile set, not part of the core manifest and not the next executable step. It may start only after Phase 0 artifacts, the pure fixture simulator **and the minimum no-behavior-change seam extraction in §7** pass independent review. It is mandatory before any Phase 2 selected-lane cohort write and before Phase 3 ordinary-user route. Phase 0E must already have selected the least-complex passing backend topology, downgrade compatibility must be proven and an explicit go/no-go must authorize persisted product writes. The core event map cannot be imported as a permissive product event vocabulary.

### Goal

Close every product-only owner required to expose the reviewed core semantics without changing those semantics.

### Planned changes

- Generate product-facade command/event/snapshot schemas that import only compatible shared primitives from the reviewed core package; reserved prose names do not become ABI automatically.
- Wrap current `/api/oscar/turns` and Agent task events with compatibility projection.
- Add protocol version/feature descriptor.
- Add stable correlation IDs across Turn → Task → Kernel receipt.
- Split public `ClientCommandInput` from server-attested `AcceptedCommandContext`; preserve current source/origin checks.
- Persist full `InteractionIntentAdmissionV1` body/ref + exact allowlisted matcher descriptor/body ref and raw implementation hash; disposition and future Goal Compiler consume the same admission. No ambient/latest matcher registry snapshot is authority.
- Add a durable continuation owner for every accepted Interaction: an idempotent inbox/recovery scan must resume `accepted -> intent-admitted -> routed`, and startup/package upgrade tests must prove no accepted command can remain ownerless. The product command schema—not a fixture tuple—owns every internal append intent.
- Retain exact historical implementation/package bytes for every nonterminal accepted Interaction/Execution; publish reproducible source→bundle provenance, signed/admitted package identity, process-generation fencing and safe GC rules. Upgrade is blocked if it would remove a referenced executable; a hash alone is not retention.
- Add mandatory current authority/package/implementation revocation checks at continuation, immediately before dispatch, before/after every blocking broker I/O, before Evidence admission, before certification and before delivery. Frozen admission proves historical scope only; current logout/workspace-grant/policy/package deny may narrow/block and produces typed `implementation-revoked|authority-revoked`, never a stale success.
- Add Clock Authority-owned `startBy` and hard `deadline`; missed start never dispatches and an in-flight deadline aborts the broker/read without admitting late bytes. Renewal is a new admitted decision, not an ambient timeout reset.
- Add separately owned certificate invalidation/correction records, projection suppression/rebuild and idempotent user notice. Historical certificate/package bytes move to quarantine/read-only audit evidence; they are not deleted or delivered as current truth.
- Choose and schema-pin the physical dispatch protocol: co-located call/transaction or durable outbox/claim. It must represent process death after dispatch intent but before any receipt, prevent a second read, and give receiptless unknown state a finite recovery/user-visible owner before product import.
- Generate a read-specific recovery profile before selected-lane cohort admission. `indeterminate`, receiptless dispatch uncertainty, package loss/revocation, cross-boot clock discontinuity, deadline, invalidated certificate and interrupted presentation each have a bounded state/outcome; they cannot wait until the later effects phase.
- Generate product query/snapshot/attach and cancellation commands. A long filesystem walk must be observable and cooperatively cancellable from every eligible surface before Phase 3; cancellation cannot rely on an unversioned UI side channel.
- Add an installation-wide bounded read queue with explicit concurrency, fairness, rate/I/O budgets and shutdown behavior. Multiple Desktop/API/Telegram requests cannot start unbounded parallel walks.
- Separate input-append CAS from asynchronous outcome/projection revisions so follow-ups are not starved by progress/delivery writes.
- Add client-visible installation generation, dedupe rollover/retention/pressure and old-generation retry rejection; command records cannot grow forever or regain ID reuse after GC.
- Add per-Windows-principal ACL/at-rest/backup disclosure, explicit retention/erasure/export, backup encryption, consistent snapshot/restore generation, ratified RPO/RTO, quarantine/orphan quotas, emergency/admin/repair schema owners and mixed-version process writer fences before persistent private command/path/evidence data exists.
- Delivery rechecks current principal/session/surface authorization and correction/revocation epoch; old outbox rows are not bearer rights. Add deterministic plain-text/accessibility/reduced-motion fallback that states unavailable/revoked/partial truth without fabricating certificate fields.
- Publish the exact capability×surface matrix, supported Windows/filesystem/build matrix and a non-authority escaped display-path binding to the handle-derived target identity. `logical-namespace-entry-bytes.v2` must never be labelled generic/current/physical disk usage.
- Keep current Astra Skills as a bounded discovery/context adapter only. Its `astra.*` IDs and skill/card bodies cannot become product command ABI, authority, evidence or completion merely because the runtime is named Astra V3.
- Add a non-product in-memory core event/store fixture; Engine driver remains outside core while current answer/legacy AgentLoop stays unchanged.
- Keep existing endpoints; no UI rewrite required.

### Current files likely touched in future implementation

- `src/app/oscar-turn-http.ts`;
- `src/app/agent-task-http.ts`;
- `src/app/application.ts`;
- `src/oscar-turn/types.ts`;
- new `src/agent-protocol/*`;
- tests under `tests/app`, `tests/oscar`, `tests/agent-protocol`.

### Explicit non-changes

- no new effect path;
- no journal cutover;
- no change to terminal verdict;
- no Safe access;
- no SDK/runtime replacement.

### Tests

- current HTTP/SSE tests remain byte/semantic compatible where promised;
- command idempotency/revision conflict;
- source/principal/privacy spoof and auth-epoch replay;
- snapshot + afterSequence reconnect;
- mapping every current Turn/Task terminal state;
- crash/matcher-upgrade between intent admission and Execution creation; no raw-text V3 reparse;
- legacy adapter never manufactures `verified` without current verifier proof.
- accepted-before-routing crash/restart, historical package retention/removal refusal and stale-process writer rejection;
- revocation at every continuation/dispatch/I/O/evidence/certification/delivery fence, start-by/deadline, receiptless dispatch crash, package quarantine, invalidation/correction/user notice and exactly-one port call;
- cancel/query/reattach on every eligible surface, bounded concurrent walks and follow-up input CAS under active progress;
- generation rollover/old retry, disk-full/emergency outcome, retention/erasure/export, consistent backup/restore/RPO/RTO and supported-filesystem matrix;
- private-store ACL/backup exposure and escaped display-path binding without authority substitution.

### Exit

- UI/surfaces can consume common snapshot for both current Turn/Task.
- Protocol adapter has no hidden writes outside existing stores.
- Current source/installed ordinary route parity retained.
- No accepted Interaction, admitted Goal, dispatched read or terminal delivery can be left without exactly one durable continuation/recovery owner.
- Product import cannot lose historical implementation bytes, ignore a newer revocation, accept an old-generation retry, expose blocked fields or run unbounded concurrent reads.

### Rollback

Stop new foundation/admission writes and keep a compatibility reader that ignores-but-preserves additive admission records. This mandatory product gate changes persisted Interaction data, so rollback requires the previous format reader to tolerate these records; the store is not truthfully «untouched». Installer downgrade to a binary without that reader is blocked. No admission body/ref is deleted.

---

## 7. Phase 1 — pure fixture simulator, minimum seam extraction, then conditional shadow

> Isolated synthetic simulator **candidates** may be developed while Phase 0 remains
> incomplete, but cannot claim Phase 1A promotion, executable acceptance or product
> evidence. Phase 1A becomes eligible only after the remaining Phase 0 gates and
> artifact review. Phase 1B is a separate no-behavior-change source refactor gate;
> Phase 1C shadow still requires its own RFC/go-no-go. No eligibility is implied by
> component-level simulator PASS.

### Goal

Prove typed truth binding entirely on synthetic/disposable fixtures, then expose the smallest current-runtime seam without changing routing/persistence/output. Shadow is a separate sub-gate.

### Planned changes

1. **1A fixture simulator:** consume only the generated package and hashed fixture corpus for:
   - `GoalContractV1`;
   - `AgentCapabilityContractV1`;
   - Evidence Graph;
   - `CompletionCertifierV1`.
2. Admit exactly the one pinned `workspace.storage.audit.v2` contract.
3. Compile only exact fixture `InteractionIntentAdmissionV1`; raw text never becomes a second matcher input.
4. Produce an untyped, explicitly non-authority comparison report against frozen legacy diagnostic fixtures outside the protocol manifest; it cannot enter any store/projection.
5. **1B minimum seam extraction:** after simulator acceptance, extract only narrow interfaces around the current storage-read dispatch and current completion/result mapping inside `AgentLoop`; adapters delegate byte/behavior-identically to the existing code. No Astra schema, store, route, certificate or UI result is imported. Golden current-route traces, Kernel calls, persisted Task/Turn bytes and user messages must be identical before/after; otherwise revert the seam.
6. **1C conditional shadow:** only after a separate reviewed RFC/go-no-go may an isolated disposable-root invocation run beside product. It uses no production/user/Safe root, writes no selected-lane/product truth and changes no user-visible outcome.

### Current isolated simulator candidate — 2026-08-29

- `astra-v3-phase1a-isolated-simulator.v1.json` pins the A11 scalar-certificate fixture,
  protocol definition, Completion binding candidate and seven exact simulator/oracle sources
  (six Python, one Node) by bytes/SHA-256, including the capability materializer, layered
  source emitter and shared-lineage entrypoint.
- The runner executes a coherent non-product cohort: ingress owner/schema bindings,
  `68` layered Admission/Goal/Evidence/Certificate candidate schema instances with
  `1175+28` rejected source mutations, one normalized seven-artifact A11 lineage from
  Admission through Goal, Evidence, CompletionAssessment and CompletionCertificate with
  `57` exact binding checks and `39` rejected lineage mutations, the 12-transition
  Invocation reducer, all `9/151` Completion cross-object binding programs with `10+12`
  rejected mutations, and `12` disposable logical-store scenarios including CAS,
  byte-stable retry, pre-commit rollback and post-commit recovery. The shared lineage
  carries `/audit/logicalBytes = 9007199254740993` only as canonical `base10-integer`,
  proving that the simulator does not lose precision above JavaScript's safe integer.
- Node orchestration and a separately implemented Python verifier both reject any
  manifest that enables a product route, product persistence, Safe access, a model or
  network. The verifier also independently recomputes all six domain-separated content
  digests and the cross-stage references from an emitted disposable lineage. Scratch is
  an owned per-run directory under `.test-tmp` on `E:` and is removed after the run.
- This is intentionally a **partial component cohort**, not the Phase 1A vertical
  simulator. The closed `AgentCapabilityContractV1` schema and schema-body digest are now
  retained, and a separate isolated materializer builds one schema-valid/self-digest-valid
  candidate body, executes `55` semantic checks and rejects `50` mutations. The shared A11
  lineage uses that exact body/digest instead of an opaque placeholder. No candidate
  authority row is created because ordinary retained schema ASTs are outside the 19-row
  joint owner/Event authority cohort. The capability instance, Store-issued refs,
  output/EvidenceNode schemas, 28 ClaimTemplate bodies, VerificationRecipe, Interaction
  admission compiler, Goal materializer, Evidence Projector and retained Completion
  Certifier are still missing. Thus `capabilityBodyValidated=true` proves only the isolated
  candidate body; its matcher is explicitly `synthetic-schema-witness-only`,
  `matcherFunctionalSemanticsValidated=false` and
  `capabilityOperationalSemanticsValidated=false`. `capabilityInstanceRetained=false`,
  dependent refs remain open and no runtime owner is manufactured.
  Therefore A11 oracle execution remains false, `0/35` acceptance remains executable,
  `phase1aPromotionReady=false` and product contribution is zero.
- The previous A11 sentence was a false-green fixture: «Сколько байт занято на тестовом
  диске?» implies point-in-time/current truth under the protocol and contains no literal
  absolute Windows target, while the shared-lineage simulator never read the command text.
  The fixture now names `<repo-root>\.test-tmp\agent-core-read\case-logical-bytes` and
  explicitly requests one complete interval observation, not a snapshot. A separate pure
  matcher-policy simulator and independent Python reconstruction agree on `11/11` cases,
  route counts `2 execution / 6 clarify / 2 blocked / 1 not-applicable`, deterministic replay,
  NFC and whitespace metamorphisms. They also expose four still-open descriptor/ABI gaps:
  synthetic retained matcher rules, no informational/not-applicable accepting outcome, no
  informational action, and no prohibition-block candidate code. Therefore this evidence is
  candidate-policy semantics only and does not raise either operational-semantics flag.
- All five nested capability implementation hashes now use exact `raw-sha256` syntax. The
  former `sha256` domain contradicted `ImplementationHashV1` and the Admission matcher binding,
  making byte-equal binding impossible; the capability simulator now checks all five fields
  and rejects both domain substitutions.
- The follow-up additive V2 ABI candidate closes the four representation gaps without changing
  retained V1. It uses finite normalized lexeme classes and literal path-token grammar with
  `semanticRegexAllowed=false`; adds separate informational-answer and zero-candidate
  not-applicable outcomes, explicit informational/not-applicable/block actions, and an
  `operational-blocked` candidate. Matcher-owned blocking is exact prohibition/input-limit;
  capability-unavailable/target-ineligible are exact application eligibility downgrades. Fourteen ordered
  operational rows combine with an orthogonal informational dimension into eight projections,
  including answer+blocked/clarify/execution `mixed-rows`. Clause-scoped facts prevent an
  informational-only sentence from injecting temporal meaning into a separate operational
  clause, while non-informational policy modifiers may bind to that operation; dots inside a
  literal Windows path are not sentence boundaries. Ambiguous double negation clarifies;
  Cyrillic drive-letter confusables fail target grammar; quoted/trailing-punctuation targets
  and separate modifier clauses remain deterministic. Node and independent Python pass
  `20/20` cases with route counts `1 answer / 2 blocked / 8 clarify / 5 execution /
  3 mixed-rows / 1 not-applicable`, four exact application downgrade cases, three metamorphic
  checks and `22` digest-recomputed rejected mutations. Candidate body is `12965` canonical bytes /
  `sha256:2d95bae3a15ed062fb0d4b2f5bc13d640ac947a4a925392ac75e7c31215b8d1f`.
  It explicitly requires one atomic CapabilityContract V2 + Descriptor V2 + Result V2 + Admission V2 upgrade and rejects
  V1 reinterpretation. No schemas are retained and no matcher implementation exists, so this
  closes representation only; functional/operational/readiness flags remain false.
- Exact source closure then proves that the three named schemas are not a sufficient atomic
  cohort. `AgentCapabilityContractV1` embeds the V1 matcher identity/algebra and the retained
  RuntimeFeatureSet binding asserts the V1 capability schema, so CapabilityContract V2 is the
  fourth minimum schema candidate. Content regeneration also proves that the two capability-owned
  semantic profiles require new `.v2` identities: changing owner under retained `.v1` IDs would
  redefine immutable semantics. Seven replaced identities therefore occur `167` times
  (`136` prior closure + `11` claim-profile + `20` requirement-profile). Six FollowUp,
  two Goal and five Event admission-owner links depend on the old owner. There are `31` total
  profile occurrences: two definitions and `29` downstream references. The `56` current V1
  Capability rules are invalidated, while V2 derives only `55` endpoints because the old
  `matcher.ruleTable[].ruleId` endpoint no longer exists; that obsolete rule must retire,
  two semantic-profile owners and the RuntimeFeatureSet binding also change. Closure therefore
  requires `15` authority-regeneration surfaces and invalidates `16` directly containing
  generated artifacts before transitive combined-ABI/Store pins. Node and independent Python
  agree and reject `17` digest-recomputed mutations. Closure body is `7207` canonical bytes /
  `sha256:da3a1f429ed0041f7929c396fc085b0e9a7e176fbcd0b617b2ca30ef068c7b8e`;
  evidence is `sha256:de1c0b5cc286544c328d8c3aa62df9066d943c352c9277da1357504dac4394b1`.
  Activation requires a new RuntimeFeatureSet generation and one Store epoch advance; old
  committed Admissions remain V1 and cannot be reparsed. This exact closure artifact is the
  immutable pre-materialization snapshot.
- The next isolated source materializes all four required candidate ASTs without adding them to
  retained schema/ID/binding/Store authority. CapabilityContract V2 preserves the full V1 frame
  but points to the sole Descriptor V2 instead of embedding another matcher-algebra copy;
  Descriptor freezes all seven ABI sections, while Result and Admission share four ordered
  candidate branches and the zero-candidate `not-applicable` boundary. Source identity is
  `3413` canonical bytes / `sha256:6ce9bb978e44921c897f038d47667cd44237812beacdaa9a46cc72c92c8df757`;
  the four-AST artifact is `43773` bytes /
  `sha256:2e709aa8ccdb93ce669109c6cbfe99f97b1c33e95aec8ceb4aba2a5ede531650`;
  evidence is `sha256:42a7a2b33bacf22b7b604dc089d3565d4b39d1db28810387469c4a5b6fe450a6`.
  Node rejects `17` semantic mutations and the independent Python full-artifact oracle rejects
  `19`, including base-frame/policy drift. Candidate schema shape is materialized; all 15
  authority surfaces, RuntimeFeatureSet/Store activation and implementation remain open.
- The isolated Result V2→Admission V2 projection is now executable as a candidate: `17` finite
  operations cover eight base rows and four application-eligibility downgrades. Target
  resolution runs exactly twice, only after positive capability drafts; failure forbids resolver
  output and capability fields, mixed downgrade preserves the informational row, and
  not-applicable remains zero-candidate. Node rejects `24` output/program mutations; independent
  Python rejects `18` source mutations. Projection source is `7136` canonical bytes /
  `sha256:2ba41637e41fbedd99d82eb057cb32ef5f66958138999e58dd4a3b3dbb8185ef`;
  evidence is `sha256:1fa65b01175fc34fb2b80fce31b5e1dc93170023881f7ecafede97863106ffbd`.
  This is non-retained executable evidence, not authority regeneration, Store authority or a
  matcher implementation.
- The following non-retained package closes the regeneration contract for all `15` authority
  surfaces as one topological DAG. Each surface envelope binds exact input artifact raw hashes,
  source selectors, allowlisted transformations, dependency-envelope digests, output names and
  proof obligations. The package exactly covers the `16` invalidated Phase 0A artifacts, all four
  schema pins, all `12` projection cases and seven substitutions including the two new
  semantic-profile IDs. Source is `14411` canonical bytes /
  `sha256:6390e1c850e16aa2f31c359e63ed117dd153f3cc706b7b4d124113cf7dc7a660`;
  15 envelopes total `26161` canonical bytes; package is `29209` /
  `sha256:78810b9e8807a7ccac0ddb6e62c51df1e894adc9a83ba54ab844d2970779ff90`;
  evidence is `sha256:0979ada42752629b73578f289cb3d927458bcc3f6be0f174ec05e219ccaa740d`.
  Node rejects `25`, independent Python `24` attacks. The first surface can emit only the
  binding program. RuntimeFeatureSet generation requires later manifest, capability-instance
  and Store-issued refs, so only the final layer may emit its non-retained generation plan.
  The actual authority contents, generation, Store cohort and retained activation remain open.
- The first real content tranche materializes the `schema-and-direct-bindings` contents without
  retaining them: four ASTs, two V2 semantic profiles, three direct profile-reference rewrites,
  `55` exact Capability V2 endpoint rules, one strengthened RuntimeFeatureSet binding program
  and all `12` projection cases. It accounts for all `31` occurrences and explicitly defers the
  remaining `26` owner/import references. Source is `3368` canonical bytes /
  `sha256:91be34fc94017c8b7643c4ff03210f52d8fa2a7383d3cb6f8bb4058b1b42111b`;
  artifact is `85938` / `sha256:74dc21899030280fd21f22d8d34810bab3f07239a9ce4c8f2ba68612e7891cca`;
  Node evidence is `sha256:5f1e5e1ead02e5f9a1bf84d360178e746e82d4d997aaa1fdf789636c3bad4887`,
  independent evidence is `sha256:891117e4d8f954cf69b78815f627f107ae17e1795ad9d9a43fb18a53e1270747`.
  Each implementation rejects `24` mutations. Owner/import content, regenerated authority,
  RuntimeFeatureSet generation, Store, matcher implementation and promotion remain false.
- The first topological output-body package gives the four direct surfaces exact named,
  content-addressed bodies bound to their authority envelopes: one binding program, two
  semantic profiles, `55` Capability rules and the `12` projection cases. Their canonical
  bodies total `32855` bytes. Source is `2258` /
  `sha256:98f17eb070f8b4dc81bff8d82c0746f4860efa05df312891fc176e480fd1a1ea`;
  artifact is `34725` / `sha256:c398cea998f951443e88d4aae444d42f5f0d7dd5e080122fbf69d5d105ebbe37`;
  Node evidence is `sha256:14c292aeacf9b96e7d80aeb383d2709dbf02a5810a7df95fb969c1ab42936fa5`;
  independent evidence is `sha256:74be93aee9978859c1b9e79dd9d66d155cc6fb32ee797c29a740b71cfc86ade4`.
  Both reject `20` attacks. These are complete surface-owned bodies, not full legacy artifacts
  or a sealed candidate definition; partial authority promotion and runtime generation remain
  forbidden.
- The second content tranche materializes the remaining profile owner/import changes as an exact
  overlay over the pinned V1 definition rather than rewriting existing catalog/grammar identities.
  Its 26 fail-closed JSON-pointer patches cover 25 layered-owner and one Event-payload reference.
  Composition with the five direct-tranche occurrences closes `31/31` profile occurrences with
  zero unresolved. Source is `1665` canonical bytes /
  `sha256:1e5601432f91c9bcd555440584c375dfb2b0bf8a99eac07544e8335e5c5bad39`;
  artifact is `22856` / `sha256:07a598bd4ea76c039473b8d8b401fd01a68d92d2929cd33f0844882fc0391fdf`;
  Node evidence is `sha256:952487cc4fbb0d77786c55ece6df8bd5a3710bc20fb11b8fac0b734405811ca9`,
  independent evidence is `sha256:ebd0aae650d166499e794d1de93bd5a5db7b023cc01440c6b7ae876df8c7899d`.
  Both implementations reject 20 mutations. This closes only combined candidate references;
  regenerated authority artifacts, RuntimeFeatureSet generation, Store and runtime remain false.
- The owner-import output-body package materializes the four next DAG surfaces as five named
  outputs with exact upstream body dependencies. Admission replaces `47` Admission and two
  matcher occurrences and imports the Admission V2 AST; follow-up and goal replace `6+2`
  owners; Event grammar plus all three projection documents replace `5+5` Admission and `1+3`
  profile occurrences. Including the 25 layered patches, the exact inventory is `63` Admission,
  two matcher and `29` profile occurrences with zero unresolved. Source is `2943` /
  `sha256:52acce8c2c259d1c702427fbdef3e8c75f31cd27a3f2a4e5be98c50cdf157715`;
  artifact is `1324765` / `sha256:8d871dd2dc4cd75b732c566051d5b1f92d45f941deb5e75786175a4e23e44c86`;
  body total is `1322793`; Node evidence is
  `sha256:acd4dd2e17642ea98585620e1eb73d00e168e6b2b5c243046abfa40e2afc8a54`;
  independent evidence is `sha256:e46ad97636047f63e6ee53dd28b1ae2ac0001cb84cb049d80b1641408592e7e9`.
  Node rejects `23`, independent Python `21` attacks. Full artifacts, candidate-definition
  seal, owner closure/rule lowering, retained authority and runtime generation remain open.
- The owner-closure output-body package materializes the next two DAG surfaces as four named
  source-level outputs. The graph/preflight body binds the exact three predecessor body digests,
  replaces the final five structural Admission V1 occurrences, re-hashes the preflight against
  a `16`-node/`16`-edge acyclic graph and retains reject-with-zero-authority-change. The
  schema-authority body replaces the final two owner/authority occurrences and binds all four
  V2 schema IDs to exact canonical URIs, schema-body digests and rederived content-identity rows
  as one indivisible cohort. Source is `2518` /
  `sha256:36dbc5e8f3a6a4433be5f68e3fce893f0ad878d38efbc559946d73e566268dc5`;
  artifact is `22605` / `sha256:ae62a4c2217e8aca1ffd09844439d044ea272b7b5cb9cb40adf3cd23394c726d`;
  body total is `20730`; Node evidence is
  `sha256:5d8fd849564d81c1cdedc2ffefb6508a2a3a45fcaac115811bbc2c6ff62ec0a2`;
  independent evidence is `sha256:7523f7a033df347c7711ec3f2b689527a75cae90c01efda71f3ed4fba06361cb`.
  Node rejects `28`, independent Python `23` attacks. This does not pretend that the old
  `517162`-byte compiled preflight or other legacy artifacts were regenerated: definition seal,
  rule-ID lowering, registry/provenance, RuntimeFeatureSet generation, Store and retained
  activation remain open.
- The Event-owner rule-ID surface now consumes the exact owner-closure body and recomputes all
  `1094` generated IDs from allocation endpoints under the pinned domain contract. Exactly
  `135` Admission endpoints change identity; all `143` rule-reference bindings are recomputed
  and verified, but only `15` reference values actually change. The `34+67` semantic
  classifications bind the V2 profiles. The resulting `1089` candidate rules, five
  external imports and `1089` provenance rows are unique, disjoint from all `117` retained
  rule IDs and have zero unresolved owners. Source is `2200` /
  `sha256:349f80ec4723c5d0ca9974af076393e0fbf0b2e9d08d907c2f11f8e9961dc24c`;
  artifact is `722660` / `sha256:89781085a98df26a85ff62397c1b5aacec2e9fec1c80a504329641693e364d0c`;
  surface body is `720855` /
  `sha256:284ebcba4f65da0953f65afa57cf3d01ef394d3b20aef9be5340421178ab3361`;
  Node evidence is `sha256:dc167cbbf6cee7821b27360e06fdb9c5edf0da32cdb9bd8382327e59e9d24cb4`;
  independent evidence is `sha256:9268f98d8eb10156ad067909fb1deef7e6962099c34217b93bb63571b44330c0`.
  Node rejects `24`, independent Python `19` attacks. This exact inventory distinguishes
  recomputed bindings from changed reference values.
- The joint Owner/Event lowering consumes that exact Event-owner body and recomputes all `3617`
  generated IDs from `3612` candidate rules plus five logical imports. It recomputes and resolves
  all `6656` reference bindings, of which only `20` values change, including exactly five direct
  AgentEvent-to-Admission-V2 links. It remaps `135` Admission endpoint identities and `34+70=104`
  semantic classifications while preserving the complete `1089` Owner and `2523` Event candidate
  partitions. Generated IDs are unique, disjoint from `117` retained IDs and have zero unresolved
  owners. Source is `2292` /
  `sha256:7f5f44f9ba838e1e8e93a7d4a7926c507d6df5f1dbea649eabbcc8573038ff80`;
  artifact is `2063281` / `sha256:e8c63d95dc95c883833e3a6201b23065f1ce72ff77c489a44bcccfb1fa2b04b3`;
  surface body is `2061465` /
  `sha256:0ba2fd18ddab9fa600e93ec5d2dbbb515e0ce47e1b1c1f5bb473b2fc2e042138`;
  Node evidence is `sha256:ac2eaeb3c9aa36552681828cf45a98e8e72fb692e3d1a1da21fd545775d9116b`;
  independent evidence is `sha256:64d670e43ad8b7c175facb712cef56856f960120b663ac9e1333c66b2386d438`.
  Node rejects `24`, independent Python `21` attacks. Composed legacy artifacts, definition seal,
  completion bindings, registry/provenance, generation, Store and activation remain open.
- The Completion binding surface consumes the exact joint rule-ID body and the exact
  RuntimeFeatureSet-to-capability-V2 binding body. It rederives all `9` programs / `151`
  instructions, replaces the one request-freeze capability target from capability V1 to V2 and
  assigns the changed program a V2 identity. Its `292` instruction endpoint occurrences / `157`
  unique routes contain exactly `47` ID-authority occurrences mapped to `23` unique joint rules:
  `39` references and `8` opaque-random owners. Every mapped ID is recomputed from its allocation
  endpoint; unresolved bindings and mixed capability V1/V2 cohort occurrences are `0`. The one
  RuntimeFeatureSet V1 reference remains structural and is coupled to the pinned body that requires
  the same capability V2 schema/digest; RuntimeFeatureSet generation is still false. Source is
  `3122` / `sha256:e499cf200d222146a851310bef31fa624d1769560010d8a587d42e026e13572b`;
  artifact is `96626` / `sha256:94d247f9f4fa1291e66e25367ac36ce8c2578d68f63eecb39d1adfb0c6a3f948`;
  surface body is `94761` / `sha256:f70beaf18973499fa6bfa9c6aa9650d629b44d177544293bcda0255e9b0e83b7`;
  Node evidence is `sha256:a6e95298a7d19c16b8c0078505d3908c6bb50f7fd3b3b717c6d690441a0f4d4c`;
  independent evidence is `sha256:bed4ee5829750ad81fa270cc7067e4bd7c42f0af372415bd0a593d34aa7de839`.
  Node rejects `28`, independent Python `25` attacks. Definition seal, registry/provenance,
  combined ABI, generation, Store and activation remain open.
- The registry/provenance surface consumes that exact Completion body and reseals only the three
  selected registry sections. Four matcher-cohort closure rows move from V1 to V2; the one
  materialized Capability V1 row is replaced and the three missing matcher rows are added. Schema
  closure therefore remains `66`, while structural-document and schema-body rows become `25`:
  `21` retained generated JSON schemas plus four canonical schema-AST candidates. It explicitly
  keeps `generatedMatcherV2JsonSchemaDocuments=0`, `missingSchemaDocuments=41`, conformance false
  and candidate-definition seal false. Provenance preserves all `45` replay outputs and binds all
  `13` predecessor surface bodies to their exact digest, bytes, authority envelope and outputs;
  selected registry sections retain zero replaced V1 identities. Source is `6775` /
  `sha256:1e538661b1d70c05e876a9d1da041461346bdbe7282180494ca071b468f5b4c7`;
  artifact is `55662` / `sha256:c5629187b9ffe586905121f9712d7364a7c8f5a67a23c1ddb61bf18abdebd71c`;
  surface body is `53943` / `sha256:2051556fd01dc9633aba7c66aa0fd354ea30be825481b421a8fd88ea2479eac5`;
  Node evidence is `sha256:7c0f2eebf66e6b8b2e100ab9d6aadbfec4b04599bc99aa03549c35abb769a089`;
  independent evidence is `sha256:9fad3b2801a617d107c6c084138f9d106a28727158bd422434ab9b41b2ca7309`.
  Node rejects `28`, independent Python `25` attacks. Whole registry/provenance rewrite,
  definition seal, combined ABI, generation, Store and activation remain open.
- The final combined-ABI/Store-plan surface exposes and corrects a material source error in the
  base ordinal-14 authority envelope. The base envelope selects the retained 25-program binding
  set, while the combined ABI's own source proof requires Event `114` plus Completion `9`.
  The isolated candidate selects the Event artifact/selector and changes the envelope identity
  from `sha256:13ab547f60f000642a3f022579918a2bbf0fe5e8ba138079c86d70eb6d86cbf4`
  / `2174` bytes to `sha256:5ca43967f68b8799b4f181cb17135863ee63a202e0873eca64a58012a69a5c1b`
  / `2210` bytes. It does not claim whole-package regeneration. The reconstructed candidate ABI
  covers two program sets, `123` programs, `1527` instructions, `26` operations, `8` scope kinds,
  `13` endpoint roles and `2519` endpoint references; ABI digest is
  `sha256:60f11f1b8632bfe70c477b378c03e0c167c4bda0ce905008d4d0698f5f624e59`.
  RuntimeFeatureSet generation and Store cohort are plan-only and require four generated V2 JSON
  Schemas, four Store-issued refs, a sealed definition and one atomic CAS epoch; executed
  generation, CAS, epoch advances and retained activation are all `0`. Source is `4836` /
  `sha256:93d273036fadf7a4098e494db93e1ce6894e7c823e7c7668ec38d16cd2dbe9f1`;
  artifact is `26874` / `sha256:c187a34801c16a776ddeb65c258fd678be493711e5b3cd7b2a415cd27249b025`;
  surface body is `24997` / `sha256:8ea41c617005968347cd5b92915ba60b5fd456cc3e42b319295b130bf8c00787`;
  Node evidence is `sha256:22a916ee541f27cb5944095581dbd2ab2c2575e21c53084d4b2898416484d3fa`;
  independent evidence is `sha256:62524bcdeed02b603f92045bb7120fb091383d02411ca7e30189cd04383290a5`.
  Node rejects `30`, independent Python `25` attacks. Isolated content bodies now cover `15/15`
  authority-named surfaces, while whole-package regeneration, schema emission, definition seal,
  Store/runtime execution, retained authority and matcher implementation remain open.
- The corrected whole-package pass then derives an effective source graph rather than mutating the
  old package. Its first `14` definitions remain byte-identical and ordinal `14` carries the Event
  correction; graph identity is `14446` /
  `sha256:1ba2f7bb3bcd90f19331435f0e2a2c16debca50acd2598cecae309b73f0024a7`.
  All `15` envelopes are recomputed: `14` equal the base package exactly and one equals the
  separately proven corrected final envelope. The resulting package candidate is `29248` /
  `sha256:b7a93867fb803d0e23ae668d500e091e48e9c922875189a59a090f3599e0b1d9`
  and binds all `15` content-body proofs. Wrapper source is `5066` /
  `sha256:736c0e44d4021b1efcedccc357cfc068844601ad0025cf85ba8004a69ffe7e68`;
  artifact is `34150` / `sha256:94f1adb7ce3f597ba03f95acb9057c92f88af8b95917dd83ad3c342960857aed`;
  Node evidence is `sha256:5ade9a98283360ce18584c1479b26f6ba4e062cb34fa6900c972cd30703f6a7c`;
  independent evidence is `sha256:f3260fac5d8412ca310a473a9744e4be4573e3a76d6a9ba98f82c07cdcd41379`.
  Node rejects `25`, independent Python `22` attacks. Corrected package regeneration and proof
  binding are closed, while the `16` underlying output artifacts, four generated schemas,
  definition seal, Store/runtime execution, retained authority and implementation remain open.
- The schema-generation pass compiles the four candidate ASTs into actual Draft 2020-12 documents
  inside a non-persisted artifact. All `10` selected-variant refs resolve against the materialized
  base-plus-candidate graph, source-only `idEndpoint` emission is zero, strict AJV compiles `4/4`,
  and independent Python reproduces the same canonical bytes and schema-body digests. The rows are
  Capability `17845` / `sha256:34e92a3ee1edb58d7c62208b1d0a9229f3d11610c13a9b5b9143eceda195a888`,
  Descriptor `11019` / `sha256:c7182b5932449ff152e2e5235554a5fcc86594f60e1eee0a26380b1912ea8fe0`,
  Result `5571` / `sha256:32135e03f305e9ba2d35ac2f2dcab48742b0c13320d835fa78a0accdf183cc85`,
  Admission `13296` / `sha256:016fd16c34c27037f0589d8e105b82725686b4a6db26e98e8ffc5e2dad0cbb46`.
  Source is `3615` / `sha256:d3c53b0a21065e58969b8a39f5fdb76cabc5cec4912189a41ebadd2460924742`;
  artifact is `53525` / `sha256:26c208fc539664f0ad0d760804be242fdd0b779f658ee66d43c94000abb4ef3e`;
  Node evidence is `sha256:eef5d3b68a3857c8232a9be76a1ce27773d8e736eb51be02c5df45cefa2a1095`;
  independent evidence is `sha256:8b5ae032da7746dce540e1e3dae4228de97eff655359d726ed3f03a87ff0de8a`.
  Node rejects `28`, independent Python `25` attacks. Registry recomposition and definition seal
  remain open; `41/66` schema documents are still missing, and no document was persisted or issued
  by Store.

- A dedicated registry composition then replaces exactly four matcher AST placeholder rows with
  the generated-document rows and preserves all `21` retained generated rows. Source is `4180` /
  `sha256:25260bd93d3939d60ac4d8aad769afdb2477c28abb564911fa7bcd64b376b25f`;
  artifact `59582` / `sha256:af54ab476f95b89d0f2e42dba8ffed7d6e749ab2035083b223fc9b7ffd3a7e2d`;
  evidence `sha256:526980095febd669ac92cddea39ca68c06349d8fd8a187182d1aa1d0e6b55cc9`;
  independent `sha256:cb3ad7803da7fbb795ba8eaf0d0cc2cdd072fa47190352357ff40339a759d860`.
  It truthfully remains `25/66` with `41` missing at this intermediate boundary.
- Classification of that missing set against four exact Phase 0A candidate artifacts proves that
  `18` of the `41` already have complete canonical documents and authority-plan parity; only `23`
  are actually unmaterialized. One additional compiled Admission V1 document is excluded because
  Admission V2 already supersedes it. Classification artifact is `44823` /
  `sha256:6190f7cd07b44b1e102e7b2af9011ea09640843f0955cb4577f87e1fb3cd36be`;
  Node/independent evidence is `sha256:107c4916d3d03f212fdce9634bed14c3b67ad0af3c36c50c7e317b25385ddbc1` /
  `sha256:7f1a7a28af7da90b9e6607f3837638bab4aea58c3c2db43769fda373f98785fe`.
- The append-only tranche then composes the exact 18 candidate rows and preserves all existing
  rows and the full closure. Registry accounting becomes `43/66` materialized and `23` open;
  schema-body rows are `43`, candidate content-identity rows `22`. Source is `2354` /
  `sha256:b886fca4a8cb228e45d8be0c686fb80a1aa47c17535568827d451d45d3797713`;
  artifact `118940` / `sha256:7bd6f9f2d969dcf624a3c597fdc4697c2a8748742c01b62bfac4d1ed260f02d3`;
  Node/independent evidence is `sha256:e5a4bada2c50414495273289953e51fc4dbd77ef1a6e404cd879a16fc512c182` /
  `sha256:3920c5f6573a622b78c6bd1d578d1d2069c1053d58b84dd94689126f569b8e8e`.
  This is still pre-Store: no standalone candidate persistence, ProtocolSchemaRef, CAS epoch,
  definition seal, retained authority or product runtime mutation occurred.
- A further bounded extraction uses only already generated closed subschemas. Invocation dispatch
  key agrees between the atomic and layered Invocation documents; all 12 Invocation transition
  branches agree between AgentEvent, CommitEvent and CommitGroup. Strict AJV compiles both roots
  against the retained ImmutableContentRef closure, and independent Python reproduces bytes and
  digests. Dispatch is `774` / schema-body
  `sha256:8512bfff16ab92baf1f4ff4a6c05da002bf0250758eb996a8e0ba8bc8985b821`;
  Transition is `11639` / schema-body
  `sha256:fe642af8eb3e128fc72abbb9e6d81e774c2f3e05effe19313990f2d402842e0f`.
  Registry accounting becomes `45/66`, with `21` open and `24` candidate content identities.
  Source/artifact are `sha256:9733b5ee85ed6d21341083d605002c610ab5db3f7391cb3acd7b09d45428a5a9` /
  `sha256:34cb24c9ca4fb4a6b8ca8780db16f6c953f785499965ad6381f5b5f1abd283df`;
  Node/independent evidence is `sha256:c31275a7a394b92f921ad95c840a920619204bf9e9e27108e7e4abb9793db823` /
  `sha256:444740f9548cb9572f7f6a47a8fe38f3f525ae7278c55a02b9db200fcdc7b074`.
  No standalone file, Store ref, epoch, seal or retained mutation was created.

- The first source-authored topological tranche pins three exact normative declarations and the
  `417373`-byte compiler source, then emits `AgentCommandReceiptV1`, `CommandDedupeRecordV1` and
  `RequirementAttemptSelectionV1` as closed Draft 2020-12 documents. Node/AJV and independent
  Python agree on all `6068` canonical bytes and the three schema-body identities. Append-only
  accounting becomes `48/66`, with exactly `18` open and `27` candidate content identities.
  Source/artifact are `sha256:d5b619e430c0abd2fa66a31c857236e353cc637ad8d9eba34b8e2dfac8205629` /
  `sha256:5367f8f5f59f9e696f41217c9da2a9bd791ee2b89ff91e374ba70c79ad7f6de6`;
  Node/independent evidence is `sha256:fcb0ca42aa9d6edb689f63eecee6f1e6f855ec12f522be05a9f52df44bd6d7b1` /
  `sha256:d6fa926014136d436e3271fb78486f345640e684adf97c6732817dc02ccd3b4f`.
  This tranche does not compose its ID-endpoint authority, persist schemas, issue Store refs, seal
  the definition or alter retained/product state.

- The evidence-foundation tranche adds only `EvidenceAdmissionKeyBodyV1` and
  `EvidenceGraphSnapshotV1`. It preserves the `raw-sha256` implementation-hash domain and exact
  one-node graph tuple; both compilers agree on `4556` canonical bytes. Accounting becomes
  `50/66`, exact open `16`, content identities `29`. Source/artifact are
  `sha256:dcfcfa8289b70ed2780ea96e989c4c0a848440db8e3d0ba1400d412a6ddc2f24` /
  `sha256:d03e1da56fe65f094bb2db11b069805a0dae5e1ade0e9e9f10ff5bbcf5912b86`;
  Node/independent evidence is `sha256:e54a82663480b51e80092a8841f289dfe5a680db6098c9663db2a7d4bf020b11` /
  `sha256:6d33f19686cca31f9a3d7f2cc22802aaa37f3c55a8c27a68b07586a74e38c745`.
  ID authority and every persistence/seal/Store/retained gate remain false.

- The goal-foundation tranche adds only `DeterministicGoalMinimumV1` and
  `GoalAdmissionBindingV1`. Before compilation, its nested `targetBinding` and `partialPolicy`
  ASTs must exactly equal the already proven schema-cohort helper shapes; this prevents a second,
  subtly wider interpretation of Goal authority. Node/AJV and independent Python agree on
  `19360` canonical schema bytes. Accounting becomes `52/66`, exact open `14`, content identities
  `31`. Source/artifact are
  `sha256:976beea1c3ebbdbf1a820e421281eb990efab0a063c40b400fcb29f7585b13e3` /
  `sha256:a3635f306dda5e2d88ca78413ea7125ed9f60c203d945492f956ada63fcf1c26`;
  Node/independent evidence is `sha256:354193b8b4551f821f6c908ad3d911177381967300ccfe103080ecf19acc7a02` /
  `sha256:a9d8dd1937a04ceecf56518817f2c97f1f89ece24288ae247f6ff51d50532fe1`.
  ID authority, semantic ref-kind narrowing, persistence, seal, Store and retained/product gates
  remain false.

- The command-fingerprint tranche derives `CommandFingerprintBodyV1` from the exact two generated
  `AgentCommandV1` branches in the pinned atomic-preflight artifact instead of compiling the broad
  review-time TypeScript aliases. Payload refs, target and follow-up CAS are copied exactly;
  command/correlation/time/accepted-context fields are forbidden in the projection. The generated
  document is `1970` bytes / raw
  `sha256:e4b15649d2982da922b1a6ec35830b90b42cdf40a95dd6c01c0c4f3882431f6a` /
  schema-body `sha256:dd55a50a92131f5d107bb9b88a923b7f2ca2fc92472b014e98fc4fd8c2dcb9f0`.
  Accounting becomes `53/66`, exact open `13`, content identities `32`; Node/independent evidence
  is `sha256:1b22064ad356f23956e36720e447592f4b37f3f51c960c80627604d69b8fe6e2` /
  `sha256:eeb7e96b7d30e8b7691f1b827946456ce6177c340e1574850e789ae17227422b`.
  ID/binding authority, persistence, seal, Store and retained/product gates remain false.

- The protocol-error tranche pins and parses the exact 24-row normative error table, expanding
  seven optional diagnostic pairs into `31` disjoint branches. Diagnostics are either fully absent
  or a complete digest plus the pinned opaque-bytes ref narrowed to `purpose='diagnostic'` and
  `private|sensitive`; free-form message/path/cause/detail fields are impossible. The document is
  `18318` bytes / raw
  `sha256:c11aeb85149ac6dc360c0dfffe15552feff6e3bb9c8a89b0c2343a513e05a45c` /
  schema-body `sha256:7c8dafa1fbb1b2c80a71e89718028e2059bd1f080b16db4a34ece73f02ac91ee`.
  Accounting becomes `54/66`, exact open `12`, content identities `33`; Node/independent evidence
  is `sha256:e25e474f3d32ee11fa746b7d4f2cd1a3c57a33d24f16aaffe45d58d7ee33d252` /
  `sha256:0c16679d459447bf684338c601820748721b7f5f73ae068578a47718c9738de1`.
  Trace ID authority, persistence, seal, Store and retained/product gates remain false.

- The selector/recipe tranche derives 28 selector IDs one-to-one from the 28 claim members and
  compares them with the separately pinned selector semantic profile. Selector has exactly six
  legal value-type/encoding branches; Recipe has the sole capability-owned identity/projector,
  raw implementation hash and exactly 28 unique claim-template digests. Their documents are
  `10158 + 1201 = 11359` bytes; schema-body digests are
  `sha256:d93e1bdb904e04d358140c0b9be865683ee2f29287b9f13fbba3a3966cf9cf70` and
  `sha256:bfbc1b746b8e616a2262318536780c1e135434d77d45dd79b7fb14bf4cc0ef3f`.
  Accounting becomes `56/66`, exact open `10`, content identities `35`; Node/independent evidence
  is `sha256:45fa153099baa6742d4850083097e07a955f6223d5158654f8759793b4e0d8f1` /
  `sha256:9cf1ef608503fe3eb6db755c21922a3808602c19e4702977a559e073b41d6b21`.
  Claim-template bodies, ID/binding authority, persistence, seal, Store and retained/product gates
  remain false.

- The claim-template tranche consumes the exact pinned §9.4 table as executable source and emits
  one disjoint branch for each of its 28 rows. Core template version is fixed to `1`; row ID,
  selector ID/source/pointer/type/encoding, predicate, private classification, presentation key and
  complete settled-observation evidence policy are exact. `condition`, `maxAgeMs`, claim-local `id`
  and alternate authority/kind fields are closed out. The document is `60830` bytes; raw/schema-body
  identities are `sha256:99ca66ac43e93d1c300e93b18e435aa619a7e588aacafb9724000688fc54d988` /
  `sha256:6a84181445fc506cf0f021741b96784fb8932b060aa0f47199e9565c94542a7f`.
  Accounting becomes `57/66`, exact open `9`, content identities `36`; Node/independent evidence is
  `sha256:03c34d220dfbb1c74e642b399cd72191c6a7adbeebf250f07501c03be5186f5a` /
  `sha256:9c927527166b9c27f4be68b8ca7def62d66d31203ac96bccbacad3867e92de79`.
  Repeated-digest equality still requires generated binding authority; ID authority, persistence,
  seal, Store and retained/product gates remain false.

- The identity/receipt tranche projects the pinned definition's exact `23` opaque-ID kinds, `5`
  semantic profiles and `117` endpoint rules into one immutable profile schema, then expands Kernel
  Receipt into seven closed branches. Completed alone may carry result/proof; cancelled/failed/
  unknown each allow either no diagnostic or an atomic diagnostic ref+digest pair. A found widening
  in the first attempt is now closed: the retained opaque branch is narrowed to
  `purpose='diagnostic'` and `private|sensitive`, so an artifact ref cannot masquerade as receipt
  diagnostics. Profile/receipt documents are `44680 + 12104 = 56784` bytes; schema-body digests are
  `sha256:2defa63f3e52e10f809ec102603900fd202b4887a565deb738bebdd8cfb9613c` /
  `sha256:98da5961a3630632d74f364887479b97b73e3c5cd0a97dd545306ce41ddfd332`.
  Accounting becomes `59/66`, exact open `7`, content identities `38`; Node/independent evidence is
  `sha256:8e6f73b0b4ddedb239ff72ced9911e441042ddd82eb067d68756b101f5de64a2` /
  `sha256:3dbe6ef85b7a08d9f6b3155c0db3ce00e5ff30bd336b0f4f47e45b8a4368f01d`.
  Receipt content-kind/digest equality remains a binding gate; ID authority, persistence, seal,
  Store and retained/product gates remain false.

- The storage proof/output tranche closes two read-capability result schemas without simulating a
  product walk. Traversal proof has `14` disjoint disposition branches and `11` exact limit-witness
  branches; Workspace output has the exact `18`-member abort vocabulary. Potentially unbounded
  counters use canonical decimal strings, executable identities retain `raw-sha256`, and both
  schemas require the atomic diagnostic ref+digest pair iff any skip/error/cloud-placeholder count
  is positive. Proof/output are `25711 + 6259 = 31970` bytes; schema-body digests are
  `sha256:3fffd836b29d8910a6f7a3978294b8bf8ccf0f1594b26c94c0568b70f6a8794e` /
  `sha256:7b9f8043ffde35bbb34d5fe75cec6223ff1a6507fda8e08c4f7d0eac594e01bd`.
  Accounting becomes `61/66`, exact open `5`, content identities `40`; Node/independent evidence is
  `sha256:396c63e7ff60e3acf1e200b4291db33bb672c584576d3884bc2cde4005821103` /
  `sha256:dcec6e4d588ee777ce4ec5a46ba832949ee79ff18fe897ab4c08e764d33041f9`.
  Exact cross-object root/policy/proof equality remains a binding gate; ID authority, persistence,
  seal, Store and retained/product gates remain false.

- The goal/presentation tranche then fixes one exact Goal requirement with the ordered 28-claim
  tuple projected from ClaimTemplate, the four authority/target/temporal/budget constraints, and a
  six-template Presentation contract with `28` allowed keys, `16` required keys and the exact
  `27×2=54` localized denial slots. Template strings accept only verdict-specific allowlisted
  double-brace tokens and denial text rejects braces, while exact token occurrence and repeated
  ref/digest equality deliberately remain semantic binding obligations. Goal/presentation are
  `53885 + 25189 = 79074` bytes; schema-body digests are
  `sha256:045769a38430829ffd6791fcf93f033f908027bc78d73982bded6ffe9c3c58b6` /
  `sha256:fb2f0010a2880d5b0e3ec69ae766eff5975dd85544a12f687d34d15a2e7e3a63`.
  Accounting becomes `63/66`, exact open `3`, content identities `42`; Node/independent evidence is
  `sha256:9e315c6750c15022882586d19291179d15e9215655c24d6fc0a3d3e9e633ba6d` /
  `sha256:694dbbc1fde44370791beb2ece3ab50eda5da5f4e1b24684f218c385720bfb54`.
  ID/binding authority, persistence, seal, Store and retained/product gates remain false.

- The evidence/result tranche closes shape validation for three EvidenceView verdict branches and
  six StructuredResult locale×status branches. Blocked cannot leak fields or presentation keys;
  verified cannot carry unresolved denials; partial/blocked require them; both artifact arrays are
  exact empty. Non-blocked fields are the ordered 28-claim tuple, required presentation keys are
  the exact 16-key tuple, and each locale/status pair selects one exact template plus a closed
  disclosure-key tuple. Repeated ref/digest/value equality, disclosure parameter expansion and
  View↔Result equality deliberately remain binding-authority work. Evidence/result are
  `37620 + 69854 = 107474` bytes; schema-body digests are
  `sha256:4dbf6fe31ca8468e5f6b60375b6ba0e77245f24c2558588458f501f0bfde4ed8` /
  `sha256:50297c76ea10796f6f7611659eeb32ffa5c48c161fd641e5477494ac6d406aa8`.
  Accounting becomes `65/66`, exact open `1` (ProtocolFeatureSchemaManifest), content identities
  `44`; Node/independent evidence is
  `sha256:81d9a975c125c67852823388472a7ef271efb119956565033350fb37d99c41c4` /
  `sha256:e4c6265ac8b51918b691d9821f1ca3d922fa6a8d406cc905cbb4ff42f9a3756e`.
  ID/binding authority, persistence, seal, Store and retained/product gates remain false.

- The Protocol-manifest schema tranche completes structural/schema-body accounting at `66/66`
  without constructing an authority manifest instance. Its exact tuples contain all `66` schema
  IDs/versions with row-matched public JSON-Schema refs, all `50` digest domains and all `66`
  closure-derived content-identity rows. The remaining rule arrays have closed bounded item shapes,
  but exact rule membership, roles, repeated digest/ref equality and Store-issued refs deliberately
  remain authority work. The schema is `168385` bytes; raw/schema-body digests are
  `sha256:68b00a84969b3e47c6d6dd75ab9e3a051802ba1812f4490e8b9b82e87d7ecf31` /
  `sha256:f3efcc38e020fe70e744d98f69259e1aad944125bdb731dfbea45bca1bf93127`.
  Node/independent evidence is
  `sha256:204b31f3484ec3c1a3fd381a047e321ac2e4dfd623aa8a7e5be21b4ad41eba86` /
  `sha256:050ddf4cb39a90875b241d1593ee86e4e91ff1f65603cda6eb3fbada7277a8aa`.
  Missing schemas are now `0`, candidate content identities `45`; manifest-instance, ID/binding,
  seal, Store and retained/product gates remain false.

### Important design constraint

Fixture/shadow mode is pure/read-only with respect to execution truth. Phase 1B is a structural seam only: the current runtime remains sole behavior owner. Comparison artifacts live only in isolated test storage on `E:`, contain no production user path/content and never form a second terminal state/telemetry pipeline.

Current G0 Golden Trace tranche materializes four closed Draft 2020-12 schemas and six
synthetic records for exact `POST /api/oscar/turns` / `OscarTurnCoordinator.submit`. Nested
route, raw-envelope, ordered seven-layer facts and the exact 19-field no-omission list are
closed; legacy Agent Card/Slot/skill text/telemetry/audit cannot become route, runtime-state,
tool or completion authority. Node/Python accepted `6` synthetic and rejected `12` negative
scenarios; independent verifier rejected `26` source and `34` artifact mutations. Source /
artifact / independent evidence:
`sha256:e0a7f8a3756d7ed6b6cef50ee5832ee05529fd9d4036a8a2d35bcec58073d627` /
`sha256:ee053a7d40e6959e1d8a028f17c082b8ddaf23a4aeae2c18e728783defe5ff34` /
`sha256:4176c5ebe23d0b6567d1e152ffd7d99d948cb0e7d9d9091c528d6ea96a56b8fc`.
This is schema/corpus preparation only: ordinary-route executions `0`, real Kernel dispatches
`0`, eligible baselines `0`, user-data reads `0`. G1 fixture capture and every shadow/product
seam still require separate go/no-go.

### G1 disposable answer-route capture — isolated execution complete, not a baseline

Source inspection found an existing no-product-patch seam. A test-owned fixture can inject a real
`OscarTurnCoordinator` into `MonarchApplication`, run the real `createMonarchHttpServer` on
`127.0.0.1:0`, call the real `POST /api/oscar/turns`, then read the real JSON replay route. HTTP
request/response bytes are captured by the test client; Turn events come from the injected
`InMemoryOscarTurnStore`; message projection comes from the injected `persistMessage` receipt.
The answer executor is a deterministic local async iterator, so external network/model/Kernel
counts remain zero. This observes the four answer-required layers without changing product code.

The existing `tests/app/oscar-turn-http.test.ts` proves that composition seam but is not itself G1:
it allocates via `os.tmpdir()` (normally `C:`), does not emit the Golden Trace schema/envelope,
and injects `agentRuntime:null`. G1 therefore MUST allocate only beneath repository `.test-tmp`
(currently a checked D: junction), canonicalize/verify that exact child before cleanup, use an
ephemeral loopback port, disable Internet/memory/history/personality/skills/quality regeneration,
forbid attachments and environment/credential reads, and keep only a content digest tombstone
after raw envelope deletion.

G1 may certify only the answer lane (`http-ingress`, `turn-store`, `public-replay`,
`message-projection`; the other three layers are explicit `not-applicable`). It MUST reject any
agent-lane eligibility because `agentRuntime:null` cannot observe `agent-task-store`,
`application-action-gateway` or `turn-reconciliation`. A later G2 needs the actual V2 AgentRuntime
with deterministic decision provider and one disposable `workspace.files.read`; a mock checkpoint
or copied Task object cannot stand in for a real Kernel dispatch. Neither G1 nor G2 is a V2 quality
baseline until full EvaluationManifest/hardware/build/package/calibration gates pass.

Machine plan `astra-v3-v2-ordinary-route-g1-capture-plan.v1.json` прошёл `12/12` scenarios
и pin readback `7/7`; Node/Python отвергли `30/20/16` mutations. Source/artifact/evidence:
`sha256:3a1456169ebde51760e02ba69c5f63ce16d8bf6b493c19879697557acff532a2` /
`sha256:7b35708124d93f3628fb5811b5399d4cb9b71cc0002b41b53019c488e2471485` /
`sha256:82bee45150920eac008def9a5015e30317dacddf09be2005f9d63c5575d095b1`.
Plan counters остаются route/model/Kernel/user reads `0`; это только закрытие design ambiguity.

Отдельный exact-scope permit
`astra-v3-v2-ordinary-route-g1-capture-permit.v1.json` разрешил только synthetic answer lane
на D/E loopback и явно не разрешил G2, shadow, product code/persistence, model, external network,
Kernel dispatch, user data или Monarch Safe. Permit digest:
`sha256:e4fba9d1e7a950d52d6dafff4406ac4588038fc70e569f88a08cf0e1624d5aaa`.
Реальный `MonarchApplication -> createMonarchHttpServer -> POST /api/oscar/turns ->
OscarTurnCoordinator.submit` выполнен с настоящими Application/HTTP/Coordinator entrypoints,
двумя `InMemoryOscarTurnStore`, deterministic local answer executor и штатным synthetic session
token. Нормализованный result имеет `4082` canonical bytes / body
`sha256:e712e0a956840597d601916ff5ba0bec9916040e649e10cc033f2c8ff9bd13dc`;
raw/normalized/comparison digests сохранены только в contentless tombstone. Raw envelope и exact
marked child root удалены до emission; absolute path не удержан.

Capture подтвердил four-layer parity: terminal in-memory store, authenticated terminal GET,
public JSON replay и два message projection receipt совпали; event order —
`accepted -> routed(answer) -> delta -> outcome`. Counts: один route, один deterministic executor,
три loopback HTTP requests, два message receipts, model/Kernel/external-network/data-egress/
memory/personality/user-data reads `0`. Независимый Python запустил route ещё дважды и получил
byte-identical canonical evidence; отвергнуты `26` artifact и `14` permit mutations. Evidence:
`sha256:8b5eb7d3676e530b7139b3941d7e34afd9c44e9dfe56f15366df5925c52d786e`.
Focused Vitest: `1/1` file, `3/3` tests PASS за `8.32s`; orphan capture roots `0`.

G1 одновременно открыл текущий V2 ordering defect: обычный answer outbox сохраняет assistant
message без `requiredPreviousMessageId`, хотя startup terminal-repair добавляет эту привязку.
Наблюдаемый порядок `user -> assistant` поэтому не является durable ordering proof. Capture
намеренно имеет status `...ordering-gap-observed-not-baseline-not-shadow`; defect не исправлялся
в product source и G1 не стал quality baseline. Astra Product Facade обязан требовать exact
causation/prerequisite receipt для каждой assistant delivery и не считать list/order coincidence
доказательством. G2 с real V2 AgentRuntime и одним disposable `workspace.files.read` остаётся
отдельным последующим gate, а не следствием G1 permit.

### G2 real V2 AgentRuntime workspace read — design and isolated capture, not a baseline

`astra-v3-v2-ordinary-route-g2-agent-read-capture-plan.v1.json` pins `13` current source files
and closes the next no-product-patch topology. Construct one real external `MonarchAgentRuntime`
with `InMemoryAgentTaskStore` and `ReplayAgentDecisionProvider`; inject it into the real
Coordinator. Construct Application with its internal AgentRuntime disabled, then bind the
adapter callbacks exactly once to Application prepare/submit. A callback before binding or a
rebind fails closed. No direct Kernel handle or Workspace call may substitute for that route.

The literal request `Прочитай файл fixture/status.txt и верни результат чтения.` was checked
against current `classifyOscarRequestDisposition`: `agent`, `file_operation`, local target.
This pure classification check is not a route/Kernel execution. Coordinator's operational
contract selects a `verification` output. Planned successful counts are exactly one replay
decision, one Application prepare, one submit, one Kernel dispatch and one Workspace read.
The fixed fixture is `ASTRA_G2_READY\n`; `models.agent.synthesize` and all real model calls are
forbidden in this tranche. Completion must bind both Coordinator goal IDs to the successful
Kernel observation and include the runtime's `verification.completed=verified` event.

The nine required observers cover HTTP, Turn, Agent Task, Application gateway, Kernel,
Workspace, reconciliation, public replay and message projection. G1's predecessor gap remains
an explicit negative result: missing `requiredPreviousMessageId` can be captured but cannot be
silently repaired, called durable ordering proof, or counted as an eligible quality baseline.

Workspace V2 policy is broader than this fixture: it includes additional local read-only roots.
G2 must enforce exact child `realpath` before route and forbid later fixture mutation. It does
not claim the Workspace output is a sandbox receipt. A symlink escape is rejected by the
fixture preflight before route; no real Safe/profile/external target is opened. Hostile
concurrent mutation/TOCTOU resistance is not proven. Server is closed first, then external
runtime drained/stopped, then Application/Coordinator stopped, then only the exact marked child
is deleted. No raw envelope, fixture content or absolute path is retained in normalized output.

Source `12555` bytes / `sha256:ca53c7822dbc0762a847730bf1315963dcb529dd760666b8ce4d85a243adbad3`;
artifact `8600` bytes / `sha256:5999a62398daf03c18da1bb33507d4984b6fc971946ad5addeca23c4be206d88`.
`22` planned scenarios include D/E happy paths, missing permit, duplicate runtime, mocks,
misrouting, extra synthesis/read dispatch, protected paths, missing verification, unfinished
plan, predecessor gap and exact cleanup recovery. Node/Python reject `34/29/16` resealed
source/independent-source/artifact mutations; independent evidence
`sha256:d4ca0ae9871b56003c50b1737ebeb44dfc43d091a02a31aa28e04d2c24adad6d`.

This is a truth table for the **planned capture**, not evidence that V2 passed its scenarios.
The immutable plan retains `g2ExecutionAuthorized=false`; it does not itself authorize execution.

Subsequent isolated execution uses separate permit
`sha256:38d19c4a12bb2612ae0514eea400dfca720ca3e60d7a4f591c37d0e7e3580745`.
The actual HTTP → Coordinator → real external AgentRuntime → Application prepare/submit →
Kernel → real Workspace → task verification → Turn reconciliation → message/public replay path
completed with one replay decision and one read dispatch. Harness-only fixture validation reads
are separate from that one agent dispatch. Model/network/user/Safe access stayed zero.

The capture deliberately reports contract gaps, not a quality baseline. Normal assistant
projection lacks `requiredPreviousMessageId` here too. The live Workspace observation also has
`outputSchema.declared=false, valid=null` despite manifest `verification.kind='schema'`; V2
still records action/task `verified`. This confirms the legacy missing-output-schema inventory.
The exact synthetic content was independently checked, but no V3 typed/schema claim may be
inferred from the V2 label. Do not add a fake output schema/receipt inside the harness.

Raw capture and the marked child are removed before output. Body `4240` bytes /
`sha256:1b4ae1a33616996d43f3f451df3bd348577a5c0527c0e6e02b06566d391e90a2`.
Two independent real-route runs were byte-identical; `14` permit and `20` resealed artifact
attacks rejected, new orphan roots `0`. Independent evidence (including exact harness source
identities): `sha256:93e0eb759d021b5905e722cb2a19ef78b944ca69f263eda60a5c5585166ab888`.
G2/G1-capture/G2-plan focused suite passed `9/9` tests in `19.87s`, including duplicate-key and
resealed second-dispatch permits rejected before fixture allocation. Root/file realpath alias
checks are preflight controls, not a TOCTOU proof. No product code was patched. The next
architectural decision is how the migration acceptance corpus treats observed V2 gaps without
copying them into Astra or claiming a real-model/Computer Use/performance baseline.

### G1/G2 defect disposition and regression admission

Frozen V2 observations are not the expected correct Astra behavior. Preserve legacy
`answered`/`verified` and each gap; do not repair a capture in place or turn fixture checks
into a capability contract. `workspace.files.read` cannot be renamed to core
`workspace.storage.audit.v2` to bypass its semantic requirements.

| Consumer | G1/G2 disposition |
|---|---|
| Diagnostic/regression source | Allowed with exact reviewed capture identity and explicit gaps |
| Expected correct Astra behavior | Denied; requires normative contract and independent outcome oracle |
| Native EvidenceNode / CompletionCertificate | Denied; legacy label/test content check conveys no V3 proof |
| Outbox predecessor receipt | Denied; observed array order cannot reconstruct causation |
| Full-task/real-model/holdout success | Denied; these captures do not execute that methodology |

Known defects must not disappear from the future baseline denominator. Freeze task membership
before execution; retain each independently adjudicated success, failure and invalid measurement.
Invalid/missing observations make measurement incomplete, not smaller or successful. Functional
read success, schema-proof availability and causal delivery are separate axes: G2's correct file
content proves neither schema validation nor durable ordering. Repeats/repairs do not create
independent tasks; a corrected capture receives a new identity and preserves the old regression.
`qualityBaselineProduced=false` is a methodology boundary, not a rule to retain only V2 successes.

Executable lab: `scripts/architecture/simulate-astra-v3-legacy-gap-acceptance.mjs` and
`tests/architecture/astra-v3-legacy-gap-acceptance.test.ts`. Fresh real G1/G2 captures retain
their original verdicts and exact identities. Native/certificate/causal/quality-pass and unknown
uses are denied; resealed predecessor/schema/quality repairs fail. Inputs remain unchanged.
This is a diagnostic admission oracle, **not a product LegacyAdapter/Projector/Certifier**.

The separate in-memory outbox fragment requires a committed user predecessor in the same
conversation/turn and rechecks its current-head binding and runtime-owned delivery receipt at
delivery time. Duplicate delivery returns the same historical receipt; identity reuse with a
different body fails. Missing, foreign, uncommitted, assistant-as-predecessor and superseded
bindings fail without append. Callers cannot mutate lab-owned state through input/return objects.
No disk, sink acknowledgement, process-crash recovery or full steering admission is proven.

Lab `24/24` PASS (`5.32s`); with existing reference/fault oracles, `3/3` files and `27/27` tests
PASS (`6.63s`). The older illustrative fault oracle's type/target/content match is not a complete
certifier or schema/authority acceptance gate. No product/shadow imports or activation added.
The subsequent storage-audit capture below uses its own permit, not an extension of G2.

### Real V2 storage audit: correct receipt, wrong verified answer

Separate synthetic permit:
`config/agent-architecture/astra-v3-v2-storage-audit-capture-permit.v1.json`, body `4953` bytes /
`sha256:07364bb87532c1fc2c3a532361b5478ce960ad8cf35b2c1ba3eedf739ae031e0`.
The real backend route uses a **server-derived Desktop principal** with a synthetic attestation
token on the fixture-only loopback server. This is not installed Electron/UI evidence. A request
with only `surface='desktop'` was correctly rejected as API-origin before any task/dispatch;
the harness was corrected to use the actual attestation seam, without weakening product auth.

One external real V2 Runtime, Application gateway, Kernel and Workspace Worker audited only
the exact canonical marked D: child: three synthetic files of `4097 + 6 + 0 = 4103` bytes,
three directories, no links or concurrent mutation; bounds `maxDepth=4`, `maxEntries=64`,
`maxWallTimeMs=2000`, `topN=5`. No huge/sparse files or production tree traversal.

| Observed layer | Actual result |
|---|---|
| Worker → module → gateway → observation | Exact root, `4103` bytes, `3` files, `3` directories, not partial |
| Goal created by Coordinator | Generic `verification`, ID `storage_audit_observation`; no exact scalar selector |
| Action + task verification / Turn | Both verified; task completed, Turn succeeded |
| Persisted assistant / public replay | “Проверенный аудит указанный корень: 0 каталогов, 0 файлов, 0 B logical bytes.” |
| Independent fixture-value comparison | **FAIL**: requested `4103` is absent; `semanticTaskPassed=false` |

Root cause in current `src/oscar-turn/coordinator.ts`: `renderStorageAuditObservation` unwraps
`structuredData.result` or the record itself, then `audit`, but real observations carry
`structuredData.output.audit`. The renderer silently defaults missing counts/bytes to zero.
This happens after correct Kernel observation and verification, without any model contribution.
Array/store/replay parity is insufficient: all projections agree on the same wrong answer.
The historical duplicate-inspection failure did **not** reproduce here: one replay decision,
one prepare, one submit, one Kernel dispatch and one Workspace call completed normally.

Required Astra boundary, not a local fallback-field patch:

1. Admission/Goal must preserve the requested scalar selector, exact-unit/format requirement and
   target. “An observation exists” cannot replace “answer this exact observed value”.
2. Projector reads only the admitted capability's schema-bound output shape. Missing/wrong-shape
   fields produce typed failure, not `Number(value || 0)` or a guessed legacy path.
3. Certifier binds the actual selected canonical value; Presentation consumes that binding,
   not a second independently guessed observation summary. Legitimate zero requires a present,
   verified field. Absent and zero are distinct.
4. Exact scalar answers must not round through `formatBytes`/`toFixed` or unsafe Number coercion.
   This is also a source-visible secondary risk once the current shape mismatch is fixed.
5. If presentation/delivery fails after a correct receipt, retain evidence and retry only the
   pure projection/delivery stage. Do not redispatch the audit or invent model synthesis.
6. End-to-end acceptance compares the delivered claim to an independent fixture oracle, in
   addition to receipt/Task/Turn/outbox parity. No `verified` label bypasses this comparison.

Capture: `scripts/architecture/capture-astra-v3-v2-storage-audit.ts`; `19` exact source pins,
including Worker, goal binding, verifier and shared fixture helper. Body `1958` bytes /
`sha256:50ba81a121a2263127d9037254e163e5687781ef40510ae7dd26918c5be6a022`, with exact harness hash.
`astra:storage-capture:test` repeats the real route twice byte-identically, independently sums
fixture sizes with BigInt, rejects resealed extra-dispatch/outside-root and duplicate-key permits
before allocation, and admits the failure only as diagnostic regression, never V3/quality proof.
With legacy-gap lab: `2/2` files, `28/28` tests PASS (`16.85s`) **as a reproduced failing behavior**.

Desktop Coordinator invokes optional `resolvePersonality` once. The fixture's throwing guard
blocks it, records `forbidden=1`, and V2 tolerates that optional hook failure. No real personality
provider/data is accessed. This is not evidence that production ignores the setting: its actual
resolver checks `personalityEnabled` before reading context. The count is not hidden or called zero.
Other forbidden/extra dispatches and external network remain absent. Raw envelope, files and
marked child are removed before emission. No product patch, model, Safe, user data or Astra
activation. Legacy number/coverage/constant `mutationsObserved=0` still confer no native V3
schema, safe-integer-range, current-state or TOCTOU proof.

### `logicalBytes` acceptance

Certifier must reject:

- output without `/audit/logicalBytes`;
- unsafe JSON number, NaN, implicit zero, non-canonical decimal or missing exact integer;
- correct field from wrong root;
- unverified observation;
- partial audit when completion policy requires complete;
- `models.agent.synthesize` output without underlying audit evidence;
- stale observation from another task/revision.
- interval traversal presented as point-in-time/current total;
- legacy `mutationsObserved=0` used as stability proof without real detector;
- any current/stable intent or detector/snapshot field presented to the interval-only core schema.

It must accept canonical base-10 integer string including `0` when field exists and Kernel proof supports it. Raw `/audit/logicalBytes` is always that string. Evidence Projector validates the raw value/output/proof and records only its derived EvidenceNode facts; **Completion Certifier alone** wraps the selected canonical string into `TypedValueV1` inside the claim binding. Capability output or EvidenceNode containing that TypedValue wrapper, Projector-owned wrapping, or Certifier expecting `/audit/logicalBytes/value` fails. Legacy `number` is diagnostic-only even when safe/non-negative; no generic mapping can invent missing metric/policy/root-volume/temporal/accounting semantics.

Target output carries raw `walkerDisposition`; Projector alone derives `walk-completed-without-local-error` from the accounting proof, counters, accumulator and start/finish root+volume identities. Core interval proof always states `mutationDetection='not-supported'` and may certify only exact arithmetic observed in its window with mandatory non-snapshot disclosure. Point-in-time/current/stable intent is rejected before core Execution and requires a future schema/profile; it is not mapped to partial. Incomplete/mismatch never verifies. No artificial u64 maximum.

### Tests

- pure deterministic contract tests;
- supported local-fixed-NTFS non-root alias cases plus rejection of drive root/UNC/mapped/`SUBST`/reparse/non-NTFS profiles;
- schema selector tests;
- property tests for missing/wrong type/extra fields;
- one canonical raw-output JSON fixture plus one derived EvidenceNode fixture; exact source schema digests are shared by capability/selector/receipt/Projector/certificate/renderer, while output↔EvidenceNode selector substitution and wrapper/string alternatives are rejected;
- same inputs produce byte-stable assessment body and commit retry returns the once-created byte-identical certificate envelope;
- worker/journal/certificate/presentation round-trip at `2^53±1` without bit loss;
- max-u64+1 and multi-operand sum remain lossless;
- decision-table fixtures: explicit interval + `mutationDetection='not-supported'` verifies only the observed interval with exact disclosure; current/stable intent and detected/snapshot fields fail admission/schema before Execution; partial traversal never verifies;
- target/policy/budget/scope substitution, protected-boundary count leakage, clock-origin/continuity/wall mismatch and concurrent mutation never yield a falsely complete/current certificate;
- no model/tool call from Certifier;
- fixture/shadow cannot alter current checkpoint, terminal projection or user message.
- Phase 1B golden traces prove exact current API, Kernel invocation, persistence and user-output parity with no Astra runtime import.

### Exit

- zero harmful false positives on the versioned corpus **and** ratified recall/false-negative/clarification/unsupported-intent thresholds with denominators and confidence bounds;
- denial codes explain every current mismatch;
- CPU/latency negligible relative to model loop;
- independent artifact review accepts generated schemas, fixture hashes/results and contract ownership; reviewer/oracle does not share the generator's endpoint/transition derivation code or schema library, and a focused human security review covers read authority/privacy boundaries before product import.

### Rollback

Disable shadow compiler/certifier and revert the narrow seam adapter if parity fails; no persisted execution semantics changed.

### Phase 1C machine plan candidate — `workspace.files.read`, plan-only

`astra-v3-workspace-read-shadow-plan.v1.json` исправляет первый slice на exact live capability
`workspace.files.read`. V2 `AgentLoop`/Workspace/Application gateway остаются единственными
владельцами behavior и одного Kernel invocation. Astra evaluator получает тот же immutable receipt
только для assessment parity; второй target read, approval, model/network, Safe path, Execution
truth, terminal projection и user output запрещены. Comparison record содержит только bounded
digests/codes, без raw path/content.

Шесть gates `S0..S5` нельзя склеивать: plan-only, no-behavior-change seam, disposable fixture
shadow, local canary, selected-lane cutover, physical deletion. Сейчас только `S0` имеет
`authorization=current`; каждый следующий gate требует отдельный go/no-go. Semantic, authority,
privacy или evaluator crash с первого случая generation-fenced/monotonic выключает shadow и не
влияет на V2. Automatic ramp/re-enable отсутствуют.

Deletion остаётся blocked до cutover, two-release compatibility window, zero live legacy
Executions, retained compatibility reader, exact source-diff/zero-call-site/de-domain proof,
installed upgrade/rollback acceptance и отдельного owner deletion go/no-go.

Изолированный plan simulator и независимый verifier прошли `24/24` cases: Kernel dispatches `20`,
shadow dispatches `0`, V2 outcome changes `0`, raw comparison payloads `0`; semantic/authority/
privacy faults caught `5/3/2`. Node отверг `28` policy mutations, Python — `22/30` resealed
source/artifact attacks. Evidence:
`sha256:7360beede20c164706c67bcc92deb2a7d8553b37e630aa2f351d6f23843e9005` /
`sha256:2d8d4884fff2fdfac8f3deaf49121cd62ad0edf9d9c37fee28f1e75f589ad3c4` /
`sha256:af0f5813636def3dfaf8cde625bd07136f076f335b7adeaa4e2f251e09de3498`.
Это machine-checkable RFC preparation, не Phase 1 eligibility и не разрешение реализации.

### Cross-phase composition definition — non-retained

До любого selected-lane product cohort требуется machine-closed
`astra-core-experience.v1`. Новый package материализует schema + instance для `14` foundation
profiles, `5` mandatory capability packs и всех `16` mandatory release components, но сохраняет
`16/16` missing retained implementations и нулевую authority. Память входит как обязательный
совместимый foundation seam, а не как уже доступная функция.

Digest construction идёт только вперёд: architecture source → candidate-definition seal →
generated composition manifest → runtime link. Обратный pin manifest/candidate digest в его
собственный source запрещён. Текущий package прошёл `18/18` deterministic cases, Node отверг
`27` source mutations, independent Python — `27/25` source/artifact mutations. Это закрывает
definition gap, но не Phase 1C shadow authorization, persistence ADR, retained manifest,
Product Facade route или installed acceptance.

---

## 8. Phase 2 — conditional selected persistence lane and direct deterministic host

### Goal

After Phase 1B, the mandatory §6 product-read foundation and a separate Phase 0E persistence go/no-go, create the first selected-lane core read Execution without importing an Engine/model protocol.

### Planned changes

- Implement only the selected additive-V3, sidecar or V4 topology with atomic logical commit/projection/command receipts after schema closure and focused regression review.
- Implement the §6 generated product command/continuation/recovery/dispatch schemas against the chosen physical store; a fixture-only internal tuple is forbidden.
- Add LegacyExecutionAdapter for read-only/current V3 tasks.
- Add a direct deterministic core host; Engine/model driver remains a separate unavailable profile.
- Keep core free of Activation. If a later multi-process/product scheduler requires a lease, it must enter through a separately generated profile/version and cannot alter this core trace.
- Retain the exact core refs/digests/hashes so upgrade recovery never substitutes latest semantics; an implementation hash does not imply retaining/running old binaries.
- Feature-gated admission for one read-only capability cohort only after its orchestration path uses the selected lane as sole owner for every fact.
- Bind GoalContract, static capability contract and runtime feature-set digests in closed core events.
- Enforce current revocation at every §6 fence, start-by/deadline, historical package retention/quarantine, correction state, process-generation writer fence and bounded installation-wide read queue at the real boundaries.

Phase 1B's seam may now receive a selected-lane adapter, but no existing `AgentLoop` branch may mutate a second lifecycle truth. An additive V3 choice updates its single existing owner atomically; sidecar owns only evidence/certificate and uses the approved coupling rule; V4 owns the whole new-cohort Execution. A compatibility mirror into a fake checkpoint is forbidden; shadow comparisons remain non-authoritative artifacts.

### No-dual-truth rule

The selected cohort writes each fact to exactly one owner. Compatibility snapshots/events are rebuildable projections only. No candidate may keep both Task V3 and sidecar/V4 lifecycle state authoritative, and no recovery routine may choose “newer-looking” truth.

### Tests

- selected-lane atomicity and projection rebuild;
- complete commit-group buffering/digest; incomplete tail/middle never partially projected;
- power-loss/process-kill fault injection;
- duplicate command and sequence collision;
- truncate/kill at every multi-event commit byte boundary; quarantine corrupt tail after prior verified commit;
- stale store-writer/RuntimeFeatureSet generation CAS; no Activation lease in this profile;
- multi-event command revision/sequence semantics and single physical appender;
- direct deterministic host/capability contract parity;
- legacy Task V3 reader and current active task isolation;
- stop-new-Astra rollback while existing selected-lane state remains readable;
- accepted→routing continuation, receiptless dispatch recovery, revocation/deadline/correction checks, query/cancel/reattach and bounded concurrency under kill/restart;

### Exit

- selected-lane read-only execution survives restart at every pre-effect boundary;
- common UI snapshot cannot distinguish storage generation except diagnostics;
- no lost/duplicated accepted command in stress test;
- no nonterminal task depends on removed implementation bytes and no stale process can append after package/schema generation switch;
- legacy data unchanged byte-for-byte unless separately migrated with explicit tool.

### Rollback

Admission flag off. Existing selected-lane tasks remain readable/finishable only by a compatible rollback build whose package identity/publisher policy is accepted and which contains the exact selected reader. Installer/update policy blocks launching an older binary unable to preserve its refs/sidecar/journal. No sidecar/V4 task converts to a synthetic V3 checkpoint and no additive V3 task loses new fields; new Interactions follow §4.4 cohort admission.

---

## 9. Phase 3 — exact read vertical slice through ordinary Oscar

### Goal

Закрыть `logical-namespace-entry-bytes.v2` end-to-end в реальном user route без маркировки как current/physical disk usage.

### Exact path

```text
ordinary /api/oscar/turns or Desktop submit
  -> durable Interaction
  -> Astra V3 Execution admission
  -> typed storage GoalContract
  -> exact static capability-contract bind
  -> Kernel workspace.storage.audit
  -> receipt/evidence
  -> Completion Certificate
  -> deterministic structured `logical-namespace-entry-bytes.v2`
  -> optional bounded prose
  -> persisted terminal Interaction
```

### Planned changes

- Enable cohort by exact feature/capability policy, not prompt keyword hack.
- Require the §6 product-facade/recovery/query/cancel/concurrency foundation; Phase 3 cannot expose a core-only certificate directly.
- Separate deterministic result renderer from `models.agent.synthesize`.
- Project certificate into Turn outcome; coordinator no longer independently re-verifies this cohort.
- Preserve partial/skips warnings.
- Persist measurement window, raw walker disposition, Kernel accounting proof, projector-derived walk verdict, root+volume identities and temporal class; legacy `complete` is diagnostic-only.
- Use only the supervised fixed-NTFS broker profile; walker cannot self-attest enumeration/exhaustion/resource counters.
- Recheck package/authority revocation and deadline around every blocking broker request, before Evidence/certification and before correction-aware delivery.
- Ensure renderer retry never repeats storage audit.

### Tests

- focused unit/integration;
- real ordinary UI route;
- forced renderer failure after valid receipt;
- application-process restart after audit/before assessment on the same validated boot continuity may resume; OS reboot/unknown continuity must fail closed and create a newly admitted Execution rather than certify old evidence;
- restart after certificate/before message persistence;
- exact `logicalBytes` binding and structured response;
- canonical decimal structured value; `2^53+1` synthetic path remains exact;
- `0` vs missing distinction;
- partial audit truthfulness;
- concurrent create/truncate/rename/delete: core may verify only the explicitly requested observed-window sum while disclosing that stability was not checked; current/stable intent is ineligible before Execution and never becomes a core partial/current total;
- no duplicate inspection without state change;
- renderer/payload GC recovery uses certificate inline value or pinned ref;
- no Safe traversal; disposable E: fixture.
- query/attach/cancel from every enabled surface, revocation/deadline at every required fence, package quarantine/certificate correction before delivery, bounded concurrent walks and one visible recovery outcome for receiptless uncertainty;

### Exit

- `falseCompletion=0/N` across the versioned false-completion corpus and installed attempts, with `N`, case IDs and results published;
- `forbiddenEffects=0/N` dispatches across all core tests/installed attempts, while every injected effect proposal returns the expected block code;
- exact field binding pass;
- arbitrary-precision value and exact temporal semantic binding pass;
- exactly one storage audit in normal path;
- terminal `verified` always cites certificate and only claims the admitted interval class; current/stable wording is impossible because that intent never enters the core Goal;
- installed app evidence, not source test only.
- user-visible target uses an escaped display alias bound to handle identity, and every label says observed logical namespace-entry bytes rather than current/physical disk usage.

### Rollback

Disable new Astra cohort admission. Existing selected-lane read-only executions finish/read through the compatible selected reader. Do not reinterpret a certificate through old heuristic matcher and do not change either runtime/persistence lane mid-flight.

---

## 10. Phase 4 — extract remaining AgentLoop seams by workflow parity

### Goal

Create the integration seams required for additional capabilities **before** expanding their family. Astra V3 must not grow new capability branches inside the existing 6721-line `agent-loop.ts` and promise to decompose them later.

### Extraction order

1. Presentation/grounded synthesis boundary.
2. Capability dispatch/contract boundary with no capability-ID switch in generic orchestration.
3. Generic progress/duplicate guard.
4. Completion request/certificate projection boundary.
5. Workspace batch/audit workflow.
6. Application resolution workflow.
7. Direct ordered operational requirements.
8. Computer Use workflow.

Items 1–4 are the mandatory minimum seam gate before Phase 5. Items 5–8 migrate by family as their old V2 consumers and parity evidence permit; they cannot receive new Astra V3-only branches meanwhile.

### Per-extraction gate

- old branch inventory and tests identified;
- new service/workflow contract implemented;
- shadow/parity trace comparison;
- crash and cancellation tests;
- old branch unreachable for the admitted Astra V3 cohort;
- old branch deleted only when no V2/legacy consumer requires it;
- line-count reduction alone не gate.

### Forbidden shortcut

Moving each `trusted*` function into `workflows/foo.ts` while preserving hidden shared mutable state is not architectural migration. Workflow must use typed inputs/events and no direct store/Kernel handles.

### Exit

- adding one reviewed read capability no longer edits a generic AgentLoop capability switch;
- Completion Certifier owns all Astra V3 terminal proof;
- coordinator consumes certificate projection only;
- remaining V2 family branches are inventoried, cohort-fenced and have named retirement gates.

### Rollback

Per-family Astra V3 flag. Do not resurrect deleted branch without its legacy consumer proof.

---

## 11. Phase 5 — agent foundation, context/compaction и read packs

### Goal

Build the non-effect foundation of `astra-core-experience.v1` through reviewed
manifests and Phase 4 seams. This phase does **not** close the Astra product: it makes
effect packs possible without implementing them before their safety foundation.

### Planned order

Foundation services close together: Product Facade, two-phase PreliminaryNeeds →
Admission/Goal, transport-only Engine + Decision Gateway, Catalog, Context with
DriverContextSession handshake, mandatory Compaction, Resource Host/Scheduler/
Recovery, Workflow/Task Graph and Completion. Phase 5 capability scope is read-only:

1. `workspace.root.get` and storage read family.
2. `workspace.files.read/list`.

Effect contract/schema/workflow proposals may be reviewed here, but they cannot be
enabled, dispatched or counted toward release until Phase 6 foundation passes.

For each capability:

- output schema;
- deterministic goal matcher;
- claim templates;
- reconciliation recipe;
- workflow ref if needed;
- contract digest/version;
- conformance fixture.

### Resolver transition

Current lexical resolver remains one search backend. Domain hard-coded hints/exclusions move into catalog metadata/policies. Required Goal capability pinned. Inspect ledger enforced before invocation.

`InteractionIntentAdmission` registry is migrated in the same capability order, but cohort selection follows §4.4 atomically for the whole selected operational clause set. It and Goal Compiler consume one immutable matcher candidate set/digest; current `disposition.ts` cannot independently downgrade an operational candidate to answer. Unknown imperative/ambiguous operational phrasing routes Execution/clarify/block.

### Tests

- search recall corpus with false-negative/clarification denominators, not only zero false positives;
- required ID cannot be displaced by ranking limit;
- missing capability never substituted;
- inspect/schema drift;
- stale catalog revision;
- permission-gated tools remain discoverable but cannot invoke;
- dynamic/untrusted capability cannot publish trusted claim template;
- ordinary Desktop/API RU/EN paraphrase, negation, multi-clause and unknown-operational corpus reaches the same admitted candidate set in disposition and GoalContract;
- adding the capability does not add a capability-specific branch to generic AgentLoop;
- branch-specific decision schemas accept benign local-model syntax drift without weakening executable semantics;
- deterministic/registered paths prove their model-call ceilings;
- context projection records token budget, omitted ranges and snapshot digest;
- model outage before/after Kernel receipt and crash boundaries produce typed blocked/partial/recovery outcomes;
- current-model ordinary-route full-task holdout publishes quality, effect and efficiency metrics.
- delta cache loss/restart/out-of-order forces full rehydration before decision;
- reservation/load/OOM/cancel/Host-crash cases independently release/fence exact
  Residency record and InferenceTurn lease;
- `ExecutionReadinessReceiptV1` expires/fails closed across capability/Kernel/store,
  catalog and policy changes; deterministic `modelRequirement=none` stays runnable
  without model, while each real turn requires fresh `InferenceTurnAdmissionReceiptV1`.

### Exit

- target capability family has no corresponding central switch branch;
- target family has no independent surface routing regex owner;
- catalog contract coverage report complete;
- no tool-call success counted without claim proof;
- mandatory read/foundation scenarios in the release matrix pass;
- false verified, wrong target/effect, authority bypass and zombie outcomes are zero;
- Phase 5 remains non-product until Phase 6 effect foundation/packs and later cutover
  gates pass; no Astra V3 default branding is authorized here.

### Rollback

Per-capability admission flag changes eligibility only for a new Interaction. §4.4 then selects one homogeneous V2/Astra V3 Execution or explicit block; it cannot return one requirement inside an existing Goal to V2. Catalog data remains read-only diagnostic; no mid-flight/global fallback.

---

## 12. Phase 6 — effect foundation, effect packs и core composition

### Goal

Extend V3 from read-only foundation to real mutations without weakening exact
approval. Only after this phase may the four-pack `astra-core-experience.v1`
composition exist as a release candidate input.

### Mandatory foundation before first effect

- separately generated Scheduler/timer/lease profile for approval/arm expiry, revocation, RecoveryCase wake, bounded notices and waiting-runtime deadlines; no service may implement ambient timers;
- Action Ledger V2/bridge with `prepared/dispatched/receipt/indeterminate`, stable invocation ID and frozen semantics refs;
- immutable `EffectSemanticsSnapshot` retained across upgrade/manifest removal;
- stable invocation authorization revision independent of runner generation;
- full Approval `pending/approved/denied/expired/revoked` lifecycle plus separate ArmAttestation entity;
- Approval state separate from durable `ArmAttestationV1`: both are child entities in one Execution aggregate; outer Execution CAS + exact Approval/Arm entity revisions; atomic approve+consume, no-arm approve, pending deny, expiry/revoke invalidation;
- server-attested approver context and one-use arm;
- `cancellation-pending/reconciling/blocked-indeterminate` state visible to UI;
- formal RecoveryCase commands/states, late correction delivery, two-tier retention/tombstone and quotas;
- Incognito effect admission denied.

### Representative slices

1. `workspace.files.write`:
   - exact path/content/overwrite;
   - approval when required;
   - bytes + readback SHA-256 claim.
2. device setting:
   - baseline observation;
   - exact set proposal;
   - postcondition readback.
3. application open:
   - deterministic resolution;
   - exact target;
   - verified opened state.
4. named browser open + exact URL navigation:
   - exact browser identity;
   - separate open and navigate nodes;
   - fresh address/title observation for exact URL.
5. Computer Use (conditional pack):
   - exact window observation;
   - one effect atom;
   - fresh readback.

External/network download remains a separate conditional pack after provider/security
review. If disabled, download requests must terminate typed unavailable; search can
never substitute artifact receipt/integrity evidence.

### Fault matrix

Inject termination/failure:

- before prepare;
- after prepare;
- approval pending/resolved;
- arm issued/expired/consumed, two concurrent approves, expiry-vs-consume, revoke-vs-consume, crash after issue, auth-epoch change, pending deny, expiry of approved authorization while dispatchState remains not-dispatched;
- before dispatch CAS;
- during Kernel call;
- after Action Ledger completion;
- before receipt projection;
- before/after postcondition;
- before certificate;
- before delivery.

Также обязательны app upgrade/manifest contract removal в pending approval, authorized-before-dispatch и indeterminate states; recovery использует frozen old body, не current registry.

### Exit

- для non-idempotent invocation ровно один admitted Monarch Kernel dispatch transition/attempt; после ambiguous outcome Monarch не делает второй dispatch;
- external/provider exactly-once не заявляется; retry возможен только при frozen supported provider idempotency protocol;
- indeterminate state visible and requires reconcile/user action;
- approval invalidates при goal/schema/policy/scope/provider/authorization change, но переживает простой activation generation crash;
- pending approval/arm expiry/revoke всегда будит workflow и не зависает;
- unsupported reconciliation can become permanently-unknown without fake cancellation; late receipt still resolves through correction saga;
- full payload retention expiry preserves minimal immutable tombstone and bounded storage pressure blocks new effects instead of deleting truth;
- effect completion always has receipt + required postcondition.
- workspace-read, workspace-effects, desktop-control and browser-navigation packs
  jointly pass ordinary-route and installed acceptance;
- every mandatory P/A whose implementation owner is Phase 0–6 is executable and
  green; A32–A34 remain explicit blocking gates for Phase 7 and Phase 9, but do not
  create a circular prerequisite for entering Phase 7; `optional-disabled`/`deferred`
  entries remain advertised unavailable and are not called solved;
- `astra-core-experience.v1` may proceed to steering/cutover evaluation only now,
  never from Phase 5 alone.

### Rollback

Disable each mutation family independently. Pending/indeterminate effects remain handled by V3 Recovery Service; never hand them to V2 blindly. `cancelled` не используется для unknown dispatched outcome.

---

## 13. Phase 7 — steering and multi-runtime lifecycle

### Goal

Add safe-boundary follow-up/attach/replay without mixing driver SDK state with domain truth.

### Planned changes

Phase 7 has two mandatory core gates and two optional runtime/provider gates:

- **7A Product continuity — mandatory:** attach/replay and already-versioned
  query/cancel surfaces; no Engine/provider dependency.
- **7B Local steering — mandatory:** persisted steering + current-local driver
  negotiation/resume/cancel semantics.
- **7C Second runtime:** another local runtime only after package/license/sandbox/parity review.
- **7D Provider runtime:** cloud/provider grant, egress/ingress and consent profile only after its separate security/privacy go/no-go.

Passing 7A does not waive 7B for `astra-core-experience.v1`; passing either does not
authorize 7C/7D. Provider identity/egress cannot be bundled into a harmless
attach/replay release.

- Persisted steering commands and row roll ordering.
- Driver feature negotiation.
- Current-local driver: capability false or exact supported semantics; no prompt imitation.
- Optional second driver only behind provider/license/data review.
- Resume token protected refs.
- generation fencing and queued fallback.
- NormalizedDecision envelope with submit/context/goal/plan/catalog/boundary/steering/compaction refs.
- Exact provider identity + ProviderExecutionGrant + per-open/submit/steer one-use EgressAdmissionPermit and `not-started|started|completed|failed|unknown` EgressAttempt lifecycle.
- Typed cancellation acknowledgement; runtime stop is not effect cancellation proof.

### Tests

- follow-up before model decision;
- during model stream;
- before/after invocation safe boundary;
- while approval pending;
- crash after steer accepted/delivered;
- unsupported driver queue-next;
- stale resume token/driver upgrade;
- buffered pre-steer decision arriving after new context;
- local→cloud/provider/terms swap, revoke and newly added attachment/memory data class;
- crash before first byte, revoke-vs-start CAS, partial stream, failure/unknown after first byte and provider acknowledgement distinction;
- row order replay after restart;
- no authority widening via follow-up.

### Exit

- no lost accepted follow-up;
- no double model turn/effect from redelivery;
- UI history order stable;
- feature flags truthful per driver.
- no provider egress without exact grant/manifest receipt.
- A32–A34 are executable/green on ordinary current-local route; cancel ack and stale
  buffered decision fencing cannot be disabled in an Astra default cohort.

### Rollback

Disabling mandatory local steering/cancel/resume makes new Astra core admission
unavailable; it cannot silently advertise a reduced Astra product. Existing durable
follow-ups remain readable and may queue as a new Interaction only under an explicit
compatibility projection; existing cancel/recovery commands remain serviceable.

---

## 14. Phase 8 — child tasks, jobs и advanced compaction profiles

Children/jobs и дополнительные compaction modes могут идти только после stable core
foundation, если release scope их выберет. Базовый coherent compaction из Phase 5
уже mandatory для `astra-core-experience.v1`; Phase 8 не может использоваться, чтобы
отложить P11/P16. Целевой release train — Monarch `0.3.0`; placeholders не означают
availability или обязательное включение optional profiles.

`agent-children.v1`, `agent-jobs.v1` and every advanced compaction extension each
require a separate manifest, RFC/go-no-go, fault corpus, feature flag and rollback
evidence. The shared Phase 8 heading is scheduling shorthand only; success of one
profile never authorizes or version-binds another.

### 14.1. Child tasks

Order:

1. read-only child with fixed capability set;
2. durable mailbox/CAS delivery;
3. cancel/orphan/parent restart;
4. multiple children bounded aggregation;
5. effectful child only after explicit approval UX and security review.

Gates:

- scope strictly narrows;
- no approval inheritance;
- parent certificate consumes child evidence, not report prose;
- no lost accepted delivery;
- depth/fanout/budget bounded.
- exact `DelegatedClaimBinding` ties parent claim, admitted lineage/descriptor, child certificate and delivery inbox receipt;
- two concurrent deliveries created at one parent revision apply sequentially by delivery-ID dedupe after revision re-read;
- unrelated child/certificate cannot satisfy parent claim.

### 14.2. Jobs

Start read-only, fresh Execution per fire, exact fire idempotency. Add effectful jobs only with per-run policy and ambiguous-crash tests. Busy sticky run defaults skip, not concurrent attach.

### 14.3. Compaction

Start with model-surface compaction in long read-only Execution. Raw journal/evidence immutable. Crash-incomplete bracket ignored. Then test goal/steering concurrency.

### Rollback

Feature disable stops new child/job/compaction operations; existing journal/mailbox/run data remains readable and cancellable.

---

## 15. Phase 9 — default cutover and legacy retirement

### Cutover prerequisites

- all `mandatory` gates in the exact release matrix plus every actually enabled
  optional profile;
- independent security/privacy review;
- zero unresolved P0/P1 within the exact enabled manifest/versioned release corpus, with IDs/denominator published;
- upgrade/rollback installer acceptance;
- installed ordinary route benchmark;
- soak and fault suite;
- exact public docs/feature claims.

### Default switch

Switch is admission policy, not deleting V2. Metrics compare:

- completion precision;
- task success/partial/block distribution;
- mean model turns/tool calls;
- latency/resource usage;
- crash recovery;
- approval rate/denials;
- renderer failures independent of effect reruns.

### Legacy deletion gates

Delete V2 branch/facade only when:

1. no active V2 tasks;
2. legacy completed data readable through stable adapter/export;
3. two release cycles without rollback need, unless explicit shorter policy approved;
4. all current capability families covered or explicitly retired;
5. source/public/installed parity verified;
6. installer rollback no longer requires old runtime binary;
7. deletion list reviewed; user data files never included.

Legacy Astra-specific gates:

8. `astra.slot.preview` has no imports from new runtime packages and is never persisted as
   Execution/Activation/ContextPlan state;
9. one ordinary-route multi-step fixture consumes a digest-bound SkillRef through Context Engine
   without skill-authored authority, approval, target, evidence or completion;
10. answer-only and execution lanes share the same SkillRef/provenance semantics;
11. skill `requiredCapabilities` is proven to be discovery-only and cannot bypass admitted Goal,
    Catalog eligibility, Kernel policy or runtime readiness;
12. every extracted domain branch has workflow parity/fault evidence before removal from
    `agent-loop.ts`.

---

## 16. File-level target map

Имена target файлов ориентировочные; ownership важнее структуры каталогов.

| Current | Target direction | Retirement condition |
|---|---|---|
| `src/app/application.ts` | inject Agent Application Service/Protocol facade | никогда не теряет composition root role |
| `src/app/oscar-turn-runtime.ts` | Interaction answer adapter + Application Service wiring | answer authority unchanged |
| `src/app/oscar-turn-http.ts` | Client Protocol adapter | current endpoint may remain compatibility boundary |
| `src/oscar-turn/coordinator.ts` | Interaction Service + saga | V3 execution reconciliation removed after certificate parity |
| `src/oscar-turn/disposition.ts` | compatibility adapter к shared InteractionIntentAdmission | independent semantic parser retired after ordinary-route corpus |
| `src/oscar-turn/types.ts` | Interaction V2 projection types | V1 reader retained |
| `src/oscar-turn/turn-store.ts` | Interaction Store V1/V2 | outbox/data migration proven |
| `src/agent/agent-runtime.ts` | Execution Application/Scheduler facade | current public callers migrated |
| `src/agent/agent-loop.ts` | generic Runtime Host orchestration or retired | all trusted/domain branches covered |
| `src/agent/types.ts` | legacy V3 + new contracts split | no giant union accumulation |
| `src/agent/agent-task-store.ts` | LegacyExecutionAdapter; candidate additive lane or lifecycle owner beside selected sidecar; V4 remains alternative | V3 data still readable and each fact has one owner |
| `src/agent/decision-schema.ts` | legacy AgentLoop codec; possible future Engine adapter | never core/domain ABI |
| `src/agent/context-compiler.ts` | Context Projection V2 | exact digest/revision tests |
| `src/agent/capability-resolver.ts` | Catalog search backend | central hints removed by family |
| `src/agent/operational-goal-binding.ts` | retired into capability contracts | contract coverage 100% for supported operational intents |
| `src/agent/kernel-execution-adapter.ts` | Invocation Coordinator Kernel port | keep/adapt, never bypass |
| `src/agent/result-verifier.ts` | Certifier predicate primitives | current tests migrated |
| `src/core/contracts.ts` | Kernel contracts remain lean | Agent contract separate unless shared invariant demands field |
| `src/core/capability-metadata.ts` | Kernel metadata validation | Agent contract registry adds its own validation |
| `src/core/action-ledger.ts` | Action Ledger V2/compatibility bridge | effect V3 waits for frozen semantics + indeterminate recovery |
| `src/modules/*/manifest.ts` | capability identity + Kernel metadata | agent contract can colocate but version separately |
| `src/modules/astra/index.ts` | legacy Skills/catalog UI adapter | cards retained; `slot.preview` never becomes runtime ABI |
| `src/modules/astra/agent-skills.ts` | SkillContextAdapter source | exact SkillRef/provenance parity across answer/execution lanes |
| `src/ui/public/*`, `oscar/frontend/*` | common AgentRunView | no runtime SDK types in renderer |

---

## 17. Test architecture

### 17.1. Layers

1. Pure contract/property tests.
2. Store/journal fault tests.
3. Driver conformance tests.
4. Capability contract conformance.
5. Workflow conformance.
6. Kernel invocation/approval/reconciliation integration.
7. Turn → Execution → certificate → message integration.
8. Browser UI/state replay.
9. Packaged Electron smoke.
10. Installed app/OS restart acceptance.

Source-green не заменяет packaged/installed evidence.

### 17.2. Capability contract conformance fixture

Каждая claim-bearing capability обязана иметь:

- positive exact input/output;
- wrong capability;
- wrong target/input;
- missing selector;
- wrong value type;
- partial/stale evidence;
- effect approval/receipt, если применимо;
- reconciliation behavior;
- schema/contract version drift;
- redaction fixture;
- canonical lossless numeric boundaries and metric-definition drift;
- accepted evidence authority and frozen effect-semantics body;
- RU/EN goal matcher examples и negation/ambiguity cases.

### 17.3. False-completion corpus

Минимум:

- exact scalar `logicalBytes`;
- legitimate zero vs absent;
- partial directory traversal;
- exact path + content hash;
- device before/after value;
- wrong-window Computer Use readback;
- model declares completion before tool;
- model cites observation другого task;
- tool successful but requested field absent;
- renderer invents/rounds value;
- child report claims success without certificate;
- missing capability followed by substitute;
- duplicate identical inspection;
- Action Ledger complete but projection crash;
- non-idempotent dispatch unknown.
- approval pending/approved across activation generation crash;
- arm expiry/revoke and background no-approver;
- buffered decision from old steering/context epoch;
- provider grant/terms/data-class mismatch;
- source/principal/privacy spoof;
- Incognito effect denial and no durable effect residue;
- Incognito allowed local read followed by renderer failure/cancel/crash/shutdown leaves no journal/evidence/receipt/certificate/ref/path/content/digest/log residue in allowed state roots;
- certificate payload GC after certification;
- two child deliveries with same creation-time parent revision;
- cross-aggregate receiver commit before sender ack.

### 17.4. Progress/liveness corpus

Correctness без liveness недостаточна. Проверяются:

- bounded repair reaches action/clarify/block;
- no infinite catalog search;
- no infinite synthesis;
- scheduler fairness;
- cancellation latency;
- stuck approval/runtime wake;
- dormant visible `blocked-indeterminate` without scheduler spin;
- mailbox/job notice budgets;
- context/compaction bounds.

---

## 17.5. Operational storage, backup and administrative control

Before any production selected-lane Astra cohort:

- data root is product-configured and validated for local durable atomic semantics/free space/removable-volume behavior; developer preference for `E:`/`D:` is not hard-coded product ABI;
- command admission fails before runtime work when receipt/journal transaction cannot commit;
- no effect crosses dispatch unless primary truth store and a bounded preallocated emergency outcome journal are writable; if main store fills after dispatch, Kernel/broker records minimum attempt/receipt/unknown fact in the emergency journal and blocks new effects until recovery imports it;
- disk-full never converts unpersisted work into success, truncates an applied commit group, drops a delivery or silently GC-s protected evidence;
- read-only degraded mode exposes status and privileged repair/export without starting runtime/effects;
- backup captures one consistent generation of Interaction/Execution journal, command receipts, Action Ledger, outbox/inbox, protected ciphertext + wrapped keys, content bodies and feature/policy snapshots. Restore verifies generation/digests before enabling admission; partial backup is diagnostic only;
- rollback installer refuses a binary without readers for every stored generation.

Repair/export/admin are typed Application commands with server-attested owner authority, exact target/generation, dry-run preview where applicable, command idempotency and immutable audit event. They cannot enumerate/read Monarch Safe by implication; Safe export/repair requires its separate exact authority and workflow. Export applies redaction/classification, protected-ref authorization and retention policy. Repair never rewrites historical authority events in place: it quarantines corrupt tail, appends an authenticated admin decision in a separate admin stream and preserves original bytes for bounded forensic retention. Cryptographic signing, if later required by the threat model, needs its own key contract.

Fault corpus includes full disk before/inside/after commit, reserve exhaustion, backup during outbox/effect/rotation, missing key envelope, corrupt ref, restore to another volume and privileged-command replay.

---

## 18. Security and privacy acceptance

Before the first **product read** cohort: admitted/reproducible package identity and rollback policy; current revocation fence; per-Windows-principal private-store ACL/backup exposure; protected-object alias denial; no-hydration filesystem flags; capability×surface matrix; parser/renderer Unicode controls; and exact supported Windows/filesystem/build matrix must pass. Read access is lower-risk than effects, not supply-chain/privacy-free.

До effect/subagent/job release:

- authority lattice tests;
- exact approval stale/replay/cross-task/cross-generation attacks;
- approval crash continuity, authorization-revision, arm one-use/expiry/revoke;
- prompt/attachment/tool-output injection;
- catalog schema substitution/digest mismatch;
- malicious plugin claim template denied;
- filesystem traversal/reparse/red-zone;
- Safe non-discovery and no log leakage;
- incognito persistence scan;
- secret/context/journal redaction;
- cloud provider consent/data class/revoke;
- local→cloud driver swap, exact context egress manifest and terms/version bump;
- child scope/credential/approval isolation;
- compaction cannot rewrite authority/proof;
- corrupted journal fail-closed;
- local API/SSE principal/source binding.
- public ClientCommandInput cannot attest surface/principal/privacy;
- fabricated runtime/provider self-claimed observation cannot enter operational Evidence Graph; only Application/Kernel `admitted-observation` may;
- Incognito rejects durable effects and external egress.
- IncognitoStorageProfile is injected into every persistence/log/cache port; no-persist-ineligible read capability is blocked.

Формулировки и тесты должны быть bounded и defensive; aggressive exploitation не требуется для доказательства инвариантов.

---

## 19. Performance acceptance

Снимается baseline и target:

- time to durable acceptance;
- time to first truthful progress;
- model load/queue time;
- model turns;
- model input/output tokens and decision repair rate per task;
- deterministic/workflow/model strategy share;
- time to first useful Kernel action;
- model residency/swap count and cancellation latency;
- catalog search/inspect time;
- tool invocations;
- certificate time;
- presentation time;
- end-to-end latency;
- memory/CPU/GPU;
- journal growth/replay time;
- restart recovery time.

Initial targets должны быть измерены, а не выдуманы. До product planning Phase 0E ratifies numeric p50/p95/p99 acceptance/commit/replay/cancel/deadline latency, peak RAM/CPU/disk amplification and RPO/RTO thresholds on supported low/median hardware. A missing/TBD/unbounded threshold is failure. Hard rules уже сейчас: Certifier не вызывает model, renderer failure не повторяет effect/read invocation, and a persistence candidate is killed if a lower-complexity candidate proves the same invariants.

First-artifact complexity ceilings are also gates: 66 runtime schemas, 40 structural event variants, 8 guard labels expanded to primitives, 28 claim templates and 16 data-bearing presentation keys. Growth requires explicit substitution/removal or a no-go ADR before implementation; “temporary” expansion is not accepted debt.

Benchmark corpus must include supported SSD/HDD classes, NTFS and every other explicitly supported filesystem, low-memory Windows VM, near-full volume, Defender/representative AV interference, removable/VHD/subst/case-sensitive paths where claimed, OneDrive placeholders without hydration, huge-shallow/deep trees, ACL failures, process kill, OS reboot and candidate-store power-loss simulation. Unsupported combinations are rejected before admission rather than silently downgraded. Before `0.3.0` RC, owners ratify numeric ceilings for acceptance latency, cancellation acknowledgement, queue wait/fairness, replay/recovery, journal growth, CPU/RAM/IOPS and renderer size; a list of metrics without thresholds is not a release gate.

---

## 20. Release gates

Owner decision assigns the release train **Monarch `0.3.0`**; this draft still does not claim readiness. A read-only schema/runtime substrate may ship only as an internal engineering preview and must not be presented as the solved Astra V3 Agent Runtime. Public/default Astra branding requires `astra-core-experience.v1`. Provider/children/jobs may remain unsupported, but the mandatory foundation and four capability packs cannot hide behind “optional”.

### 20.1. Monarch `0.3.0` Astra core-experience gates

- generated protocol/schema manifest + canonical fixtures and focused independent regression PASS;
- ordinary surface route V3 proof after shadow parity;
- selected persistence/direct-host/certifier conformance and production current-local Engine/Decision Gateway; a model driver is mandatory for the agent product even though deterministic tasks bypass it;
- mandatory product-read foundation: durable accepted-work continuation, historical implementation/package retention/quarantine/provenance, revocation checks at continuation/dispatch/I/O/evidence/certification/delivery, start-by/deadline, certificate invalidation/correction/user notice, current delivery auth, receiptless dispatch recovery, facade/delivery, query/cancel/attach, bounded concurrency, process-generation fence and dedupe rollover;
- exact `logicalBytes`, policy scope, temporal proof/default intent and lossless integer corpus PASS;
- assessment fence/single-Invocation selection/conflict/presentation truth corpus PASS;
- crash matrix for every enabled read boundary;
- single persisted InteractionIntentAdmission/follow-up/mixed-clause cohort corpus;
- Safe deny-before-enumeration/non-disclosure, legacy outcome/reader and rollback-build gates;
- Incognito/encrypted/Engine/provider/plugin flags and schemas provably absent/unavailable unless their separate profiles are enabled and fully gated;
- installed acceptance on supported Windows/filesystems;
- exact Windows/filesystem/build/OneDrive/AV/removable/near-full/low-memory support matrix, with unsupported roots rejected before execution;
- private persistent-store ACL/retention/erasure/export/backup disclosure, consistent backup/restore with ratified RPO/RTO, accessibility fallback and typed admin/emergency recovery evidence;
- zero open P0/P1 **within exact versioned release corpus/manifest**, not a global claim;
- ratified latency/liveness/false-completion thresholds and truthful Alpha/Beta/Stable labels;
- one Admission/Goal artifact prevents routing drift and covers RU/EN morphology, negation, mixed clauses and greetings;
- branch-specific constrained decisions plus bounded canonicalization/strict semantic admission pass the local-model ABI corpus;
- Catalog required pinning, ContextPlan/delta/compaction boundary and Scheduler/Recovery pass their fault corpora;
- workspace read, workspace effect, desktop control and browser navigation packs pass current-model ordinary-route and installed full-task acceptance;
- all `mandatory` P/A from the exact release matrix have materialized fixtures,
  executable ordinary-route oracles and green evidence; `optional-disabled`/`deferred`
  entries are unavailable and never counted as solved;
- false verified, wrong target/effect, permission/Safe/egress bypass, zombie and duplicate non-idempotent dispatch counts are zero;
- untouched real-model holdout reaches at least 95% overall, no mandatory capability class below 90%, and optimized-path quality regression is no worse than one percentage point;
- published efficiency report includes model calls/tokens per task, repair rate, strategy share, queue/load/generation latency, time to first useful action, model swaps and RAM/VRAM.

### 20.2. Conditional effect/provider gates

Because the mandatory product composition includes bounded workspace/device effects, every applicable Runtime §32.1 hard gate joins the blocker set: chosen single/co-located dispatch ownership design, frozen executable semantics, approval/arm/policy dispatch transaction where required, RecoveryCase retention/privacy, protected refs, attacker/supply-chain model, crash/unknown/revoke and installed effect acceptance. Computer Use, external provider and download add their extra gates only when enabled. Engine cannot be omitted from an Astra product cohort.

### 20.3. Post-`0.3.0` stable-contract gates

- all enabled foundation/conditional feature gates sustained;
- soak/liveness targets;
- mandatory core compaction acceptance, plus supported child/job acceptance or exact
  `optional-disabled` non-support;
- long-session context integrity;
- upgrade from supported prior stable versions;
- security/privacy review closed;
- no hidden V2 authority route;
- release docs and implementation exact parity;
- failure rates/false completion within ratified thresholds.
- any later product version is an explicit owner/release decision; Astra V3 does not reserve `0.5.0` or `1.0.0`.

---

## 21. Rollout controls

Feature flags не создают schema variants. Сначала отдельный manifest compiles/reviews, затем server-owned durable `RuntimeFeatureSetV1` может атомарно включить только его exact feature ID. Список ниже — future rollout inventory, не current core config:

- `agentProtocolV1`;
- `astraReadPersistenceLane` (exact one of the Phase 0E-approved literals);
- per-capability V3 cohort;
- `completionCertifierV1` shadow/enforcing;
- `agentCatalogV1`;
- `agentWorkflow.<id>`;
- `agentSteeringV1`;
- `agentChildrenV1`;
- `agentJobsV1`;
- `agentCompactionV1`.

Нельзя включать скрытый prompt-only fallback под тем же feature flag. Snapshot показывает actual driver/features/generation в diagnostics.

Flags публикуются только одним atomic `RuntimeFeatureSetV1` generation/digest; Execution pins it at admission. Partial config write/restart cannot expose an intermediate combination. Validator rejects at least:

| Requested flag/cohort | Mandatory prerequisites | Invalid result |
|---|---|---|
| `completionCertifierV1=shadow` | pure fixture simulator PASS + focused artifact review + separately approved shadow RFC | no comparison, typed config rejection |
| `completionCertifierV1=enforcing` | selected-lane atomic commit, exact Goal/evidence fence, terminal correction-aware delivery, focused regression PASS | forbidden |
| read Astra cohort | protocol + selected persistence lane + exact static capability/Goal + frozen read semantics + enforcing certifier + deterministic presentation | forbidden |
| any effect cohort | all read prerequisites + chosen single-owner effect dispatch ABI + approval/arm/policy transaction + threat/supply-chain gates | forbidden |
| provider/cloud | process/OS egress broker + grant/attempt/ingress + protected-ref model | forbidden |
| `agentSteeringV1` | persisted follow-up admission + envelope CAS + compatible driver + finite waits | queue-next only |
| split clauses | `executionLinks[]` + §4.4 dependency partition fixtures + delivery | single homogeneous cohort/block |
| core compaction | ContextPlan handshake + raw-truth/atomic-view/crash fixtures | Astra core cohort forbidden |
| children/jobs/advanced compaction | their full schema/authority/retention fixtures | feature unavailable, never partial |

No flag combination may enable a persistence lane without historical bodies/readers, enforcing completion without assessment/correction fences, or effects without exact dispatch recovery. A requested invalid set fails before admission; it never auto-fills prerequisites behind the operator's back.

---

## 22. Go/no-go review template per phase

Перед переходом фазы фиксируется:

1. Exact scope.
2. Changed contracts/files.
3. Authority/data migration impact.
4. Tests actually run + results.
5. Source/browser/packaged/installed evidence layers.
6. Fault points covered.
7. Performance delta.
8. Safe/privacy statement.
9. Open risks/findings.
10. Rollback command/path and data readability.
11. What next agent must not touch.
12. Git branch/commit/dirty state.

No-go при unknown data migration, missing rollback reader, false verified outcome, approval weakening или production Safe involvement.

### Authority-root V1 → V2 pre-migration gate

Structural Manifest V1 не допускается как activation target. До любого shadow migration должны
существовать и независимо совпасть `ProtocolAuthorityProfileV1`,
`ProtocolFeatureSchemaManifestV2` и `RuntimeFeatureSetV2`; только эти три schema заменяют legacy
OpaqueIdProfile/Manifest/RuntimeFeatureSet, а остальные 63 schema остаются byte-identical.
Profile содержит exact `3617` ID rules и unified `148/1620/30` binding authority, не имеет
Manifest back-reference; Manifest связывает его Store ref+digest, RuntimeFeatureSet связывает
только Manifest. Все объекты, новый root pointer и один epoch advance коммитятся одним CAS.
Historical V1 сохраняется read-only для replay; mixed V1/V2 graph, partial cohort или ambient ABI
lookup дают zero authority change. Текущий alignment artifact лишь доказывает topology/counts и
не разрешает migration, persistence или product runtime.

---

## 23. Conditional first technical shadow RFC after simulator + artifact review

Первый technical shadow RFC должен быть строго ограничен:

```text
GoalContract V1 + exact AgentCapabilityContract `workspace.storage.audit.v2`
+ pure CompletionCertifier
+ raw canonical `/audit/logicalBytes` string -> Projector validation -> Certifier-owned TypedValue claim binding and one shared output schema fixture
+ exact admission/follow-up/cohort binding; no model/V2/split path
+ exact policy/root+volume/path/reparse/error/exclusion/accounting-proof schema
+ exact logicalBytes benchmark plus normative temporal proof/default-intent table and concurrent-mutation fixtures
+ single-node Evidence refs/single-Invocation selection/assessment-fence/dedicated certification-key/byte-stable envelope fixtures
+ exact six locale×verdict deterministic templates + 54 localized denial rows, with certified scope/window/mutation/exclusion disclosures and a blocked/no-claim rendering branch
+ legacy diagnostic comparison only; no compatibility adapter/certificate
+ no production terminal behavior change (shadow first)
+ isolated disposable root only; no whole volume/user roots/production Safe
```

До этого RFC sole machine definition, generated JSON Schema 2020-12 + TypeScript/rule tables/canonical fixtures должны compile и пройти focused independent structural + semantic regression review. RFC не добавляет product persistence lane, user-visible certificate/verdict, сторонний runtime, subagents, jobs, compaction, новый UI design, provider или effect path. Он проверяет substrate и не открывает release cutover. Только после shadow evidence, Phase 0E decision, Phase 0F agent-core baseline и нового no-go/go review может обсуждаться selected-lane foundation RFC; default Astra требует пройти Phase 5–7 и §20.1.

---

## 24. Architecture review loop

До первого generated package текущий focused prose-source series ограничен тремя проходами:

1. Draft main architecture/protocol/migration.
2. Независимый adversarial reviewer ищет contradictions, dual truth, unsafe recovery, impossible guarantees, migration/data-loss risk, missing liveness/compatibility.
3. Автор исправляет документы и фиксирует disposition.
4. Reviewer повторно атакует revised design; если PASS 2 открыл P1, выполняется третий и последний frozen-source PASS 3.
5. После PASS 3 новые author edits не запускают четвёртый prose-pass: они остаются явно отмеченными source corrections/open gates до generated package.

Следующая независимая проверка после этого bounded series разрешена только над новым исполняемым объектом: exact machine definition, generated schemas/TypeScript/rule programs, manifest, fixtures, hashes, benchmark/test outputs и source diff. Она проверяет structural parity **и targeted semantics/counterexamples**, но не является четвёртым LLM-аудитом той же прозы. Любая normative правка после PASS 3 либо закрывается таким artifact review, либо остаётся blocker/open ADR; сам автор не объявляет её independently closed.

Reviewer gate считается независимым только если reviewer не создавал проверяемый artifact/result и получил exact source diff + generated package + fixture hashes + reproducible outputs. Findings ранжируются по воспроизводимому counterexample, exact schema/event/path и impact; model brand/самоидентификация может только менять очередь ручной проверки, но не verdict. Ещё один ответ LLM по одной прозе является advisory input, а не closure evidence. Convergence означает: все findings имеют disposition/root ID, accepted blockers отсутствуют в core path, manifest compiles и counterexample corpus стабилен; оно не означает «никто больше не придумал пожеланий».
