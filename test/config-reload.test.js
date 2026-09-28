import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReloadingConfigReader, resolveTopicSession } from "../src/config.js";

function configYaml(root, sessionId) {
  return `version: 1
project:
  root: ${JSON.stringify(root)}
agents:
  test-agent:
    name: Test Agent
    entity_dir: entities/test-agent
topics:
  - name: Test Agent
    chat_id: "1"
    topic_id: "2"
    agent: test-agent
    session_id: ${sessionId}
`;
}

test("reloading config reader observes an externally checkpointed session", () => {
  const root = mkdtempSync(join(tmpdir(), "telepi-config-reload-"));
  const configPath = join(root, "telepi.yaml");
  const errors = [];

  try {
    writeFileSync(configPath, configYaml(root, "old-session"));
    const getConfig = createReloadingConfigReader(configPath, {
      onError: (error) => errors.push(error),
    });

    const before = getConfig();
    assert.equal(resolveTopicSession(before, before.topics[0]).id, "old-session");

    writeFileSync(configPath, configYaml(root, "checkpoint-session"));
    const after = getConfig();
    assert.equal(resolveTopicSession(after, after.topics[0]).id, "checkpoint-session");

    writeFileSync(configPath, "topics: [\n");
    const fallback = getConfig();
    assert.equal(resolveTopicSession(fallback, fallback.topics[0]).id, "checkpoint-session");
    assert.equal(errors.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
