"""Bounded, disposable document decoder. stdin/stdout only; never extracts files."""
import base64
import ctypes
import io
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET


def resource_boundary():
    if os.name == 'nt':
        from ctypes import wintypes as w
        class Basic(ctypes.Structure):
            _fields_ = [('process_time', ctypes.c_longlong), ('job_time', ctypes.c_longlong), ('flags', w.DWORD),
                ('min_working', ctypes.c_size_t), ('max_working', ctypes.c_size_t), ('active', w.DWORD),
                ('affinity', ctypes.c_size_t), ('priority', w.DWORD), ('scheduling', w.DWORD)]
        class Io(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in ('read_ops','write_ops','other_ops','read_bytes','write_bytes','other_bytes')]
        class Extended(ctypes.Structure):
            _fields_ = [('basic', Basic), ('io', Io), ('process_memory', ctypes.c_size_t), ('job_memory', ctypes.c_size_t),
                ('peak_process', ctypes.c_size_t), ('peak_job', ctypes.c_size_t)]
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateJobObjectW.restype = w.HANDLE
        kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
        kernel.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
        kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        kernel.GetCurrentProcess.restype = w.HANDLE
        job = kernel.CreateJobObjectW(None, None)
        limits = Extended(); limits.basic.flags = 0x100 | 0x2000 | 0x8  # memory, kill on close, one process
        limits.process_memory = 512 * 1024 * 1024; limits.basic.active = 1
        if not job or not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)) \
            or not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
            raise RuntimeError('resource-boundary-unavailable')
        return job  # Retain the handle for the process lifetime.
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (8, 8))
    return None


def audit(event, _args):
    if event == 'open' or event.startswith(('socket.', 'subprocess.', 'os.spawn', 'os.exec', 'ctypes.')) or event in ('os.system', 'os.remove', 'os.rename', 'os.mkdir'):
        raise PermissionError('document-worker-operation-denied')


def decode(packet):
    data = base64.b64decode(packet['dataBase64'], validate=True)
    if not 0 < len(data) <= 8 * 1024 * 1024:
        raise ValueError('input-budget')
    if packet['format'] == 'docx':
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 256 or sum(x.file_size for x in entries) > 16 * 1024 * 1024:
                raise ValueError('archive-budget')
            for entry in entries:
                if entry.filename.startswith(('/', '\\')) or '..' in entry.filename.replace('\\', '/').split('/') \
                    or entry.file_size > 8 * 1024 * 1024 or entry.file_size > max(1, entry.compress_size) * 100 \
                    or entry.flag_bits & 1 or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    raise ValueError('archive-entry')
            with archive.open('word/document.xml') as source:
                xml = source.read(4 * 1024 * 1024 + 1)
            if len(xml) > 4 * 1024 * 1024 or b'\0' in xml or re.search(br'<!\s*(DOCTYPE|ENTITY)', xml, re.I):
                raise ValueError('xml-budget-or-entity')
            document = ET.fromstring(xml)
            text = '\n'.join(''.join(p.itertext()) for p in document.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p'))
    elif packet['format'] == 'pdf':
        if not data.startswith(b'%PDF-'):
            raise ValueError('pdf-header')
        reader = PdfReader(io.BytesIO(data), strict=True)
        if reader.is_encrypted or len(reader.pages) > 100:
            raise ValueError('pdf-encrypted-or-page-budget')
        parts = []; size = 0
        for page in reader.pages:
            value = page.extract_text() or ''; parts.append(value); size += len(value)
            if size > 24000: break
        text = '\n'.join(parts)
    else:
        raise ValueError('format')
    encoded = text.encode('utf-8'); truncated = len(encoded) > 24000
    text = encoded[:24000].decode('utf-8', errors='ignore')
    if not text.strip():
        raise ValueError('no-text-layer')
    return {'text': text, 'truncated': truncated}


if __name__ == '__main__':
    try:
        boundary = resource_boundary()
        if len(sys.argv) == 3 and sys.argv[1] == '--dependency-root':
            sys.path.insert(0, sys.argv[2])
        # Import trusted decoders before closing filesystem/network/process access.
        from pypdf import PdfReader
        import encodings.cp1252
        import encodings.cp437
        import zlib
        sys.addaudithook(audit)
        raw = sys.stdin.buffer.read(12 * 1024 * 1024 + 1)
        if len(raw) > 12 * 1024 * 1024: raise ValueError('packet-budget')
        result = decode(json.loads(raw))
        sys.stdout.write(json.dumps(result, ensure_ascii=False))
    except BaseException:
        sys.stdout.write('{"error":"document-extraction-unavailable"}')
        sys.exit(1)
