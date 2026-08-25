# Monarch Voice

`src/modules/voice` is a local STT/TTS transport. It does not classify user intent, choose a model lane, execute device actions, or own conversation state.

## Agent-first call path

```text
microphone -> local STT -> Oscar Turn(source=voice) -> AgentTask
           -> model decision -> Kernel capability -> observation/verification
           -> terminal Turn outcome -> local TTS
```

- `src/ui/public/modules/oscar-voice-mode.js` sends every ordinary transcript through `executeVoiceAgentTask`.
- The only local text control is an exact wake-only `Оскар` / `Oscar`; stop, mute, close, capture cancellation, and speech interruption remain surface controls.
- Voice uses the same durable Turn, adaptive Agent loop, capability discovery, danger assessment, Kernel receipts, clarification, cancellation, and completion rules as Desktop.
- Voice cannot resolve approvals or change Owner/Security settings. An action that needs approval is presented in Desktop as an exact action-card.
- TTS may speak a Kernel-verified/partial outcome, a source-grounded answer, or a bounded `models.agent.respond` answer that passed ClaimIntegrityGate and contains no current-state/action-completion claim.
- The removed `voice.mode.*` classifier/session/Micro/Lite/scripted capabilities are not compatibility execution paths. Old source workers and their private session store were deleted.

## Speech to text

- `voice.transcribe.prepare` warms only the local STT transport.
- `voice.transcribe.stream.start/push/finish/cancel` accepts ordered mono PCM16 batches. Sessions use server-generated IDs, bind to one renderer, enforce exact sequence and bounded byte/time limits, and do not persist raw PCM.
- `MediaRecorder` runs as a fallback when direct PCM setup/finalization fails. The compressed fallback is decoded locally; no cloud STT provider is used.
- `VoiceStreamingSttRuntime` prefers pinned Sherpa ONNX + Russian T-one and falls back truthfully to the resident Vosk worker when the native runtime/model is unavailable.
- Install the pinned T-one assets with `npm run voice:stt:setup`. Heavy models stay under ignored `runtime/voice/models/` on the selected data drive.
- `MONARCH_STT_TRANSCRIBE_COMMAND` may supply an isolated custom local adapter with `{audio}` and `{language}` placeholders. Commands run with `shell: false`; inline shell/interpreter code is rejected.
- `MONARCH_DISABLE_DEFAULT_STT=1` disables the built-in adapter. Stable failures such as `voice-stt-timeout`, `voice-stt-command-exit`, and `voice-stt-language-unavailable` must remain truthful.

## Speech playback

- `src/ui/public/modules/oscar-speech.js` owns Markdown cleanup, language selection, chunking, cancellation, and renderer state.
- Desktop prefers the trusted preload bridge and local `Qwen3-TTS-12Hz-0.6B-Base`; references and provenance live in `assets/voice/reference-provenance.json` and `assets/voice/PROVENANCE.md`.
- Install the isolated runtime with `npm run voice:setup`. Model/runtime caches stay outside the source tree's tracked files.
- Windows SAPI and browser `speechSynthesis` are explicit emergency fallbacks, never presented as the neural quality path.
- Answer text stays local. The renderer sends bounded plain speech settings to trusted IPC and never constructs shell commands.

## Fullscreen lifecycle

- Phase machine: `entering -> listening -> recognizing -> routing -> thinking -> speaking -> listening`, plus `error/closed`.
- VAD, mute, manual stop, close, TTS interruption, late-result invalidation, and microphone cleanup remain transport-owned.
- UI progress is short and factual (`Agent Task`, Kernel action/result); internal model reasoning is never rendered or spoken.

## Registered capabilities

- `voice.status`
- `voice.transcribe.prepare`
- `voice.transcribe.audio`
- `voice.transcribe.stream.start`
- `voice.transcribe.stream.push`
- `voice.transcribe.stream.finish`
- `voice.transcribe.stream.cancel`
- `voice.bridge.start`
- `voice.bridge.stop`

Device volume/brightness, application launch, browser work, files, network access, and shell are common Agent capability providers, not Voice-owned shortcuts.

## Acceptance

- `tests/ui/voice-agent-first.test.ts` proves the renderer has one Agent entrypoint and the Voice manifest exposes no private decision loop.
- `tests/ui/api.test.ts` proves `source=voice`, terminal outcome handling, cancellation, and the no-approval-from-voice boundary.
- `tests/modules/voice*.test.ts` cover local transcription, direct PCM session isolation, fallbacks, cleanup, and command policy.
- Operational Voice actions are accepted through the common Agent/Desktop tests and require the same Kernel evidence as typed chat.
