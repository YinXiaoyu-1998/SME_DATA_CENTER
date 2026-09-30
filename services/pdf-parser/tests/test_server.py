"""Real HTTP upload boundary: auth, capacity, deadlines and private cleanup."""

import asyncio
import json

import aiohttp
from aiohttp import web
import pytest

from test_protocol import fixture

SECRET = "synthetic-service-token-at-least-32-characters"


async def serve(tmp_path, operation, **options):
    try:
        from smedc_pdf_parser.server import create_app
    except ModuleNotFoundError:
        pytest.fail("Authenticated parser service is missing")
    options.setdefault("readiness_check", lambda: None)
    app = create_app(secret=SECRET, temp_root=tmp_path, **options)
    server = web.AppRunner(app, handler_cancellation=True)
    await server.setup()
    site = web.TCPSite(server, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    try:
        await operation(f"http://127.0.0.1:{port}")
    finally:
        await server.cleanup()
    assert list(tmp_path.iterdir()) == []


class Success:
    async def run(self, source):
        assert source.read_bytes().startswith(b"%PDF-")
        return fixture()


def test_auth_routes_mime_and_stream_size(tmp_path):
    async def scenario(url):
        async with aiohttp.ClientSession() as session:
            async with session.post(url + "/v1/parse", data=b"%PDF-") as response:
                assert response.status == 401
                assert await response.json() == {
                    "code": "PDF_UNAUTHORIZED",
                    "message": "Parser authentication required.",
                }
            headers = {
                "Authorization": "Bearer " + SECRET,
                "Content-Type": "application/pdf",
            }
            async with session.get(
                url + "/private/source.pdf", headers=headers
            ) as response:
                assert response.status == 404
            async with session.post(
                url + "/v1/parse?path=/private/a", headers=headers, data=b"%PDF-"
            ) as response:
                assert response.status == 400
            async with session.post(
                url + "/v1/parse", headers=headers, data=b"not a pdf"
            ) as response:
                assert response.status == 422
            async with session.post(
                url + "/v1/parse",
                headers={**headers, "Content-Type": "application/json"},
                data=b"{}",
            ) as response:
                assert response.status == 415

            async def too_big():
                yield b"%PDF-"
                yield b"x" * 80

            async with session.post(
                url + "/v1/parse", headers=headers, data=too_big()
            ) as response:
                assert response.status == 413
            async with session.post(
                url + "/v1/parse", headers=headers, data=b"%PDF-ok"
            ) as response:
                assert response.status == 200
                assert await response.json() == fixture()

    asyncio.run(serve(tmp_path, scenario, runner=Success(), input_bytes=64))


def test_capacity_covers_slow_upload_and_upload_deadline(tmp_path):
    async def scenario(url):
        reader, writer = await asyncio.open_connection(
            "127.0.0.1", int(url.rsplit(":", 1)[1])
        )
        writer.write(
            (
                f"POST /v1/parse HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {SECRET}\r\nContent-Type: application/pdf\r\nContent-Length: 100\r\n\r\n%PDF-"
            ).encode()
        )
        await writer.drain()
        await asyncio.sleep(0.03)
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url + "/v1/parse",
                headers={
                    "Authorization": "Bearer " + SECRET,
                    "Content-Type": "application/pdf",
                },
                data=b"%PDF-ok",
            ) as response:
                assert response.status == 503
                assert response.headers["Retry-After"] == "5"
        response = await asyncio.wait_for(reader.read(4096), 2)
        assert b"408" in response and b"PDF_UPLOAD_TIMEOUT" in response
        writer.close()
        await writer.wait_closed()

    asyncio.run(serve(tmp_path, scenario, runner=Success(), upload_seconds=0.2))


def test_disconnect_cancels_runner_and_cleans_artifacts(tmp_path):
    started = asyncio.Event()
    cancelled = asyncio.Event()

    class Blocking:
        async def run(self, source):
            started.set()
            try:
                await asyncio.sleep(30)
            finally:
                cancelled.set()

    async def scenario(url):
        reader, writer = await asyncio.open_connection(
            "127.0.0.1", int(url.rsplit(":", 1)[1])
        )
        writer.write(
            (
                f"POST /v1/parse HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {SECRET}\r\nContent-Type: application/pdf\r\nContent-Length: 7\r\n\r\n%PDF-ok"
            ).encode()
        )
        await writer.drain()
        await asyncio.wait_for(started.wait(), 2)
        writer.close()
        await writer.wait_closed()
        await asyncio.wait_for(cancelled.wait(), 2)
        await asyncio.sleep(0.05)
        assert list(tmp_path.iterdir()) == []

    asyncio.run(serve(tmp_path, scenario, runner=Blocking()))


def test_output_validator_and_safe_unknown_errors(tmp_path):
    class Bad:
        async def run(self, source):
            return {"body": "private text", "path": "/private/secret"}

    async def scenario(url):
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url + "/v1/parse",
                headers={
                    "Authorization": "Bearer " + SECRET,
                    "Content-Type": "application/pdf",
                },
                data=b"%PDF-ok",
            ) as response:
                assert response.status == 502
                value = await response.json()
                assert set(value) == {"code", "message"}
                assert value["code"] == "PDF_INVALID_RESULT"
                assert "private" not in json.dumps(value)

    asyncio.run(serve(tmp_path, scenario, runner=Bad()))


@pytest.mark.parametrize("limit", ["max", "8589934593", "0"])
def test_runtime_refuses_missing_or_unbounded_memory(tmp_path, limit):
    from smedc_pdf_parser.server import require_container_memory_limit

    (tmp_path / "memory.max").write_text(limit)
    with pytest.raises(RuntimeError, match="finite cgroup memory limit"):
        require_container_memory_limit(tmp_path)


def test_runtime_accepts_actual_finite_memory_ceiling(tmp_path):
    from smedc_pdf_parser.server import require_container_memory_limit

    (tmp_path / "memory.max").write_text("5368709120")
    require_container_memory_limit(tmp_path)


def test_private_exception_is_never_returned(tmp_path):
    class Crashing:
        async def run(self, source):
            raise RuntimeError("private document text /secret/path bearer-private")

    async def scenario(url):
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url + "/v1/parse",
                headers={
                    "Authorization": "Bearer " + SECRET,
                    "Content-Type": "application/pdf",
                },
                data=b"%PDF-ok",
            ) as response:
                assert response.status == 422
                assert await response.json() == {
                    "code": "PDF_PARSE_FAILED",
                    "message": "PDF conversion failed.",
                }

    asyncio.run(serve(tmp_path, scenario, runner=Crashing()))


@pytest.mark.parametrize(
    "code",
    [
        None,
        "PDF_MODEL_MISSING",
        "PDF_MODEL_CHECKSUM_MISMATCH",
        "PDF_RUNTIME_VERSION_MISMATCH",
    ],
)
def test_authenticated_readiness_validates_assets_once_at_startup(tmp_path, code):
    from smedc_pdf_parser.convert import PdfParseError

    checks = []

    def checker():
        checks.append(True)
        if code:
            raise PdfParseError(code)

    async def scenario(url):
        async with aiohttp.ClientSession() as session:
            async with session.get(url + "/health") as response:
                assert response.status == 200
            async with session.get(
                url + "/v1/ready", headers={"Authorization": "Bearer wrong-token"}
            ) as response:
                assert response.status == 401
            for _ in range(2):
                async with session.get(
                    url + "/v1/ready", headers={"Authorization": "Bearer " + SECRET}
                ) as response:
                    value = await response.json()
                    if code:
                        assert response.status == 503
                        assert value["code"] == code
                        assert set(value) == {"code", "message"}
                    else:
                        assert response.status == 200
                        assert value["status"] == "ready"
                        assert value["schemaVersion"] == 1
                        assert len(value["parserFingerprint"]) == 64
                        assert set(value) == {
                            "status",
                            "schemaVersion",
                            "parserFingerprint",
                        }
            if code:
                async with session.post(
                    url + "/v1/parse",
                    headers={
                        "Authorization": "Bearer " + SECRET,
                        "Content-Type": "application/pdf",
                    },
                    data=b"%PDF-ok",
                ) as response:
                    assert response.status == 503
                    assert (await response.json())["code"] == code
            assert len(checks) == 1

    asyncio.run(serve(tmp_path, scenario, runner=Success(), readiness_check=checker))
