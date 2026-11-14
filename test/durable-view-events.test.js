import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

import { openDurableHost } from "../src/durable/runtime.js";
import { createViewEventTranslator, messageChanges } from "../src/durable/view-events.js";

function view(entries, live = {}) {
  return { conversation: { id: 1 }, entries, docs: { "pi.live": live } };
}

test("a streamed partial becomes typed message changes", () => {
  assert.deepEqual(messageChanges(undefined, { content: [{ type: "thinking", thinking: "hm" }] }), [
    { type: "thinking_start", contentIndex: 0, block: { type: "thinking", thinking: "hm" } },
  ]);
  const before = { content: [{ type: "text", text: "Chec" }] };
  const after = { content: [{ type: "text", text: "Checking" }, { type: "toolCall", name: "bash", arguments: {} }] };
  assert.deepEqual(messageChanges(before, after).map((change) => [change.type, change.delta ?? change.block?.name]), [
    ["text_delta", "king"],
    ["toolcall_start", "bash"],
  ]);
  assert.deepEqual(messageChanges(after, after), []);
});

test("view changes become turn, tool, and message events in order", () => {
  const translator = createViewEventTranslator(view([{ id: 1, model: [{ role: "assistant", content: [] }] }]));
  const user = { id: 2, model: [{ role: "user", content: "hi" }] };
  assert.deepEqual(
    translator.advance(view([user], { run: { taskId: 10, inputs: [5], turns: 0 } })).map((event) => event.type),
    ["message_start", "message_end", "run_start", "turn_start"],
  );

  const partial = { role: "assistant", content: [{ type: "text", text: "Look" }] };
  assert.deepEqual(
    translator.advance(view([user], { run: { taskId: 10, inputs: [5], turns: 0 }, generation: { attempt: 1, message: partial } }))
      .map((event) => event.type),
    ["message_start", "message_update"],
  );

  const answer = { id: 3, model: [{ role: "assistant", content: [{ type: "text", text: "Looking" }, { type: "toolCall", id: "c1", name: "bash", arguments: {} }] }] };
  const running = { run: { taskId: 10, inputs: [5], turns: 1 }, tools: [{ callId: "c1", name: "bash", status: "running" }] };
  const events = translator.advance(view([user, answer], running));
  assert.deepEqual(events.map((event) => event.type), ["tool_execution_start", "message_end"]);
  assert.equal(events[1].entry.id, 3);

  const result = { id: 4, model: [{ role: "toolResult", toolCallId: "c1", isError: true, content: [] }] };
  const next = translator.advance(view([user, answer, result], {
    run: { taskId: 11, inputs: [5], turns: 1 },
    tools: [{ callId: "c1", name: "bash", status: "done", entry: 4 }],
  }));
  assert.deepEqual(next.map((event) => event.type), ["tool_execution_end", "message_start", "message_end", "turn_end", "turn_start"]);
  assert.equal(next[0].isError, true);

  const final = { id: 5, model: [{ role: "assistant", content: [{ type: "text", text: "Done" }] }] };
  assert.deepEqual(
    translator.advance(view([user, answer, result, final], {
      runFailure: undefined,
    })).map((event) => event.type),
    ["message_start", "message_end", "turn_end", "run_end"],
  );
});

test("a faulted run is reported once as a task failure", () => {
  const translator = createViewEventTranslator(view([], { run: { taskId: 3, inputs: [1], turns: 0 } }));
  const failed = view([], { runFailure: { taskId: 3, inputs: [1], reason: "faulted", detail: "boom" } });
  const events = translator.advance(failed);
  assert.deepEqual(events.map((event) => event.type), ["task_failed", "turn_end", "run_end"]);
  assert.equal(events[0].message, "boom");
  assert.deepEqual(translator.advance(failed), []);
});

// A 2x2 24-bit BMP: no provider takes BMP, so `read` must convert it.
function bmp() {
  const bytes = Buffer.alloc(54 + 16);
  bytes.write("BM", 0, "ascii");
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(2, 18);
  bytes.writeInt32LE(2, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(16, 34);
  bytes.fill(0x7f, 54);
  return bytes;
}

test("a real Durable run streams translated events and reads a BMP as PNG", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telepi-view-events-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "work");
  const agentDir = join(directory, "agent");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  await writeFile(join(workspace, "shot.bmp"), bmp());

  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true, input: ["text", "image"] }] });
  const models = createModels();
  models.setProvider(faux.provider);
  let toolResult;
  faux.setResponses([
    fauxAssistantMessage([fauxThinking("look at it"), fauxText("Checking the image."), fauxToolCall("read", { path: "shot.bmp" }, { id: "call-1" })], { stopReason: "toolUse" }),
    (context) => {
      toolResult = context.messages.findLast((message) => message.role === "toolResult");
      return fauxAssistantMessage("It is grey.");
    },
  ]);

  const host = await openDurableHost({
    storageDir: directory,
    infrastructureAgentDir: agentDir,
    projectRoot: directory,
    models,
    settingsManager: SettingsManager.inMemory({}),
  });
  t.after(() => host.close());

  const spec = {
    endpointKey: "endpoint:view",
    agentId: "test",
    agentDir,
    cwd: workspace,
    location: { type: "local" },
    modelSpec: "faux/faux-1:high",
    legacySessionId: "legacy-view",
    skillPaths: [],
    systemPrompt: null,
  };
  await host.ensureEndpoint(spec);
  const events = [];
  await host.watchEndpoint(spec.endpointKey, (batch) => events.push(...batch));

  const submitted = await host.submit(spec.endpointKey, { requestId: "view-1", content: "What is in shot.bmp?" });
  const result = await host.waitSubmission(spec.endpointKey, submitted.submissionId);
  assert.equal(result.status, "done");
  assert.deepEqual(result.answers.map((answer) => answer.text), ["Checking the image.", "It is grey."]);

  // The image reached the model converted to a format providers accept.
  const image = toolResult?.content?.find((block) => block.type === "image");
  assert.ok(image, JSON.stringify(toolResult));
  assert.equal(image.mimeType, "image/png");

  await new Promise((resolve) => setTimeout(resolve, 50));
  const types = events.map((event) => event.type);
  for (const expected of ["run_start", "turn_start", "tool_execution_start", "tool_execution_end", "turn_end", "run_end"]) {
    assert.ok(types.includes(expected), `${expected} missing from ${types.join(",")}`);
  }
  assert.equal(types.filter((type) => type === "turn_start").length, 2, types.join(","));
  assert.ok(types.indexOf("run_end") > types.lastIndexOf("turn_end"), types.join(","));
  const assistantTexts = events
    .filter((event) => event.type === "message_end" && event.entry?.model?.[0]?.role === "assistant")
    .map((event) => event.entry.model[0].content.filter((block) => block.type === "text").map((block) => block.text).join(""));
  assert.deepEqual(assistantTexts, ["Checking the image.", "It is grey."]);
  const userStart = events.find((event) => event.type === "message_start" && event.message?.role === "user");
  assert.ok(userStart, "the user prompt must start a message so the reasoning display resets");
  const end = events.find((event) => event.type === "tool_execution_end");
  assert.equal(end.toolName, "read");
  assert.equal(end.isError, false);
});
