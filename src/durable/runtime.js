import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SettingsManager,
  formatSkillsForPrompt,
  loadProjectContextFiles,
  loadSkills,
} from "@earendil-works/pi-coding-agent";
import {
  AssistantEntry,
  Harness,
  LiveDoc,
  configure,
  createRegistry,
  defineDoc,
  defineDocFamily,
  defineExtension,
  section,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { RemoteExecutionEnv, sshConnection } from "@earendil-works/pi-env";
import { createDurableCompactionModels } from "../compaction-policy.js";
import { createViewEventTranslator } from "./view-events.js";
import { stageAttachments } from "./attachments.js";
import { applyHttpProxySettings, configurePiHttpDispatcher } from "../pi/http-dispatcher.js";
import {
  loadLocalAgentContext,
  loadProjectSkillsFromEnv,
  loadRemoteAgentContextFiles,
  loadRemoteProjectContextFiles,
  loadSkillRootsFromEnv,
} from "./remote-context.js";
import { resolveRemoteAgentResources } from "./remote-agent.js";
import { RemoteBrowserManager, createRemoteBrowserExtension } from "./remote-browser.js";
import { createDurableTelegramExtension } from "./telegram-tools.js";
import { createDurableBackgroundJobExtension } from "./background-job-tool.js";
import {
  sshConnectionKey,
  sshEnvironmentId,
  sshTargetFromLocation,
} from "./ssh-location.js";

const context = BACKGROUND_CONTEXT;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const EndpointDoc = defineDocFamily({
  kind: "telepi.endpoint",
  version: 1,
  family: true,
  scope: "session",
  // Small documents: keep every change as a delta (Durable 1.4 requires a choice).
  checkpointWhen: () => false,
  initial: (endpointKey) => ({
    endpointKey,
    conversationId: null,
    bindingGeneration: 0,
  }),
});

export const ConversationDoc = defineDoc({
  kind: "telepi.conversation",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({
    endpointKey: null,
    agentId: null,
    agentDir: null,
    cwd: null,
    location: { type: "local" },
    chatId: null,
    topicId: null,
    topicName: null,
    browserPackageRoot: null,
    remoteSkillRoots: [],
    backendVersion: 1,
    legacySessionId: null,
    skillPaths: [],
    systemPrompt: null,
  }),
});

export async function openDurableHost(options) {
  const storageDir = resolve(options.storageDir);
  const databasePath = options.databasePath || join(storageDir, "telepi.sqlite");
  const infrastructureAgentDir = resolve(options.infrastructureAgentDir);
  const settingsManager = options.settingsManager || SettingsManager.create(
    options.projectRoot || process.cwd(),
    infrastructureAgentDir,
    { projectTrusted: false },
  );
  applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
  configurePiHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

  const modelRuntime = options.models || await ModelRuntime.create({
    authPath: join(infrastructureAgentDir, "auth.json"),
    modelsPath: join(infrastructureAgentDir, "models.json"),
    modelsStorePath: join(infrastructureAgentDir, "models-store.json"),
  });
  // Durable uses completeSimple only for its built-in summarization task;
  // ordinary turns use streamSimple. Wrap that one boundary so the same
  // Telepi-wide compaction policy applies without changing normal requests.
  const harnessModels = createDurableCompactionModels(modelRuntime);
  const prompt = createTelepiPrompt();
  const browserManager = new RemoteBrowserManager();
  const remoteBrowser = createRemoteBrowserExtension(browserManager, ConversationDoc);
  const telegram = createDurableTelegramExtension(
    options.gatewayRequest || (() => Promise.reject(new Error("Durable gateway tools are unavailable"))),
    ConversationDoc,
  );
  const backgroundJobs = createDurableBackgroundJobExtension();
  // Durable's `read` returns images itself: with a processor it orients,
  // converts (BMP), and shrinks them to the model's limits before sending.
  const codingTools = createCodingTools({ images: options.images || await createNodePhotonImages() });
  const runtimeExtensions = { codingTools, prompt, remoteBrowser, telegram, backgroundJobs };
  const registry = createRegistry();
  registry.install(codingTools);
  registry.install(prompt);
  registry.install(remoteBrowser);
  registry.install(telegram);
  registry.install(backgroundJobs);
  const envs = new ExecutionEnvs(options.projectRoot || process.cwd(), {
    knownHostsFile: join(storageDir, "ssh-known-hosts"),
    onLog: options.onSshLog,
    sshConnectionFactory: options.sshConnectionFactory,
  });
  const reports = [];
  const harness = await Harness.open(
    await openNodeSqliteStorage(databasePath),
    {
      models: harnessModels,
      registry,
      settings: createHarnessSettings(settingsManager, [codingTools, prompt, telegram, backgroundJobs]),
      env: envs.env,
      conversationCreated: async (tx, conversation) => {
        await tx.doc(ConversationDoc, conversation.id);
      },
      // Durable 1.5 passes one tagged Report: `kind` and the `error`.
      onReport: (report) => {
        const error = report?.error;
        const message = error instanceof Error ? error.message : String(error ?? report?.kind ?? "unknown report");
        reports.push({ at: new Date().toISOString(), kind: report?.kind ?? null, message });
        if (reports.length > 100) reports.shift();
        options.onReport?.(report);
      },
    },
    context,
  );

  const endpointLocks = new Map();
  const watches = new Map();
  let closed = false;
  harness.resume();

  const api = {
    harness,
    databasePath,

    ensureEndpoint(spec) {
      return withKeyLock(endpointLocks, spec.endpointKey, async () => {
        const prepared = await prepareEndpointSpec(spec, envs);
        return ensureEndpoint(harness, modelRuntime, prepared, runtimeExtensions);
      });
    },

    async watchEndpoint(endpointKey, listener) {
      const key = requireString(endpointKey, "endpointKey");
      if (watches.has(key)) return;
      const conversation = await resolveEndpointConversation(harness, key);
      const deliver = (value) => {
        const events = translator.advance(value);
        if (!events.length) return;
        try {
          listener(events);
        } catch (error) {
          console.error(`durable event delivery failed endpoint=${key}: ${error instanceof Error ? error.message : error}`);
        }
      };
      // The observation's value is the state at attachment; a commit can
      // advance the observer before observeConversation() resolves, so hold
      // those values until the translator has its starting point.
      let translator;
      let early = [];
      let observation;
      observation = await harness.observeConversation(conversation.id, {
        advance(call) {
          if (call?.kind !== "value") return;
          if (!translator) early.push(call.value);
          else deliver(call.value);
        },
        end() {
          if (observation && watches.get(key) === observation) watches.delete(key);
        },
      }, context);
      translator = createViewEventTranslator(observation.value);
      for (const value of early) deliver(value);
      early = [];
      watches.set(key, observation);
    },

    async submit(endpointKey, draft) {
      const conversation = await resolveEndpointConversation(harness, endpointKey);
      const submission = await conversation.submit({
        type: "input",
        content: String(draft.content || ""),
        requestId: requireString(draft.requestId, "submission requestId"),
        whenBusy: draft.whenBusy || "followUp",
      }, context);
      return { submissionId: submission.id, status: (await submission.status(context)).status };
    },

    // Telegram files are downloaded on the gateway host. A conversation at an
    // SSH location reads them on its own machine, so copy them there first.
    async stageAttachments(endpointKey, request) {
      const conversation = await resolveEndpointConversation(harness, endpointKey);
      const metadata = await harness.snapshot(ConversationDoc, conversation.id, context);
      const attachments = Array.isArray(request?.attachments) ? request.attachments : [];
      if (metadata?.location?.type !== "ssh") return { attachments, location: "local" };
      const env = envs.remote(metadata.location, metadata.cwd);
      const staged = await stageAttachments(env, { ...request, attachments }, context);
      return { ...staged, location: "ssh" };
    },

    async waitSubmission(endpointKey, submissionId) {
      const conversation = await resolveEndpointConversation(harness, endpointKey);
      const submission = await harness.submission(requireSafeInteger(submissionId, "submissionId"), context);
      if (!submission) throw new Error(`Unknown Durable submission: ${submissionId}`);
      const current = await submission.status(context);
      if (current.conversationId !== conversation.id) throw new Error("Durable submission belongs to another endpoint");
      const settled = await submission.wait(context);
      if (settled.status !== "done" || settled.type !== "input") {
        return {
          status: "unanswered",
          reason: settled.reason,
          detail: settled.detail ?? null,
          answers: [],
        };
      }
      return {
        status: "done",
        answers: await collectAssistantAnswers(conversation, settled.entry, settled.answer),
      };
    },

    async abort(endpointKey) {
      const mapping = await harness.snapshot(EndpointDoc, endpointKey, context);
      if (!mapping?.conversationId) return { status: "idle" };
      const conversation = await harness.conversation(mapping.conversationId, context);
      if (!conversation) throw new Error(`Durable endpoint ${endpointKey} references a missing conversation`);
      const live = await harness.snapshot(LiveDoc, conversation.id, context);
      const wasBusy = live?.run !== undefined || (live?.compactions?.length || 0) > 0;
      await conversation.abort(context);
      return { status: wasBusy ? "aborted" : "idle" };
    },

    async compact(endpointKey, instructions) {
      const conversation = await resolveEndpointConversation(harness, endpointKey);
      const taskId = await conversation.compact(instructions == null ? undefined : String(instructions), context);
      const receipt = await harness.waitForTask(taskId, context);
      const outcome = receipt.state.outcome;
      if (outcome.status !== "completed") {
        return {
          status: outcome.status,
          reason: outcome.reason || outcome.error?.message || "Compaction did not complete",
        };
      }
      const result = outcome.result;
      let placement;
      if (result.submissionId !== undefined) {
        const submission = await harness.submission(result.submissionId, context);
        placement = submission ? await submission.wait(context) : undefined;
      }
      return {
        status: result.entryId !== undefined || placement?.status === "done" ? "compacted" : "skipped",
        entryId: result.entryId ?? null,
        submissionId: result.submissionId ?? null,
        placementStatus: placement?.status ?? null,
      };
    },

    async inspect() {
      const inspection = await harness.inspect(context);
      return {
        scheduling: inspection.scheduling,
        taskCount: inspection.tasks.length,
        submissionCount: inspection.submissions.length,
        idle: inspection.tasks.length === 0,
        reports: [...reports],
      };
    },

    async close({ waitForIdle = false } = {}) {
      if (closed) return;
      closed = true;
      if (waitForIdle) await harness.waitForIdle(context);
      for (const observation of watches.values()) observation.detach();
      watches.clear();
      try {
        await harness.close(context);
      } finally {
        try {
          await browserManager.cleanup(context);
        } finally {
          await envs.cleanup(context);
        }
      }
    },
  };
  return api;
}

async function prepareEndpointSpec(spec, envs) {
  validateEndpointSpec(spec);
  if (spec.location?.type !== "ssh" || !spec.location.agent_dir) return spec;
  const env = envs.remote(spec.location, spec.cwd);
  const resources = await resolveRemoteAgentResources(env, spec.location.agent_dir, context);
  return {
    ...spec,
    browserPackageRoot: resources.browserPackageRoot,
    remoteSkillRoots: resources.skillRoots,
  };
}

async function ensureEndpoint(harness, models, spec, runtimeExtensions) {
  validateEndpointSpec(spec);
  const existing = await harness.snapshot(EndpointDoc, spec.endpointKey, context);
  if (existing?.conversationId) {
    const conversation = await harness.conversation(existing.conversationId, context);
    if (!conversation) throw new Error(`Durable endpoint ${spec.endpointKey} references a missing conversation`);
    const metadata = await harness.snapshot(ConversationDoc, conversation.id, context);
    assertBindingMatches(spec, metadata);
    const agent = buildAgentChange(models, spec, runtimeExtensions);
    await conversation.commit(async (tx) => {
      await configure(tx, conversation.id, agent);
      const current = await tx.doc(ConversationDoc, conversation.id);
      assignConversationMetadata(current, spec);
    }, context);
    return { conversationId: conversation.id, created: false, bindingGeneration: existing.bindingGeneration };
  }

  const agent = buildAgentChange(models, spec, runtimeExtensions);
  const conversation = await harness.createConversation({
    ownership: { kind: "ownerless" },
    agent,
    init: async (tx, conversationId) => {
      const endpoint = await tx.doc(EndpointDoc, spec.endpointKey, spec.endpointKey);
      if (endpoint.conversationId !== null) throw new Error(`Durable endpoint already exists: ${spec.endpointKey}`);
      endpoint.conversationId = conversationId;
      endpoint.bindingGeneration += 1;
      const metadata = await tx.doc(ConversationDoc, conversationId);
      assignConversationMetadata(metadata, spec);
    },
  }, context);
  const mapping = await harness.snapshot(EndpointDoc, spec.endpointKey, context);
  return {
    conversationId: conversation.id,
    created: true,
    bindingGeneration: mapping?.bindingGeneration || 1,
  };
}

function buildAgentChange(models, spec, runtimeExtensions) {
  const parsed = parseModelSpec(spec.modelSpec);
  const model = models.getModel(parsed.provider, parsed.modelId);
  if (!model) throw new Error(`Durable model is unavailable: ${parsed.provider}/${parsed.modelId}`);
  const thinkingLevel = parsed.thinkingLevel
    ? clampThinkingLevel(model, parsed.thinkingLevel)
    : "off";
  return {
    model: { provider: parsed.provider, modelId: parsed.modelId },
    thinkingLevel,
    extensions: [
      runtimeExtensions.codingTools,
      runtimeExtensions.prompt,
      runtimeExtensions.telegram,
      runtimeExtensions.backgroundJobs,
      ...(spec.browserPackageRoot ? [runtimeExtensions.remoteBrowser] : []),
    ],
    cwd: endpointCwd(spec),
  };
}

function createTelepiPrompt() {
  return defineExtension({
    name: "telepi-prompt",
    sections: [
      section("preamble", () => (
        "You are an expert coding assistant operating inside Telepi. Use the available tools to inspect, modify, and verify the working directory."
      ), { tag: false }),
      section("project_context", async (input, renderContext) => {
        const metadata = await input.read.snapshot(ConversationDoc, input.conversationId, renderContext);
        if (!metadata?.agentDir || !metadata.cwd) return undefined;
        const files = metadata.location?.type === "ssh"
          ? [
              ...(metadata.location.agent_dir
                ? await loadRemoteAgentContextFiles(input.env, metadata.location.agent_dir, renderContext)
                : loadLocalAgentContext(metadata.agentDir)),
              ...await loadRemoteProjectContextFiles(input.env, renderContext),
            ]
          : loadProjectContextFiles({ cwd: metadata.cwd, agentDir: metadata.agentDir });
        const blocks = files.map(({ path, content }) => `<context path=${JSON.stringify(path)}>\n${content}\n</context>`);
        if (metadata.systemPrompt) blocks.unshift(metadata.systemPrompt);
        return blocks.length ? blocks.join("\n\n") : undefined;
      }),
      section("skills", async (input, renderContext) => {
        const metadata = await input.read.snapshot(ConversationDoc, input.conversationId, renderContext);
        if (!metadata?.agentDir || !metadata.cwd) return undefined;
        const isRemote = metadata.location?.type === "ssh";
        const usesRemoteAgentDir = isRemote && Boolean(metadata.location.agent_dir);
        const loaded = usesRemoteAgentDir
          ? { skills: [], diagnostics: [] }
          : loadSkills({
              cwd: isRemote ? metadata.agentDir : metadata.cwd,
              agentDir: metadata.agentDir,
              skillPaths: metadata.skillPaths || [],
              includeDefaults: true,
            });
        if (isRemote) {
          const [agentSkills, projectSkills] = await Promise.all([
            loadSkillRootsFromEnv(input.env, metadata.remoteSkillRoots || [], renderContext),
            loadProjectSkillsFromEnv(input.env, input.env.cwd, renderContext),
          ]);
          const names = new Set(loaded.skills.map((skill) => skill.name));
          for (const skill of [...agentSkills.skills, ...projectSkills.skills]) {
            if (!names.has(skill.name)) {
              loaded.skills.push(skill);
              names.add(skill.name);
            }
          }
        }
        return loaded.skills.length ? formatSkillsForPrompt(loaded.skills) : undefined;
      }),
      section("cwd", (input) => input.env?.cwd || input.agent.cwd),
    ],
  });
}

function createHarnessSettings(settingsManager, extensions) {
  return {
    extensions,
    get stream() {
      const provider = settingsManager.getProviderRetrySettings();
      const idle = settingsManager.getHttpIdleTimeoutMs();
      return {
        timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2_147_483_647 : idle),
        maxRetryDelayMs: provider.maxRetryDelayMs,
        ...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
      };
    },
    get compaction() {
      return settingsManager.getCompactionSettings();
    },
    get retry() {
      return settingsManager.getRetrySettings();
    },
    get steeringMode() {
      return settingsManager.getSteeringMode();
    },
    get followUpMode() {
      return settingsManager.getFollowUpMode();
    },
  };
}

class ExecutionEnvs {
  constructor(defaultCwd, options = {}) {
    this.defaultCwd = defaultCwd;
    this.projectRoot = resolve(defaultCwd);
    this.knownHostsFile = options.knownHostsFile;
    this.onLog = options.onLog;
    this.sshConnectionFactory = options.sshConnectionFactory || ((target) => sshConnection(target));
    this.localEnvs = new Map();
    this.remoteEnvs = new Map();
    this.remoteConnections = new Map();
    this.env = async ({ conversationId, cwd = this.defaultCwd, read }, envContext) => {
      const metadata = await read.snapshot(ConversationDoc, conversationId, envContext);
      const location = metadata?.location || { type: "local" };
      if (location.type === "ssh") return this.remote(location, cwd);
      const path = resolve(cwd);
      let env = this.localEnvs.get(path);
      if (!env) {
        env = new NodeExecutionEnv({ cwd: path });
        this.localEnvs.set(path, env);
      }
      return env;
    };
  }

  remote(location, cwd) {
    const connectionKey = sshConnectionKey(location, {
      projectRoot: this.projectRoot,
      knownHostsFile: this.knownHostsFile,
    });
    let connection = this.remoteConnections.get(connectionKey);
    if (!connection) {
      const target = sshTargetFromLocation(location, {
        projectRoot: this.projectRoot,
        knownHostsFile: this.knownHostsFile,
      });
      const opened = this.sshConnectionFactory({
        ...target,
        onLog: this.onLog,
      });
      connection = opened.connection || opened;
      this.remoteConnections.set(connectionKey, connection);
    }
    const key = `${connectionKey}\0${cwd}`;
    let env = this.remoteEnvs.get(key);
    if (!env) {
      env = new RemoteExecutionEnv({
        connection,
        id: sshEnvironmentId(location),
        cwd,
      });
      this.remoteEnvs.set(key, env);
    }
    return env;
  }

  async cleanup(cleanupContext) {
    const envs = [...this.localEnvs.values(), ...this.remoteEnvs.values()];
    this.localEnvs.clear();
    this.remoteEnvs.clear();
    try {
      for (const env of envs) await env.cleanup(cleanupContext);
    } finally {
      for (const connection of this.remoteConnections.values()) connection.close();
      this.remoteConnections.clear();
    }
  }
}

async function resolveEndpointConversation(harness, endpointKey) {
  const key = requireString(endpointKey, "endpointKey");
  const mapping = await harness.snapshot(EndpointDoc, key, context);
  if (!mapping?.conversationId) throw new Error(`Durable endpoint is not configured: ${key}`);
  const conversation = await harness.conversation(mapping.conversationId, context);
  if (!conversation) throw new Error(`Durable endpoint ${key} references a missing conversation`);
  return conversation;
}

async function collectAssistantAnswers(conversation, firstEntryId, answerEntryId) {
  const entries = [];
  let cursor;
  do {
    const page = await conversation.entries({ minEntryId: firstEntryId, maxEntryId: answerEntryId }, 256, cursor, context);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return entries
    .filter((entry) => AssistantEntry.is(entry))
    .sort((a, b) => a.id - b.id)
    .map((entry) => ({
      entryId: entry.id,
      text: entry.model
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.content)
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(""),
      stopReason: entry.model.find((message) => message.role === "assistant")?.stopReason || null,
    }));
}

function assignConversationMetadata(metadata, spec) {
  metadata.endpointKey = spec.endpointKey;
  metadata.agentId = spec.agentId;
  metadata.agentDir = resolve(spec.agentDir);
  metadata.cwd = endpointCwd(spec);
  metadata.location = endpointLocation(spec);
  metadata.chatId = spec.chatId == null ? null : String(spec.chatId);
  metadata.topicId = spec.topicId == null ? null : String(spec.topicId);
  metadata.topicName = spec.topicName || null;
  metadata.browserPackageRoot = spec.browserPackageRoot || null;
  metadata.remoteSkillRoots = [...new Set(spec.remoteSkillRoots || [])];
  metadata.backendVersion = 1;
  metadata.legacySessionId = spec.legacySessionId || null;
  metadata.skillPaths = [...new Set((spec.skillPaths || []).map((path) => resolve(path)))];
  metadata.systemPrompt = spec.systemPrompt || null;
}

function assertBindingMatches(spec, metadata) {
  if (!metadata) throw new Error(`Durable endpoint metadata is missing: ${spec.endpointKey}`);
  for (const [field, expected] of [
    ["agentId", spec.agentId],
    ["agentDir", resolve(spec.agentDir)],
    ["cwd", endpointCwd(spec)],
    ["location", endpointLocation(spec)],
  ]) {
    if (!sameBindingValue(metadata[field], expected)) {
      throw new Error(`Durable endpoint ${spec.endpointKey} ${field} changed; rotate the endpoint before reusing it`);
    }
  }
}

function validateEndpointSpec(spec) {
  requireString(spec?.endpointKey, "endpointKey");
  requireString(spec?.agentId, "agentId");
  requireString(spec?.agentDir, "agentDir");
  requireString(spec?.cwd, "cwd");
  requireString(spec?.modelSpec, "modelSpec");
  endpointLocation(spec);
}

function endpointLocation(spec) {
  const location = spec.location || { type: "local" };
  if (location.type === "local") return { type: "local" };
  if (location.type !== "ssh") throw new Error(`Unsupported Durable location type: ${location.type}`);
  const normalized = {
    type: "ssh",
    host: requireString(location.host, "SSH host"),
  };
  for (const field of ["user", "identity_file", "config_file", "agent_dir"]) {
    if (location[field]) normalized[field] = requireString(location[field], `SSH ${field}`);
  }
  if (location.port != null) {
    const port = Number(location.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid SSH port: ${location.port}`);
    normalized.port = port;
  }
  return normalized;
}

function endpointCwd(spec) {
  return endpointLocation(spec).type === "ssh" ? requireString(spec.cwd, "cwd") : resolve(spec.cwd);
}

function sameBindingValue(actual, expected) {
  if (actual == null && expected?.type === "local") return true;
  return typeof expected === "object"
    ? JSON.stringify(actual || null) === JSON.stringify(expected)
    : actual === expected;
}

export function parseModelSpec(value) {
  const source = requireString(value, "modelSpec");
  const slash = source.indexOf("/");
  if (slash <= 0 || slash === source.length - 1) throw new Error(`Invalid Durable model: ${source}`);
  const provider = source.slice(0, slash);
  let modelId = source.slice(slash + 1);
  let thinkingLevel;
  const colon = modelId.lastIndexOf(":");
  if (colon > 0 && THINKING_LEVELS.has(modelId.slice(colon + 1))) {
    thinkingLevel = modelId.slice(colon + 1);
    modelId = modelId.slice(0, colon);
  }
  return { provider, modelId, ...(thinkingLevel ? { thinkingLevel } : {}) };
}

function requireString(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`Durable ${name} is required`);
  return normalized;
}

function requireSafeInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Invalid Durable ${name}: ${value}`);
  return number;
}

function withKeyLock(locks, key, operation) {
  const previous = locks.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  locks.set(key, current);
  return current.finally(() => {
    if (locks.get(key) === current) locks.delete(key);
  });
}
