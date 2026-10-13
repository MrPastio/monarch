"""Trusted supervisor bootstrap waits behind its guardian's anonymous gate."""
from __future__ import annotations

import os
from pathlib import Path
import sys


def main():
    from .runtime_guard import REQUEST_BYTES, ProgressReporter, validate_request
    from .worker_transport import decode_frame
    request = validate_request(decode_frame(sys.stdin.buffer.readline(REQUEST_BYTES + 1), REQUEST_BYTES))
    if sys.stdin.buffer.read(1):
        from .worker_errors import WorkerError
        raise WorkerError('guardian-request-extra-frame')
    # Config and full runtime authority are loaded only after held job assignment.
    os.environ['MONARCH_SECURITY_LAUNCH_ID'] = request['launch_id']
    from .config import load_config
    from .analysis import RuleEngine
    from .audit import AuditLog
    from .llm import LLMRouter
    from .policy import PolicyEngine
    from .resources import ResourceGuard
    from .state import StateStore
    from .supervisor import SecuritySupervisor
    config = load_config(Path(request['config_path']) if request['config_path'] else None)
    resources, policy = ResourceGuard(config.resources), PolicyEngine(config.policy)
    reporter = ProgressReporter(request, sys.stdout.buffer)
    supervisor = SecuritySupervisor(config, resources, RuleEngine(config.router),
        LLMRouter(config, resources, policy), policy,
        AuditLog(config.runtime.audit_log_path, config.runtime.max_audit_log_bytes, stdout=False,
                 integrity_key_path=config.runtime.integrity_key_path),
        StateStore(config.runtime.state_path, config.runtime.integrity_key_path),
        no_llm=request['no_llm'], progress=reporter)
    code = supervisor.run(0)
    if code == 0:
        reporter.emit('finished')
    return code


if __name__ == '__main__':
    raise SystemExit(main())
