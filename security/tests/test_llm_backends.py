from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from monarch_security.config import load_config
from monarch_security.llm.router import LLMRouter
from monarch_security.policy import PolicyEngine
from monarch_security.resources import ResourceGuard


class LlmBackendSelectionTests(unittest.TestCase):
    def test_hf_backend_selected_for_model_directory(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            model_dir = root / "hf-model"
            model_dir.mkdir()
            config_path = root / "monarch_security.toml"
            config_path.write_text(f"[model]\npath = '{model_dir}'\n", encoding="utf-8")

            config = load_config(config_path)
            router = LLMRouter(config, ResourceGuard(config.resources), PolicyEngine(config.policy))

            self.assertEqual(router.backend.status().backend, "hf")

    def test_gguf_backend_selected_for_model_file(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            model = root / "model.gguf"
            model.write_bytes(b"not a real model")
            config_path = root / "monarch_security.toml"
            config_path.write_text(f"[model]\npath = '{model}'\n", encoding="utf-8")

            config = load_config(config_path)
            router = LLMRouter(
                config,
                ResourceGuard(config.resources),
                PolicyEngine(config.policy),
            )

            self.assertEqual(router.backend.status().backend, "gguf")
