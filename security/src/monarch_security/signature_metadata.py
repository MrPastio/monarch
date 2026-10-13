"""Bounded read-only Authenticode metadata, used inside the owned wrapper job."""
from __future__ import annotations

from pathlib import Path
import os
import subprocess
import threading

from .worker_transport import WorkerError, decode_frame

# Shared extension contract; importing deep_scan here would load policy/LLM deps.
SIGNATURE_EXTENSIONS = {'.bat', '.cmd', '.com', '.cpl', '.dll', '.exe', '.hta', '.js',
                        '.lnk', '.msi', '.ps1', '.scr', '.sys', '.url', '.vbs', '.wsf'}
MAX_BYTES = 65_536
COMMAND = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$sig = Get-AuthenticodeSignature -LiteralPath $env:MONARCH_SCAN_PATH
[pscustomobject]@{
  authenticode_status = [string]$sig.Status
  authenticode_signed = $null -ne $sig.SignerCertificate
} | ConvertTo-Json -Compress
"""


def signature_required(path: Path, facts: dict) -> bool:
    return path.suffix.lower() in SIGNATURE_EXTENSIONS or facts.get('magic_type') == 'pe'


def signature_facts(path: Path) -> dict:
    unavailable = {'authenticode_status': 'Unavailable', 'authenticode_error': 'signature-query-unavailable'}
    if os.name != 'nt':
        return unavailable
    executable = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    try:
        process = subprocess.Popen(
            [str(executable), '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', COMMAND],
            env={**os.environ, 'MONARCH_SCAN_PATH': str(path)}, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    except OSError:
        return unavailable
    output, errors = [], []

    def read():
        try:
            output.append(process.stdout.read(MAX_BYTES + 1))
        except OSError:
            errors.append(True)

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    reader.join(timeout=5)
    try:
        if reader.is_alive() or errors or (output and len(output[0]) > MAX_BYTES):
            process.kill()
        process.wait(timeout=1)
        reader.join(timeout=1)
        if reader.is_alive():
            # Do not reuse a wrapper with an unreaped native reader. Parent owns
            # and kills its entire job, including signature descendants.
            raise SystemExit(2)
        if process.returncode != 0 or errors or not output or len(output[0]) > MAX_BYTES:
            return unavailable
        result = decode_frame(output[0], MAX_BYTES)
        if (set(result) != {'authenticode_status', 'authenticode_signed'}
                or type(result['authenticode_signed']) is not bool
                or result['authenticode_status'] not in {
                    'Valid', 'NotSigned', 'HashMismatch', 'NotTrusted', 'NotSupportedFileFormat', 'UnknownError'}):
            return unavailable
        return result
    except (WorkerError, subprocess.TimeoutExpired):
        process.kill()
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            raise SystemExit(2)
        return unavailable
    finally:
        if not reader.is_alive():
            process.stdout.close()
