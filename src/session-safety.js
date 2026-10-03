export function isRpcPromptResponseTimeout(result) {
  return Boolean(
    result
    && !result.ok
    && result.code === 1
    && /Timeout waiting for response to prompt/i.test(result.stderr || ""),
  );
}

export function formatPreservedPromptTimeoutNotice(topicName, sessionId) {
  return [
    `⚠️ ${topicName} did not accept the prompt before the RPC deadline.`,
    "",
    `The existing downstream session (${sessionId}) was preserved. Telepi did not create a fresh session or retry your prompt automatically.`,
    "Send /retry to try the same prompt again, or explicitly unlink the session if you want a fresh conversation.",
  ].join("\n");
}

export function formatFreshSessionSwitchNotice({ topicName, previousSessionId, nextSessionId, reason }) {
  return [
    `⚠️ Downstream session changed for ${topicName}.`,
    "",
    "A fresh session is now active. It does not inherit the previous session's conversation context.",
    `Previous session: ${previousSessionId}`,
    `New session: ${nextSessionId}`,
    "The previous transcript is preserved and can be restored.",
    reason ? `Reason: ${reason}` : undefined,
  ].filter(Boolean).join("\n");
}

export function formatRestoredSessionSwitchNotice({ topicName, previousSessionId, nextSessionId }) {
  return [
    `↩️ Downstream session changed for ${topicName}.`,
    "",
    "A preserved session is now active. New turns use its saved conversation context.",
    `Previous active session: ${previousSessionId}`,
    `Restored session: ${nextSessionId}`,
    "The session replaced by this switch remains preserved.",
  ].join("\n");
}
