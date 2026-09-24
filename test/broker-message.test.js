import assert from "node:assert/strict";
import test from "node:test";

import {
  createBrokerEnvelope,
  normalizeBrokerSubmitRequest,
  resolveBrokerTarget,
} from "../src/broker-message.js";
import { buildTopicRunSpec } from "../src/pi/topic-spec.js";

const config = {
  telegram: { bot_token_env: "TEST_TOKEN" },
  users: { aliases: {} },
  project: {
    root: "/tmp/telepi-test",
    entities_dir: "/tmp/telepi-test/entities",
    sessions_dir: "/tmp/telepi-test/sessions",
    cache_dir: "/tmp/telepi-test/cache",
    extensions: [],
  },
  agents: {
    primary: { name: "Primary", entity_dir: "/tmp/telepi-test/entities/primary", skills: [], extensions: [] },
    secondary: { name: "Secondary", entity_dir: "/tmp/telepi-test/entities/secondary", skills: [], extensions: [] },
  },
  topics: [
    { name: "Primary", agent: "primary", chat_id: "1", topic_id: "10", session_id: "primary-session" },
    { name: "Secondary", agent: "secondary", chat_id: "1", topic_id: "20", session_id: "secondary-main" },
    { name: "Secondary Alternate", agent: "secondary", chat_id: "1", topic_id: "21", session_id: "secondary-alternate" },
  ],
};

test("broker submit normalization and target resolution support topics and unique agents", () => {
  const submit = normalizeBrokerSubmitRequest({
    version: 1,
    type: "submit",
    id: "sender:call-1",
    target: { name: "Primary" },
    message: { text: "Please inspect the gateway." },
    origin: {
      kind: "agent",
      name: "Sender",
      agentId: "sender",
      topicName: "Sender",
    },
    options: { echo: false },
  });

  assert.equal(resolveBrokerTarget(config, submit.target).session_id, "primary-session");
  assert.equal(resolveBrokerTarget(config, { agent: "primary" }).name, "Primary");
  assert.throws(() => resolveBrokerTarget(config, { agent: "secondary" }), /multiple enabled topics/);
  assert.throws(() => resolveBrokerTarget(config, { name: "missing" }), /No enabled topic mapping/);
});

test("broker messages use a transport-neutral routing header and expose the broker socket", () => {
  const submit = normalizeBrokerSubmitRequest({
    version: 1,
    type: "submit",
    id: "sender:call-2",
    target: { topic: "Primary" },
    message: { text: "A broker-routed message" },
    origin: {
      kind: "agent",
      name: "Sender",
      agentId: "sender",
      topicName: "Sender",
      source: "agent:sender",
    },
    options: { echo: false },
  });
  const topic = resolveBrokerTarget(config, submit.target);
  const envelope = createBrokerEnvelope(topic, submit);
  const previousToken = process.env.TEST_TOKEN;
  const previousBrokerSocket = process.env.TELEPI_BROKER_SOCKET;
  process.env.TEST_TOKEN = "test-token";
  delete process.env.TELEPI_BROKER_SOCKET;
  try {
    const spec = buildTopicRunSpec(config, topic, envelope);
    assert.match(spec.initialMessage, /^Telepi broker route: Primary/m);
    assert.match(spec.initialMessage, /^telepi_sender_kind=agent$/m);
    assert.match(spec.initialMessage, /^telepi_sender_agent_id=sender$/m);
    assert.match(spec.initialMessage, /^telepi_sender_topic=Sender$/m);
    assert.doesNotMatch(spec.initialMessage, /^Telegram topic route:/m);
    assert.equal(spec.env.TELEPI_BROKER_SOCKET, "/tmp/telepi-test/cache/broker.sock");
  } finally {
    if (previousToken === undefined) delete process.env.TEST_TOKEN;
    else process.env.TEST_TOKEN = previousToken;
    if (previousBrokerSocket === undefined) delete process.env.TELEPI_BROKER_SOCKET;
    else process.env.TELEPI_BROKER_SOCKET = previousBrokerSocket;
  }
});

test("broker requests reject malformed or ambiguous input", () => {
  assert.throws(
    () => normalizeBrokerSubmitRequest({ version: 1, type: "submit", id: "1", target: { topic: "A", agent: "a" }, message: { text: "x" } }),
    /exactly one/,
  );
  assert.throws(
    () => normalizeBrokerSubmitRequest({ version: 1, type: "submit", id: "1", target: { topic: "A" }, message: { text: " " } }),
    /must not be empty/,
  );
  assert.throws(
    () => normalizeBrokerSubmitRequest({ version: 2, type: "submit", id: "1", target: { topic: "A" }, message: { text: "x" } }),
    /Unsupported broker protocol/,
  );
});
