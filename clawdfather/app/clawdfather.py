"""ClawdFather: the Managed Agent that hires other Managed Agents.

ClawdFather is itself an agent. When it decides to hire someone it calls the
`create_teammate` custom tool; this module answers that call — provisioning the
Slack identity, writing the soul file, and creating the teammate's agent — and
hands the result back over `user.custom_tool_result`.
"""

from __future__ import annotations

import logging
import re

from . import config, managed_agent, registry, slack_client, templates
from . import teammate as teammate_tools
from .prompts import render_soul, system_from_soul

log = logging.getLogger(__name__)


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "teammate"


def _compose(
    template_slug: str | None,
    name: str | None,
    role: str | None,
    instructions: str | None,
    emoji: str | None,
) -> tuple[str, str, str, str, str | None]:
    """Resolve a hire request into (name, role, emoji, soul_body, template_slug).

    A template supplies defaults for everything; anything passed explicitly wins.
    `instructions` given alongside a template is appended rather than replacing
    it, so "a CFO, but we're pre-revenue" keeps the CFO.
    """
    if not template_slug:
        if not (instructions or "").strip():
            raise ValueError(
                "Give either a `template` slug or `instructions`. Available "
                f"templates: {', '.join(templates.slugs())}."
            )
        if not (name or "").strip():
            raise ValueError("`name` is required when no template is given.")
        return (
            name.strip(),
            (role or "Teammate").strip(),
            # slack_client re-wraps this in colons, so ":mag:" must not survive.
            (emoji or "robot_face").strip(":"),
            instructions,
            None,
        )

    tpl = templates.get(template_slug)
    if tpl is None:
        raise ValueError(
            f"No template {template_slug!r}. Available: {', '.join(templates.slugs())}."
        )

    body = tpl.soul
    if (instructions or "").strip():
        body = f"{body}\n\n## For this hire\n\n{instructions.strip()}"

    return (
        (name or tpl.name).strip(),
        (role or tpl.role).strip(),
        (emoji or tpl.emoji).strip(":"),
        body,
        tpl.slug,
    )


def hire(
    *,
    home_channel: str,
    template: str | None = None,
    name: str | None = None,
    role: str | None = None,
    instructions: str | None = None,
    emoji: str | None = None,
) -> registry.Teammate:
    """Provision one teammate end to end."""
    name, role, emoji, soul_body, template_slug = _compose(
        template, name, role, instructions, emoji
    )
    channel_id, channel_name = slack_client.resolve_channel(home_channel)
    slot = registry.claim_slot(name)

    soul = render_soul(name, role, channel_name, soul_body)
    config.SOULS_DIR.mkdir(parents=True, exist_ok=True)
    soul_path = config.SOULS_DIR / f"{_slug(name)}.md"
    soul_path.write_text(soul)

    existing = registry.teammate_by_name(name)
    if existing:
        version = managed_agent.update_agent_system(existing.agent_id, system_from_soul(soul))
        agent_id = existing.agent_id
        log.info("re-hired %s -> agent %s v%s", name, agent_id, version)
    else:
        agent_id, version = managed_agent.create_agent(
            name=name, system=system_from_soul(soul), tools=teammate_tools.TEAMMATE_TOOLS
        )
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
        emoji=emoji,
        template=template_slug,
    )
    registry.save_teammate(teammate)
    return teammate


def handle_tool(name: str, args: dict) -> str:
    """Answer ClawdFather's custom tool calls. Raises on failure so the agent sees it."""
    if name == "create_teammate":
        teammate = hire(
            home_channel=args["home_channel"],
            template=args.get("template"),
            name=args.get("name"),
            role=args.get("role"),
            instructions=args.get("instructions"),
            emoji=args.get("emoji"),
        )
        provenance = f" from the {teammate.template} template" if teammate.template else ""
        return (
            f"Hired {teammate.name} ({teammate.role}).\n"
            f"Slack identity: {teammate.mention} in #{teammate.home_channel_name}.\n"
            f"Managed Agent: {teammate.agent_id} (version {teammate.agent_version}).\n"
            f"Soul written to {teammate.soul_path}{provenance}.\n"
            f"It listens ambiently in #{teammate.home_channel_name} and responds "
            f"to @{teammate.name} anywhere else."
        )

    if name == "list_teammates":
        teammates = registry.all_teammates()
        if not teammates:
            return "No teammates hired yet."
        return "\n".join(
            f"- {t.name} ({t.role}) — lives in #{t.home_channel_name}, "
            f"agent {t.agent_id}" + (f", from template {t.template}" if t.template else "")
            for t in teammates
        )

    raise ValueError(f"Unknown tool {name!r}")
