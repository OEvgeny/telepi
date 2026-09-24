import assert from "node:assert/strict";
import test from "node:test";

import { buildSdkRunSpec } from "../src/pi/sdk-driver.js";
import { buildTopicRuntimeSpec } from "../src/pi/runtime.js";
import { parseWorkerArgs, resolveWorkerTopic } from "../src/pi/worker.js";

const config = {
  _path: "/tmp/telepi-sdk-test/config/telepi.yaml",
  telegram: { bot_token_env: "TEST_TOKEN" },
  users: { aliases: {} },
  project: {
    root: "/tmp/telepi-sdk-test",
    entities_dir: "/tmp/telepi-sdk-test/entities",
    sessions_dir: "/tmp/telepi-sdk-test/sessions",
    cache_dir: "/tmp/telepi-sdk-test/cache",
    extensions: ["extensions/shared.ts"],
  },
  agents: {
    testagent: {
      name: "Test Agent",
      entity_dir: "entities/testagent",
      session_id: "testagent-default",
      skills: ["skills/telepi-dev/SKILL.md"],
      extensions: ["entities/testagent/.pi/extensions/private.ts", "extensions/shared.ts"],
      system_prompt: "Agent override",
    },
  },
  topics: [
    {
      name: "Test Agent",
      agent: "testagent",
      chat_id: "1",
      topic_id: "10",
      session_id: "testagent-session",
      model: "vllm/test-model:high",
      enabled: true,
    },
  ],
};

const envelope = {
  chatId: "1",
  topicId: "10",
  userId: "owner",
  userName: "Test User",
  messageId: "42",
  text: "Continue the work.",
  attachments: [],
};

test("SDK driver starts the routed worker while preserving the gateway run spec", () => {
  const spec = buildSdkRunSpec(config, config.topics[0], envelope, { botToken: "test-token" });

  assert.match(spec.cliPath, /\/src\/pi\/worker\.js$/);
  assert.deepEqual(spec.args, [
    "--config", config._path,
    "--chat-id", "1",
    "--topic-id", "10",
    "--expected-topic-name", "Test Agent",
    "--expected-agent", "testagent",
    "--expected-session-id", "testagent-session",
  ]);
  assert.equal(spec.cwd, "/tmp/telepi-sdk-test/entities/testagent");
  assert.equal(spec.sessionId, "testagent-session");
  assert.equal(spec.env.TELEPI_AGENT_ID, "testagent");
  assert.match(spec.initialMessage, /^Telegram topic route: Test Agent/m);
  assert.match(spec.initialMessage, /Continue the work\.$/);
});

test("SDK worker arguments and route expectations reject concurrent config changes", () => {
  const args = parseWorkerArgs([
    "--mode", "rpc",
    "--config", config._path,
    "--chat-id", "1",
    "--topic-id", "10",
    "--expected-topic-name", "Test Agent",
    "--expected-agent", "testagent",
    "--expected-session-id", "testagent-session",
  ]);

  assert.equal(resolveWorkerTopic(config, args), config.topics[0]);
  assert.throws(
    () => resolveWorkerTopic({ ...config, topics: [{ ...config.topics[0], agent: "other" }] }, args),
    /agent changed before startup/,
  );
  assert.throws(
    () => resolveWorkerTopic({ ...config, topics: [{ ...config.topics[0], session_id: "replacement" }] }, args),
    /session changed before startup/,
  );
  assert.throws(() => parseWorkerArgs(["--mode", "print"]), /Missing worker option|Unsupported worker mode/);
});

test("topic runtime spec preserves current entity cwd and separates infrastructure paths", () => {
  const spec = buildTopicRuntimeSpec(config, config.topics[0], {
    infrastructureAgentDir: "/tmp/pi-host-agent",
  });

  assert.equal(spec.cwd, "/tmp/telepi-sdk-test/entities/testagent");
  assert.equal(spec.agentDir, "/tmp/pi-host-agent");
  assert.equal(spec.infrastructureAgentDir, "/tmp/pi-host-agent");
  assert.equal(spec.sessionId, "testagent-session");
  assert.equal(spec.modelSpec, "vllm/test-model:high");
  assert.deepEqual(spec.extensionPaths, [
    "/tmp/telepi-sdk-test/extensions/shared.ts",
    "/tmp/telepi-sdk-test/entities/testagent/.pi/extensions/private.ts",
  ]);
  assert.deepEqual(spec.skillPaths, ["/tmp/telepi-sdk-test/skills/telepi-dev/SKILL.md"]);
  assert.deepEqual(spec.appendSystemPrompt, ["Agent override"]);
});
