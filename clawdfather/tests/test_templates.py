"""Base personalities: loading, and how a hire request resolves against one."""

import pytest

from app import templates
from app.clawdfather import _compose

# --- loading --------------------------------------------------------------


def test_templates_are_installed():
    assert len(templates.all_templates()) >= 5
    assert "fractional-cfo" in templates.slugs()


def test_every_template_parses_and_is_complete():
    """A malformed template must fail here, not at hire time in front of a demo."""
    for t in templates.all_templates():
        assert t.name and t.role and t.emoji and t.summary, t.slug
        assert len(t.soul.splitlines()) >= 5, f"{t.slug} soul is too thin"
        assert ":" not in t.emoji, f"{t.slug} emoji should have no colons"
        assert "\n" not in t.summary, f"{t.slug} summary must be one line"


def test_souls_are_second_person_and_distinct():
    souls = {t.slug: t.soul for t in templates.all_templates()}
    for slug, soul in souls.items():
        assert soul.lstrip().startswith("You are"), f"{slug} should address the teammate"
    assert len(set(souls.values())) == len(souls), "templates must not be copies"


def test_lookup_is_forgiving_but_not_fuzzy():
    assert templates.get("  FRACTIONAL-CFO ").slug == "fractional-cfo"
    assert templates.get("cfo") is None
    assert templates.get("") is None


def test_catalog_is_one_line_per_template():
    lines = templates.catalog().splitlines()
    assert len(lines) == len(templates.all_templates())
    assert all(line.startswith("- ") for line in lines)


# --- resolving a hire request ---------------------------------------------


def test_template_supplies_every_default():
    name, role, emoji, soul, slug = _compose("fractional-cfo", None, None, None, None)
    tpl = templates.get("fractional-cfo")
    assert (name, role, emoji, slug) == (tpl.name, tpl.role, tpl.emoji, "fractional-cfo")
    assert soul == tpl.soul


def test_explicit_values_beat_template_defaults():
    name, role, emoji, _, _ = _compose(
        "fractional-cfo", "Penny", "Head of Finance", None, "moneybag"
    )
    assert (name, role, emoji) == ("Penny", "Head of Finance", "moneybag")


def test_instructions_append_to_a_template_rather_than_replacing_it():
    """'a CFO, but we're pre-revenue' must still be a CFO."""
    _, _, _, soul, _ = _compose("fractional-cfo", None, None, "We are pre-revenue.", None)
    assert templates.get("fractional-cfo").soul in soul
    assert "We are pre-revenue." in soul
    assert soul.index("## For this hire") > soul.index("fractional CFO")


def test_freehand_hire_still_works_without_a_template():
    name, role, emoji, soul, slug = _compose(None, "Odd", None, "You are unusual.", None)
    assert (name, role, emoji, soul, slug) == (
        "Odd",
        "Teammate",
        "robot_face",
        "You are unusual.",
        None,
    )


@pytest.mark.parametrize(
    "template,name,instructions",
    [("fractional-cfo", None, None), (None, "Odd", "You are unusual.")],
)
def test_emoji_colons_are_stripped(template, name, instructions):
    """Both paths: slack_client wraps this in colons, so '::mag::' would break."""
    _, _, emoji, _, _ = _compose(template, name, None, instructions, ":moneybag:")
    assert emoji == "moneybag"


# --- refusals that should reach the agent as a usable error ---------------


def test_unknown_template_lists_the_real_ones():
    with pytest.raises(ValueError, match="fractional-cfo"):
        _compose("cfo-but-cooler", None, None, None, None)


def test_neither_template_nor_instructions_is_refused():
    with pytest.raises(ValueError, match="template"):
        _compose(None, "Nameless", None, "   ", None)


def test_freehand_without_a_name_is_refused():
    with pytest.raises(ValueError, match="name"):
        _compose(None, None, None, "You are unusual.", None)


# --- the catalog actually reaches ClawdFather -----------------------------


def test_clawdfather_prompt_carries_the_catalog():
    from app.prompts import clawdfather_system

    prompt = clawdfather_system()
    assert "fractional-cfo" in prompt
    assert "{catalog}" not in prompt, "placeholder was not substituted"
    for slug in templates.slugs():
        assert slug in prompt
