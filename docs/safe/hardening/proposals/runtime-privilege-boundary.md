# Security Hardening Proposal: Constrain the Monarch Safe Runtime Privilege Boundary

## Decision

**Decision status: design review; no implementation option has been selected.**

We need to decide whether Monarch Safe should retain its dedicated Electron utility process and formalize the controls inside that process, or replace that runtime with a Windows-isolated native helper. The decision is specifically about limiting the ambient operating-system authority of the component that holds unlocked vault keys and processes file content. It does not replace the existing cryptographic, authorization, renderer, or destructive-action controls.

## Executive Recommendation

The complete option set is:

- **Option 1: Dedicated Electron utility with formalized local controls.** We preserve the current JavaScript runtime and direct MessagePort data path, make its protocol and local policy gate explicit, and keep the existing native-confirmation capability model. This is the compatibility baseline, but it does not remove the runtime's ambient same-user operating-system authority.
- **Option 2: Windows-isolated native helper with narrow versioned IPC.** We move the vault engine and unlocked keys into a signed native helper launched under an AppContainer profile, or under a restricted-token profile only if it passes the same access-denial matrix. We preserve the local controls inside the helper and add an operating-system-enforced boundary around them.

I recommend Option 2 when “maximum isolation” is the governing requirement and a Windows-specific helper, installer work, and a longer validation cycle are acceptable. Option 1 remains the appropriate near-term baseline and rollback path. This recommendation is conditional: the AppContainer prototype must demonstrate vault-root access, device-key binding, feature compatibility, and explicit denial of network, child-process, and unrelated user-resource access. The supplied permission-model experiment is not retained evidence, so we must also revalidate it before relying on the premise that Electron's Node runtime cannot provide an equivalent boundary.

No implementation plan is created by this proposal because the option has not been selected.

## Evidence

I inspected the current working-tree versions of the Electron launcher, the Safe runtime, and the latest Safe QA report. The source files currently differ from the repository HEAD, so their exact identity must be refreshed before implementation. The structural diagnosis is influenced most strongly by the direct `utilityProcess.fork` boundary in SRC-01 and the runtime's Node dispatch loop in SRC-02: together they show a separate process and strong application-level gates, but no source-visible Windows token reduction.

| Evidence | Finding or document | What it establishes |
| --- | --- | --- |
| `SRC-01` | [Electron Safe process launch and capability authority](../../../../desktop/electron/main.mjs) | **Observed:** the Electron main process launches `desktop/safe/runtime.mjs` with `utilityProcess.fork`, generates a per-runtime capability key, passes device and capability material at connection time, creates the direct MessageChannel, and applies BrowserWindow/session controls. |
| `SRC-02` | [Node Safe runtime and serialized request queue](../../../../desktop/safe/runtime.mjs) | **Observed:** a Node utility runtime receives the MessagePort, serializes requests through one promise queue, dispatches an action allowlist, and verifies signed one-use capabilities for destructive and replacement writes. No Windows access-token, AppContainer, or equivalent OS restriction is requested in this source. |
| `EXP-01` | Unretained Electron utility permission-model probe | **Reported experimental observation:** the tested Electron utility runtime reported Node `24.17.0` without `process.permission`. The temporary probe was not retained, so this is a lead rather than reproducible proof and requires revalidation against the packaged Electron version. |
| `QA-01` | [Safe renderer-boundary QA report](../../../../output/safe-qa/qa-report.json) | **Observed in the retained report:** renderer network, popup, clipboard, generic destroy, unauthorized write, unauthorized delete, and capability-replay checks passed. The report does not inspect the utility process token or prove denial of OS resources. |

From this evidence we can distinguish two claims. It is **observed** that Monarch Safe has an isolated renderer session, a dedicated utility process, a narrow action dispatcher, and native-confirmation capability gates. It is **inferred** that the utility process retains the launching account's ambient filesystem and network authority because no reduction is configured in inspected source; that inference must be confirmed with token inspection and access-denial probes before we treat it as a measured property.

## Current Design And Failure Mode

The current split is useful. The Safe BrowserWindow is sandboxed and has no Node integration, the Electron main process owns native confirmation and runtime startup, and the vault engine runs outside the renderer in a dedicated Node utility process. A MessageChannel connects the renderer directly to the utility for the data path. For replacement writes and deletion, the renderer first obtains a short-lived, action-and-resource-bound capability from the Electron main process; the runtime verifies and consumes it. SRC-01, SRC-02, and QA-01 show that this design already limits what the renderer can request through supported interfaces.

The structural weakness is that the application policy gate and the operating-system authority boundary are not the same thing. The dispatcher can reject an unsupported action, but code executing inside the Node utility process is not forced to use the dispatcher before accessing Node or native capabilities. If a content-processing defect, dependency defect, or future code path gains execution in that process, the local action allowlist is no longer an enforcement boundary for direct filesystem, network, process, registry, or IPC access. A separate process improves lifetime management and failure isolation, but separation under the same ambient token does not by itself establish least privilege.

QA-01 is therefore necessary but not sufficient. It demonstrates that the renderer cannot use the intended bridge to reach several prohibited operations. It does not demonstrate that the utility process itself cannot reach unrelated resources. EXP-01 also gives us pause: the tested Electron runtime apparently did not expose Node's permission model, but because the probe was not retained we cannot use it as the architectural control or as proof that no supported Electron configuration exists.

This proposal addresses that ownership mismatch. We want the component holding unlocked keys to have both a narrow application protocol and a narrow OS capability set, so bypassing one layer does not automatically bypass the other.

## Desired Invariants

- An unlocked Safe runtime can read and write only the configured Safe vault root and explicitly required device-key material; attempts to access unrelated user files, arbitrary registry locations, network endpoints, clipboard, UI surfaces, or process creation fail at the operating-system boundary.
- The renderer can request only versioned, typed Safe operations. No request can name an arbitrary host path, executable, shell command, URL, or unrestricted OS handle.
- Replacement and destructive mutations require a fresh capability bound to the exact action, resource identifier, expiry, and nonce; helper restart invalidates every outstanding capability.
- The helper starts locked, fails closed when its token/profile, vault-root grant, protocol version, or key-binding dependency is invalid, and does not automatically restart into an unlocked state after a crash.
- Raw vault master keys and device-binding secrets remain inside the smallest feasible trusted component and are erased on lock, process termination, session boundary, and fatal protocol failure.
- The runtime boundary is attestable: startup records the actual isolation profile, and regression QA proves both allowed Safe behavior and denied OS-resource behavior.
- Existing encrypted vault data remains readable through a controlled rollback path. A process-boundary rollout must not silently introduce a vault-format migration.

## Constraints And Non-Goals

- The stated priority is maximum practical isolation, local-first operation, and no cloud dependency. We use that priority for the recommendation.
- Option 2 is Windows-specific. Cross-platform parity is not assumed; another OS would require its own sandbox design and evidence.
- Existing renderer sandboxing, file/resource URL controls, cryptographic envelopes, capability tokens, bounded parsers, auto-lock behavior, and recovery semantics remain tactical protections throughout any migration.
- We do not use Windows or third-party viewers to render Safe content. Viewer architecture is outside this proposal except where its bytes cross the runtime boundary.
- We do not claim protection from a Windows administrator, kernel compromise, physical memory acquisition, firmware compromise, or a compromised user session with unrestricted screen/input capture.
- AppContainer primarily confines the helper. It does not make encrypted vault files unreadable to every process running as the owning user; cryptography remains the locked-state protection, and plaintext necessarily reaches the Safe renderer when the user views content.
- No measured latency, throughput, working-set, installer, or support budget was supplied. Performance and resource effects below are source-derived, analogous, or hypothetical, never measured.
- EXP-01 is not strong enough to justify building around `process.permission` being unavailable. Revalidation is a prerequisite, not an implementation detail.

## Before Architecture

The [before architecture](../diagrams/runtime-privilege-boundary-before.mmd) shows the distinction that matters: the renderer is constrained by Electron policy and the runtime is a separate process, but the Node utility still sits inside the standard-user OS authority boundary. Native confirmation controls selected requests; it does not constrain direct OS calls made inside the runtime.

The dotted authority edges in the diagram are explicitly inferred, not measured. We need Windows token inspection and live denial probes to turn them into observed evidence.

## Options

### Option 1: Dedicated Electron Utility With Formalized Local Controls

The strongest case for Option 1 is continuity. We keep the existing vault implementation, Electron lifecycle, direct MessagePort data path, and current encrypted data format. The runtime continues to serialize requests, and the Electron main process continues to mint short-lived capabilities after native confirmation. We can formalize this boundary without a new executable, installer profile, ACL lifecycle, or cross-language implementation.

The proposed local-control layer would define a versioned request envelope, one centralized decoder, per-action payload and response limits, explicit protocol negotiation, and stable fail-closed error semantics. Requests would identify vault objects by opaque IDs rather than host paths. Every action would declare whether it is read-only, state-changing, destructive, or key-sensitive; the dispatcher would require the matching capability class and would reject unknown versions or fields. Startup would publish truthful runtime status, including that no OS sandbox was attested. Existing renderer URL, permission, download, popup, clipboard, write, delete, replay, lock, and cleanup checks would remain mandatory.

The [Option 1 after diagram](../diagrams/runtime-privilege-boundary-local-controls-after.mmd) makes the application gate a first-class component, but deliberately leaves the runtime inside the same standard-user boundary. That honest residual edge is the central tradeoff. Local controls reduce accidental policy drift and constrain a compromised renderer, yet code executing within the runtime can still bypass the dispatcher and use ambient Node or OS authority.

| Change | Before | After | Security consequence | Cost |
| --- | --- | --- | --- | --- |
| Protocol ownership | Action strings and payloads are dispatched by runtime code | One versioned schema and decoder owns validation, limits, and compatibility | Fewer ambiguous or inconsistently validated request paths | Schema maintenance and compatibility tests |
| Capability policy | Signed capabilities cover selected mutations | Every action is classified and capability requirements are centrally declared | Makes authorization drift easier to detect and review | Additional policy metadata and negative tests |
| Runtime status | Separate process is visible, OS privilege level is not attested | Startup reports protocol version and explicitly reports OS isolation as unavailable | Prevents UI or telemetry from overstating isolation | Small status and observability surface |
| OS authority | Standard-user utility process with inferred ambient authority | Unchanged standard-user utility process | No protection if execution bypasses local policy | No installer or native-helper cost, but major residual risk remains |
| Rollback | Current runtime | Current runtime plus schema/policy layer | Narrow changes can be reverted independently | Simple source rollback; old/new protocol compatibility must be maintained during rollout |

The performance mechanism is modest: schema validation and bounded framing add CPU proportional to message count, not file size, if file data remains transferred as binary buffers or bounded chunks. Memory can remain near the current profile if validation avoids duplicate full-file copies. Reliability should improve for malformed or incompatible requests because they fail before vault state changes, but the single serialized queue remains a head-of-line blocking point. Operability stays familiar, and JavaScript developer ergonomics remain strongest under this option.

What gives me pause is not the quality of those controls; several are already valuable and QA-backed. It is that they are controls inside the same component whose authority we are trying to constrain. Option 1 is a sound baseline and a low-risk delivery choice, but it cannot satisfy the strongest interpretation of process isolation.

Rollout is incremental: introduce protocol negotiation while accepting the current protocol for one compatibility window, port callers, require the new protocol in QA, then remove the legacy decoder. Rollback restores the legacy decoder and runtime without changing vault data. Existing tactical controls remain required before, during, and after rollout.

### Option 2: Windows-Isolated Native Helper With Narrow Versioned IPC

Option 2 changes the enforcement owner. We replace the Node vault utility with a signed native helper that is launched under a dedicated AppContainer profile with no network capability and an ACL grant limited to the Safe vault root and the smallest feasible device-key resource. The helper is placed in a kill-on-close Job Object with a one-process limit and process-creation restrictions. If AppContainer compatibility proves infeasible, a restricted-token profile is acceptable only if it passes the same deny matrix; “restricted” in a configuration file is not sufficient evidence.

The helper owns decrypted keys, archive/content operations that belong on the trusted side, encrypted vault I/O, protocol validation, and capability verification. The Electron main process remains the control plane for launch, lifecycle, and native confirmation, while the renderer/preload bridge uses a narrow versioned data plane. The protocol exposes Safe object IDs and bounded chunks, never arbitrary paths, commands, URLs, registry keys, or handles. Each session negotiates a protocol version and fresh authentication material; restarting the helper creates a locked session and invalidates outstanding mutation capabilities.

Device binding needs a deliberate redesign. SRC-01 currently shows the Electron main process loading and passing device material to the utility. The preferred stronger design is a non-exportable Windows CNG or DPAPI-backed key resource accessible to the helper profile, so the Electron main process does not handle the raw device key. We have not established that this works from the chosen AppContainer profile. If it does not, we must review a minimal key-broker operation and its trust implications rather than quietly passing the current raw key across the new boundary.

The [Option 2 after diagram](../diagrams/runtime-privilege-boundary-appcontainer-helper-after.mmd) shows the intended double boundary: application policy limits what the renderer may ask, and the Windows profile limits what the helper may reach even if its internal control flow fails. The diagram marks key binding as feasibility-dependent because it is not yet an observed capability.

| Change | Before | After | Security consequence | Cost |
| --- | --- | --- | --- | --- |
| Runtime technology | Electron-managed Node utility process | Signed native Safe helper | Removes ambient Node APIs and reduces the helper's runtime surface | New native code, build, signing, update, and debugging path |
| OS identity | Launching user's standard token | Dedicated AppContainer profile, or validated restricted-token fallback | OS denies unrelated resources independently of the Safe dispatcher | Profile creation, ACL lifecycle, token attestation, Windows-version testing |
| Filesystem authority | Runtime receives a root path but retains inferred account authority | Helper profile receives only the vault-root grant | Direct helper access outside the vault root should fail | Installer and repair logic must preserve exact ACLs |
| Network and child processes | No application need, but denial is not established at OS boundary | No network capability; Job/token policy denies child-process creation | Narrows data egress and execution expansion from the helper | Compatibility probes and support telemetry are required |
| Device key | Electron main loads and passes raw device material | Preferred non-exportable key usable by the helper profile | Shrinks key exposure if feasibility is proven | Key provisioning and recovery compatibility are unresolved |
| IPC | Direct renderer-to-Node MessagePort actions | Authenticated, versioned, bounded Safe protocol | Makes the helper's complete authority surface enumerable and testable | Serialization, compatibility negotiation, fuzzing, and possible extra copies |
| Failure containment | Runtime exit closes the Safe window | Helper crash kills the job, locks the session, and requires fresh launch/authentication | Prevents silent unlocked restart and orphaned child processes | More lifecycle states and recovery telemetry |
| Rollback | Existing Node runtime | Feature-gated helper with unchanged vault format during transition | Allows return to the known runtime after a clean lock | Dual-runtime compatibility must not permit simultaneous writers |

The security gain is substantial but bounded. The AppContainer/restricted token can remove helper access to unrelated files, network, child processes, and selected OS surfaces even after an internal defect. It does not protect against a compromised Windows kernel or administrator, and it does not make the larger Electron main process untrusted. The main process still controls launch and native authorization, while plaintext shown to the user still exists in the renderer. We should not describe Option 2 as a complete enclave.

Performance is unknown. A native helper may have a smaller steady-state footprint than an Electron Node utility, but versioned framing, chunk transfer, and any main-process relay can add hops and copies. We should prefer a direct authenticated data path between the preload bridge and helper when Electron and Windows handle-transfer constraints permit it; otherwise we must measure the relay rather than assume it is free. Benchmarks need interactive metadata operations and large sequential file transfers, with p50/p95 latency, throughput, CPU, and peak working set compared to Option 1.

Reliability and operability are the costs most likely to change the decision. Profile creation can fail, ACLs can drift, endpoint protection can quarantine a new helper, code signing can be invalid, and packaged upgrades can leave a protocol mismatch. The helper must therefore fail closed with a diagnosable locked state, support version overlap during upgrade, and expose non-secret attestation such as executable signature, protocol version, token/profile identity, vault-root grant, and Job membership. Support tooling must never dump keys, plaintext, recovery material, or decrypted filenames into logs or crash reports.

Developer ergonomics also regress: contributors must maintain a native toolchain and a cross-language protocol. The benefit is that security ownership becomes legible. The helper API is the complete privileged surface, and Windows policy is verified separately from application tests. We can mitigate the ergonomics cost with generated protocol types, deterministic fixtures, a reference client, and one command that runs compatibility, fuzz, token-attestation, and denial probes.

Migration should preserve the vault format and make only one runtime a writer. We first validate the helper against disposable vault copies, then run read-only compatibility checks, then gate the helper behind an explicit development flag, and only later promote it after clean-lock handoff. Rollback requires locking and terminating the helper, discarding session keys and capabilities, validating the vault generation, and starting the Node runtime. If key provisioning makes rollback impossible without exporting a secret, the key design must return to review before rollout.

## Comparison

The comparison below uses explicit evidence bases. Nothing in the Option 2 column is measured yet; its stronger security effect is conditional on Windows access-denial validation.

| Dimension | Option 1: Electron utility + local controls | Option 2: Windows-isolated native helper |
| --- | --- | --- |
| Security | **Improves, high confidence, source-derived.** Central policy reduces renderer and control-drift risk, but same-user ambient runtime authority remains. Validate with protocol negative tests and token inspection. | **Improves materially, medium confidence, analogous/hypothetical.** OS policy should deny unrelated resources even if helper code bypasses local policy. Require a zero-success deny matrix for prohibited resources before acceptance. |
| Performance | **Near-neutral, medium confidence, source-derived.** Per-message schema checks add bounded overhead. Compare p50/p95 operations and large-file throughput with the current runtime. | **Unknown, low confidence, hypothetical.** Native execution may help, while IPC framing/copies may regress. Compare the same workloads and require the agreed release budget before promotion. |
| Memory | **Near-neutral, medium confidence, source-derived.** No new process; avoid validation copies and record peak working set. | **Unknown, low confidence, hypothetical.** A native baseline may be smaller, but chunk queues and relay buffers add memory. Measure steady-state and peak working set under concurrent preview/import workloads. |
| Reliability | **Improves slightly, medium confidence, source-derived.** Version rejection is deterministic, but the single queue and process failure domain remain. Exercise malformed requests, lock races, queue backpressure, and restart. | **Mixed, medium confidence, hypothetical.** OS failure containment improves, while profile, ACL, signing, and protocol lifecycle add failure modes. Prove crash-to-locked behavior and upgrade compatibility. |
| Operability | **Near-neutral, high confidence, source-derived.** Existing Electron packaging remains; add truthful status and protocol telemetry. | **Regresses, high confidence, source-derived/analogous.** Installer, ACL repair, signature validation, profile cleanup, and Windows matrix support are new obligations. Validate install, upgrade, repair, and uninstall paths. |
| Migration | **Improves incrementally, high confidence, source-derived.** One protocol compatibility window and no vault-format change. | **Regresses initially, high confidence, source-derived.** Native parity, key binding, protocol versioning, packaging, and controlled handoff are required. Require reversible clean-lock switching with disposable and copied vaults. |
| Developer ergonomics | **Best, high confidence, source-derived.** One JavaScript/Electron toolchain and direct debugging. | **Regresses, high confidence, analogous.** Native toolchain and cross-language debugging are required; generated protocol bindings and fixtures can reduce drift. |
| Reversibility | **High, high confidence, source-derived.** Revert the policy/schema layer or retain a compatibility decoder. | **Medium, medium confidence, hypothetical.** Feature-gated rollback is feasible only while vault format and key provisioning remain backward compatible. Test rollback before promotion. |

Option 1 wins on delivery certainty, compatibility, and contributor velocity. Option 2 wins on the property this opportunity exists to provide: an OS-enforced limit on the authority of the unlocked content-processing component. The remaining unknowns are concrete enough to resolve with a prototype rather than by argument.

## Recommendation

I recommend that we treat Option 1 as the required baseline and evaluate Option 2 as the target architecture for the maximum-isolation profile. This is not a selection or authorization to implement Option 2. It is a conditional design recommendation based on the stated security priority and the current source-visible absence of an OS privilege reduction.

Option 2 should win only if the prototype proves all of the following: the helper can access the Safe root and required key primitive; unrelated files, network, child processes, and unapproved IPC are denied; existing vaults remain compatible; crash and upgrade behavior fail locked; and measured resource costs fit an agreed release budget. If Windows-only packaging, native maintenance, or device-key constraints are unacceptable, Option 1 is the honest choice, and the product must describe its isolation as application-level rather than OS-enforced.

A separate Windows service or dedicated user account could provide a stronger administrative boundary, but it is deferred rather than presented as a third option. It would add service installation, privilege, recovery, update, and support obligations that are not justified by current constraints, and it could become a larger trusted component if designed poorly.

## Evidence Coverage And Residual Risk

| Evidence | Option 1 effect | Option 2 effect | Tactical protection still required |
| --- | --- | --- | --- |
| `SRC-01` — Electron Safe process launch and capability authority | **Mitigates:** formalizes the existing launch, protocol, and capability ownership without changing OS identity. | **Mitigates:** keeps main-process launch/confirmation but moves unlocked vault authority to the restricted helper. | BrowserWindow/session restrictions, fresh capability keys, native confirmation, sender validation, and force-lock behavior remain required. |
| `SRC-02` — Node Safe runtime and serialized request queue | **Mitigates:** strengthens dispatcher validation but does not constrain code that bypasses it. | **Addresses the helper-authority condition if validated:** replaces the ambient Node runtime with a constrained native helper. | Serialized state transitions, action authorization, bounded payloads, crypto checks, zeroization, and fail-closed errors remain required. |
| `EXP-01` — Unretained Electron utility permission-model probe | **Unaffected:** Option 1 cannot claim Node permission enforcement from this evidence. | **Mitigates:** Option 2 does not depend on Node permissions, but the premise still requires revalidation. | Re-run and retain the exact packaged-runtime probe before final design approval. |
| `QA-01` — Safe renderer-boundary QA report | **Preserves and extends:** current renderer-facing denials remain regression gates. | **Unknown until ported:** the same behavioral suite must pass through the helper, plus OS denial checks. | Network/popup/clipboard/resource/write/delete/replay/lock/cleanup tests remain mandatory. |

Residual risk common to both options includes cryptographic or state-machine defects, compromised Electron main or renderer processes, plaintext present during viewing, administrator/kernel access, rollback of valid encrypted metadata, crash-dump exposure, dependency/update compromise, and mistakes in recovery or destruction semantics. Option 2 adds profile/ACL drift, native memory-safety risk, code-signing and update risk, and the possibility that a restricted-token fallback provides weaker confinement than the AppContainer design. Neither option removes the need for direct fixes and tests in the vault engine.

## Migration And Rollout

No rollout begins until an option is selected. If Option 1 is selected, we can introduce the versioned protocol behind compatibility negotiation, migrate each renderer action, require the new negative tests, and remove the legacy decoder after one supported transition window. The encrypted vault format and device-key mechanism remain unchanged, making rollback a source-level change after a clean lock.

If Option 2 is selected, rollout should use these named phases rather than simultaneous production writers:

- **Feasibility:** build a non-production helper that reports its token/profile and runs only against disposable fixtures. Retain every probe result.
- **Protocol compatibility:** freeze a versioned operation model, generate both sides, and prove byte-for-byte and state-transition compatibility with the Node runtime.
- **Read-only parity:** open copied vaults and compare status, listing, reads, preview inputs, errors, and lock behavior. Never attach both runtimes to the same writable vault.
- **Mutation parity:** exercise imports, replacements, folders, archives, deletion, auto-lock, interruption, and recovery against disposable vaults, including crash points.
- **Opt-in packaged trial:** validate signing, profile creation, ACL repair, updates, endpoint-protection behavior, crash handling, and rollback on the supported Windows matrix.
- **Promotion:** switch only after a clean lock, rotate session capability material, verify vault generation, and keep the old runtime available only as an explicit locked rollback path for a defined compatibility period.

At every phase, the current local controls remain in force. We do not relax renderer restrictions or capability checks because an OS sandbox is expected to exist. If helper attestation fails, Safe remains locked and reports the exact non-secret boundary failure.

## Validation Plan

The validation plan must produce retained artifacts, not transient console observations.

| Area | Workload and metric | Baseline and candidate | Decision threshold |
| --- | --- | --- | --- |
| Runtime identity | Inspect Windows token, AppContainer SID/capabilities, integrity level, privileges, Job membership, child-process policy, and executable signature | Current Electron utility vs candidate helper | Option 2 fails if the claimed profile cannot be independently attested at runtime. |
| Resource denial | Probe Safe root, Desktop/Documents/temp outside Safe, registry scopes, named pipes, clipboard/UI access, loopback/external network, and process creation | Same signed probe operations under both runtimes | Candidate must allow required Safe operations and produce zero successful prohibited-resource probes. |
| Protocol robustness | Unknown action/version/field, size limits, truncation, duplicate/replayed capabilities, invalid ordering, disconnect, and backpressure | Current QA plus protocol property/fuzz tests | No unauthorized mutation, out-of-root access, unlocked restart, unbounded allocation, or process crash. |
| Compatibility | Existing disposable vault fixtures covering setup, PIN, recovery, files, sections, archives, auto-lock, deletion, and interrupted writes | Node runtime output/state vs native helper output/state | No silent data-format change; every intentional semantic difference is reviewed and migration-safe. |
| Performance | Metadata operations plus 1 KiB, 1 MiB, and maximum-supported sequential read/write/import; collect p50/p95 latency, throughput, CPU, and peak working set | Option 1 packaged baseline vs Option 2 packaged candidate on the same machine | Numerical release budget must be agreed before implementation; no promotion while it remains undefined. |
| Reliability | Helper crash, main crash, renderer close, OS lock/suspend, upgrade mismatch, ACL removal, signature failure, and disk-full interruption | Current locked-state behavior vs candidate | Every failure leaves the vault locked or cryptographically recoverable, with no orphan helper and no simultaneous writer. |
| Permission-model premise | Re-run `process.permission` and relevant Electron launch-option checks in the exact packaged Electron/Node build | Retained output from current and candidate release builds | EXP-01 may influence the decision only after a reproducible artifact confirms the result. |

Security QA acceptance must extend QA-01 rather than replace it. A passing helper suite includes the existing renderer denials plus token/profile attestation and the OS access-denial matrix. Performance acceptance remains intentionally open because no budget was supplied; that missing threshold is a decision blocker for promotion, not a reason to invent a measurement.

## Implementation Work Packages

These are candidate work packages for estimation and review. They are not an implementation plan or authorization to modify the runtime.

| Work package | Applies to | Deliverable and acceptance condition |
| --- | --- | --- |
| Boundary evidence refresh | Both options | Bind source hashes/revision, retain the packaged `process.permission` result, inspect the current utility token, and record a reproducible access matrix. |
| Versioned Safe protocol | Both options | Typed schema, explicit limits, compatibility negotiation, generated fixtures, capability classes, and negative/property tests. |
| Local policy consolidation | Option 1 and retained in Option 2 | One dispatcher policy map, object-ID-only operations, fail-closed status, truthful attestation, and complete renderer regression coverage. |
| Windows confinement prototype | Option 2 | Signed helper launched under AppContainer; restricted-token fallback evaluated only against the same denial criteria; Job and mitigation policy attested. |
| Device-key binding | Option 2 | Demonstrate a non-exportable helper-usable key or return to design review with a narrowly specified broker and explicit trust analysis. |
| Native vault parity | Option 2 | Read/write/state compatibility against disposable vault fixtures with no format drift and no external viewer/tool dependency. |
| Packaging and operations | Option 2 | Installer/profile/ACL/signature lifecycle, repair/uninstall behavior, non-secret telemetry, Windows compatibility matrix, and endpoint-protection validation. |
| Controlled rollout and rollback | Selected option | Clean-lock switching, single-writer enforcement, capability rotation, crash recovery, and a rehearsed rollback that preserves vault access. |

## Open Questions

- Which boundary is primary for acceptance: compromised renderer containment, compromised content-processing helper containment, or protection from other same-user processes? Option 2 strongly improves the second but does not fully solve the third.
- Is a Windows-only native helper acceptable for the maximum-isolation profile, and what behavior should other operating systems expose?
- Can the packaged Electron version provide a supported OS sandbox or Node permission configuration that invalidates the EXP-01 premise?
- Can an AppContainer helper use a non-exportable CNG/DPAPI-backed device key without the Electron main process handling raw key material?
- Can Electron establish a direct authenticated data path to the native helper, or must the main process relay file bytes? If it relays, is main-process plaintext exposure within the accepted trust model?
- What p95 latency, large-file throughput, CPU, and working-set regression budgets are acceptable?
- Which Windows versions, architectures, installation scopes, and enterprise endpoint-protection products are in the support matrix?
- Is AppContainer mandatory, or may a restricted-token fallback ship after it passes the same resource-denial and child-process criteria?
- What code-signing, crash-dump, update rollback, profile repair, and forensic telemetry requirements apply to a helper that handles unlocked content?
- Do any current viewers or archive paths require OS capabilities that conflict with the proposed profile? The feasibility probe must enumerate them before the helper API is frozen.

Until these questions are answered and an option is explicitly selected, this document remains a proposal only.
