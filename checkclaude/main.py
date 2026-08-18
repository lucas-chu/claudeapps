"""CheckClaude: mention -> context -> agent -> guard -> reply.

    python main.py                      # run the bot
    python main.py --once <post-url>    # check one post and print the reply
    python main.py --dry-run            # run the loop, never post
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import re
import sys
from dataclasses import replace

from agent import fact_check
from config import config
from context import CheckContext, build_context, extract_links, is_trigger
from store import Store
from verdict import guard
from x_client import Post, XClient

log = logging.getLogger("checkclaude")


async def handle(client: XClient, store: Store, mention: Post) -> str | None:
    """Run one mention end to end. Returns the posted reply text, if any."""
    prior = None
    if mention.parent_id:
        record = store.prior_check_for_reply(mention.parent_id)
        if record:
            prior = record.reply_text

    ctx = await build_context(client, mention, prior_check=prior)
    if ctx is None:
        log.info("Mention %s has no checkable claim; skipping", mention.id)
        return None

    log.info(
        "Checking %s (claim post %s by @%s)%s",
        mention.id,
        ctx.claim_post.id,
        ctx.claim_post.author_handle,
        " [follow-up]" if ctx.is_followup else "",
    )

    run = await fact_check(ctx)
    if run.fact_check is None:
        # No verdict means no reply. Silence beats a confident guess. Releasing
        # the claim leaves the mention eligible for a retry (on stream redelivery
        # or a restart) rather than permanently recording it as handled.
        log.warning("No verdict for %s (%s); staying silent", mention.id, run.error)
        store.release(mention.id)
        return None

    reply = guard(run.fact_check, run.retrieved_urls, config.max_post_chars, config.reply_style)
    for warning in reply.warnings:
        log.warning("guard[%s]: %s", mention.id, warning)
    if run.fact_check.notes:
        log.info("notes[%s]: %s", mention.id, run.fact_check.notes)

    reply_id = await client.reply(mention.id, reply.text)
    store.record(mention.id, reply_id, reply.fact_check.verdict, reply.text)
    log.info("Posted verdict %s for %s", reply.fact_check.verdict, mention.id)
    return reply.text


async def run_bot() -> None:
    client = XClient()
    store = Store(config.db_path)
    log.info(
        "Listening for @%s (mode=%s, dry_run=%s)",
        config.bot_handle,
        config.ingest_mode,
        config.dry_run,
    )
    try:
        async for mention in client.listen_for_mentions(since_id=store.latest_mention_id()):
            if not is_trigger(mention):
                continue
            if not store.claim(mention.id, mention.parent_id or mention.id):
                continue  # already handled
            try:
                await handle(client, store, mention)
            except Exception:  # noqa: BLE001 - never let one mention kill the loop
                log.exception("Unhandled error on mention %s", mention.id)
                store.release(mention.id)
    finally:
        store.close()


def parse_post_id(target: str) -> str | None:
    """Accept a post URL or a bare id. Usernames can contain digits, so the
    /status/ segment wins over anything earlier in the URL."""
    in_url = re.search(r"/status(?:es)?/(\d{5,25})", target)
    if in_url:
        return in_url.group(1)
    bare = re.fullmatch(r"\s*(\d{5,25})\s*", target)
    return bare.group(1) if bare else None


async def run_once(target: str, question: str) -> int:
    """Check a single post by URL or id and print the reply without posting."""
    post_id = parse_post_id(target)
    if not post_id:
        print(f"Could not find a post id in {target!r}", file=sys.stderr)
        return 2

    client = XClient()
    post = await client.get_post(post_id)
    if post is None:
        print(f"Could not fetch post {post_id}", file=sys.stderr)
        return 2

    # Synthesise the mention that would have triggered this check.
    mention = replace(
        post,
        id=f"local-{post.id}",
        text=f"@{config.bot_handle} {question}",
        author_handle="you",
        author_name="",
    )
    ctx = CheckContext(
        mention=mention,
        claim_post=post,
        question=question,
        thread=await client.get_thread(post),
        links=extract_links(post),
    )

    run = await fact_check(ctx)
    if run.fact_check is None:
        print(f"No verdict: {run.error}", file=sys.stderr)
        return 1

    reply = guard(run.fact_check, run.retrieved_urls, config.max_post_chars, config.reply_style)
    print("\n--- reply ---")
    print(reply.text)
    print("--- /reply ---\n")
    print(f"claim:      {reply.fact_check.claim}")
    print(f"confidence: {reply.fact_check.confidence}")
    print(f"research:   {run.research_summary()}")
    for sub in reply.fact_check.sub_claims:
        print(f"sub-claim:  [{sub.verdict}] {sub.claim}")
        if sub.finding:
            print(f"            {sub.finding}")
        for source in sub.sources:
            print(f"            {source.name} {source.url}")
    if reply.fact_check.notes:
        print(f"notes:      {reply.fact_check.notes}")
    for source in reply.fact_check.sources:
        print(f"source:     {source.name} {source.url}")
    for warning in reply.warnings:
        print(f"warning:    {warning}")
    return 0


# Libraries that log credentials at DEBUG. oauthlib prints the signature base
# string, which embeds the consumer key and the access token in cleartext, so
# `-v` output would otherwise be unsafe to paste, screen-share, or redirect to
# a file. Muting these is a security control, not tidiness.
CREDENTIAL_LEAKING_LOGGERS = ("oauthlib", "requests_oauthlib")


def configure_logging(verbose: bool = False) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    for name in ("httpx", "urllib3", *CREDENTIAL_LEAKING_LOGGERS):
        logging.getLogger(name).setLevel(logging.WARNING)


def main() -> int:
    parser = argparse.ArgumentParser(description="CheckClaude - fact-check X posts by mention")
    parser.add_argument("--once", metavar="POST", help="check one post URL or id, print, don't post")
    parser.add_argument("--question", default="Is this true?", help="question to ask with --once")
    parser.add_argument("--dry-run", action="store_true", help="run the loop but never post")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    configure_logging(args.verbose)

    if args.dry_run:
        object.__setattr__(config, "dry_run", True)

    try:
        if args.once:
            return asyncio.run(run_once(args.once, args.question))
        asyncio.run(run_bot())
    except KeyboardInterrupt:
        log.info("Shutting down")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
