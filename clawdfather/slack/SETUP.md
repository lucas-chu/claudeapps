# Slack setup — four apps, ~5 minutes

You create one **router** app (ClawdFather, the only one that listens) and three
**teammate** identity apps (which only post). Manifests do the scope-clicking
for you.

## 1. Router app — ClawdFather

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** →
   **From a manifest** → pick your workspace
2. Paste [`clawdfather.manifest.yaml`](./clawdfather.manifest.yaml) → Next → Create
3. **Basic Information → App-Level Tokens → Generate Token and Scopes**
   - Name it `socket`, add the `connections:write` scope, Generate
   - Copy the `xapp-…` token → `.env` as `SLACK_APP_TOKEN`
4. **Install App** → Install to Workspace → Allow
   - Copy the **Bot User OAuth Token** (`xoxb-…`) → `.env` as `SLACK_BOT_TOKEN`

## 2. Teammate apps — three of them

For each of `Teammate One`, `Teammate Two`, `Teammate Three`:

1. **Create New App → From a manifest**
2. Paste [`teammate.manifest.yaml`](./teammate.manifest.yaml), changing **both**
   name fields (`display_information.name` and `features.bot_user.display_name`)
   to that teammate's slot name
3. **Install App** → copy the Bot User OAuth Token → `.env` as
   `SLACK_TEAMMATE_N_BOT_TOKEN`
4. **App Home** → copy the **Bot User ID** (`U…`) → `.env` as
   `SLACK_TEAMMATE_N_USER_ID`

> Getting the bot user ID: App Home shows it directly. If you can't find it,
> `curl -sH "Authorization: Bearer xoxb-…" https://slack.com/api/auth.test`
> returns `user_id`.

## 3. Invite ClawdFather to your channels

In every channel you'll demo in:

```
/invite @ClawdFather
```

ClawdFather must be in a channel to see its messages — that's the whole routing
mechanism. It invites the teammate bots itself at hire time.

## If the rename doesn't stick

After hiring, the pooled app is renamed via `users.profile.set` so `@Scout`
reads as Scout. Some workspaces reject that scope for bot tokens. You'll see
`could not rename slot N` in the logs.

Everything still works — Scout's messages show as **Scout** with its emoji
(via the `username` override). Only `@`-autocomplete shows "Teammate One".

Ten-second fix, per app: api.slack.com/apps → the app → **Basic Information** →
**Display Information** → change the name → Save. No reinstall needed.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Nothing happens on `@ClawdFather …` | ClawdFather isn't in that channel — `/invite @ClawdFather` |
| `not_in_channel` when a teammate posts | Auto-invite failed; `/invite @Teammate One` manually |
| Teammate posts under the pool name | `chat:write.customize` missing — add it and reinstall |
| `No channel named #x` at hire time | Create the channel first, or invite ClawdFather if it's private |
| Duplicate replies | Two processes running against the same app-level token |
