# Monarch Project Presentation

2D animated Remotion presentation and vertical social edit of the Monarch local-first AI ecosystem.

- Composition: `MonarchProject`
- Format: 1920×1080, 30 FPS
- Duration: 1611 frames (~53.7 seconds)
- Composition: `MonarchTikTok`
- Format: 1080×1920, 30 FPS
- Duration: 536 frames (~17.9 seconds)
- Composition: `MonarchPhonkEdit`
- Format: 1080×1920, 30 FPS
- Duration: 456 frames (15.2 seconds)
- Focus: high-contrast graphic-novel edit using the real Monarch mark, module names, and Oscar mascot states
- Audio: original 150 BPM phonk beat generated locally by `scripts/generate_phonk.py`
- Composition: `MonarchVoiceMode`
- Format: 1920×1080, 30 FPS
- Duration: 420 frames (14 seconds)
- Focus: editable motion reference for five Oscar Voice Mode states
- Language: Russian
- Style: dark glassmorphism with orange, gold, white, and black

## Commands

```powershell
npm run dev
npm run lint
npm run still
npm run render
npm run still:tiktok
npm run render:tiktok
npm run audio:phonk
npm run stills:phonk
npm run render:phonk
npm run stills:voice
npm run render:voice
```

The final renders are written to `out/monarch-project-presentation.mp4`, `out/monarch-tiktok-edit.mp4`, `out/monarch-phonk-edit.mp4`, and `out/monarch-voice-mode-motion-reference.mp4`.
