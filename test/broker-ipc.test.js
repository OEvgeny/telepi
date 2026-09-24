import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  BROKER_PROTOCOL_VERSION,
  requestBroker,
  resolveBrokerSocketPath,
  startBrokerIpcServer,
} from "../src/broker-ipc.js";

const execFileAsync = promisify(execFile);
const root = resolve(new URL("..", import.meta.url).pathname);

test("broker IPC carries one correlated request over a protected Unix socket", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telepi-broker-ipc-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "broker.sock");
  let received;
  const server = await startBrokerIpcServer({
    socketPath,
    onRequest: (request) => {
      received = request;
      return { accepted: true, echoed: request.message.text };
    },
  });
  t.after(() => server.close());

  const request = {
    version: BROKER_PROTOCOL_VERSION,
    id: "test-1",
    type: "submit",
    message: { text: "line one\nline two — привет" },
  };
  const response = await requestBroker(socketPath, request);

  assert.deepEqual(received, request);
  assert.deepEqual(response, { accepted: true, echoed: request.message.text });
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
});

test("broker client reports an unavailable socket clearly", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telepi-broker-missing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "missing.sock");

  await assert.rejects(
    requestBroker(socketPath, { id: "missing" }, { timeoutMs: 100 }),
    /broker is unavailable/,
  );
});

test("topic:prompt submits to the broker instead of starting pi directly", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telepi-broker-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "broker.sock");
  const configPath = join(directory, "telepi.yaml");
  await writeFile(configPath, [
    "version: 1",
    "project:",
    `  root: ${JSON.stringify(directory)}`,
    "  entities_dir: entities",
    "  sessions_dir: sessions",
    "  cache_dir: cache",
    "telegram:",
    "  bot_token_env: TEST_BOT_TOKEN_THAT_IS_NOT_SET",
    "users:",
    "  owner: Test User",
    "  aliases:",
    "    Test User:",
    "      id: '1'",
    "agents:",
    "  target:",
    "    name: Target",
    "    entity_dir: entities/target",
    "topics:",
    "  - name: Target",
    "    agent: target",
    "    chat_id: '10'",
    "    topic_id: '20'",
    "    session_id: target-session",
  ].join("\n"));

  let received;
  const server = await startBrokerIpcServer({
    socketPath,
    onRequest: (request) => {
      received = request;
      return {
        accepted: true,
        status: "started",
        topic: "Target",
        agent: "target",
        sessionId: "target-session",
        telegramMessageId: null,
      };
    },
  });
  t.after(() => server.close());

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    join(root, "bin/telepi.js"),
    "-c", configPath,
    "topic:prompt",
    "--topic", "Target",
    "--text", "Broker delivery",
    "--no-echo",
    "--from", "Source Agent",
    "--source", "agent-message-test",
  ], {
    cwd: root,
    env: { ...process.env, TELEPI_BROKER_SOCKET: socketPath },
  });

  assert.equal(stderr, "");
  assert.match(stdout, /accepted Target -> target\/target-session status=started/);
  assert.equal(received.type, "submit");
  assert.deepEqual(received.target, { topic: "Target" });
  assert.deepEqual(received.message, { text: "Broker delivery" });
  assert.deepEqual(received.origin, {
    kind: "cli",
    name: "Source Agent",
    source: "agent-message-test",
  });
  assert.deepEqual(received.options, { echo: false });
  assert.match(received.id, /^cli:/);
});

test("broker socket path defaults to the configured cache and supports an override", () => {
  const config = { project: { cache_dir: "/tmp/telepi-cache" } };
  assert.equal(resolveBrokerSocketPath(config, {}), "/tmp/telepi-cache/broker.sock");
  assert.equal(
    resolveBrokerSocketPath(config, { TELEPI_BROKER_SOCKET: "/tmp/custom-telepi.sock" }),
    "/tmp/custom-telepi.sock",
  );
});
