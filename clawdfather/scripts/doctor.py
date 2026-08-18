"""Preflight check — run before demoing.

Validates everything that can only fail at runtime: tokens, scopes, bot IDs,
channel membership, and whether the Anthropic objects in .env still resolve.
Every failure prints the fix.

    python -m scripts.doctor
"""

from __future__ import annotations

import sys

from app import config, registry

OK, BAD, WARN = "\033[32m✓\033[0m", "\033[31m✗\033[0m", "\033[33m!\033[0m"

_failures: list[str] = []
_warnings: list[str] = []


def ok(msg: str) -> None:
    print(f"  {OK} {msg}")


def bad(msg: str, fix: str) -> None:
    print(f"  {BAD} {msg}\n      → {fix}")
    _failures.append(msg)


def warn(msg: str, note: str) -> None:
    print(f"  {WARN} {msg}\n      → {note}")
    _warnings.append(msg)


def _slack_error(exc: Exception) -> str:
    """Slack API errors carry a reason; connectivity errors do not."""
    from slack_sdk.errors import SlackApiError

    if isinstance(exc, SlackApiError):
        return str(exc.response.get("error", exc))
    return f"cannot reach Slack: {type(exc).__name__}"


def _scopes(response) -> set[str]:
    """Granted bot scopes, read off the x-oauth-scopes response header."""
    headers = getattr(response, "headers", {}) or {}
    raw = headers.get("x-oauth-scopes") or headers.get("X-OAuth-Scopes") or ""
    if isinstance(raw, list):
        raw = raw[0] if raw else ""
    return {s.strip() for s in raw.split(",") if s.strip()}


# ---------------------------------------------------------------------------


def check_env() -> None:
    print("\nEnvironment")
    required = {
        "ANTHROPIC_API_KEY": config.ANTHROPIC_API_KEY,
        "ENVIRONMENT_ID": config.ENVIRONMENT_ID,
        "CLAWDFATHER_AGENT_ID": config.CLAWDFATHER_AGENT_ID,
        "SLACK_BOT_TOKEN": config.SLACK_BOT_TOKEN,
        "SLACK_APP_TOKEN": config.SLACK_APP_TOKEN,
    }
    for name, value in required.items():
        if value:
            ok(f"{name} set")
        else:
            bad(
                f"{name} is not set",
                "cp .env.example .env, then fill it in "
                "(ENVIRONMENT_ID / CLAWDFATHER_AGENT_ID come from `python -m scripts.setup`)",
            )

    if config.SLACK_APP_TOKEN and not config.SLACK_APP_TOKEN.startswith("xapp-"):
        bad(
            "SLACK_APP_TOKEN is not an app-level token",
            "it must start with xapp- (Basic Information → App-Level Tokens), not xoxb-",
        )
    if config.SLACK_BOT_TOKEN and not config.SLACK_BOT_TOKEN.startswith("xoxb-"):
        bad("SLACK_BOT_TOKEN is not a bot token", "it must start with xoxb-")

    pool = config.identity_pool()
    if pool:
        ok(f"{len(pool)} teammate identity slot(s): {[s.index for s in pool]}")
    else:
        bad(
            "no teammate identities configured",
            "add SLACK_TEAMMATE_1_BOT_TOKEN and SLACK_TEAMMATE_1_USER_ID to .env",
        )


def check_anthropic() -> None:
    print("\nAnthropic")
    if not config.ANTHROPIC_API_KEY:
        return
    from app import managed_agent

    client = managed_agent.client
    try:
        client.models.retrieve(config.TEAMMATE_MODEL)
        ok(f"API key works; {config.TEAMMATE_MODEL} available")
    except Exception as exc:
        bad(f"API key rejected or model unavailable ({exc})", "check ANTHROPIC_API_KEY")
        return

    if config.ENVIRONMENT_ID:
        try:
            env = client.beta.environments.retrieve(config.ENVIRONMENT_ID)
            ok(f"environment {env.id} resolves")
        except Exception as exc:
            bad(f"ENVIRONMENT_ID does not resolve ({exc})", "re-run `python -m scripts.setup`")

    if config.CLAWDFATHER_AGENT_ID:
        try:
            agent = client.beta.agents.retrieve(config.CLAWDFATHER_AGENT_ID)
        except Exception as exc:
            bad(
                f"CLAWDFATHER_AGENT_ID does not resolve ({exc})",
                "re-run `python -m scripts.setup`",
            )
            return
        tools = {getattr(t, "name", None) for t in (agent.tools or [])}
        if "create_teammate" in tools:
            ok(f"ClawdFather agent {agent.id} has its hiring tools")
        else:
            bad(
                "ClawdFather agent is missing the create_teammate tool",
                'run `python -c "from app import slack; slack.ensure_clawdfather_tools()"`',
            )


def check_slack() -> None:
    print("\nSlack — router app")
    if not config.SLACK_BOT_TOKEN:
        return
    from app import slack_client

    try:
        auth = slack_client.router().auth_test()
    except Exception as exc:
        bad(
            f"router token unusable ({_slack_error(exc)})",
            "re-copy the Bot User OAuth Token from the ClawdFather app, "
            "and check this machine can reach slack.com",
        )
        return

    ok(f"ClawdFather is <@{auth['user_id']}> in workspace '{auth['team']}'")

    granted = _scopes(auth)
    needed = {
        "channels:history": "it cannot see channel messages — routing will never fire",
        "chat:write": "it cannot post at all",
        "chat:write.customize": "teammates will post under the pool app's name",
        "channels:read": "it cannot resolve channel names at hire time",
        "channels:manage": "it cannot auto-invite teammates; you'd /invite by hand",
    }
    if not granted:
        warn("could not read granted scopes", "Slack did not return x-oauth-scopes")
    for scope, consequence in needed.items():
        if scope in granted:
            ok(f"scope {scope}")
        else:
            bad(f"missing scope {scope}", f"{consequence}. Add it and reinstall the app")

    print("\nSlack — teammate identity pool")
    for slot in config.identity_pool():
        client = slack_client.for_slot(slot)
        try:
            info = client.auth_test()
        except Exception as exc:
            bad(
                f"slot {slot.index}: token unusable ({_slack_error(exc)})",
                f"re-copy SLACK_TEAMMATE_{slot.index}_BOT_TOKEN",
            )
            continue
        if info["user_id"] != slot.bot_user_id:
            bad(
                f"slot {slot.index}: token belongs to {info['user_id']}, "
                f"but SLACK_TEAMMATE_{slot.index}_USER_ID says {slot.bot_user_id}",
                "the token and user ID are from different apps — re-copy both from "
                "the same app (App Home shows the bot user ID)",
            )
            continue
        slot_scopes = _scopes(info)
        missing = {"chat:write", "chat:write.customize", "reactions:write"} - slot_scopes
        if missing and slot_scopes:
            bad(
                f"slot {slot.index} ({info['user']}): missing {', '.join(sorted(missing))}",
                "add the scope and reinstall that teammate app",
            )
        else:
            ok(f"slot {slot.index}: {info['user']} <@{info['user_id']}>")


def check_channels() -> None:
    print("\nChannels")
    if not config.SLACK_BOT_TOKEN:
        return
    from app import slack_client

    # Page through: a workspace with more than one page of channels would
    # otherwise look like the bot had joined nothing.
    joined: list[str] = []
    cursor = None
    try:
        while True:
            resp = slack_client.router().conversations_list(
                types="public_channel,private_channel",
                limit=200,
                exclude_archived=True,
                cursor=cursor,
            )
            joined += [c["name"] for c in resp["channels"] if c.get("is_member")]
            cursor = resp.get("response_metadata", {}).get("next_cursor")
            if not cursor:
                break
    except Exception as exc:
        bad(f"cannot list channels ({_slack_error(exc)})", "add the channels:read scope")
        return

    if joined:
        ok(f"ClawdFather is in: {', '.join('#' + n for n in sorted(joined))}")
    else:
        bad(
            "ClawdFather is not in any channel",
            "/invite @ClawdFather in the channels you'll demo in — it cannot see "
            "messages in channels it hasn't joined",
        )

    for teammate in registry.all_teammates():
        if teammate.home_channel_name in joined:
            ok(f"{teammate.name}'s home #{teammate.home_channel_name} is watched")
        else:
            warn(
                f"{teammate.name}'s home #{teammate.home_channel_name} is not watched",
                "/invite @ClawdFather there, or ambient listening won't fire",
            )


def check_registry() -> None:
    print("\nRegistry")
    teammates = registry.all_teammates()
    if not teammates:
        ok("no teammates hired yet (expected on a fresh setup)")
        return
    from app import managed_agent

    pool_indexes = {s.index for s in config.identity_pool()}
    for teammate in teammates:
        if teammate.slot_index not in pool_indexes:
            bad(
                f"{teammate.name} is bound to slot {teammate.slot_index}, which is "
                "no longer in .env",
                "restore that SLACK_TEAMMATE_N_* pair, or delete data/registry.json and re-hire",
            )
        elif not (config.ROOT / teammate.soul_path).exists():
            bad(
                f"{teammate.name}'s soul file {teammate.soul_path} is missing",
                "re-hire the teammate to regenerate it",
            )
        else:
            ok(f"{teammate.name} → slot {teammate.slot_index}, #{teammate.home_channel_name}")

        try:
            agent = managed_agent.client.beta.agents.retrieve(teammate.agent_id)
            tools = {getattr(t, "name", None) for t in (agent.tools or [])}
            if "message_teammate" not in tools:
                warn(
                    f"{teammate.name}'s agent predates message_teammate/add_reaction",
                    'run `python -c "from app import slack; slack.ensure_teammate_tools()"`',
                )
        except Exception as exc:
            warn(f"{teammate.name}'s agent {teammate.agent_id} could not be checked", str(exc))


def main() -> int:
    print("ClawdFather preflight")
    check_env()
    check_anthropic()
    check_slack()
    check_channels()
    check_registry()

    print()
    if _failures:
        print(f"{BAD} {len(_failures)} problem(s) to fix before running.")
        return 1
    if _warnings:
        print(f"{WARN} {len(_warnings)} warning(s), but nothing blocking.")
    else:
        print(f"{OK} All checks passed — `python -m app.slack` should work.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
