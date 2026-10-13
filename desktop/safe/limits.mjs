export const MAX_SAFE_FILE_BYTES = 256 * 1024 * 1024;

export async function readBoundedImport(file) {
  if (!Number.isSafeInteger(file?.size) || file.size < 0 || file.size > MAX_SAFE_FILE_BYTES) {
    throw new Error('Файл превышает лимит Safe: 256 МиБ.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size || bytes.byteLength > MAX_SAFE_FILE_BYTES) {
    bytes.fill(0);
    throw new Error('Размер файла изменился во время чтения.');
  }
  return bytes;
}
