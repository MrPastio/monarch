# Monarch Studio

Monarch Studio is the first member of the promoted `Monarch Modules` suite.

The current module establishes the versioned local project format, safe project creation/save, typed photo operations, a basic video timeline, bounded non-destructive undo/redo, and license-aware export planning. The visual renderer is added only after its interaction concept is selected and browser-verified.

Implemented media-core operations:

- photo source, canvas resize/background, crop, rotate, flip;
- image, text, shape, and drawing layers with transforms, visibility, locking, opacity, blend modes, filters, selection, duplicate, remove, and reorder;
- video/audio/text tracks with add/update/remove/reorder;
- clips with add/update/move/remove/split, playback rate, volume, fades, opacity, selection, playhead, and duration;
- 50-step branching history with validated before/after snapshots;
- atomic project save constrained to the Studio projects root.

Planned engine boundaries:

- photo: Fabric.js-backed, non-destructive object/layer model;
- video preview and fast path: native media APIs plus Mediabunny/WebCodecs;
- compatibility export: user-provided or separately licensed FFmpeg;
- AI: optional local Transformers.js tools with model storage outside `C:`;
- Remotion: optional template adapter only after explicit license approval.
