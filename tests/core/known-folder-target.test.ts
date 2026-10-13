import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ensureWritableParentDirectory,
  extractDriveRoot,
  isFilesystemRoot,
} from '../../src/core/filesystem-policy';
import {
  extractDriveWriteDestination,
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

  it('treats a drive letter as a write destination only when Desktop/Downloads were not requested', () => {
    expect(extractDriveRoot('создай игру динозаврика в файле на html и помести ее на диск D')).toBe('D:\\');
    expect(extractDriveRoot('put the file on drive E')).toBe('E:\\');
    expect(extractDriveRoot('какие у меня папки на диске E?')).toBe('E:\\');
    expect(extractDriveRoot('прочитай E:\\Agent-QA\\status.json')).toBe('');
    expect(extractDriveWriteDestination(
      'создай игру динозаврика в файле на html и помести ее на диск D',
    )).toBe('D:\\');
    expect(parseKnownFolderFileRequest(
      'создай игру динозаврика в файле на html и помести ее на диск D',
    )).toBeNull();
    expect(extractDriveWriteDestination(
      'создай на рабочем столе текстовый файл с именем ромашка',
    )).toBe('');
    expect(extractDriveWriteDestination('какие у меня папки на диске E?')).toBe('E:\\');
  });

  it('does not treat a file on a drive root as the drive root itself', () => {
    expect(isFilesystemRoot('D:\\')).toBe(true);
    expect(isFilesystemRoot('D:/')).toBe(true);
    expect(isFilesystemRoot('D:\\dino-game.html')).toBe(false);
    expect(isFilesystemRoot('D:\\games\\dino-game.html')).toBe(false);
  });

  it('does not mkdir a Windows drive root before writing a file on that volume', async () => {
    await expect(ensureWritableParentDirectory('D:\\dino-game.html')).resolves.toBeUndefined();
  });

  it('still creates missing nested parents for an ordinary file path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-parent-dir-'));
    const nested = path.join(root, 'games', 'html', 'dino-game.html');
    try {
      await ensureWritableParentDirectory(nested);
      expect(isFilesystemRoot(path.dirname(nested))).toBe(false);
      expect((await stat(path.dirname(nested))).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
