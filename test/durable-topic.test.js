import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { readConfig } from "../src/config.js";
import { describeUnanswered, durableEventToDisplayEvents, durableEventToPiEvents, durableUnavailableMessage, runDurableTopic, stageEnvelopeAttachments } from "../src/durable/gateway-run.js";
import { isTelegramDeliveryEvent } from "../src/telegram/adapter.js";
import {
  buildDurableEndpointSpec,
  buildDurableSubmission,
  durableEndpointKey,
  formatBackendSwitchNotice,
  formatLocationSwitchNotice,
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
    chatId: "10",
    topicId: "20",
    topicName: "Pilot",
    modelSpec: "provider/model:high",
    legacySessionId: "legacy-session",
    skillPaths: ["/tmp/telepi-durable-topic/skills/test/SKILL.md"],
    systemPrompt: "Agent instructions",
    noContextFiles: false,
    // The Pi extensions this topic would load on the Pi backend.
    piExtensions: {
      cwd: "/tmp/telepi-durable-topic/work/pilot",
      agentDir: "/tmp/telepi-durable-topic/entities/agent",
      infrastructureAgentDir: "/tmp/infrastructure-agent",
      extensionPaths: [],
    },
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

test("Durable configuration notices are short and explicit", () => {
  assert.equal(formatBackendSwitchNotice("durable"), "Backend: Durable. Pi history preserved.");
  assert.equal(formatBackendSwitchNotice("pi"), "Backend: Pi. Durable history preserved.");
  assert.equal(formatLocationSwitchNotice("ssh"), "Location: SSH. Fresh context; previous history preserved.");
  assert.equal(formatLocationSwitchNotice("local"), "Location: local. Fresh context; previous history preserved.");
});

test("Durable watch events adapt to Telepi's existing activity mechanics", () => {
  assert.equal(
    durableUnavailableMessage(new Error("Durable driver is closing")),
    "Durable backend is restarting. Please retry in a moment.",
  );
  assert.equal(durableUnavailableMessage(new Error("provider failed")), null);
  assert.deepEqual(durableEventToPiEvents({ type: "turn_start" }, 2), [{ type: "turn_start", turnIndex: 2 }]);
  assert.deepEqual(durableEventToPiEvents({
    type: "message_update",
    changes: [{ type: "thinking_delta", delta: "hidden" }, { type: "text_delta", delta: "visible" }],
  }), [
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta" } },
  ]);
  assert.deepEqual(durableEventToPiEvents({ type: "turn_end" }), [{ type: "turn_end" }]);
  assert.deepEqual(durableEventToPiEvents({ type: "run_end" }), [{ type: "agent_end" }]);
});

test("Durable runs stream each committed assistant entry before the turn settles", async () => {
  const listeners = new Set();
  let emit;
  const deliveredBeforeSettle = [];
  const sent = [];
  const driver = {
    infrastructureAgentDir: "/tmp/infrastructure-agent",
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async ensureEndpoint() {},
    async submit() {
      emit = (events, endpointKey = "telegram:10:20") => {
        for (const listener of listeners) listener("conversation.events", { endpointKey, events });
      };
      return { submissionId: 7 };
    },
    async waitSubmission() {
      emit([
        { type: "message_start", message: { role: "assistant", content: [] } },
        {
          type: "message_end",
          entry: {
            id: 5,
            model: [{
              role: "assistant",
              content: [
                { type: "text", text: "Checking the logs first." },
                { type: "toolCall", name: "bash" },
              ],
            }],
          },
        },
        // A watch overflow replays the same commit; it must not resend the text.
        {
          type: "message_end",
          entry: { id: 5, model: [{ role: "assistant", content: [{ type: "text", text: "Checking the logs first." }] }] },
        },
      ]);
      // Another conversation's watch batch must be ignored.
      emit([
        { type: "message_end", entry: { id: 6, model: [{ role: "assistant", content: [{ type: "text", text: "Other topic" }] }] } },
      ], "telegram:10:21");
      // Give the queued live delivery a turn to run before the submission settles.
      await new Promise((resolveTick) => setImmediate(resolveTick));
      deliveredBeforeSettle.push(...sent);
      return {
        status: "done",
        answers: [
          { entryId: 5, text: "Checking the logs first." },
          { entryId: 9, text: "All services are healthy." },
        ],
      };
    },
    async abort() {},
  };
  const telegram = {
    async queueAssistantTextDisplay(_active, envelope, text) {
      assert.equal(envelope.chatId, "10");
      sent.push(text);
    },
  };
  const active = { steered: [], resolveReady() {}, envelope: { chatId: "10", topicId: "20", messageId: "30" } };

  const result = await runDurableTopic(
    driver,
    config,
    telegram,
    { ...config.topics[0], backend: "durable" },
    { chatId: "10", topicId: "20", userId: "owner", userName: "Owner", messageId: "30", text: "Hello" },
    active,
  );

  // Live narration was already in Telegram before the submission settled.
  assert.deepEqual(deliveredBeforeSettle, ["Checking the logs first."]);
  assert.deepEqual(sent, ["Checking the logs first.", "All services are healthy."]);
  assert.equal(result.streamedTextCount, 2);
  assert.equal(result.undeliveredText, "");
  assert.equal(listeners.size, 0);
});

test("Durable runs deliver two entries with the same text twice", async () => {
  const sent = [];
  const driver = {
    infrastructureAgentDir: "/tmp/infrastructure-agent",
    onEvent() { return () => undefined; },
    async ensureEndpoint() {},
    async submit() { return { submissionId: 7 }; },
    async waitSubmission() {
      return { status: "done", answers: [{ entryId: 3, text: "Checking." }, { entryId: 5, text: "Checking." }] };
    },
    async abort() {},
  };
  const telegram = { async queueAssistantTextDisplay(_active, _envelope, text) { sent.push(text); } };
  const active = { steered: [], resolveReady() {}, envelope: { chatId: "10", topicId: "20", messageId: "30" } };
  const result = await runDurableTopic(
    driver,
    config,
    telegram,
    { ...config.topics[0], backend: "durable" },
    { chatId: "10", topicId: "20", userId: "owner", userName: "Owner", messageId: "30", text: "Hi" },
    active,
  );
  assert.deepEqual(sent, ["Checking.", "Checking."]);
  assert.equal(result.streamedTextCount, 2);
});

test("Durable runs retain assistant text rejected by Telegram for final delivery", async () => {
  const driver = {
    infrastructureAgentDir: "/tmp/infrastructure-agent",
    async ensureEndpoint() {},
    async submit() { return { submissionId: 7 }; },
    async waitSubmission() {
      return { status: "done", answers: [{ entryId: 9, text: "Persisted Durable answer" }] };
    },
    async abort() {},
  };
  const telegram = {
    async queueAssistantTextDisplay() { throw new Error("Telegram sendMessage timed out"); },
  };
  const active = {
    steered: [],
    resolveReady() {},
  };
  const result = await runDurableTopic(
    driver,
    config,
    { ...telegram },
    { ...config.topics[0], backend: "durable" },
    {
      chatId: "10",
      topicId: "20",
      userId: "owner",
      userName: "Owner",
      messageId: "30",
      text: "Hello",
    },
    active,
  );
  assert.equal(result.ok, true);
  assert.equal(result.streamedTextCount, 0);
  assert.equal(result.undeliveredText, "Persisted Durable answer");
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
    "--port", "8022", "--identity-file", identityFile, "--agent-dir", "/remote/agent/effective",
  ], { cwd: root });
  const updated = readConfig(configPath);
  const topic = updated.topics[0];
  assert.deepEqual(topic.session.location, {
    type: "ssh",
    host: "tablet-alias",
    user: "agent",
    port: 8022,
    identity_file: identityFile,
    agent_dir: "/remote/agent/effective",
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

test("Durable SSH submissions name attachments by their path on the remote machine", async () => {
  const sshEndpoint = { endpointKey: "telegram:10:20", location: { type: "ssh", host: "box" } };
  const envelope = {
    chatId: "10",
    topicId: "20",
    userId: "owner",
    userName: "Owner",
    messageId: "31",
    text: "look",
    attachments: [{ type: "image", path: "/gateway/cache/images/10/20/31-photo.jpg", mimeType: "image/jpeg" }],
  };
  const requests = [];
  const driver = {
    async stageAttachments(endpointKey, request) {
      requests.push({ endpointKey, request });
      return { attachments: request.attachments.map((attachment) => ({ ...attachment, path: "/home/u/.local/state/telepi/attachments/10/20/31-photo.jpg" })) };
    },
  };
  const staged = await stageEnvelopeAttachments(driver, sshEndpoint, envelope);
  assert.equal(requests.length, 1);
  const content = buildDurableSubmission(config, config.topics[0], staged).content;
  assert.match(content, /- image: \/home\/u\/\.local\/state\/telepi\/attachments\/10\/20\/31-photo\.jpg/);
  assert.doesNotMatch(content, /\/gateway\/cache/);

  // A local conversation reads the gateway path directly: no copy.
  const local = await stageEnvelopeAttachments(driver, { ...sshEndpoint, location: { type: "local" } }, envelope);
  assert.equal(local, envelope);
  assert.equal(requests.length, 1);

  // A failed copy keeps the message, says why, and names no gateway path.
  const failing = { async stageAttachments() { throw new Error("ssh: connection refused"); } };
  const unavailable = await stageEnvelopeAttachments(failing, sshEndpoint, envelope);
  const failedContent = buildDurableSubmission(config, config.topics[0], unavailable).content;
  assert.match(failedContent, /- image: unavailable \(not copied to box: ssh: connection refused\)/);
  assert.doesNotMatch(failedContent, /\/gateway\/cache/);
});

test("Durable events feed display_messages and delivery counting in Pi's shapes", async () => {
  const answer = {
    type: "message_end",
    entry: { id: 4, model: [{ role: "assistant", content: [
      { type: "thinking", thinking: "weighing it" },
      { type: "text", text: "Sending the photo." },
      { type: "toolCall", id: "c1", name: "telepi_send_image", arguments: { file_path: "a.png" } },
    ] }] },
  };
  assert.deepEqual(durableEventToDisplayEvents(answer).map((event) => event.assistantMessageEvent.type), [
    "thinking_end",
    "text_end",
    "toolcall_end",
  ]);

  const result = { role: "toolResult", toolCallId: "c1", toolName: "telepi_send_image", isError: false,
    content: [{ type: "text", text: "Image sent" }], details: { messageId: "77", message_id: "77" } };
  const end = { type: "tool_execution_end", toolCallId: "c1", toolName: "telepi_send_image", entry: { id: 5, model: [result] } };
  const [piEnd] = durableEventToPiEvents(end);
  assert.deepEqual(piEnd.result, { content: result.content, details: result.details });

  // The gateway's own check counts it as delivered output, as on Pi topics.
  assert.equal(isTelegramDeliveryEvent(piEnd), true);

  // A display_messages config with tool cards sees the tool result.
  assert.deepEqual(durableEventToDisplayEvents({ type: "message_end", entry: { id: 5, model: [result] } }), [
    { type: "message_end", message: result },
  ]);
});

test("Durable runs report a model error as Pi topics do and name other failures plainly", async () => {
  const driver = {
    infrastructureAgentDir: "/tmp/infrastructure-agent",
    onEvent() { return () => undefined; },
    async ensureEndpoint() {},
    async submit() { return { submissionId: 7 }; },
    async waitSubmission() { return { status: "unanswered", reason: "model_error", detail: "429 rate limited" }; },
    async abort() {},
  };
  const active = { steered: [], resolveReady() {}, envelope: { chatId: "10", topicId: "20", messageId: "30" } };
  const result = await runDurableTopic(driver, config, { async queueAssistantTextDisplay() {} },
    { ...config.topics[0], backend: "durable" },
    { chatId: "10", topicId: "20", userId: "owner", userName: "Owner", messageId: "30", text: "Hi" }, active);
  assert.equal(result.ok, true);
  assert.equal(result.modelError, "429 rate limited");

  assert.equal(describeUnanswered("turn_limit", "40 turns"), "Durable run ended without an answer: the run reached its tool-round limit (40 turns).");
  assert.equal(describeUnanswered("weird"), "Durable run ended without an answer: reason weird.");
});

test("Durable runs send no assistant text when display_messages turns it off", async () => {
  const sent = [];
  const driver = {
    infrastructureAgentDir: "/tmp/infrastructure-agent",
    onEvent() { return () => undefined; },
    async ensureEndpoint() {},
    async submit() { return { submissionId: 7 }; },
    async waitSubmission() { return { status: "done", answers: [{ entryId: 3, text: "hidden" }] }; },
    async abort() {},
  };
  const active = {
    steered: [],
    resolveReady() {},
    envelope: { chatId: "10", topicId: "20", messageId: "30" },
    display: { streamAssistantMessages: false },
  };
  const result = await runDurableTopic(driver, config, { async queueAssistantTextDisplay(_a, _e, text) { sent.push(text); } },
    { ...config.topics[0], backend: "durable" },
    { chatId: "10", topicId: "20", userId: "owner", userName: "Owner", messageId: "30", text: "Hi" }, active);
  assert.deepEqual(sent, []);
  assert.equal(result.streamedTextCount, 0);
});
