import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { reapStaleActiveSessionFiles } from "../../mcp/engine/startup_hygiene";

// QLN-145 Bug 2: stale per-PID `active-session-<pid>` files never get
// reaped. The per-PID file scheme (race-free session_id lookup under
// concurrent sessions) accumulates dead-PID files indefinitely because
// nothing sweeps them when the owning claude process exits. Over weeks
// of dev work, dozens pile up; one project hit 30 on 2026-05-27.
//
// PR #8 upstream (SpawnBox-dev/claude-plugins) implemented the sweeper
// but never merged. This plugin's 0.30.52 still ships without it.
//
// Fix: extract reapStaleActiveSessionFiles into its own engine module
// so it is testable in isolation (liveness probe injectable), and wire
// it at MCP server startup the same way PR #8 did.
describe("startup hygiene - stale active-session-<pid> reaper (QLN-145)", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "qln145-reaper-"));
  });

  afterEach(() => {
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("removes active-session-<pid> files whose PID is dead", () => {
    writeFileSync(join(stateDir, "active-session-99991"), "sid-dead-1");
    writeFileSync(join(stateDir, "active-session-99992"), "sid-dead-2");
    writeFileSync(join(stateDir, "active-session-99993"), "sid-alive-3");

    // Liveness probe: 99993 is alive, others are dead.
    const isAlive = (pid: number) => pid === 99993;

    const reaped = reapStaleActiveSessionFiles(stateDir, isAlive);

    expect(reaped).toBe(2);
    expect(existsSync(join(stateDir, "active-session-99991"))).toBe(false);
    expect(existsSync(join(stateDir, "active-session-99992"))).toBe(false);
    expect(existsSync(join(stateDir, "active-session-99993"))).toBe(true);
  });

  test("ignores non-PID files in the same directory", () => {
    writeFileSync(join(stateDir, "active-session"), "legacy-sid");
    writeFileSync(join(stateDir, "active-session-12345"), "sid-dead");
    writeFileSync(join(stateDir, "unrelated.txt"), "noise");
    writeFileSync(join(stateDir, "active-session-notapid"), "garbage");

    const reaped = reapStaleActiveSessionFiles(stateDir, () => false);

    expect(reaped).toBe(1);
    expect(existsSync(join(stateDir, "active-session"))).toBe(true);
    expect(existsSync(join(stateDir, "active-session-12345"))).toBe(false);
    expect(existsSync(join(stateDir, "unrelated.txt"))).toBe(true);
    expect(existsSync(join(stateDir, "active-session-notapid"))).toBe(true);
  });

  test("missing stateDir is a no-op (no throw)", () => {
    const missing = join(stateDir, "does-not-exist");
    const reaped = reapStaleActiveSessionFiles(missing, () => true);
    expect(reaped).toBe(0);
  });

  test("empty stateDir is a no-op", () => {
    const reaped = reapStaleActiveSessionFiles(stateDir, () => true);
    expect(reaped).toBe(0);
    expect(readdirSync(stateDir)).toEqual([]);
  });

  test("uses real process.kill probe when liveness fn omitted", () => {
    // Use this process's own PID as the canonical "alive" signal -
    // process.kill(self, 0) succeeds. Use a very large unlikely PID as
    // the "dead" signal.
    writeFileSync(join(stateDir, `active-session-${process.pid}`), "live");
    writeFileSync(join(stateDir, "active-session-2147483646"), "dead");

    const reaped = reapStaleActiveSessionFiles(stateDir);

    expect(reaped).toBe(1);
    expect(existsSync(join(stateDir, `active-session-${process.pid}`))).toBe(
      true,
    );
    expect(existsSync(join(stateDir, "active-session-2147483646"))).toBe(false);
  });

  test("rejects pid <= 0", () => {
    writeFileSync(join(stateDir, "active-session-0"), "bogus");
    writeFileSync(join(stateDir, "active-session-1"), "sid-dead");
    // PID 1 is `init` on linux - definitely alive in any container/host
    // a dev runs claude in. But the regex requires \d+ so it matches.
    // We can't safely reap PID 1, so let's set liveness=true for it.
    const isAlive = (pid: number) => pid === 1;

    const reaped = reapStaleActiveSessionFiles(stateDir, isAlive);
    // PID 0 file: regex matches, pid=0 is rejected by the pid > 0
    // guard, so it is NOT reaped (we never had a way to probe it).
    expect(existsSync(join(stateDir, "active-session-0"))).toBe(true);
    // PID 1 is alive -> not reaped.
    expect(existsSync(join(stateDir, "active-session-1"))).toBe(true);
    expect(reaped).toBe(0);
  });
});
