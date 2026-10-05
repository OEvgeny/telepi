import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync(new URL("../scripts/restart-gateway-when-idle.sh", import.meta.url), "utf8");

test("normal gateway restart drains the permanent Durable host before checking child PIDs", () => {
  assert.match(script, /\/src\/durable\/host\.js/);
  assert.match(script, /node bin\/telepi\.js gateway:drain/);
  assert.match(script, /Durable host drain failed; no restart attempted/);
  assert.match(script, /if \[\[ "\$FORCE" == true \]\]/);
});
