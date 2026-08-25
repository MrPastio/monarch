# Oscar Cursor Set

The seven `oscar-cursor-*.png` files are the production raster states for
Monarch Computer Use. They were generated as isolated assets from Anton's
selected visual prototype:

`E:\ETS Pro Mods\ChatGPT Image 12 авг. 2026 г., 22_53_50.png`

The embedded native provider loads one asset per state so glow, rings, trails,
text and disabled artwork can never bleed into a neighbouring frame:

1. idle
2. hover
3. pressed
4. moving
5. busy
6. text/precision
7. disabled

The magenta background is removed at runtime into per-pixel alpha. Motion uses
a continuous 360-degree velocity vector: orientation, elastic stretch and the
history trail follow every horizontal, vertical and diagonal direction without
direction presets. Spring physics, cross-fades, glow and the exact half-second
pre-click vibration are rendered by `OscarCursorAnimation.cs`; the PNG files
supply the selected glossy amber body and state-specific artwork.

Runtime size is derived from Windows `SM_CXCURSOR`. After state scale,
directional stretch and rotation are applied, the complete sprite diagonal is
hard-clamped to at most `1.5x` the system cursor width. Do not replace this
with a fixed pixel size or a body-only limit.

Do not replace these assets with a hand-drawn GDI arrow, text label, generic
system cursor or unrelated icon set. Regenerate them only from the selected
Oscar Cursor Set art direction and rerun native visual and live motion QA.
