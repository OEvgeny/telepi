import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createCompactionCheckpoint, hasMeaningfulEntriesAfterLatestCompaction } from "../src/pi-compact.js";
import { resolvePiPackageIndex } from "../src/pi-path.js";

const pi = await import(pathToFileURL(resolvePiPackageIndex()).href);

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content, stopReason = "stop", timestamp = Date.now()) {
  return { role: "assistant", content, api: "test", provider: "test", model: "test", usage, stopReason, timestamp };
}

test("a compaction freshness notice does not make the session compactable again", () => {
  const compaction = { type: "compaction", id: "compact", parentId: "answer" };
  const notice = { type: "custom_message", id: "notice", parentId: "compact", customType: "telepi-compaction-notice" };
  const model = { type: "model_change", id: "model", parentId: "notice" };
  assert.equal(hasMeaningfulEntriesAfterLatestCompaction([compaction, notice, model]), false);
  assert.equal(hasMeaningfulEntriesAfterLatestCompaction([compaction, notice, { type: "message", id: "next" }]), true);
  assert.equal(hasMeaningfulEntriesAfterLatestCompaction([{ type: "message", id: "first" }]), true);
});

test("compaction checkpoint keeps the exact model context without summarized history", () => {
  const sessionDir = mkdtempSync(join(tmpdir(), "telepi-checkpoint-test-"));
  const cwd = process.cwd();
  try {
    const source = pi.SessionManager.create(cwd, sessionDir, { id: "source-session" });
    source.appendMessage({ role: "user", content: [{ type: "text", text: "discard me" }], timestamp: 1 });
    source.appendMessage(assistant([{ type: "text", text: "old answer" }], "stop", 2));
    const firstKeptEntryId = source.appendMessage({
      role: "user",
      content: [{ type: "text", text: "keep me" }],
      timestamp: 3,
    });
    source.appendMessage(assistant([
      { type: "toolCall", id: "call_keep", name: "read", arguments: { path: "x" } },
    ], "toolUse", 4));
    source.appendMessage({
      role: "toolResult",
      toolCallId: "call_keep",
      toolName: "read",
      content: [{ type: "text", text: "kept result" }],
      isError: false,
      timestamp: 5,
    });
    const compactionEntryId = source.appendCompaction("summary of discarded history", firstKeptEntryId, 100);
    source.appendCustomMessageEntry("telepi-compaction-notice", [{ type: "text", text: "freshness notice" }], false);

    const sourceFile = source.getSessionFile();
    const sourceContext = source.buildSessionContext();
    const result = createCompactionCheckpoint(pi.SessionManager, {
      sessionManager: source,
      sourceFile,
      sessionsDir: sessionDir,
      entityDir: cwd,
      sessionId: "checkpoint-session",
      now: new Date("2026-07-30T06:00:00.000Z"),
    });

    const checkpoint = pi.SessionManager.open(result.file, sessionDir, cwd);
    assert.deepEqual(checkpoint.buildSessionContext(), sourceContext);

    const rows = readFileSync(result.file, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(rows[0].id, "checkpoint-session");
    assert.equal(rows[0].parentSession, sourceFile);
    assert.equal(rows[1].id, firstKeptEntryId);
    assert.equal(rows[1].parentId, null);
    assert.equal(rows.find((row) => row.type === "compaction")?.id, compactionEntryId);
    assert.equal(rows.some((row) => JSON.stringify(row).includes("discard me")), false);
    assert.equal(rows.some((row) => JSON.stringify(row).includes("call_keep")), true);
    assert.ok(result.checkpointBytes < result.sourceBytes);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});
