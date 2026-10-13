import io
import os
import pytest

from monarch_security import signature_metadata as signature


@pytest.mark.skipif(os.name != 'nt', reason='Windows read-only metadata wrapper')
@pytest.mark.parametrize('raw,complete', [
    (b'{"authenticode_status":"NotSigned","authenticode_signed":false}\n', True),
    (b'{"authenticode_status":"Valid","authenticode_signed":true}\n', True),
    (b'{}\n', False),
    (b'{"authenticode_status":"Valid","authenticode_status":"NotSigned","authenticode_signed":false}\n', False),
    (b'{"authenticode_status":"Valid","authenticode_signed":true,"authenticode_subject":"unexpected"}\n', False),
    (b'X'*(signature.MAX_BYTES + 100), False),
    (b'\xff\n', False),
], ids=['unsigned', 'valid', 'empty', 'duplicate', 'extra-field', 'oversize', 'invalid-utf8'])
def test_metadata_output_bound_schema_and_duplicate_rejection(tmp_path, monkeypatch, raw, complete):
    class Process:
        stdout = io.BytesIO(raw)
        returncode = None
        killed = False
        def wait(self, *, timeout):
            if self.returncode is None:
                self.returncode = 0
            return self.returncode
        def kill(self):
            self.returncode = -1
            self.killed = True
    process = Process()
    def launch(command, **options):
        assert '-NoProfile' in command and 'Get-AuthenticodeSignature' in command[-1]
        assert options['env']['MONARCH_SCAN_PATH'] == str(tmp_path / 'fixture.ps1')
        return process
    monkeypatch.setattr(signature.subprocess, 'Popen', launch)
    facts = signature.signature_facts(tmp_path / 'fixture.ps1')
    assert (facts['authenticode_status'] != 'Unavailable') == complete
    if len(raw) > signature.MAX_BYTES:
        assert process.killed
    assert process.stdout.closed
