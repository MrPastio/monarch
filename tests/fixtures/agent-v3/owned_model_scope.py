"""Closed PUBLIC QA asset whitelist; never discover product models/configuration."""
import hashlib
import json
from pathlib import Path


PROFILES = {
    'astra-v3-live-smollm2-': ('astra-v3-live-smollm2-owned-cpu-only', 'live-model-profile.json', 105454432),
    'astra-v3-live-qwen25-15b-': ('astra-v3-live-qwen25-15b-owned-cpu-only', 'live-qwen25-profile.json', 1117320736),
    'astra-v3-live-gemma4-e4b-': ('astra-v3-live-gemma4-e4b-owned-cpu-only', 'live-gemma4-e4b-profile.json', 5154941280),
}


def admit_owned_model(directory: Path, parent: Path):
    directory = directory.resolve(strict=True)
    parent = parent.resolve(strict=True)
    choice = next((value for prefix, value in PROFILES.items() if directory.name.startswith(prefix)), None)
    if parent.drive.upper() != 'D:' or directory.parent != parent or choice is None:
        raise RuntimeError('fixture-scope')
    marker, profile_name, size = choice
    marker_file = directory / '.fixture-marker'
    if marker_file.resolve(strict=True) != marker_file or marker_file.read_text(encoding='utf-8').strip() != marker:
        raise RuntimeError('fixture-marker')
    profile = json.loads((Path(__file__).parent / profile_name).read_text(encoding='utf-8'))
    model_file = (directory / 'model' / profile['file']).resolve(strict=True)
    if model_file.parent != directory / 'model' or model_file.stat().st_size != size:
        raise RuntimeError('fixture-model-scope')
    with model_file.open('rb') as stream:
        if stream.read(4) != b'GGUF':
            raise RuntimeError('fixture-model-format')
        stream.seek(0)
        actual_digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if actual_digest != profile['sha256']:
        raise RuntimeError('fixture-model-digest')
    return directory, marker, profile, model_file, actual_digest
