import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = resolve(new URL("..", import.meta.url).pathname);

// The runtime resolves every configured resource path with resolvePath(), which
// keeps an absolute path as it is. Validation must use the same resolver, or an
// absolute skill/extension path is joined onto the project root and reported
// missing even though the gateway loads it.
test("validate accepts absolute skill and extension paths", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telepi-validate-paths-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const skillDir = join(directory, "shared-skills", "example");
  const extensionDir = join(directory, "shared-extensions");
  await mkdir(skillDir, { recursive: true });
  await mkdir(extensionDir, { recursive: true });
  await mkdir(join(directory, "config"), { recursive: true });
  const skill = join(skillDir, "SKILL.md");
  const extension = join(extensionDir, "example.ts");
  await writeFile(skill, "---\nname: example\ndescription: example\n---\n\n# Example\n");
  await writeFile(extension, "export default function example() {}\n");
  const configPath = join(directory, "config/telepi.yaml");
  await writeFile(configPath, [
    "version: 1",
    "project:",
    "  root: .",
    "  entities_dir: entities",
    "  sessions_dir: sessions",
    "  cache_dir: cache",
    "telegram:",
    "  allowed_user_ids: []",
    "agents:",
    "  helper:",
    "    name: Helper",
    `    entity_dir: ${join(directory, "entities/helper")}`,
    "    skills:",
    `      - ${skill}`,
    "    extensions:",
    `      - ${extension}`,
    "topics: []",
  ].join("\n"));

  const { stdout } = await execFileAsync(process.execPath, [
    join(root, "bin/telepi.js"),
    "-c", configPath,
    "validate",
  ], { cwd: root, encoding: "utf8" });

  assert.match(stdout, /^ok: 0 topic\(s\), 1 agent\(s\)$/m);
});
