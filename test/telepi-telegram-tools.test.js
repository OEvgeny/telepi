import assert from "node:assert/strict";
import test from "node:test";

import registerTelepiTelegram from "../extensions/telepi-telegram.ts";

test("Telegram extension tells agents to fetch missing reply text by message id", () => {
  const tools = [];
  registerTelepiTelegram({ registerTool(tool) { tools.push(tool); } });

  const lookup = tools.find((tool) => tool.name === "telepi_get_message");
  assert.ok(lookup);
  assert.match(lookup.description, /reply_to_message_id/);
  assert.match(lookup.description, /no `reply_to_text`/);
  assert.match(lookup.description, /current topic/);
  assert.match(lookup.description, /uncached messages/);
});
