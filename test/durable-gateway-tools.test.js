import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDurableGatewayToolHandler } from "../src/durable/gateway-tools.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "telepi-durable-gateway-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const telegram = {
    client: {
      async sendPhoto(params) {
        calls.push({ method: "photo", params });
        return { message_id: 41 };
      },
      async sendMessage(params) {
        calls.push({ method: "message", params });
        return { message_id: 42 };
      },
    },
  };
  const submissions = [];
  const handler = createDurableGatewayToolHandler({
    getConfig: () => ({ project: { cache_dir: directory } }),
    telegram,
    submitBroker: async (request) => {
      submissions.push(request);
      return { topic: "target", agent: "other", status: "started" };
    },
  });
  return { directory, calls, submissions, handler };
}

test("Durable Telegram gateway tools preserve broker provenance and deduplicate requests", async (t) => {
  const { handler, submissions } = await fixture(t);
  const params = {
    requestId: "conversation:call",
    to: "target",
    message: "hello",
    currentAgentId: "source-agent",
    currentTopicName: "source",
  };
  const first = await handler("telegram.sendMessage", params);
  const second = await handler("telegram.sendMessage", params);
  assert.deepEqual(second, first);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].options.echo, false);
  assert.deepEqual(submissions[0].origin, {
    kind: "agent",
    name: "source",
    agentId: "source-agent",
    topicName: "source",
    source: "agent:source-agent",
  });
  await assert.rejects(
    handler("telegram.sendMessage", { ...params, requestId: "self", to: "source" }),
    /cannot target the current topic/,
  );
});

test("Durable Telegram gateway tools upload remote bytes and persist button callbacks", async (t) => {
  const { directory, calls, handler } = await fixture(t);
  const image = await handler("telegram.sendImage", {
    requestId: "image",
    chatId: "10",
    topicId: "20",
    fileName: "proof.png",
    dataBase64: Buffer.from("png-bytes").toString("base64"),
  });
  assert.equal(image.messageId, "41");
  assert.deepEqual(calls[0].params.fileData, Buffer.from("png-bytes"));
  assert.equal(calls[0].params.fileName, "proof.png");

  const buttons = await handler("telegram.sendButtons", {
    requestId: "buttons",
    chatId: "10",
    topicId: "20",
    agentId: "source-agent",
    topicName: "source",
    text: "Choose",
    buttons: ["Yes", { label: "Docs", url: "https://example.test" }],
  });
  assert.equal(buttons.messageId, "42");
  assert.equal(calls[1].params.replyMarkup.inline_keyboard.flat().length, 2);
  const records = (await readFile(join(directory, "button-callbacks.jsonl"), "utf8")).trim().split("\n");
  assert.equal(records.length, 1);
  const record = JSON.parse(records[0]);
  assert.equal(record.agent_id, "source-agent");
  assert.equal(record.topic_name, "source");
  assert.deepEqual(record.buttons, [
    { label: "Yes", data: null },
    { label: "Docs", data: null },
  ]);
});
