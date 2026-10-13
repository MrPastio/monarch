from __future__ import annotations

import sys
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

# Packaged Python may keep dependencies outside its interpreter directory.
if "--site-packages" in sys.argv:
    index = sys.argv.index("--site-packages")
    if index + 1 < len(sys.argv):
        os.environ["MONARCH_SECURITY_SITE_PACKAGES"] = sys.argv[index + 1]
site_packages = os.environ.get("MONARCH_SECURITY_SITE_PACKAGES", "")
if site_packages and Path(site_packages).is_dir() and site_packages not in sys.path:
    sys.path.append(site_packages)

from monarch_security.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
