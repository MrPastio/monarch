"""Opt-in synthetic Astra host using the production pinned Fast resident.

No model discovery, user settings/history, fallback or public listener.
"""
import asyncio
import json
import os
from pathlib import Path
import socket
import sys

repository = Path(__file__).resolve().parents[3]
directory = Path(sys.argv[1]).resolve(strict=True)
parent = (repository / '.test-tmp').resolve(strict=True)
if parent != Path('D:/Monarch-test-tmp-astra-v3') or directory.parent != parent:
    raise RuntimeError('recovery-prepared-root')
if not directory.name.startswith(('agent-recovery-draft-', 'astra-v3-oscar-recovery-')) or (directory / '.owner').read_text() != 'monarch-synthetic-draft-v1':
    raise RuntimeError('recovery-prepared-marker')
for key in list(os.environ):
    if key.startswith(('OSCAR_', 'MONARCH_')):
        del os.environ[key]
os.environ['TEMP'] = os.environ['TMP'] = str(directory)
sys.path.insert(0, str(repository / 'oscar/backend'))
from oscar_agent.config import Settings
from oscar_agent.model_runtime import LocalModelRuntime
from oscar_agent.astra_asset_pin import AstraAssetExpectation
from oscar_agent.astra_prepared_driver import AstraResidentDriverProvider
from oscar_agent.astra_model_host import AstraPreparedModelHost
from oscar_agent.astra_model_http import create_astra_model_router
from oscar_agent.inference_coordinator import InferenceCoordinator
from fastapi import FastAPI, Header, HTTPException, Depends
import uvicorn

model = Path('E:/MonarchData/models/gemma_models/Gemma_E2B/gemma-4-E2B-it-Q5_K_M.gguf')
asset = AstraAssetExpectation(root=model.parent, candidate=model, size=3356035200,
    digest='sha256:d8fc2ac6fd597481dfd9c5ef9543ea1f0bda8088086da3853ce5e5564ab43bf8')
settings = Settings(_env_file=None, api_token=None, model_path=model, gemma_models_dir=model.parent,
    data_dir=directory / 'data', db_path=directory / 'unused.sqlite', offload_dir=directory / 'offload',
    qwen_models_dir=directory / 'unused-qwen', coder_models_dir=directory / 'unused-coder',
    memory_embedding_model_dir=directory / 'unused-embedding', workspace_root=directory,
    workspace_generated_dir=directory / 'generated', mock_model=False, mock_fallback=False,
    gemma_speculative_decoding=False, gemma4_fast_context_tokens=4096, suppress_llama_logs=True)
runtime = LocalModelRuntime(settings)
provider = AstraResidentDriverProvider(runtime)
coordinator = None
calls = 0
driver = None

def resident(_expected_digest):
    global driver
    runtime.load_tier('gemma4-fast', allow_fallback=False, astra_asset=asset)
    if driver is None:
        driver = provider()
        generate = driver.generate
        def measured(*args):
            global calls
            calls += 1
            if calls > 2:
                raise RuntimeError('recovery-generation-budget')
            return generate(*args)
        driver.generate = measured
    return provider()

def shared():
    global coordinator
    if coordinator is None:
        coordinator = InferenceCoordinator(asyncio.Lock())
    return coordinator

async def authenticate(authorization: str = Header(default='')):
    if authorization != 'Bearer synthetic-draft-recovery':
        raise HTTPException(401)
    return 'synthetic_draft'

host = AstraPreparedModelHost(deployment='isolated-validation', coordinator=shared,
    resident_driver=resident, admitted_model_digest=asset.digest)
app = FastAPI()
app.include_router(create_astra_model_router(host, authenticate=authenticate))

@app.get('/metrics', dependencies=[Depends(authenticate)])
async def metrics():
    return dict(calls=calls, tier=runtime.active_tier, mock=settings.mock_model,
        fallback=runtime.fallback_active, slotReserved=shared().locked())

listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen(8)
print(json.dumps(dict(endpoint='http://127.0.0.1:' + str(listener.getsockname()[1]),
    hostGeneration=host.host_generation, modelDigest=asset.digest)), flush=True)
try:
    uvicorn.Server(uvicorn.Config(app, log_level='critical', access_log=False)).run(sockets=[listener])
finally:
    if coordinator is None or not coordinator.locked():
        runtime.unload()
