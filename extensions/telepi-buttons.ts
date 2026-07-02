import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ButtonInput = string | { label: string; data?: string; url?: string };
type Button = { label: string; data?: string; url?: string };

function botToken(): string {
	const envName = process.env.TELEPI_BOT_TOKEN ? "TELEPI_BOT_TOKEN" : "PI_TELEGRAM_BOT_TOKEN";
	const token = process.env[envName];
	if (!token) throw new Error("Telegram bot token not available in TELEPI_BOT_TOKEN or PI_TELEGRAM_BOT_TOKEN");
	return token;
}

function buttonStorePath(): string {
	return resolve(process.env.TELEPI_BUTTON_STORE || ".telepi/cache/button-callbacks.jsonl");
}

async function telegramJsonRequest(method: string, payload: unknown): Promise<any> {
	const response = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
	const body = await response.json().catch(() => null);
	if (!response.ok || !body?.ok) {
		const message = body?.description || `${response.status} ${response.statusText}`;
		throw new Error(`Telegram ${method} failed: ${message}`);
	}
	return body.result;
}

function normalizeButtons(input: ButtonInput[] | undefined): Button[] {
	if (!Array.isArray(input) || input.length === 0) throw new Error("buttons must be a non-empty array");
	if (input.length > 24) throw new Error("buttons may contain at most 24 entries");
	return input.map((entry, index) => {
		const button = typeof entry === "string" ? { label: entry } : entry;
		const label = String(button?.label || "").trim();
		if (!label) throw new Error(`button ${index + 1} is missing label`);
		if (label.length > 64) throw new Error(`button ${index + 1} label is too long (max 64 chars)`);
		const url = button.url ? String(button.url).trim() : "";
		if (url && !/^https?:\/\//i.test(url)) throw new Error(`button ${index + 1} url must start with http:// or https://`);
		const data = button.data == null ? undefined : String(button.data);
		if (data && data.length > 2000) throw new Error(`button ${index + 1} data is too long (max 2000 chars)`);
		if (url && data) throw new Error(`button ${index + 1} must use either url or data, not both`);
		return url ? { label, url } : { label, data };
	});
}

// Pack buttons into rows: short labels share a row (up to 3), long ones get
// their own so labels don't get truncated by Telegram's per-row width.
function layoutRows(buttons: Button[]): Button[][] {
	const rows: Button[][] = [];
	let row: Button[] = [];
	let rowChars = 0;
	for (const button of buttons) {
		const fits = row.length < 3 && rowChars + button.label.length <= 24;
		if (row.length && !fits) {
			rows.push(row);
			row = [];
			rowChars = 0;
		}
		row.push(button);
		rowChars += button.label.length;
	}
	if (row.length) rows.push(row);
	return rows;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "telepi_buttons",
		label: "Telepi Buttons",
		description:
			"Ask the Telegram user to choose between options via tappable inline buttons. The tapped choice is routed back to this session as the user's reply.",
		promptSnippet:
			"Use telepi_buttons when the user should pick from a few concrete options (approve/deny, variant selection, retries). Pass a question as text and a flat list of buttons — plain strings, or {label, data} when the routed-back payload should differ from the label, or {label, url} for link buttons. The tapped label (or its data) comes back as a normal user reply; the keyboard is removed after one tap.",
		parameters: Type.Object({
			text: Type.String({ description: "The question or prompt shown above the buttons." }),
			buttons: Type.Array(
				Type.Union([
					Type.String({ description: "Button label; also the text routed back when tapped." }),
					Type.Object({
						label: Type.String({ description: "Button label shown in Telegram." }),
						data: Type.Optional(Type.String({ description: "Payload routed back instead of the label when tapped." })),
						url: Type.Optional(Type.String({ description: "Makes this a link button; opens in Telegram, nothing is routed back." })),
					}),
				]),
				{ description: "Flat list of up to 24 buttons; rows are laid out automatically." },
			),
			chat_id: Type.Optional(Type.String({ description: "Override Telegram chat id. Defaults to current routed chat." })),
			topic_id: Type.Optional(Type.String({ description: "Override Telegram topic/message_thread_id. Defaults to current routed topic." })),
		}),
		async execute(_toolCallId, params) {
			const chatId = params.chat_id || process.env.TELEPI_CHAT_ID;
			const topicId = params.topic_id ?? process.env.TELEPI_TOPIC_ID;
			if (!chatId) {
				return { content: [{ type: "text", text: "Failed: no Telegram chat id in tool params or TELEPI_CHAT_ID" }] };
			}

			try {
				const buttons = normalizeButtons(params.buttons);
				const messageToken = randomBytes(9).toString("base64url");
				const inlineKeyboard = layoutRows(buttons).map((row) => row.map((button) =>
					button.url
						? { text: button.label, url: button.url }
						: { text: button.label, callback_data: `telepi:btn:${messageToken}:${buttons.indexOf(button)}` },
				));

				const payload: any = {
					chat_id: chatId,
					text: String(params.text).slice(0, 4096),
					disable_web_page_preview: true,
					reply_markup: { inline_keyboard: inlineKeyboard },
				};
				if (topicId) payload.message_thread_id = topicId;

				const sent = await telegramJsonRequest("sendMessage", payload);

				const path = buttonStorePath();
				await mkdir(dirname(path), { recursive: true });
				const record = {
					token: messageToken,
					chat_id: String(chatId),
					topic_id: topicId ? String(topicId) : null,
					agent_id: process.env.TELEPI_AGENT_ID || null,
					topic_name: process.env.TELEPI_TOPIC_NAME || null,
					message_id: String(sent.message_id),
					buttons: buttons.map((button) => ({ label: button.label, data: button.data ?? null })),
					created_at: new Date().toISOString(),
				};
				await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");

				return {
					content: [{ type: "text", text: `Buttons sent to Telegram (message_id: ${sent.message_id}). The user's tap will arrive as their next reply.` }],
					details: {
						chat_id: String(chatId),
						topic_id: topicId ? String(topicId) : null,
						message_id: String(sent.message_id),
						buttons: buttons.length,
					},
				};
			} catch (error: any) {
				return { content: [{ type: "text", text: `Failed: ${error?.message || error}` }] };
			}
		},
	});
}
