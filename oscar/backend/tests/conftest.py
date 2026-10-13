from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


# oscar_agent.config resolves its roots at import time, and oscar_agent.main
# builds a MemoryStore/MemoryV4Service against them while the module is being
# imported. Several suites import main, so without this redirection the test
# run reads and writes the owner's real chat database under oscar/data -- it
# has created conversations there, and the memory retention migration would
# run against live data. Point every writable root at a throwaway directory
# before the first oscar_agent import; an explicit root from the environment
# still wins, so CI and the owner can aim the suite somewhere on purpose.
_SANDBOX = Path(tempfile.mkdtemp(prefix="monarch-backend-tests-"))
for _variable, _subdirectory in (
    ("MONARCH_DATA_ROOT", "data"),
    ("MONARCH_PAYLOAD_ROOT", "payload"),
    ("MONARCH_GENERATED_ROOT", "generated"),
    ("MONARCH_WORKSPACE_ROOT", "workspace"),
    ("MONARCH_RUNTIME_ROOT", "runtime"),
    ("MONARCH_SECRETS_ROOT", "secrets"),
):
    if not os.getenv(_variable, "").strip():
        _root = _SANDBOX / _subdirectory
        _root.mkdir(parents=True, exist_ok=True)
        os.environ[_variable] = str(_root)

# The MONARCH_* roots alone are not enough on a developer machine: oscar/.env
# pins OSCAR_DB_PATH and OSCAR_OFFLOAD_DIR to the installed data directory and
# pydantic-settings applies that file to every Settings(). Moving the config
# root moves the .env lookup with it, so the suite reads no developer-specific
# overrides at all and each setting falls back to the sandbox roots above.
# Overriding the individual OSCAR_* variables instead would leak into tests
# that reload the config module to assert how the roots resolve.
if not os.getenv("MONARCH_CONFIG_ROOT", "").strip():
    _config_root = _SANDBOX / "config"
    (_config_root / "config" / "oscar").mkdir(parents=True, exist_ok=True)
    os.environ["MONARCH_CONFIG_ROOT"] = str(_config_root)

assert "oscar_agent.config" not in sys.modules, (
    "oscar_agent was imported before the test sandbox roots were set"
)
