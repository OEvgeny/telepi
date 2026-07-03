#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  findTopicByName,
  getBotToken,
  readConfig,
  resolvePath,
  resolveUser,
  resolveConfigPath,
  serializableConfig,
  writeConfig,
} from "../src/config.js";
import { TelegramClient, normalizeTopicColor, resolveForumTopicIcon } from "../src/telegram.js";
import { toTelegramMarkdownV2 } from "../src/telegram-format.js";
import { startPiForTopic } from "../src/pi-session.js";

const program = new Command();

program
  .name("telepi")
  .description("Manage Telegram topic to pi session mappings")
  .option("-c, --config <path>", "YAML config path", process.env.TELEPI_CONFIG || "config/telepi.yaml");

program
  .command("validate")
  .description("Validate the YAML config and referenced agents")
  .action(() => {
    const config = load();
    const errors = validateConfig(config);
    if (errors.length) {
      for (const error of errors) console.error(`error: ${error}`);
      process.exit(1);
    }
    console.log(`ok: ${config.topics.length} topic(s), ${Object.keys(config.agents).length} agent(s)`);
  });

program
  .command("agents")
  .description("List configured agents")
  .action(() => {
    const config = load();
    for (const [id, agent] of Object.entries(config.agents)) {
      console.log(`${id}\t${agent.name || id}\t${agent.entity_dir || ""}`);
    }
  });

program
  .command("topics")
  .description("List topic mappings")
  .action(() => {
    const config = load();
    for (const topic of config.topics) {
      const owner = topic.owner ? `\towner=${topic.owner}` : "";
      console.log(`${topic.name}\tchat=${topic.chat_id}\ttopic=${topic.topic_id}\tagent=${topic.agent}\tsession=${topic.session_id}${owner}`);
    }
  });

program
  .command("users")
  .description("List configured Telegram user aliases")
  .action(() => {
    const config = load();
    for (const [alias, user] of Object.entries(config.users.aliases || {})) {
      const marker = alias === config.users.owner ? " owner" : "";
      console.log(`${alias}\t${user.id}${marker}`);
    }
  });

program
  .command("telegram:me")
  .description("Check the configured Telegram bot credentials")
  .action(async () => {
    const config = load();
    const telegram = new TelegramClient(getBotToken(config));
    const me = await telegram.getMe();
    console.log(`${me.first_name}\t@${me.username || ""}\tid=${me.id}`);
  });

program
  .command("icons")
  .description("List Telegram forum topic icons available to this bot")
  .action(async () => {
    const config = load();
    const telegram = new TelegramClient(getBotToken(config));
    const stickers = await telegram.getForumTopicIconStickers();
    for (const sticker of stickers) {
      console.log(`${sticker.emoji}\t${sticker.custom_emoji_id}`);
    }
  });

program
  .command("agent:create")
  .description("Create an agent entity folder and config entry")
  .requiredOption("--id <id>", "Stable agent id")
  .option("--name <name>", "Display name")
  .option("--entity-dir <path>", "Entity folder relative to project root")
  .option("--skill <path...>", "Skill file(s) relative to project root")
  .option("--extension <path...>", "Pi extension file(s) relative to project root")
  .option("--session-id <id>", "Default pi session id")
  .option("--chat-id <id>", "Telegram chat id for the seed topic; defaults to manager.chat_id")
  .option("--owner <alias-or-id>", "Topic owner alias/id; defaults to configured owner")
  .option("--topic-name <name>", "Seed topic name; defaults to the agent display name")
  .option("--no-seed-topic", "Create only the entity/config entry, without a Telegram seed topic")
  .option("--color <color>", "Default Telegram topic color name or integer", "blue")
  .option("--style <style>", "Default free-form style metadata")
  .option("--avatar <avatar>", "Default free-form avatar metadata")
  .option("--icon-custom-emoji-id <id>", "Telegram forum topic icon custom_emoji_id")
  .action(async (options) => {
    const config = load();
    if (config.agents[options.id]) throwCli(`agent already exists: ${options.id}`);
    const agentName = options.name || options.id;
    const entityDir = options.entityDir || join("entities", options.id);
    config.agents[options.id] = {
      name: agentName,
      entity_dir: entityDir,
      session_id: options.sessionId || options.id,
      skills: options.skill || [],
      extensions: options.extension || [],
      branding: {
        color: options.color,
        style: options.style || null,
        avatar: options.avatar || null,
        icon_custom_emoji_id: options.iconCustomEmojiId || null,
      },
    };
    mkdirSync(join(config.project.root, entityDir), { recursive: true });
    const agentsMd = join(config.project.root, entityDir, "AGENTS.md");
    if (!existsSync(agentsMd)) {
      writeFileSync(agentsMd, `# ${agentName}\n\nThis folder is the stable entity state for the ${options.id} Telegram topic agent.\n`, "utf8");
    }
    if (options.seedTopic) {
      const owner = resolveUser(config, options.owner);
      const resolvedChatId = options.chatId || (options.owner ? owner?.id : config.manager?.chat_id) || owner?.id;
      if (!resolvedChatId) throwCli("seed topic requested, but no --chat-id, --owner, manager.chat_id, or users.owner is configured");
      await createTopicEntry(config, {
        chatId: resolvedChatId,
        owner: owner?.alias,
        name: options.topicName || agentName,
        agentId: options.id,
        sessionId: options.sessionId || options.id,
        color: options.color,
        style: options.style,
        avatar: options.avatar,
        iconCustomEmojiId: options.iconCustomEmojiId,
      });
    }
    save(config);
    console.log(`created agent ${options.id}`);
  });

program
  .command("agent:skills")
  .description("List or modify an agent's skills")
  .requiredOption("--id <id>", "Agent id")
  .option("--add <path...>", "Skill file(s) relative to project root")
  .option("--remove <path...>", "Skill file(s) to detach")
  .action((options) => {
    const config = load();
    const agent = config.agents[options.id];
    if (!agent) throwCli(`unknown agent: ${options.id}`);
    const skills = new Set(agent.skills || []);
    for (const skill of options.add || []) {
      if (!existsSync(resolvePath(config.project.root, skill))) throwCli(`skill file not found: ${skill}`);
      skills.add(skill);
    }
    for (const skill of options.remove || []) {
      if (!skills.delete(skill)) throwCli(`skill not attached: ${skill}`);
    }
    agent.skills = [...skills];
    if (options.add?.length || options.remove?.length) save(config);
    console.log(agent.skills.length ? agent.skills.join("\n") : "(no skills)");
  });

program
  .command("topic:create")
  .description("Create a Telegram forum topic and bind it to an agent")
  .option("--chat-id <id>", "Telegram chat id")
  .option("--owner <alias-or-id>", "Topic owner alias/id; fills --chat-id when omitted")
  .requiredOption("--name <name>", "Topic name")
  .requiredOption("--agent <id>", "Configured agent id")
  .option("--session-id <id>", "Stable pi session id")
  .option("--color <color>", "Telegram topic icon color name or integer")
  .option("--style <style>", "Free-form style metadata")
  .option("--avatar <avatar>", "Free-form avatar metadata")
  .option("--icon-custom-emoji-id <id>", "Telegram forum topic icon custom_emoji_id")
  .action(async (options) => {
    const config = load();
    if (!config.agents[options.agent]) throwCli(`unknown agent: ${options.agent}`);
    const owner = resolveUser(config, options.owner);
    const chatId = options.chatId || owner?.id;
    if (!chatId) throwCli("missing --chat-id or resolvable --owner");
    if (findTopicByName(config, options.name)) throwCli(`topic name already exists: ${options.name}`);
    const entry = await createTopicEntry(config, {
      chatId,
      owner: owner?.alias,
      name: options.name,
      agentId: options.agent,
      sessionId: options.sessionId,
      color: options.color,
      style: options.style,
      avatar: options.avatar,
      iconCustomEmojiId: options.iconCustomEmojiId,
    });
    save(config);
    console.log(`created topic ${entry.name}: ${entry.topic_id}`);
  });

program
  .command("topic:bind")
  .description("Bind an existing Telegram topic id to an agent")
  .requiredOption("--chat-id <id>", "Telegram chat id")
  .requiredOption("--topic-id <id>", "Telegram message_thread_id")
  .requiredOption("--name <name>", "Mapping name")
  .requiredOption("--agent <id>", "Configured agent id")
  .option("--session-id <id>", "Stable pi session id")
  .option("--style <style>", "Free-form style metadata")
  .option("--avatar <avatar>", "Free-form avatar metadata")
  .action((options) => {
    const config = load();
    if (!config.agents[options.agent]) throwCli(`unknown agent: ${options.agent}`);
    const exists = config.topics.some((topic) => String(topic.chat_id) === String(options.chatId) && String(topic.topic_id) === String(options.topicId));
    if (exists) throwCli(`mapping already exists for chat=${options.chatId} topic=${options.topicId}`);
    const agent = config.agents[options.agent];
    config.topics.push({
      name: options.name,
      chat_id: String(options.chatId),
      topic_id: String(options.topicId),
      agent: options.agent,
      session_id: options.sessionId || defaultSessionId(options.agent, agent, options.name, options.topicId),
      enabled: true,
      style: options.style ?? agent.branding?.style ?? null,
      avatar: options.avatar ?? agent.branding?.avatar ?? null,
      color: agent.branding?.color ?? null,
      icon_custom_emoji_id: agent.branding?.icon_custom_emoji_id ?? null,
      owner: ownerAliasForChat(config, options.chatId),
    });
    save(config);
    console.log(`bound topic ${options.name}`);
  });

program
  .command("topic:rename")
  .description("Rename a Telegram topic and update the mapping")
  .requiredOption("--name <name>", "Existing mapping name")
  .requiredOption("--to <name>", "New topic name")
  .action(async (options) => {
    const config = load();
    const topic = findTopicByName(config, options.name);
    if (!topic) throwCli(`unknown topic mapping: ${options.name}`);
    const telegram = new TelegramClient(getBotToken(config));
    await telegram.renameTopic({ chatId: topic.chat_id, topicId: topic.topic_id, name: options.to });
    topic.name = options.to;
    save(config);
    console.log(`renamed topic ${options.name} -> ${options.to}`);
  });

program
  .command("topic:set-agent")
  .description("Re-route an existing topic mapping to another agent/session")
  .requiredOption("--name <name>", "Existing mapping name")
  .requiredOption("--agent <id>", "Configured agent id")
  .option("--session-id <id>", "Stable pi session id")
  .action((options) => {
    const config = load();
    const topic = findTopicByName(config, options.name);
    if (!topic) throwCli(`unknown topic mapping: ${options.name}`);
    if (!config.agents[options.agent]) throwCli(`unknown agent: ${options.agent}`);
    topic.agent = options.agent;
    if (options.sessionId) topic.session_id = options.sessionId;
    save(config);
    console.log(`updated ${topic.name} -> ${topic.agent}/${topic.session_id}`);
  });

program
  .command("topic:set-model")
  .description("Set or clear a per-topic pi model override")
  .requiredOption("--name <name>", "Existing mapping name")
  .option("--model <provider/model>", "Model override to pass to pi")
  .option("--clear", "Remove the per-topic model override")
  .action((options) => {
    const config = load();
    const topic = findTopicByName(config, options.name);
    if (!topic) throwCli(`unknown topic mapping: ${options.name}`);
    if (options.clear) {
      delete topic.model;
      save(config);
      console.log(`cleared model override for ${topic.name}`);
      return;
    }
    if (!options.model) throwCli("missing --model or --clear");
    topic.model = String(options.model);
    save(config);
    console.log(`updated ${topic.name} model -> ${topic.model}`);
  });

program
  .command("topic:prompt")
  .description("Prompt a mapped topic's pi agent and send the response to Telegram")
  .option("--topic <name>", "Existing topic mapping name")
  .option("--agent <id>", "Configured agent id; allowed only when it has exactly one enabled topic")
  .option("--text <text>", "Prompt text")
  .option("--stdin", "Read prompt text from stdin")
  .option("--no-echo", "Do not post the prompt into Telegram before running pi")
  .action(async (options) => {
    const config = load();
    const topic = resolvePromptTopic(config, options);
    if (topic.enabled === false) throwCli(`topic is disabled: ${topic.name}`);
    const text = promptText(options);
    if (!text.trim()) throwCli("missing --text or non-empty --stdin");

    const telegram = new TelegramClient(getBotToken(config));
    let promptMessageId = "";
    if (options.echo) {
      const sentMessages = await sendCliLongMessage(telegram, {
        chatId: topic.chat_id,
        topicId: topic.topic_id,
        text,
      });
      promptMessageId = sentMessages[0]?.message_id == null ? "" : String(sentMessages[0].message_id);
      console.log(`sent prompt to ${topic.name}: message=${promptMessageId}`);
    }

    // Timer/CLI prompts run on behalf of the topic owner, so agents see the
    // same identity as when the owner writes in Telegram.
    const owner = resolveUser(config, topic.owner);
    const envelope = {
      updateId: `cli:${Date.now()}`,
      chatId: String(topic.chat_id),
      topicId: topic.topic_id == null ? null : String(topic.topic_id),
      userId: owner?.id || "telepi-cli",
      userName: owner?.alias || "telepi-cli",
      messageId: promptMessageId,
      text,
      attachments: [],
    };

    let delivered = 0;
    let toolDeliveries = 0;
    let lastModelError;
    const countToolDelivery = (event) => {
      if (cliIsTelegramDeliveryEvent(event)) toolDeliveries += 1;
      if (event?.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "error") {
        lastModelError = String(event.message.errorMessage || "unknown model error");
      }
    };
    const displayBridge = createCliDisplayBridge(config, telegram, topic, envelope);
    const run = await startPiForTopic(config, topic, envelope, displayBridge ? {
      onEvent: (event) => {
        countToolDelivery(event);
        displayBridge.onEvent(event);
      },
    } : {
      onEvent: countToolDelivery,
      onText: async (chunk) => {
        const sentMessages = await sendCliLongMessage(telegram, {
          chatId: topic.chat_id,
          topicId: topic.topic_id,
          replyToMessageId: promptMessageId || undefined,
          text: chunk,
        });
        delivered += sentMessages.length;
      },
    });
    const result = await run.promise;
    if (displayBridge) {
      await displayBridge.flush();
      delivered += displayBridge.deliveredCount();
    }
    if (!result.ok) {
      await sendCliLongMessage(telegram, {
        chatId: topic.chat_id,
        topicId: topic.topic_id,
        replyToMessageId: promptMessageId || undefined,
        text: `pi session failed (${result.code})\n\n${result.stderr || result.stdout || "No output"}`,
      });
      process.exitCode = 1;
      return;
    }
    if (lastModelError) {
      await sendCliLongMessage(telegram, {
        chatId: topic.chat_id,
        topicId: topic.topic_id,
        replyToMessageId: promptMessageId || undefined,
        text: `⚠️ ${topic.agent} hit a model error: ${lastModelError}`,
      });
    } else if (!delivered && !toolDeliveries) {
      await sendCliLongMessage(telegram, {
        chatId: topic.chat_id,
        topicId: topic.topic_id,
        replyToMessageId: promptMessageId || undefined,
        text: result.stdout || `${topic.agent} completed without output.`,
      });
    }
    console.log(`completed ${topic.name} -> ${topic.agent}/${topic.session_id}`);
  });

program
  .command("session:list")
  .description("List active and unlinked pi sessions known to telepi")
  .option("--topic <name>", "Limit output to one topic mapping name")
  .option("--files", "Include matching session transcript files")
  .option("--unlinked", "Only show unlinked session history")
  .action((options) => {
    const config = load();
    const topics = options.topic ? [findTopicByName(config, options.topic)].filter(Boolean) : config.topics;
    if (options.topic && !topics.length) throwCli(`unknown topic mapping: ${options.topic}`);
    if (!options.unlinked) {
      for (const topic of topics) {
        console.log(`active\t${topic.name}\tchat=${topic.chat_id}\ttopic=${topic.topic_id}\tagent=${topic.agent}\tsession=${topic.session_id}`);
        if (options.files) {
          for (const file of sessionFiles(config, topic.session_id)) {
            console.log(`file\t${topic.name}\t${file.name}\t${file.size}`);
          }
        }
      }
    }
    for (const entry of config.sessions?.unlinked || []) {
      if (options.topic && entry.topic_name !== options.topic) continue;
      console.log(`unlinked\t${entry.topic_name}\tchat=${entry.chat_id}\ttopic=${entry.topic_id}\tagent=${entry.agent}\tsession=${entry.session_id}\tunlinked_at=${entry.unlinked_at}${entry.reason ? `\treason=${entry.reason}` : ""}`);
      if (options.files) {
        for (const file of sessionFiles(config, entry.session_id)) {
          console.log(`file\t${entry.topic_name}\t${file.name}\t${file.size}`);
        }
      }
    }
  });

program
  .command("session:compact")
  .description("Compact a topic's pi session transcript in place")
  .requiredOption("--topic <name>", "Existing topic mapping name")
  .option("--instructions <text>", "Custom compaction instructions")
  .option("--model <provider/model>", "Model to run the compaction with; defaults to the topic's configured model")
  .option("--keep-recent <tokens>", "How many recent tokens to keep uncompacted (default 20000)")
  .action(async (options) => {
    const { compactPiSession } = await import("../src/pi-compact.js");
    const config = load();
    const topic = findTopicByName(config, options.topic);
    if (!topic) throwCli(`unknown topic mapping: ${options.topic}`);
    let result;
    try {
      result = await compactPiSession(config, topic, options.instructions, {
        model: options.model,
        keepRecentTokens: options.keepRecent,
      });
    } catch (error) {
      // Nothing new since the last compaction — a no-op, not a failure (timers rerun this nightly).
      if (/Already compacted|too small/i.test(error.message)) {
        console.log(`skipped ${topic.name} (${topic.session_id}): ${error.message}`);
        return;
      }
      throw error;
    }
    console.log(`compacted ${topic.name} (${topic.session_id}): tokensBefore=${result?.tokensBefore ?? "?"}`);
  });

program
  .command("session:unlink")
  .description("Preserve a topic's current pi session history and switch it to a fresh session id")
  .requiredOption("--name <name>", "Existing mapping name")
  .option("--session-id <id>", "New pi session id; defaults to a generated id")
  .option("--reason <text>", "Reason to store in session history")
  .action((options) => {
    const config = load();
    const topic = findTopicByName(config, options.name);
    if (!topic) throwCli(`unknown topic mapping: ${options.name}`);
    const oldSessionId = topic.session_id;
    const newSessionId = options.sessionId || freshSessionId(topic);
    if (String(oldSessionId) === String(newSessionId)) throwCli("new session id must differ from the current session id");
    config.sessions ||= {};
    config.sessions.unlinked ||= [];
    config.sessions.unlinked.push({
      topic_name: topic.name,
      chat_id: String(topic.chat_id),
      topic_id: String(topic.topic_id),
      agent: topic.agent,
      session_id: String(oldSessionId),
      replaced_by_session_id: String(newSessionId),
      unlinked_at: new Date().toISOString(),
      reason: options.reason || null,
    });
    topic.session_id = String(newSessionId);
    save(config);
    console.log(`unlinked ${topic.name}: ${oldSessionId} -> ${newSessionId}`);
  });

program
  .command("session:restore")
  .description("Point a topic mapping back to a previous session id without deleting any files")
  .requiredOption("--name <name>", "Existing mapping name")
  .option("--session-id <id>", "Previous pi session id to restore")
  .option("--index <number>", "1-based index from session:list --topic <name> --unlinked")
  .action((options) => {
    const config = load();
    const topic = findTopicByName(config, options.name);
    if (!topic) throwCli(`unknown topic mapping: ${options.name}`);
    const entries = (config.sessions?.unlinked || []).filter((entry) => entry.topic_name === topic.name);
    let sessionId = options.sessionId;
    if (!sessionId && options.index) {
      const index = Number(options.index);
      if (!Number.isInteger(index) || index < 1 || index > entries.length) throwCli(`invalid --index; expected 1-${entries.length}`);
      sessionId = entries[index - 1].session_id;
    }
    if (!sessionId) throwCli("missing --session-id or --index");
    const oldSessionId = topic.session_id;
    topic.session_id = String(sessionId);
    config.sessions ||= {};
    config.sessions.unlinked ||= [];
    config.sessions.unlinked.push({
      topic_name: topic.name,
      chat_id: String(topic.chat_id),
      topic_id: String(topic.topic_id),
      agent: topic.agent,
      session_id: String(oldSessionId),
      replaced_by_session_id: String(sessionId),
      unlinked_at: new Date().toISOString(),
      reason: "restore replaced active session",
    });
    save(config);
    console.log(`restored ${topic.name}: ${oldSessionId} -> ${sessionId}`);
  });

program
  .command("topic:set-icon")
  .description("Set a Telegram topic icon from an available avatar emoji or custom emoji id")
  .requiredOption("--name <name>", "Existing mapping name")
  .option("--avatar <emoji>", "Avatar emoji to resolve through Telegram forum topic icons")
  .option("--icon-custom-emoji-id <id>", "Telegram forum topic icon custom_emoji_id")
  .action(async (options) => {
    const config = load();
    const topic = findTopicByName(config, options.name);
    if (!topic) throwCli(`unknown topic mapping: ${options.name}`);
    const telegram = new TelegramClient(getBotToken(config));
    const iconCustomEmojiId = await resolveForumTopicIcon(telegram, {
      avatar: options.avatar ?? topic.avatar,
      iconCustomEmojiId: options.iconCustomEmojiId,
    });
    if (!iconCustomEmojiId) {
      throwCli(`avatar is not available as a Telegram forum topic icon: ${options.avatar ?? topic.avatar}`);
    }
    await telegram.editTopic({
      chatId: topic.chat_id,
      topicId: topic.topic_id,
      name: topic.name,
      iconCustomEmojiId,
    });
    if (options.avatar) topic.avatar = options.avatar;
    topic.icon_custom_emoji_id = iconCustomEmojiId;
    save(config);
    console.log(`updated icon for ${topic.name}: ${iconCustomEmojiId}`);
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error.message);
  process.exit(1);
});

function load() {
  return readConfig(program.opts().config);
}

function save(config) {
  writeConfig(serializableConfig(config), resolveConfigPath(program.opts().config));
}

function validateConfig(config) {
  const errors = [];
  const seen = new Set();
  if (config.users.owner && !config.users.aliases?.[config.users.owner]) {
    errors.push(`users.owner references unknown alias ${config.users.owner}`);
  }
  for (const [alias, user] of Object.entries(config.users.aliases || {})) {
    if (!user.id) errors.push(`user alias ${alias} missing id`);
    if (!config.telegram.allowed_user_ids.includes(String(user.id))) {
      errors.push(`user alias ${alias} id ${user.id} is not in telegram.allowed_user_ids`);
    }
  }
  for (const [id, agent] of Object.entries(config.agents)) {
    if (!agent.entity_dir) errors.push(`agent ${id} missing entity_dir`);
    for (const skill of agent.skills || []) {
      const path = join(config.project.root, skill);
      if (!existsSync(path)) errors.push(`agent ${id} skill missing: ${relative(config.project.root, path)}`);
    }
    for (const extension of agent.extensions || []) {
      const path = join(config.project.root, extension);
      if (!existsSync(path)) errors.push(`agent ${id} extension missing: ${relative(config.project.root, path)}`);
    }
  }
  for (const extension of config.project.extensions || []) {
    const path = join(config.project.root, extension);
    if (!existsSync(path)) errors.push(`project extension missing: ${relative(config.project.root, path)}`);
  }
  for (const topic of config.topics) {
    const key = `${topic.chat_id}:${topic.topic_id}`;
    if (seen.has(key)) errors.push(`duplicate topic mapping: ${key}`);
    seen.add(key);
    if (!config.agents[topic.agent]) errors.push(`topic ${topic.name} references unknown agent ${topic.agent}`);
    if (!topic.session_id) errors.push(`topic ${topic.name} missing session_id`);
  }
  return errors;
}

async function createTopicEntry(config, options) {
  const agent = config.agents[options.agentId];
  const color = options.color ?? agent.branding?.color ?? "blue";
  const telegram = new TelegramClient(getBotToken(config));
  const iconCustomEmojiId = await resolveForumTopicIcon(telegram, {
    avatar: options.avatar ?? agent.branding?.avatar,
    iconCustomEmojiId: options.iconCustomEmojiId ?? agent.branding?.icon_custom_emoji_id,
  });
  const topic = await telegram.createTopicWithIcon({
    chatId: options.chatId,
    name: options.name,
    iconColor: color,
    iconCustomEmojiId,
  });
  const entry = {
    name: options.name,
    chat_id: String(options.chatId),
    topic_id: String(topic.message_thread_id),
    agent: options.agentId,
    session_id: options.sessionId || defaultSessionId(options.agentId, agent, options.name, topic.message_thread_id),
    enabled: true,
    style: options.style ?? agent.branding?.style ?? null,
    avatar: options.avatar ?? agent.branding?.avatar ?? null,
    color,
    icon_custom_emoji_id: iconCustomEmojiId ?? null,
    owner: options.owner || ownerAliasForChat(config, options.chatId),
  };
  config.topics.push(entry);
  return entry;
}

function ownerAliasForChat(config, chatId) {
  return Object.entries(config.users?.aliases || {}).find(([, user]) => String(user.id) === String(chatId))?.[0] || null;
}

function defaultSessionId(agentId, agent, topicName, topicId) {
  if (topicName === (agent.name || agentId) && agent.session_id) return agent.session_id;
  return `${agentId}-${topicId}`;
}

function freshSessionId(topic) {
  return `${topic.agent}-${topic.topic_id}-${compactTimestamp()}`;
}

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function sessionFiles(config, sessionId) {
  if (!sessionId || !existsSync(config.project.sessions_dir)) return [];
  const suffix = `_${sessionId}.jsonl`;
  return readdirSync(config.project.sessions_dir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => {
      const path = join(config.project.sessions_dir, name);
      return { name, size: statSync(path).size };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function resolvePromptTopic(config, options) {
  if (options.topic && options.agent) throwCli("use either --topic or --agent, not both");
  if (options.topic) {
    const topic = findTopicByName(config, options.topic);
    if (!topic) throwCli(`unknown topic mapping: ${options.topic}`);
    return topic;
  }
  if (options.agent) {
    const matches = config.topics.filter((topic) => topic.agent === options.agent && topic.enabled !== false);
    if (!matches.length) throwCli(`no enabled topic mapping for agent: ${options.agent}`);
    if (matches.length > 1) {
      const names = matches.map((topic) => topic.name).join(", ");
      throwCli(`agent ${options.agent} has multiple enabled topics; use --topic. Matches: ${names}`);
    }
    return matches[0];
  }
  throwCli("missing --topic or --agent");
}

function promptText(options) {
  if (options.stdin && options.text) throwCli("use either --text or --stdin, not both");
  if (options.stdin) return readFileSync(0, "utf8");
  return options.text || "";
}

// Mirror the gateway's display_messages bridge for CLI prompts: stream
// assistant text and custom tool progress (edited in place) to the topic,
// instead of dumping everything at turn end.
function createCliDisplayBridge(config, telegram, topic, envelope) {
  const configured = topic.display_messages || config.agents?.[topic.agent]?.display_messages || config.telegram.display_messages;
  if (!configured) return null;
  const allowed = configured.map((value) => String(value).trim()).filter(Boolean);
  const isAllowed = (type) => allowed.includes(type) || allowed.includes(type.split("/")[0]);
  const toolMessages = new Map();
  let queue = Promise.resolve();
  let delivered = 0;

  const deliver = async (item) => {
    const existing = item.toolCallId ? toolMessages.get(item.toolCallId) : undefined;
    if (existing) {
      if (existing.text === item.text) return;
      existing.text = item.text;
      const converted = toTelegramMarkdownV2(item.text);
      const payload = {
        chatId: existing.chatId,
        messageId: existing.messageId,
        text: converted ?? item.text,
        parseMode: converted ? "MarkdownV2" : undefined,
      };
      try {
        await telegram.editMessageText(payload);
      } catch (error) {
        if (payload.parseMode && /parse entities|can't parse entities|reserved and must be escaped/i.test(error.message)) {
          await telegram.editMessageText({ ...payload, parseMode: undefined, text: item.text });
        } else {
          throw error;
        }
      }
      return;
    }
    const sent = await sendCliLongMessage(telegram, {
      chatId: topic.chat_id,
      topicId: topic.topic_id,
      replyToMessageId: envelope.messageId || undefined,
      text: item.text,
    });
    delivered += sent.length;
    const latest = sent.at(-1);
    if (item.toolCallId && latest?.message_id) {
      toolMessages.set(item.toolCallId, { chatId: String(topic.chat_id), messageId: String(latest.message_id), text: item.text });
    }
  };

  return {
    onEvent: (event) => {
      const item = cliDisplayItemFromEvent(event);
      if (!item || !isAllowed(item.type)) return;
      queue = queue
        .catch(() => undefined)
        .then(() => deliver(item))
        .catch((error) => console.error(`display message failed: ${error.message}`));
    },
    flush: () => queue.catch(() => undefined),
    deliveredCount: () => delivered,
  };
}

function cliDisplayItemFromEvent(event) {
  if (event?.type === "message_update" && event.assistantMessageEvent?.type === "text_end") {
    const text = String(event.assistantMessageEvent.content || "").trim();
    return text ? { type: "assistant/message", text } : null;
  }
  if (event?.type === "message_end" && event.message?.role === "custom" && event.message.display !== false) {
    const customType = String(event.message.customType || "message");
    const text = cliTextFromContent(event.message.content);
    return text ? { type: `custom/${customType}`, text: cliTitledText(event.message, text) } : null;
  }
  const result = event?.type === "tool_execution_update"
    ? event.partialResult
    : event?.type === "tool_execution_end" ? event.result : null;
  const customType = result?.details?.customType;
  if (customType) {
    const text = cliTextFromContent(result.content);
    return text
      ? { type: `custom/${customType}`, text: cliTitledText(result, text), toolCallId: event.toolCallId }
      : null;
  }
  return null;
}

// Same heuristic as the gateway: a tool result carrying Telegram message ids
// means the tool already delivered user-visible output.
function cliIsTelegramDeliveryEvent(event) {
  if (event?.type !== "tool_execution_end") return false;
  const details = event.result?.details;
  if (!details || typeof details !== "object") return false;
  if (details.message_id) return true;
  return Array.isArray(details.telegram_messages) && details.telegram_messages.some((entry) => entry?.messageId || entry?.message_id);
}

function cliTextFromContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && part.text) || "").filter(Boolean).join("\n").trim();
}

function cliTitledText(message, text) {
  const title = message?.details?.telepiTitle || message?.details?.title || message?.telepiTitle || "";
  return title ? `${title}\n${text}` : text;
}

async function sendCliLongMessage(telegram, message) {
  const chunks = splitCliMessage(message.text);
  const sentMessages = [];
  for (const [index, chunk] of chunks.entries()) {
    const converted = toTelegramMarkdownV2(chunk);
    const payload = {
      chatId: message.chatId,
      topicId: message.topicId,
      replyToMessageId: index === 0 ? message.replyToMessageId : undefined,
      text: converted ?? chunk,
      parseMode: converted ? "MarkdownV2" : undefined,
    };
    try {
      sentMessages.push(await telegram.sendMessage(payload));
    } catch (error) {
      if (payload.replyToMessageId && /reply|replied|message to be replied/i.test(error.message)) {
        sentMessages.push(await telegram.sendMessage({ ...payload, replyToMessageId: undefined }));
      } else if (payload.parseMode && /parse entities|can't parse entities|reserved and must be escaped/i.test(error.message)) {
        sentMessages.push(await telegram.sendMessage({ ...payload, parseMode: undefined, text: chunk }));
      } else {
        throw error;
      }
    }
  }
  return sentMessages;
}

function splitCliMessage(text, maxLength = 3900) {
  const value = String(text || "");
  if (value.length <= maxLength) return [value || " "];
  const chunks = [];
  let rest = value;
  while (rest.length > maxLength) {
    let index = rest.lastIndexOf("\n\n", maxLength);
    if (index < maxLength / 2) index = rest.lastIndexOf("\n", maxLength);
    if (index < maxLength / 2) index = rest.lastIndexOf(" ", maxLength);
    if (index < maxLength / 2) index = maxLength;
    chunks.push(rest.slice(0, index).trim());
    rest = rest.slice(index).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function throwCli(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}
