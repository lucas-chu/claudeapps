"""Base personalities — reusable starting souls for new teammates.

Each `templates/<slug>.md` is frontmatter plus a soul body:

    ---
    name: Ledger
    role: Fractional CFO
    emoji: chart_with_upwards_trend
    summary: One line ClawdFather sees in its catalog.
    ---
    You are the company's fractional CFO. ...

ClawdFather only ever sees the catalog (slug, role, summary — one line each), so
adding a template costs ~1 line of its context rather than a whole soul. The
body is resolved here, at hire time, when a `template` is named.

The frontmatter parser is deliberately hand-rolled: the format is a flat
`key: value` block and this keeps the runtime free of a YAML dependency.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from .config import ROOT

TEMPLATES_DIR = ROOT / "templates"
_FIELDS = ("name", "role", "emoji", "summary")


@dataclass(frozen=True)
class Template:
    slug: str
    name: str
    role: str
    emoji: str
    summary: str
    soul: str


def _parse(slug: str, text: str) -> Template:
    if not text.startswith("---"):
        raise ValueError(f"template {slug!r} has no frontmatter block")
    _, frontmatter, body = text.split("---", 2)

    meta: dict[str, str] = {}
    for line in frontmatter.strip().splitlines():
        if not line.strip():
            continue
        key, sep, value = line.partition(":")
        if not sep:
            raise ValueError(f"template {slug!r}: bad frontmatter line {line!r}")
        meta[key.strip()] = value.strip()

    missing = [f for f in _FIELDS if not meta.get(f)]
    if missing:
        raise ValueError(f"template {slug!r} is missing frontmatter: {', '.join(missing)}")
    if not body.strip():
        raise ValueError(f"template {slug!r} has an empty soul body")

    return Template(slug=slug, soul=body.strip(), **{f: meta[f] for f in _FIELDS})


@lru_cache(maxsize=1)
def all_templates() -> tuple[Template, ...]:
    """Every template on disk, sorted by slug. Cached — these do not change at runtime."""
    if not TEMPLATES_DIR.is_dir():
        return ()
    return tuple(_parse(path.stem, path.read_text()) for path in sorted(TEMPLATES_DIR.glob("*.md")))


def get(slug: str) -> Template | None:
    wanted = slug.strip().lower()
    return next((t for t in all_templates() if t.slug == wanted), None)


def slugs() -> list[str]:
    return [t.slug for t in all_templates()]


def catalog() -> str:
    """The one-line-per-template listing injected into ClawdFather's prompt."""
    templates = all_templates()
    if not templates:
        return "(no templates installed)"
    width = max(len(t.slug) for t in templates)
    return "\n".join(f"- {t.slug:<{width}}  {t.role} — {t.summary}" for t in templates)
