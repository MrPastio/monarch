let sequence = 0;

export function nowIso(): string {
  return new Date().toISOString();
}

export function createMonarchId(prefix: string): string {
  sequence += 1;
  const time = Date.now().toString(36);
  const serial = sequence.toString(36).padStart(4, '0');
  return `${prefix}_${time}_${serial}`;
}

export function normalizeId(value: string): string {
  return String(value || '').trim();
}

export function normalizeText(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

