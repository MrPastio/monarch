/** Minimal real GGUF directory; padded/sparse weight payload belongs to caller. */
export function customChatGguf(options: { draft?: boolean; auxiliary?: boolean; split?: boolean; mtp?: boolean } = {}): Buffer {
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (s: string) => { const b = Buffer.from(s); return Buffer.concat([u64(b.length), b]); };
  const field = (key: string, val: string | number) => Buffer.concat([str(key), u32(typeof val === 'string' ? 8 : 4), typeof val === 'string' ? str(val) : u32(val)]);
  const metadata = [field('general.architecture', options.auxiliary ? 'clip' : 'qwen35'), field('general.type', 'model'),
    field('qwen35.block_count', 3), field('qwen35.nextn_predict_layers', options.draft || options.mtp ? 1 : 0),
    field('split.count', options.split ? 2 : 1)];
  const tensors = (options.draft ? [2] : [0, 1, 2]).map(block => Buffer.concat([
    str(`blk.${block}.attn_norm.weight`), u32(1), u64(8), u32(0), u64(0),
  ]));
  return Buffer.concat([Buffer.from('GGUF'), u32(3), u64(tensors.length), u64(metadata.length), ...metadata, ...tensors]);
}
