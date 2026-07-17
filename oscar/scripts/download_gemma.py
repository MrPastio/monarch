import argparse
import sys
from pathlib import Path

from huggingface_hub import hf_hub_download


ROOT = Path(__file__).resolve().parents[2] / "gemma_models"

TIERS = {
    "fast": {
        "repo": "unsloth/gemma-4-E2B-it-GGUF",
        "remote": "gemma-4-E2B-it-Q5_K_M.gguf",
        "filename": "gemma-4-E2B-it-Q5_K_M.gguf",
        "dest": ROOT / "Gemma_E2B",
        "vision_remote": "mmproj-BF16.gguf",
        "vision": "mmproj-BF16_E2B.gguf",
        "draft_remote": "mtp-gemma-4-E2B-it.gguf",
        "draft": "mtp-gemma-4-E2B-it.gguf",
    },
    "balanced": {
        "repo": "unsloth/gemma-4-12b-it-GGUF",
        "remote": "gemma-4-12b-it-Q4_K_M.gguf",
        "filename": "gemma-4-12B-it-Q4_K_M.gguf",
        "dest": ROOT / "Gemma_12B",
        "vision_remote": "mmproj-BF16.gguf",
        "vision": "mmproj-BF16_12B.gguf",
        "draft_remote": "mtp-gemma-4-12b-it.gguf",
        "draft": "mtp-gemma-4-12b-it.gguf",
    },
    "deepthinking": {
        "repo": "unsloth/gemma-4-26B-A4B-it-GGUF",
        "remote": "gemma-4-26B-A4B-it-UD-Q4_K_M.gguf",
        "filename": "gemma-4-26B-A4B-it-UD-Q4_K_M.gguf",
        "dest": ROOT / "Gemma_26B",
        "vision_remote": "mmproj-BF16.gguf",
        "vision": "mmproj-BF16_26B.gguf",
        "draft_remote": "mtp-gemma-4-26B-A4B-it.gguf",
        "draft": "mtp-gemma-4-26B-A4B-it.gguf",
    },
    "extended": {
        "repo": "unsloth/gemma-4-31B-it-GGUF",
        "remote": "gemma-4-31B-it-Q4_K_S.gguf",
        "filename": "gemma-4-31B-it-Q4_K_S.gguf",
        "dest": ROOT / "Gemma_31B",
        "vision_remote": "mmproj-BF16.gguf",
        "vision": "mmproj-BF16_31B.gguf",
        "draft_remote": "mtp-gemma-4-31B-it.gguf",
        "draft": "mtp-gemma-4-31B-it.gguf",
    },
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Download Monarch Gemma 4 GGUF assets.")
    parser.add_argument(
        "--tier",
        action="append",
        choices=sorted(TIERS),
        help="Tier to download. Repeat for several tiers. Defaults to balanced.",
    )
    parser.add_argument("--all", action="store_true", help="Download all configured tiers.")
    parser.add_argument("--vision", action="store_true", help="Download matching BF16 vision adapters.")
    parser.add_argument("--draft", action="store_true", help="Download matching MTP draft models.")
    parser.add_argument("--force", action="store_true", help="Force re-download even when a valid GGUF exists.")
    args = parser.parse_args()

    selected = sorted(TIERS) if args.all else (args.tier or ["balanced"])
    for tier in selected:
        spec = TIERS[tier]
        download_asset(spec["repo"], spec["remote"], spec["dest"], local_filename=spec["filename"], force=args.force)
        if args.vision:
            download_asset(spec["repo"], spec["vision_remote"], ROOT / "vision_other", local_filename=spec["vision"], force=args.force)
        if args.draft:
            download_asset(spec["repo"], spec["draft_remote"], ROOT / "mtp_model", local_filename=spec["draft"], force=args.force)
    return 0


def download_asset(repo_id: str, filename: str, dest: Path, *, local_filename: str, force: bool) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    target = dest / local_filename
    if not force and is_valid_gguf(target):
        print(f"Already present: {target}")
        return

    print(f"Downloading {filename} from {repo_id} -> {target}")
    try:
        downloaded = Path(hf_hub_download(
            repo_id=repo_id,
            filename=filename,
            local_dir=dest,
            force_download=force,
        ))
    except Exception as exc:
        print(f"Error downloading {filename}: {exc}", file=sys.stderr)
        raise
    if downloaded.resolve() != target.resolve():
        downloaded.replace(target)


def is_valid_gguf(path: Path) -> bool:
    try:
        with path.open("rb") as stream:
            return stream.read(4) == b"GGUF"
    except OSError:
        return False


if __name__ == "__main__":
    raise SystemExit(main())
