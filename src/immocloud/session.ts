import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  deleteKeychainSecret,
  isKeychainAvailable,
  loadKeychainSecret,
  saveKeychainSecret,
} from "./keychain.js";

export type SessionBackend = "auto" | "keychain" | "file";

export interface ImmocloudSession {
  authToken: string;
  deviceId?: string;
  deviceIdExpiresAt?: string;
  origin?: string;
  savedAt: string;
  backend: "keychain" | "file";
}

/** On-disk metadata. Must never contain authToken when backend is keychain. */
interface SessionMetaFile {
  backend: "keychain" | "file";
  origin?: string;
  savedAt: string;
  deviceIdExpiresAt?: string;
  /** Legacy plaintext sessions only. */
  authToken?: string;
  deviceId?: string;
}

export interface SaveSessionResult {
  sessionPath: string;
  backend: "keychain" | "file";
  migratedFromFile: boolean;
}

function defaultSessionPath(): string {
  return path.resolve(process.cwd(), ".immocloud", "session.json");
}

export function resolveSessionPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.IMMOCLOUD_SESSION_PATH?.trim();
  return configured ? path.resolve(configured) : defaultSessionPath();
}

export function resolveSessionBackend(
  env: NodeJS.ProcessEnv = process.env,
): SessionBackend {
  const raw = env.IMMOCLOUD_SESSION_BACKEND?.trim().toLowerCase();
  if (raw === undefined || raw === "") {
    return "auto";
  }
  if (raw === "auto" || raw === "keychain" || raw === "file") {
    return raw;
  }
  throw new Error(
    'IMMOCLOUD_SESSION_BACKEND must be "auto", "keychain", or "file".',
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

/**
 * Reject symlinks on the session file and its immediate parent directory.
 * Do not walk ancestors to root — system paths like macOS `/tmp` → `/private/tmp`
 * are legitimate and would otherwise block normal installs.
 */
async function assertNoSymlinkAt(targetPath: string): Promise<void> {
  const absolute = path.resolve(targetPath);
  try {
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Refusing session path that is a symbolic link: ${absolute}`,
      );
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
}

async function assertSafeSessionLocations(sessionPath: string): Promise<void> {
  const absolute = path.resolve(sessionPath);
  const parent = path.dirname(absolute);
  await assertNoSymlinkAt(parent);
  await assertNoSymlinkAt(absolute);
}

async function readMetaFile(
  sessionPath: string,
): Promise<SessionMetaFile | undefined> {
  await assertSafeSessionLocations(sessionPath);

  let handle;
  try {
    handle = await open(
      sessionPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error("Immocloud session path is not a regular file.");
    }
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new Error(
        "Immocloud session file permissions are too broad; require mode 0600.",
      );
    }

    const raw = await handle.readFile("utf8");
    try {
      return JSON.parse(raw) as SessionMetaFile;
    } catch {
      return undefined;
    }
  } finally {
    await handle.close();
  }
}

async function writeMetaFile(
  sessionPath: string,
  meta: SessionMetaFile,
): Promise<void> {
  const dir = path.dirname(sessionPath);
  await assertNoSymlinkAt(dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await assertSafeSessionLocations(sessionPath);
  const dirStats = await lstat(dir);
  if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) {
    throw new Error("Immocloud session parent is not a directory.");
  }
  if (process.platform !== "win32" && (dirStats.mode & 0o022) !== 0) {
    throw new Error(
      "Immocloud session parent directory must not be group/world writable.",
    );
  }

  const temporaryPath = path.join(
    dir,
    `.${path.basename(sessionPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_NOFOLLOW;
  let handle;
  try {
    handle = await open(temporaryPath, flags, 0o600);
    await handle.writeFile(`${JSON.stringify(meta, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    await assertNoSymlinkAt(sessionPath);
    await rename(temporaryPath, sessionPath);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function assertOrigin(
  sessionOrigin: string | undefined,
  expectedOrigin: string | undefined,
): void {
  if (
    expectedOrigin !== undefined &&
    sessionOrigin !== undefined &&
    sessionOrigin !== expectedOrigin
  ) {
    throw new Error(
      "Saved Immocloud session belongs to a different API origin.",
    );
  }
}

function chooseWriteBackend(preferred: SessionBackend): "keychain" | "file" {
  if (preferred === "file") {
    return "file";
  }
  if (preferred === "keychain") {
    if (!isKeychainAvailable()) {
      throw new Error(
        "IMMOCLOUD_SESSION_BACKEND=keychain but the OS keychain is unavailable.",
      );
    }
    return "keychain";
  }
  return isKeychainAvailable() ? "keychain" : "file";
}

/**
 * Load a saved session. Prefer OS keychain secrets; fall back to legacy
 * plaintext session.json and migrate when keychain is available.
 */
export async function loadSession(
  sessionPath: string = resolveSessionPath(),
  expectedOrigin?: string,
  backend: SessionBackend = resolveSessionBackend(),
): Promise<ImmocloudSession | undefined> {
  const meta = await readMetaFile(sessionPath);
  const keychainSecret =
    backend === "file" ? undefined : loadKeychainSecret(sessionPath);

  if (keychainSecret) {
    const origin = keychainSecret.origin ?? meta?.origin;
    const deviceIdExpiresAt =
      keychainSecret.deviceIdExpiresAt ?? meta?.deviceIdExpiresAt;
    assertOrigin(origin, expectedOrigin);
    const session: ImmocloudSession = {
      authToken: keychainSecret.authToken,
      savedAt:
        typeof meta?.savedAt === "string"
          ? meta.savedAt
          : new Date().toISOString(),
      backend: "keychain",
      ...(keychainSecret.deviceId ? { deviceId: keychainSecret.deviceId } : {}),
      ...(typeof deviceIdExpiresAt === "string"
        ? { deviceIdExpiresAt }
        : {}),
      ...(typeof origin === "string" ? { origin } : {}),
    };

    // Ensure metadata file does not retain a plaintext token.
    if (meta?.authToken) {
      await writeMetaFile(sessionPath, {
        backend: "keychain",
        savedAt: session.savedAt,
        ...(session.origin ? { origin: session.origin } : {}),
        ...(session.deviceIdExpiresAt
          ? { deviceIdExpiresAt: session.deviceIdExpiresAt }
          : {}),
      });
    }
    return session;
  }

  if (!meta) {
    return undefined;
  }

  const legacyToken =
    typeof meta.authToken === "string" ? meta.authToken.trim() : undefined;
  if (!legacyToken || !/^Bearer\s+\S+$/i.test(legacyToken)) {
    return undefined;
  }
  assertOrigin(meta.origin, expectedOrigin);

  const legacy: ImmocloudSession = {
    authToken: legacyToken,
    savedAt:
      typeof meta.savedAt === "string" ? meta.savedAt : new Date().toISOString(),
    backend: "file",
    ...(typeof meta.deviceId === "string" && meta.deviceId.trim()
      ? { deviceId: meta.deviceId.trim() }
      : {}),
    ...(typeof meta.deviceIdExpiresAt === "string"
      ? { deviceIdExpiresAt: meta.deviceIdExpiresAt }
      : {}),
    ...(typeof meta.origin === "string" ? { origin: meta.origin } : {}),
  };

  // Migrate plaintext file → keychain when allowed.
  if (backend !== "file" && isKeychainAvailable()) {
    try {
      const { backend: _ignoredBackend, ...migratable } = legacy;
      const saved = await saveSession(migratable, sessionPath, "keychain");
      if (saved.backend === "keychain") {
        return { ...legacy, backend: "keychain" };
      }
    } catch {
      // Keep serving the legacy file session if migration fails.
    }
  }

  return legacy;
}

export async function saveSession(
  session: Omit<ImmocloudSession, "savedAt" | "backend"> & {
    savedAt?: string;
    backend?: "keychain" | "file";
  },
  sessionPath: string = resolveSessionPath(),
  backend: SessionBackend = resolveSessionBackend(),
): Promise<SaveSessionResult> {
  const authToken = session.authToken.trim();
  if (!/^Bearer\s+\S+$/i.test(authToken)) {
    throw new Error("Refusing to persist an invalid Immocloud auth token.");
  }

  const savedAt = session.savedAt ?? new Date().toISOString();
  // Explicit backend argument wins over any session.backend hint.
  const writeBackend =
    backend === "auto"
      ? (session.backend ?? chooseWriteBackend(backend))
      : chooseWriteBackend(backend);
  let migratedFromFile = false;

  if (writeBackend === "keychain") {
    const existingMeta = await readMetaFile(sessionPath);
    if (existingMeta?.authToken) {
      migratedFromFile = true;
    }
    saveKeychainSecret(sessionPath, {
      authToken,
      ...(session.deviceId ? { deviceId: session.deviceId } : {}),
      ...(session.deviceIdExpiresAt
        ? { deviceIdExpiresAt: session.deviceIdExpiresAt }
        : {}),
      ...(session.origin ? { origin: session.origin } : {}),
    });
    await writeMetaFile(sessionPath, {
      backend: "keychain",
      savedAt,
      ...(session.origin ? { origin: session.origin } : {}),
      ...(session.deviceIdExpiresAt
        ? { deviceIdExpiresAt: session.deviceIdExpiresAt }
        : {}),
    });
    return { sessionPath, backend: "keychain", migratedFromFile };
  }

  // File backend — plaintext token (legacy / fallback).
  deleteKeychainSecret(sessionPath);
  await writeMetaFile(sessionPath, {
    backend: "file",
    savedAt,
    authToken,
    ...(session.deviceId ? { deviceId: session.deviceId } : {}),
    ...(session.deviceIdExpiresAt
      ? { deviceIdExpiresAt: session.deviceIdExpiresAt }
      : {}),
    ...(session.origin ? { origin: session.origin } : {}),
  });
  return { sessionPath, backend: "file", migratedFromFile: false };
}
