import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function botToken(): string {
	const envName = process.env.TELEPI_BOT_TOKEN ? "TELEPI_BOT_TOKEN" : "PI_TELEGRAM_BOT_TOKEN";
	const token = process.env[envName];
	if (!token) throw new Error("Telegram bot token not available in TELEPI_BOT_TOKEN or PI_TELEGRAM_BOT_TOKEN");
	return token;
}

async function telegramRequest(method: string, form: FormData): Promise<any> {
	const response = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
		method: "POST",
		body: form,
	});
	const body = await response.json().catch(() => null);
	if (!response.ok || !body?.ok) {
		const message = body?.description || `${response.status} ${response.statusText}`;
		throw new Error(`Telegram ${method} failed: ${message}`);
	}
	return body.result;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "telepi_send_image",
		label: "Telepi Send Image",
		description:
			"Send a local image file back to the current Telegram topic as a native photo. Use this when you created or found an image file that should be sent to the Telegram user.",
		promptSnippet:
			"Use telepi_send_image to send local image files to the current Telegram topic. Pass file_path and optional caption. Defaults to the current chat/topic.",
		parameters: Type.Object({
			file_path: Type.String({ description: "Absolute or entity-relative path to an image file: jpg, jpeg, png, webp, or gif." }),
			caption: Type.Optional(Type.String({ description: "Optional Telegram photo caption, truncated by Telegram around 1024 characters." })),
			chat_id: Type.Optional(Type.String({ description: "Override Telegram chat id. Defaults to current routed chat." })),
			topic_id: Type.Optional(Type.String({ description: "Override Telegram topic/message_thread_id. Defaults to current routed topic." })),
			reply_to_message_id: Type.Optional(Type.String({ description: "Optional Telegram message id to reply to. Defaults to current user message." })),
		}),
		async execute(_toolCallId, params) {
			const chatId = params.chat_id || process.env.TELEPI_CHAT_ID;
			const topicId = params.topic_id ?? process.env.TELEPI_TOPIC_ID;
			const replyTo = params.reply_to_message_id ?? process.env.TELEPI_MESSAGE_ID;
			if (!chatId) {
				return { content: [{ type: "text", text: "Failed: no Telegram chat id in tool params or TELEPI_CHAT_ID" }] };
			}
			if (!existsSync(params.file_path)) {
				return { content: [{ type: "text", text: `Failed: image file not found: ${params.file_path}` }] };
			}

			const file = await readFile(params.file_path);
			const form = new FormData();
			form.set("chat_id", chatId);
			if (topicId) form.set("message_thread_id", topicId);
			if (params.caption) form.set("caption", params.caption.slice(0, 1024));
			if (replyTo) form.set("reply_to_message_id", replyTo);
			form.set("photo", new Blob([file]), basename(params.file_path));

			try {
				const sent = await telegramRequest("sendPhoto", form);
				return {
					content: [{ type: "text", text: `Image sent to Telegram (message_id: ${sent.message_id})` }],
					details: {
						chat_id: String(chatId),
						topic_id: topicId ? String(topicId) : null,
						message_id: String(sent.message_id),
						file_path: params.file_path,
					},
				};
			} catch (error: any) {
				if (replyTo && /reply|replied|message to be replied/i.test(error?.message || "")) {
					const retry = new FormData();
					retry.set("chat_id", chatId);
					if (topicId) retry.set("message_thread_id", topicId);
					if (params.caption) retry.set("caption", params.caption.slice(0, 1024));
					retry.set("photo", new Blob([file]), basename(params.file_path));
					const sent = await telegramRequest("sendPhoto", retry);
					return { content: [{ type: "text", text: `Image sent to Telegram without reply target (message_id: ${sent.message_id})` }] };
				}
				return { content: [{ type: "text", text: `Failed: ${error?.message || error}` }] };
			}
		},
	});
}
