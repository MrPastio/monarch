import { execFileSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const contractPath = path.join(
  root,
  'assets',
  'voice',
  'reference-provenance.json',
);
const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as {
  schemaVersion: number;
  contractId: string;
  status: string;
  origin: {
    kind: string;
    humanReferenceAudio: boolean;
    voiceCloning: boolean;
  };
  model: {
    repository: string;
    revision: string;
    license: string;
    localPath: string;
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  generationEvidence: {
    sourceContractSha256: string | null;
    generatorSha256: string | null;
    manifestSha256: string | null;
  };
  generation: {
    generator: string;
    language: string;
    referenceText: string;
    stagingDirectory: string;
    settings: Record<string, unknown>;
  };
  voices: Array<{
    id: string;
    description: string;
    seed: number;
    assetPath: string;
    stagingPath: string;
    artifact: {
      status: string;
      sha256: string | null;
      bytes: number | null;
      durationSeconds: number | null;
      sampleRateHz: number | null;
      channels: number;
      sampleWidthBits: number;
    };
  }>;
};

describe('synthetic voice reference provenance', () => {
  it('pins the exact offline VoiceDesign model and synthetic-only origin', () => {
    expect(contract.schemaVersion).toBe(1);
    expect(contract.contractId).toBe(
      'monarch-synthetic-voice-references-v1',
    );
    expect(contract.origin).toEqual({
      kind: 'synthetic-text-and-instruction-only',
      humanReferenceAudio: false,
      voiceCloning: false,
    });
    expect(contract.model).toMatchObject({
      repository: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
      revision: '5ecdb67327fd37bb2e042aab12ff7391903235d3',
      license: 'Apache-2.0',
      localPath: 'runtime/voice/models/qwen3-tts-1.7b-voice-design',
    });
    expect(contract.model.files).toHaveLength(11);
    for (const file of contract.model.files) {
      expect(file.path).not.toMatch(/^[A-Za-z]:|^\//);
      expect(file.bytes).toBeGreaterThan(0);
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('fixes the canonical Russian prompt, descriptions, seeds, and paths', () => {
    expect(contract.generation).toMatchObject({
      generator: 'tools/generate-voice-references.py',
      language: 'Russian',
      referenceText:
        'Привет. Меня зовут Оскар. Я говорю спокойно, уверенно и по делу. ' +
        'Давай вместе найдём точное и надёжное решение.',
      stagingDirectory: 'artifacts/qa/voice-reference-provenance-v1',
    });
    expect(contract.generation.settings).toMatchObject({
      device: 'cuda',
      dtype: 'bfloat16',
      attentionImplementation: 'sdpa',
      deterministicAlgorithms: true,
      allowTf32: false,
    });
    expect(contract.voices.map(({ id, seed }) => ({ id, seed }))).toEqual([
      { id: 'oscar', seed: 2026072901 },
      { id: 'oscar-clear', seed: 2026072902 },
      { id: 'aurora', seed: 2026072903 },
    ]);
    for (const voice of contract.voices) {
      expect(voice.description).toContain('без имитации конкретного человека');
      expect(voice.assetPath).toBe(
        `assets/voice/${voice.id}-reference.wav`,
      );
      expect(voice.stagingPath).toBe(
        `artifacts/qa/voice-reference-provenance-v1/` +
          `${voice.id}-reference.wav`,
      );
    }
  });

  it('keeps output evidence all-pending or all-verified', () => {
    const statuses = new Set(
      contract.voices.map((voice) => voice.artifact.status),
    );
    if (contract.status === 'pending-regeneration') {
      expect(statuses).toEqual(new Set(['pending-generation']));
      expect(contract.generationEvidence).toEqual({
        sourceContractSha256: null,
        generatorSha256: null,
        manifestSha256: null,
      });
      for (const voice of contract.voices) {
        expect(voice.artifact).toMatchObject({
          sha256: null,
          bytes: null,
          durationSeconds: null,
          sampleRateHz: null,
          channels: 1,
          sampleWidthBits: 16,
        });
      }
      return;
    }
    expect(contract.status).toBe('verified');
    expect(statuses).toEqual(new Set(['verified']));
    expect(contract.generationEvidence.sourceContractSha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(contract.generationEvidence.generatorSha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(contract.generationEvidence.manifestSha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    for (const voice of contract.voices) {
      expect(voice.artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(voice.artifact.bytes).toBeGreaterThan(44);
      expect(voice.artifact.durationSeconds).toBeGreaterThan(0);
      expect(voice.artifact.sampleRateHz).toBeGreaterThan(0);
    }
  });

  it('validates the source contract without importing the model runtime', () => {
    const output = execFileSync(
      'python',
      ['tools/generate-voice-references.py', 'verify-contract'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONUTF8: '1',
        },
      },
    );
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      contractId: 'monarch-synthetic-voice-references-v1',
      status: contract.status,
      sourceProjectionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('keeps the canonical source projection stable across promotion fields', () => {
    const probe = [
      'import copy,importlib.util,json,pathlib,sys',
      'path=pathlib.Path(sys.argv[1])',
      'spec=importlib.util.spec_from_file_location("voice_source_probe",path)',
      'module=importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'contract,_=module.load_contract()',
      'before=module.source_contract_digest(contract)',
      'promoted=copy.deepcopy(contract)',
      'promoted["status"]="verified"',
      'promoted["generationEvidence"]={' +
        '"sourceContractSha256":before,"generatorSha256":"2"*64,' +
        '"manifestSha256":"4"*64}',
      'for voice in promoted["voices"]:',
      ' voice["artifact"]={' +
        '"status":"verified","sha256":"3"*64,"bytes":100,' +
        '"durationSeconds":1.0,"sampleRateHz":24000,' +
        '"channels":1,"sampleWidthBits":16}',
      'after=module.source_contract_digest(promoted)',
      'print(json.dumps({"before":before,"after":after,' +
        '"projection":module.source_contract_projection(promoted)},' +
        'ensure_ascii=False,separators=(",",":")))',
    ].join('\n');
    const output = execFileSync(
      'python',
      ['-c', probe, 'tools/generate-voice-references.py'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONUTF8: '1',
        },
      },
    );
    const parsed = JSON.parse(output) as {
      before: string;
      after: string;
      projection: { projectionId: string };
    };
    expect(parsed.before).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.after).toBe(parsed.before);
    expect(parsed.projection.projectionId).toBe(
      'monarch-voice-generation-source-v1',
    );
  });

  it('keeps the Sharing voice-clone transcript aligned with the contract', () => {
    const extractor = [
      'import ast,json,pathlib,sys',
      'tree=ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))',
      'values={target.id:ast.literal_eval(node.value) for node in tree.body' +
        ' if isinstance(node,ast.Assign) for target in node.targets' +
        ' if isinstance(target,ast.Name) and target.id=="REFERENCE_TEXT"}',
      'print(json.dumps(values,ensure_ascii=False,separators=(",",":")))',
    ].join(';');
    const output = execFileSync(
      'python',
      ['-c', extractor, 'tools/sharing-tts-worker.py'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONUTF8: '1',
        },
      },
    );
    expect(JSON.parse(output)).toEqual({
      REFERENCE_TEXT: contract.generation.referenceText,
    });
  });

  it('binds manifest voices to exact source digests without model imports', () => {
    const probe = [
      'import importlib.util,json,pathlib,sys',
      'path=pathlib.Path(sys.argv[1])',
      'spec=importlib.util.spec_from_file_location("voice_provenance_probe",path)',
      'module=importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'contract,_=module.load_contract()',
      'artifact={"status":"verified","sha256":"3"*64,"bytes":100,' +
        '"durationSeconds":1.0,"sampleRateHz":24000,"channels":1,' +
        '"sampleWidthBits":16}',
      'files=[{"path":p,"bytes":s,"sha256":h}' +
        ' for p,s,h in module.PINNED_MODEL_FILES]',
      'rendered=[(voice,b"",artifact.copy()) for voice in module.VOICE_SPECS]',
      'manifest=module.build_generation_manifest(' +
        'contract,files,"1"*64,"2"*64,rendered)',
      'module.validate_generation_manifest_payload(' +
        'contract,manifest,source_contract_sha256="1"*64,' +
        'generator_sha256="2"*64,require_contract_artifacts=False)',
      'manifest["voices"][0]["seed"]+=1',
      'rejected=False',
      'try:',
      ' module.validate_generation_manifest_payload(' +
        'contract,manifest,source_contract_sha256="1"*64,' +
        'generator_sha256="2"*64,require_contract_artifacts=False)',
      'except RuntimeError:',
      ' rejected=True',
      'manifest["voices"][0]["seed"]-=1',
      'print(json.dumps({"source":manifest["source"],' +
        '"description":manifest["voices"][0]["description"],' +
        '"seed":manifest["voices"][0]["seed"],"rejected":rejected},' +
        'ensure_ascii=False,separators=(",",":")))',
    ].join('\n');
    const output = execFileSync(
      'python',
      ['-c', probe, 'tools/generate-voice-references.py'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONUTF8: '1',
        },
      },
    );
    expect(JSON.parse(output)).toEqual({
      source: {
        contract: {
          path:
            'assets/voice/reference-provenance.json#' +
            'generation-source-v1',
          projectionId: 'monarch-voice-generation-source-v1',
          sha256: '1'.repeat(64),
        },
        generator: {
          path: 'tools/generate-voice-references.py',
          sha256: '2'.repeat(64),
        },
      },
      description: contract.voices[0].description,
      seed: contract.voices[0].seed,
      rejected: true,
    });
  });

  it('rejects hardlinks and Windows alternate data streams', () => {
    const qaRoot = path.join(root, 'artifacts', 'qa');
    mkdirSync(qaRoot, { recursive: true });
    const temporaryRoot = mkdtempSync(
      path.join(qaRoot, 'voice-file-policy-'),
    );
    const probeScript = [
      'import importlib.util,json,pathlib,sys',
      'module_path=pathlib.Path(sys.argv[1])',
      'spec=importlib.util.spec_from_file_location(' +
        '"voice_provenance_file_probe",module_path)',
      'module=importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'try:',
      ' module.verify_regular_file_identity(' +
        'pathlib.Path(sys.argv[2]),label="probe")',
      'except Exception as error:',
      ' print(json.dumps({"ok":False,"error":str(error)}))',
      ' raise SystemExit(3)',
      'print(\'{"ok":true}\')',
    ].join('\n');
    const runProbe = (target: string) =>
      execFileSync(
        'python',
        [
          '-c',
          probeScript,
          'tools/generate-voice-references.py',
          target,
        ],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PYTHONDONTWRITEBYTECODE: '1',
            PYTHONUTF8: '1',
          },
        },
      );
    try {
      const hardlinkTarget = path.join(temporaryRoot, 'hardlink-source.bin');
      const hardlinkAlias = path.join(temporaryRoot, 'hardlink-alias.bin');
      writeFileSync(hardlinkTarget, 'voice-policy-probe');
      expect(JSON.parse(runProbe(hardlinkTarget))).toEqual({ ok: true });
      linkSync(hardlinkTarget, hardlinkAlias);
      expect(() => runProbe(hardlinkTarget)).toThrow();

      if (process.platform === 'win32') {
        const adsTarget = path.join(temporaryRoot, 'ads-source.bin');
        writeFileSync(adsTarget, 'voice-policy-probe');
        expect(JSON.parse(runProbe(adsTarget))).toEqual({ ok: true });
        writeFileSync(`${adsTarget}:monarch-provenance-test`, 'blocked');
        expect(() => runProbe(adsTarget)).toThrow();
      }
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('creates outputs exclusively and never overwrites an existing path', () => {
    const qaRoot = path.join(root, 'artifacts', 'qa');
    mkdirSync(qaRoot, { recursive: true });
    const temporaryRoot = mkdtempSync(
      path.join(qaRoot, 'voice-exclusive-output-'),
    );
    const target = path.join(temporaryRoot, 'output.bin');
    const probe = [
      'import importlib.util,json,pathlib,sys',
      'module_path=pathlib.Path(sys.argv[1])',
      'target=pathlib.Path(sys.argv[2])',
      'spec=importlib.util.spec_from_file_location(' +
        '"voice_exclusive_probe",module_path)',
      'module=importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'module.exclusive_write_bytes(target,b"first",label="probe")',
      'rejected=False',
      'try:',
      ' module.exclusive_write_bytes(target,b"second",label="probe")',
      'except FileExistsError:',
      ' rejected=True',
      'print(json.dumps({"rejected":rejected,' +
        '"content":target.read_text(encoding="ascii")}))',
    ].join('\n');
    try {
      const output = execFileSync(
        'python',
        [
          '-c',
          probe,
          'tools/generate-voice-references.py',
          target,
        ],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PYTHONDONTWRITEBYTECODE: '1',
            PYTHONUTF8: '1',
          },
        },
      );
      expect(JSON.parse(output)).toEqual({
        rejected: true,
        content: 'first',
      });
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('documents authoritative WAV hashes and version-specific licenses', () => {
    const provenance = readFileSync(
      path.join(root, 'assets', 'voice', 'PROVENANCE.md'),
      'utf8',
    );
    expect(provenance).toContain(
      'SHA-256 of each reviewed promoted WAV is the authoritative release identity',
    );
    expect(provenance).toContain(
      'They do not promise bit-identical output across',
    );
    const notices = readFileSync(
      path.join(root, 'docs', 'THIRD_PARTY_NOTICES.md'),
      'utf8',
    );
    expect(notices).toContain(
      'https://pypi.org/project/faster-qwen3-tts/0.3.0/',
    );
    expect(notices).toContain(
      'https://github.com/andimarafioti/faster-qwen3-tts/blob/v0.3.0/LICENSE',
    );
    expect(notices).toContain(
      'https://pypi.org/project/qwen-tts/0.1.1/',
    );
    expect(notices).toContain(
      'https://github.com/QwenLM/Qwen3-TTS/blob/' +
        '6cafe5582caea83df269c36b1ce62d953a9cc66b/LICENSE',
    );
  });

  it('has no path override, download, or voice-cloning generation surface', () => {
    const generator = readFileSync(
      path.join(root, 'tools', 'generate-voice-references.py'),
      'utf8',
    );
    expect(generator).not.toContain('add_argument("--model');
    expect(generator).not.toContain('add_argument("--output');
    expect(generator).not.toContain('snapshot_download');
    expect(generator).not.toContain('hf_hub_download');
    expect(generator).not.toContain('generate_voice_clone');
    expect(generator).toContain('local_files_only=True');
    expect(generator).toContain('HF_HUB_OFFLINE');
    expect(generator).toContain('os.O_EXCL');
    const releaseGate = readFileSync(
      path.join(root, 'tests', 'release', 'voice-reference-release-gate.test.ts'),
      'utf8',
    );
    expect(releaseGate).toContain("'verify-release'");
    expect(releaseGate).not.toContain("'verify-assets'");
  });

  it('pins exact provenance bytes to LF across Windows checkouts', () => {
    const attributes = readFileSync(path.join(root, '.gitattributes'), 'utf8');
    expect(attributes).toContain(
      '/assets/voice/generation-manifest.json text eol=lf',
    );
    expect(attributes).toContain(
      '/assets/voice/reference-provenance.json text eol=lf',
    );
    expect(attributes).toContain(
      '/tools/generate-voice-references.py text eol=lf',
    );
  });

  it('fails Sharing closed before model import when provenance is unverified', () => {
    const worker = readFileSync(
      path.join(root, 'tools', 'sharing-tts-worker.py'),
      'utf8',
    );
    expect(worker).toContain('verified_reference_record');
    expect(worker).toContain('contract.get("status") != "verified"');
    expect(worker).toContain(
      'contract_file_sha256=contract_file_sha256',
    );
    expect(
      worker.indexOf(
        'release_verifier, release_contract = verify_installed_voice_release(',
      ),
    ).toBeLessThan(worker.indexOf('import torch'));
    expect(worker).toContain('HF_HUB_OFFLINE');
    expect(worker).toContain('TRANSFORMERS_OFFLINE');
    expect(worker).toContain('exclusive_write_bytes');
    expect(worker).toContain('create_private_reference_snapshot');
    expect(worker).toContain('reconcile_private_reference');
    expect(worker).toContain('"bytes": output_bytes');
    expect(worker).toContain('"sha256": output_sha256');
    expect(worker).toContain(
      'model_dir, mode, request = resolve_request(args)',
    );
  });

  it('keeps model checks lexical and reconciles path-backed model use', () => {
    const generator = readFileSync(
      path.join(root, 'tools', 'generate-voice-references.py'),
      'utf8',
    );
    const worker = readFileSync(
      path.join(root, 'tools', 'sharing-tts-worker.py'),
      'utf8',
    );
    expect(generator).toContain('def verify_lexical_path(');
    expect(generator).toContain(
      'model_root = verify_directory_identity(',
    );
    expect(generator).toContain('def measure_bound_regular_file(');
    expect(generator).toContain(
      'actual_size, actual_sha256 = measure_bound_regular_file(',
    );
    expect(generator).toContain('def reconcile_model_evidence(');
    const generationBody = generator.slice(generator.indexOf('def generate('));
    expect(
      generationBody.match(/reconcile_model_evidence\(/g),
    ).toHaveLength(3);
    expect(generationBody.indexOf('phase="before model load"')).toBeLessThan(
      generationBody.indexOf('FasterQwen3TTS.from_pretrained('),
    );
    expect(generationBody.indexOf('phase="during model load"')).toBeGreaterThan(
      generationBody.indexOf('FasterQwen3TTS.from_pretrained('),
    );
    expect(worker).toContain('def verify_lexical_path(');
    expect(worker).toContain('capture_model_tree_identity(model_dir)');
  });

  it('binds and cleans the private Sharing reference snapshot', () => {
    const qaRoot = path.join(root, 'artifacts', 'qa');
    mkdirSync(qaRoot, { recursive: true });
    const temporaryRoot = mkdtempSync(
      path.join(qaRoot, 'sharing-reference-snapshot-'),
    );
    const probe = [
      'import importlib.util,io,json,pathlib,sys,wave',
      'path=pathlib.Path(sys.argv[1])',
      'directory=pathlib.Path(sys.argv[2])',
      'spec=importlib.util.spec_from_file_location("sharing_snapshot_probe",path)',
      'module=importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'buffer=io.BytesIO()',
      'with wave.open(buffer,"wb") as stream:',
      ' stream.setnchannels(1)',
      ' stream.setsampwidth(2)',
      ' stream.setframerate(24000)',
      ' stream.writeframes(b"\\0\\0"*24)',
      'payload=buffer.getvalue()',
      'artifact={"bytes":len(payload),' +
        '"sha256":module.hashlib.sha256(payload).hexdigest(),' +
        '"durationSeconds":24/24000,"sampleRateHz":24000,' +
        '"channels":1,"sampleWidthBits":16}',
      'target,descriptor,identity=module.create_private_reference_snapshot(' +
        'directory,payload,artifact,voice_id="probe")',
      'module.reconcile_private_reference(' +
        'target,descriptor,identity,artifact,label="probe")',
      'module.cleanup_private_reference(target,descriptor,identity)',
      'module.PROTOCOL_STDOUT.write(json.dumps({' +
        '"removed":not target.exists()},separators=(",",":")))',
    ].join('\n');
    try {
      const output = execFileSync(
        'python',
        ['-c', probe, 'tools/sharing-tts-worker.py', temporaryRoot],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PYTHONDONTWRITEBYTECODE: '1',
            PYTHONUTF8: '1',
          },
        },
      );
      expect(JSON.parse(output)).toEqual({ removed: true });
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('makes Sharing reference use follow the current verified state', () => {
    const probe = [
      'import importlib.util,json,pathlib,sys',
      'path=pathlib.Path(sys.argv[1])',
      'spec=importlib.util.spec_from_file_location("sharing_voice_probe",path)',
      'module=importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'try:',
      ' target=module.verify_installed_reference(' +
        'pathlib.Path(sys.argv[2]).resolve(),"oscar")',
      ' result={"ok":True,"target":target.as_posix()}',
      'except Exception as error:',
      ' result={"ok":False,"error":str(error)}',
      'module.PROTOCOL_STDOUT.write(json.dumps(result,separators=(",",":")))',
    ].join('\n');
    const output = execFileSync(
      'python',
      ['-c', probe, 'tools/sharing-tts-worker.py', root],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONUTF8: '1',
        },
      },
    );
    const result = JSON.parse(output) as {
      ok: boolean;
      target?: string;
      error?: string;
    };
    if (contract.status === 'pending-regeneration') {
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining('not verified'),
      });
      return;
    }
    expect(result, result.error || 'Sharing reference verification failed without an error').toMatchObject({
      ok: true,
      target: expect.stringMatching(
        /[\\/]assets[\\/]voice[\\/]oscar-reference\.wav$/,
      ),
    });
  });

  it('makes the Sharing WAV writer preserve an occupied target', () => {
    const qaRoot = path.join(root, 'artifacts', 'qa');
    mkdirSync(qaRoot, { recursive: true });
    const temporaryRoot = mkdtempSync(
      path.join(qaRoot, 'sharing-exclusive-output-'),
    );
    const target = path.join(temporaryRoot, 'output.wav');
    writeFileSync(target, 'occupied');
    const probe = [
      'import importlib.util,json,pathlib,sys',
      'path=pathlib.Path(sys.argv[1])',
      'target=pathlib.Path(sys.argv[2])',
      'spec=importlib.util.spec_from_file_location("sharing_output_probe",path)',
      'module=importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'rejected=False',
      'try:',
      ' module.exclusive_write_bytes(target,b"replacement",label="probe")',
      'except FileExistsError:',
      ' rejected=True',
      'module.PROTOCOL_STDOUT.write(json.dumps({' +
        '"rejected":rejected,' +
        '"content":target.read_text(encoding="ascii")},' +
        'separators=(",",":")))',
    ].join('\n');
    try {
      const output = execFileSync(
        'python',
        ['-c', probe, 'tools/sharing-tts-worker.py', target],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PYTHONDONTWRITEBYTECODE: '1',
            PYTHONUTF8: '1',
          },
        },
      );
      expect(JSON.parse(output)).toEqual({
        rejected: true,
        content: 'occupied',
      });
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
