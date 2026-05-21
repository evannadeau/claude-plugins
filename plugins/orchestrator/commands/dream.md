---
description: "LLM-driven semantic consolidation of the orchestrator knowledge base — merges semantic duplicates, resolves contradictions, synthesizes higher-order insights"
---

# /dream — semantic knowledge-base consolidation

`/dream` runs a semantic consolidation pass over the orchestrator knowledge base. It
complements `/reflect` (mechanical decay + keyword-Jaccard dedup) by reasoning about
*meaning*: it catches semantic duplicates that share no keywords, resolves contradictions,
and synthesizes scattered related notes into higher-order insights.

Argument: `--dry-run` — preview the proposed changeset without applying it or recording the run.

`/dream` is normally triggered automatically by the SessionStart cadence gate (~7 days). It
may also be run manually at any time. When invoked, work the passes below in order.

## Pass 0 — Mechanical pre-pass

Call the `retro` MCP tool. Note its `revalidation_queue`, `orphan_notes`, and
`code_refs_broken` outputs — you act on them in Passes 2–3. If `retro` errors, continue
anyway and record the failure in the Pass 4 report.

## Pass 1 — Survey (cheap)

Determine the incremental cutoff: read `$CLAUDE_PROJECT_DIR/.orchestrator-state/dream-marker`.
- If it exists, its content is the ISO timestamp of the last completed dream — survey only
  notes updated at or after that time (an incremental run).
- If it is missing, this is a full run — survey the whole knowledge base.

Enumerate notes with `lookup` in `output_mode: "summary"` (one line per note), iterating
over note types. For an incremental run, also pull the linked neighbourhoods of changed
notes so each is reconsidered against its existing relations. From the summaries, identify
candidate groups:
- semantic-duplicate clusters (notes that mean the same thing),
- contradiction-pair candidates (notes that conflict),
- synthesis clusters (3+ notes circling one theme).

Be cost-conscious: stay in summary mode here; only go to full content in Pass 2.

## Pass 2 — Deep-dive (targeted)

For each candidate group ONLY, fetch full content (`lookup` by `id`; `check_similar` to
spot-check uncertain pairs). Decide the consolidation action for each group.

## Pass 3 — Apply

Skip this pass entirely if `--dry-run` was passed.

- **Semantic merge** — near-duplicate notes → `supersede_note` (weaker/older note
  superseded by the canonical one).
- **Contradiction resolution** — conflicting notes → `supersede_note` the stale one,
  preferring the newer `updated_at`. If genuinely ambiguous (e.g. an old `decision` vs. a
  newer informal `insight`, or both equally authoritative), DO NOT resolve — list it under
  "unresolved contradictions" in the report.
- **Synthesis** — 3+ notes on one theme with a stateable meta-pattern → create one new
  `insight` note via `note()`. It MUST cite its source note IDs as `[[id]]` links. Fire
  only when the pattern is genuinely redundant or implicit across the sources — never
  speculative. Prefer leaving the source notes in place and adding the synthesis as a
  linked higher-order note; supersede sources only when truly redundant.

HARD RULES:
- NEVER call `delete_note`. Only `supersede_note` / `update_note` / `close_thread`.
- NEVER modify or supersede `checkpoint`-type notes.

## Pass 4 — Report and marker

Print a summary: every applied change with note IDs, grouped by operation type; then the
flagged "unresolved contradictions" list. On a `--dry-run`, print the *proposed* changeset
under a clear "DRY RUN — nothing applied" heading.

Then, UNLESS `--dry-run` was passed, record completion with Bash:

```bash
mkdir -p "$CLAUDE_PROJECT_DIR/.orchestrator-state"
printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$CLAUDE_PROJECT_DIR/.orchestrator-state/dream-marker"
rm -f "$CLAUDE_PROJECT_DIR/.orchestrator-state/dream-claim"
```
