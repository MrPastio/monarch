# Monarch Voice

`src/modules/voice` owns local STT/TTS transport plus the pure grammar for the default Simplified Mode. It does not launch applications itself and does not own permission decisions.

Release train: this workstream is accumulated for Monarch `0.3.0`; source readiness does not imply packaged, installed, signed, published, or Stable readiness.

## Two explicit modes

```text
Simplified (default): microphone -> local STT -> deterministic command compiler
                    -> exact Kernel capability -> verified receipt -> local TTS/card

Full Voice (explicit): microphone -> local STT -> Oscar Turn(source=voice)
                     -> AgentTask -> Kernel -> terminal outcome -> local TTS
```

- Simplified Mode is enabled by default in durable Voice settings. It never falls through into Full Voice automatically.
- `src/modules/voice/simplified-command.ts` removes a bounded `Оскар`/`Oscar` wake prefix and compiles supported phrases into exact Device capabilities. Destructive and unknown requests return a handoff result without execution.
- `/api/voice/simplified` accepts only an attested local Desktop principal. It bypasses Agent planning but never bypasses Kernel permissions, source policy, provider consent, or verification.
- Full Voice remains available only when Simplified Mode is explicitly disabled and is visibly labelled **крайне нестабилен**.
- Voice cannot resolve approvals or change Owner/Security settings. An action that needs approval is presented in Desktop as an exact action-card.
- Wake-only, stop, mute, close, capture cancellation, and speech interruption remain local surface controls.

## Adaptive local targets

- Device builds one trusted target graph from Windows Start Apps, App Paths, Start/Desktop `.lnk` shortcuts, and safe HTTP(S) `.url` shortcuts.
- `.lnk` discovery and launch reject script hosts and revalidate that the shortcut stays under an exact Start/Desktop root before dispatch.
- `semantic-target-resolver.ts` maps generic roles such as music, messaging, mail, browser, notes, documents, IDE, and games onto that graph. Voice contains no `if music -> YouTube Music` branch.
- Exact product identity wins for product requests. A role with one installed provider resolves directly; multiple providers fail closed and return a bounded choice unless a durable preference is present.

## Fast information providers

- Weather uses a fixed-origin Open‑Meteo geocoding/forecast client in `information-provider.ts`; the card supports today, tomorrow, and the day after tomorrow.
- Location comes from an explicit city or OS geolocation. Device coordinates are requested only for a weather command, rounded at the server boundary, sent to Open‑Meteo, and never persisted by Monarch.
- Exchange rates use the official NBU public table. Currency selection and amount conversion happen locally, so NBU receives no transcript or conversion amount.
- Both providers are fail-closed behind exact consent version `2026-08-29.1`. The data/terms boundary is `docs/legal/VOICE_INFORMATION_PROVIDERS_TERMS_RU.md`.
- Default Open‑Meteo hosts are the free non-commercial endpoints. A commercial deployment supplies `MONARCH_OPEN_METEO_API_KEY`; optional `MONARCH_OPEN_METEO_WEATHER_URL` and `MONARCH_OPEN_METEO_GEOCODING_URL` accept only the pinned official free/customer origins.
- News and traffic remain unsupported in Simplified Mode until a provider with an acceptable accuracy/privacy/licensing boundary is selected. Full Voice is never started automatically as a fallback.

## Speech to text

- `voice.transcribe.prepare` warms only the local STT transport.
- `voice.transcribe.stream.start/push/finish/cancel` accepts ordered mono PCM16 batches. Sessions use server-generated IDs, bind to one renderer, enforce exact sequence and bounded byte/time limits, and do not persist raw PCM.
- `MediaRecorder` runs as a fallback when direct PCM setup/finalization fails. The compressed fallback is decoded locally; no cloud STT provider is used.
- `VoiceStreamingSttRuntime` prefers pinned Sherpa ONNX + Russian T-one and falls back truthfully to the resident Vosk worker when the native runtime/model is unavailable.
- Install the complete pinned local STT stack with `npm run voice:stt:setup`: T-one handles live Russian PCM, while Vosk plus a separately licensed local FFmpeg runtime handles bounded Ogg/WebM one-shot input such as Telegram voice notes. Heavy models, decoder and isolated Python packages stay under ignored `runtime/voice/` on the selected data drive.
- `MONARCH_STT_TRANSCRIBE_COMMAND` may supply an isolated custom local adapter with `{audio}` and `{language}` placeholders. Commands run with `shell: false`; inline shell/interpreter code is rejected.
- `MONARCH_DISABLE_DEFAULT_STT=1` disables the built-in adapter. Stable failures such as `voice-stt-timeout`, `voice-stt-command-exit`, and `voice-stt-language-unavailable` must remain truthful.

## Speech playback

- `src/ui/public/modules/oscar-speech.js` owns Markdown cleanup, language selection, chunking, cancellation, and renderer state.
- Desktop prefers the trusted preload bridge and local `Qwen3-TTS-12Hz-0.6B-Base`; references and provenance live in `assets/voice/reference-provenance.json` and `assets/voice/PROVENANCE.md`.
- Install the isolated runtime with `npm run voice:setup`. Model/runtime caches stay outside the source tree's tracked files.
- Windows SAPI and browser `speechSynthesis` are explicit emergency fallbacks, never presented as the neural quality path.
- Answer text stays local. The renderer sends bounded plain speech settings to trusted IPC and never constructs shell commands.

## Surface lifecycle

- Phase machine: `entering -> listening -> recognizing -> routing -> thinking -> speaking -> listening`, plus `error/closed`.
- VAD, mute, manual stop, close, TTS interruption, late-result invalidation, and microphone cleanup remain transport-owned.
- Simplified Mode uses the existing organic orb plus an independent transparent click-through Electron overlay. The hidden main renderer remains resident while Monarch is in the tray; weather/rate results grow into bounded attributed glass cards.
- Full Voice keeps the fullscreen surface and permanent instability warning. Internal model reasoning is never rendered or spoken.
- Background wake is enabled by default after authoritative Voice settings load, marks active microphone state in the tray, and never stores raw audio. This is source/live Desktop behavior, not yet an installed-release acceptance claim.

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

Device time, volume/brightness, application launch, bounded browser work, weather, and NBU rates are supported Simplified commands. Files, shell, deletion, news, and traffic are not.

## Acceptance

- `tests/modules/voice-simplified-command.test.ts` proves wake normalization, exact capability compilation, and no implicit Full Voice/destructive fallback.
- `tests/modules/voice-information-provider.test.ts` proves fixed-origin weather/rate parsing, attribution, local conversion, and missing-location failure.
- `tests/modules/device-semantic-target-resolver.test.ts` proves role resolution, non-music reuse, ambiguity, and preferences.
- `tests/ui/voice-agent-first.test.ts` proves Simplified Mode is default while the common Agent entrypoint remains explicit for Full Voice.
- `tests/ui/api.test.ts` proves `source=voice`, terminal outcome handling, cancellation, and the no-approval-from-voice boundary.
- `tests/modules/voice*.test.ts` cover local transcription, direct PCM session isolation, fallbacks, cleanup, and command policy.
- Operational Voice actions are accepted through the common Agent/Desktop tests and require the same Kernel evidence as typed chat.
