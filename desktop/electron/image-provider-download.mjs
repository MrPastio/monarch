import { randomBytes } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export const MAX_IMAGE_PROVIDER_DOWNLOAD_BYTES = 24 * 1024 * 1024;

export function createImageProviderDownloadHandler(options) {
  const configuredRoot = String(options?.root || '').trim();
  const root = configuredRoot && path.isAbsolute(configuredRoot) ? path.resolve(configuredRoot) : null;
  const isTrustedSource = typeof options?.isTrustedSource === 'function'
    ? options.isTrustedSource
    : () => false;
  const emit = typeof options?.emit === 'function' ? options.emit : () => undefined;
  const maxBytes = Number.isSafeInteger(options?.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : MAX_IMAGE_PROVIDER_DOWNLOAD_BYTES;

  return (event, item, webContents) => {
    if (!root || !isTrustedSource(webContents) || typeof item?.setSavePath !== 'function'
      || typeof item?.on !== 'function' || typeof item?.once !== 'function') {
      event.preventDefault();
      return;
    }
    const originalName = sanitizeDownloadName(item?.getFilename?.());
    const temporaryPath = path.join(root, `${randomBytes(16).toString('hex')}.download`);
    let oversized = false;
    item.setSavePath(temporaryPath);
    emit({ schemaVersion: 1, status: 'started', name: originalName });
    item.on('updated', () => {
      if (oversized || Number(item.getReceivedBytes?.() || 0) <= maxBytes) return;
      oversized = true;
      item.cancel();
      emit({
        schemaVersion: 1,
        status: 'rejected',
        name: originalName,
        code: 'image-download-too-large',
        message: 'Изображение превышает лимит 24 МБ.',
      });
    });
    item.once('done', (_downloadEvent, state) => {
      void finishImageProviderDownload({
        state,
        temporaryPath,
        originalName,
        oversized,
        maxBytes,
        emit,
      });
    });
  };
}

async function finishImageProviderDownload({
  state,
  temporaryPath,
  originalName,
  oversized,
  maxBytes,
  emit,
}) {
  try {
    if (oversized) return;
    if (state !== 'completed') {
      emit({
        schemaVersion: 1,
        status: state === 'cancelled' ? 'cancelled' : 'failed',
        name: originalName,
        code: state === 'cancelled' ? 'image-download-cancelled' : 'image-download-failed',
        message: state === 'cancelled' ? 'Скачивание отменено.' : 'Perchance не завершил скачивание изображения.',
      });
      return;
    }
    const details = await stat(temporaryPath);
    if (!details.isFile() || details.size < 12 || details.size > maxBytes) {
      emit({
        schemaVersion: 1,
        status: 'rejected',
        name: originalName,
        code: 'image-download-invalid-size',
        message: 'Скачанный файл пуст или превышает лимит 24 МБ.',
      });
      return;
    }
    const bytes = await readFile(temporaryPath);
    const mimeType = detectImageMimeType(bytes);
    if (!mimeType) {
      emit({
        schemaVersion: 1,
        status: 'rejected',
        name: originalName,
        code: 'unsupported-image-type',
        message: 'Perchance скачал файл, но это не PNG, JPEG или WebP.',
      });
      return;
    }
    await rm(temporaryPath, { force: true });
    emit({
      schemaVersion: 1,
      status: 'ready',
      name: normalizeImageFilename(originalName, mimeType),
      mimeType,
      bytes: bytes.byteLength,
      dataBase64: bytes.toString('base64'),
      source: 'perchance-user-download',
    });
  } catch {
    emit({
      schemaVersion: 1,
      status: 'failed',
      name: originalName,
      code: 'image-download-read-failed',
      message: 'Monarch не смог проверить скачанный файл.',
    });
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export function detectImageMimeType(bytes) {
  if (!bytes || bytes.byteLength < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export function sanitizeDownloadName(value) {
  const basename = path.basename(String(value || '').replace(/[\u0000-\u001f\u007f]/gu, '').trim());
  return basename.slice(0, 160) || 'perchance-image';
}

function normalizeImageFilename(value, mimeType) {
  const extension = mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.jpg';
  const withoutKnownExtension = value.replace(/\.(?:png|jpe?g|webp)$/iu, '');
  return `${withoutKnownExtension || 'perchance-image'}${extension}`.slice(0, 180);
}
