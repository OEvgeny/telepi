import { closeSync, mkdirSync, openSync, readSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgent, resolvePath, resolveTopicModel, resolveTopicSession } from "../config.js";
import { applyHttpProxySettings, configurePiHttpDispatcher } from "./http-dispatcher.js";

const MODEL_OPERATION_TIMEOUT_MS = 15_000;

// Resolve the stable Telepi inputs independently of Pi's process-global state.
// Legacy topics use the host Pi agent directory and entity cwd. A configured
// session location switches to the portable Agent + Location split: entity root
// is Pi's agentDir, while location.cwd is the project cwd.
export function buildTopicRuntimeSpec(config, topic, options = {}) {
  const agent = getAgent(config, topic.agent);
  const infrastructureAgentDir = resolve(options.infrastructureAgentDir);
  const session = resolveTopicSession(config, topic, { agent, sessionId: options.sessionId });
  const agentDir = session.location
    ? session.entityDir
    : resolve(options.agentDir || infrastructureAgentDir);

  return {
    agent,
    agentDir,
    infrastructureAgentDir,
    cwd: session.cwd,
    location: session.location,
    sessionDir: config.project.sessions_dir,
    sessionId: session.id,
    modelSpec: resolveTopicModel(config, topic, agent),
    extensionPaths: [...new Set([
      ...(config.project.extensions || []),
      ...(agent.extensions || []),
    ].map((path) => resolvePath(config.project.root, path)))],
    skillPaths: [...new Set((agent.skills || []).map((path) => resolvePath(config.project.root, path)))],
    appendSystemPrompt: agent.system_prompt ? [String(agent.system_prompt)] : [],
  };
}

export async function createTopicRuntime(pi, config, topic, options = {}) {
  const infrastructureAgentDir = options.infrastructureAgentDir || pi.getAgentDir();
  const spec = buildTopicRuntimeSpec(config, topic, {
    ...options,
    infrastructureAgentDir,
  });

  mkdirSync(spec.cwd, { recursive: true });
  mkdirSync(spec.sessionDir, { recursive: true });
  pi.assertValidSessionId?.(spec.sessionId);

  const sessionManager = await openConfiguredSession(pi.SessionManager, spec);
  const actualCwd = resolve(sessionManager.getCwd());
  if (actualCwd !== resolve(spec.cwd)) {
    throw new Error(`Session cwd mismatch for ${topic.name}: ${actualCwd} != ${resolve(spec.cwd)}`);
  }

  const createRuntime = async ({ cwd, agentDir, sessionManager: activeSessionManager, sessionStartEvent }) => {
    const diagnostics = [];
    const projectTrusted = resolveProjectTrust(pi, cwd, spec.infrastructureAgentDir, diagnostics);
    const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted });
    applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
    configurePiHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
    const modelRuntime = await createInfrastructureModelRuntime(pi, spec.infrastructureAgentDir);
    const services = await pi.createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: {
        additionalExtensionPaths: spec.extensionPaths,
        additionalSkillPaths: spec.skillPaths,
        appendSystemPrompt: spec.appendSystemPrompt,
      },
    });

    diagnostics.push(
      ...services.diagnostics,
      ...collectSettingsDiagnostics(settingsManager),
      ...services.resourceLoader.getExtensions().errors.map(({ path, error }) => ({
        type: "error",
        message: `Failed to load extension "${path}": ${error}`,
      })),
    );

    const selection = await resolveSessionSelection(pi, spec, services, activeSessionManager);
    diagnostics.push(...selection.diagnostics);
    const created = await pi.createAgentSessionFromServices({
      services,
      sessionManager: activeSessionManager,
      sessionStartEvent,
      model: selection.model,
      thinkingLevel: selection.thinkingLevel,
      scopedModels: selection.scopedModels,
    });

    // Match Pi's CLI behavior: an explicit :thinking suffix becomes a
    // persisted session override rather than only an in-memory initial value.
    if (created.session.model && selection.explicitThinking) {
      created.session.setThinkingLevel(created.session.thinkingLevel);
    }

    return {
      ...created,
      services,
      diagnostics: deduplicateDiagnostics(diagnostics),
    };
  };

  const runtime = await pi.createAgentSessionRuntime(createRuntime, {
    cwd: sessionManager.getCwd(),
    agentDir: spec.agentDir,
    sessionManager,
  });

  return { runtime, spec };
}

async function openConfiguredSession(SessionManager, spec) {
  const localMatch = (await SessionManager.list(spec.cwd, spec.sessionDir))
    .find((session) => String(session.id) === spec.sessionId);
  if (localMatch) return SessionManager.open(localMatch.path, spec.sessionDir);

  const existing = findSessionHeaders(spec.sessionDir, spec.sessionId);
  const conflicting = existing.find(({ header }) => resolve(header.cwd || "") !== resolve(spec.cwd));
  if (conflicting) {
    const existingCwd = conflicting.header.cwd ? resolve(conflicting.header.cwd) : "an unknown cwd";
    throw new Error(
      `Session ${spec.sessionId} belongs to ${existingCwd}, not ${resolve(spec.cwd)}; `
      + "rotate the topic session before changing its location",
    );
  }
  const sameCwd = existing.find(({ header }) => resolve(header.cwd || "") === resolve(spec.cwd));
  if (sameCwd) return SessionManager.open(sameCwd.path, spec.sessionDir);
  return SessionManager.create(spec.cwd, spec.sessionDir, { id: spec.sessionId });
}

export function findSessionHeaders(sessionDir, sessionId) {
  const matches = [];
  try {
    for (const name of readdirSync(sessionDir).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(sessionDir, name);
      const fd = openSync(path, "r");
      try {
        const buffer = Buffer.alloc(4096);
        const length = readSync(fd, buffer, 0, buffer.length, 0);
        const newline = buffer.indexOf(0x0a, 0);
        const header = JSON.parse(buffer.subarray(0, newline >= 0 ? newline : length).toString("utf8"));
        if (header?.type === "session" && String(header.id) === String(sessionId)) {
          matches.push({ header, path });
        }
      } catch {
        // Ignore malformed and unrelated histories here; session readers report
        // their own diagnostics without mutating transcript files.
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    return matches;
  }
  return matches;
}

export function resolveProjectTrust(pi, cwd, agentDir, diagnostics) {
  if (!pi.hasTrustRequiringProjectResources(cwd)) return true;
  const decision = new pi.ProjectTrustStore(agentDir).get(cwd);
  if (decision == null) {
    diagnostics.push({
      type: "error",
      message: `Project trust has not been decided for ${cwd}; open it in Pi once and choose a trust policy`,
    });
    return false;
  }
  return decision;
}

export function createInfrastructureModelRuntime(pi, infrastructureAgentDir) {
  return pi.ModelRuntime.create({
    authPath: join(infrastructureAgentDir, "auth.json"),
    modelsPath: join(infrastructureAgentDir, "models.json"),
    modelsStorePath: join(infrastructureAgentDir, "models-store.json"),
    signal: AbortSignal.timeout(MODEL_OPERATION_TIMEOUT_MS),
  });
}

async function resolveSessionSelection(pi, spec, services, sessionManager) {
  const diagnostics = [];
  const modelPatterns = services.settingsManager.getEnabledModels();
  let scopedModels = [];
  if (modelPatterns?.length) {
    const resolvedScope = await pi.resolveModelScopeWithDiagnostics(
      modelPatterns,
      services.modelRuntime,
      { signal: AbortSignal.timeout(MODEL_OPERATION_TIMEOUT_MS) },
    );
    scopedModels = resolvedScope.scopedModels;
    diagnostics.push(...resolvedScope.diagnostics);
  }

  let model;
  let thinkingLevel;
  let explicitThinking = false;
  if (spec.modelSpec) {
    const resolvedModel = pi.resolveCliModel({
      cliModel: String(spec.modelSpec),
      modelRuntime: services.modelRuntime,
    });
    if (resolvedModel.warning) diagnostics.push({ type: "warning", message: resolvedModel.warning });
    if (resolvedModel.error) diagnostics.push({ type: "error", message: resolvedModel.error });
    model = resolvedModel.model;
    thinkingLevel = resolvedModel.thinkingLevel;
    explicitThinking = resolvedModel.thinkingLevel !== undefined;
  }

  if (!model && scopedModels.length && sessionManager.buildSessionContext().messages.length === 0) {
    const defaultProvider = services.settingsManager.getDefaultProvider();
    const defaultModelId = services.settingsManager.getDefaultModel();
    const preferred = scopedModels.find(({ model: candidate }) => (
      candidate.provider === defaultProvider && candidate.id === defaultModelId
    ));
    const selected = preferred || scopedModels[0];
    model = selected.model;
    thinkingLevel = selected.thinkingLevel;
  }

  return {
    model,
    thinkingLevel,
    explicitThinking,
    scopedModels: scopedModels.map(({ model: scopedModel, thinkingLevel: scopedThinking }) => ({
      model: scopedModel,
      thinkingLevel: scopedThinking,
    })),
    diagnostics,
  };
}

function collectSettingsDiagnostics(settingsManager) {
  return settingsManager.drainErrors().map(({ scope, path, error }) => ({
    type: "warning",
    message: path
      ? `Invalid settings file ${path}: ${error.message}`
      : `Invalid ${scope} settings: ${error.message}`,
  }));
}

function deduplicateDiagnostics(diagnostics) {
  const seen = new Set();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.type}\0${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
