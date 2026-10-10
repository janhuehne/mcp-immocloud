import type { ImmocloudConfig } from "../config.js";
import type { ImmocloudAuthenticator } from "./auth.js";
import type { ImmocloudClient } from "./client.js";
import { loadSession, resolveSessionPath } from "./session.js";

export type BootstrapAuthResult =
  | { status: "token_from_env" }
  | { status: "session_restored" }
  | { status: "authenticated_via_login" }
  | { status: "device_verification_required" }
  | { status: "unauthenticated"; reason: string };

/**
 * Restore a saved session or log in with email/password + trusted device.
 * Never prints tokens or passwords.
 */
export async function bootstrapAuthentication(
  config: ImmocloudConfig,
  client: ImmocloudClient,
  authenticator: ImmocloudAuthenticator,
): Promise<BootstrapAuthResult> {
  if (config.authMode === "oauth") {
    return {
      status: "unauthenticated",
      reason:
        "OAuth mode is status-only; private REST tokens, saved sessions, login, and write tools are disabled.",
    };
  }

  if (client.getAuthSnapshot().tokenPresent) {
    return { status: "token_from_env" };
  }

  const sessionPath = resolveSessionPath();
  const session = await loadSession(
    sessionPath,
    new URL(config.baseUrl).origin,
  );
  if (session) {
    client.setAuthToken(session.authToken);
    if (session.deviceId) {
      client.setDeviceId(session.deviceId);
    }
    return { status: "session_restored" };
  }

  if (!config.enableLoginTools) {
    return {
      status: "unauthenticated",
      reason:
        "No IMMOCLOUD_AUTH_TOKEN / saved session. Enable IMMOCLOUD_ENABLE_LOGIN_TOOLS and set IMMOCLOUD_EMAIL / IMMOCLOUD_PASSWORD, or set a Bearer token.",
    };
  }

  if (!config.email || !config.password) {
    return {
      status: "unauthenticated",
      reason:
        "Login tools are enabled but IMMOCLOUD_EMAIL / IMMOCLOUD_PASSWORD are missing from the environment (.env).",
    };
  }

  const login = await authenticator.loginFromEnvironment();
  if (login.status === "authenticated") {
    return { status: "authenticated_via_login" };
  }

  return { status: "device_verification_required" };
}
