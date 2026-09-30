"""One disposable process group per conversion, with bounded pipe reads."""

from __future__ import annotations

import asyncio
from contextlib import redirect_stdout
import json
import os
from pathlib import Path
import resource
import signal
import sys

from .convert import PdfParseError, _manifest
from .protocol import validate_result


class Runner:
    def __init__(self, *, command=None, output_bytes=None, timeout_seconds=None):
        budget = _manifest()["budgets"]
        self.command = command or [sys.executable, "-m", "smedc_pdf_parser.runner"]
        self.output_bytes = (
            budget["outputBytes"] if output_bytes is None else output_bytes
        )
        self.timeout_seconds = (
            budget["timeoutSeconds"] if timeout_seconds is None else timeout_seconds
        )

    async def run(self, source: Path):
        spawn = asyncio.create_task(
            asyncio.create_subprocess_exec(
                *self.command,
                str(source),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True,
                limit=65536,
                env={
                    **{
                        key: value
                        for key, value in os.environ.items()
                        if key != "SMEDC_PDF_SERVICE_TOKEN"
                    },
                    "TMPDIR": str(source.parent),
                },
            )
        )
        try:
            process = await asyncio.shield(spawn)
        except asyncio.CancelledError:
            process = await spawn
            await _terminate(process)
            raise
        try:
            async with asyncio.timeout(self.timeout_seconds):
                output = bytearray()
                while True:
                    chunk = await process.stdout.read(
                        min(65536, self.output_bytes + 1 - len(output))
                    )
                    if not chunk:
                        break
                    output.extend(chunk)
                    if len(output) > self.output_bytes:
                        raise PdfParseError("PDF_OUTPUT_TOO_LARGE")
                status = await process.wait()
                try:
                    value = json.loads(output)
                except (ValueError, RecursionError):
                    raise PdfParseError("PDF_PARSE_FAILED") from None
                if status != 0:
                    code = value.get("code") if isinstance(value, dict) else None
                    raise PdfParseError(
                        code if code in CHILD_ERRORS else "PDF_PARSE_FAILED"
                    )
                return validate_result(value)
        except TimeoutError:
            raise PdfParseError("PDF_TIMEOUT") from None
        finally:
            await _terminate(process)


async def _terminate(process):
    # Kill the group even if its leader exited leaving descendants.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    await process.wait()


CHILD_ERRORS = frozenset(
    (
        "PDF_INPUT_TOO_LARGE",
        "PDF_INVALID_OR_ENCRYPTED",
        "PDF_PAGE_LIMIT",
        "PDF_PIXEL_LIMIT",
        "PDF_MODEL_MISSING",
        "PDF_MODEL_CHECKSUM_MISMATCH",
        "PDF_RUNTIME_VERSION_MISMATCH",
        "PDF_INCOMPLETE_PARSE",
        "PDF_OUTPUT_TOO_LARGE",
        "PDF_INVALID_RESULT",
        "PDF_PARSE_FAILED",
    )
)


def main():
    # CPU, descriptors and core dumps are process limits. RSS is enforced by
    # container memory.max, never by an inferred RLIMIT_AS virtual-space cap.
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    cpu = _manifest()["budgets"]["timeoutSeconds"]
    resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
    resource.setrlimit(
        resource.RLIMIT_FSIZE, (_manifest()["budgets"]["outputBytes"],) * 2
    )
    try:
        from .convert import convert_pdf

        with redirect_stdout(sys.stderr):
            value = validate_result(convert_pdf(Path(sys.argv[1])))
        encoder = json.JSONEncoder(
            ensure_ascii=False, allow_nan=False, separators=(",", ":")
        )
        total = 0
        for fragment in encoder.iterencode(value):
            encoded = fragment.encode("utf-8")
            total += len(encoded)
            if total > _manifest()["budgets"]["outputBytes"]:
                raise PdfParseError("PDF_OUTPUT_TOO_LARGE")
            sys.stdout.buffer.write(encoded)
    except Exception as error:
        code = str(error)
        sys.stdout.write(
            json.dumps({"code": code if code in CHILD_ERRORS else "PDF_PARSE_FAILED"})
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
