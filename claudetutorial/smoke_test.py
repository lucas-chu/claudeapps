#!/usr/bin/env python3
"""
smoke_test.py

The fast, no-network signal: confirms the SDK is installed, the API key is
configured, and all three tutorial scripts at least parse. Doesn't call
the API -- run the numbered scripts for that.

Run:
    python smoke_test.py
"""
import os
import pathlib
import py_compile
import sys

REPO_ROOT = pathlib.Path(__file__).parent
SCRIPTS = ["01_hello_claude.py", "02_tool_use_agent.py", "03_managed_agent.py"]


def check_sdk_installed() -> bool:
    try:
        import anthropic
    except ImportError:
        print("FAIL: `anthropic` isn't installed. Run: pip install -r requirements.txt")
        return False
    print(f"OK:   anthropic SDK installed (version {anthropic.__version__})")
    return True


def check_dotenv_installed() -> bool:
    try:
        from dotenv import load_dotenv
    except ImportError:
        print("FAIL: `python-dotenv` isn't installed. Run: pip install -r requirements.txt")
        return False
    load_dotenv()
    return True


def check_api_key() -> bool:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("WARN: ANTHROPIC_API_KEY isn't set -- the numbered scripts need it, this check doesn't.")
    else:
        print("OK:   ANTHROPIC_API_KEY is set")
    return True


def check_scripts_compile() -> bool:
    ok = True
    for name in SCRIPTS:
        path = REPO_ROOT / name
        try:
            py_compile.compile(str(path), doraise=True)
            print(f"OK:   {name} compiles")
        except py_compile.PyCompileError as e:
            print(f"FAIL: {name} -- {e}")
            ok = False
    return ok


def main() -> None:
    results = [
        check_sdk_installed(),
        check_dotenv_installed(),
        check_api_key(),
        check_scripts_compile(),
    ]
    if not all(results):
        sys.exit(1)
    print("\nAll good -- run 01_hello_claude.py to make your first real call.")


if __name__ == "__main__":
    main()
