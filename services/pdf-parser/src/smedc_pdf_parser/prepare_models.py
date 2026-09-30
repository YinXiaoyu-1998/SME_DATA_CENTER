"""Build-time only, manifest-selected model assets and upstream license notices."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import urllib.request


def prepare_models(records, output: Path, *, cache: Path | None = None):
    output.mkdir(parents=True, exist_ok=True)
    for record in records:
        relative = Path(record["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Invalid manifest path")
        cached = cache / relative if cache else None
        with tempfile.TemporaryDirectory(dir=output) as temporary:
            selected = Path(temporary) / "asset"
            if cached and cached.is_file():
                shutil.copyfile(cached, selected)
            else:
                if not record["url"].startswith("https://"):
                    raise ValueError("Invalid manifest URL")
                with (
                    urllib.request.urlopen(record["url"], timeout=120) as response,
                    selected.open("wb") as target,
                ):
                    # An upstream mismatch is bounded by the declared asset size.
                    size = 0
                    while chunk := response.read(65536):
                        size += len(chunk)
                        if size > record["bytes"]:
                            raise ValueError("Model checksum mismatch")
                        target.write(chunk)
            with selected.open("rb") as file:
                digest = hashlib.file_digest(file, "sha256").hexdigest()
            if selected.stat().st_size != record["bytes"] or digest != record["sha256"]:
                raise ValueError("Model checksum mismatch")
            destination = output / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(selected, destination)
            destination.chmod(0o444)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path.cwd()
    manifest = json.loads((root / "model-manifest.json").read_text())
    notices = json.loads((root / "model-notices.json").read_text())
    prepare_models(manifest["files"] + notices, args.output, cache=args.cache)
    shutil.copyfile(root / "model-manifest.json", args.output / "MODEL-MANIFEST.json")
    shutil.copyfile(root / "model-notices.json", args.output / "MODEL-NOTICES.json")


if __name__ == "__main__":
    main()
