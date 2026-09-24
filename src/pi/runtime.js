import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgent, resolveEntityDir, resolvePath, resolveTopicModel } from "../config.js";

const MODEL_OPERATION_TIMEOUT_MS = 15_000;

// Resolve the stable Telepi inputs independently of Pi's process-global state.
// Location-aware cwd/agent-dir selection will extend this seam later; the first
// SDK worker intentionally preserves today's entity cwd and host Pi agent dir.
export function buildTopicRuntimeSpec(config, topic, options = {}) {
  const agent = getAgent(config, topic.agent);
  const infrastructureAgentDir = resolve(options.infrastructureAgentDir);
  const agentDir = resolve(options.agentDir || infrastructureAgentDir);
  const cwd = resolveEntityDir(config, agent);
  const sessionId = String(options.sessionId || topic.session_id || agent.session_id || `${topic.agent}-${topic.topic_id}`);

  return {
    agent,
    agentDir,
    infrastructureAgentDir,
    cwd,
    sessionDir: config.project.sessions_dir,
    sessionId,
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
    const projectTrusted = resolveProjectTrust(pi, cwd, agentDir, diagnostics);
    const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted });
    const modelRuntime = await pi.ModelRuntime.create({
      authPath: join(spec.infrastructureAgentDir, "auth.json"),
      modelsPath: join(spec.infrastructureAgentDir, "models.json"),
      modelsStorePath: join(spec.infrastructureAgentDir, "models-store.json"),
      signal: AbortSignal.timeout(MODEL_OPERATION_TIMEOUT_MS),
    });
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
  return SessionManager.create(spec.cwd, spec.sessionDir, { id: spec.sessionId });
}

function resolveProjectTrust(pi, cwd, agentDir, diagnostics) {
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
