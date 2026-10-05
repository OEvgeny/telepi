import { mkdir, open, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";

export async function acquireDurableStorageLock(storageDir, options = {}) {
  const directory = resolve(storageDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "host.lock");
  await (await open(path, "a", 0o600)).close();

  const staleMs = options.staleMs ?? 10_000;
  let release;
  try {
    release = await lockfile.lock(path, {
      realpath: false,
      stale: staleMs,
      update: Math.max(1_000, Math.floor(staleMs / 2)),
      retries: options.retries ?? { retries: 12, minTimeout: 1_000, maxTimeout: 1_000 },
    });
  } catch (error) {
    throw new Error(`Durable storage is already owned: ${directory}`, { cause: error });
  }

  const owner = {
    pid: process.pid,
    nonce: options.nonce || null,
    acquiredAt: new Date().toISOString(),
  };
  await writeFile(path, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  let released = false;
  return {
    directory,
    path,
    async release() {
      if (released) return;
      released = true;
      await release();
    },
  };
}
