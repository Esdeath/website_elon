import { createHash, randomUUID } from "node:crypto";
import { mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface LockOwner {
  host: string;
  pid: number;
  token: string;
}

const LOCK_ROOT = join(tmpdir(), "musk-archive-video-locks");
const RETRY_DELAY_MS = 100;

const wait = (milliseconds: number) =>
  new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));

function lockPathFor(filePath: string): string {
  const key = createHash("sha256").update(resolve(filePath)).digest("hex");
  return join(LOCK_ROOT, `${key}.lock`);
}

function staleClaimPath(lockPath: string, staleTarget: string, predecessor = ""): string {
  const generation = createHash("sha256")
    .update(staleTarget)
    .update("\\0")
    .update(predecessor)
    .digest("hex");
  return `${lockPath}.reap-${generation}`;
}

function encodeOwner(owner: LockOwner): string {
  return Buffer.from(JSON.stringify(owner), "utf8").toString("base64url");
}

function decodeOwner(value: string): LockOwner | undefined {
  try {
    const owner = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as LockOwner;
    if (
      typeof owner.host !== "string" ||
      !Number.isInteger(owner.pid) ||
      owner.pid < 1 ||
      typeof owner.token !== "string"
    ) {
      return undefined;
    }
    return owner;
  } catch {
    return undefined;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

async function releaseOwnedSymlink(path: string, ownerTarget: string): Promise<void> {
  try {
    if ((await readlink(path)) === ownerTarget) await unlink(path);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

async function acquireStaleClaim(
  lockPath: string,
  staleTarget: string,
): Promise<(() => Promise<void>) | undefined> {
  // A crashed claimant is bypassed with a new immutable generation. This keeps
  // stale recovery from ever deleting a replacement claimant or live entry lock.
  const claimantTarget = encodeOwner({
    host: hostname(),
    pid: process.pid,
    token: randomUUID(),
  });
  let predecessor = "";

  for (;;) {
    const claimPath = staleClaimPath(lockPath, staleTarget, predecessor);
    try {
      await symlink(claimantTarget, claimPath);
      return () => releaseOwnedSymlink(claimPath, claimantTarget);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
    }

    let existingTarget: string;
    try {
      existingTarget = await readlink(claimPath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      return undefined;
    }
    const existingOwner = decodeOwner(existingTarget);
    if (
      !existingOwner ||
      existingOwner.host !== hostname() ||
      processExists(existingOwner.pid)
    ) {
      return undefined;
    }
    predecessor = `${claimPath}\\0${existingTarget}`;
  }
}

async function removeStaleLocalLock(lockPath: string): Promise<boolean> {
  let observedTarget: string;
  try {
    observedTarget = await readlink(lockPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return true;
    }
    return false;
  }
  const owner = decodeOwner(observedTarget);
  if (!owner || owner.host !== hostname() || processExists(owner.pid)) return false;

  const releaseClaim = await acquireStaleClaim(lockPath, observedTarget);
  if (!releaseClaim) return false;
  try {
    const currentTarget = await readlink(lockPath);
    const currentOwner = decodeOwner(currentTarget);
    if (
      currentTarget !== observedTarget ||
      !currentOwner ||
      currentOwner.host !== hostname() ||
      processExists(currentOwner.pid)
    ) {
      return false;
    }
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return true;
    }
    return false;
  } finally {
    await releaseClaim();
  }
}

async function acquireVideoEntryLock(filePath: string): Promise<() => Promise<void>> {
  await mkdir(LOCK_ROOT, { recursive: true });
  const lockPath = lockPathFor(filePath);
  const ownerTarget = encodeOwner({
    host: hostname(),
    pid: process.pid,
    token: randomUUID(),
  });

  for (;;) {
    try {
      await symlink(ownerTarget, lockPath);
      break;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      if (!(await removeStaleLocalLock(lockPath))) await wait(RETRY_DELAY_MS);
    }
  }

  return async () => {
    await releaseOwnedSymlink(lockPath, ownerTarget);
  };
}

export async function withVideoEntryLock<Result>(
  filePath: string,
  action: () => Promise<Result>,
): Promise<Result> {
  const release = await acquireVideoEntryLock(filePath);
  try {
    return await action();
  } finally {
    await release();
  }
}
