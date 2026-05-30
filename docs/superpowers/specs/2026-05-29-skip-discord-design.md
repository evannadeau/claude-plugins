# skip-discord — two-way Discord MCP bot (design)

**Date:** 2026-05-29
**Status:** Design — awaiting review
**Work item:** 589fad64 (revives the cross-rate-limit wake goal of 930b7ba4)

## 1. Problem & goal

We want a scheduled or automated message (e.g. a Discord reminder bot posting
"skip, resume work") to be able to **wake a live skip session** and prompt it to
continue. The official `claude-plugins-official/discord` plugin can inject
inbound messages into a session, but its `messageCreate` handler drops **every**
bot-authored message at the top (`if (msg.author.bot) return`, server.ts:806).
That is a deliberate anti-loop convention, not a Discord limitation — Discord
delivers bot/webhook messages to other bots fine. The drop is the single reason
bot-to-bot wake fails today.

**Goal:** a Discord bot we own that injects inbound messages into the live skip
session **including** messages from a small allowlist of trusted bots, so a
scheduled reminder can prompt skip to resume.

## 2. Scope

**In scope (scenario A only):** waking a session that is **alive but idle or
rate-limited**. When skip's session process is running, its MCP subprocess is
running, so an injected message becomes a new turn (queued through a rate-limit
window, processed on reset).

**Out of scope:** reviving a **dead/exited** session. A dead session has no MCP
listener; no Discord message from any bot or human can revive it. Launching a
new session on a schedule is a different mechanism (cron / systemd / the
`nightshift-relay` skill) and is explicitly not solved here.

## 3. Approach

Fork the official `claude-plugins-official/discord` plugin (v0.0.4) into a new
plugin, `skip-discord`, published from the `evannadeau-claude-plugins`
marketplace. The fork inherits the proven machinery — the
`notifications/claude/channel` session-injection, pairing, `access.json` gating,
permission-reply handling, message chunking, typing/ack — and changes only what
the new capability and identity require.

Rejected alternatives: a from-scratch Python MCP server (re-solves the fiddly
injection/pairing/chunking protocol for no benefit); an in-place patch of the
vendored official plugin (wiped on update; doesn't give us an owned server).

## 4. Architecture

- **Type:** Claude Code stdio MCP plugin. Registered via the plugin's own
  `.mcp.json` (`bun run start`, same as the official plugin). **Session-scoped**
  — alive exactly when skip is alive, which is all scenario A needs.
- **Identity:** a **new "Skip" Discord application** with its own bot token
  (`SKIP_DISCORD_BOT_TOKEN`) and the **Message Content privileged intent**
  enabled in the Discord developer portal. Invited to CB Phone Home and a member
  of `#skip-control`.
- **Home:** `evannadeau-claude-plugins` marketplace → `plugins/skip-discord/`,
  registered in `.claude-plugin/marketplace.json` (alongside `orchestrator`,
  `docs-manager`). Branched off `single-orchestrator` (the branch where that
  marketplace lives) and merged back into it, like PRs #1/#2 — **not** off
  `main` (which is the pristine upstream mirror, `spawnbox-dev-claude-plugins`).
- **State:** new state dir `~/.claude/channels/skip-discord/access.json`, so the
  fork never shares access state with the official plugin (which is being
  retired from skip's session — see §8).
- **Coexistence:** `claude-dev-bridge` (the always-on outbound notification bus)
  is **untouched**. Skip is purely the inbound/interactive bot.

### Components (changed vs. inherited)

| Component | Change |
|---|---|
| Discord client intents | **No code change** — `GatewayIntentBits.MessageContent` is already present (server.ts:86). The new Skip app must have the **Message Content privileged intent enabled in the Discord developer portal**. |
| `messageCreate` filter | **Replace** the blanket bot-drop (see §5). |
| Token / branding | New `SKIP_DISCORD_BOT_TOKEN`; plugin name/strings → `skip-discord` / "Skip". |
| State path | `~/.claude/channels/skip-discord/`. |
| `access.json` schema | **Add** `allowBots: [authorId,...]` (see §6). |
| `notifications/claude/channel` emit | **Inherited unchanged** — `meta.user`/`meta.user_id` carry the bot's identity so skip can tell a bot-triggered wake from a human. |
| `reply` / `react` / `edit_message` / `fetch_messages` / `download_attachment` tools | **Inherited unchanged.** Replies post as "Skip". |
| pairing / permission-reply / chunking / typing-ack | **Inherited unchanged.** |

## 5. The filter (core change)

Replace `if (msg.author.bot) return` (server.ts:806) with:

```ts
// Always drop our own posts — prevents the reply-to-self loop.
if (msg.author.id === client.user?.id) return
// Untrusted bots are dropped; trusted bots (allowlist) fall through.
if (msg.author.bot && !allowBots.includes(msg.author.id)) return
// Humans and trusted bots continue into the existing gate().
```

- **Self-loop guard** is by author id, so Skip never processes its own replies.
- **`allowBots`** is the new allowlist of trusted bot author ids (e.g. the
  reminder bot). It does **not** mean "accept all bots" — other server bots, and
  `claude-dev-bridge`'s own outbound notifications, are dropped, preventing
  cross-bot noise/loops.
- A trusted bot **bypasses the human sender-gate** (`groupAllowFrom`) but still
  must post in an **approved channel** with `requireMention` satisfied. In
  `gate()`, treat `allowBots.includes(senderId)` as an allowed sender path
  alongside the existing human-allowlist path.

## 6. Access / config model (v1)

`~/.claude/channels/skip-discord/access.json`, **hand-authored for v1** (a
`group allow-bot <id>` skill command is a deferred follow-up):

```json
{
  "dmPolicy": "pairing",
  "allowFrom": ["156969922403106817"],
  "allowBots": ["<reminder-bot-app-id>"],
  "groups": {
    "1510103404414898308": { "requireMention": false, "allowFrom": [] }
  },
  "pending": {}
}
```

- `allowFrom` — the operator's Discord user id (two-way human chat).
- `allowBots` — trusted automation; populate with the **reminder bot's
  application/user id**, obtained by right-clicking one of its messages →
  **Copy User ID** (Developer Mode on), or from the bot's profile.
- `groups."1510103404414898308"` — `#skip-control` in CB Phone Home,
  `requireMention:false`. This **must** be false for the wake use case: a
  reminder bot won't @-mention Skip, and trusted bots are still subject to the
  `requireMention` gate, so a mention-required channel would drop the wake.

## 7. Data flow (wake path)

1. Reminder bot fires on schedule → posts "skip, resume work" in `#skip-control`.
2. Skip bot (alive, since skip's session is alive) receives `messageCreate`.
3. Filter: author ∈ `allowBots` ✓ (not self). `gate()`: channel approved,
   `requireMention:false` ✓.
4. Emit `notifications/claude/channel` with `content:"skip, resume work"`,
   `meta.user:"<reminder bot name>"`.
5. Claude Code injects it as a `<channel source=...>` turn → skip wakes and
   resumes; optional reply posts as "Skip".

## 8. Cutover & rollout

1. Create the Skip Discord app; enable Message Content intent; invite to CB Phone
   Home; confirm it can see `#skip-control`.
2. Build `plugins/skip-discord/`; register in the marketplace manifest.
3. Hand-author `~/.claude/channels/skip-discord/access.json` (§6).
4. Enable `skip-discord` in skip's session config; **disable the official
   `discord` plugin in skip's session** so only one bot injects (no
   double-processing).
5. Validate (§9), then retire the official plugin from skip's flow entirely.

## 9. Testing

- **Unit:** extract the filter into a pure function and test the four cases —
  self (drop), trusted bot (pass), untrusted bot (drop), human (pass through to
  `gate()`).
- **Manual E2E checklist** (mirrors `claude-dev-bridge/test_e2e.sh` style):
  1. Human posts in `#skip-control` → wakes skip (regression of today's behavior).
  2. Reminder bot posts → wakes skip (the new capability).
  3. A non-allowlisted bot posts → ignored.
  4. Skip's own reply → not re-processed (no loop).

## 10. Risks & follow-ups

- **Message Content intent** must be enabled on the Skip app, or `msg.content`
  arrives empty and wakes fire with no text. Setup-time checklist item.
- **Double-injection** if the official plugin isn't disabled at cutover (§8.4).
- **Fork maintenance:** track upstream `claude-plugins-official/discord` changes;
  the delta is small (intents, filter, token, state path) so re-basing is cheap.
- **Follow-up:** extend the access skill with `group allow-bot <id>` /
  `group rm-bot <id>` so `allowBots` isn't hand-edited.
- **Follow-up (out of scope):** dead-session launch (scenario B) remains the
  `nightshift-relay` / cron domain.
