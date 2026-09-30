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
