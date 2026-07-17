import {
  VOICE_MODE_PROFILE_MODEL_NAMES,
  VOICE_MODE_PROFILE_METADATA,
  VoiceModeRuntimeError,
  VoiceProfileRuntime,
  type VoiceModeProfile,
  type VoiceProfilePrepareResult,
  type VoiceProfileRespondResult,
  type VoiceProfileRuntimeOptions,
  type VoiceProfileRuntimePort,
  type VoiceProfileRuntimeSnapshot,
} from './voice-lite-runtime';
import { classifyVoiceModeCommand, voiceModeLocalProfile } from './voice-mode';

const RESIDENT_PROFILES: readonly VoiceModeProfile[] = ['lite'];

export interface VoiceModePrepareInput {
  profiles?: Array<'lite'>;
}

export interface VoiceModeRespondInput {
  profile: VoiceModeProfile;
  text: string;
}

export interface VoiceModePrepareResult {
  status: 'ready';
  backend: 'llama-cpp-cpu';
  profiles: VoiceProfilePrepareResult[];
}

export interface VoiceModeReleaseResult {
  status: 'released';
  profiles: VoiceModeProfile[];
}

export interface VoiceModeManagerSnapshot {
  backend: 'llama-cpp-cpu';
  profiles: Record<VoiceModeProfile, VoiceProfileRuntimeSnapshot>;
}

export interface VoiceModeModelManagerPort {
  prepare(input?: unknown): Promise<VoiceModePrepareResult>;
  respond(input: unknown): Promise<VoiceProfileRespondResult>;
  release(input?: unknown): Promise<VoiceModeReleaseResult>;
  shutdown(): Promise<void>;
  snapshot(): VoiceModeManagerSnapshot;
}

export interface VoiceModeModelManagerOptions {
  workspaceRoot?: string;
  executable?: string;
  workerScriptPath?: string;
  requestTimeoutMs?: number;
  runtimeFactory?: (profile: VoiceModeProfile) => VoiceProfileRuntimePort;
}

/** Owns at most one lazy persistent CPU worker: the fixed Lite profile. */
export class VoiceModeModelManager implements VoiceModeModelManagerPort {
  private readonly options: VoiceModeModelManagerOptions;
  private readonly runtimes = new Map<VoiceModeProfile, VoiceProfileRuntimePort>();

  constructor(options: VoiceModeModelManagerOptions = {}) {
    this.options = options;
  }

  async prepare(input: unknown = {}): Promise<VoiceModePrepareResult> {
    const profiles = readPrepareProfiles(input);
    const prepared = await Promise.all(
      profiles.map((profile) => this.runtime(profile).prepare()),
    );
    return {
      status: 'ready',
      backend: 'llama-cpp-cpu',
      profiles: prepared,
    };
  }

  async respond(input: unknown): Promise<VoiceProfileRespondResult> {
    const request = readRespondInput(input);
    const routedProfile = voiceModeLocalProfile(classifyVoiceModeCommand(request.text));
    if (routedProfile !== request.profile) {
      throw new VoiceModeRuntimeError(
        'voice-mode-profile-route-mismatch',
        routedProfile
          ? `Voice request belongs to the ${routedProfile} profile.`
          : 'Voice request is not eligible for a local model profile.',
      );
    }
    // Micro used to keep a second GGUF worker resident for tiny social turns.
    // Preserve the wire contract while serving that legacy lane through the
    // single lazy Lite worker; Voice Mode must never allocate both workers.
    const runtimeProfile: VoiceModeProfile = request.profile === 'micro' ? 'lite' : request.profile;
    return this.runtime(runtimeProfile).respond({ text: request.text });
  }

  async release(input: unknown = {}): Promise<VoiceModeReleaseResult> {
    const profiles = readResidentProfiles(input, 'release');
    const released: VoiceModeProfile[] = [];
    for (const profile of profiles) {
      const runtime = this.runtimes.get(profile);
      if (!runtime) continue;
      await runtime.shutdown();
      if (this.runtimes.get(profile) === runtime) this.runtimes.delete(profile);
      released.push(profile);
    }
    return { status: 'released', profiles: released };
  }

  async shutdown(): Promise<void> {
    const runtimes = Array.from(this.runtimes.values());
    await Promise.allSettled(runtimes.map((runtime) => runtime.shutdown()));
    this.runtimes.clear();
  }

  snapshot(): VoiceModeManagerSnapshot {
    return {
      backend: 'llama-cpp-cpu',
      profiles: {
        micro: this.runtimes.get('micro')?.snapshot() || idleSnapshot('micro'),
        lite: this.runtimes.get('lite')?.snapshot() || idleSnapshot('lite'),
      },
    };
  }

  private runtime(profile: VoiceModeProfile): VoiceProfileRuntimePort {
    const existing = this.runtimes.get(profile);
    if (existing) return existing;

    const runtime = this.options.runtimeFactory
      ? this.options.runtimeFactory(profile)
      : new VoiceProfileRuntime(runtimeOptions(profile, this.options));
    this.runtimes.set(profile, runtime);
    return runtime;
  }
}

function runtimeOptions(
  profile: VoiceModeProfile,
  options: VoiceModeModelManagerOptions,
): VoiceProfileRuntimeOptions {
  return {
    profile,
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    ...(options.executable ? { executable: options.executable } : {}),
    ...(options.workerScriptPath ? { workerScriptPath: options.workerScriptPath } : {}),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
  };
}

function readPrepareProfiles(input: unknown): VoiceModeProfile[] {
  return readResidentProfiles(input, 'prepare');
}

function readResidentProfiles(input: unknown, operation: 'prepare' | 'release'): VoiceModeProfile[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new VoiceModeRuntimeError(
      `voice-mode-${operation}-invalid`,
      `Voice mode ${operation} input must be an object.`,
    );
  }
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'profiles')) {
    throw new VoiceModeRuntimeError(
      `voice-mode-${operation}-invalid`,
      `Voice mode ${operation} accepts only the profiles field.`,
    );
  }
  const value = record.profiles;
  if (value === undefined) return operation === 'release' ? [...RESIDENT_PROFILES] : [];
  if (!Array.isArray(value) || value.length === 0 || value.length > RESIDENT_PROFILES.length) {
    throw new VoiceModeRuntimeError(
      `voice-mode-${operation}-invalid`,
      'Voice mode resident profiles may contain only lite.',
    );
  }
  const profiles: VoiceModeProfile[] = [];
  for (const profile of value) {
    if (profile !== 'lite' || profiles.includes(profile)) {
      throw new VoiceModeRuntimeError(
        'voice-mode-profile-invalid',
        'Only the lazy Lite profile may be prepared or released.',
      );
    }
    profiles.push(profile);
  }
  return profiles;
}

function readRespondInput(input: unknown): VoiceModeRespondInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new VoiceModeRuntimeError(
      'voice-mode-input-invalid',
      'Voice mode response input must be an object.',
    );
  }
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'profile' && key !== 'text')) {
    throw new VoiceModeRuntimeError(
      'voice-mode-input-invalid',
      'Voice mode response accepts only profile and text.',
    );
  }
  if (!isProfile(record.profile)) {
    throw new VoiceModeRuntimeError(
      'voice-mode-profile-invalid',
      'Voice mode response requires the micro or lite profile.',
    );
  }
  return {
    profile: record.profile,
    text: typeof record.text === 'string' ? record.text : '',
  };
}

function idleSnapshot(profile: VoiceModeProfile): VoiceProfileRuntimeSnapshot {
  const metadata = VOICE_MODE_PROFILE_METADATA[profile];
  return {
    state: 'idle',
    profile,
    backend: 'llama-cpp-cpu',
    model: VOICE_MODE_PROFILE_MODEL_NAMES[profile],
    repository: metadata.repository,
    license: metadata.license,
    sha256: metadata.sha256,
  };
}

function isProfile(value: unknown): value is VoiceModeProfile {
  return value === 'micro' || value === 'lite';
}
