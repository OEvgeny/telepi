import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const unit = readFileSync(new URL("../systemd/telepi-gateway.service", import.meta.url), "utf8");

test("gateway service has a boot-stable Node and pi environment", () => {
  assert.match(unit, /^Environment=TELEPI_PI_BIN=%h\/\.npm\/bin\/pi$/m);
  assert.match(unit, /^Environment=PATH=.*%h\/\.nix-profile\/bin.*\/run\/current-system\/sw\/bin/m);
  assert.match(unit, /^ExecStart=%h\/\.nix-profile\/bin\/node src\/gateway\.js$/m);
  assert.doesNotMatch(unit, /^ExecStart=.*\/usr\/bin\/env\s+(?:node|npm)/m);
});
