import {
  Ellipse,
  FabricImage,
  FabricObject,
  FabricText,
  Line,
  Polyline,
  Rect,
  StaticCanvas,
  filters,
} from 'fabric/node';
import type {
  StudioDrawingObject,
  StudioImageObject,
  StudioPhotoObject,
  StudioShapeObject,
  StudioTextObject,
} from './photo-document';
import { validateStudioProject, type StudioProjectV1 } from './project';

export type StudioPhotoExportFormat = 'png' | 'jpeg';

export interface StudioPhotoRenderOptions {
  format: StudioPhotoExportFormat;
  quality?: number;
  resolveSource?: (source: string) => Promise<string>;
}

export interface StudioPhotoRenderResult {
  buffer: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  warnings: string[];
}

export async function renderStudioPhoto(
  project: StudioProjectV1,
  options: StudioPhotoRenderOptions
): Promise<StudioPhotoRenderResult> {
  const validation = validateStudioProject(project);
  if (!validation.ok || project.mode !== 'photo') {
    throw new Error(
      project.mode !== 'photo'
        ? 'Studio photo rendering requires a photo project.'
        : `Studio project is invalid: ${validation.errors.join('; ')}`
    );
  }

  const crop = project.photo.crop;
  const width = Math.round(crop?.width ?? project.canvas.width);
  const height = Math.round(crop?.height ?? project.canvas.height);
  const quality = clamp(options.quality ?? project.export.quality, 0.1, 1);
  const canvasOptions = {
    width: project.canvas.width,
    height: project.canvas.height,
    renderOnAddRemove: false,
    ...(project.canvas.background === 'transparent'
      ? {}
      : { backgroundColor: project.canvas.background }),
  };
  const canvas = new StaticCanvas(undefined, canvasOptions);
  const warnings = [...validation.warnings];

  try {
    if (project.photo.source) {
      const source = await resolveImageSource(project.photo.source, options.resolveSource);
      const background = await FabricImage.fromURL(source);
      placeBackground(background, project);
      canvas.add(background);
    }

    for (const object of project.photo.objects) {
      const rendered = await createFabricObject(object, options.resolveSource, warnings);
      canvas.add(rendered);
    }

    canvas.renderAll();
    const dataUrl = canvas.toDataURL({
      format: options.format,
      quality,
      left: crop?.x ?? 0,
      top: crop?.y ?? 0,
      width,
      height,
      multiplier: 1,
      enableRetinaScaling: false,
    });
    const expectedMimeType = options.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const parsed = decodeDataUrl(dataUrl);
    if (parsed.mimeType !== expectedMimeType) {
      throw new Error(`Fabric returned ${parsed.mimeType} for ${options.format} export.`);
    }
    return {
      buffer: parsed.buffer,
      mimeType: expectedMimeType,
      width,
      height,
      warnings: unique(warnings),
    };
  } finally {
    canvas.dispose();
  }
}

async function createFabricObject(
  object: StudioPhotoObject,
  resolver: StudioPhotoRenderOptions['resolveSource'],
  warnings: string[]
): Promise<FabricObject> {
  switch (object.kind) {
  case 'image':
    return createImageObject(object, resolver, warnings);
  case 'text':
    return createTextObject(object);
  case 'shape':
    return createShapeObject(object);
  case 'drawing':
    return createDrawingObject(object);
  }
}

async function createImageObject(
  object: StudioImageObject,
  resolver: StudioPhotoRenderOptions['resolveSource'],
  warnings: string[]
): Promise<FabricImage> {
  const source = await resolveImageSource(object.source, resolver);
  const image = await FabricImage.fromURL(source);
  const imageFilters = [];
  if (object.filters.brightness !== 0) {
    imageFilters.push(new filters.Brightness({ brightness: object.filters.brightness }));
  }
  if (object.filters.contrast !== 0) {
    imageFilters.push(new filters.Contrast({ contrast: object.filters.contrast }));
  }
  if (object.filters.saturation !== 0) {
    imageFilters.push(new filters.Saturation({ saturation: object.filters.saturation }));
  }
  if (object.filters.hue !== 0) {
    imageFilters.push(new filters.HueRotation({ rotation: object.filters.hue / 180 }));
  }
  if (object.filters.blur !== 0) {
    imageFilters.push(new filters.Blur({ blur: object.filters.blur }));
  }
  if (object.filters.grayscale > 0) {
    imageFilters.push(new filters.Grayscale());
    if (object.filters.grayscale < 1) warnings.push('Fabric grayscale export is applied at full strength.');
  }
  if (object.filters.sepia > 0) {
    imageFilters.push(new filters.Sepia());
    if (object.filters.sepia < 1) warnings.push('Fabric sepia export is applied at full strength.');
  }
  if (object.filters.invert > 0) {
    imageFilters.push(new filters.Invert());
    if (object.filters.invert < 1) warnings.push('Fabric invert export is applied at full strength.');
  }
  image.filters = imageFilters;
  image.applyFilters();
  return applyCommonProperties(image, object) as FabricImage;
}

function createTextObject(object: StudioTextObject): FabricText {
  const text = new FabricText(object.text, {
    fill: object.color,
    fontFamily: object.fontFamily,
    fontSize: object.fontSize,
    fontWeight: object.fontWeight,
    textAlign: object.align,
  });
  return applyCommonProperties(text, object) as FabricText;
}

function createShapeObject(object: StudioShapeObject): FabricObject {
  if (object.shape === 'ellipse') {
    return applyCommonProperties(new Ellipse({
      rx: object.width / 2,
      ry: object.height / 2,
      fill: transparentToNull(object.fill),
      stroke: transparentToNull(object.stroke),
      strokeWidth: object.strokeWidth,
    }), object);
  }
  if (object.shape === 'line') {
    return applyCommonProperties(new Line([0, 0, object.width, object.height], {
      fill: null,
      stroke: transparentToNull(object.stroke) || transparentToNull(object.fill),
      strokeWidth: Math.max(1, object.strokeWidth),
    }), object);
  }
  return applyCommonProperties(new Rect({
    width: object.width,
    height: object.height,
    fill: transparentToNull(object.fill),
    stroke: transparentToNull(object.stroke),
    strokeWidth: object.strokeWidth,
  }), object);
}

function createDrawingObject(object: StudioDrawingObject): Polyline {
  const drawing = new Polyline(object.points, {
    fill: null,
    stroke: object.color,
    strokeWidth: object.strokeWidth,
    strokeLineCap: 'round',
    strokeLineJoin: 'round',
  });
  return applyCommonProperties(drawing, object) as Polyline;
}

function applyCommonProperties(object: FabricObject, model: StudioPhotoObject): FabricObject {
  const intrinsicWidth = Math.max(1, Number(object.width) || model.width);
  const intrinsicHeight = Math.max(1, Number(object.height) || model.height);
  object.set({
    left: model.x,
    top: model.y,
    originX: 'left',
    originY: 'top',
    angle: model.rotation,
    opacity: model.opacity,
    visible: model.visible,
    selectable: false,
    evented: false,
    scaleX: model.width / intrinsicWidth,
    scaleY: model.height / intrinsicHeight,
    globalCompositeOperation: model.blendMode === 'normal' ? 'source-over' : model.blendMode,
  });
  return object;
}

function placeBackground(image: FabricImage, project: StudioProjectV1): void {
  const original = image.getOriginalSize();
  const rotated = project.photo.rotation === 90 || project.photo.rotation === 270;
  const sourceWidth = Math.max(1, rotated ? Number(original.height) : Number(original.width));
  const sourceHeight = Math.max(1, rotated ? Number(original.width) : Number(original.height));
  const scale = Math.max(project.canvas.width / sourceWidth, project.canvas.height / sourceHeight);
  image.set({
    left: project.canvas.width / 2,
    top: project.canvas.height / 2,
    originX: 'center',
    originY: 'center',
    angle: project.photo.rotation,
    flipX: project.photo.flipX,
    flipY: project.photo.flipY,
    scaleX: scale,
    scaleY: scale,
    selectable: false,
    evented: false,
  });
}

async function resolveImageSource(
  source: string,
  resolver: StudioPhotoRenderOptions['resolveSource']
): Promise<string> {
  if (source.startsWith('data:image/')) {
    return source;
  }
  if (!resolver) {
    throw new Error('A local source resolver is required for non-data image sources.');
  }
  const resolved = await resolver(source);
  if (!resolved.startsWith('data:image/')) {
    throw new Error('Studio image resolver must return an image data URL.');
  }
  return resolved;
}

function decodeDataUrl(value: string): { mimeType: string; buffer: Buffer } {
  const match = /^data:([^;,]+);base64,([a-z0-9+/=]+)$/i.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new Error('Fabric returned an invalid image data URL.');
  }
  return { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') };
}

function transparentToNull(value: string): string | null {
  return value === 'transparent' ? null : value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
