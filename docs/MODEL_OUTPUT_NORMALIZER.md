# Model Output Normalizer

`normalizeModelOutput()` is the clean-room Monarch adaptation of MARK-ALFA model-output normalization.

It converts unstable model text into a stable envelope:

```ts
{
  schemaVersion: 'monarch.model-output.v1',
  intent: string,
  status: 'success' | 'partial' | 'error',
  outputType: 'text' | 'json' | 'code' | 'html' | 'md' | 'artifact',
  data: unknown,
  userMessage: string,
  meta: Record<string, unknown>
}
```

Supported inputs:

- strict JSON envelopes
- fenced JSON
- embedded balanced JSON objects
- fenced code blocks
- markdown/html/plain text

This does not execute model output. It only normalizes it so later planner, artifact, and tool layers can validate and route it safely.
