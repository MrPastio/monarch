import hashlib
import os

import pytest

from oscar_agent.astra_asset_pin import pin_astra_asset

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows native sharing contract")


def fixture(tmp_path):
    root = tmp_path / "owned"
    root.mkdir()
    model = root / "model.gguf"
    data = b"GGUFsynthetic asset bytes, not a real model"
    model.write_bytes(data)
    return dict(root=root, candidate=model, expected_digest="sha256:" + hashlib.sha256(data).hexdigest(), expected_bytes=len(data))


def test_pin_allows_loader_read_but_denies_write_replace_and_directory_rename(tmp_path):
    args = fixture(tmp_path)
    model = args["candidate"]
    with pin_astra_asset(**args) as asset:
        assert asset.path == model and asset.digest == args["expected_digest"]
        assert model.read_bytes().startswith(b"GGUF")
        with pytest.raises(OSError):
            model.write_bytes(b"overwritten")
        with pytest.raises(OSError):
            model.rename(model.with_suffix(".moved"))
        replacement = args["root"] / "replacement.gguf"
        replacement.write_bytes(b"GGUFreplacement")
        with pytest.raises(OSError):
            replacement.replace(model)
        with pytest.raises(OSError):
            args["root"].rename(tmp_path / "renamed")
    model.write_bytes(b"released")
    assert model.read_bytes() == b"released"


@pytest.mark.parametrize("change,code", [({"expected_digest": "sha256:" + "0" * 64}, "asset-pin-hash"),
    ({"expected_bytes": 999}, "asset-pin-identity"), ({"expected_digest": "bad"}, "asset-pin-digest")])
def test_rejected_admission_releases_all_handles(tmp_path, change, code):
    args = fixture(tmp_path)
    with pytest.raises(ValueError, match=code):
        with pin_astra_asset(**{**args, **change}):
            pytest.fail("rejected asset admitted")
    args["candidate"].write_bytes(b"released")
    args["root"].rename(tmp_path / "released-root")


def test_existing_writer_prevents_admission_and_loader_failure_releases_pin(tmp_path):
    args = fixture(tmp_path)
    with args["candidate"].open("r+b"):
        with pytest.raises(OSError):
            with pin_astra_asset(**args):
                pytest.fail("concurrent writer admitted")
    with pytest.raises(RuntimeError, match="native loader failed"):
        with pin_astra_asset(**args):
            raise RuntimeError("native loader failed")
    args["candidate"].write_bytes(b"released")


def test_outside_owner_root_rejected_before_content_read(tmp_path):
    args = fixture(tmp_path)
    other = tmp_path / "outside.gguf"
    other.write_bytes(b"GGUFoutside")
    with pytest.raises(ValueError, match="asset-pin-scope"):
        with pin_astra_asset(**{**args, "candidate": other}):
            pytest.fail("outside root admitted")
