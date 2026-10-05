import assert from "node:assert/strict";
import test from "node:test";
import * as undici from "undici";

import {
  configurePiHttpDispatcher,
  parseHttpIdleTimeoutMs,
} from "../src/pi/http-dispatcher.js";

test("HTTP idle timeout parser accepts extended and disabled values", () => {
  assert.equal(parseHttpIdleTimeoutMs(900_000), 900_000);
  assert.equal(parseHttpIdleTimeoutMs("900000"), 900_000);
  assert.equal(parseHttpIdleTimeoutMs("disabled"), 0);
  assert.equal(parseHttpIdleTimeoutMs(-1), undefined);
  assert.equal(parseHttpIdleTimeoutMs("nope"), undefined);
});

test("Pi HTTP configuration installs the worker dispatcher", async (t) => {
  const originalDispatcher = undici.getGlobalDispatcher();
  const dispatcher = configurePiHttpDispatcher(900_000);
  t.after(async () => {
    undici.setGlobalDispatcher(originalDispatcher);
    await dispatcher.close();
  });

  assert.equal(undici.getGlobalDispatcher(), dispatcher);
  assert.throws(() => configurePiHttpDispatcher(-1), /Invalid HTTP idle timeout/);
});
