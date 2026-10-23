import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TelegramMessageIndex } from "../src/telegram/message-index.js";
import { lookupTelegramMessage } from "../src/telegram/message-lookup.js";

function config() {
  return {
    topics: [{
      name: "Current",
      agent: "agent",
      chat_id: "10",
      topic_id: "20",
      enabled: true,
    }],
  };
}

test("Telegram message index keeps complete recent incoming and outgoing text across reloads", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telepi-message-index-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "messages.jsonl");
  const text = "x".repeat(4_000);
  const first = new TelegramMessageIndex(path);

  first.init();
  first.record({
    chat_id: "10",
    topic_id: "20",
    message_id: "30",
    direction: "incoming",
    user_name: "Person",
    text,
  });
  first.record({
    chat_id: "10",
    topic_id: "20",
    message_id: "31",
    direction: "outgoing",
    agent_id: "agent",
    text: "answer",
  });
  await appendFile(path, "not json\n", "utf8");

  const reopened = new TelegramMessageIndex(path);
  reopened.init();
  assert.equal(reopened.find("10", "30").text, text);
  assert.equal(reopened.find("10", "30").user_name, "Person");
  assert.equal(reopened.find("10", "31").text, "answer");
  assert.equal(reopened.find("10", "missing"), null);
});

test("Telegram message lookup is current-topic-only and explains cache misses", () => {
  const records = new Map([
    ["30", {
      chat_id: "10",
      topic_id: "20",
      message_id: "30",
      direction: "incoming",
      user_name: "Person",
      text: "the referenced text",
      text_truncated: false,
    }],
    ["31", {
      chat_id: "10",
      topic_id: "other-topic",
      message_id: "31",
      text: "private elsewhere",
    }],
  ]);
  const telegram = {
    findTelegramMessageRecord(chatId, messageId) {
      assert.equal(chatId, "10");
      return records.get(messageId) || null;
    },
  };
  const request = {
    topicName: "Current",
    agentId: "agent",
    chatId: "10",
    topicId: "20",
    messageId: "30",
  };

  assert.deepEqual(lookupTelegramMessage(config(), telegram, request), {
    found: true,
    messageId: "30",
    text: "the referenced text",
    textTruncated: false,
    direction: "incoming",
    userName: "Person",
    agentId: null,
    attachments: [],
    createdAt: null,
  });
  const missing = lookupTelegramMessage(config(), telegram, { ...request, messageId: "99" });
  assert.equal(missing.found, false);
  assert.match(missing.limitation, /Bot API cannot fetch/);
  assert.equal(lookupTelegramMessage(config(), telegram, { ...request, messageId: "31" }).found, false);
  assert.throws(
    () => lookupTelegramMessage(config(), telegram, { ...request, agentId: "other" }),
    /limited to the current topic/,
  );
  assert.throws(
    () => lookupTelegramMessage(config(), telegram, { ...request, messageId: "not-a-number" }),
    /positive integer/,
  );
});
