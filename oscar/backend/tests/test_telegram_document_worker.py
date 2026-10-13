import base64
import io
import json
import subprocess
import sys
import zipfile
from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject

WORKER = Path(__file__).parents[1] / 'oscar_agent' / 'telegram_document_worker.py'


def run_worker(data: bytes, kind: str):
    result = subprocess.run([sys.executable, '-I', '-B', '-X', 'utf8', str(WORKER)],
        input=json.dumps({'format': kind, 'dataBase64': base64.b64encode(data).decode()}),
        text=True, capture_output=True, timeout=15)
    return result.returncode, json.loads(result.stdout)


def docx(xml: str, name='word/document.xml'):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as archive:
        archive.writestr(name, xml)
    return output.getvalue()


def test_docx_child_extracts_text_under_os_resource_boundary():
    data = docx('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Fixture content</w:t></w:r></w:p></w:document>')
    code, result = run_worker(data, 'docx')
    assert code == 0 and result['text'] == 'Fixture content'


def test_xml_entities_and_path_traversal_are_rejected_before_extraction():
    for data in (docx('<!DOCTYPE doc [<!ENTITY x SYSTEM "file:///private-fixture">]><doc>&x;</doc>'), docx('text', '../word/document.xml')):
        code, result = run_worker(data, 'docx')
        assert code != 0 and result == {'error': 'document-extraction-unavailable'}


def test_pdf_text_uses_no_active_content_and_encrypted_pdf_is_rejected():
    writer = PdfWriter(); page = writer.add_blank_page(width=300, height=300)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    stream = DecodedStreamObject(); stream.set_data(b'BT /F1 12 Tf 30 50 Td (Fixture PDF) Tj ET')
    page[NameObject('/Contents')] = writer._add_object(stream)
    data = io.BytesIO(); writer.write(data)
    code, result = run_worker(data.getvalue(), 'pdf')
    assert code == 0 and 'Fixture PDF' in result['text']
    writer.encrypt('fixture-password'); encrypted = io.BytesIO(); writer.write(encrypted)
    assert run_worker(encrypted.getvalue(), 'pdf')[0] != 0
