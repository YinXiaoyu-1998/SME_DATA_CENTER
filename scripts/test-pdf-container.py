"""Bounded synthetic Linux parser qualification; never load private documents."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services/pdf-parser/tests"))
from test_convert import create_pdf  # noqa: E402

IMAGE = os.environ.get("SMEDC_PDF_TEST_IMAGE", "smedc-pdf-parser:ci")
TOKEN = secrets.token_hex(32)
NAMES = []


def docker(*args, input=None, check=True):
    return subprocess.run(["docker", *args], input=input, capture_output=True, check=check, env={**os.environ, "SMEDC_PDF_SERVICE_TOKEN": TOKEN})


def start(name, memory="5g", extra=()):
    NAMES.append(name)
    return docker("run", "-d", "--name", name, "--network", "none", "--read-only", "--memory", memory, "--memory-swap", memory, "--cpus", "4", "--pids-limit", "128", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,noexec,nosuid,size=134217728,uid=10001,gid=10001,mode=0700", "-e", "SMEDC_PDF_SERVICE_TOKEN", *extra, IMAGE)


def request(name, path, body=b"", authenticated=True):
    code = """
import json,os,sys,urllib.request,urllib.error
headers={'Content-Type':'application/pdf'}
if sys.argv[2]=='true':headers['Authorization']='Bearer '+os.environ['SMEDC_PDF_SERVICE_TOKEN']
body=sys.stdin.buffer.read()
req=urllib.request.Request('http://127.0.0.1:8080'+sys.argv[1],data=body if body else None,headers=headers)
try:
 r=urllib.request.urlopen(req,timeout=120); status=r.status; content=r.read()
except urllib.error.HTTPError as r:status=r.code; content=r.read()
print(json.dumps({'status':status,'body':json.loads(content)}))
"""
    result = docker("exec", "-i", name, "python", "-c", code, path, str(authenticated).lower(), input=body)
    return json.loads(result.stdout)


def wait_ready(name, expected):
    for _ in range(60):
        try:
            reply = request(name, "/v1/ready")
            if reply["status"] == expected:
                return reply
        except subprocess.CalledProcessError:
            pass
        time.sleep(0.5)
    raise AssertionError("Parser did not reach expected readiness")


def main():
    prefix = f"smedc-pdf-test-{os.getpid()}"
    with tempfile.TemporaryDirectory(prefix="smedc-pdf-fixture-") as directory:
        source = create_pdf(Path(directory) / "mixed.pdf", mixed=True).read_bytes()
        name = prefix + "-ocr"
        start(name)
        ready = wait_ready(name, 200)
        manifest = json.loads((ROOT / "services/pdf-parser/model-manifest.json").read_text())
        fingerprint = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        assert ready["body"]["parserFingerprint"] == fingerprint
        began = time.monotonic()
        parsed = request(name, "/v1/parse", source)
        seconds = time.monotonic() - began
        assert parsed["status"] == 200, parsed["body"]
        result = parsed["body"]
        compact = lambda value: "".join(value.split())
        body = compact("\n".join(block["text"] for block in result["blocks"]))
        assert body.count("原生正文仅出现一次") == 1
        assert "黄瓜" in body and "小米辣" in body
        assert result["pageCount"] == 2 and result["pages"][0]["outcome"] == "blank"
        rows = [[compact(cell["text"]) for cell in table["cells"] if cell["row"] == row] for table in result["tables"] for row in range(table["rowCount"])]
        assert ["黄瓜", "克", "60"] in rows and ["小米辣", "克", "5"] in rows
        subprocess.run(["npx", "tsx", "-e", "import {parsePdfEvidenceResult} from '@smedc/domain'; import fs from 'node:fs'; parsePdfEvidenceResult(JSON.parse(fs.readFileSync(0,'utf8')));"], cwd=ROOT, input=json.dumps(result).encode(), check=True, capture_output=True)
        measurement = json.loads(docker("exec", name, "python", "-c", "import json,pathlib,platform; p=pathlib.Path('/sys/fs/cgroup');print(json.dumps({'architecture':platform.machine(),'memoryPeakBytes':int((p/'memory.peak').read_text()),'memoryLimitBytes':int((p/'memory.max').read_text()),'cpuMax':(p/'cpu.max').read_text().strip(),'jobsRemaining':len(list(pathlib.Path('/tmp/jobs').iterdir()))}))").stdout)
        assert measurement["jobsRemaining"] == 0
        measurement.update(seconds=round(seconds, 3), pages=result["pageCount"], tables=len(result["tables"]), parserFingerprint=fingerprint)
        print(json.dumps(measurement))
        docker("rm", "-f", name)
        missing = prefix + "-missing"
        start(missing, "512m", ("-e", "SMEDC_PDF_MODELS_PATH=/missing"))
        assert wait_ready(missing, 503)["body"]["code"] == "PDF_MODEL_MISSING"
        assert request(missing, "/v1/ready", authenticated=False)["status"] == 401
        assert request(missing, "/v1/parse", source)["body"]["code"] == "PDF_MODEL_MISSING"
        assert request(missing, "/health", authenticated=False)["status"] == 200
        docker("rm", "-f", missing)
        lifecycle = """
import asyncio,os,pathlib,sys
from smedc_pdf_parser.runner import Runner
async def main():
 marker=pathlib.Path('/tmp/pid')
 code="import os,time,pathlib;pathlib.Path('/tmp/pid').write_text(str(os.getpid()));time.sleep(30)"
 try:await Runner(command=[sys.executable,'-c',code],timeout_seconds=.3).run(pathlib.Path('/tmp/input.pdf'))
 except ValueError as error:assert str(error)=='PDF_TIMEOUT'
 else:raise AssertionError('Timeout missing')
 try:os.kill(int(marker.read_text()),0)
 except ProcessLookupError:pass
 else:raise AssertionError('Child survived')
asyncio.run(main())
"""
        docker("run", "--rm", "--network", "none", "--read-only", "--memory", "512m", "--memory-swap", "512m", "--tmpfs", "/tmp:rw,uid=10001,gid=10001,mode=0700", "--entrypoint", "python", IMAGE, "-c", lifecycle)
        oom = prefix + "-oom"
        NAMES.append(oom)
        failed = docker("run", "--name", oom, "--network", "none", "--read-only", "--memory", "64m", "--memory-swap", "64m", "--entrypoint", "python", IMAGE, "-c", "x=bytearray(128*1024*1024)", check=False)
        assert failed.returncode == 137
        assert docker("inspect", "--format", "{{.State.OOMKilled}}", oom).stdout.strip() == b"true"
        print("authenticated readiness, missing-model refusal, finite child timeout and cgroup OOM passed")


try:
    main()
finally:
    for name in NAMES:
        docker("rm", "-f", name, check=False)
