import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { ImmocloudConfig } from "../config.js";
import type { ImmocloudAuthenticator } from "../immocloud/auth.js";
import type { ImmocloudClient } from "../immocloud/client.js";
import { getOAuthStatus } from "../immocloud/oauth.js";
import { runTool } from "./result.js";

const localStatusAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const authenticationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export function registerAuthTools(
  server: McpServer,
  config: ImmocloudConfig,
  client: ImmocloudClient,
  authenticator: ImmocloudAuthenticator,
): void {
  server.registerTool(
    "immocloud_auth_status",
    {
      description:
        "Show non-secret Immocloud authentication configuration and runtime status. Never returns a token, password, email, or device ID.",
      annotations: localStatusAnnotations,
    },
    async () =>
      runTool(() => {
        const auth = client.getAuthSnapshot();
        return {
          authMode: config.authMode,
          tokenPresent: auth.tokenPresent,
          whiteLabel: config.whiteLabel,
          baseUrl: config.baseUrl,
          deviceIdPresent: auth.deviceIdPresent,
          emailConfigured: config.email !== undefined,
          passwordConfigured: config.password !== undefined,
          loginToolsEnabled:
            config.authMode === "token" && config.enableLoginTools,
          readOnly: config.readOnly,
          bankingWriteToolsEnabled: config.enableBankingWriteTools,
          propertyWriteToolsEnabled: config.enablePropertyWriteTools,
          oauthImplemented: false,
        };
      }),
  );

  server.registerTool(
    "immocloud_oauth_status",
    {
      description:
        "Describe the future official Immocloud MCP OAuth integration, known endpoints, configuration readiness, and the possible mcpNotEnabled account gate. Makes no OAuth request.",
      annotations: localStatusAnnotations,
    },
    async () => runTool(() => getOAuthStatus(config)),
  );

  if (config.authMode !== "token" || !config.enableLoginTools) {
    return;
  }

  server.registerTool(
    "immocloud_login",
    {
      description:
        "Log in to Immocloud using IMMOCLOUD_EMAIL and IMMOCLOUD_PASSWORD from the server environment. Uses IMMOCLOUD_DEVICE_ID when configured. The resulting token is never returned and is persisted to the OS keychain when available (otherwise a protected local session file).",
      annotations: authenticationAnnotations,
    },
    async () => runTool(() => authenticator.loginFromEnvironment()),
  );

  server.registerTool(
    "immocloud_verify_device",
    {
      description:
        "Complete an Immocloud EMAIL_DEVICE challenge using IMMOCLOUD_EMAIL. Trusts the device and persists the token/device ID to the OS keychain when available (otherwise a protected local session file) without returning either secret.",
      inputSchema: {
        challengeHandle: z
          .string()
          .trim()
          .regex(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          )
          .describe("Opaque challenge handle returned by immocloud_login."),
        code: z
          .string()
          .trim()
          .min(1)
          .max(32)
          .describe("One-time device verification code sent by email."),
      },
      annotations: authenticationAnnotations,
    },
    async ({ challengeHandle, code }) =>
      runTool(async () => {
        const email = authenticator.getConfiguredEmail();
        if (!email) {
          throw new Error(
            "Device verification requires IMMOCLOUD_EMAIL in the MCP process environment.",
          );
        }
        return authenticator.verifyDevice({ email, challengeHandle, code });
      }),
  );
}
