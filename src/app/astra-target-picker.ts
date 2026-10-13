import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import type { AstraAuthenticatedHttpActor } from './astra-task-facade';
import { validateAstraSelectedTargetSnapshot, type AstraSelectedTarget } from './astra-source-goal-compiler';
import type { AstraTargetSelectionDescriptor, AstraTargetSelectionStore } from './astra-target-selection-store';

export interface AstraPickerSource { actor: AstraAuthenticatedHttpActor; conversationId: string; epoch: string }
export interface AstraPickerRequest { version: 1; requestId: string; access: AstraSelectedTarget['access'] }
export type AstraPickerResult = { status: 'cancelled' } | { status: 'selected'; selection: AstraTargetSelectionDescriptor };
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(value);
function check(value: unknown, statusCode: number, code: string): asserts value {
  if (!value) throw Object.assign(Error('astra-picker:' + code), { statusCode, code: 'astra-picker-' + code });
}
function selectedTarget(relativePath: string, access: AstraSelectedTarget['access'], maxReadBytes: number,
  maxCreateBytes: number, timeoutMs: number): AstraSelectedTarget {
  const target = { id: 'picked', relativePath, access, maxBytes: access === 'observe' ? maxReadBytes : maxCreateBytes, timeoutMs };
  const principal = { actor: { id: 'sha256:' + '0'.repeat(64), source: 'desktop' as const }, conversationId: 'validation' };
  validateAstraSelectedTargetSnapshot({ ...principal, selectionId: 'validation', revision: 1, targets: [target] }, { ...principal, selectionId: 'validation' });
  check(access !== 'exclusive-create' || !/[\\/]/u.test(relativePath) && relativePath.length <= 255, 409, 'create-leaf-required');
  return target;
}

/** Runtime-side counterpart of the trusted native picker. The selected absolute
 * path is accepted only from the separate host-token HTTP port. */
export function preflightAstraPickedTarget(options: { canonicalRoot: string; selectedPath: string;
  access: AstraSelectedTarget['access']; maxReadBytes: number; maxCreateBytes: number; timeoutMs: number }): AstraSelectedTarget {
  const root = options.canonicalRoot, selected = options.selectedPath;
  check(path.isAbsolute(root) && path.normalize(root) === root, 409, 'canonical-root');
  const rootStat = lstatSync(root);
  check(rootStat.isDirectory() && !rootStat.isSymbolicLink() && realpathSync(root) === root, 409, 'canonical-root');
  check(typeof selected === 'string' && selected.length <= root.length + 1025 && path.isAbsolute(selected)
    && path.normalize(selected) === selected, 400, 'path');
  const relative = path.relative(root, selected);
  check(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep), 403, 'outside-root');
  const target = selectedTarget(relative, options.access, options.maxReadBytes, options.maxCreateBytes, options.timeoutMs), parts = relative.split(path.sep);
  let cursor = root;
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]!); const leaf = index === parts.length - 1;
    try {
      const stat = lstatSync(cursor); check(!stat.isSymbolicLink(), 403, 'reparse-path');
      if (leaf) check(options.access === 'observe' && stat.isFile() && stat.nlink === 1, 409, 'target-not-readable-or-exists');
      else check(stat.isDirectory(), 409, 'parent-not-directory');
    } catch (error) {
      if (leaf && options.access === 'exclusive-create' && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  return target;
}

/** Trusted local producer only. The renderer supplies no path, actor, root or
 * permission. Native dialog returns a path to THIS host, never to the renderer.
 * This bounded preflight is not handle-based hostile filesystem containment;
 * the existing Kernel must still revalidate and authorize every actual effect. */
export class AstraTargetPicker {
  private readonly rootIdentity: string;
  private pending: { identity: string; result: Promise<AstraPickerResult> } | null = null;
  constructor(private readonly options: {
    deployment: 'isolated-validation'; canonicalRoot: string; store: AstraTargetSelectionStore;
    currentSource(): AstraPickerSource;
    choose(access: AstraSelectedTarget['access'], defaultDirectory: string): Promise<string | null>;
    ttlMs: number; maxReadBytes: number; maxCreateBytes: number; timeoutMs: number;
  }) {
    check(options.deployment === 'isolated-validation' && Number.isSafeInteger(options.ttlMs)
      && options.ttlMs >= 1000 && options.ttlMs <= 86400000, 400, 'configuration');
    options.store.assertCanonicalRoot(options.canonicalRoot);
    this.rootIdentity = this.root();
    this.validateTarget('configuration.txt', 'observe'); this.validateTarget('configuration.txt', 'exclusive-create');
  }
  pick(value: unknown, assertCaller: () => void): Promise<AstraPickerResult> {
    try {
      check(typeof assertCaller === 'function', 403, 'caller'); assertCaller();
      const request = this.request(value), source = this.source();
      const identity = JSON.stringify({ request, source });
      if (this.pending) {
        check(this.pending.identity === identity, 409, 'busy');
        // Each joining caller is rechecked when its own reply is delivered.
        return this.pending.result.then(result => { assertCaller(); this.assertSource(source); return structuredClone(result); });
      }
      const result = this.choose(request, source, assertCaller);
      const pending = { identity, result }; this.pending = pending;
      void result.finally(() => { if (this.pending === pending) this.pending = null; }).catch(() => {});
      return result;
    } catch (error) { return Promise.reject(error); }
  }
  private request(value: unknown): AstraPickerRequest {
    check(value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).every(key => ['version', 'requestId', 'access'].includes(key)), 400, 'request');
    const request = value as AstraPickerRequest;
    check(request.version === 1 && id(request.requestId) && ['observe', 'exclusive-create'].includes(request.access), 400, 'request');
    return structuredClone(request);
  }
  private source(): AstraPickerSource {
    const source = structuredClone(this.options.currentSource());
    check(source && Object.keys(source).every(key => ['actor', 'conversationId', 'epoch'].includes(key))
      && id(source.epoch) && id(source.conversationId) && source.actor && source.actor.source === 'desktop'
      && /^sha256:[a-f0-9]{64}$/u.test(source.actor.id)
      && Object.keys(source.actor).every(key => ['id', 'source'].includes(key)), 403, 'source');
    return source;
  }
  private assertSource(source: AstraPickerSource): void {
    check(JSON.stringify(source) === JSON.stringify(this.source()), 409, 'source-changed');
    check(this.root() === this.rootIdentity, 409, 'root-changed');
  }
  private root(): string {
    const root = this.options.canonicalRoot;
    check(path.isAbsolute(root) && realpathSync(root) === root, 409, 'canonical-root');
    const stat = lstatSync(root, { bigint: true }); check(stat.isDirectory() && !stat.isSymbolicLink(), 409, 'canonical-root');
    return String(stat.dev) + ':' + String(stat.ino);
  }
  private validateTarget(relativePath: string, access: AstraSelectedTarget['access']): AstraSelectedTarget {
    return selectedTarget(relativePath, access, this.options.maxReadBytes, this.options.maxCreateBytes, this.options.timeoutMs);
  }
  private preflight(selected: string, access: AstraSelectedTarget['access']): AstraSelectedTarget {
    return preflightAstraPickedTarget({ canonicalRoot: this.options.canonicalRoot, selectedPath: selected, access,
      maxReadBytes: this.options.maxReadBytes, maxCreateBytes: this.options.maxCreateBytes, timeoutMs: this.options.timeoutMs });
  }
  private async choose(request: AstraPickerRequest, source: AstraPickerSource, assertCaller: () => void): Promise<AstraPickerResult> {
    this.assertSource(source);
    const requestId = 'pick_' + createHash('sha256').update(request.requestId).digest('hex').slice(0, 32);
    const { actor, conversationId } = source, principal = { actor, conversationId };
    const old = this.options.store.findIssued(requestId, principal);
    if (old) {
      const selection = this.options.store.list(principal).find(item => item.selectionId === old.selectionId);
      check(selection, 409, 'selection-unavailable');
      check(selection.targets.length === 1 && selection.targets[0]?.access === request.access, 409, 'request-conflict');
      return { status: 'selected', selection };
    }
    const selected = await this.options.choose(request.access, this.options.canonicalRoot);
    assertCaller(); this.assertSource(source);
    if (selected === null) return { status: 'cancelled' };
    const target = this.preflight(selected, request.access);
    assertCaller(); this.assertSource(source);
    const snapshot = this.options.store.issue({ ...principal, requestId, targets: [target], ttlMs: this.options.ttlMs });
    const selection = this.options.store.list(principal).find(item => item.selectionId === snapshot.selectionId);
    check(selection, 409, 'selection-unavailable'); return { status: 'selected', selection };
  }
}
