import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import YAML from "yaml";

export const DEFAULT_CONFIG_PATH = "config/telepi.yaml";

export function projectRootFromConfigPath(configPath) {
  return resolve(dirname(configPath), "..");
}

export function resolveConfigPath(explicitPath) {
  return resolve(explicitPath || process.env.TELEPI_CONFIG || DEFAULT_CONFIG_PATH);
}

export function readConfig(configPath) {
  const path = resolveConfigPath(configPath);
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }
  const text = readFileSync(path, "utf8");
  const data = YAML.parse(text) || {};
  return normalizeConfig(data, path);
}

// CLI maintenance commands can rotate a topic's session immediately before
// submitting its next broker prompt. Every ingress must therefore resolve
// against a fresh config instead of a gateway-startup snapshot. A transient
// malformed write keeps the last valid config so Telegram polling stays alive.
export function createReloadingConfigReader(configPath, options = {}) {
  let current = readConfig(configPath);
  return () => {
    try {
      current = readConfig(configPath);
    } catch (error) {
      options.onError?.(error);
    }
    return current;
  };
}

export function writeConfig(config, configPath) {
  const path = resolveConfigPath(configPath);
  mkdirSync(dirname(path), { recursive: true });
  const doc = new YAML.Document(config);
  doc.contents = config;
  writeFileSync(path, String(doc), "utf8");
}

export function normalizeConfig(config, configPath = resolveConfigPath()) {
  const root = resolvePath(projectRootFromConfigPath(configPath), config.project?.root || ".");
  const entitiesDir = resolvePath(root, config.project?.entities_dir || "entities");
  const sessionsDir = resolvePath(root, config.project?.sessions_dir || ".telepi/pi-sessions");
  return {
    version: config.version || 1,
    telegram: {
      bot_token_env: config.telegram?.bot_token_env || "TELEPI_BOT_TOKEN",
      bot_token: config.telegram?.bot_token,
      allowed_user_ids: stringifyList(config.telegram?.allowed_user_ids || []),
      display_messages: normalizeOptionalStringList(config.telegram?.display_messages),
      poll_timeout_seconds: Number(config.telegram?.poll_timeout_seconds || 25),
      poll_limit: Number(config.telegram?.poll_limit || 50),
      working_indicator: config.telegram?.working_indicator || "typing",
      typing_interval_seconds: Number(config.telegram?.typing_interval_seconds || 4),
    },
    users: normalizeUsers(config.users || {}),
    project: {
      root,
      entities_dir: entitiesDir,
      sessions_dir: sessionsDir,
      cache_dir: resolvePath(root, config.project?.cache_dir || ".telepi/cache"),
      extensions: stringifyList(config.project?.extensions || []),
    },
    manager: config.manager || {},
    agents: config.agents || {},
    topics: Array.isArray(config.topics) ? config.topics : [],
    sessions: normalizeSessions(config.sessions || {}),
    _path: configPath,
  };
}

export function serializableConfig(config) {
  const defaultRoot = config._path ? projectRootFromConfigPath(config._path) : resolve(".");
  const telegram = {
    bot_token_env: config.telegram?.bot_token_env || "TELEPI_BOT_TOKEN",
    allowed_user_ids: stringifyList(config.telegram?.allowed_user_ids || []),
    poll_timeout_seconds: config.telegram?.poll_timeout_seconds || 25,
    poll_limit: config.telegram?.poll_limit || 50,
    working_indicator: config.telegram?.working_indicator || "typing",
    typing_interval_seconds: config.telegram?.typing_interval_seconds || 4,
  };
  if (config.telegram?.display_messages) {
    telegram.display_messages = stringifyList(config.telegram.display_messages);
  }
  return {
    version: config.version || 1,
    telegram,
    users: config.users || {},
    project: {
      root: normalize(config.project.root) === normalize(defaultRoot) ? "." : config.project.root,
      entities_dir: relativeOrAbsolute(config.project.root, config.project.entities_dir),
      sessions_dir: relativeOrAbsolute(config.project.root, config.project.sessions_dir),
      cache_dir: relativeOrAbsolute(config.project.root, config.project.cache_dir),
      extensions: stringifyList(config.project.extensions || []),
    },
    manager: config.manager || {},
    agents: config.agents || {},
    topics: config.topics || [],
    sessions: config.sessions || { unlinked: [] },
  };
}

export function getBotToken(config) {
  const envName = config.telegram.bot_token_env || "TELEPI_BOT_TOKEN";
  const token = process.env[envName] || config.telegram.bot_token || process.env.PI_TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error(`Telegram bot token not found. Set ${envName} or PI_TELEGRAM_BOT_TOKEN.`);
  }
  return token;
}

export function findTopic(config, chatId, topicId) {
  const chat = String(chatId);
  const topic = topicId == null ? null : String(topicId);
  return config.topics.find((entry) => String(entry.chat_id) === chat && String(entry.topic_id) === String(topic));
}

export function findTopicByName(config, name) {
  return config.topics.find((entry) => entry.name === name);
}

export function resolveUser(config, aliasOrId) {
  if (!aliasOrId) {
    const owner = config.users?.owner;
    return owner ? config.users.aliases?.[owner] : undefined;
  }
  const value = String(aliasOrId);
  return config.users?.aliases?.[value] || { id: value, alias: value };
}

function normalizeUsers(users) {
  const aliases = {};
  for (const [alias, value] of Object.entries(users.aliases || {})) {
    aliases[alias] = typeof value === "object" ? { ...value, id: String(value.id), alias } : { id: String(value), alias };
  }
  return {
    owner: users.owner || null,
    aliases,
  };
}

function normalizeSessions(sessions) {
  const normalized = {
    unlinked: Array.isArray(sessions.unlinked) ? sessions.unlinked : [],
  };
  if (sessions.max_bytes != null) normalized.max_bytes = Number(sessions.max_bytes);
  return normalized;
}

function normalizeOptionalStringList(values) {
  if (values == null) return undefined;
  return stringifyList(Array.isArray(values) ? values : [values]).filter(Boolean);
}

export function getAgent(config, agentId) {
  const agent = config.agents?.[agentId];
  if (!agent) {
    throw new Error(`Unknown agent: ${agentId}`);
  }
  return agent;
}

// Topics without their own model override inherit from the agent's main topic
// (the topic named after the agent), so each agent's model is set in one place.
export function resolveTopicModel(config, topic, agent) {
  if (topic.model) return topic.model;
  const mainName = agent.name || topic.agent;
  const mainTopic = (config.topics || []).find((entry) => entry.agent === topic.agent && entry.name === mainName);
  return mainTopic?.model;
}

export function resolveEntityDir(config, agent) {
  const entityDir = agent.entity_dir || join("entities", agent.name || "agent");
  return resolvePath(config.project.root, entityDir);
}

export function resolveTopicSession(config, topic, options = {}) {
  const agent = options.agent || getAgent(config, topic.agent);
  const entityDir = resolveEntityDir(config, agent);
  const nested = topic.session;
  if (nested != null && (typeof nested !== "object" || Array.isArray(nested))) {
    throw new Error(`Invalid session config for ${topic.name}: expected an object`);
  }
  const id = String(
    options.sessionId
      || nested?.id
      || topic.session_id
      || agent.session_id
      || `${topic.agent}-${topic.topic_id}`,
  );
  const configuredLocation = nested?.location;
  if (configuredLocation == null) {
    return { id, cwd: entityDir, entityDir, location: null };
  }
  if (typeof configuredLocation === "string") {
    throw new Error(`Named session locations are not supported yet: ${configuredLocation}`);
  }
  if (typeof configuredLocation !== "object" || Array.isArray(configuredLocation)) {
    throw new Error(`Invalid session location for ${topic.name}: expected an object`);
  }
  const configuredCwd = String(configuredLocation.cwd || "").trim();
  if (!configuredCwd) throw new Error(`Session location for ${topic.name} is missing cwd`);
  return {
    id,
    cwd: resolvePath(config.project.root, configuredCwd),
    entityDir,
    location: { ...configuredLocation, cwd: configuredCwd },
  };
}

export function createTopicSessionConfig(id, cwd) {
  return {
    id: String(id),
    location: { cwd: String(cwd) },
  };
}

export function setTopicSessionId(topic, id) {
  if (topic.session && typeof topic.session === "object" && !Array.isArray(topic.session)) {
    topic.session.id = String(id);
    return;
  }
  topic.session_id = String(id);
}

export function resolvePath(base, path) {
  return isAbsolute(path) ? normalize(path) : resolve(base, path);
}

function stringifyList(values) {
  return values.map((value) => String(value));
}

function relativeOrAbsolute(base, path) {
  const relative = normalize(path).startsWith(normalize(base)) ? normalize(path).slice(normalize(base).length + 1) : null;
  return relative && !relative.startsWith("..") ? relative || "." : path;
}
