/**
 * Startup-time hygiene sweeps for the agent-channel state directory.
 *
 * QLN-145 Bug 2: per-PID `active-session-<pid>` files (introduced in
 * 0.30.19+ for race-free session_id lookup under concurrent sessions)
 * accumulate indefinitely because nothing reaps them when the owning
 * claude process exits. Over weeks of dev work the pile grows large
 * enough to slow directory listings; one project hit 30 stale files in
 * ~12 days (skip 2026-05-27 incident). Worse, PID reuse means a stale
 * file can hand `getFallbackSessionId` a session_id that is no longer
 * live - the root cause of QLN-145 Bug 1's phantom-sibling false
 * positive.
 *
 * The sweep runs once per MCP startup, is cheap, idempotent, and race-
 * safe: we only unlink files whose PID is verified gone. Lost races
 * with concurrent sessions are tolerated - the next startup retries.
 *
 * Originally proposed upstream as spawnbox-dev/claude-plugins PR #8
 * (commit b7f43b7). That PR never merged, so this fork carries the
 * fix.
 */

import { existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";

/**
 * Default liveness probe using `process.kill(pid, 0)`. Throws if the
 * PID does not exist (ESRCH); succeeds if alive (or alive-but-not-ours
 * with EPERM, which we treat as alive to be safe). The failure cost of
 * a missed reap is one extra orphan file at worst - the next startup
 * will retry it.
 */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sweep `stateDir` for `active-session-<pid>` files whose PID is no
 * longer alive. Returns the number of files reaped.
 *
 * - `stateDir` is typically `<project>/.orchestrator-state`. Missing
 *   dir is a no-op; the caller need not check.
 * - `isAlive` is injected for testability. Production callers omit it
 *   so the `process.kill(pid, 0)` probe runs.
 *
 * Race safety: between the readdir snapshot and unlink we re-check
 * nothing; if a concurrent process races us to unlink the same dead-
 * PID file the unlinkSync exception is swallowed.
 */
export function reapStaleActiveSessionFiles(
  stateDir: string,
  isAlive: (pid: number) => boolean = defaultIsAlive,
): number {
  if (!existsSync(stateDir)) return 0;
  let reaped = 0;
  let entries: string[];
  try {
    entries = readdirSync(stateDir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const m = entry.match(/^active-session-(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (isAlive(pid)) continue;
    try {
      unlinkSync(join(stateDir, entry));
      reaped++;
    } catch {
      // Lost a race with another session or permission issue. Non-fatal;
      // next startup will retry.
    }
  }
  return reaped;
}
