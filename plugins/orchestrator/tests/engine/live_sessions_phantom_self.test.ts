// Force :memory: DB path for tests BEFORE the module loads. bun:sqlite on
// Windows holds the .db file handle for an indefinite window after
// Database.close() returns, which trips EBUSY in rmSync test teardown.
// `:memory:` DBs have no file to lock; per-stateDir cache key still isolates
// each test. Production retains file-backed DBs via the default.
process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY = ":memory:";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  writeSession,
  closeAgentChannelDb,
  type SessionEntry,
} from "../../mcp/engine/agent_channel_state";
import {
  getLiveOtherSessionIds,
  setSelfSessionForLiveFilter,
  clearSelfSessionForLiveFilter,
} from "../../mcp/engine/live_sessions";

// QLN-145 Bug 1: phantom-sibling false positive.
//
// On a fresh single-claude launch (no /resume), the MCP server's
// selfSession.session_id can drift from the harness session_id (for
// example, a stale per-PID active-session-<pid> file from a prior
// session that the reaper never cleaned up, plus PID reuse, yields a
// resolved session_id that is no longer the live harness id).
//
// The MCP then writes a self-row to agent_channel.db under that drifted
// id, and the every-turn cross-session injection - which only filters
// by the CALLER (harness) id - reports the MCP's own row as "1 sibling
// session active" for the entire session lifetime.
//
// Fix: live_sessions exposes a process-wide opt-in self-id filter. The
// MCP boot path registers its selfSession.session_id at startAgentChannel
// time AND on first explicit session_id observed via resolveSessionId.
// getLiveOtherSessionIds then excludes BOTH the caller id AND the
// registered self id. This prevents the phantom even when the two
// disagree.
describe("live_sessions phantom-self filter (QLN-145)", () => {
  let stateDir: string;
  let projectRoot: string;
  let origProjectRoot: string | undefined;
  let origClaudeProjectDir: string | undefined;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "qln145-phantom-"));
    stateDir = join(projectRoot, ".orchestrator-state", "agent-channel");
    mkdirSync(stateDir, { recursive: true });
    origProjectRoot = process.env.ORCHESTRATOR_PROJECT_ROOT;
    origClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.ORCHESTRATOR_PROJECT_ROOT = projectRoot;
    process.env.CLAUDE_PROJECT_DIR = projectRoot;
    // getAgentChannelStateDir() requires either `agent_channel.db` or the
    // legacy `sessions.json` to exist before it returns a non-null state
    // dir. The :memory: test DB never materializes as a file, AND the
    // first writeSession() call eats any legacy sessions.json sentinel
    // we drop here as part of its migration sweep. Touch an empty
    // `agent_channel.db` file so the marker persists for the lifetime
    // of the test - it never gets read (the :memory: DB cache shadows
    // it), it just makes the existsSync check happy.
    writeFileSync(join(stateDir, "agent_channel.db"), "");
    clearSelfSessionForLiveFilter();
  });

  afterEach(() => {
    clearSelfSessionForLiveFilter();
    closeAgentChannelDb(stateDir);
    if (origProjectRoot === undefined) {
      delete process.env.ORCHESTRATOR_PROJECT_ROOT;
    } else {
      process.env.ORCHESTRATOR_PROJECT_ROOT = origProjectRoot;
    }
    if (origClaudeProjectDir === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = origClaudeProjectDir;
    }
    try {
      rmSync(projectRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  test("excludes registered self-session even when its id differs from caller", () => {
    // Simulate a fresh single-claude launch where the MCP self-resolved
    // an id that is NOT the harness id. Could happen via stale per-PID
    // file + PID reuse, or via a resolveSessionId race.
    const mcpSelfSessionId = "drifted-self-id-aaaaaaaa";
    const harnessSessionId = "harness-real-bbbbbbbb";
    const now = new Date().toISOString();

    const selfEntry: SessionEntry = {
      session_id: mcpSelfSessionId,
      id8: "drifted0",
      role: "prime",
      name: `auto-${mcpSelfSessionId.slice(0, 8)}`,
      started_at: now,
      last_heartbeat_at: now,
    };
    writeSession(stateDir, selfEntry);

    // Without the self-filter, the MCP self-row leaks as a "sibling"
    // because the caller filters only by harness id and the heartbeat is
    // fresh. This is the bug.
    const unfilteredOthers = getLiveOtherSessionIds(harnessSessionId);
    expect(unfilteredOthers).not.toBeNull();
    expect(unfilteredOthers).toContain(mcpSelfSessionId);

    // After the MCP registers its selfSession, the resolver MUST drop
    // the self-row regardless of caller id mismatch.
    setSelfSessionForLiveFilter(mcpSelfSessionId);
    const filteredOthers = getLiveOtherSessionIds(harnessSessionId);
    expect(filteredOthers).not.toBeNull();
    expect(filteredOthers).not.toContain(mcpSelfSessionId);
    expect(filteredOthers).toEqual([]);
  });

  test("still returns genuine sibling sessions", () => {
    // A real sibling MCP also has a row. The self-filter MUST NOT
    // accidentally hide it.
    const mcpSelfSessionId = "self-id-ccccccccc";
    const realSiblingId = "real-sibling-dddddddd";
    const harnessSessionId = mcpSelfSessionId; // caller in sync with self
    const now = new Date().toISOString();

    writeSession(stateDir, {
      session_id: mcpSelfSessionId,
      id8: "selfcccc",
      role: "prime",
      name: "PA-test",
      started_at: now,
      last_heartbeat_at: now,
    });
    writeSession(stateDir, {
      session_id: realSiblingId,
      id8: "realsibd",
      role: "subordinate",
      name: "SA-test",
      started_at: now,
      last_heartbeat_at: now,
    });

    setSelfSessionForLiveFilter(mcpSelfSessionId);
    const others = getLiveOtherSessionIds(harnessSessionId);
    expect(others).not.toBeNull();
    expect(others).toEqual([realSiblingId]);
  });

  test("setSelfSessionForLiveFilter is idempotent and updatable", () => {
    // First the MCP resolves to one id; later, the explicit session_id
    // arrives via a tool call and the MCP updates its self id. The
    // filter must track the latest id without leaking the previous one.
    const firstSelf = "first-self-eeeeeeee";
    const updatedSelf = "updated-self-ffffffff";
    const harnessSessionId = "harness-different-99999999";
    const now = new Date().toISOString();

    writeSession(stateDir, {
      session_id: firstSelf,
      id8: "firstsel",
      role: "prime",
      name: `auto-${firstSelf.slice(0, 8)}`,
      started_at: now,
      last_heartbeat_at: now,
    });
    writeSession(stateDir, {
      session_id: updatedSelf,
      id8: "updateds",
      role: "prime",
      name: `auto-${updatedSelf.slice(0, 8)}`,
      started_at: now,
      last_heartbeat_at: now,
    });

    setSelfSessionForLiveFilter(firstSelf);
    let others = getLiveOtherSessionIds(harnessSessionId);
    expect(others).not.toContain(firstSelf);
    expect(others).toContain(updatedSelf);

    setSelfSessionForLiveFilter(updatedSelf);
    others = getLiveOtherSessionIds(harnessSessionId);
    expect(others).not.toContain(updatedSelf);
    // The original `firstSelf` row was never reaped from the DB; the
    // filter is point-in-time "what is the MCP's CURRENT self id?",
    // not a historical exclusion set. firstSelf reappears as an
    // apparent sibling - acceptable, because in production startAgent
    // -Channel removes the old row before re-registering under the new
    // id. The contract this test pins is "the LATEST registered self
    // id is filtered."
    expect(others).toContain(firstSelf);
  });
});
