#!/usr/bin/env node
/**
 * Read-only Immocloud connectivity / API-shape smoke test.
 * Detects auth failures and common Immocloud private-API drift.
 *
 * Usage:
 *   node --env-file=.env dist/health-check.js
 *   npm run health-check
 */

import { loadConfig } from "./config.js";
import { ImmocloudAuthenticator } from "./immocloud/auth.js";
import { bootstrapAuthentication } from "./immocloud/bootstrap.js";
import { ImmocloudApiError, ImmocloudClient } from "./immocloud/client.js";
import { safeErrorMessage } from "./security/redaction.js";

type CheckStatus = "pass" | "fail" | "warn" | "skip";

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayLen(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (isRecord(value) && Array.isArray(value.content)) return value.content.length;
  if (isRecord(value) && Array.isArray(value.items)) return value.items.length;
  if (isRecord(value) && Array.isArray(value.data)) return value.data.length;
  return undefined;
}

async function check(
  name: string,
  fn: () => Promise<string>,
): Promise<CheckResult> {
  try {
    const detail = await fn();
    return { name, status: "pass", detail };
  } catch (error) {
    if (error instanceof ImmocloudApiError) {
      return {
        name,
        status: "fail",
        detail: `HTTP ${error.status ?? "?"} — ${safeErrorMessage(error)}`,
      };
    }
    return { name, status: "fail", detail: safeErrorMessage(error) };
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const results: CheckResult[] = [];

  if (config.authMode !== "token") {
    console.error(
      "health-check: IMMOCLOUD_AUTH_MODE=oauth is status-only; private API checks are skipped.",
    );
    process.exitCode = 2;
    return;
  }

  const client = new ImmocloudClient(config);
  const authenticator = new ImmocloudAuthenticator(config, client);
  const bootstrap = await bootstrapAuthentication(
    config,
    client,
    authenticator,
  );

  if (
    bootstrap.status === "unauthenticated" ||
    bootstrap.status === "device_verification_required"
  ) {
    const reason =
      bootstrap.status === "unauthenticated"
        ? bootstrap.reason
        : "device verification required (complete immocloud_verify_device first)";
    results.push({
      name: "auth.bootstrap",
      status: "fail",
      detail: reason,
    });
    printReport(results);
    process.exitCode = 1;
    return;
  }

  results.push({
    name: "auth.bootstrap",
    status: "pass",
    detail: bootstrap.status,
  });

  results.push(
    await check("GET /profile", async () => {
      const profile = await client.get<unknown>("/profile");
      if (!isRecord(profile) || typeof profile.id !== "string") {
        throw new Error("profile missing string id — shape may have changed");
      }
      return "profile.id present";
    }),
  );

  results.push(
    await check("GET /properties/page", async () => {
      const body = await client.get<unknown>("/properties/page", {
        page: 0,
        size: 5,
      });
      const n = arrayLen(body);
      if (n === undefined && !isRecord(body)) {
        throw new Error("unexpected properties payload shape");
      }
      return n === undefined ? "ok (non-array envelope)" : `${n} item(s) in page`;
    }),
  );

  results.push(
    await check("GET /contacts", async () => {
      const body = await client.get<unknown>("/contacts", {
        page: 0,
        size: 5,
      });
      const n = arrayLen(body);
      return n === undefined ? "ok" : `${n} item(s) in page`;
    }),
  );

  results.push(
    await check("GET /banking/connections", async () => {
      const body = await client.get<unknown>("/banking/connections");
      const n = arrayLen(body);
      return n === undefined ? "ok" : `${n} connection(s)`;
    }),
  );

  results.push(
    await check("GET /finance/transactions/bank", async () => {
      const body = await client.get<unknown>("/finance/transactions/bank", {
        page: 0,
        size: 5,
        transactionState: "UNASSIGNED",
      });
      const n = arrayLen(body);
      return n === undefined ? "ok" : `${n} bank tx(s) in page`;
    }),
  );

  results.push(
    await check("GET /finance/transactions", async () => {
      const body = await client.get<unknown>("/finance/transactions", {
        page: 0,
        size: 5,
      });
      const n = arrayLen(body);
      return n === undefined ? "ok" : `${n} finance tx(s) in page`;
    }),
  );

  results.push(
    await check("GET /actuator/health", async () => {
      const response = await client.request<unknown>("/actuator/health", {
        method: "GET",
        authenticated: false,
      });
      const body = response.data;
      if (!isRecord(body) || body.status !== "UP") {
        throw new Error(`unexpected health payload`);
      }
      return "status UP";
    }),
  );

  printReport(results);

  const failed = results.filter((r) => r.status === "fail").length;
  process.exitCode = failed > 0 ? 1 : 0;
}

function printReport(results: CheckResult[]): void {
  const icon: Record<CheckStatus, string> = {
    pass: "PASS",
    fail: "FAIL",
    warn: "WARN",
    skip: "SKIP",
  };
  console.log("Immocloud MCP health check (read-only)\n");
  for (const result of results) {
    console.log(
      `[${icon[result.status]}] ${result.name}: ${result.detail}`,
    );
  }
  const failed = results.filter((r) => r.status === "fail").length;
  const passed = results.filter((r) => r.status === "pass").length;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(
      "If failures appeared after Immocloud worked before, the private API likely changed — inspect paths/shapes in src/tools/ and update the MCP.",
    );
  }
}

main().catch((error: unknown) => {
  console.error(`health-check crashed: ${safeErrorMessage(error)}`);
  process.exitCode = 1;
});
