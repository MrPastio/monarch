# Monarch Voice Module

`src/modules/voice` is a standalone Monarch runtime module. It owns local capture/STT, Voice Mode routing, bounded session context, model-lane lifecycle, and delegation of verified actions to other Monarch modules. It does not bypass the Kernel, capability schemas, permission gate, Security controller, or audit events.

The original bridge layer remains the clean-room Monarch adaptation of MARK-ALFA voice bridge mechanics.

It does not import MARK-ALFA `ear.py`, wake words, identity text, or Piper/Vosk configuration. It only provides an isolated process boundary for local STT/TTS bridge commands.

UI voice input:

- `src/ui/public/modules/voice-input.js` owns the ChatGPT-style composer dictation control.
- On browsers with `AudioWorklet`, the renderer sends ordered mono PCM16 batches of about 120 ms through `voice.transcribe.stream.start/push/finish/cancel`. Decoding happens while the user is speaking; no raw PCM is written to disk or conversation history. `MediaRecorder` records in parallel and is used only when direct PCM setup, transport, or finalization fails or returns no text.
- Composer voice input now supports long-form local dictation: minimum 500 ms, up to a 10-minute safety envelope, and up to a 32 MB compressed fallback blob. The former 12-second auto-stop is gone; the user stops normally with the microphone button, while the generous upper bound still prevents an abandoned capture from consuming resources indefinitely.
- It inserts only the final transcript into the current composer draft and dispatches a normal `input` event; it does not bypass Oscar routing or permission gates. Streaming partials are retained only as bounded latency telemetry and never churn the composer DOM.
- Before insertion, the renderer restores spoken punctuation and sentence casing for RU/UK/BG/EN (`точка`, `знак вопроса`, `comma`, `question mark`, and equivalents). Russian dictation also normalizes explicit `ай-ти` and the narrow T-one merge `далёкому отойти` into `IT`/`далёкому от IT`; ordinary motion phrases such as `нужно отойти` and `далеко отойти` remain unchanged. Question endings are inferred conservatively; URLs, file names, and decimal numbers are left intact.
- The first browser speech locale is canonicalized to one of `ru-RU`, `uk-UA`, `bg-BG`, or `en-US`. The static Russian UI language does not override the user's speech locale.
- Browser/Electron `SpeechRecognition` / `webkitSpeechRecognition` is intentionally not used for normal dictation because the product policy is local-first.
- If MediaRecorder/microphone permission is unavailable, the mic control fails visibly instead of pretending that audio was transcribed.
- With no custom command, `VoiceStreamingSttRuntime` prefers `sherpa-onnx-node@1.13.4` plus the Russian streaming T-one model in an isolated resident Node child. Native model loading and every `decode()` stay off the HTTP/kernel event loop. If the optional native runtime or T-one model is unavailable, the same direct PCM contract falls back to the persistent Vosk Python worker; compressed `MediaRecorder`/ffmpeg/Vosk remains the final browser failsafe. Explicit `MONARCH_STT_TRANSCRIBE_COMMAND` keeps its existing isolated one-process-per-recording semantics and does not opt into streaming.
- Direct sessions use server-generated 192-bit IDs, are bound to the requesting renderer, allow one active session per client and four globally, enforce exact batch sequences, 64 KiB batches, and a 64 MiB/10-minute safety envelope. The 45-second timer is an inactivity timeout refreshed by every accepted batch in both the server and native worker, so active long dictation is not mistaken for an abandoned session. Cancel, timeout, module shutdown, worker crash, and failed finish all release session state. Only transcript text and bounded timing metadata cross the capability result; raw PCM is neither logged nor emitted as an event.
- Install the pinned T-one model with `npm run voice:stt:setup`. The setup script verifies the official archive against SHA-256 `b9c907450e99a6e5049e279bf18368a17db0bdc5e63b7fa978943138debbe3ae`, validates archive paths and required files, then atomically installs under ignored `runtime/voice/models/`. The optional Node dependency is fixed to the validated `1.13.4` ABI; absence remains a truthful Vosk fallback, not an install failure for the whole app.
- The default Vosk adapter expects a matching-language model in `runtime/voice/models/`, for example `runtime/voice/models/vosk-model-small-ru-0.22`, and uses local `ffmpeg` to convert browser audio to mono 16 kHz WAV. It fails with `voice-stt-language-unavailable` instead of silently using a model for another language.
- Browser `MediaRecorder` produces compressed WebM/Opus, so the final fallback still needs one short ffmpeg decode. The direct path avoids WebM, temporary audio files, and ffmpeg entirely. Successful streaming results expose `enginePath`, `recognitionMs`, `finalizeMs`, `captureStopToFinalMs`, `partialAgeMs`, and `workerPid` telemetry. In a local target-machine spike on `assets/voice/oscar-reference.wav` (10.24 s), T-one loaded cold in `2043 ms`, processed 86 warm 120 ms pushes in `590.81 ms`, and finalized after capture stop in `29.61 ms` wall / `29.16 ms` worker time with an exact transcript. These are local engineering measurements, not a published WER or a universal latency guarantee.
- The Vosk adapter applies lightweight ffmpeg speech filters by default (`highpass`, `lowpass`, `dynaudnorm`) and retries without filters if the local ffmpeg build rejects them. Set `MONARCH_VOSK_FFMPEG_FILTERS=off` to disable filtering.
- `MONARCH_STT_TRANSCRIBE_COMMAND` can use `{audio}` and `{language}` placeholders, for example: `python tools/local_stt.py {audio} {language}`. If `{audio}` is omitted, Monarch appends the audio path as the last argument.
- Set `MONARCH_DISABLE_DEFAULT_STT=1` to disable the built-in adapter and require an explicit command.
- The command may print plain transcript text or JSON with `text`, `transcript`, or `result`.
- STT stdout is decoded as UTF-8. For Python adapters Monarch forces `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1`; the built-in Vosk adapter also reconfigures stdout/stderr to UTF-8.
- Service logs, JSON without transcript text, Vosk/ffmpeg diagnostics, and replacement-character mojibake must not be inserted into the composer. Put diagnostics on stderr; stdout should contain a transcript JSON line.
- Timeout and command-exit failures must keep stable error codes (`voice-stt-timeout`, `voice-stt-command-exit`) so the UI can show a clear Russian status instead of a disappearing raw exception.
- Acquisition, recording, and recognition are separate tokenized sessions. Cancel/submit invalidates late results, stops acquired tracks, and never restores an already edited or submitted draft.
- Voice commands run without a shell. `cmd`, inline PowerShell, `python -c`, and `node -e` are rejected; project-owned interpreter scripts must stay inside the workspace boundary.
- This fallback is local-only by design. Do not replace it with a cloud STT provider without an explicit product/security decision.

Oscar response playback:

- Every completed non-error Oscar answer renders a speaker button directly below the answer. A second click stops the active playback; switching conversations or starting a new chat also stops it.
- `src/ui/public/modules/oscar-speech.js` owns Markdown-to-speech cleanup, RU/UK/BG/EN language detection, long-answer chunking for browser engines, natural-voice ranking, and single-session cancellation.
- Monarch Desktop prefers the trusted preload bridge (`speakText` / `stopSpeaking`) over renderer Web Speech. The renderer never constructs a shell command and sends only bounded plain text, language, allowlisted voice/style values, bounded tuning values, and an optional 300-character delivery instruction.
- The normal Desktop engine is the local `Qwen3-TTS-12Hz-0.6B-Base` model conditioned on one of three bundled references: `oscar-reference.wav` (baritone), `oscar-clear-reference.wav` (clear male), or `aurora-reference.wav` (warm female). All references are synthetic Russian voices designed once with Qwen VoiceDesign; they do not clone real people. `tools/local-neural-tts.py` keeps the model, per-reference prompt cache, and captured CUDA graphs alive, splits the full answer at semantic boundaries, streams audio into a queue-backed PortAudio output, and accepts stop/new-request commands over newline-delimited JSON.
- Settings -> General -> `Как звучит Оскар` is a local Voice Studio: three preset cards, an animated voice orb, delivery style, and manual sliders for speed (`80-120%`), pitch intent (`-2..2`), expressiveness (`0-100`), semantic pause (`40-400 ms`), and output volume (`20-100%`). It persists locally and the response speaker controller reads current values on every click, so no Desktop restart is needed. `Проверить голос` drives the orb's live waveform and uses the same trusted IPC/worker as a real answer; reduced-motion disables the decorative animation.
- Speed, pitch, and expressiveness become bounded Qwen delivery instructions; expressiveness also tunes temperature/top-k/top-p/repetition within safe ranges. Pause duration is applied between generated semantic segments, while volume scales and clips the float32 stream before PortAudio. The main process and Python worker validate all values again instead of trusting renderer storage.
- `desktop/electron/speech-output.mjs` starts that worker once with `shell: false`, warms it in the background during Desktop startup, and keeps request completion/cancellation scoped by an opaque id. Only the main Monarch renderer may invoke the IPC handlers.
- Desktop spawns Qwen3-TTS through one shared warmup coordinator before starting the broader local runtime. Trusted renderer callers await that exact bounded promise instead of launching another worker; one explicit retry is available after a failed first attempt. If a speech turn arrives while the worker is still loading, it awaits the same underlying readiness promise instead of silently downgrading the turn to Windows SAPI. SAPI is used only after a real neural startup/readiness failure or the 120-second cold-start deadline; a ready worker that emits no valid playback frame within 6 s is quarantined, stopped, and replaced before the next neural turn. Oscar may release the Qwen worker before a heavy local inference route, but now explicitly starts the shared warmup again when that route finishes so the next playback does not remain on SAPI. Neural completion remains bounded and uses the same quarantine/restart path after timeout. PII-safe startup/playback diagnostics are appended to `runtime/electron-speech.log`; the log excludes answer text and raw worker summaries while classifying Windows `os error 1455` explicitly.
- The PortAudio playback callback emits bounded `frame` telemetry at no more than about 22 Hz. Each frame contains actual output `rms`, `peak`, sample rate, and a zero-crossing `brightness` proxy; `brightness` is not fundamental pitch. The main process accepts frames only for the active opaque request id, validates them, and forwards them through the trusted preload subscription.
- `oscar-speech.js` publishes those neural frames to Voice Mode while playback is active. The organic orb consumes live output energy immediately; if no frame arrives for 180 ms, browser/SAPI playback and transient neural gaps fall back to the deterministic text-cadence envelope. Reduced-motion keeps a fixed low-energy pose instead of running decorative motion.
- On the target RTX 4060 Laptop GPU, measured warm-path TTFA is about `0.7-1.1 s` depending on voice/style, with generation around `1.6-1.8x` realtime. The initial model load, reference prompt extraction, and CUDA-graph capture take about `30 s`, so they must never be repeated per click.
- Install the isolated tested runtime and official Apache-2.0 model weights with `npm run voice:setup`. Heavy Python/CUDA/model files stay under ignored `runtime/voice/` and do not alter Oscar's backend venv.
- `tools/local-windows-tts.ps1` / Windows SAPI remains only an emergency fallback when the neural runtime is missing or fails. Its blocking worker is completion-bounded and killed with stable `speech-fallback-timeout` semantics if Windows speech hangs. It is not the quality path and must not be presented as a natural voice.
- Browser `speechSynthesis` remains a progressive fallback. It prewarms voices, prefers exact-language natural/neural voices, and queues short semantic chunks so long answers are read completely instead of stalling on one oversized utterance.
- Playback is local after the one-time model setup; answer text is not sent to a speech service. The selected Qwen model is published by Qwen on Hugging Face under Apache-2.0.
- `tools/local-windows-tts.ps1` accepts `probe: true` only for direct QA; production IPC strips unknown fields, so renderer code cannot redirect or persist speech output.

Oscar voice mode (isolated low-latency runtime):

- The Oscar composer has one deterministic primary-action slot: `busy -> stop`, non-empty text or attachments -> `send`, empty draft -> `voice`. One-shot dictation remains a separate control.
- `src/ui/public/modules/oscar-voice-mode.js` owns the fullscreen session and phase machine: `entering -> listening -> recognizing -> routing -> thinking -> speaking -> listening`, plus `error/closed`. Microphone mute is orthogonal state. During `speaking`, the orb stays keyboard/click actionable: one activation stops the current local TTS session and returns to listening without starting a second microphone capture.
- The visual state is deliberately reactive: a quiet breathing idle, a darker contracted listening state driven by microphone level, an organic orbiting thinking form, a brighter asymmetric speaking pulse, and a paused state. The live renderer now uses the approved Visualize-lab contract directly: a 112-point organic Canvas shape, state-specific expanding rings, bounded particles, and listening/speaking voice bands on a wide responsive stage. The old pixel/halo overlay is absent; warm Monarch orange/yellow/white tokens remain, and `prefers-reduced-motion` removes non-essential motion.
- Fullscreen Voice Mode is hands-free after entry. `voice-activity-detector.js` measures time-domain PCM with an adaptive noise floor, a 160 ms guarded warm-up, three-frame onset hysteresis, a 320 ms minimum utterance, and adaptive trailing silence: about 650 ms for short/unstable speech, tightening toward 500 ms for a stable longer phrase. The recorder is already armed during onset detection, so the beginning of the utterance is retained; the orb click remains a manual stop fallback.
- A silent armed recorder is recycled after 8 s without showing a cancellation error, then immediately listens again. A spoken turn is capped at 10.8 s inside Voice Mode and remains under the generic 12 s/8 MB recorder boundary. Mute, close, manual stop, recognition, and TTS all cancel or suspend microphone analysis, preventing duplicate commits and speaker-to-microphone feedback. Manual TTS interruption is deliberately separate from microphone start, so tapping the orb cannot accidentally record while the answer is still playing.
- This is bounded direct streaming recognition with end-of-utterance VAD and a deterministic manual interrupt, not acoustic barge-in, visible interim dictation, wake-word detection, or an always-on background microphone. Those require separate echo/privacy/ownership contracts.
- Voice turns never call `/api/chat`, never hydrate or persist standard Oscar chat history, and never reuse the standard Oscar system prompt. `voice.mode.session.start/complete/close` keep at most 16 messages in an in-memory Voice-owned session with a 30-minute idle TTL; closing Voice Mode forgets it. Fast/realtime receive only the last eight bounded user/assistant messages for pronoun and follow-up resolution. Legacy `route.interactionMode`, `route.voiceLane`, and `model_selection_source=voice-router` remain rejected by the standard chat schema.
- The renderer is transport/orchestration only: `voice.mode.classify` creates a tokenized pending turn, the selected capability runs, and `voice.mode.session.complete` commits the exchange only after a real answer/action result. Aborted and failed turns are not added as successful history.
- The model-free classifier in `src/modules/voice/voice-mode.ts` is authoritative. `voice.mode.respond` reclassifies the transcript server-side and rejects a caller-selected profile that does not match the trusted route.
- Clarification state is session-local and expires after 30 s. After `Для какого города?`, a bare `Киев` becomes the pending weather location without entering Lite; mute, close, timeout, cancellation, or an unrelated deterministic action clears the pending slot.

Voice lane policy:

| Lane | Runtime | Intended work | Hard boundary |
|---|---|---|---|
| `scripted` | no LLM | wake/continue, greetings, thanks, time, arithmetic, clarifications, and registered device actions | unavailable handlers fail closed; an LLM may not pretend an action ran |
| `voice-micro` | dormant compatibility profile | no normal Voice Mode route | must not be preloaded or used for greetings, facts, actions, arithmetic, or routing decisions |
| `voice-lite` | Qwen3 1.7B Q4_K_M, lazy CPU worker | bounded non-factual wording transformations only | no-think mode, 96-token ceiling; no facts, actions, current-data claims, or open-ended conversation |
| `voice-realtime` | Open-Meteo; focused search extraction; bounded search excerpts + exact `gemma4-fast` fallback | weather, current officeholders, politics, news, prices, rates, and explicit realtime lookup | verified officeholder extraction can answer without an LLM; missing evidence fails honestly |
| `fast-llm` | dedicated `/api/voice/fast` -> exact `gemma4-fast` E2B tier | stable facts, follow-ups, and short reasoning that exceed scripted/Lite | trusted minimal voice prompt, 192-token ceiling, strict tier; bounded ephemeral Voice history only, no persistent memory, tools, search, or quality regeneration |
| `blocked` | no model | oversized or explicitly text-only work | asks the user to continue in text mode |

- `voice.mode.prepare` warms only the streaming STT by default and returns an empty LLM profile list. Qwen TTS startup owns first priority; Sherpa starts after the shared Qwen readiness coordinator. Micro is not spawned in the normal flow, while Lite remains lazy until an allowlisted wording transformation actually needs it.
- `VoiceModeModelManager` owns the optional Lite JSONL worker with `n_gpu_layers=0`, `offload_kqv=False`, and `op_offload=False`, leaving the RTX 4060 for Qwen TTS. The worker has a minimal trusted prompt; renderer input cannot override its model path, sampling, token ceiling, or hardware policy. Qwen3 thinking is disabled through the chat template and `/no_think`; leaked `<think>` content is rejected.
- Before `fast-llm` or `voice-realtime`, and when Voice Mode closes, the renderer awaits `voice.mode.release`. A failed release blocks the heavier route instead of overlapping Lite with Gemma. A timed-out Lite/Sherpa worker is quarantined and fully retired before any replacement or fallback process is started.
- Current-officeholder queries use focused DDGS Wikipedia snippets with `fetch_pages=False`. `build_voice_officeholder_answer` returns a short model-free answer only when the source explicitly states the current relation or two independent sources corroborate the person; historical/former context is rejected. Other realtime questions continue through bounded search plus Fast, or return no reliable result when evidence is absent.
- The scripted executor completes `listen.continue`, `time.query`, `math.calculate`, verified Windows volume writes, verified Windows volume reads, and Device-delegated display brightness reads/writes. Brightness supports absolute and relative phrases such as `яркость на 50%`, `сделай экран ярче`, and `какая сейчас яркость?`; every write uses WMI and succeeds only after a real reread within one percentage point.
- Weather with a location goes through fixed-host Open-Meteo geocoding/forecast calls with redirects and proxy inheritance disabled, bounded responses/timeouts, strict WMO/numeric validation, and `model: open-meteo`, `generation_ms: 0`. Russian locatives such as `в Киеве`, `в Москве`, and `в Лондоне` are resolved only when the canonical geocoder result matches; a wrong fuzzy first hit is rejected.
- Application launch, safe HTTP(S) browser navigation/search, YouTube search, and basic workspace create/delete now leave the LLM lane and execute through existing `device.*` / `workspace.*` capabilities. Every mutating/device request uses the exact one-time confirmation token, existing filesystem boundaries, and truthful capability result. App names are data, never shell fragments; common aliases use fixed launchers and other installed apps resolve through `Get-StartApps`. Browser targets reject non-HTTP(S) schemes and credentials.
- Wi-Fi, Bluetooth, monitor power, and other unregistered device operations remain fail-closed and cannot be claimed by an LLM. WMI brightness is available only for an active built-in display; unsupported external monitors fail honestly without falling into an LLM.
- `voice-mode-phrases.js` provides 100 anti-repeat waiting phrases. They are visual feedback only. If waiting audio is added, it must be a bounded pre-rendered cache that stops as soon as answer audio/token becomes available; it must not launch a second TTS generation while Fast is loading.
- Existing Qwen TTS remains the only answer speech layer. Closing the surface aborts the active voice capability, local capture, and TTS without writing a partial turn into the standard Oscar conversation.
- Tray wake is still a separate next slice: after explicit opt-in and only while the main window is hidden, a dedicated main-process wake listener should accept only `Оскар` and open a sandboxed bottom-center mini-window. Hidden renderer capture and duplicate microphone ownership remain forbidden.

Installed voice LLM weights (ignored runtime data):

| Profile | File | Source | License | SHA-256 |
|---|---|---|---|---|
| Micro | `runtime/voice/models/voice-lite/qwen2.5-0.5b-instruct-q4_k_m.gguf` (491,400,032 bytes) | `Qwen/Qwen2.5-0.5B-Instruct-GGUF` | Apache-2.0 | `74A4DA8C9FDBCD15BD1F6D01D621410D31C6FC00986F5EB687824E7B93D7A9DB` |
| Lite | `runtime/voice/models/voice-lite/qwen3-1.7b-q4_k_m.gguf` (1,107,409,472 bytes) | `unsloth/Qwen3-1.7B-GGUF` | Apache-2.0 | `B139949C5BD74937AD8ED8C8CF3D9FFB1E99C866C823204DC42C0D91FA181897` |

Rejected benchmark candidates `Qwen3-0.6B-Q8_0` and `Qwen2.5-1.5B-Q4_K_M` were removed after the quality gate; they are not runtime dependencies.

Capabilities:

- `voice.status`, risk `read`
- `voice.transcribe.audio`, risk `read`
- `voice.transcribe.stream.start`, risk `read`
- `voice.transcribe.stream.push`, risk `read`
- `voice.transcribe.stream.finish`, risk `read`
- `voice.transcribe.stream.cancel`, risk `read`
- `voice.mode.classify`, risk `read`
- `voice.mode.session.start`, risk `read`
- `voice.mode.session.complete`, risk `read`
- `voice.mode.session.close`, risk `read`
- `voice.mode.prepare`, risk `read`
- `voice.mode.release`, risk `read`
- `voice.mode.respond`, risk `read`
- `voice.mode.execute-scripted`, risk `read`
- `voice.bridge.start`, risk `execute`
- `voice.bridge.stop`, risk `execute`

The dedicated Fast path is exposed by the Oscar module as `oscar.voice.fast`, risk `read`; current-data lookup uses `oscar.voice.realtime`, risk `network`. Neither is part of the standard chat capability.

Env vars:

- `MONARCH_STT_TRANSCRIBE_COMMAND`
- `MONARCH_STT_PYTHON`
- `MONARCH_STT_LANGUAGE`
- `MONARCH_STT_PREWARM_ON_ACTIVATE`
- `MONARCH_SHERPA_MODEL_DIR`
- `MONARCH_SHERPA_THREADS`
- `MONARCH_STT_COMMAND`
- `MONARCH_TTS_COMMAND`
- `MONARCH_VOSK_FFMPEG_FILTERS`

Started bridge processes are managed by Monarch and can emit line-delimited JSON on stdout. Each stdout/stderr line becomes a `voice.bridge.event` event. Non-JSON lines are preserved as bounded text.

Starting and stopping bridges requires confirmation through the normal permission gate.
