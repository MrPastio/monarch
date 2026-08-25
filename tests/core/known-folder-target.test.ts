import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  knownFolderWriteInputMatchesRequest,
  knownFolderWriteOutputMatchesRequest,
  parseKnownFolderFileRequest,
} from '../../src/core/known-folder-target';

describe('known-folder request target grammar', () => {
  it.each([
    ['создай на рабочем столе текстовый файл с именем ромашка', 'desktop', 'ромашка.txt'],
    ['создай текстовый файл под названием ромашка на рабочем столе', 'desktop', 'ромашка.txt'],
    ['create a text file named hello world on the desktop', 'desktop', 'hello world.txt'],
    ['save a text file called "release notes" in Downloads', 'downloads', 'release notes.txt'],
  ])('extracts one exact leaf without swallowing the location: %s', (request, knownFolder, basename) => {
    expect(parseKnownFolderFileRequest(request)).toMatchObject({
      knownFolder,
      basename,
      content: '',
      overwrite: false,
    });
  });

  it.each([
    'создай текстовый файл на рабочем столе',
    'create a text file on the desktop',
    'save a document in Downloads',
  ])('fails closed when no explicit filename can be proven: %s', (request) => {
    expect(parseKnownFolderFileRequest(request)).toBeNull();
  });

  it('binds explicit content to exact UTF-8 bytes and readback hash', async () => {
    const oldDesktop = process.env.MONARCH_DESKTOP_DIR;
    const qaRoot = path.join(path.parse(process.cwd()).root, 'Monarch-Agent-QA');
    await mkdir(qaRoot, { recursive: true });
    const desktop = await mkdtemp(path.join(qaRoot, 'known-folder-content-'));
    process.env.MONARCH_DESKTOP_DIR = desktop;
    const request = 'создай на рабочем столе текстовый файл с именем ромашка с текстом привет';
    const expected = Buffer.from('привет', 'utf8');
    try {
      expect(parseKnownFolderFileRequest(request)).toMatchObject({
        basename: 'ромашка.txt',
        content: 'привет',
      });
      expect(knownFolderWriteInputMatchesRequest(request, {
        knownFolder: 'desktop', basename: 'ромашка', content: 'привет', overwrite: false,
      })).toBe(false);
      expect(knownFolderWriteInputMatchesRequest(request, {
        knownFolder: 'desktop', basename: 'ромашка.txt', content: 'привет', overwrite: false,
      })).toBe(true);
      const base = {
        verified: true,
        knownFolder: 'desktop',
        basename: 'ромашка.txt',
        path: path.join(desktop, 'ромашка.txt'),
        bytes: expected.byteLength,
      };
      expect(knownFolderWriteOutputMatchesRequest(request, {
        ...base,
        readbackSha256: createHash('sha256').update(expected).digest('hex'),
      })).toBe(true);
      expect(knownFolderWriteOutputMatchesRequest(request, {
        ...base,
        readbackSha256: createHash('sha256').update('пока', 'utf8').digest('hex'),
      })).toBe(false);
    } finally {
      if (oldDesktop === undefined) delete process.env.MONARCH_DESKTOP_DIR;
      else process.env.MONARCH_DESKTOP_DIR = oldDesktop;
      await rm(desktop, { recursive: true, force: true });
    }
  });
});
