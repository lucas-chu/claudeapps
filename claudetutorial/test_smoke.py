#!/usr/bin/env python3
"""
test_smoke.py

Regression coverage for smoke_test.py: a missing dependency must produce
the documented FAIL line instead of a crash, and the .env it loads must be
found regardless of the caller's working directory. No network, no API key.

Run:
    pytest -q
"""
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent
SMOKE = REPO_ROOT / "smoke_test.py"

sys.path.insert(0, str(REPO_ROOT))
import smoke_test  # noqa: E402


def test_missing_anthropic_reports_fail_without_crashing(monkeypatch):
    monkeypatch.setitem(sys.modules, "anthropic", None)
    assert smoke_test.check_sdk_installed() is False


def test_missing_dotenv_reports_fail_without_crashing(monkeypatch):
    monkeypatch.setitem(sys.modules, "dotenv", None)
    assert smoke_test.check_dotenv_installed() is False


def test_env_file_loads_regardless_of_caller_cwd(tmp_path):
    """The quickstart's `cp .env.example .env` leaves the file next to
    smoke_test.py, not in whatever directory the process happens to be
    invoked from -- run the script from an unrelated cwd and confirm it
    still finds the key."""
    env_path = REPO_ROOT / ".env"
    env_path.write_text("ANTHROPIC_API_KEY=sk-ant-test-fake-key\n")
    try:
        result = subprocess.run(
            [sys.executable, str(SMOKE)],
            cwd=tmp_path,
            capture_output=True,
            text=True,
        )
    finally:
        env_path.unlink()

    assert "OK:   ANTHROPIC_API_KEY is set" in result.stdout, result.stdout + result.stderr
