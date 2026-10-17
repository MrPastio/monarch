"""Disposable Memory V4 HTTP fixture. Never imports production main globals."""
import json
import sys
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "oscar" / "backend"))
from oscar_agent.config import Settings
from oscar_agent.memory import MemoryStore
from oscar_agent.context_settings import ContextSettingsStore
from oscar_agent.memory_v4 import MemoryV4Service
from oscar_agent.conversation_messages import append_conversation_message
from oscar_agent.schemas import ConversationMessageCreate

root = Path(sys.argv[1]).resolve(strict=True)
parent = Path(".test-tmp").resolve(strict=True)
marker = "astra-v3-memory-server-synthetic-only"
if root.parent != parent or parent.drive.upper() != "D:" or not root.name.startswith("astra-v3-memory-"):
    raise RuntimeError("owned-memory-fixture-required")
if (root / ".fixture-marker").read_text(encoding="utf-8") != marker:
    raise RuntimeError("fixture-marker-required")
settings = Settings(data_dir=root / "data", db_path=root / "data" / "memory.sqlite3",
                    offload_dir=root / "offload", workspace_root=root / "workspace",
                    workspace_generated_dir=root / "workspace" / "generated",
                    gemma_models_dir=root / "models", coder_models_dir=root / "coder-models",
                    memory_embedding_model_dir=root / "missing-embedding", mock_model=True)
memory = MemoryStore(settings)
context = ContextSettingsStore(settings)
service = MemoryV4Service(settings)
receipt = context.execute(client_request_id="synthetic-seed", command="memory.create", scope={"type": "chat"},
                          expected_revision=0, payload={"text": "syntheticneedle use concise answers", "category": "rule"},
                          policy_decision_hash="b" * 64)
item_id = receipt["result"]["record"]["id"]
retrieval_count = 0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        global retrieval_count
        if self.headers.get("X-Oscar-Token") != "synthetic-memory-only":
            self.send_error(401)
            return
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 < size <= 16384:
            self.send_error(400)
            return
        request = json.loads(self.rfile.read(size))
        if self.path == "/api/memory/context":
            retrieval_count += 1
            result = service.retrieve(request["query"], request["scope"])
        elif self.path == "/api/memory/context/validity":
            result = service.read_context_validity(request["scope"])
        elif self.path == "/fixture/delete":
            result = context.execute(client_request_id="synthetic-delete", command="memory.delete", scope={"type": "chat"},
                                     expected_revision=1, payload={"id": item_id}, policy_decision_hash="b" * 64)
        elif self.path == "/fixture/metrics":
            result = {"retrievals": retrieval_count}
        elif self.path.startswith("/api/conversations/") and self.path.endswith("/messages"):
            conversation_id = self.path.split("/")[3]
            result = append_conversation_message(memory, conversation_id, ConversationMessageCreate.model_validate(request))
        else:
            self.send_error(404)
            return
        body = json.dumps(result).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(json.dumps({"endpoint": f"http://127.0.0.1:{server.server_port}", "marker": marker}), flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
    service.close()
