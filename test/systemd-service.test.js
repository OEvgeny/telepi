import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const unit = readFileSync(new URL("../systemd/telepi-gateway.service", import.meta.url), "utf8");

test("gateway service has a boot-stable Node and pi environment", () => {
  assert.doesNotMatch(unit, /^Environment=TELEPI_PI_BIN=/m);
  assert.match(unit, /^Environment=PATH=%h\/\.nix-profile\/bin:.*%h\/\.local\/bin:.*%h\/\.npm\/bin:.*\/run\/current-system\/sw\/bin/m);
  assert.match(unit, /^ExecStart=%h\/\.nix-profile\/bin\/node src\/gateway\.js$/m);
  assert.doesNotMatch(unit, /^ExecStart=.*\/usr\/bin\/env\s+(?:node|npm)/m);
});

test("gateway service captures stderr and bounds the post-crash teardown", () => {
  // stderr carries every crash trace; the journal only shows systemd's exit line.
  assert.match(unit, /^StandardError=append:%h\/telepi\/\.telepi\/gateway\.log$/m);
  assert.match(unit, /^Restart=always$/m);
  // Default TimeoutStopSec=90 turned a 1s crash into a 90s outage.
  const timeout = unit.match(/^TimeoutStopSec=(\d+)$/m);
  assert.ok(timeout, "TimeoutStopSec must be explicit");
  assert.ok(Number(timeout[1]) > 0 && Number(timeout[1]) <= 30, `unexpected TimeoutStopSec=${timeout[1]}`);
});
