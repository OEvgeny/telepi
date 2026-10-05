import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

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

function endpoint(key, cwd, agentDir) {
  return {
    endpointKey: key,
    agentId: "test",
    agentDir,
    cwd,
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
