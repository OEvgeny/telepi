import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  formatFreshSessionSwitchNotice,
  formatRestoredSessionSwitchNotice,
} from "../src/session-safety.js";

test("gateway never unlinks or retries a session after an RPC prompt delay", async () => {
  const gateway = await readFile(new URL("../src/gateway.js", import.meta.url), "utf8");
  assert.doesNotMatch(gateway, /session:unlink|auto-rpc-timeout-retry|recovered rpc prompt timeout/i);
});

test("fresh and restored session switches explain their context boundary", () => {
  const fresh = formatFreshSessionSwitchNotice({
    topicName: "Example",
    previousSessionId: "old-session",
    nextSessionId: "new-session",
    reason: "explicit reset",
  });
  assert.match(fresh, /does not inherit the previous session's conversation context/i);
  assert.match(fresh, /previous transcript is preserved and can be restored/i);
  assert.match(fresh, /Previous session: old-session/);
  assert.match(fresh, /New session: new-session/);
  assert.match(fresh, /Reason: explicit reset/);

  const restored = formatRestoredSessionSwitchNotice({
    topicName: "Example",
    previousSessionId: "new-session",
    nextSessionId: "old-session",
  });
  assert.match(restored, /preserved session is now active/i);
  assert.match(restored, /New turns use its saved conversation context/i);
  assert.match(restored, /Restored session: old-session/);
});
