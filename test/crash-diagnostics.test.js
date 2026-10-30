import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  describeError,
  installCrashDiagnostics,
} from "../src/crash-diagnostics.js";
import { createTelegramAdapter } from "../src/telegram/adapter.js";

function adapterConfig(directory) {
  return {
    project: { cache_dir: directory },
    telegram: { bot_token: "test-token" },
    users: { aliases: {} },
    topics: [],
  };
}

test("crash diagnostics record the error, footprint, and in-flight registry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telepi-crash-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const processRef = new EventEmitter();
  const logged = [];
  const inflight = { active: [{ key: "10:20", topic: "Pilot" }], pendingCount: 3 };
  const { recorder } = installCrashDiagnostics({
    cacheDir: directory,
    snapshot: () => inflight,
    log: (message) => logged.push(message),
    processRef,
    now: () => new Date("2026-10-30T07:35:26.000Z"),
    pid: 4242,
    uptime: () => 187,
    memory: () => ({ rss: 8_000_000_000, heapTotal: 4_000_000_000, heapUsed: 3_500_000_000, external: 1, arrayBuffers: 2 }),
  });

  const failure = new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
  // Both handlers must swallow the event: the gateway keeps serving.
  assert.equal(processRef.listeners("unhandledRejection").length, 1);
  assert.equal(processRef.listeners("uncaughtException").length, 1);
  processRef.emit("unhandledRejection", failure);
  processRef.emit("uncaughtException", new Error("boom"));

  const files = (await readdir(recorder.dir)).sort();
  assert.deepEqual(files, [
    "2026-10-30T07-35-26-000Z-uncaughtException.json",
    "2026-10-30T07-35-26-000Z-unhandledRejection.json",
  ]);
  const record = JSON.parse(await readFile(join(recorder.dir, files[1]), "utf8"));
  assert.equal(record.kind, "unhandledRejection");
  assert.equal(record.pid, 4242);
  assert.equal(record.uptimeSeconds, 187);
  assert.equal(record.memory.heapUsed, 3_500_000_000);
  assert.equal(record.error.name, "TypeError");
  assert.equal(record.error.cause.code, "ECONNRESET");
  assert.deepEqual(record.inflight, inflight);
  assert.match(logged[0], /gateway unhandledRejection pid=4242/);
  assert.match(logged[0], /active=1/);
  assert.match(logged[0], /fetch failed/);
});

test("crash diagnostics record a non-zero exit and survive an unreadable snapshot", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telepi-crash-exit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const processRef = new EventEmitter();
  const { recorder } = installCrashDiagnostics({
    cacheDir: directory,
    snapshot: () => {
      throw new Error("snapshot unavailable");
    },
    log: () => {},
    processRef,
    now: () => new Date("2026-10-30T07:35:27.000Z"),
    pid: 1,
    uptime: () => 1,
    memory: () => ({ rss: 1, heapTotal: 1, heapUsed: 1, external: 1, arrayBuffers: 1 }),
  });

  processRef.emit("exit", 0);
  assert.deepEqual(await readdir(recorder.dir).catch(() => []), []);
  processRef.emit("exit", 1);
  const files = await readdir(recorder.dir);
  assert.deepEqual(files, ["2026-10-30T07-35-27-000Z-exit.json"]);
  const record = JSON.parse(await readFile(join(recorder.dir, files[0]), "utf8"));
  assert.equal(record.error.message, "gateway exited with code 1");
  assert.equal(record.inflight.error.message, "snapshot unavailable");
});

test("describeError keeps one cause chain without recursing forever", () => {
  const root = new Error("outer");
  let current = root;
  for (let depth = 0; depth < 6; depth += 1) {
    const next = new Error(`cause ${depth}`);
    current.cause = next;
    current = next;
  }
  const described = describeError(root);
  assert.equal(described.message, "outer");
  assert.equal(described.cause.message, "cause 0");
  assert.equal(described.cause.cause.cause.cause, null);
  assert.deepEqual(describeError("plain string"), { message: "plain string", stack: null, cause: null });
});

test("a failed Telegram edit does not leave the display queue rejected", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telepi-display-queue-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const method = new URL(url).pathname.split("/").at(-1);
    if (method === "getMe") {
      return Response.json({ ok: true, result: { id: 99, first_name: "Test Bot", username: "test_bot" } });
    }
    if (method === "sendMessage") {
      const payload = JSON.parse(options.body);
      return Response.json({ ok: true, result: { message_id: 456, chat: { id: payload.chat_id }, text: payload.text } });
    }
    if (method === "editMessageText") {
      return Response.json({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" }, { status: 400 });
    }
    return Response.json({ ok: true, result: true });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const adapter = await createTelegramAdapter(adapterConfig(directory));
  // A card already on screen makes the first render an edit, which fails.
  const active = {
    displayQueue: Promise.resolve(),
    turnStatusMessage: { chatId: "10", messageId: "456", text: "previous card" },
  };
  const stop = adapter.startTurnStatus(active, { chatId: "10", topicId: "20" }, {
    silenceMs: 1,
    updateMs: 60_000,
  });
  await new Promise((resolveTick) => setTimeout(resolveTick, 80));
  // The card edit failed, the tail is still usable, and later work still runs.
  await active.displayQueue;
  let ran = false;
  active.displayQueue = active.displayQueue.then(() => {
    ran = true;
  });
  await active.displayQueue;
  assert.equal(ran, true);
  stop();
  await active.displayQueue;
});
