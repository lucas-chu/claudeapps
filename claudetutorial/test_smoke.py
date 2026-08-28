#!/usr/bin/env python3
"""
test_smoke.py

Regression coverage for smoke_test.py: a missing dependency must produce
the documented FAIL line instead of a crash, and the .env it loads must be
found regardless of the caller's working directory. No network, no API key.

Never touches claudetutorial/.env -- a developer who followed the
quickstart has a real key in that file.

Run:
    pytest -q
"""
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent
SMOKE = REPO_ROOT / "smoke_test.py"
SCRIPTS = ["01_hello_claude.py", "02_tool_use_agent.py", "03_managed_agent.py"]


def test_missing_dependencies_report_fail_without_crashing():
    """`-S` skips site-packages, so neither anthropic nor python-dotenv are
    importable -- the same failure a bare interpreter hits, without needing
    a separate virtualenv to prove it."""
    result = subprocess.run(
        [sys.executable, "-S", str(SMOKE)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 1, result.stdout + result.stderr
    assert "FAIL: `anthropic` isn't installed" in result.stdout
    assert "FAIL: `python-dotenv` isn't installed" in result.stdout


def test_env_file_loads_regardless_of_caller_cwd(tmp_path):
    """The quickstart's `cp .env.example .env` leaves the file next to
    smoke_test.py, not in whatever directory the process happens to be
    invoked from -- prove it against a throwaway copy of the tutorial, run
    from an unrelated cwd, so this never touches the real claudetutorial/.env."""
    sandbox = tmp_path / "sandbox"
    sandbox.mkdir()
    for name in ["smoke_test.py", *SCRIPTS]:
        shutil.copy(REPO_ROOT / name, sandbox / name)
    (sandbox / ".env").write_text("ANTHROPIC_API_KEY=sk-ant-test-fake-key\n")

    unrelated_cwd = tmp_path / "elsewhere"
    unrelated_cwd.mkdir()

    result = subprocess.run(
        [sys.executable, str(sandbox / "smoke_test.py")],
        cwd=unrelated_cwd,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "OK:   ANTHROPIC_API_KEY is set" in result.stdout
