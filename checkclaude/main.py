"""CheckClaude: request -> context -> agent -> guard -> answer.

Two channels, one investigation. A public @mention is answered in the thread, as a
numbered self-reply thread when the answer is worth more than one post. A DM is
answered in that DM and nowhere else, unabridged - somebody who asked privately
did not ask for a public post about it.

    python main.py                      # run the bot
    python main.py --once <post-url>    # check one post and print the reply
    python main.py --once <url> --dm    # print it as the private DM answer
    python main.py --dry-run            # run both loops, never post
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from dataclasses import replace

from agent import fact_check
from config import config
from context import PUBLIC as PUBLIC_CHANNEL
from context import (
    DM,
    CheckContext,
    build_context,
    build_dm_context,
    extract_links,
    is_trigger,
    parse_post_id,
)
from store import DM as DM_ROW
from store import Store
from verdict import guard
from x_client import DirectMessage, Post, XClient

log = logging.getLogger("checkclaude")

# Sent when a DM arrives with nothing checkable in it. Silence is fine in a public
# thread, where a non-answer is invisible; in a DM it just looks broken.
DM_HELP = (
    "Send me a post link, or the claim in your own words, and I'll check it. "
    "Whatever you send here I answer here - I don't post about DMs publicly."
)


async def handle(client: XClient, store: Store, mention: Post) -> str | None:
    """Run one public mention end to end. Returns what was posted, if anything."""
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

    reply = guard(
        run.fact_check,
        run.retrieved_urls,
        config.max_post_chars,
        config.reply_style,
        config.thread_posts,
    )
    for warning in reply.warnings:
        log.warning("guard[%s]: %s", mention.id, warning)
    if run.fact_check.notes:
        log.info("notes[%s]: %s", mention.id, run.fact_check.notes)

    # The answer outran even the thread. Offer the unabridged version privately,
    # and only mention it publicly once it has actually been delivered - plenty of
    # accounts refuse DMs from strangers, and a promised DM that never arrives is
    # worse than a slightly shorter answer.
    if reply.truncated and config.dm_enabled and config.dm_overflow:
        delivered = await client.dm_user(mention.author_id, reply.long_form(config.max_dm_chars))
        if delivered:
            reply.add_dm_notice()
            log.info("DMed the full answer to @%s and pointed at it", mention.author_handle)

    reply_ids = await client.reply_thread(mention.id, reply.posts)
    store.record(mention.id, reply_ids, reply.fact_check.verdict, reply.thread_text)
    log.info(
        "Posted verdict %s for %s across %d post(s)",
        reply.fact_check.verdict,
        mention.id,
        len(reply.posts),
    )
    return reply.thread_text


async def handle_dm(client: XClient, store: Store, dm: DirectMessage) -> str | None:
    """Run one DM end to end. The answer goes back to that conversation only.

    The guard runs exactly as it does in public - a smaller audience is not a
    lower evidence bar - but the rendering is the unabridged one, since the 280
    characters were a property of a post and never of the answer.
    """
    record = store.prior_check_in_conversation(dm.conversation_id)
    ctx = await build_dm_context(client, dm, prior_check=record.reply_text if record else None)
    if ctx is None:
        log.info("DM %s has nothing checkable; asking for a claim", dm.id)
        await client.send_dm(dm.conversation_id, DM_HELP)
        store.record(dm.id, None, "NONE", "")
        return None

    log.info(
        "Checking DM %s from @%s (claim %s)%s",
        dm.id,
        dm.sender_handle or dm.sender_id,
        "in the message" if ctx.claim_is_the_request else ctx.claim_post.id,
        " [follow-up]" if ctx.is_followup else "",
    )

    run = await fact_check(ctx)
    if run.fact_check is None:
        log.warning("No verdict for DM %s (%s); staying silent", dm.id, run.error)
        store.release(dm.id)
        return None

    reply = guard(run.fact_check, run.retrieved_urls, config.max_dm_chars, config.reply_style)
    for warning in reply.warnings:
        log.warning("guard[dm %s]: %s", dm.id, warning)
    if run.fact_check.notes:
        log.info("notes[dm %s]: %s", dm.id, run.fact_check.notes)

    text = reply.long_form(config.max_dm_chars)
    event_id = await client.send_dm(dm.conversation_id, text)
    store.record(dm.id, event_id, reply.fact_check.verdict, text)
    log.info("Answered DM %s privately with verdict %s", dm.id, reply.fact_check.verdict)
    return text


async def mention_loop(client: XClient, store: Store) -> None:
    log.info("Listening for @%s (mode=%s)", config.bot_handle, config.ingest_mode)
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


async def dm_loop(client: XClient, store: Store) -> None:
    """The private channel. Any DM is a request - there is no handle to look for."""
    log.info("Listening for DMs (every %ds)", config.dm_poll_seconds)
    async for dm in client.listen_for_dms(since_id=store.latest_dm_event_id()):
        if not store.claim(dm.id, dm.conversation_id, DM_ROW):
            continue  # already handled
        try:
            await handle_dm(client, store, dm)
        except Exception:  # noqa: BLE001 - one bad DM must not kill the loop
            log.exception("Unhandled error on DM %s", dm.id)
            store.release(dm.id)


async def run_bot() -> None:
    client = XClient()
    store = Store(config.db_path)
    log.info(
        "Starting CheckClaude (dms=%s, thread_posts=%d, dry_run=%s)",
        config.dm_enabled,
        config.thread_posts,
        config.dry_run,
    )
    tasks = [asyncio.create_task(mention_loop(client, store), name="mentions")]
    if config.dm_enabled:
        tasks.append(asyncio.create_task(dm_loop(client, store), name="dms"))
    try:
        # Each loop already survives a bad request on its own, so anything that
        # escapes one is fatal to it. Stop the other rather than run half a bot
        # that looks healthy.
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
        for task in pending:
            task.cancel()
        for task in done:
            task.result()
    finally:
        store.close()


async def run_once(target: str, question: str, as_dm: bool = False) -> int:
    """Check a single post by URL or id and print the answer without sending it.

    ``as_dm`` rehearses the private path instead of the public one: same
    investigation, same guard, unabridged rendering.
    """
    post_id = parse_post_id(target)
    if not post_id:
        print(f"Could not find a post id in {target!r}", file=sys.stderr)
        return 2

    client = XClient()
    post = await client.get_post(post_id)
    if post is None:
        print(f"Could not fetch post {post_id}", file=sys.stderr)
        return 2

    # Synthesise the request that would have triggered this check.
    request = replace(
        post,
        id=f"local-{post.id}",
        text=question if as_dm else f"@{config.bot_handle} {question}",
        author_handle="you",
        author_name="",
    )
    ctx = CheckContext(
        mention=request,
        claim_post=post,
        question=question,
        thread=await client.get_thread(post),
        links=extract_links(post),
        channel=DM if as_dm else PUBLIC_CHANNEL,
    )

    run = await fact_check(ctx)
    if run.fact_check is None:
        print(f"No verdict: {run.error}", file=sys.stderr)
        return 1

    if as_dm:
        reply = guard(run.fact_check, run.retrieved_urls, config.max_dm_chars, config.reply_style)
        print("\n--- DM ---")
        print(reply.long_form(config.max_dm_chars))
        print("--- /DM ---\n")
    else:
        reply = guard(
            run.fact_check,
            run.retrieved_urls,
            config.max_post_chars,
            config.reply_style,
            config.thread_posts,
        )
        print("\n--- reply ---")
        for index, text in enumerate(reply.posts, start=1):
            if len(reply.posts) > 1:
                print(f"[post {index}/{len(reply.posts)}]")
            print(text)
        print("--- /reply ---\n")
        if reply.truncated:
            # This is exactly the case where the running bot would DM the rest.
            print("--- overflow, would be DMed ---")
            print(reply.long_form(config.max_dm_chars))
            print("--- /overflow ---\n")
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
    parser = argparse.ArgumentParser(
        description="CheckClaude - fact-check X posts by mention or DM"
    )
    parser.add_argument("--once", metavar="POST", help="check one post URL or id, print, don't post")
    parser.add_argument("--question", default="Is this true?", help="question to ask with --once")
    parser.add_argument(
        "--dm",
        action="store_true",
        help="with --once, render the private DM answer instead of the public reply",
    )
    parser.add_argument(
        "--no-dm", action="store_true", help="run the bot without the DM channel"
    )
    parser.add_argument("--dry-run", action="store_true", help="run the loops but never post")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    configure_logging(args.verbose)

    if args.dry_run:
        object.__setattr__(config, "dry_run", True)
    if args.no_dm:
        object.__setattr__(config, "dm_enabled", False)

    try:
        if args.once:
            return asyncio.run(run_once(args.once, args.question, args.dm))
        asyncio.run(run_bot())
    except KeyboardInterrupt:
        log.info("Shutting down")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
