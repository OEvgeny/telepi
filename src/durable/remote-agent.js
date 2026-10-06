const BROWSER_EXTENSION_PATTERN = /(?:^|[\\/])browser\.(?:[cm]?[jt]s)$/i;

export async function resolveRemoteAgentResources(env, agentDir, context) {
  if (!agentDir) return { skillRoots: [], browserPackageRoot: null };
  const settingsPath = await joinEnvPath(env, [agentDir, "settings.json"], context);
  const settings = await readJsonOptional(env, settingsPath, context) || {};
  const packageRoots = [];
  let browserPackageRoot = null;

  for (const packageSpec of Array.isArray(settings.packages) ? settings.packages : []) {
    if (typeof packageSpec !== "string" || !packageSpec.trim()) continue;
    const resolved = await resolvePackageRoot(env, agentDir, packageSpec.trim(), context);
    if (!resolved) continue;
    packageRoots.push(resolved.root);
    const extensions = Array.isArray(resolved.manifest?.pi?.extensions) ? resolved.manifest.pi.extensions : [];
    const packageName = String(resolved.manifest?.name || "");
    if (!browserPackageRoot && (
      /(?:^|[/@-])browser(?:$|-)/i.test(packageName)
      || extensions.some((path) => BROWSER_EXTENSION_PATTERN.test(String(path)))
    )) {
      browserPackageRoot = resolved.root;
    }
  }

  const skillRoots = [await joinEnvPath(env, [agentDir, "skills"], context)];
  for (const path of Array.isArray(settings.skills) ? settings.skills : []) {
    if (typeof path === "string" && path.trim()) skillRoots.push(await resolveRemotePath(env, agentDir, path.trim(), context));
  }
  for (const root of packageRoots) {
    const manifest = await readJsonOptional(env, await joinEnvPath(env, [root, "package.json"], context), context);
    for (const path of Array.isArray(manifest?.pi?.skills) ? manifest.pi.skills : []) {
      if (typeof path === "string" && path.trim()) skillRoots.push(await resolveRemotePath(env, root, path.trim(), context));
    }
  }

  return {
    skillRoots: [...new Set(skillRoots)],
    browserPackageRoot,
  };
}

async function resolvePackageRoot(env, agentDir, packageSpec, context) {
  const candidates = isAbsoluteRemotePath(packageSpec)
    ? [packageSpec]
    : [
        await joinEnvPath(env, [agentDir, packageSpec], context),
        await joinEnvPath(env, [agentDir, "..", "source", packageSpec], context),
        await joinEnvPath(env, [env.cwd, packageSpec], context),
      ];
  for (const root of candidates) {
    const manifest = await readJsonOptional(env, await joinEnvPath(env, [root, "package.json"], context), context);
    if (manifest) {
      const canonical = await env.canonicalPath(root, context);
      return { root: canonical.ok ? canonical.value : root, manifest };
    }
  }
  return null;
}

async function resolveRemotePath(env, base, path, context) {
  return isAbsoluteRemotePath(path) ? path : joinEnvPath(env, [base, path], context);
}

function isAbsoluteRemotePath(path) {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

async function readJsonOptional(env, path, context) {
  const result = await env.readTextFile(path, context);
  if (!result.ok) {
    if (["not_found", "permission_denied", "is_directory"].includes(result.error?.code)) return null;
    throw result.error;
  }
  try {
    return JSON.parse(result.value);
  } catch (error) {
    throw new Error(`Invalid remote JSON ${path}: ${error instanceof Error ? error.message : error}`);
  }
}

async function joinEnvPath(env, parts, context) {
  const result = await env.joinPath(parts, context);
  if (!result.ok) throw result.error;
  return result.value;
}
