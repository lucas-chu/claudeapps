"""The Agent SDK lives here.

We hand Claude an objective and a research toolbox, not a script. The only thing
we constrain is the shape of the answer: the run ends when Claude calls
``submit_verdict``, an in-process MCP tool whose schema is the verdict contract.

Two properties are enforced structurally rather than by prompting:

  * Claude can only search and fetch. No Bash, no file access. The agent reads
    attacker-controlled text off the open internet all day; there is nothing for
    a prompt injection to reach for.
  * Every URL that came back from a tool is recorded, so the response guard can
    check citations against pages that actually exist.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    ToolUseBlock,
    create_sdk_mcp_server,
    query,
    tool,
)

from config import Config, config
from context import CheckContext
from prompts import FOLLOWUP_NOTE, OBJECTIVE, STYLE_GUIDANCE, SYSTEM_PROMPT
from verdict import FactCheck, Source

log = logging.getLogger(__name__)

_URL_RE = re.compile(r"https?://[^\s<>\"'\\)\]]+")

VERDICT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "verdict": {
            "type": "string",
            "enum": ["TRUE", "MOSTLY_TRUE", "MISLEADING", "FALSE", "UNVERIFIABLE"],
            "description": (
                "TRUE: accurate and well supported. MOSTLY_TRUE: substantially "
                "accurate with minor imprecision. MISLEADING: literally defensible "
                "but the framing or implication misleads. FALSE: contradicted by "
                "the evidence. UNVERIFIABLE: insufficient or conflicting evidence, "
                "or the claim is an opinion or prediction."
            ),
        },
        "claim": {
            "type": "string",
            "description": "The precise factual claim you assessed, in your own words.",
        },
        "body": {
            "type": "string",
            "description": (
                "The text of your public reply. Plain prose that opens with the "
                "answer - no verdict label, no header, no emoji, no URLs. See the "
                "length limit and style guidance in the task."
            ),
        },
        "sources": {
            "type": "array",
            "minItems": 0,
            "maxItems": 3,
            "description": (
                "Sources you actually retrieved, best first. Citations that were "
                "not retrieved during this investigation are stripped before posting."
            ),
            "items": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Short publisher name as it appears in the reply, e.g. 'EIA'.",
                    },
                    "url": {"type": "string", "description": "The exact URL you retrieved."},
                },
                "required": ["name", "url"],
            },
        },
        "confidence": {
            "type": "string",
            "enum": ["low", "medium", "high"],
            "description": "How strongly the evidence supports the verdict.",
        },
        "notes": {
            "type": "string",
            "description": (
                "Internal only, never posted: sub-claims you decomposed, evidence "
                "that conflicts, and anything you could not resolve."
            ),
        },
    },
    "required": ["verdict", "claim", "body", "sources", "confidence"],
}


@dataclass
class AgentRun:
    fact_check: FactCheck | None = None
    retrieved_urls: set[str] = field(default_factory=set)
    tool_calls: Counter[str] = field(default_factory=Counter)
    tool_errors: Counter[str] = field(default_factory=Counter)
    error: str | None = None

    @property
    def total_tool_calls(self) -> int:
        return sum(self.tool_calls.values())

    def research_summary(self) -> str:
        """One line describing what the research loop actually managed to do.

        Worth surfacing: an environment that blocks WebFetch still produces
        plausible answers off search snippets, just with weaker sourcing. That
        should be visible rather than silent.
        """
        parts = []
        for name, count in sorted(self.tool_calls.items()):
            failed = self.tool_errors.get(name, 0)
            parts.append(f"{name} {count}" + (f" ({failed} failed)" if failed else ""))
        return ", ".join(parts) or "no tools used"


def _harvest_urls(message: Any, sink: set[str]) -> None:
    """Record URLs that came back from tools.

    Only two things count: pages the agent asked WebFetch to retrieve, and URLs
    present in tool *results*. Text the model wrote is deliberately ignored -
    that is exactly the channel a hallucinated citation would arrive on.
    """
    blocks = getattr(message, "content", None)
    if not isinstance(blocks, list):
        return  # a plain-string message is our own prompt, not tool output
    for block in blocks:
        if isinstance(block, ToolUseBlock):
            if block.name.endswith("WebFetch"):
                url = (block.input or {}).get("url")
                if isinstance(url, str):
                    sink.add(url.rstrip(".,);"))
            continue
        # Tool results arrive as blocks carrying `content`; the shape varies by
        # tool, so match URLs out of the rendered payload.
        payload = getattr(block, "content", None)
        if payload is not None:
            sink.update(u.rstrip(".,);") for u in _URL_RE.findall(str(payload)))


def _tool_result_failed(block: Any) -> bool:
    if getattr(block, "is_error", False):
        return True
    payload = str(getattr(block, "content", "") or "").lower()
    return any(
        marker in payload
        for marker in ("socket closed", "connection error", "failed to fetch", "econnrefused")
    )


def _build_verdict_server(captured: dict[str, Any]):
    """One MCP server per run, closing over this run's capture slot."""

    @tool(
        "submit_verdict",
        "Submit your final fact-check. Call this exactly once, when the "
        "investigation is complete. This is what gets posted to X.",
        VERDICT_SCHEMA,
    )
    async def submit_verdict(args: dict[str, Any]) -> dict[str, Any]:
        if captured:
            return {
                "content": [
                    {
                        "type": "text",
                        "text": "A verdict was already submitted for this check. Stop here.",
                    }
                ],
                "is_error": True,
            }
        captured.update(args)
        return {
            "content": [
                {"type": "text", "text": f"Verdict recorded: {args.get('verdict')}. Investigation complete."}
            ]
        }

    return create_sdk_mcp_server(name="verdict", version="1.0.0", tools=[submit_verdict])


def _to_fact_check(raw: dict[str, Any]) -> FactCheck:
    sources = [
        Source(name=str(s.get("name", "")).strip(), url=str(s.get("url", "")).strip())
        for s in raw.get("sources") or []
        if isinstance(s, dict) and s.get("url")
    ]
    return FactCheck(
        verdict=str(raw.get("verdict", "UNVERIFIABLE")).upper().replace(" ", "_"),
        claim=str(raw.get("claim", "")).strip(),
        body=str(raw.get("body", "")).strip(),
        sources=sources,
        confidence=str(raw.get("confidence", "medium")).lower(),
        notes=str(raw.get("notes", "")).strip(),
    )


async def fact_check(ctx: CheckContext, cfg: Config = config) -> AgentRun:
    """Investigate the claim in ``ctx`` and return a structured verdict."""
    captured: dict[str, Any] = {}
    run = AgentRun()

    # Reserve room for the sources line, plus the verdict header in card style.
    reserved = 90 if cfg.reply_style == "card" else 75
    budget = max(120, cfg.max_post_chars - reserved)
    style_guidance = STYLE_GUIDANCE.get(cfg.reply_style, STYLE_GUIDANCE["conversational"])

    prompt = OBJECTIVE.format(
        today=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        context=ctx.render(),
        style=style_guidance.format(budget=budget),
    )
    if ctx.is_followup:
        prompt = f"{prompt}\n{FOLLOWUP_NOTE}"

    options = ClaudeAgentOptions(
        system_prompt=SYSTEM_PROMPT,
        model=cfg.model,
        effort=cfg.effort,
        max_turns=cfg.max_turns,
        # Research tools only - no Bash, no filesystem, nothing with side effects.
        tools=["WebSearch", "WebFetch"],
        allowed_tools=["WebSearch", "WebFetch", "mcp__verdict__submit_verdict"],
        mcp_servers={"verdict": _build_verdict_server(captured)},
        permission_mode="dontAsk",
        setting_sources=[],  # ignore any CLAUDE.md / settings on the host
    )

    tool_names: dict[str, str] = {}  # tool_use id -> tool name, to attribute results

    try:
        async with asyncio.timeout(cfg.timeout_seconds):
            async for message in query(prompt=prompt, options=options):
                _harvest_urls(message, run.retrieved_urls)
                if isinstance(message, AssistantMessage):
                    for block in message.content:
                        if isinstance(block, ToolUseBlock):
                            run.tool_calls[block.name] += 1
                            tool_names[block.id] = block.name
                            log.debug("tool: %s %s", block.name, block.input)
                elif isinstance(message, ResultMessage):
                    log.info(
                        "Agent finished (%s): %s, %d URLs retrieved",
                        message.subtype,
                        run.research_summary(),
                        len(run.retrieved_urls),
                    )
                for block in getattr(message, "content", None) or []:
                    use_id = getattr(block, "tool_use_id", None)
                    if use_id and _tool_result_failed(block):
                        run.tool_errors[tool_names.get(use_id, "unknown")] += 1
    except TimeoutError:
        run.error = f"investigation exceeded {cfg.timeout_seconds}s"
        log.warning("Fact-check timed out for mention %s", ctx.mention.id)
    except Exception as exc:  # noqa: BLE001 - one bad mention must not kill the loop
        run.error = f"{type(exc).__name__}: {exc}"
        log.exception("Fact-check failed for mention %s", ctx.mention.id)

    if captured:
        run.fact_check = _to_fact_check(captured)
    elif run.error is None:
        run.error = "agent never called submit_verdict"
        log.warning("No verdict submitted for mention %s", ctx.mention.id)

    return run
