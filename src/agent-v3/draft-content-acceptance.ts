import { createHash } from 'node:crypto';
import { modelReadCheck as check, modelReadDigest as digest } from './model-read-task-state';

/** Supplied only by the trusted source admission port, never parsed from model
 * claims or inferred from natural-language text. If the source already has the
 * complete literal bytes, prefer the existing model-free create profile instead. */
export interface AstraDraftContentRequirement { kind: 'exact-utf8'; bytes: number; contentDigest: string }
export interface AstraDraftContentAcceptance {
  kind: 'exact-utf8'; requirementDigest: string; status: 'matched' | 'mismatched' | 'not-proposed';
  expected: { bytes: number; contentDigest: string }; actual?: { bytes: number; contentDigest: string };
}
export function astraDraftContentFingerprint(content: string): { bytes: number; contentDigest: string } {
  return { bytes: Buffer.byteLength(content, 'utf8'), contentDigest: 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex') };
}
export function validateAstraDraftContentRequirement(value: AstraDraftContentRequirement, maximum: number): void {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 3
    && Object.keys(value).every(key => ['kind', 'bytes', 'contentDigest'].includes(key)) && value.kind === 'exact-utf8'
    && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes <= maximum
    && typeof value.contentDigest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value.contentDigest), 'draft-content-requirement');
}
/** No I/O, model, normalization, repair or execution. The family certifier calls
 * this again over retained output; a successful comparison alone proves no write. */
export function inspectAstraDraftContent(requirement: AstraDraftContentRequirement, content?: string): AstraDraftContentAcceptance {
  validateAstraDraftContentRequirement(requirement, 16384);
  const expected = { bytes: requirement.bytes, contentDigest: requirement.contentDigest }, actual = content === undefined ? undefined : astraDraftContentFingerprint(content);
  return { kind: 'exact-utf8', requirementDigest: digest(requirement), expected,
    status: !actual ? 'not-proposed' : actual.bytes === expected.bytes && actual.contentDigest === expected.contentDigest ? 'matched' : 'mismatched',
    ...(actual ? { actual } : {}) };
}
