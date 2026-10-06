import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { normalizeSessionLocation, readConfig, resolveTopicSession } from "../src/config.js";
import { resolvePiPackageIndex } from "../src/pi/path.js";
import { buildTopicRuntimeSpec, createTopicRuntime } from "../src/pi/runtime.js";
import { buildTopicRunSpec } from "../src/pi/topic-spec.js";

const execFileAsync = promisify(execFile);
const root = resolve(new URL("..", import.meta.url).pathname);

test("SSH session locations reject unsafe SSH option tokens", () => {
  assert.throws(
    () => normalizeSessionLocation({ type: "ssh", cwd: "/work", host: "-oProxyCommand=bad" }, "Unsafe"),
    /Invalid SSH token/,
  );
  assert.throws(
    () => normalizeSessionLocation({ type: "ssh", cwd: "/work", host: "example", user: "bad user" }, "Unsafe"),
    /invalid user/,
  );
  assert.throws(
    () => normalizeSessionLocation({ type: "ssh", cwd: "/work", host: "example", port: 70000 }, "Unsafe"),
    /invalid port/,
  );
});

test("new topic mappings enter location mode with the entity root as agent home and cwd", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telepi-location-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "config"), { recursive: true });
  await mkdir(join(directory, "entities/helper"), { recursive: true });
  await mkdir(join(directory, "projects/example"), { recursive: true });
  await writeFile(join(directory, "entities/helper/AGENTS.md"), "# Helper agent home\n");
  await writeFile(join(directory, "projects/example/AGENTS.md"), "# Example location\n");
  const configPath = join(directory, "config/telepi.yaml");
  await writeFile(configPath, [
    "version: 1",
    "project:",
    "  root: .",
    "  entities_dir: entities",
    "  sessions_dir: sessions",
    "  cache_dir: cache",
    "telegram:",
    "  allowed_user_ids: []",
    "agents:",
    "  helper:",
    "    name: Helper",
    "    entity_dir: entities/helper",
    "    session_id: helper-main",
    "topics: []",
  ].join("\n"));

  await execFileAsync(process.execPath, [
    join(root, "bin/telepi.js"),
    "-c", configPath,
    "topic:bind",
    "--chat-id", "1",
    "--topic-id", "2",
    "--name", "Helper",
    "--agent", "helper",
  ], { cwd: root });

  const validation = await execFileAsync(process.execPath, [
    join(root, "bin/telepi.js"),
    "-c", configPath,
    "validate",
  ], { cwd: root });
  assert.match(validation.stdout, /^ok: 1 topic\(s\), 1 agent\(s\)/);

  const config = readConfig(configPath);
  const topic = config.topics[0];
  assert.deepEqual(topic.session, {
    id: "helper-main",
    location: { cwd: "entities/helper" },
  });

  const infrastructureAgentDir = join(directory, "host-pi-agent");
  const defaultSpec = buildTopicRuntimeSpec(config, topic, { infrastructureAgentDir });
  assert.equal(defaultSpec.agentDir, join(directory, "entities/helper"));
  assert.equal(defaultSpec.cwd, join(directory, "entities/helper"));
  assert.equal(defaultSpec.infrastructureAgentDir, infrastructureAgentDir);

  topic.session.location.cwd = "projects/example";
  const locatedSpec = buildTopicRuntimeSpec(config, topic, { infrastructureAgentDir });
  assert.equal(locatedSpec.agentDir, join(directory, "entities/helper"));
  assert.equal(locatedSpec.cwd, join(directory, "projects/example"));

  const pi = await import(pathToFileURL(resolvePiPackageIndex()).href);
  const { runtime } = await createTopicRuntime(pi, config, topic, {
    infrastructureAgentDir: pi.getAgentDir(),
  });
  try {
    assert.deepEqual(
      runtime.services.resourceLoader.getAgentsFiles().agentsFiles.map((file) => file.path),
      [
        join(directory, "entities/helper/AGENTS.md"),
        join(directory, "projects/example/AGENTS.md"),
      ],
    );
  } finally {
    await runtime.dispose();
  }

  await writeFile(
    join(config.project.sessions_dir, "location-session.jsonl"),
    `${JSON.stringify({ type: "session", id: "helper-main", cwd: join(directory, "projects/example") })}\n`,
  );
  topic.session.location.cwd = "entities/helper";
  await assert.rejects(
    createTopicRuntime(pi, config, topic, { infrastructureAgentDir: pi.getAgentDir() }),
    /rotate the topic session before changing its location/,
  );

  topic.session.location = { type: "ssh", host: "remote-alias", cwd: "/remote/project" };
  const remoteSession = resolveTopicSession(config, topic);
  assert.equal(remoteSession.cwd, "/remote/project");
  assert.equal(remoteSession.location.type, "ssh");
  assert.throws(
    () => buildTopicRunSpec(config, topic, { chatId: "1", topicId: "2", text: "test" }),
    /supported only by the Durable backend/,
  );

  const legacyTopic = { ...topic, name: "Legacy", topic_id: "3", session_id: "legacy" };
  delete legacyTopic.session;
  const legacySpec = buildTopicRuntimeSpec(config, legacyTopic, { infrastructureAgentDir });
  assert.equal(legacySpec.agentDir, infrastructureAgentDir);
  assert.equal(legacySpec.cwd, join(directory, "entities/helper"));
});
