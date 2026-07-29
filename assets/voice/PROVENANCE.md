# Voice reference provenance

This is the release contract for three intended synthetic product references:

- `oscar-reference.wav` — calm synthetic male voice;
- `oscar-clear-reference.wav` — clear neutral synthetic male voice;
- `aurora-reference.wav` — warm clear synthetic female voice.

That provenance claim applies to promoted WAV bytes only when
`reference-provenance.json` has `status: verified` and `verify-release`
passes. While the contract is `pending-regeneration`, the existing bundled
WAVs are not claimed to have this synthetic provenance and the release gate
must remain red.

Their canonical provenance and same-environment regeneration contract is
`assets/voice/reference-provenance.json`. It pins:

- `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` at revision
  `5ecdb67327fd37bb2e042aab12ff7391903235d3`;
- every model file used by the generator by byte count and SHA-256;
- the exact Russian reference text, synthetic voice descriptions, seeds,
  decoding settings, generator runtime versions, and fixed output paths;
- an explicit `humanReferenceAudio: false` and `voiceCloning: false` origin.

Fixed seeds, deterministic PyTorch enforcement, and disabled TF32 reduce
same-environment variance. They do not promise bit-identical output across
different GPUs, drivers, CUDA/cuDNN builds, or kernel implementations. The
SHA-256 of each reviewed promoted WAV is the authoritative release identity.

The model is used locally and offline under Apache-2.0. The generator never
downloads weights and accepts no model or output path from the command line.
It verifies the fixed local model before importing the CUDA runtime, then
writes only to the ignored staging directory
`artifacts/qa/voice-reference-provenance-v1`.

Safe release procedure:

1. Run `runtime/voice/.venv/Scripts/python.exe
   tools/generate-voice-references.py verify-model`.
2. Ensure the staging directory is absent or empty, then run the same command
   with `generate`.
3. Run the tool with `verify-staging`, then listen to all three staged WAVs and
   review `generation-manifest.json`. The manifest binds every description and
   seed to the SHA-256 of the canonical immutable pre-promotion source
   projection and exact generator bytes. The projection is recomputable from
   both pending and verified contract states. Generation does not overwrite
   bundled assets.
4. Promote only the three exact reviewed WAVs and the exact reviewed manifest
   to `assets/voice/generation-manifest.json`. Copy the WAV measurements into
   `reference-provenance.json`; copy the manifest's source-contract and
   generator hashes plus the SHA-256 of the promoted manifest into
   `generationEvidence`, then set the contract and artifact statuses to
   `verified`.
5. Run the tool with `verify-release`. This rechecks the canonical source
   projection, exact generator, promoted manifest and its pinned model-file
   evidence, contract artifacts, and promoted WAVs. Local model bytes and
   staged WAVs are checked before promotion by `verify-model` and
   `verify-staging`; they are intentionally not required in a clean public
   release checkout. `verify-assets` remains only a standalone promoted-WAV
   diagnostic; it is not a release gate. A pending contract, changed byte,
   symlink/junction, hardlink, Windows alternate data stream, unexpected PCM
   format, or duration mismatch fails closed.

Do not publish the voice WAVs as newly provenance-verified while the contract
status is `pending-regeneration`.
