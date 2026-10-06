import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

const PROJECT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];
const MAX_SKILL_DEPTH = 12;
const MAX_SKILL_ENTRIES = 2_000;

export function loadLocalAgentContext(agentDir) {
  const files = [];
  for (const name of PROJECT_INSTRUCTION_FILES) {
    const path = join(agentDir, name);
    if (existsSync(path)) files.push({ path, content: readFileSync(path, "utf8") });
  }
  return files;
}

export async function loadRemoteProjectContextFiles(env, context) {
  return loadProjectContextFromEnv(env, env.cwd, context);
}

export async function loadProjectContextFromEnv(env, cwd, context) {
  const directories = await ancestorDirectories(env, cwd, context);
  const files = [];
  for (const directory of directories.reverse()) {
    for (const name of PROJECT_INSTRUCTION_FILES) {
      const candidate = await joinEnvPath(env, [directory, name], context);
      const content = await readOptionalText(env, candidate, context);
      if (content != null) files.push({ path: candidate, content });
    }
  }
  return files;
}

// Pi's default project skill location is <cwd>/.pi/skills. Stable agent skills
// are loaded locally by Telepi; this loader adds workspace-owned skills through
// the selected ExecutionEnv so their paths are valid to Durable's read tool.
export async function loadProjectSkillsFromEnv(env, cwd, context) {
  const root = await joinEnvPath(env, [cwd, ".pi", "skills"], context);
  const skills = [];
  const diagnostics = [];
  const state = { entries: 0 };
  await scanSkillDirectory(env, root, true, 0, skills, diagnostics, state, context);
  return { skills, diagnostics };
}

async function scanSkillDirectory(env, directory, includeRootFiles, depth, skills, diagnostics, state, context) {
  if (depth > MAX_SKILL_DEPTH || state.entries >= MAX_SKILL_ENTRIES) return;
  const listed = await env.listDir(directory, context);
  if (!listed.ok) {
    if (listed.error?.code !== "not_found") diagnostics.push(resourceWarning(listed.error, directory));
    return;
  }
  state.entries += listed.value.length;

  const declared = listed.value.find((entry) => entry.name === "SKILL.md" && entry.kind === "file");
  if (declared) {
    await addSkill(env, declared.path, skills, diagnostics, context);
    return;
  }

  for (const entry of listed.value) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (entry.kind === "directory") {
      await scanSkillDirectory(env, entry.path, false, depth + 1, skills, diagnostics, state, context);
    } else if (entry.kind === "file" && includeRootFiles && entry.name.endsWith(".md")) {
      await addSkill(env, entry.path, skills, diagnostics, context);
    }
    if (state.entries >= MAX_SKILL_ENTRIES) break;
  }
}

async function addSkill(env, filePath, skills, diagnostics, context) {
  const read = await env.readTextFile(filePath, context);
  if (!read.ok) {
    diagnostics.push(resourceWarning(read.error, filePath));
    return;
  }
  const declared = basenamePortable(filePath) === "SKILL.md";
  let frontmatter;
  try {
    frontmatter = parseFrontmatter(read.value);
  } catch (error) {
    if (declared) diagnostics.push({ type: "warning", message: error.message, path: filePath });
    return;
  }
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  if (!description) {
    if (declared) diagnostics.push({ type: "warning", message: "description is required", path: filePath });
    return;
  }
  const baseDir = dirnamePortable(filePath);
  const name = typeof frontmatter.name === "string" && frontmatter.name.trim()
    ? frontmatter.name.trim()
    : basenamePortable(baseDir);
  skills.push({
    name,
    description,
    filePath,
    baseDir,
    sourceInfo: { source: "telepi-remote", scope: "project", baseDir },
    disableModelInvocation: frontmatter["disable-model-invocation"] === true,
  });
}

function parseFrontmatter(content) {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) throw new Error("unterminated YAML frontmatter");
  return parseYaml(content.slice(content.indexOf("\n") + 1, end)) || {};
}

async function ancestorDirectories(env, cwd, context) {
  const canonical = await env.canonicalPath(cwd, context);
  let current = canonical.ok ? canonical.value : cwd;
  const directories = [];
  for (let depth = 0; depth < 256; depth += 1) {
    directories.push(current);
    const joined = await joinEnvPath(env, [current, ".."], context);
    const parentResult = await env.canonicalPath(joined, context);
    const parent = parentResult.ok ? parentResult.value : dirnamePortable(current);
    if (!parent || parent === current) return directories;
    current = parent;
  }
  throw new Error(`Remote project context ancestry is too deep: ${cwd}`);
}

async function joinEnvPath(env, parts, context) {
  const result = await env.joinPath(parts, context);
  if (!result.ok) throw result.error;
  return result.value;
}

async function readOptionalText(env, path, context) {
  const result = await env.readTextFile(path, context);
  if (result.ok) return result.value;
  if (["not_found", "is_directory", "permission_denied"].includes(result.error?.code)) return null;
  throw result.error;
}

function resourceWarning(error, path) {
  return { type: "warning", message: error?.message || "failed to read remote skill", path };
}

function basenamePortable(path) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || basename(path);
}

function dirnamePortable(path) {
  if (path.includes("\\")) {
    const index = path.lastIndexOf("\\");
    return index <= 2 ? path.slice(0, index + 1) : path.slice(0, index);
  }
  return dirname(path);
}
