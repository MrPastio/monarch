"""Synthetic-only HTTP shell around the REAL conversation schema/service/SQLite.

Never imports oscar_agent.main or constructs Settings (which can discover tokens).
This shell is not product bootstrap, discovery, authentication or UI acceptance.
"""
import json
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

REPO = Path(__file__).resolve().parents[3]
root = Path(sys.argv[1])
parent = (REPO / ".test-tmp").resolve(strict=True)
if (root != root.resolve(strict=True) or root.parent != parent or parent.drive.upper() != "D:"
        or not root.name.startswith("astra-v3-oscar-")
        or (root / ".fixture-marker").read_text(encoding="utf-8") != "astra-v3-oscar-bridge-synthetic-only"):
    raise RuntimeError("owned-oscar-fixture-required")
db = root / "conversation-history.sqlite"
for candidate in (db, Path(str(db) + "-wal"), Path(str(db) + "-shm")):
    if candidate.exists() and (candidate.resolve(strict=True) != candidate or candidate.stat().st_nlink != 1):
        raise RuntimeError("fixture-database-must-be-owned")
sys.path.insert(0, str(REPO / "oscar" / "backend"))
from fastapi import HTTPException
from pydantic import ValidationError
from oscar_agent.conversation_messages import append_conversation_message
from oscar_agent.memory import MemoryStore
from oscar_agent.schemas import ConversationMessageCreate

memory = MemoryStore(SimpleNamespace(db_path=db))
additional = json.loads(sys.argv[2]) if len(sys.argv) > 2 else []
if (not isinstance(additional, list) or len(additional) > 16
        or any(not isinstance(item, str) or not re.fullmatch(r"[A-Za-z0-9_]{1,64}", item) for item in additional)):
    raise RuntimeError("fixture-exact-conversation-cohort-required")
allowed = {"conversation", "conversation_two", *additional}
requests = []
TOKEN = "astra-synthetic-conversation-only"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, data):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.route()

    def do_POST(self):
        self.route()

    def route(self):
        if self.headers.get("X-Oscar-Token") != TOKEN and self.headers.get("Authorization") != "Bearer " + TOKEN:
            return self.reply(403, {"detail": "fixture-token-required"})
        parsed = urlsplit(self.path)
        if self.command == "GET" and parsed.path == "/__fixture/evidence":
            return self.reply(200, {"requests": requests, "productMainImported": "oscar_agent.main" in sys.modules})
        requests.append(self.command + " " + parsed.path)
        match = re.fullmatch(r"/api/conversations/([A-Za-z0-9_]+)(/messages)?", parsed.path)
        if not match or match[1] not in allowed:
            return self.reply(403, {"detail": "fixture-conversation-not-admitted"})
        try:
            if self.command == "GET" and not match[2]:
                query = parse_qs(parsed.query)
                limit = int(query.get("message_limit", ["20"])[0])
                if not 1 <= limit <= 50 or set(query) - {"message_limit", "before"}:
                    raise ValueError("bounded-history-required")
                before = int(query["before"][0]) if "before" in query else None
                return self.reply(200, memory.get_conversation(match[1], message_limit=limit, before_rowid=before))
            if self.command != "POST" or match[2] != "/messages" or parsed.query:
                return self.reply(403, {"detail": "fixture-route-not-admitted"})
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 131072:
                raise ValueError("bounded-message-required")
            request = ConversationMessageCreate.model_validate_json(self.rfile.read(length))
            return self.reply(200, append_conversation_message(memory, match[1], request))
        except HTTPException as exc:
            return self.reply(exc.status_code, {"detail": exc.detail})
        except (ValueError, ValidationError):
            return self.reply(422, {"detail": "invalid-conversation-message"})
        except KeyError:
            return self.reply(404, {"detail": "conversation-not-found"})


server = HTTPServer(("127.0.0.1", 0), Handler)
server.timeout = 5
server.socket.settimeout(10)
timer = threading.Timer(180, server.shutdown)
timer.daemon = True
timer.start()


def stop_on_eof():
    # A parent-owned process pipe, not an HTTP shutdown capability.
    sys.stdin.buffer.readline(32)
    server.shutdown()


threading.Thread(target=stop_on_eof, daemon=True).start()
print(json.dumps({"origin": f"http://127.0.0.1:{server.server_port}", "marker": "synthetic-conversation-memory"}), flush=True)
try:
    server.serve_forever(poll_interval=0.05)
finally:
    timer.cancel()
    server.server_close()
