import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
	BACKGROUND_JOB_MAX_WAIT_SECONDS,
	backgroundJobToolResult,
	runBackgroundJob,
} from "../src/background-job.js";
import { BROKER_PROTOCOL_VERSION, requestBroker } from "../src/broker-ipc.js";

type ButtonInput = string | { label: string; data?: string; url?: string };
type Button = { label: string; data?: string; url?: string };

const TELEGRAM_MIN_INTERVAL_MS = 1000;
const MAX_TELEGRAM_RATE_LIMIT_RETRY_MS = 5000;
let telegramRequestQueue: Promise<unknown> = Promise.resolve();
let nextTelegramRequestAt = 0;

function botToken(): string {
	const envName = process.env.TELEPI_BOT_TOKEN ? "TELEPI_BOT_TOKEN" : "PI_TELEGRAM_BOT_TOKEN";
	const token = process.env[envName];
	if (!token) throw new Error("Telegram bot token not available in TELEPI_BOT_TOKEN or PI_TELEGRAM_BOT_TOKEN");
	return token;
}

function buttonStorePath(): string {
	return resolve(process.env.TELEPI_BUTTON_STORE || ".telepi/cache/button-callbacks.jsonl");
}

async function telegramRequest(method: string, body: FormData | unknown): Promise<any> {
	const scheduled = telegramRequestQueue.then(async () => {
		const waitMs = Math.max(0, nextTelegramRequestAt - Date.now());
		if (waitMs > 0) await sleep(waitMs);
		nextTelegramRequestAt = Date.now() + TELEGRAM_MIN_INTERVAL_MS;
		return telegramRequestWithRetry(method, body);
	});
	telegramRequestQueue = scheduled.catch(() => undefined);
	return scheduled;
}

async function telegramRequestWithRetry(method: string, body: FormData | unknown): Promise<any> {
	try {
		return await performTelegramRequest(method, body);
	} catch (error: any) {
		const delayMs = telegramRateLimitDelayMs(error);
		if (delayMs == null || delayMs > MAX_TELEGRAM_RATE_LIMIT_RETRY_MS) throw error;
		await sleep(delayMs);
		nextTelegramRequestAt = Date.now() + TELEGRAM_MIN_INTERVAL_MS;
		return performTelegramRequest(method, body);
	}
}

async function performTelegramRequest(method: string, body: FormData | unknown): Promise<any> {
	const isForm = body instanceof FormData;
	const response = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
		method: "POST",
		headers: isForm ? undefined : { "content-type": "application/json" },
		body: isForm ? body : JSON.stringify(body),
	});
	const result = await response.json().catch(() => null);
	if (!response.ok || !result?.ok) {
		const message = result?.description || `${response.status} ${response.statusText}`;
		const error = new Error(`Telegram ${method} failed: ${message}`) as Error & { retryAfterSeconds?: number };
		if (result?.parameters?.retry_after != null) error.retryAfterSeconds = Number(result.parameters.retry_after);
		throw error;
	}
	return result.result;
}

function telegramRateLimitDelayMs(error: any): number | null {
	if (!/Too Many Requests|retry after/i.test(error?.message || "")) return null;
	const seconds = Number(error.retryAfterSeconds ?? error.message.match(/retry after (\d+)/i)?.[1] ?? 1);
	return Math.max(1, seconds) * 1000;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
		name: "telepi_run_command",
		label: "Telepi Run Command",
		description:
			`Run a non-interactive shell command as a detached job in the current workspace. The tool waits up to ${BACKGROUND_JOB_MAX_WAIT_SECONDS} seconds, then returns while the command continues. Complete output is written to a persistent path that can be inspected with read in a later turn.`,
		promptSnippet: "Run a potentially long command as a detached job with persistent output",
		promptGuidelines: [
			"Use telepi_run_command instead of bash for non-interactive commands likely to run longer than a few minutes or that must survive the current turn.",
			`It waits at most ${BACKGROUND_JOB_MAX_WAIT_SECONDS} seconds, then returns an output path while the command continues; inspect that path with read later.`,
			"Do not use telepi_run_command for interactive commands or commands that should be cancelled when the current turn stops.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run in the current workspace." }),
			wait_seconds: Type.Optional(Type.Integer({
				minimum: 0,
				maximum: BACKGROUND_JOB_MAX_WAIT_SECONDS,
				description: `Seconds to wait before returning. Defaults to ${BACKGROUND_JOB_MAX_WAIT_SECONDS}; use 0 to return immediately.`,
			})),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const env = new NodeExecutionEnv({ cwd: ctx.cwd });
				const context = {
					abortSignal: signal,
					value: () => undefined,
					toString: () => "telepi-run-command",
				};
				const job = await runBackgroundJob(env, {
					command: params.command,
					waitSeconds: params.wait_seconds,
					cwd: ctx.cwd,
				}, context);
				return backgroundJobToolResult(job);
			} catch (error: any) {
				const message = error?.message || String(error);
				return { content: [{ type: "text", text: `Failed: ${message}` }], isError: true, details: { error: message } };
			}
		},
	});

	pi.registerTool({
		name: "telepi_get_message",
		label: "Telepi Get Message",
		description:
			"Fetch the text or caption of a Telegram message by its numeric message identifier from Telepi's local recent-message archive. Use this when Telegram reply context contains `reply_to_message_id` but no `reply_to_text`, or when the user asks what a referenced message said. Lookup is restricted to the current topic. Telegram's Bot API cannot retrieve arbitrary uncached messages, so old messages may be unavailable.",
		promptSnippet: "Fetch locally archived Telegram message text by message id in the current topic",
		promptGuidelines: [
			"Use telepi_get_message when a Telegram reply provides reply_to_message_id without reply_to_text and the referenced text matters to the request.",
			"Pass only the numeric Telegram message id. The tool cannot read another topic and may not have messages older than Telepi's local archive.",
		],
		parameters: Type.Object({
			message_id: Type.String({ description: "Numeric Telegram message identifier, such as the value of reply_to_message_id." }),
		}),
		async execute(toolCallId, params, signal) {
			const socketPath = process.env.TELEPI_BROKER_SOCKET;
			if (!socketPath) throw new Error("TELEPI_BROKER_SOCKET is not configured for this session");
			const request = {
				version: BROKER_PROTOCOL_VERSION,
				type: "telegram_message_get",
				id: `${process.env.TELEPI_AGENT_ID || "unknown-agent"}:${toolCallId}`,
				messageId: params.message_id,
				chatId: process.env.TELEPI_CHAT_ID || "",
				topicId: process.env.TELEPI_TOPIC_ID || null,
				agentId: process.env.TELEPI_AGENT_ID || "",
				topicName: process.env.TELEPI_TOPIC_NAME || "",
			};
			const result = await requestBroker(socketPath, request, { signal });
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
		},
	});

	pi.registerTool({
		name: "telepi_send_message",
		label: "Telepi Send Message",
		description:
			"Send a one-way text message through the local broker. Set `to` to the exact mapped topic name to reach that topic's specific session; this mapping name is the session's routable alias. An agent id works only when that agent has exactly one enabled topic. Raw session ids are not routable. This does not post the incoming text to Telegram and must not target the current topic or agent. The broker starts an idle target, steers a running target, or queues the message at a safe boundary.",
		promptSnippet:
			"Send a message to another Telepi session by its exact topic mapping name, or to an agent with only one enabled topic",
		promptGuidelines: [
			"Use telepi_send_message when the user asks you to contact or wake another Telepi agent or one of its sessions.",
			"When an agent has multiple topics or sessions, address the desired session by its exact topic mapping name. The mapping name is its routable alias; do not use a raw session id or an ambiguous agent id.",
			"Never use telepi_send_message to notify the user or target your current topic/agent; normal assistant text is delivered to the current Telegram topic.",
			"telepi_send_message only confirms broker acceptance; it does not wait for the recipient's reply.",
		],
		parameters: Type.Object({
			to: Type.String({ description: "Exact topic mapping name (the route alias for a specific session), or an agent id only when it has exactly one enabled topic. Do not pass a raw session id." }),
			message: Type.String({ description: "Text to deliver to the target session." }),
		}),
		async execute(toolCallId, params, signal) {
			const socketPath = process.env.TELEPI_BROKER_SOCKET;
			if (!socketPath) throw new Error("TELEPI_BROKER_SOCKET is not configured for this session");
			const agentId = process.env.TELEPI_AGENT_ID || "unknown-agent";
			const topicName = process.env.TELEPI_TOPIC_NAME || "";
			const target = params.to.trim();
			if (target === topicName || target === agentId) {
				throw new Error(
					"telepi_send_message cannot target the current topic or agent; reply normally to post text in the current Telegram topic",
				);
			}
			const result = await requestBroker(socketPath, {
				version: BROKER_PROTOCOL_VERSION,
				type: "submit",
				id: `${agentId}:${toolCallId}`,
				target: { name: target },
				message: { text: params.message },
				origin: {
					kind: "agent",
					name: topicName || agentId,
					agentId,
					topicName: topicName || undefined,
					source: `agent:${agentId}`,
				},
				options: { echo: false },
			}, { signal });
			return {
				content: [{
					type: "text",
					text: `Message accepted for ${result.topic} (${result.agent}); status: ${result.status}.`,
				}],
				details: result,
			};
		},
	});

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
			const buildForm = (withReply: boolean) => {
				const form = new FormData();
				form.set("chat_id", chatId);
				if (topicId) form.set("message_thread_id", topicId);
				if (params.caption) form.set("caption", params.caption.slice(0, 1024));
				if (withReply && replyTo) form.set("reply_to_message_id", replyTo);
				form.set("photo", new Blob([file]), basename(params.file_path));
				return form;
			};

			try {
				let sent;
				try {
					sent = await telegramRequest("sendPhoto", buildForm(true));
				} catch (error: any) {
					if (replyTo && /reply|replied|message to be replied/i.test(error?.message || "")) {
						sent = await telegramRequest("sendPhoto", buildForm(false));
					} else {
						throw error;
					}
				}
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
				return { content: [{ type: "text", text: `Failed: ${error?.message || error}` }] };
			}
		},
	});

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

				const sent = await telegramRequest("sendMessage", payload);

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
