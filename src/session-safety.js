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
