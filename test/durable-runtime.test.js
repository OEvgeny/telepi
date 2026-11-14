import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Connection, packagedDaemon } from "@earendil-works/pi-env";

import { assertDurablePackageVersions, DURABLE_PACKAGE_VERSION } from "../src/durable/packages.js";
import { openDurableHost, parseModelSpec } from "../src/durable/runtime.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "telepi-durable-runtime-"));
  const workspace = join(directory, "work");
  const otherWorkspace = join(directory, "other");
  const agentDir = join(directory, "agent");
  await Promise.all([mkdir(workspace), mkdir(otherWorkspace), mkdir(agentDir)]);
  await writeFile(join(agentDir, "AGENTS.md"), "# Test agent\n\nAnswer concisely.\n");
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, workspace, otherWorkspace, agentDir };
}

function endpoint(key, cwd, agentDir, options = {}) {
  return {
    endpointKey: key,
    agentId: "test",
    agentDir,
    cwd,
    location: options.location || { type: "local" },
    modelSpec: "faux/faux-1:high",
    legacySessionId: `legacy-${key}`,
    skillPaths: [],
    systemPrompt: null,
  };
}

test("Durable package family is coherently exact-pinned", () => {
  const versions = assertDurablePackageVersions();
  assert.ok(Object.keys(versions).length >= 9);
  assert.ok(Object.values(versions).every((version) => version === DURABLE_PACKAGE_VERSION));
});

test("one Durable host runs two endpoint conversations concurrently and deduplicates ingress", async (t) => {
  const paths = await fixture(t);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  let starts = 0;
  let release;
  let bothStarted;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { bothStarted = resolve; });
  const response = async () => {
    starts += 1;
    const number = starts;
    if (starts === 2) bothStarted();
    await gate;
    return fauxAssistantMessage(`answer-${number}`);
  };
  faux.setResponses([response, response]);

  const host = await openDurableHost({
    storageDir: paths.directory,
    infrastructureAgentDir: paths.agentDir,
    projectRoot: paths.directory,
    models,
    settingsManager: SettingsManager.inMemory({}),
  });
  t.after(() => host.close());

  const [firstEndpoint, secondEndpoint] = await Promise.all([
    host.ensureEndpoint(endpoint("endpoint:one", paths.workspace, paths.agentDir)),
    host.ensureEndpoint(endpoint("endpoint:two", paths.otherWorkspace, paths.agentDir)),
  ]);
  assert.notEqual(firstEndpoint.conversationId, secondEndpoint.conversationId);

  const [first, second] = await Promise.all([
    host.submit("endpoint:one", { requestId: "request-one", content: "one" }),
    host.submit("endpoint:two", { requestId: "request-two", content: "two" }),
  ]);
  const waits = Promise.all([
    host.waitSubmission("endpoint:one", first.submissionId),
    host.waitSubmission("endpoint:two", second.submissionId),
  ]);
  await Promise.race([
    started,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`only ${starts} Durable generation(s) started`)), 2_000)),
  ]);
  release();
  const results = await waits;

  assert.equal(starts, 2);
  assert.deepEqual(results.map((result) => result.status), ["done", "done"]);
  assert.deepEqual(results.flatMap((result) => result.answers.map((answer) => answer.text)).sort(), ["answer-1", "answer-2"]);

  const duplicate = await host.submit("endpoint:one", { requestId: "request-one", content: "one" });
  assert.equal(duplicate.submissionId, first.submissionId);
  await assert.rejects(
    host.ensureEndpoint(endpoint("endpoint:one", paths.otherWorkspace, paths.agentDir)),
    /cwd changed; rotate the endpoint/,
  );
  await assert.rejects(
    host.ensureEndpoint(endpoint("endpoint:one", paths.workspace, paths.agentDir, {
      location: { type: "ssh", host: "changed.invalid" },
    })),
    /location changed; rotate the endpoint/,
  );
});

test("official pi-env supplies remote agent resources, project context, skills, and browser tools", async (t) => {
  const paths = await fixture(t);
  const remoteCwd = join(paths.workspace, "nested");
  const remoteAgentDir = join(paths.directory, "remote-agent");
  const browserRoot = join(remoteAgentDir, "browser-package");
  await mkdir(join(remoteCwd, ".pi", "skills", "remote-skill"), { recursive: true });
  await mkdir(join(remoteAgentDir, "skills", "agent-skill"), { recursive: true });
  await mkdir(join(browserRoot, "src"), { recursive: true });
  await mkdir(join(browserRoot, "skills", "browser-skill"), { recursive: true });
  await writeFile(join(paths.workspace, "AGENTS.md"), "# Remote project\n\nREMOTE_CONTEXT_SENTINEL\n");
  await writeFile(join(remoteAgentDir, "AGENTS.md"), "# Remote agent\n\nREMOTE_AGENT_SENTINEL\n");
  await writeFile(join(remoteAgentDir, "settings.json"), JSON.stringify({ packages: ["browser-package"] }));
  await writeFile(
    join(remoteAgentDir, "skills", "agent-skill", "SKILL.md"),
    "---\nname: agent-skill\ndescription: Instructions owned by the remote agent.\n---\n",
  );
  await writeFile(
    join(remoteCwd, ".pi", "skills", "remote-skill", "SKILL.md"),
    "---\nname: remote-skill\ndescription: Instructions owned by the remote workspace.\n---\n",
  );
  await writeFile(join(browserRoot, "package.json"), JSON.stringify({
    name: "test-browser",
    type: "module",
    pi: { extensions: ["./extensions"], skills: ["./skills"] },
  }));
  await writeFile(
    join(browserRoot, "skills", "browser-skill", "SKILL.md"),
    "---\nname: browser-skill\ndescription: Instructions owned by the remote browser package.\n---\n",
  );
  await writeFile(join(browserRoot, "src", "session.mjs"), `
    export class Session {
      async start() { return { url: "https://remote.test", viewport: { width: 800, height: 600 } }; }
      async close() {}
    }
  `);
  await writeFile(join(browserRoot, "src", "output.mjs"), `
    export const bound = (text) => String(text);
    export const renderReady = () => "REMOTE_BROWSER_READY";
    export const renderCapture = renderReady;
    export const renderInspect = renderReady;
    export const renderInteract = renderReady;
    export const renderRecordCase = renderReady;
    export const renderRunSummary = renderReady;
  `);

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    (request) => {
      const prompt = JSON.stringify(request);
      assert.doesNotMatch(prompt, /Test agent/);
      assert.match(prompt, /REMOTE_AGENT_SENTINEL/);
      assert.match(prompt, /REMOTE_CONTEXT_SENTINEL/);
      assert.match(prompt, /agent-skill/);
      assert.match(prompt, /remote-skill/);
      assert.match(prompt, /browser-skill/);
      assert.match(prompt, /"name":"browser"/);
      assert.match(prompt, /"name":"telepi_get_message"/);
      assert.match(prompt, /"name":"telepi_send_message"/);
      assert.match(prompt, /"name":"telepi_send_image"/);
      assert.match(prompt, /"name":"telepi_buttons"/);
      assert.match(prompt, /"name":"telepi_run_command"/);
      return fauxAssistantMessage(
        fauxToolCall("browser", { action: "start", url: "https://remote.test" }),
        { stopReason: "toolUse" },
      );
    },
    (request) => {
      assert.match(JSON.stringify(request.messages), /REMOTE_BROWSER_READY/);
      return fauxAssistantMessage("remote-ready");
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

  await host.ensureEndpoint(endpoint("endpoint:ssh", remoteCwd, paths.agentDir, {
    location: { type: "ssh", host: "test.invalid", user: "tester", agent_dir: remoteAgentDir },
  }));
  const submitted = await host.submit("endpoint:ssh", { requestId: "remote-request", content: "inspect remote" });
  const result = await host.waitSubmission("endpoint:ssh", submitted.submissionId);
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.equal(result.answers.at(-1)?.text, "remote-ready", JSON.stringify(result));
});

test("Durable Telegram tools call the gateway with stable conversation provenance", async (t) => {
  const paths = await fixture(t);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const calls = [];
  faux.setResponses([
    () => fauxAssistantMessage(
      fauxToolCall("telepi_send_message", { to: "target", message: "hello" }),
      { stopReason: "toolUse" },
    ),
    (request) => {
      assert.match(JSON.stringify(request.messages), /Message accepted for target/);
      return fauxAssistantMessage("sent");
    },
  ]);
  const host = await openDurableHost({
    storageDir: paths.directory,
    infrastructureAgentDir: paths.agentDir,
    projectRoot: paths.directory,
    models,
    settingsManager: SettingsManager.inMemory({}),
    gatewayRequest: async (method, params) => {
      calls.push({ method, params });
      return { topic: "target", agent: "other", status: "started" };
    },
  });
  t.after(() => host.close());
  const ensured = await host.ensureEndpoint({
    ...endpoint("endpoint:telegram", paths.workspace, paths.agentDir),
    chatId: "10",
    topicId: "20",
    topicName: "source",
  });
  const submitted = await host.submit("endpoint:telegram", { requestId: "telegram-request", content: "send it" });
  const result = await host.waitSubmission("endpoint:telegram", submitted.submissionId);
  assert.equal(result.answers.at(-1)?.text, "sent");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "telegram.sendMessage");
  assert.equal(calls[0].params.to, "target");
  assert.equal(calls[0].params.currentAgentId, "test");
  assert.equal(calls[0].params.currentTopicName, "source");
  assert.match(calls[0].params.requestId, new RegExp(`^${ensured.conversationId}:`));
});

test("SQLite reopen preserves endpoint mapping and conversation identity", async (t) => {
  const paths = await fixture(t);
  const firstFaux = fauxProvider();
  const firstModels = createModels();
  firstModels.setProvider(firstFaux.provider);
  const settings = SettingsManager.inMemory({});
  let host = await openDurableHost({
    storageDir: paths.directory,
    infrastructureAgentDir: paths.agentDir,
    projectRoot: paths.directory,
    models: firstModels,
    settingsManager: settings,
  });
  const created = await host.ensureEndpoint(endpoint("endpoint:restart", paths.workspace, paths.agentDir));
  await host.close();

  const secondFaux = fauxProvider();
  const secondModels = createModels();
  secondModels.setProvider(secondFaux.provider);
  host = await openDurableHost({
    storageDir: paths.directory,
    infrastructureAgentDir: paths.agentDir,
    projectRoot: paths.directory,
    models: secondModels,
    settingsManager: settings,
  });
  t.after(() => host.close());
  const reopened = await host.ensureEndpoint(endpoint("endpoint:restart", paths.workspace, paths.agentDir));
  assert.equal(reopened.created, false);
  assert.equal(reopened.conversationId, created.conversationId);
});

test("Durable model specs preserve model tags and parse explicit thinking", () => {
  assert.deepEqual(parseModelSpec("provider/model:tag"), { provider: "provider", modelId: "model:tag" });
  assert.deepEqual(parseModelSpec("provider/model:tag:xhigh"), {
    provider: "provider",
    modelId: "model:tag",
    thinkingLevel: "xhigh",
  });
  assert.throws(() => parseModelSpec("missing-provider"), /Invalid Durable model/);
});

test("Telegram attachments are copied to an SSH conversation's machine", async (t) => {
  const paths = await fixture(t);
  const remoteState = join(paths.directory, "remote-state");
  const gatewayCache = join(paths.directory, "gateway-cache");
  await mkdir(gatewayCache);
  const photo = join(gatewayCache, "42-photo.jpg");
  const voice = join(gatewayCache, "42-voice.ogg");
  await writeFile(photo, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  await writeFile(voice, "OggS-voice");

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  // The daemon stands in for the remote machine; its state home is a temp dir.
  const connection = new Connection({
    command: ["env", `XDG_STATE_HOME=${remoteState}`, packagedDaemon({ platform, arch })],
  });
  const host = await openDurableHost({
    storageDir: paths.directory,
    infrastructureAgentDir: paths.agentDir,
    projectRoot: paths.directory,
    models,
    settingsManager: SettingsManager.inMemory({}),
    sshConnectionFactory: () => ({ connection }),
  });
  t.after(() => host.close());

  await host.ensureEndpoint(endpoint("endpoint:remote-files", paths.workspace, paths.agentDir, {
    location: { type: "ssh", host: "test.invalid", user: "tester" },
  }));
  const request = {
    chatId: "-100123",
    topicId: "7",
    attachments: [
      { type: "image", path: photo, mimeType: "image/jpeg" },
      { type: "audio", path: voice, mimeType: "audio/ogg" },
    ],
  };
  const staged = await host.stageAttachments("endpoint:remote-files", request);
  assert.equal(staged.location, "ssh");
  const expectedDir = join(remoteState, "telepi", "attachments", "-100123", "7");
  assert.deepEqual(staged.attachments.map((attachment) => attachment.path), [
    join(expectedDir, "42-photo.jpg"),
    join(expectedDir, "42-voice.ogg"),
  ]);
  assert.equal(staged.attachments[0].gatewayPath, photo);
  assert.deepEqual(await readFile(staged.attachments[0].path), await readFile(photo));
  assert.equal(await readFile(staged.attachments[1].path, "utf8"), "OggS-voice");

  // A retry writes the same paths, so the prompt text does not change.
  const again = await host.stageAttachments("endpoint:remote-files", request);
  assert.deepEqual(again.attachments.map((attachment) => attachment.path), staged.attachments.map((attachment) => attachment.path));

  // A local conversation keeps the gateway paths: the files are already there.
  await host.ensureEndpoint(endpoint("endpoint:local-files", paths.otherWorkspace, paths.agentDir));
  const local = await host.stageAttachments("endpoint:local-files", request);
  assert.equal(local.location, "local");
  assert.deepEqual(local.attachments.map((attachment) => attachment.path), [photo, voice]);
});

test("Durable expands /skill: commands and honors context_files: false, as Pi does", async (t) => {
  const paths = await fixture(t);
  const skillDir = join(paths.directory, "skills", "demo");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: A demo skill.\n---\n\nDEMO_SKILL_BODY\n");
  await writeFile(join(paths.workspace, "AGENTS.md"), "PROJECT_CONTEXT_SENTINEL\n");

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const requests = [];
  faux.setResponses([
    (context) => { requests.push(JSON.stringify(context)); return fauxAssistantMessage("one"); },
    (context) => { requests.push(JSON.stringify(context)); return fauxAssistantMessage("two"); },
  ]);
  const host = await openDurableHost({
    storageDir: paths.directory,
    infrastructureAgentDir: paths.agentDir,
    projectRoot: paths.directory,
    models,
    settingsManager: SettingsManager.inMemory({}),
  });
  t.after(() => host.close());

  await host.ensureEndpoint({
    ...endpoint("endpoint:skills", paths.workspace, paths.agentDir),
    skillPaths: [join(skillDir, "SKILL.md")],
  });
  let submitted = await host.submit("endpoint:skills", { requestId: "skill-1", content: "/skill:demo do the thing" });
  await host.waitSubmission("endpoint:skills", submitted.submissionId);
  assert.match(requests[0], /<skill name=\\"demo\\" location=/);
  assert.match(requests[0], /DEMO_SKILL_BODY/);
  assert.match(requests[0], /do the thing/);
  assert.doesNotMatch(requests[0], /\/skill:demo/);
  // With context files on, the project's AGENTS.md is in the prompt.
  assert.match(requests[0], /PROJECT_CONTEXT_SENTINEL/);

  await host.ensureEndpoint({
    ...endpoint("endpoint:no-context", paths.workspace, paths.agentDir),
    noContextFiles: true,
    systemPrompt: "IDENTITY_SENTINEL",
  });
  submitted = await host.submit("endpoint:no-context", { requestId: "no-context-1", content: "hello" });
  await host.waitSubmission("endpoint:no-context", submitted.submissionId);
  assert.doesNotMatch(requests[1], /PROJECT_CONTEXT_SENTINEL/);
  assert.match(requests[1], /IDENTITY_SENTINEL/);
});
