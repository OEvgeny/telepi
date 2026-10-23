import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function createDurableTelegramExtension(gatewayRequest, metadataDoc) {
  const metadata = (api, context) => api.snapshot(metadataDoc, api.conversationId, context);
  return defineExtension({
    name: "telepi-telegram",
    tools: [
      defineTool({
        name: "telepi_get_message",
        label: "Telepi Get Message",
        description: "Fetch the text or caption of a Telegram message by its numeric message identifier from Telepi's local recent-message archive. Use this when reply context has reply_to_message_id but no reply_to_text, or when the user asks what a referenced message said. Lookup is restricted to the current topic; arbitrary uncached messages cannot be fetched from Telegram's Bot API.",
        promptSnippet: "Fetch locally archived Telegram message text by message id in the current topic",
        promptGuidelines: [
          "Use telepi_get_message when reply_to_message_id is present without reply_to_text and the referenced text matters.",
          "The tool is limited to the current topic and may not have old uncached messages.",
        ],
        parameters: Type.Object({
          message_id: Type.String(),
        }),
        replay: "safe",
        executionMode: "sequential",
        execute: async (params, api, context) => {
          try {
            const current = await metadata(api, context);
            const result = await gatewayRequest("telegram.getMessage", {
              requestId: `${api.conversationId}:${api.callId}`,
              messageId: params.message_id,
              chatId: current.chatId,
              topicId: current.topicId,
              agentId: current.agentId,
              topicName: current.topicName,
            }, context);
            return messageLookupResult(result);
          } catch (error) {
            return failed(error);
          }
        },
      }),
      defineTool({
        name: "telepi_send_message",
        label: "Telepi Send Message",
        description: "Send a one-way text message through the local broker. Set `to` to the exact mapped topic name to reach that topic's specific session; an agent id works only when uniquely mapped. Raw session ids are not routable. This does not echo the incoming text to Telegram and must not target the current topic or agent.",
        promptSnippet: "Send a message to another Telepi session by exact topic alias, or to a uniquely mapped agent",
        promptGuidelines: [
          "Use telepi_send_message when the user asks you to contact or wake another Telepi agent or one of its sessions.",
          "Use an exact topic mapping name when an agent has multiple sessions. Never use a raw session id.",
          "Never target the current topic or agent; reply normally to post in the current Telegram topic.",
          "The tool confirms broker acceptance but does not wait for the recipient's reply.",
        ],
        parameters: Type.Object({
          to: Type.String(),
          message: Type.String(),
        }),
        replay: "unsafe",
        executionMode: "sequential",
        execute: async (params, api, context) => {
          try {
            const current = await metadata(api, context);
            const result = await gatewayRequest("telegram.sendMessage", {
              requestId: `${api.conversationId}:${api.callId}`,
              to: params.to,
              message: params.message,
              currentAgentId: current.agentId,
              currentTopicName: current.topicName,
            }, context);
            return {
              content: [{ type: "text", text: `Message accepted for ${result.topic} (${result.agent}); status: ${result.status}.` }],
              details: result,
            };
          } catch (error) {
            return failed(error);
          }
        },
      }),
      defineTool({
        name: "telepi_send_image",
        label: "Telepi Send Image",
        description: "Send an image file from the selected execution environment back to the current Telegram topic as a native photo.",
        promptSnippet: "Send image files from the current workspace to the current Telegram topic",
        parameters: Type.Object({
          file_path: Type.String(),
          caption: Type.Optional(Type.String()),
          chat_id: Type.Optional(Type.String()),
          topic_id: Type.Optional(Type.String()),
          reply_to_message_id: Type.Optional(Type.String()),
        }),
        replay: "unsafe",
        executionMode: "sequential",
        execute: async (params, api, context) => {
          try {
            if (!api.env) throw new Error("No execution environment is available");
            const current = await metadata(api, context);
            const bytes = await readRemoteFile(api.env, params.file_path, context);
            const result = await gatewayRequest("telegram.sendImage", {
              requestId: `${api.conversationId}:${api.callId}`,
              fileName: remoteBaseName(params.file_path),
              dataBase64: Buffer.from(bytes).toString("base64"),
              caption: params.caption,
              chatId: params.chat_id || current.chatId,
              topicId: params.topic_id ?? current.topicId,
              replyToMessageId: params.reply_to_message_id,
            }, context);
            return {
              content: [{ type: "text", text: `Image sent to Telegram (message_id: ${result.messageId})` }],
              details: result,
            };
          } catch (error) {
            return failed(error);
          }
        },
      }),
      defineTool({
        name: "telepi_buttons",
        label: "Telepi Buttons",
        description: "Ask the Telegram user to choose between options via tappable inline buttons. The tapped choice is routed back to this session as the user's reply.",
        promptSnippet: "Ask the Telegram user to pick from a few concrete options using inline buttons",
        parameters: Type.Object({
          text: Type.String(),
          buttons: Type.Array(Type.Union([
            Type.String(),
            Type.Object({
              label: Type.String(),
              data: Type.Optional(Type.String()),
              url: Type.Optional(Type.String()),
            }),
          ])),
          chat_id: Type.Optional(Type.String()),
          topic_id: Type.Optional(Type.String()),
        }),
        replay: "unsafe",
        executionMode: "sequential",
        execute: async (params, api, context) => {
          try {
            const current = await metadata(api, context);
            const result = await gatewayRequest("telegram.sendButtons", {
              requestId: `${api.conversationId}:${api.callId}`,
              text: params.text,
              buttons: params.buttons,
              chatId: params.chat_id || current.chatId,
              topicId: params.topic_id ?? current.topicId,
              agentId: current.agentId,
              topicName: current.topicName,
            }, context);
            return {
              content: [{ type: "text", text: `Buttons sent to Telegram (message_id: ${result.messageId}). The user's tap will arrive as their next reply.` }],
              details: result,
            };
          } catch (error) {
            return failed(error);
          }
        },
      }),
    ],
  });
}

async function readRemoteFile(env, path, context) {
  const opened = await env.openBinaryReader(path, undefined, context);
  if (!opened.ok) throw opened.error;
  const reader = opened.value;
  try {
    const info = await reader.info(context);
    if (!info.ok) throw info.error;
    if (info.value.size > MAX_IMAGE_BYTES) throw new Error(`Image is too large (${info.value.size} bytes; max ${MAX_IMAGE_BYTES})`);
    const read = await reader.read(0, MAX_IMAGE_BYTES + 1, context);
    if (!read.ok) throw read.error;
    if (read.value.length > MAX_IMAGE_BYTES) throw new Error(`Image is too large (max ${MAX_IMAGE_BYTES} bytes)`);
    return read.value;
  } finally {
    await reader.close(context);
  }
}

function remoteBaseName(path) {
  return String(path).split(/[\\/]/).filter(Boolean).at(-1) || "photo.jpg";
}

function messageLookupResult(result) {
  if (!result.found) {
    return {
      content: [{ type: "text", text: `Telegram message ${result.messageId} is not in Telepi's local archive. ${result.limitation}` }],
      details: result,
    };
  }
  const author = result.agentId || result.userName || result.direction || "unknown author";
  const text = result.text || "[The archived message has no text or caption.]";
  const suffix = result.textTruncated ? "\n\n[Archived text was truncated.]" : "";
  return {
    content: [{ type: "text", text: `Telegram message ${result.messageId} from ${author}:\n\n${text}${suffix}` }],
    details: result,
  };
}

function failed(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `Failed: ${message}` }], isError: true, details: { error: message } };
}
