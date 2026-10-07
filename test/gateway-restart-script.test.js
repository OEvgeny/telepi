import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync(new URL("../scripts/restart-gateway-when-idle.sh", import.meta.url), "utf8");

test("normal gateway restart keeps Durable available until other gateway work drains", () => {
  assert.match(script, /\/src\/durable\/host\.js/);
  assert.match(script, /non_durable_workers/);
  assert.match(script, /-n "\$durable_workers" && -z "\$non_durable_workers"/);
  assert.match(script, /node bin\/telepi\.js gateway:drain/);
  assert.match(script, /Durable host drain failed; no restart attempted/);
  assert.match(script, /cmdline=.*\/proc\/\$pid\/cmdline.*\|\| true/);
  assert.match(script, /if \[\[ "\$FORCE" == true \]\]/);
});
