# Astra local resident model integration

2026-09-05 Codex. Implementation contract; not an activation/readiness claim.

Implementation checkpoint: `astra_asset_pin.py` now verifies an explicitly owned
Windows GGUF while holding a read-share-only file handle and no-delete directory
handles. Six native Windows tests cover reader compatibility, write/rename/replace
denial, existing writer rejection, scope/hash/size failure and cleanup. Uses 1 MiB
streaming chunks, not whole-model allocation. Not yet called by LocalModelRuntime.
Owner expectation transport/resident binding still pending. This sharing contract
is not a sandbox against a pre-existing writable mapped section, privileged raw
disk access or hostile filesystem drivers; do not claim those are covered.
API reference: https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew

2026-09-05 loader checkpoint: `load_tier(..., astra_asset=...)` now optionally pins
the selected asset before the existing native loader, disables alternate/model
mock fallback and unadmitted draft, publishes handle-bound generation only on
success, and retains pin through native close. Existing unadmitted resident is
reloaded, never retroactively labelled verified. Warm admitted reuse avoids hash
and reload. Close failure revokes admission, retains pin, and quarantines further
loads until process restart. 61 focused tests pass (native loader synthetic).
Asset expectation remains host-only; authenticated component-owner transport and
prepared-driver provider/descriptor/main mount are still pending.

2026-09-05: AstraResidentDriverProvider now binds prepared driver to the existing
runtime's admitted generation/asset. It never loads models or accepts a request
digest as provenance. Same generation reuses driver and rechecks it; faulted driver
is retained, so reconstruction cannot bypass quarantine. Unload/reload invalidates
old prepared work and creates a distinct driver. 65 focused tests PASS with real
runtime/pin and synthetic native vocabulary. HTTP owner admission/descriptor/main
mount remain pending. Provider must be called under the existing inference lease.

2026-09-05: AstraLocalModelService composes existing runtime, coordinator, memory
guard and provider with owner-authenticated model router + no-store configuration
descriptor. Wrong expected digest rejected before queue/load. Asset expectation
and tier supplied by host constructor only; no arbitrary-path HTTP admission.
58 local-service/host/residency tests PASS. Real HTTP ASGI route and loader seam,
synthetic vocabulary/native loader. Main mounting and desktop trusted component
expectation transport remain pending; descriptor does not claim loaded/ready.

## Evidence and decision

The existing owner is `LocalModelRuntime`, loaded by `load_tier` / `_load_llama`
and invalidated by `_release_model_memory`. Reuse it and main's existing
InferenceCoordinator. Do not add a second loader, model process or GPU scheduler.
`component-manager.ts` verifies accepted component variants by size, GGUF magic
and full SHA-256. Python currently receives none of that verification identity;
runtime status / active tier / file name are not proof of admitted bytes.

The sealed Astra driver must bind the exact resident object to an owner-admitted
asset. Client `expectedModelDigest` only selects/checks; it must never manufacture
that binding. Legacy already-loaded models without a retained load-time binding
are unadmitted, not implicitly trusted by hashing their current pathname later.

## Ordered implementation

1. Add a host-only admission record at the existing load boundary: canonical
   asset identity, verified digest, actual tier, fresh residency generation and
   exact resident handle. Publish only after successful load; revoke before close,
   fallback, replacement or failed load. Preserve ordinary chat behavior when no
   explicit Astra admission was requested. Mock/vision/custom-tokenizer residents
   cannot become this text driver's admitted resident.
2. Bind trusted asset expectation from existing component variant ownership to
   Python admission. Authenticate the owner request; forbid arbitrary model paths,
   caller-selected trust roots and silently accepted alternate variants. Verify
   bytes at admission with bounded streaming memory, not every model turn. Bind
   that verification to the file actually loaded, not a later pathname lookup.
   Resolve the loader's pathname-vs-handle limitation explicitly: load-time file
   replacement/mutation must reject admission. Do not claim that size/mtime alone
   prevents hostile modification. Native read-handle pinning and file identity
   tests are required before claiming replacement resistance on Windows.
3. Cache the prepared driver only for that residency generation and exact handle.
   Repeated turns reuse it without another hash or model load. A normal chat lane
   changing tier/context/vision must invalidate it, not silently retarget Astra.
4. Explicitly compose host/router into existing backend: authenticated stable
   owner actor, existing coordinator, current resident provider, real Memory V4
   guard. Expose an authenticated small descriptor for host generation/model
   binding so desktop does not need manual environment copying. No public routes,
   automatic external provider fallback or default activation in this step.
5. On shutdown close admissions, await `wait_closed`, and coordinate with other
   inference lanes before unloading. False/timeout is not permission to free a
   model still in use. Existing process termination is a separate hard-stop action;
   do not counterfeit graceful completion or release the slot early.

## Acceptance scope

- Synthetic files and stub native loader: correct digest loads once; mismatched
  digest, replacement during admission and failed load publish no residency.
- Unload/reload of the same tier revokes the old driver generation; old prepared
  inputs cannot execute on the replacement. Repeated admitted requests do not
  hash/load again. Fallback and vision reject without breaking ordinary chat.
- Actual existing Application/backend HTTP composition: owner authentication,
  descriptor freshness, cancellation/shutdown, one shared native slot and memory
  revocation at generation boundary. Never import default user data in fixtures.
- Only then run an explicitly scoped real local model task and measure cold load,
  warm response and memory usage. Synthetic success is not real-model acceptance.

Do not expand this step into global planner/CU work. Those remain required work,
but are not evidence that this local admission/lifecycle boundary is complete.
