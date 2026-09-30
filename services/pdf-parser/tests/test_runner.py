"""Actual child processes must terminate under output/time/cancellation bounds."""

import asyncio
import os
import sys

import pytest


def runner(**kwargs):
    try:
        from smedc_pdf_parser.runner import Runner
    except ModuleNotFoundError:
        pytest.fail("Bounded subprocess runner is missing")
    return Runner(**kwargs)


def test_stdout_is_capped_while_child_is_writing(tmp_path):
    async def scenario():
        child = runner(
            command=[
                sys.executable,
                "-c",
                "import os,time; os.write(1,b'x'*100000); time.sleep(30)",
            ],
            output_bytes=1024,
        )
        with pytest.raises(ValueError, match="^PDF_OUTPUT_TOO_LARGE$"):
            await asyncio.wait_for(child.run(tmp_path / "source.pdf"), 3)

    asyncio.run(scenario())


@pytest.mark.parametrize("cancel", [False, True])
def test_timeout_and_cancel_kill_process_group(tmp_path, cancel):
    marker = tmp_path / "pids"
    script = (
        "import os,subprocess,time,pathlib; p=subprocess.Popen(['sleep','30']); pathlib.Path(%r).write_text(str(os.getpid())+' '+str(p.pid)); time.sleep(30)"
        % str(marker)
    )

    async def scenario():
        child = runner(command=[sys.executable, "-c", script], timeout_seconds=0.3)
        task = asyncio.create_task(child.run(tmp_path / "source.pdf"))
        while not marker.exists():
            await asyncio.sleep(0.01)
        if cancel:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            with pytest.raises(ValueError, match="^PDF_TIMEOUT$"):
                await task
        for pid in map(int, marker.read_text().split()):
            # POSIX kill leaves a short-lived reparented zombie; it cannot run.
            for _ in range(100):
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    break
                status = os.popen(f"ps -o stat= -p {pid}").read().strip()
                if status.startswith("Z"):
                    break
                await asyncio.sleep(0.02)
            else:
                pytest.fail("Child or descendant survived termination")

    asyncio.run(scenario())


def test_cancel_during_spawn_does_not_orphan_child(tmp_path, monkeypatch):
    from smedc_pdf_parser import runner as module

    marker = tmp_path / "spawn-pid"
    spawn = asyncio.create_subprocess_exec

    async def delayed_spawn(*args, **kwargs):
        process = await spawn(*args, **kwargs)
        await asyncio.sleep(0.1)
        return process

    monkeypatch.setattr(module.asyncio, "create_subprocess_exec", delayed_spawn)

    async def scenario():
        child = runner(
            command=[
                sys.executable,
                "-c",
                "import os,pathlib,time; pathlib.Path(%r).write_text(str(os.getpid())); time.sleep(30)"
                % str(marker),
            ]
        )
        task = asyncio.create_task(child.run(tmp_path / "input.pdf"))
        while not marker.exists():
            await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        with pytest.raises(ProcessLookupError):
            os.kill(int(marker.read_text()), 0)

    asyncio.run(scenario())


def test_worker_child_does_not_inherit_service_auth_secret(tmp_path, monkeypatch):
    import json
    from test_protocol import fixture

    marker = tmp_path / "auth-state"
    monkeypatch.setenv("SMEDC_PDF_SERVICE_TOKEN", "private-service-token")
    script = (
        "import os,pathlib; pathlib.Path(%r).write_text(str('SMEDC_PDF_SERVICE_TOKEN' in os.environ)); print(%r)"
        % (str(marker), json.dumps(fixture()))
    )

    async def scenario():
        await runner(command=[sys.executable, "-c", script]).run(tmp_path / "input.pdf")
        assert marker.read_text() == "False"

    asyncio.run(scenario())
