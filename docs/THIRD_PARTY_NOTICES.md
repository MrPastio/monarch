# Third-party notices

## Qwen3-TTS synthetic voice references

Monarch's release contract defines synthetic `oscar`, `oscar-clear`, and
`aurora` product voices generated from text and natural-language descriptions
with `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign`; no human reference recording or
voice-cloning input is used for that generation. This statement attaches to
the promoted WAV bytes only after `assets/voice/reference-provenance.json` is
`verified` and its full `verify-release` chain passes. A
`pending-regeneration` contract makes no provenance claim about existing
bundled WAV bytes.

Pinned source revision:
`5ecdb67327fd37bb2e042aab12ff7391903235d3`

Model source and notice:
https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign/tree/5ecdb67327fd37bb2e042aab12ff7391903235d3

The Qwen3-TTS model is made available by the Qwen team under the Apache
License 2.0: https://www.apache.org/licenses/LICENSE-2.0

The model weights are not part of Monarch's public source snapshot. Exact
generation inputs, settings, local model hashes, and output-evidence status are
recorded in `assets/voice/reference-provenance.json`.

The pinned local generation runtime also uses:

- `faster-qwen3-tts` 0.3.0, MIT:
  https://pypi.org/project/faster-qwen3-tts/0.3.0/
  Source: https://github.com/andimarafioti/faster-qwen3-tts/tree/v0.3.0
  License:
  https://github.com/andimarafioti/faster-qwen3-tts/blob/v0.3.0/LICENSE
- `qwen-tts` 0.1.1, Apache-2.0:
  https://pypi.org/project/qwen-tts/0.1.1/
  Source:
  https://github.com/QwenLM/Qwen3-TTS/tree/6cafe5582caea83df269c36b1ce62d953a9cc66b
  License:
  https://github.com/QwenLM/Qwen3-TTS/blob/6cafe5582caea83df269c36b1ce62d953a9cc66b/LICENSE

These Python packages and the model weights are installed separately under the
ignored local runtime; they are not copied into Monarch's public source
snapshot.

## @illuma-ai/icons ThinkingOrb

Monarch uses and adapts the `ThinkingOrb` motion primitive from
`@illuma-ai/icons` 2.7.0 in the Oscar thinking/search status UI.

MIT License

Copyright (c) 2026 Illuma AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
