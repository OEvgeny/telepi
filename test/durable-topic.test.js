import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { readConfig } from "../src/config.js";
import { durableEventToPiEvents } from "../src/durable/gateway-run.js";
import {
  buildDurableEndpointSpec,
  buildDurableSubmission,
  durableEndpointKey,
  resolveTopicBackend,
} from "../src/durable/topic.js";

const execFileAsync = promisify(execFile);
const root = resolve(new URL("..", import.meta.url).pathname);

const config = {
  project: { root: "/tmp/telepi-durable-topic", sessions_dir: "/tmp/sessions", cache_dir: "/tmp/cache" },
  users: { aliases: {} },
  agents: {
    agent: {
      name: "Agent",
      entity_dir: "entities/agent",
      skills: ["skills/test/SKILL.md"],
      system_prompt: "Agent instructions",
    },
  },
  topics: [{
    name: "Pilot",
    agent: "agent",
    chat_id: "10",
    topic_id: "20",
    model: "provider/model:high",
    session: { id: "legacy-session", location: { cwd: "work/pilot" } },
  }],
};

test("Durable topic specs preserve a fresh endpoint beside immutable legacy history", () => {
  const topic = config.topics[0];
  assert.equal(resolveTopicBackend(topic), "pi");
  assert.equal(durableEndpointKey(topic), "telegram:10:20");
  const spec = buildDurableEndpointSpec(config, { ...topic, backend: "durable" }, {
    infrastructureAgentDir: "/tmp/infrastructure-agent",
  });
  assert.deepEqual(spec, {
    endpointKey: "telegram:10:20",
    agentId: "agent",
    agentDir: "/tmp/telepi-durable-topic/entities/agent",
    cwd: "/tmp/telepi-durable-topic/work/pilot",
    location: { type: "local" },
    modelSpec: "provider/model:high",
    legacySessionId: "legacy-session",
    skillPaths: ["/tmp/telepi-durable-topic/skills/test/SKILL.md"],
    systemPrompt: "Agent instructions",
  });
  assert.equal(durableEndpointKey({ ...topic, durable_endpoint_generation: 2 }), "telegram:10:20:g2");
  assert.deepEqual(buildDurableSubmission(config, topic, {
    chatId: "10",
    topicId: "20",
    userId: "owner",
    userName: "Owner",
    messageId: "30",
    text: "Hello",
  }).requestId, "telegram:10:20:30");
});

test("Durable watch events adapt to Telepi's existing activity mechanics", () => {
  assert.deepEqual(durableEventToPiEvents({ type: "turn_start" }, 2), [{ type: "turn_start", turnIndex: 2 }]);
  assert.deepEqual(durableEventToPiEvents({
    type: "message_update",
    changes: [{ type: "thinking_delta", delta: "hidden" }, { type: "text_delta", delta: "visible" }],
  }), [
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta" } },
  ]);
  assert.deepEqual(durableEventToPiEvents({ type: "run_end" }), [{ type: "agent_end" }]);
});

test("topic:set-location configures SSH only for Durable and rotates endpoint context", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telepi-durable-ssh-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "entities", "agent"), { recursive: true });
  const identityFile = join(directory, "identity");
  await writeFile(identityFile, "test-only-key-path");
  const configPath = join(directory, "telepi.yaml");
  await writeFile(configPath, [
    "version: 1",
    "project:",
    `  root: ${JSON.stringify(directory)}`,
    "  entities_dir: entities",
    "  sessions_dir: sessions",
    "  cache_dir: cache",
    "telegram:",
    "  allowed_user_ids: []",
    "agents:",
    "  agent:",
    "    name: Agent",
    "    entity_dir: entities/agent",
    "topics:",
    "  - name: Remote",
    "    agent: agent",
    "    chat_id: '10'",
    "    topic_id: '20'",
    "    model: provider/model",
    "    backend: durable",
    "    session:",
    "      id: legacy-session",
    "      location:",
    "        cwd: entities/agent",
  ].join("\n"));

  await execFileAsync(process.execPath, [
    join(root, "bin/telepi.js"), "-c", configPath,
    "topic:set-location", "--name", "Remote", "--type", "ssh",
    "--cwd", "/remote/work", "--host", "tablet-alias", "--user", "agent",
    "--port", "8022", "--identity-file", identityFile,
  ], { cwd: root });
  const updated = readConfig(configPath);
  const topic = updated.topics[0];
  assert.deepEqual(topic.session.location, {
    type: "ssh",
    host: "tablet-alias",
    user: "agent",
    port: 8022,
    identity_file: identityFile,
    cwd: "/remote/work",
  });
  assert.equal(topic.durable_endpoint_generation, 1);
  assert.equal(updated.sessions.unlinked.at(-1).session_id, "legacy-session");
  assert.equal(buildDurableEndpointSpec(updated, topic).cwd, "/remote/work");
  assert.equal(buildDurableEndpointSpec(updated, topic).location.type, "ssh");

  const validation = await execFileAsync(process.execPath, [
    join(root, "bin/telepi.js"), "-c", configPath, "validate",
  ], { cwd: root });
  assert.match(validation.stdout, /^ok:/);
  await assert.rejects(execFileAsync(process.execPath, [
    join(root, "bin/telepi.js"), "-c", configPath,
    "topic:set-backend", "--name", "Remote", "--backend", "pi",
  ], { cwd: root }), /requires the durable backend/);
});

test("topic:set-backend is the only writer needed to opt a topic in and back out", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telepi-durable-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "entities", "agent"), { recursive: true });
  const configPath = join(directory, "telepi.yaml");
  await writeFile(configPath, [
    "version: 1",
    "project:",
    `  root: ${JSON.stringify(directory)}`,
    "  entities_dir: entities",
    "  sessions_dir: sessions",
    "  cache_dir: cache",
    "telegram:",
    "  allowed_user_ids: []",
    "agents:",
    "  agent:",
    "    name: Agent",
    "    entity_dir: entities/agent",
    "topics:",
    "  - name: Pilot",
    "    agent: agent",
    "    chat_id: '10'",
    "    topic_id: '20'",
    "    model: provider/model",
    "    session_id: legacy-session",
  ].join("\n"));

  await execFileAsync(process.execPath, [
    join(root, "bin/telepi.js"), "-c", configPath,
    "topic:set-backend", "--name", "Pilot", "--backend", "durable",
  ], { cwd: root });
  assert.equal(readConfig(configPath).topics[0].backend, "durable");

  await execFileAsync(process.execPath, [
    join(root, "bin/telepi.js"), "-c", configPath,
    "topic:set-backend", "--name", "Pilot", "--backend", "pi",
  ], { cwd: root });
  assert.equal(readConfig(configPath).topics[0].backend, undefined);
});
