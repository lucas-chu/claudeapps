"""ClawdFather: the Managed Agent that hires other Managed Agents.

ClawdFather is itself an agent. When it decides to hire someone it calls the
`create_teammate` custom tool; this module answers that call — provisioning the
Slack identity, writing the soul file, and creating the teammate's agent — and
hands the result back over `user.custom_tool_result`.
"""

from __future__ import annotations

import logging
import re

from . import config, managed_agent, registry, slack_client
from .prompts import render_soul, system_from_soul

log = logging.getLogger(__name__)


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "teammate"


def hire(
    *,
    name: str,
    role: str,
    instructions: str,
    home_channel: str,
    emoji: str = "robot_face",
) -> registry.Teammate:
    """Provision one teammate end to end."""
    channel_id, channel_name = slack_client.resolve_channel(home_channel)
    slot = registry.claim_slot(name)

    soul = render_soul(name, role, channel_name, instructions)
    config.SOULS_DIR.mkdir(parents=True, exist_ok=True)
    soul_path = config.SOULS_DIR / f"{_slug(name)}.md"
    soul_path.write_text(soul)

    existing = registry.teammate_by_name(name)
    if existing:
        version = managed_agent.update_agent_system(existing.agent_id, system_from_soul(soul))
        agent_id = existing.agent_id
        log.info("re-hired %s -> agent %s v%s", name, agent_id, version)
    else:
        agent_id, version = managed_agent.create_agent(name=name, system=system_from_soul(soul))
        log.info("hired %s -> agent %s v%s", name, agent_id, version)

    slack_client.set_bot_profile(slot, display_name=name, real_name=f"{name} · {role}")
    slack_client.invite_to_channel(channel_id, slot.bot_user_id)

    teammate = registry.Teammate(
        name=name,
        role=role,
        home_channel=channel_id,
        home_channel_name=channel_name,
        agent_id=agent_id,
        agent_version=version,
        slot_index=slot.index,
        bot_user_id=slot.bot_user_id,
        soul_path=str(soul_path.relative_to(config.ROOT)),
        emoji=emoji or "robot_face",
    )
    registry.save_teammate(teammate)
    return teammate


def handle_tool(name: str, args: dict) -> str:
    """Answer ClawdFather's custom tool calls. Raises on failure so the agent sees it."""
    if name == "create_teammate":
        teammate = hire(
            name=args["name"].strip(),
            role=args["role"].strip(),
            instructions=args["instructions"],
            home_channel=args["home_channel"],
            emoji=(args.get("emoji") or "robot_face").strip(":"),
        )
        return (
            f"Hired {teammate.name} ({teammate.role}).\n"
            f"Slack identity: {teammate.mention} in #{teammate.home_channel_name}.\n"
            f"Managed Agent: {teammate.agent_id} (version {teammate.agent_version}).\n"
            f"Soul written to {teammate.soul_path}.\n"
            f"It listens ambiently in #{teammate.home_channel_name} and responds "
            f"to @{teammate.name} anywhere else."
        )

    if name == "list_teammates":
        teammates = registry.all_teammates()
        if not teammates:
            return "No teammates hired yet."
        return "\n".join(
            f"- {t.name} ({t.role}) — lives in #{t.home_channel_name}, agent {t.agent_id}"
            for t in teammates
        )

    raise ValueError(f"Unknown tool {name!r}")
