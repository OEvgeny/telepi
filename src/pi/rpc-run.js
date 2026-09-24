import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

// Shared lifecycle for one native Pi RPC run. Process and transport ownership
// are supplied by the SDK driver's socket client.
export async function startRpcRun(args, {
  workerPath,
  cwd,
  idleTimeoutMs,
  hardTimeoutMs,
  env = {},
  onText,
  onEvent,
  initialMessage,
  steerMessage,
  sessionDir,
  sessionId,
  createRpcClient,
}) {
  // Capture the pre-prompt byte boundary. Pi persists messages before all RPC
  // lifecycle events have necessarily escaped the process, so the transcript
  // is the authoritative fallback when RPC wedges after writing a final answer.
  const transcriptCursor = createSessionTranscriptCursor(sessionDir, sessionId);
  if (typeof createRpcClient !== "function") throw new Error("RPC client factory is required");
  const client = createRpcClient({
    workerPath,
    cwd: resolve(cwd),
    env,
    args,
  });
  await client.start();

  let unsubscribe;
  let terminalSettleTimer;
  const controlTracker = createPendingControlTracker();
  const promise = new Promise((resolvePromise) => {
    const outputCollector = createAssistantOutputCollector();
    let streamedTextCount = 0;
    let textQueue = Promise.resolve();
    let textDeliveryError = "";
    let terminalTranscriptText = "";
    const deliveredTexts = new Set();
    let streamedAssistantParts = [];
    let initialUserMessageSeen = false;
    let settled = false;
    let idleTimer;
    let transcriptTimer;
    const timeoutRun = (message) => {
      if (settled) return;
      settled = true;
      cleanup();
      textQueue
        .catch(() => undefined)
        .then(() => client.stop())
        .finally(() => {
          resolvePromise({
            ok: false,
            code: null,
            stdout: outputCollector.text() || terminalTranscriptText,
            stderr: message,
            streamedTextCount,
          });
        });
    };
    const refreshIdleTimer = () => {
      if (!idleTimeoutMs || idleTimeoutMs <= 0) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timeoutRun(`Timed out after ${idleTimeoutMs}ms without pi events`);
      }, idleTimeoutMs);
    };
    refreshIdleTimer();
    const hardTimer = hardTimeoutMs > 0
      ? setTimeout(() => {
        timeoutRun(`Timed out after hard limit ${hardTimeoutMs}ms`);
      }, hardTimeoutMs)
      : undefined;

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      await textQueue;
      // Pi can emit agent_settled before the RPC response to the abort command
      // that caused it. Do not terminate the worker under an accepted control
      // request; let its correlated response reach RpcClient first.
      await controlTracker.wait();
      if (textDeliveryError) {
        result.stderr = `${result.stderr ? `${result.stderr}\n` : ""}Streaming text delivery failed: ${textDeliveryError}`;
      }
      await client.stop();
      resolvePromise(result);
    };

    const cleanup = () => {
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      clearTimeout(terminalSettleTimer);
      clearInterval(transcriptTimer);
      unsubscribe?.();
      unsubscribe = undefined;
    };

    const enqueueText = (text) => {
      const normalized = String(text || "").trim();
      if (!normalized || !onText || deliveredTexts.has(normalized)) return;
      deliveredTexts.add(normalized);
      streamedTextCount += 1;
      textQueue = textQueue
        .catch(() => undefined)
        .then(() => onText(normalized))
        .catch((error) => {
          textDeliveryError = error.message;
          console.error(`pi assistant text delivery failed: ${error.stack || error.message}`);
        });
    };

    // A completed final assistant message should be followed immediately by
    // agent_end/agent_settled. If pi wedges after persisting that answer, allow
    // a grace period and then close only that completed lifecycle—not an
    // actively reasoning/tool-using turn. Gateway-owned steers not confirmed by
    // a transcript user message are replayed after this run closes.
    const scheduleTerminalSettle = () => {
      clearTimeout(terminalSettleTimer);
      if (settled) return;
      terminalSettleTimer = setTimeout(() => {
        console.error("pi emitted a terminal assistant message but did not settle; closing completed run");
        void finish({
          ok: true,
          code: 0,
          stdout: outputCollector.text() || terminalTranscriptText,
          stderr: client.getStderr().trim(),
          streamedTextCount,
        });
      }, 60_000);
    };

    const pollTranscript = () => {
      const update = summarizeTranscriptLifecycle(readSessionTranscriptEntries(transcriptCursor));
      for (const finalText of update.finalTexts) {
        terminalTranscriptText = finalText;
        enqueueText(finalText);
      }
      // The newest persisted message owns the fallback timer. In particular, a
      // steered user message can follow a terminal answer in the same read.
      if (update.settleAction === "schedule") scheduleTerminalSettle();
      if (update.settleAction === "clear") clearTimeout(terminalSettleTimer);
    };
    transcriptTimer = setInterval(pollTranscript, 500);
    transcriptTimer.unref?.();
    pollTranscript();

    unsubscribe = client.onEvent((event) => {
      refreshIdleTimer();
      onEvent?.(event);

      if (event.type === "message_start" && event.message?.role === "assistant") {
        streamedAssistantParts = [];
      }
      if (event.type === "message_start" && event.message?.role === "user") {
        if (initialUserMessageSeen) {
          clearTimeout(terminalSettleTimer);
        } else {
          initialUserMessageSeen = true;
        }
      }

      const streamedText = outputCollector.consume(event);
      if (streamedText) {
        streamedAssistantParts.push(streamedText);
        // Do NOT stream intermediate assistant text here: every completed
        // text_end (including working narration between tool calls) would
        // become a separate Telegram message, flooding the chat on multi-
        // step turns. The final answer is delivered by the message_end
        // fallback below (final text that differs from the accumulated parts)
        // and by pollTranscript (stopReason "stop" only).
      }

      // Some provider/transport paths persist message_end without emitting a
      // usable text_end delta. Deliver the finalized assistant text as a
      // fallback, but ONLY for the terminal message (stopReason "stop"):
      // intermediate tool-calling turns carry working narration that must
      // never reach the chat as its own message. The accumulated parts (from
      // text_end deltas) and the message content agree for the final answer;
      // enqueue whichever is non-empty so the live path is prompt and the
      // transcript-poll path (below) is the authoritative fallback.
      if (event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "stop") {
        const finalText = textFromPiContent(event.message.content).trim();
        const streamedTextCombined = streamedAssistantParts.join("\n\n").trim();
        const delivered = streamedTextCombined || finalText;
        if (delivered) enqueueText(delivered);
        scheduleTerminalSettle();
      }

      // agent_end is only a low-level boundary and may still be followed by
      // queued steering/follow-up work. agent_settled is the true completion.
      if (event.type === "agent_settled") {
        void finish({
          ok: true,
          code: 0,
          stdout: outputCollector.text() || terminalTranscriptText,
          stderr: client.getStderr().trim(),
          streamedTextCount,
        });
      }
    });

    client.prompt(initialMessage).catch((error) => {
      void finish({
        ok: false,
        code: 1,
        stdout: outputCollector.text() || terminalTranscriptText,
        stderr: `${error.message}${client.getStderr() ? `\n${client.getStderr().trim()}` : ""}`.trim(),
        streamedTextCount,
      });
    });
  });

  return {
    promise,
    abort: () => controlTracker.track(() => client.abort()),
    steer: (envelope) => controlTracker.track(() => client.steer(steerMessage(envelope))),
  };
}

function createSessionTranscriptCursor(sessionDir, sessionId) {
  const path = findSessionTranscriptFile(sessionDir, sessionId);
  return {
    sessionDir,
    sessionId: String(sessionId || ""),
    path,
    offset: path ? statSync(path).size : 0,
    pending: Buffer.alloc(0),
  };
}

function findSessionTranscriptFile(sessionDir, sessionId) {
  if (!sessionDir || !sessionId) return null;
  try {
    const candidates = readdirSync(sessionDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => resolve(sessionDir, name))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    for (const path of candidates) {
      const fd = openSync(path, "r");
      try {
        const buffer = Buffer.alloc(4096);
        const length = readSync(fd, buffer, 0, buffer.length, 0);
        const newline = buffer.indexOf(0x0a, 0);
        const header = parseJsonLine(buffer.subarray(0, newline >= 0 ? newline : length).toString("utf8"));
        if (header?.type === "session" && String(header.id) === String(sessionId)) return path;
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    return null;
  }
  return null;
}

function readSessionTranscriptEntries(cursor) {
  try {
    if (!cursor.path) {
      cursor.path = findSessionTranscriptFile(cursor.sessionDir, cursor.sessionId);
      if (!cursor.path) return [];
      cursor.offset = 0;
    }
    const size = statSync(cursor.path).size;
    if (size <= cursor.offset) return [];
    const buffer = Buffer.alloc(size - cursor.offset);
    const fd = openSync(cursor.path, "r");
    let length = 0;
    try {
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, cursor.offset + length);
        if (!count) break;
        length += count;
      }
    } finally {
      closeSync(fd);
    }
    cursor.offset += length;
    let unread = Buffer.concat([cursor.pending, buffer.subarray(0, length)]);
    const entries = [];
    let newline;
    while ((newline = unread.indexOf(0x0a)) >= 0) {
      const line = unread.subarray(0, newline).toString("utf8");
      unread = unread.subarray(newline + 1);
      const entry = parseJsonLine(line);
      if (entry) entries.push(entry);
    }
    cursor.pending = Buffer.from(unread);
    return entries;
  } catch {
    return [];
  }
}

export function createPendingControlTracker() {
  const pending = new Set();
  return {
    track(operation) {
      const promise = Promise.resolve().then(operation);
      const settled = promise.then(() => undefined, () => undefined);
      pending.add(settled);
      settled.then(() => pending.delete(settled));
      return promise;
    },
    async wait() {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}

export function summarizeTranscriptLifecycle(entries) {
  const finalTexts = [];
  let settleAction = "none";
  for (const entry of entries || []) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role === "assistant" && message.stopReason === "stop") {
      const finalText = textFromPiContent(message.content).trim();
      if (finalText) {
        finalTexts.push(finalText);
        settleAction = "schedule";
        continue;
      }
    }
    // Any later persisted message means an older terminal assistant is no
    // longer the active lifecycle. This includes steered users, tool work, and
    // non-text terminal messages.
    settleAction = "clear";
  }
  return { finalTexts, settleAction };
}

function textFromPiContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text || ""))
    .join("\n\n");
}

// RPC events repeat growing partial messages and may end with the complete
// transcript in agent_end. Retaining their serialized JSON makes memory usage
// quadratic on long/tool-heavy turns. Keep only finalized assistant text—the
// sole part used as the run's stdout fallback.
export function createAssistantOutputCollector() {
  const chunks = [];
  return {
    consume(event) {
      if (event?.type !== "message_update") return "";
      const messageEvent = event.assistantMessageEvent;
      if (messageEvent?.type !== "text_end") return "";
      const text = String(messageEvent.content || "").trim();
      if (text) chunks.push(text);
      return text;
    },
    text() {
      return chunks.join("\n\n").trim();
    },
  };
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
