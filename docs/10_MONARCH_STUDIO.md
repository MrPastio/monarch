# Monarch Modules и Monarch Studio

> Стадия обоих компонентов: **Alpha**. Monarch в целом имеет статус **Beta**.
> Основные пользовательские пути реализованы и проверены, но расширенные media
> engines и module-authoring contracts ещё могут меняться.

## Product boundary

`Monarch Modules` — promoted suite верхнего уровня. Он получает отдельную точку входа
в навигации и запускается раньше дочерних модулей, но не получает дополнительных
полномочий. Router, Permission Gate, audit, filesystem policy и Security остаются
обязательными для suite и всех его детей.

Первый дочерний продукт — `Monarch Studio`: local-first редактор фото и базовый
редактор видео. Project format — `monarch-studio@1`.

Выбранный UX — **Guided Flow (concept 2)**: canvas остаётся главным, а справа
открываются понятные группы задач. Точные параметры и более сложные инструменты
раскрываются постепенно, без отдельного «профессионального режима» на старте.

## Меню suite

Минимальная информационная архитектура:

1. **Studio** — фото и видео проекты.
2. **Создать модуль** — guided builder `draft → validate → preview → create`.
3. **Мои модули** — статус, capabilities, dependencies и health дочерних модулей.

Следующие кандидаты, только после полноценного Studio MVP:

- **Monarch Convert** — локальная конвертация, сжатие и resize;
- **Monarch Capture** — screenshot/screen recording и быстрая разметка;
- **Monarch Publish** — reusable export presets и batch handoff.

## UX invariants

Эти правила не зависят от выбранного visual concept:

- первый экран показывает один главный результат и одно основное действие;
- beginner mode включён по умолчанию, точные параметры раскрываются постепенно;
- любое действие сразу видно на canvas/preview и всегда можно отменить;
- destructive edits отсутствуют: source не меняется, project хранит операции и ссылки;
- сложные термины заменяются задачами: «Сделать светлее», «Убрать фон», «Обрезать»;
- hover/selection/progress состояния заметны, но motion не мешает редактированию;
- клавиатура: `Ctrl+Z`, `Ctrl+Shift+Z`, `Delete`, arrows и `Space` для preview;
- ошибки объясняют, что осталось сохранено и какое действие можно сделать дальше;
- offline/local status и скачивание AI-модели показываются честно;
- export всегда имеет preview, формат, размер, качество, progress и cancel.

## Photo MVP

### Реализованный media-core

- canvas size/background;
- source reference, crop, right-angle rotate и flip;
- image, text, shape и drawing layers;
- position, size, rotation, opacity, visibility, lock и layer order;
- brightness, contrast, saturation, hue, blur, grayscale, sepia и invert;
- selection, duplicate, update и remove;
- 50-step branching undo/redo history;
- validated atomic project save.

### Реализованный renderer/UI slice

- Fabric.js `7.4.0` node adapter для validated project export в PNG/JPEG;
- browser import через user file picker без передачи файла в Oscar/LLM;
- Guided UI: before/after, presets, exposure/contrast/color/warmth, crop, rotate,
  flip, resize, retouch, text, brush, rectangle/ellipse markup;
- локальный browser PNG/JPEG/WebP export с выбранным crop/resize, фильтрами,
  разметкой и текстом;
- branching UI history, `Ctrl+Z`, `Ctrl+Shift+Z`, `Ctrl+S`, clickable recovery steps;
- source не перезаписывается, backend export использует отдельный configured exports root.

WebP остаётся browser-only. Тяжёлые pixel operations и полноценный direct-manipulation
layer canvas — следующий этап, а не скрытая готовая возможность.

### Advanced lane

- masks и blend modes beyond MVP;
- healing/clone and histogram;
- optional local background removal через Transformers.js;
- AI model revision pin, visible download progress, explicit E:/D: model root и dispose.

## Video MVP

### Реализованный media-core

- video, audio и text tracks;
- clip add/update/move/remove/split;
- start/duration/source offset/playback rate;
- volume, fades, opacity, selection и playhead;
- overlap warnings и duration bounds;
- undo/redo through the same project history.

### Реализованный preview/export slice

- native `<video>` preview, play/pause и текущая позиция;
- trim start/end, playback speed, volume и text overlay;
- локальный WebM export через canvas capture + `MediaRecorder`, с progress и
  сохранением аудио, когда Chromium отдаёт audio track;
- Mediabunny `1.50.9` probe для локальных media-файлов внутри workspace: container,
  duration, primary video/audio codec, dimensions, sample rate и decodability;
- честные ошибки для неподдерживаемого codec/export surface.

Snapping/zoom, thumbnails, multi-clip browser timeline и совместимый MP4 remux ещё не
выдаются за готовые. Они остаются следующим video slice.

Remotion не является ядром editor/runtime. Он может появиться только как optional
template adapter после отдельной проверки лицензии и явного продуктового решения.

## Project safety

- project содержит только JSON и file references, не binary media blobs;
- save разрешён только внутри configured Studio projects root;
- project validation не нормализует повреждённые ids молча;
- history snapshots не содержат саму history и ограничены 50 entries;
- новый edit после undo удаляет только недостижимую redo branch;
- UI не запускает shell и не получает generic Electron IPC;
- будущие process/network/model actions остаются typed capabilities.

## Open-source references

Решения используются как источник архитектуры и UX, а не копируются целиком:

- Fabric.js — object/layer canvas model: https://fabricjs.com/docs/core-concepts/
- miniPaint — local browser editor patterns: https://github.com/viliusle/miniPaint
- OpenCut — local-first lightweight timeline ideas: https://github.com/OpenCut-app/OpenCut
- Mediabunny — browser media pipeline: https://mediabunny.dev/guide/introduction
- Transformers.js — optional local vision inference: https://huggingface.co/docs/transformers.js/
- BiRefNet lite ONNX — candidate background removal model: https://huggingface.co/onnx-community/BiRefNet_lite-ONNX
- Remotion pricing/license boundary: https://www.remotion.dev/docs/license/pricing
- FFmpeg distribution compliance: https://ffmpeg.org/legal.html
- Phosphor Icons — pinned official SVG icon set, license сохранена рядом с assets:
  https://github.com/phosphor-icons/core

## Definition of done

Studio нельзя считать завершённым, пока не доказаны все пункты:

- выбранный mock faithfully реализован в live `src/ui/public`;
- beginner photo workflow работает от import до export;
- основной photo toolset реально меняет canvas и переживает save/reopen;
- базовый video workflow import → trim/split → audio/text → export работает;
- undo/redo, autosave/recovery, keyboard, reduced motion и errors проверены;
- no-network/offline behavior проверен;
- in-app Browser comparison против выбранного mock выполнен в одинаковом viewport;
- typecheck, root tests, smoke и desktop smoke зелёные;
- Memory v3 compatibility решена без потери пользовательских полей.
