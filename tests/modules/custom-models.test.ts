import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalCustomModelStore, labelFromFileName, quantizationOf } from '../../src/modules/models/custom-models';
import { LocalModelPreferenceStore } from '../../src/settings/model-preference';
import { customChatGguf } from '../fixtures/custom-chat-gguf';

let root = '';
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'monarch-custom-models-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function ggufFile(name: string, bytes = 17 * 1024 * 1024): Promise<string> {
  const file = path.join(root, name);
  const buffer = Buffer.alloc(bytes);
  customChatGguf().copy(buffer);
  await writeFile(file, buffer);
  return file;
}

describe('LocalCustomModelStore', () => {
  it('rejects a renamed MTP-only file and leaves the registry unchanged', async () => {
    const store = new LocalCustomModelStore({ modelsRoot: path.join(root, 'models') });
    const file = await ggufFile('chat-model.gguf');
    const payload = Buffer.alloc(17 * 1024 * 1024);
    customChatGguf({ draft: true }).copy(payload);
    await writeFile(file, payload);
    await expect(store.addLocalFile({ path: file })).rejects.toMatchObject({ code: 'custom-model-draft-only' });
    expect(await store.list()).toEqual([]);
    expect((await readFile(file)).length).toBe(payload.length);
  });

  it('revalidates an older ready record and does not rewrite it or remove its file', async () => {
    const store = new LocalCustomModelStore({ modelsRoot: path.join(root, 'models') });
    const file = await ggufFile('old.gguf');
    await store.addLocalFile({ path: file });
    expect((await store.list())[0]?.status).toBe('ready');
    const registryPath = path.join(root, 'models', 'custom_models', 'registry.v1.json');
    const before = await readFile(registryPath);
    const payload = Buffer.alloc(17 * 1024 * 1024);
    customChatGguf({ draft: true }).copy(payload);
    await writeFile(file, payload);
    expect((await store.list())[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('MTP draft') });
    expect(await readFile(registryPath)).toEqual(before);
  });

  it.each([{ auxiliary: true }, { split: true }])('refuses a non-chat GGUF %j', async options => {
    const store = new LocalCustomModelStore({ modelsRoot: root });
    const file = await ggufFile('model.gguf');
    const payload = Buffer.alloc(17 * 1024 * 1024);
    customChatGguf(options).copy(payload);
    await writeFile(file, payload);
    await expect(store.addLocalFile({ path: file })).rejects.toMatchObject({ code: options.split ? 'custom-model-split' : 'custom-model-auxiliary' });
  });

  it('accepts a full model with MTP even when its filename says draft', async () => {
    const store = new LocalCustomModelStore({ modelsRoot: root });
    const file = await ggufFile('draft.gguf');
    const payload = Buffer.alloc(17 * 1024 * 1024);
    customChatGguf({ mtp: true }).copy(payload);
    await writeFile(file, payload);
    await expect(store.addLocalFile({ path: file })).resolves.toMatchObject({ status: 'ready' });
  });
  it('registers an owner GGUF in place with a friendly name', async () => {
    const store = new LocalCustomModelStore({ modelsRoot: path.join(root, 'models') });
    const file = await ggufFile('Mistral-7B-Instruct-v0.3-Q4_K_M.gguf');
    const model = await store.addLocalFile({ path: file });
    expect(model.id).toMatch(/^custom-[a-f0-9]{12}$/u);
    expect(model.label).toBe('Mistral 7B Instruct v0.3');
    expect(model.status).toBe('ready');
    expect(model.contextTokens).toBe(8192);
    const registry = JSON.parse(await readFile(path.join(root, 'models', 'custom_models', 'registry.v1.json'), 'utf8'));
    expect(registry.models[0].path).toBe(path.resolve(file));
    await expect(store.addLocalFile({ path: file })).rejects.toThrow('уже добавлена');
  });

  it('refuses files that are not GGUF models', async () => {
    const store = new LocalCustomModelStore({ modelsRoot: root });
    const notGguf = path.join(root, 'weights.gguf');
    await writeFile(notGguf, Buffer.alloc(17 * 1024 * 1024));
    await expect(store.addLocalFile({ path: notGguf })).rejects.toThrow('Это не модель GGUF');
    await expect(store.addLocalFile({ path: path.join(root, 'model.bin') })).rejects.toThrow('.gguf');
    await expect(store.addLocalFile({ path: 'relative.gguf' })).rejects.toThrow('Выбери файл');
    await expect(store.addLocalFile({ path: await ggufFile('tiny.gguf', 1024) })).rejects.toThrow('слишком маленький');
  });

  it('reports a moved file instead of pretending it is ready', async () => {
    const store = new LocalCustomModelStore({ modelsRoot: root });
    const file = await ggufFile('moved.gguf');
    await store.addLocalFile({ path: file });
    await rm(file);
    expect((await store.list())[0]?.status).toBe('missing');
  });

  it('keeps the owner file when a registered model is removed', async () => {
    const store = new LocalCustomModelStore({ modelsRoot: root });
    const file = await ggufFile('keep.gguf');
    const model = await store.addLocalFile({ path: file, label: 'Мой Qwen' });
    expect(model.label).toBe('Мой Qwen');
    await store.remove(model.id);
    expect(await store.list()).toEqual([]);
    await expect(readFile(file)).resolves.toBeTruthy();
  });

  it('lists a Hugging Face repository and recommends a Q4_K_M file', async () => {
    const requested: string[] = [];
    const fetchImpl = (async (url: string) => {
      requested.push(url);
      return new Response(JSON.stringify({ siblings: [
        { rfilename: 'README.md', size: 10 },
        { rfilename: 'Qwen3-8B-Q8_0.gguf', size: 8_000_000_000 },
        { rfilename: 'Qwen3-8B-Q4_K_M.gguf', size: 5_000_000_000 },
        { rfilename: 'Qwen3-8B-Q2_K.gguf', size: 3_000_000_000 },
        { rfilename: 'mmproj-F16.gguf', size: 600_000_000 },
        { rfilename: 'big/Qwen3-8B-F16-00001-of-00002.gguf', size: 9_000_000_000 },
      ] }), { status: 200 });
    }) as unknown as typeof fetch;
    const store = new LocalCustomModelStore({ modelsRoot: root }, { fetchImpl });
    const inspection = await store.inspectHub('https://huggingface.co/unsloth/Qwen3-8B-GGUF');
    expect(requested[0]).toBe('https://huggingface.co/api/models/unsloth/Qwen3-8B-GGUF?blobs=true');
    expect(inspection.repository).toBe('unsloth/Qwen3-8B-GGUF');
    expect(inspection.suggestedLabel).toBe('Qwen3 8B');
    expect(inspection.files.map((file) => file.file)).toEqual(['Qwen3-8B-Q2_K.gguf', 'Qwen3-8B-Q4_K_M.gguf', 'Qwen3-8B-Q8_0.gguf']);
    expect(inspection.files.find((file) => file.recommended)?.file).toBe('Qwen3-8B-Q4_K_M.gguf');
  });

  it('accepts a direct file link and short repository names', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ siblings: [
      { rfilename: 'model-Q4_K_M.gguf', size: 1 }, { rfilename: 'model-Q6_K.gguf', size: 2 },
    ] }), { status: 200 })) as unknown as typeof fetch;
    const store = new LocalCustomModelStore({ modelsRoot: root }, { fetchImpl });
    const direct = await store.inspectHub('https://huggingface.co/owner/model-GGUF/blob/main/model-Q6_K.gguf');
    expect(direct.files.find((file) => file.recommended)?.file).toBe('model-Q6_K.gguf');
    await expect(store.inspectHub('owner/model-GGUF')).resolves.toMatchObject({ repository: 'owner/model-GGUF' });
    await expect(store.inspectHub('https://example.com/owner/model')).rejects.toThrow('huggingface.co');
  });

  it('downloads a chosen file and becomes ready only after the GGUF check', async () => {
    const payload = Buffer.alloc(17 * 1024 * 1024);
    customChatGguf().copy(payload);
    const fetchImpl = (async (url: string) => {
      expect(url).toBe('https://huggingface.co/owner/model-GGUF/resolve/main/model-Q4_K_M.gguf');
      return new Response(payload, { status: 200, headers: { 'content-length': String(payload.byteLength) } });
    }) as unknown as typeof fetch;
    const store = new LocalCustomModelStore({ modelsRoot: root }, { fetchImpl });
    const started = await store.startDownload({ repository: 'owner/model-GGUF', file: 'model-Q4_K_M.gguf' });
    expect(started.status).toBe('downloading');
    let ready = null;
    for (let attempt = 0; attempt < 200 && !ready; attempt++) {
      ready = (await store.list()).find((model) => model.status === 'ready') || null;
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(ready?.sizeBytes).toBe(payload.byteLength);
    expect(ready?.path.startsWith(path.join(root, 'custom_models', started.id))).toBe(true);
    await store.remove(started.id);
    await expect(readFile(ready!.path)).rejects.toThrow();
  });

  it('names quantizations and labels files readably', () => {
    expect(quantizationOf('Llama-3.2-3B-Instruct-Q4_K_M.gguf')).toBe('Q4_K_M');
    expect(quantizationOf('phi-4-IQ3_XS.gguf')).toBe('IQ3_XS');
    expect(quantizationOf('model.gguf')).toBeNull();
    expect(labelFromFileName('gemma-3-4b-it-Q5_K_M.gguf')).toBe('gemma 3 4b it');
  });
});

describe('LocalModelPreferenceStore', () => {
  it('defaults to the local fallback on and remembers the chosen work mode', () => {
    const store = new LocalModelPreferenceStore(root);
    expect(store.snapshot()).toMatchObject({ work: null, maxLocalFallback: true });
    store.update({ work: 'hybrid' });
    store.update({ maxLocalFallback: false });
    expect(new LocalModelPreferenceStore(root).snapshot()).toMatchObject({ work: 'hybrid', maxLocalFallback: false });
    expect(() => store.update({ work: 'cloud' })).toThrow('model-preference-work');
    expect(() => store.update({ maxLocalFallback: 'yes' })).toThrow('model-preference-fallback');
  });
});
