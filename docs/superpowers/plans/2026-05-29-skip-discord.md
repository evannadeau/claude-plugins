# skip-discord Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fork the official `discord` plugin into a `skip-discord` plugin whose inbound handler injects messages from an allowlist of trusted bots (not just humans) into the live skip session, enabling scheduled bot-to-bot wake.

**Architecture:** Copy `claude-plugins-official/discord` v0.0.4 into `plugins/skip-discord/` in the `evannadeau-claude-plugins` marketplace. Extract the sender-filter decisions into a pure, unit-tested module (`access-filter.ts`); the only behavioral change is replacing the blanket "drop all bot messages" with "drop only our own posts + drop untrusted bots, where trusted bots come from a new `allowBots` allowlist." Rename the token/state env so it never collides with the official plugin. Scenario A only (wake a live-but-idle session).

**Tech Stack:** TypeScript on bun, `discord.js` v14, `@modelcontextprotocol/sdk`, `bun:test`.

**Branch:** `feat/skip-discord`, based on `single-orchestrator` (the branch where the `evannadeau-claude-plugins` marketplace lives), in worktree `.worktrees/skip-discord`. Merges back into `single-orchestrator` — NOT `main` (the upstream mirror).

---

## File structure

**New (in repo):**
- `plugins/skip-discord/server.ts` — forked Discord MCP server (copied, then edited: import filter module, wire self-guard + `allowBots`, rename token/state env).
- `plugins/skip-discord/access-filter.ts` — NEW pure module: `isOwnMessage`, `shouldDropBot`, `senderPassesGroupGate`. No Discord/fs deps → unit-testable.
- `plugins/skip-discord/access-filter.test.ts` — NEW `bun:test` unit tests.
- `plugins/skip-discord/package.json` — renamed manifest.
- `plugins/skip-discord/.claude-plugin/plugin.json` — renamed; `name: "skip-discord"`.
- `plugins/skip-discord/.mcp.json` — MCP server key `skip-discord`.
- `plugins/skip-discord/.gitignore` — ignore `node_modules/`.
- `plugins/skip-discord/README.md`, `LICENSE` — copied as-is.

**Modified (in repo):**
- `.claude-plugin/marketplace.json` — add the `skip-discord` plugin entry.

**Local machine state (NOT in repo — Task 5/6 checklists):**
- New Discord "Skip" app (Message Content privileged intent on; invited to CB Phone Home).
- `~/.claude/channels/skip-discord/.env` → `SKIP_DISCORD_BOT_TOKEN=…`
- `~/.claude/channels/skip-discord/access.json` → hand-authored.
- skip session settings: enable `skip-discord`, disable official `discord`.

**Deferred to follow-up (NOT in v1):** forking the `access` / `configure` skills (rebranding `/discord:access`). v1 hand-edits `access.json`. Consequence: the inherited pairing-reply text still says "run `/discord:access pair …`"; harmless because v1 hand-authors `allowFrom`, so pairing never triggers for the operator.

---

## Task 1: Scaffold the skip-discord plugin (fork copy + manifests)

Mechanical fork import — no test (you cannot TDD a file copy). Verification is structural.

**Files:**
- Create: `plugins/skip-discord/server.ts`, `README.md`, `LICENSE` (copied)
- Create: `plugins/skip-discord/package.json`, `.claude-plugin/plugin.json`, `.mcp.json`, `.gitignore` (new content)

- [ ] **Step 1: Copy the source files**

Run (from the worktree root `/.worktrees/skip-discord`):
```bash
SRC=~/.claude/plugins/cache/claude-plugins-official/discord/0.0.4
DST=plugins/skip-discord
mkdir -p "$DST/.claude-plugin"
cp "$SRC/server.ts"  "$DST/server.ts"
cp "$SRC/README.md"  "$DST/README.md"
cp "$SRC/LICENSE"    "$DST/LICENSE"
ls "$DST"
```
Expected: `server.ts  README.md  LICENSE  .claude-plugin` listed.

- [ ] **Step 2: Write `plugins/skip-discord/package.json`**

```json
{
  "name": "skip-channel-discord",
  "version": "0.0.1",
  "license": "Apache-2.0",
  "type": "module",
  "bin": "./server.ts",
  "scripts": {
    "start": "bun install --no-summary && bun server.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "discord.js": "^14.14.0"
  }
}
```

- [ ] **Step 3: Write `plugins/skip-discord/.claude-plugin/plugin.json`**

```json
{
  "name": "skip-discord",
  "description": "Skip's two-way Discord channel — forked discord plugin that injects inbound messages (including an allowlist of trusted bots) into the live session, enabling scheduled bot-to-bot wake. Hand-edit access.json for v1.",
  "version": "0.0.1",
  "keywords": ["discord", "messaging", "channel", "mcp", "skip"]
}
```

- [ ] **Step 4: Write `plugins/skip-discord/.mcp.json`**

```json
{
  "mcpServers": {
    "skip-discord": {
      "command": "bun",
      "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start"]
    }
  }
}
```

- [ ] **Step 5: Write `plugins/skip-discord/.gitignore`**

```gitignore
node_modules/
```

- [ ] **Step 6: Commit**

```bash
git add plugins/skip-discord/server.ts plugins/skip-discord/README.md \
        plugins/skip-discord/LICENSE plugins/skip-discord/package.json \
        plugins/skip-discord/.claude-plugin/plugin.json \
        plugins/skip-discord/.mcp.json plugins/skip-discord/.gitignore
git commit -m "feat(skip-discord): scaffold plugin as fork of official discord v0.0.4"
```

---

## Task 2: Pure filter module (TDD)

The only new logic. Write the test first, watch it fail, implement, watch it pass.

**Files:**
- Test: `plugins/skip-discord/access-filter.test.ts`
- Create: `plugins/skip-discord/access-filter.ts`

- [ ] **Step 1: Write the failing test**

Create `plugins/skip-discord/access-filter.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { isOwnMessage, shouldDropBot, senderPassesGroupGate } from './access-filter'

test('isOwnMessage: true only when author equals self', () => {
  expect(isOwnMessage('123', '123')).toBe(true)
  expect(isOwnMessage('123', '456')).toBe(false)
  expect(isOwnMessage('123', undefined)).toBe(false)
})

test('shouldDropBot: drops untrusted bots, keeps humans and trusted bots', () => {
  expect(shouldDropBot(false, '111', [])).toBe(false)       // human → keep
  expect(shouldDropBot(true, '111', [])).toBe(true)         // untrusted bot → drop
  expect(shouldDropBot(true, '111', ['111'])).toBe(false)   // trusted bot → keep
  expect(shouldDropBot(true, '222', ['111'])).toBe(true)    // other bot → drop
})

test('senderPassesGroupGate: trusted bot bypasses, empty allowFrom is open', () => {
  expect(senderPassesGroupGate('999', [], [])).toBe(true)            // open channel
  expect(senderPassesGroupGate('999', ['111'], [])).toBe(false)      // not allowlisted
  expect(senderPassesGroupGate('111', ['111'], [])).toBe(true)       // allowlisted human
  expect(senderPassesGroupGate('bot1', ['111'], ['bot1'])).toBe(true) // trusted bot bypass
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugins/skip-discord && bun test access-filter.test.ts`
Expected: FAIL — `Cannot find module './access-filter'` (or resolution error).

- [ ] **Step 3: Write the minimal implementation**

Create `plugins/skip-discord/access-filter.ts`:
```ts
/**
 * Pure sender-filter decisions for skip-discord. No Discord or fs deps, so the
 * gating logic is unit-testable in isolation from the live bot.
 */

/** True when the message was authored by Skip itself — never react to our own posts. */
export function isOwnMessage(authorId: string, selfId: string | undefined): boolean {
  return selfId !== undefined && authorId === selfId
}

/**
 * True when an author should be dropped because it is an untrusted bot.
 * Humans (isBot=false) are never dropped here; trusted bots in allowBots pass.
 */
export function shouldDropBot(isBot: boolean, authorId: string, allowBots: string[]): boolean {
  return isBot && !allowBots.includes(authorId)
}

/**
 * True when a sender clears the per-channel human gate.
 * Trusted bots bypass the human allowlist; an empty allowFrom means the channel is open.
 */
export function senderPassesGroupGate(
  senderId: string,
  groupAllowFrom: string[],
  allowBots: string[],
): boolean {
  if (allowBots.includes(senderId)) return true
  if (groupAllowFrom.length === 0) return true
  return groupAllowFrom.includes(senderId)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd plugins/skip-discord && bun test access-filter.test.ts`
Expected: PASS — 3 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add plugins/skip-discord/access-filter.ts plugins/skip-discord/access-filter.test.ts
git commit -m "feat(skip-discord): pure sender-filter module with unit tests"
```

---

## Task 3: Wire the filter into server.ts + rename token/state env

Edits to the copied `plugins/skip-discord/server.ts`. Each edit is an exact find/replace.

**Files:**
- Modify: `plugins/skip-discord/server.ts`

- [ ] **Step 1: Add the filter import** (just after the discord.js import block)

Find:
```ts
import { randomBytes } from 'crypto'
```
Replace with:
```ts
import { randomBytes } from 'crypto'
import { isOwnMessage, shouldDropBot, senderPassesGroupGate } from './access-filter'
```

- [ ] **Step 2: Rename the state dir + token env**

Find:
```ts
const STATE_DIR = process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
```
Replace with:
```ts
const STATE_DIR = process.env.SKIP_DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'skip-discord')
```

Find:
```ts
const TOKEN = process.env.DISCORD_BOT_TOKEN
```
Replace with:
```ts
const TOKEN = process.env.SKIP_DISCORD_BOT_TOKEN
```

Find:
```ts
  process.stderr.write(
    `discord channel: DISCORD_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n` +
    `  format: DISCORD_BOT_TOKEN=MTIz...\n`,
  )
```
Replace with:
```ts
  process.stderr.write(
    `skip-discord: SKIP_DISCORD_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n` +
    `  format: SKIP_DISCORD_BOT_TOKEN=MTIz...\n`,
  )
```

- [ ] **Step 3: Add `allowBots` to the `Access` type**

Find:
```ts
  /** Split on paragraph boundaries instead of hard char count. */
  chunkMode?: 'length' | 'newline'
}
```
Replace with:
```ts
  /** Split on paragraph boundaries instead of hard char count. */
  chunkMode?: 'length' | 'newline'
  /** Bot author IDs allowed to trigger Skip (e.g. a reminder bot). Skip's own posts are always filtered. */
  allowBots?: string[]
}
```

- [ ] **Step 4: Drop untrusted bots inside `gate()`**

Find:
```ts
  const senderId = msg.author.id
  const isDM = msg.channel.type === ChannelType.DM
```
Replace with:
```ts
  const senderId = msg.author.id
  const isDM = msg.channel.type === ChannelType.DM

  // The messageCreate handler only filters our own posts; untrusted bots are
  // dropped here, where access (and allowBots) is loaded. Trusted bots fall through.
  const allowBots = access.allowBots ?? []
  if (shouldDropBot(msg.author.bot, senderId, allowBots)) return { action: 'drop' }
```

- [ ] **Step 5: Let trusted bots bypass the per-channel human gate**

Find:
```ts
  if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
    return { action: 'drop' }
  }
```
Replace with:
```ts
  if (!senderPassesGroupGate(senderId, groupAllowFrom, allowBots)) {
    return { action: 'drop' }
  }
```

- [ ] **Step 6: Replace the blanket bot-drop in `messageCreate` with the self-guard**

Find:
```ts
client.on('messageCreate', msg => {
  if (msg.author.bot) return
  handleInbound(msg).catch(e => process.stderr.write(`discord: handleInbound failed: ${e}\n`))
})
```
Replace with:
```ts
client.on('messageCreate', msg => {
  if (isOwnMessage(msg.author.id, client.user?.id)) return
  handleInbound(msg).catch(e => process.stderr.write(`skip-discord: handleInbound failed: ${e}\n`))
})
```

- [ ] **Step 7: Re-run the unit tests (regression)**

Run: `cd plugins/skip-discord && bun test access-filter.test.ts`
Expected: PASS — 3 pass, 0 fail (the module is unchanged; this confirms nothing broke).

- [ ] **Step 8: Smoke-test that server.ts parses and the env rename took**

Run:
```bash
cd plugins/skip-discord && bun install --no-summary >/dev/null 2>&1 && \
SKIP_DISCORD_STATE_DIR=/tmp/skip-discord-smoke bun server.ts 2>&1 | head -3
```
Expected: prints `skip-discord: SKIP_DISCORD_BOT_TOKEN required` and exits (no token in the smoke state dir). This proves imports resolve, the file parses, and the rename is correct.

- [ ] **Step 9: Commit**

```bash
git add plugins/skip-discord/server.ts
git commit -m "feat(skip-discord): allowBots trusted-bot wake + self-guard; rename token/state env"
```

---

## Task 4: Register the plugin in the marketplace manifest

**Files:**
- Modify: `.claude-plugin/marketplace.json`

- [ ] **Step 1: Add the `skip-discord` entry**

In `.claude-plugin/marketplace.json`, find the end of the `docs-manager` entry inside the `plugins` array:
```json
      "source": "./plugins/docs-manager",
      "category": "productivity"
    }
  ]
}
```
Replace with:
```json
      "source": "./plugins/docs-manager",
      "category": "productivity"
    },
    {
      "name": "skip-discord",
      "description": "Skip's two-way Discord channel — injects inbound messages (including a trusted-bot allowlist) into the live session for scheduled bot-to-bot wake.",
      "version": "0.0.1",
      "author": {
        "name": "SpawnBox-dev"
      },
      "source": "./plugins/skip-discord",
      "category": "productivity"
    }
  ]
}
```

- [ ] **Step 2: Verify the JSON is valid**

Run: `cd /home/enadeau/workspaces/slurm/claude-plugins/.worktrees/skip-discord && bun -e "JSON.parse(require('fs').readFileSync('.claude-plugin/marketplace.json','utf8')); console.log('valid')"`
Expected: `valid`

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/marketplace.json
git commit -m "feat(skip-discord): register plugin in evannadeau-claude-plugins marketplace"
```

---

## Task 5: Local setup — Discord app + state files (manual checklist, no commits)

This is operator/local-machine work; nothing is committed.

- [ ] **Step 1: Create the Skip Discord app**
  - Discord Developer Portal → New Application "Skip" → Bot → copy the bot token.
  - Bot → Privileged Gateway Intents → enable **Message Content Intent**.
  - OAuth2 → URL generator → scopes `bot`; permissions: View Channels, Send Messages, Read Message History → invite to **CB Phone Home**.
  - Confirm the Skip bot appears in the member list of **#skip-control**.

- [ ] **Step 2: Capture the reminder bot's user id**
  - In Discord (Developer Mode on), right-click one of the reminder bot's messages → **Copy User ID**. Save it for `allowBots`.

- [ ] **Step 3: Write the token env**

```bash
mkdir -p ~/.claude/channels/skip-discord
printf 'SKIP_DISCORD_BOT_TOKEN=%s\n' '<paste-skip-bot-token>' > ~/.claude/channels/skip-discord/.env
chmod 600 ~/.claude/channels/skip-discord/.env
```

- [ ] **Step 4: Hand-author `~/.claude/channels/skip-discord/access.json`**

```json
{
  "dmPolicy": "pairing",
  "allowFrom": ["156969922403106817"],
  "allowBots": ["<reminder-bot-user-id>"],
  "groups": {
    "1510103404414898308": { "requireMention": false, "allowFrom": [] }
  },
  "pending": {}
}
```
(`156969922403106817` = operator's user id; `1510103404414898308` = #skip-control.)

---

## Task 6: Cutover + E2E validation (manual)

- [ ] **Step 1: Enable skip-discord, disable the official discord plugin** in skip's session settings (`.claude/settings.json` / `settings.local.json`: add `skip-discord` to `enabledPlugins`, remove/disable `discord`). Restart Claude Code so both MCP servers reload — exactly one inbound bot must be active.

- [ ] **Step 2: E2E checklist** (post-restart)
  1. **Human** posts in #skip-control → arrives as a channel event, skip can reply (regression of today's behavior).
  2. **Reminder bot** fires (or post a test message as the allowlisted bot) → arrives as a channel event with `meta.user` = the bot's name (the new capability).
  3. A **non-allowlisted bot** posts in #skip-control → nothing arrives (dropped).
  4. Skip's **own reply** → not re-processed (no loop).

- [ ] **Step 3: Record the result** on work item 589fad64; on success, mark the original wake goal (930b7ba4) satisfied via this path and retire the official discord plugin from skip's flow.

---

## Task 7: Open the PR (optional, when ready)

- [ ] **Step 1: Pre-push private-name scrub** (public-exposure constraint)

Run: `cd /home/enadeau/workspaces/slurm/claude-plugins/.worktrees/skip-discord && git grep -ni quayline $(git rev-list single-orchestrator..feat/skip-discord) -- 2>/dev/null; git grep -ni quayline -- 'plugins/skip-discord' 'docs/superpowers'`
Expected: no matches. If any, scrub before pushing (evannadeau/claude-plugins may be public).

- [ ] **Step 2: Push and open the PR into `single-orchestrator`** (not `main`)

```bash
git push -u origin feat/skip-discord
gh pr create --base single-orchestrator --head feat/skip-discord \
  --title "feat(skip-discord): two-way Discord bot with trusted-bot wake" \
  --body "Implements docs/superpowers/specs/2026-05-29-skip-discord-design.md. Fork of the official discord plugin; replaces the blanket bot-drop with self-guard + allowBots allowlist so a reminder bot can wake a live skip session. Scenario A only."
```

---

## Self-review (against the spec)

**Spec coverage:**
- §3 fork approach → Task 1. ✓
- §4 MessageContent already present → Task 5 Step 1 (portal toggle), no code task (correct). ✓
- §4 new state dir + token → Task 3 Step 2. ✓
- §4 `allowBots` schema → Task 3 Step 3. ✓
- §5 filter (self-guard + untrusted-bot drop + trusted-bot bypass) → Task 2 (pure fns) + Task 3 Steps 4–6. ✓
- §6 hand-authored access.json → Task 5 Step 4. ✓
- §7 wake data flow → exercised by Task 6 Step 2 case 2. ✓
- §8 cutover (disable official plugin) → Task 6 Step 1. ✓
- §9 testing (4 filter cases + E2E checklist) → Task 2 tests + Task 6 Step 2. ✓
- §10 risks: Message Content intent → Task 5 Step 1; double-injection → Task 6 Step 1; fork-maintenance/skill follow-ups → noted in file-structure "Deferred". ✓

**Placeholder scan:** `<paste-skip-bot-token>`, `<reminder-bot-user-id>` are genuine operator-supplied secrets/IDs with documented capture steps (Task 5 Steps 1–2), not design gaps. No TODO/TBD code steps.

**Type consistency:** `isOwnMessage`, `shouldDropBot`, `senderPassesGroupGate` signatures match between Task 2 (definition) and Task 3 (call sites: `shouldDropBot(msg.author.bot, senderId, allowBots)`, `senderPassesGroupGate(senderId, groupAllowFrom, allowBots)`, `isOwnMessage(msg.author.id, client.user?.id)`). `allowBots` defined in the `Access` type (Task 3 Step 3) and read in `gate()` (Task 3 Step 4). Consistent.
