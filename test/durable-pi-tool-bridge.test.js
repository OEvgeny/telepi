import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Connection, packagedDaemon } from "@earendil-works/pi-env";

import { openDurableHost } from "../src/durable/runtime.js";

// A Pi extension as agents write them: a tool with a path argument that reads
// the file, a card posted with pi.sendMessage, and a telepi_* tool that
// Durable already has natively.
const EXTENSION = `
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "probe_file",
    label: "Probe File",
    description: "Read a file and report where the tool ran.",
    promptSnippet: "Probe a file",
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = resolve(ctx.cwd, params.path);
      const text = readFileSync(path, "utf8");
      pi.sendMessage({ customType: "probe-card", content: "probe card", display: true });
      return { content: [{ type: "text", text: "cwd=" + ctx.cwd + " path=" + path + " text=" + text }], details: { path, message_id: "991" } };
    },
  });
  pi.registerTool({
    name: "telepi_send_message",
    label: "Shadow",
    description: "Must not replace the native Durable tool.",
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "shadow" }] }; },
  });
}
`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "telepi-pi-bridge-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "work");
  const agentDir = join(directory, "agent");
  const extensionDir = join(directory, "extensions");
  await Promise.all([mkdir(workspace), mkdir(agentDir), mkdir(extensionDir)]);
  const extensionPath = join(extensionDir, "probe.ts");
  await writeFile(extensionPath, EXTENSION);
  return { directory, workspace, agentDir, extensionPath };
}

function spec(paths, overrides = {}) {
  return {
    endpointKey: "endpoint:bridge",
    agentId: "test",
    agentDir: paths.agentDir,
    cwd: paths.workspace,
    location: { type: "local" },
    modelSpec: "faux/faux-1",
    legacySessionId: "legacy",
    skillPaths: [],
    systemPrompt: null,
    piExtensions: { cwd: paths.workspace, agentDir: paths.agentDir, extensionPaths: [paths.extensionPath] },
    ...overrides,
  };
}

test("a local Durable topic gets its Pi extension tools and their cards", async (t) => {
  const paths = await fixture(t);
  await writeFile(join(paths.workspace, "note.txt"), "local-note");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let offered;
  let toolResult;
  faux.setResponses([
    (context) => {
      offered = JSON.stringify(context);
      return fauxAssistantMessage(fauxToolCall("probe_file", { path: "note.txt" }), { stopReason: "toolUse" });
    },
    (context) => {
      toolResult = context.messages.findLast((message) => message.role === "toolResult");
      return fauxAssistantMessage("done");
    },
  ]);
  const cards = [];
  const host = await openDurableHost({
    storageDir: paths.directory,
    infrastructureAgentDir: paths.agentDir,
    projectRoot: paths.directory,
    models,
    settingsManager: SettingsManager.inMemory({}),
    onCustomMessage: (endpointKey, message) => cards.push({ endpointKey, message }),
  });
  t.after(() => host.close());

  await host.ensureEndpoint(spec(paths));
  const submitted = await host.submit("endpoint:bridge", { requestId: "bridge-1", content: "probe it" });
  const result = await host.waitSubmission("endpoint:bridge", submitted.submissionId);
  assert.equal(result.status, "done", JSON.stringify(result));

  assert.match(offered, /"name":"probe_file"/);
  // The native Durable tool stays; the extension's copy is not offered twice.
  assert.equal(offered.match(/"name":"telepi_send_message"/g)?.length, 1);
  assert.doesNotMatch(offered, /Must not replace the native Durable tool/);
  const text = toolResult.content.map((block) => block.text).join("");
  assert.match(text, new RegExp(`cwd=${paths.workspace} `));
  assert.match(text, /text=local-note/);
  assert.equal(toolResult.details.message_id, "991");
  assert.deepEqual(cards.map((card) => [card.endpointKey, card.message.customType]), [["endpoint:bridge", "probe-card"]]);
});

test("an SSH Durable topic's Pi tool gets a local copy of the remote file", async (t) => {
  const paths = await fixture(t);
  const remoteDir = join(paths.directory, "remote-work");
  await mkdir(remoteDir);
  await writeFile(join(remoteDir, "voice.ogg"), "remote-bytes");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let toolResult;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("probe_file", { path: "voice.ogg" }), { stopReason: "toolUse" }),
    (context) => {
      toolResult = context.messages.findLast((message) => message.role === "toolResult");
      return fauxAssistantMessage("done");
    },
  ]);
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const connection = new Connection({ command: [packagedDaemon({ platform, arch })] });
  const host = await openDurableHost({
    storageDir: paths.directory,
    infrastructureAgentDir: paths.agentDir,
    projectRoot: paths.directory,
    models,
    settingsManager: SettingsManager.inMemory({}),
    sshConnectionFactory: () => ({ connection }),
  });
  t.after(() => host.close());

  await host.ensureEndpoint(spec(paths, {
    endpointKey: "endpoint:bridge-ssh",
    cwd: remoteDir,
    location: { type: "ssh", host: "test.invalid", user: "tester" },
  }));
  const submitted = await host.submit("endpoint:bridge-ssh", { requestId: "bridge-ssh-1", content: "probe it" });
  const result = await host.waitSubmission("endpoint:bridge-ssh", submitted.submissionId);
  assert.equal(result.status, "done", JSON.stringify(result));

  const text = toolResult.content.map((block) => block.text).join("");
  // The tool read a local temporary copy, not the remote path itself.
  assert.match(text, /path=\S*telepi-pi-tool-[^/]+\/voice\.ogg/);
  assert.match(text, /text=remote-bytes/);
  const leftovers = (await readdir(tmpdir())).filter((name) => name.startsWith("telepi-pi-tool-"));
  const copied = /telepi-pi-tool-[^/]+/.exec(text)[0];
  assert.ok(!leftovers.includes(copied), "the temporary copy is removed after the call");
});
