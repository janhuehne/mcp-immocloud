import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const SERVICE = "immocloud-mcp";
const require = createRequire(import.meta.url);

export interface KeychainSecretPayload {
  authToken: string;
  deviceId?: string;
  deviceIdExpiresAt?: string;
  origin?: string;
}

type KeyringEntry = {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
};

type KeyringEntryConstructor = new (
  service: string,
  account: string,
) => KeyringEntry;

export function keychainAccountForSessionPath(sessionPath: string): string {
  const digest = createHash("sha256")
    .update(sessionPath)
    .digest("hex")
    .slice(0, 16);
  return `session:${digest}`;
}

function loadEntryConstructor(): KeyringEntryConstructor | undefined {
  try {
    const mod = require("@napi-rs/keyring") as {
      Entry?: KeyringEntryConstructor;
    };
    return typeof mod.Entry === "function" ? mod.Entry : undefined;
  } catch {
    return undefined;
  }
}

function createEntry(
  account: string,
): { ok: true; entry: KeyringEntry } | { ok: false; error: Error } {
  const Entry = loadEntryConstructor();
  if (Entry === undefined) {
    return {
      ok: false,
      error: new Error("@napi-rs/keyring is not available in this environment."),
    };
  }
  try {
    return { ok: true, entry: new Entry(SERVICE, account) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export function isKeychainAvailable(): boolean {
  const created = createEntry("__immocloud_mcp_probe__");
  if (!created.ok) {
    return false;
  }
  try {
    created.entry.getPassword();
    return true;
  } catch {
    return false;
  }
}

export function loadKeychainSecret(
  sessionPath: string,
): KeychainSecretPayload | undefined {
  const created = createEntry(keychainAccountForSessionPath(sessionPath));
  if (!created.ok) {
    return undefined;
  }
  let raw: string | null;
  try {
    raw = created.entry.getPassword();
  } catch {
    return undefined;
  }
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as KeychainSecretPayload;
    if (
      typeof parsed.authToken !== "string" ||
      !/^Bearer\s+\S+$/i.test(parsed.authToken.trim())
    ) {
      return undefined;
    }
    return {
      authToken: parsed.authToken.trim(),
      ...(typeof parsed.deviceId === "string" && parsed.deviceId.trim()
        ? { deviceId: parsed.deviceId.trim() }
        : {}),
      ...(typeof parsed.deviceIdExpiresAt === "string"
        ? { deviceIdExpiresAt: parsed.deviceIdExpiresAt }
        : {}),
      ...(typeof parsed.origin === "string" ? { origin: parsed.origin } : {}),
    };
  } catch {
    return undefined;
  }
}

export function saveKeychainSecret(
  sessionPath: string,
  secret: KeychainSecretPayload,
): void {
  const created = createEntry(keychainAccountForSessionPath(sessionPath));
  if (!created.ok) {
    throw created.error;
  }
  const authToken = secret.authToken.trim();
  if (!/^Bearer\s+\S+$/i.test(authToken)) {
    throw new Error("Refusing to persist an invalid Immocloud auth token.");
  }
  const payload: KeychainSecretPayload = {
    authToken,
    ...(secret.deviceId ? { deviceId: secret.deviceId } : {}),
    ...(secret.deviceIdExpiresAt
      ? { deviceIdExpiresAt: secret.deviceIdExpiresAt }
      : {}),
    ...(secret.origin ? { origin: secret.origin } : {}),
  };
  created.entry.setPassword(JSON.stringify(payload));
}

export function deleteKeychainSecret(sessionPath: string): void {
  const created = createEntry(keychainAccountForSessionPath(sessionPath));
  if (!created.ok) {
    return;
  }
  try {
    created.entry.deletePassword();
  } catch {
    // Ignore missing entries.
  }
}
