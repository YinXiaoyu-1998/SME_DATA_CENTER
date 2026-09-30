"""Model build cache is untrusted: copy manifest files only and verify hashes."""

import hashlib

import pytest


def prepare(*args, **kwargs):
    try:
        from smedc_pdf_parser.prepare_models import prepare_models
    except ModuleNotFoundError:
        pytest.fail("Manifest-only build preparation is missing")
    return prepare_models(*args, **kwargs)


def test_only_verified_manifest_assets_enter_runtime(tmp_path):
    cache, output = tmp_path / "cache", tmp_path / "out"
    cache.mkdir()
    (cache / "model").write_bytes(b"public asset")
    (cache / "secret").write_text("must not copy")
    records = [
        dict(
            path="model",
            bytes=12,
            sha256=hashlib.sha256(b"public asset").hexdigest(),
            url="https://invalid.example/model",
        )
    ]
    prepare(records, output, cache=cache)
    assert (output / "model").read_bytes() == b"public asset"
    assert list(output.iterdir()) == [output / "model"]
    (cache / "model").write_bytes(b"tampered")
    with pytest.raises(ValueError, match="checksum"):
        prepare(records, tmp_path / "bad", cache=cache)


def test_manifest_cannot_escape_preparation_directory(tmp_path):
    with pytest.raises(ValueError, match="path"):
        prepare(
            [
                dict(
                    path="../escape",
                    bytes=0,
                    sha256="a" * 64,
                    url="https://invalid.example/a",
                )
            ],
            tmp_path / "out",
        )


def test_ci_preparation_entry_uses_service_working_directory(tmp_path, monkeypatch):
    import json
    import sys
    from pathlib import Path
    from smedc_pdf_parser.prepare_models import main

    workflow = Path(__file__).resolve().parents[3] / ".github/workflows/phase3-quality-gates.yml"
    if workflow.is_file():
        parser_job = workflow.read_text().split("  pdf-parser-unit:", 1)[1]
        assert "working-directory: services/pdf-parser" in parser_job
        assert "--project ." in parser_job
        assert 'SMEDC_PDF_MODELS_PATH="$PWD/.codex-build/pdf-ci/models"' in parser_job
    service = tmp_path / "services/pdf-parser"
    service.mkdir(parents=True)
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / "asset").write_bytes(b"tiny")
    (service / "model-manifest.json").write_text(json.dumps({"files": [dict(path="asset", bytes=4, sha256=hashlib.sha256(b"tiny").hexdigest(), url="https://invalid.example/asset")]}))
    (service / "model-notices.json").write_text("[]")
    monkeypatch.chdir(service)  # the workflow's actual preparation cwd
    monkeypatch.setattr(sys, "argv", ["prepare_models", "--cache", str(cache), "--output", ".codex-build/pdf-ci/models"])
    main()
    output = service / ".codex-build/pdf-ci/models"
    assert (output / "asset").read_bytes() == b"tiny"
    assert (output / "MODEL-MANIFEST.json").is_file()
    assert (output / "MODEL-NOTICES.json").is_file()
