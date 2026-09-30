"""Authenticated binary-only internal HTTP service; no path/URL/model inputs."""

from __future__ import annotations

import asyncio
import hmac
import json
import os
from pathlib import Path
import tempfile

from aiohttp import web

from .convert import PdfParseError, _manifest
from .protocol import validate_result
from .runner import Runner


ERRORS = {
    "PDF_UNAUTHORIZED": (401, "Parser authentication required."),
    "PDF_NOT_FOUND": (404, "Parser endpoint not found."),
    "PDF_INVALID_REQUEST": (400, "Invalid parser request."),
    "PDF_UNSUPPORTED_MEDIA_TYPE": (415, "PDF content type required."),
    "PDF_INPUT_TOO_LARGE": (413, "PDF input exceeds the limit."),
    "PDF_INVALID_OR_ENCRYPTED": (422, "PDF is invalid or password protected."),
    "PDF_BUSY": (503, "Parser is busy. Retry later."),
    "PDF_UPLOAD_TIMEOUT": (408, "PDF upload deadline exceeded."),
    "PDF_TIMEOUT": (504, "PDF conversion deadline exceeded."),
    "PDF_INVALID_RESULT": (502, "Invalid PDF evidence result."),
    "PDF_OUTPUT_TOO_LARGE": (422, "PDF output exceeds the limit."),
    "PDF_PAGE_LIMIT": (422, "PDF page count exceeds the limit."),
    "PDF_PIXEL_LIMIT": (422, "PDF rendering exceeds the limit."),
    "PDF_INCOMPLETE_PARSE": (422, "PDF conversion is incomplete."),
    "PDF_MODEL_MISSING": (503, "Parser models unavailable."),
    "PDF_MODEL_CHECKSUM_MISMATCH": (503, "Parser models unavailable."),
    "PDF_RUNTIME_VERSION_MISMATCH": (503, "Parser runtime unavailable."),
    "PDF_PARSE_FAILED": (422, "PDF conversion failed."),
}


def failure(code):
    status, message = ERRORS[code]
    response = web.json_response({"code": code, "message": message}, status=status)
    if code == "PDF_BUSY":
        response.headers["Retry-After"] = "5"
    # Do not drain an unauthorized/oversized/slow body in the background.
    response.force_close()
    return response


def create_app(
    *, secret: str, temp_root: Path, runner=None, input_bytes=None, upload_seconds=120
):
    if len(secret.encode()) < 32:
        raise ValueError("Parser secret must contain at least 32 bytes.")
    budget = _manifest()["budgets"]
    input_bytes = budget["inputBytes"] if input_bytes is None else input_bytes
    runner = runner or Runner()
    busy = False
    temp_root.mkdir(parents=True, exist_ok=True, mode=0o700)

    async def handle(request):
        nonlocal busy
        if (
            request.method == "GET"
            and request.path == "/health"
            and not request.query_string
        ):
            return web.json_response({"status": "ok"})
        credential = request.headers.get("Authorization", "")
        if not hmac.compare_digest(credential.encode(), ("Bearer " + secret).encode()):
            return failure("PDF_UNAUTHORIZED")
        if request.path != "/v1/parse" or request.method != "POST":
            return failure("PDF_NOT_FOUND")
        if (
            request.query_string
            or request.headers.get("Content-Encoding", "identity") != "identity"
        ):
            return failure("PDF_INVALID_REQUEST")
        if request.content_type != "application/pdf":
            return failure("PDF_UNSUPPORTED_MEDIA_TYPE")
        if request.content_length is not None and request.content_length > input_bytes:
            return failure("PDF_INPUT_TOO_LARGE")
        if busy:
            return failure("PDF_BUSY")
        busy = True  # No await between check and acquisition; no pending queue.
        try:
            with tempfile.TemporaryDirectory(
                prefix="parse-", dir=temp_root
            ) as directory:
                source = Path(directory) / "input.pdf"
                size = 0
                try:
                    async with asyncio.timeout(upload_seconds):
                        with source.open("xb") as file:
                            async for chunk in request.content.iter_chunked(65536):
                                size += len(chunk)
                                if size > input_bytes:
                                    raise PdfParseError("PDF_INPUT_TOO_LARGE")
                                file.write(chunk)
                except TimeoutError:
                    raise PdfParseError("PDF_UPLOAD_TIMEOUT") from None
                with source.open("rb") as file:
                    if not file.read(5).startswith(b"%PDF-"):
                        raise PdfParseError("PDF_INVALID_OR_ENCRYPTED")
                # Handler cancellation is enabled at the HTTP server; dropping
                # a connection cancels Runner and waits for group termination.
                value = validate_result(await runner.run(source))
                encoded = json.dumps(
                    value, ensure_ascii=False, allow_nan=False, separators=(",", ":")
                ).encode()
                if len(encoded) > budget["outputBytes"]:
                    raise PdfParseError("PDF_OUTPUT_TOO_LARGE")
                return web.Response(body=encoded, content_type="application/json")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            code = str(error)
            return failure(code if code in ERRORS else "PDF_PARSE_FAILED")
        finally:
            busy = False

    app = web.Application(client_max_size=input_bytes)
    app.router.add_route("*", "/{path:.*}", handle)
    return app


def require_container_memory_limit(root=Path("/sys/fs/cgroup")):
    """Fail closed without a finite Linux cgroup v2 RSS/page-cache ceiling."""
    try:
        limit = int((root / "memory.max").read_text().strip())
        if not 0 < limit <= _manifest()["budgets"]["memoryBytes"]:
            raise ValueError
    except (OSError, ValueError):
        raise RuntimeError(
            "Parser requires a finite cgroup memory limit of at most 8 GiB."
        ) from None


def main():
    require_container_memory_limit()
    os.umask(0o077)
    secret = os.environ.get("SMEDC_PDF_SERVICE_TOKEN", "")
    app = create_app(secret=secret, temp_root=Path("/tmp/jobs"))
    web.run_app(
        app,
        host="0.0.0.0",
        port=8080,
        access_log=None,
        handler_cancellation=True,
        shutdown_timeout=5,
        max_line_size=4096,
        max_field_size=4096,
        auto_decompress=False,
    )


if __name__ == "__main__":
    main()
