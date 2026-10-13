import { open } from 'node:fs/promises';

export class GgufChatError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Bounded GGUF directory inspection; never reads the weight payload.
 * Full models with MTP are allowed. A filename is not admission evidence. */
export async function assertChatGguf(file: string): Promise<void> {
  const handle = await open(file, 'r');
  try {
    const limit = Math.min((await handle.stat()).size, 64 * 1024 * 1024);
    let cursor = 0, windowStart = 0;
    let window = Buffer.alloc(0);
    const fail = (): never => { throw new GgufChatError('custom-model-format'); };
    const skip = (n: number): void => {
      if (!Number.isSafeInteger(n) || n < 0 || cursor + n > limit) fail();
      cursor += n;
    };
    const read = async (n: number): Promise<Buffer> => {
      const position = cursor;
      skip(n);
      if (position < windowStart || position + n > windowStart + window.length) {
        const buffer = Buffer.alloc(Math.min(Math.max(n, 65536), limit - position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        window = buffer.subarray(0, bytesRead); windowStart = position;
      }
      if (position + n > windowStart + window.length) fail();
      return window.subarray(position - windowStart, position - windowStart + n);
    };
    const uint = async (n: 4 | 8): Promise<number> => {
      const raw = await read(n);
      const value = n === 4 ? raw.readUInt32LE() : Number(raw.readBigUInt64LE());
      if (!Number.isSafeInteger(value)) fail();
      return value;
    };
    const string = async (keep = false): Promise<string | undefined> => {
      const n = await uint(8);
      if (!keep) { skip(n); return undefined; }
      if (n > 65536) fail();
      try { return new TextDecoder('utf-8', { fatal: true }).decode(await read(n)); }
      catch { return fail(); }
    };
    const widths: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
    const value = async (kind: number, keep: boolean): Promise<string | number | boolean | undefined> => {
      if (kind === 8) return string(keep);
      if (kind === 9) {
        const element = await uint(4), count = await uint(8);
        if (count > 2_000_000) fail();
        if (element === 8) { for (let i = 0; i < count; i++) await string(); }
        else if (widths[element]) skip(count * widths[element]);
        else fail();
        return undefined;
      }
      const width = widths[kind];
      if (!width) return fail();
      if (!keep) { skip(width); return undefined; }
      const raw = await read(width);
      switch (kind) {
        case 0: return raw.readUInt8(); case 1: return raw.readInt8();
        case 2: return raw.readUInt16LE(); case 3: return raw.readInt16LE();
        case 4: return raw.readUInt32LE(); case 5: return raw.readInt32LE();
        case 6: return raw.readFloatLE(); case 7: return raw.readUInt8() !== 0;
        case 10: return Number(raw.readBigUInt64LE()); case 11: return Number(raw.readBigInt64LE());
        case 12: return raw.readDoubleLE(); default: return fail();
      }
    };
    if ((await read(4)).toString('ascii') !== 'GGUF' || ![2, 3].includes(await uint(4))) fail();
    const tensors = await uint(8), fields = await uint(8);
    if (tensors < 1 || tensors > 200_000 || fields < 1 || fields > 100_000) fail();
    const metadata = new Map<string, string | number | boolean | undefined>(), keys = new Set<string>();
    for (let i = 0; i < fields; i++) {
      const key = (await string(true))!;
      if (keys.has(key)) fail();
      keys.add(key);
      const keep = ['general.architecture', 'general.type', 'split.count'].includes(key)
        || key.endsWith('.block_count') || key.endsWith('.nextn_predict_layers');
      const result = await value(await uint(4), keep);
      if (keep) metadata.set(key, result);
    }
    const arch = metadata.get('general.architecture');
    if (typeof arch !== 'string' || !arch) fail();
    const blocks = new Set<number>();
    for (let i = 0; i < tensors; i++) {
      const block = /^blk\.(\d+)\./u.exec((await string(true))!);
      if (block) blocks.add(Number(block[1]));
      const dimensions = await uint(4);
      if (dimensions < 1 || dimensions > 4) fail();
      skip(8 * dimensions + 4 + 8);
    }
    if (arch === 'clip' || (metadata.get('general.type') ?? 'model') !== 'model') throw new GgufChatError('custom-model-auxiliary');
    if ((metadata.get('split.count') ?? 1) !== 1) throw new GgufChatError('custom-model-split');
    const layers = metadata.get(`${arch}.block_count`), nextn = metadata.get(`${arch}.nextn_predict_layers`) ?? 0;
    if (layers !== undefined) {
      if (typeof layers !== 'number' || !Number.isSafeInteger(layers) || layers < 1 || layers > 200_000
        || typeof nextn !== 'number' || !Number.isSafeInteger(nextn) || nextn < 0 || nextn > layers) return fail();
      const baseLayers = layers - nextn;
      if (nextn > 0 && (baseLayers <= 0 || ![...blocks].some(block => block < baseLayers))) throw new GgufChatError('custom-model-draft-only');
      for (let block = 0; block < baseLayers; block++) if (!blocks.has(block)) fail();
    }
  } finally { await handle.close(); }
}
