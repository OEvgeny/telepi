import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildPiRunSpec } from "../src/pi-session.js";
import { hydrateEnvelopeMedia, updateToEnvelope } from "../src/telegram.js";

function telegramUpdate(media) {
  return {
    update_id: 1,
    message: {
      message_id: 42,
      message_thread_id: 7,
      chat: { id: 100 },
      from: { id: 200, first_name: "Tester" },
      ...media,
    },
  };
}

test("Telegram voice notes are accepted and hydrated as transcribable audio", async (t) => {
  const cacheDir = mkdtempSync(join(tmpdir(), "telepi-voice-"));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));

  const envelope = updateToEnvelope(telegramUpdate({
    voice: {
      file_id: "voice-file-id",
      file_size: 321,
      duration: 2,
    },
  }));

  assert.ok(envelope);
  assert.equal(envelope.text, "");
  assert.deepEqual(envelope.telegramAttachments, [{
    kind: "voice",
    fileId: "voice-file-id",
    mimeType: "audio/ogg",
    fileSize: 321,
  }]);

  const hydrated = await hydrateEnvelopeMedia({
    async getFile(fileId) {
      assert.equal(fileId, "voice-file-id");
      return { file_path: "voice/file_1" };
    },
    async downloadFile(filePath) {
      assert.equal(filePath, "voice/file_1");
      return Buffer.from("voice bytes");
    },
  }, {
    project: { cache_dir: cacheDir },
  }, envelope);

  assert.equal(hydrated.telegramAttachments.length, 0);
  assert.equal(hydrated.attachments.length, 1);
  assert.equal(hydrated.attachments[0].type, "audio");
  assert.equal(hydrated.attachments[0].mimeType, "audio/ogg");
  assert.match(hydrated.attachments[0].path, /42-voice\.ogg$/);
  assert.equal(readFileSync(hydrated.attachments[0].path, "utf8"), "voice bytes");
});

test("Telegram audio files are accepted and preserve their real extension", async (t) => {
  const cacheDir = mkdtempSync(join(tmpdir(), "telepi-audio-"));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));

  const envelope = updateToEnvelope(telegramUpdate({
    audio: {
      file_id: "audio-file-id",
      file_name: "recording.oga",
      mime_type: "audio/ogg; codecs=opus",
      file_size: 654,
      duration: 3,
    },
  }));

  assert.ok(envelope);
  assert.equal(envelope.telegramAttachments[0].kind, "audio");

  const hydrated = await hydrateEnvelopeMedia({
    async getFile() {
      return { file_path: "audio/file_2" };
    },
    async downloadFile() {
      return Buffer.from("audio bytes");
    },
  }, {
    project: { cache_dir: cacheDir },
  }, envelope);

  assert.equal(hydrated.attachments[0].type, "audio");
  assert.match(hydrated.attachments[0].path, /42-audio\.oga$/);
});

test("agent attachment guidance directs audio to transcribe_file", (t) => {
  const root = mkdtempSync(join(tmpdir(), "telepi-audio-prompt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const topic = { name: "Test", agent: "test", topic_id: "7" };
  const config = {
    project: {
      root,
      sessions_dir: join(root, "sessions"),
      cache_dir: join(root, "cache"),
      extensions: [],
    },
    telegram: { bot_token_env: "TELEPI_BOT_TOKEN" },
    users: { aliases: {} },
    agents: {
      test: {
        name: "Test",
        entity_dir: "agent",
        skills: [],
        extensions: [],
      },
    },
    topics: [topic],
  };
  const envelope = {
    chatId: "100",
    topicId: "7",
    userId: "200",
    userName: "Tester",
    messageId: "42",
    text: "",
    attachments: [{
      type: "audio",
      path: "/tmp/voice.ogg",
      mimeType: "audio/ogg",
      fileSize: 321,
    }],
  };

  const spec = buildPiRunSpec(config, topic, envelope, { botToken: "test-token" });
  assert.match(spec.initialMessage, /use transcribe_file for audio\/video/);
  assert.match(spec.initialMessage, /- audio: \/tmp\/voice\.ogg/);
  assert.doesNotMatch(spec.initialMessage, /use the read tool on the path/);
});
