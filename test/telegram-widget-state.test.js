import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createWidgetStateStore,
  handleWidgetQuery,
  readWidgetStateRequest,
  sharedWidgetStateKey,
  widgetStateKey,
} from "../src/telegram/widget-state.js";

function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "telepi-widget-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "widget-states.json");
  return { path, store: createWidgetStateStore(path) };
}

function fakeApi({ failEdit = null } = {}) {
  const calls = [];
  const api = async (method, payload) => {
    calls.push({ method, payload });
    if (method.startsWith("edit") && failEdit) throw Object.assign(new Error(failEdit), { description: failEdit });
    return true;
  };
  api.calls = calls;
  return api;
}

const query = (data, overrides = {}) => ({
  id: "q-1",
  data,
  chat: { id: 151725717, type: "supergroup" },
  message_id: 25986,
  from: { id: 151725717, first_name: "Eugene" },
  ...overrides,
});

test("a widget request must be a small JSON object", () => {
  assert.deepEqual(readWidgetStateRequest('{"n":7}'), { state: '{"n":7}' });
  assert.deepEqual(readWidgetStateRequest('{"n":7, "label":"a b"}'), { state: '{"n":7,"label":"a b"}' });
  assert.deepEqual(readWidgetStateRequest(""), { error: "empty" });
  assert.deepEqual(readWidgetStateRequest("7"), { error: "not-object" });
  assert.deepEqual(readWidgetStateRequest("[1,2]"), { error: "not-object" });
  assert.deepEqual(readWidgetStateRequest("n:7"), { error: "not-json" });
  assert.deepEqual(readWidgetStateRequest(`{"a":"${"x".repeat(80)}"}`), { error: "too-large" });
});

test("the store survives a restart and keeps the newest entries", (t) => {
  const { path, store } = tempStore(t);
  store.set("message:1:2", '{"n":3}', { chatId: 1, messageId: 2 });
  store.set("message:1:4", '{"n":9}', { chatId: 1, messageId: 4 });

  const reloaded = createWidgetStateStore(path);
  assert.deepEqual(reloaded.get("message:1:2"), {
    state: '{"n":3}',
    updatedAt: reloaded.get("message:1:2").updatedAt,
    chatId: 1,
    messageId: 2,
  });
  assert.equal(reloaded.get("message:1:4").state, '{"n":9}');
  assert.equal(reloaded.get("message:9:9"), null);
  assert.equal(reloaded.list().length, 2);

  writeFileSync(path, "not json");
  assert.deepEqual(createWidgetStateStore(path).list(), []);
  assert.match(readFileSync(path, "utf8"), /not json/);
});

test("a tap is answered, mirrored into the message and sampled", async (t) => {
  const { store } = tempStore(t);
  const api = fakeApi();

  const result = await handleWidgetQuery(query('{"n":5}'), { store, api });

  assert.deepEqual(result, { accepted: true, key: "message:151725717:25986", state: '{"n":5}' });
  assert.deepEqual(api.calls.map((call) => call.method), ["answerWidgetQuery", "editMessageWidgetData"]);
  assert.equal(api.calls[0].payload.widget_query_id, "q-1");
  assert.deepEqual(JSON.parse(api.calls[0].payload.data), { ok: 1 });
  assert.equal(api.calls[1].payload.chat_id, 151725717);
  assert.equal(api.calls[1].payload.message_id, 25986);
  assert.equal(api.calls[1].payload.chat_data, '{"n":5}');

  assert.equal(store.get(widgetStateKey({ chatId: 151725717, messageId: 25986 })).state, '{"n":5}');
  assert.equal(store.get(widgetStateKey({ chatId: 151725717, messageId: 25986 })).fromId, 151725717);
});

test("garbage is answered but never stored or mirrored", async (t) => {
  const { store } = tempStore(t);
  const api = fakeApi();
  const logged = [];

  const result = await handleWidgetQuery(query("drop table"), { store, api, log: (line) => logged.push(line) });

  assert.deepEqual(result, { accepted: false, key: "message:151725717:25986", reason: "not-json" });
  assert.deepEqual(api.calls.map((call) => call.method), ["answerWidgetQuery"]);
  assert.deepEqual(JSON.parse(api.calls[0].payload.data), { error: "not-json" });
  assert.equal(store.get(widgetStateKey({ chatId: 151725717, messageId: 25986 })), null);
  assert.match(logged.join("\n"), /widget query rejected/);
});

test("the sample is still recorded when the message edit fails", async (t) => {
  const { store } = tempStore(t);
  const api = fakeApi({ failEdit: "Bad Request: message to edit not found" });
  const logged = [];

  const result = await handleWidgetQuery(query('{"n":2}'), { store, api, log: (line) => logged.push(line) });

  assert.equal(result.accepted, true);
  assert.equal(store.get(widgetStateKey({ chatId: 151725717, messageId: 25986 })).state, '{"n":2}');
  assert.match(logged.join("\n"), /widget state edit failed/);
});

test("'message is not modified' is not an error", async (t) => {
  const { store } = tempStore(t);
  const api = fakeApi({ failEdit: "Bad Request: message is not modified" });
  const logged = [];

  await handleWidgetQuery(query('{"n":2}'), { store, api, log: (line) => logged.push(line) });
  assert.deepEqual(logged, []);
});

test("a shared widget keeps one state under its widget id", async (t) => {
  const { store } = tempStore(t);
  const api = fakeApi();

  const result = await handleWidgetQuery({
    id: "q-2",
    data: '{"v":[1,0]}',
    widget_id: "7770011223344556677",
    from: { id: 151725717 },
  }, { store, api, kind: "shared_widget_query" });

  assert.deepEqual(result, { accepted: true, key: sharedWidgetStateKey("7770011223344556677"), state: '{"v":[1,0]}' });
  assert.deepEqual(api.calls.map((call) => call.method), ["answerWidgetQuery", "editSharedWidgetData"]);
  assert.equal(api.calls[1].payload.widget_id, "7770011223344556677");
  assert.equal(api.calls[1].payload.public_data, '{"v":[1,0]}');
  assert.equal(store.get(sharedWidgetStateKey("7770011223344556677")).widgetId, "7770011223344556677");
});
