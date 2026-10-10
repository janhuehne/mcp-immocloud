#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createRequire } from "node:module";

import { loadConfig } from "./config.js";
import { ImmocloudAuthenticator } from "./immocloud/auth.js";
import { bootstrapAuthentication } from "./immocloud/bootstrap.js";
import { ImmocloudClient } from "./immocloud/client.js";
import { safeErrorMessage } from "./security/redaction.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerBankingTools } from "./tools/banking.js";
import { registerPropertyTools } from "./tools/properties.js";
import { registerReadTools } from "./tools/read.js";

const require = createRequire(import.meta.url);
const SERVER_VERSION = String(
  (require("../package.json") as { version: string }).version,
);
const SERVER_NAME = "immocloud-mcp";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new ImmocloudClient(config);
  const authenticator = new ImmocloudAuthenticator(config, client);

  try {
    const bootstrap = await bootstrapAuthentication(
      config,
      client,
      authenticator,
    );
    switch (bootstrap.status) {
      case "token_from_env":
        console.error("Immocloud auth: using IMMOCLOUD_AUTH_TOKEN from env.");
        break;
      case "session_restored":
        console.error("Immocloud auth: restored saved session.");
        break;
      case "authenticated_via_login":
        console.error(
          "Immocloud auth: logged in with email/password (+ trusted device if set).",
        );
        break;
      case "device_verification_required":
        console.error(
          "Immocloud auth: device verification required. Call immocloud_login, then immocloud_verify_device with the returned challengeHandle and emailed code.",
        );
        break;
      case "unauthenticated":
        console.error(`Immocloud auth: ${bootstrap.reason}`);
        break;
    }
  } catch (error) {
    console.error(
      `Immocloud auth bootstrap failed: ${safeErrorMessage(error)}`,
    );
  }

  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      instructions:
        "Access Immocloud's unsupported private REST API. Write tools are disabled by default. Banking writes need IMMOCLOUD_ENABLE_BANKING_WRITE_TOOLS=true and confirm=true; property/unit writes need IMMOCLOUD_ENABLE_PROPERTY_WRITE_TOOLS=true and confirm=true. IMMOCLOUD_READ_ONLY=true overrides both flags. confirm=true is a technical guard, not proof of human approval. Restart the MCP server after environment changes. Sessions prefer the OS keychain (IMMOCLOUD_SESSION_BACKEND=auto) with a local metadata file under .immocloud/. Treat all returned account data as confidential. Official OAuth mode is status-only.",
    },
  );

  if (config.authMode === "token") {
    registerReadTools(server, client);
    registerBankingTools(server, config, client);
    registerPropertyTools(server, config, client);
  }
  registerAuthTools(server, config, client, authenticator);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `${SERVER_NAME} ${SERVER_VERSION} running over stdio (${config.authMode} mode).`,
  );

  const close = async (): Promise<void> => {
    await server.close();
  };
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
}

main().catch((error: unknown) => {
  console.error(
    `${SERVER_NAME} failed to start: ${safeErrorMessage(error)}`,
  );
  process.exitCode = 1;
});
