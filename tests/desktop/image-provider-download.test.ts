import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createImageProviderDownloadHandler } from '../../desktop/electron/image-provider-download.mjs';

const roots: string[] = [];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlK4eQAAAAASUVORK5CYII=', 'base64');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Perchance download bridge', () => {
  it('accepts only a user download from the trusted provider and removes the temporary file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-perchance-download-'));
    roots.push(root);
    const item = createDownloadItem('cat.png', PNG.byteLength);
    const ready = new Promise<Record<string, unknown>>((resolve) => {
      const handler = createImageProviderDownloadHandler({
        root,
        isTrustedSource: (contents: { id?: number }) => contents.id === 42,
        emit: (value: Record<string, unknown>) => {
          if (value.status === 'ready') resolve(value);
        },
      });
      handler({ preventDefault: () => { throw new Error('trusted download was blocked'); } }, item, { id: 42 });
    });
    const temporaryPath = item.savePath;
    expect(path.dirname(temporaryPath)).toBe(root);
    await writeFile(temporaryPath, PNG);
    item.emit('done', {}, 'completed');

    await expect(ready).resolves.toMatchObject({
      status: 'ready',
      name: 'cat.png',
      mimeType: 'image/png',
      bytes: PNG.byteLength,
      dataBase64: PNG.toString('base64'),
      source: 'perchance-user-download',
    });
    await expect(readFile(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('blocks untrusted renderer downloads before choosing a save path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-perchance-download-'));
    roots.push(root);
    const item = createDownloadItem('not-provider.png', PNG.byteLength);
    let prevented = false;
    createImageProviderDownloadHandler({ root, isTrustedSource: () => false })({
      preventDefault: () => { prevented = true; },
    }, item, { id: 7 });
    expect(prevented).toBe(true);
    expect(item.savePath).toBe('');
  });

  it('rejects a completed file whose bytes are not PNG, JPEG, or WebP', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-perchance-download-'));
    roots.push(root);
    const item = createDownloadItem('payload.png', 16);
    const rejected = new Promise<Record<string, unknown>>((resolve) => {
      createImageProviderDownloadHandler({
        root,
        isTrustedSource: () => true,
        emit: (value: Record<string, unknown>) => {
          if (value.status === 'rejected') resolve(value);
        },
      })({ preventDefault: () => undefined }, item, { id: 42 });
    });
    await writeFile(item.savePath, Buffer.from('not an image file'));
    item.emit('done', {}, 'completed');
    await expect(rejected).resolves.toMatchObject({ status: 'rejected', code: 'unsupported-image-type' });
  });
});

function createDownloadItem(filename: string, receivedBytes: number): EventEmitter & {
  savePath: string;
  setSavePath: (value: string) => void;
  getFilename: () => string;
  getReceivedBytes: () => number;
  cancel: () => void;
} {
  const item = new EventEmitter() as EventEmitter & {
    savePath: string;
    setSavePath: (value: string) => void;
    getFilename: () => string;
    getReceivedBytes: () => number;
    cancel: () => void;
  };
  item.savePath = '';
  item.setSavePath = (value) => { item.savePath = value; };
  item.getFilename = () => filename;
  item.getReceivedBytes = () => receivedBytes;
  item.cancel = () => item.emit('done', {}, 'cancelled');
  return item;
}
