import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { ImmocloudConfig } from "../config.js";
import {
  assertPeriodFieldsPreserved,
  assertRentCreateHasPeriod,
  assertUnitBookingHasPeriodOrCategory,
  buildFinancePutBody,
  hasRentPeriod,
  looksLikeRentTransaction,
  paymentList,
} from "../finance/payments.js";
import type {
  ImmocloudClient,
  ImmocloudResponse,
  QueryParameters,
} from "../immocloud/client.js";
import {
  encodeImmocloudId,
  immocloudIdSchema,
  normalizeImmocloudId,
} from "../immocloud/ids.js";
import {
  boundedJsonObjectSchema,
  boundedJsonValueSchema,
} from "../security/input.js";
import { safeErrorMessage } from "../security/redaction.js";
import { runTool } from "./result.js";

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const paginationSchema = {
  page: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Zero-based page index."),
  size: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Number of records to return (1-100)."),
};

const confirmSchema = z
  .literal(true)
  .describe(
    "Must be true to execute this write. Prevents accidental assignment or booking changes.",
  );

const jsonObjectSchema = boundedJsonObjectSchema.describe(
  "Bounded JSON object forwarded to Immocloud as the request body.",
);

function requireConfirm(confirm: true): void {
  if (confirm !== true) {
    throw new Error(
      'Write refused: pass confirm=true to modify Immocloud bank/accounting data.',
    );
  }
}

function optionalQuery(
  values: Record<string, string | number | boolean | undefined>,
): QueryParameters {
  const query: QueryParameters = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      query[key] = value;
    }
  }
  return query;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function paymentIdentities(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }
  const identities: string[] = [];
  for (const key of [
    "paymentId",
    "bankTransactionId",
    "financeTransactionId",
    "transactionId",
    "id",
  ]) {
    const candidate = value[key];
    if (typeof candidate === "string" || typeof candidate === "number") {
      identities.push(String(candidate));
    }
  }
  return identities;
}

function transactionState(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of [
    "transactionState",
    "bankTransactionState",
    "assignmentState",
    "state",
  ]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim().toUpperCase();
    }
  }
  return undefined;
}

function assertPaymentsPreserved(
  before: Record<string, unknown>,
  after: unknown,
  options: { clearPayments: boolean },
): void {
  if (options.clearPayments) {
    return;
  }
  const beforeCount = paymentList(before.payments).length;
  if (beforeCount === 0) {
    return;
  }
  const afterRecord = isRecord(after) ? after : {};
  const afterPayments = paymentList(afterRecord.payments);
  const afterCount = afterPayments.length;
  if (afterCount < beforeCount) {
    throw new Error(
      "Refusing result: finance update dropped bank payments. " +
        "Re-link via payments[] or immocloud_assign_bank_to_finance_transactions; " +
        "use clearPayments=true only when unlinking on purpose.",
    );
  }
  const beforeIdentityGroups = paymentList(before.payments)
    .map(paymentIdentities)
    .filter((identities) => identities.length > 0);
  const afterIdentities = new Set(
    afterPayments.flatMap(paymentIdentities),
  );
  if (
    beforeIdentityGroups.length > 0 &&
    beforeIdentityGroups.some((identities) =>
      identities.every((identity) => !afterIdentities.has(identity)),
    )
  ) {
    throw new Error(
      "Refusing result: finance update replaced one or more existing bank payments.",
    );
  }
}

function assertBankTransactionAssigned(value: unknown): void {
  if (!isRecord(value) || paymentList(value.payments).length === 0) {
    throw new Error(
      "Bank assignment verification failed: payments[] is empty after the update.",
    );
  }
  const state = transactionState(value);
  if (state !== "ASSIGNED") {
    throw new Error(
      `Bank assignment verification failed: expected ASSIGNED state, received ${state ?? "no state"}.`,
    );
  }
}

async function getFinanceTransaction(
  client: ImmocloudClient,
  transactionId: string,
): Promise<Record<string, unknown>> {
  const transaction = await client.get<unknown>(
    `/finance/transactions/${encodeImmocloudId(transactionId, "Transaction ID")}`,
  );
  if (!isRecord(transaction)) {
    throw new Error("Immocloud finance transaction response was not an object.");
  }
  return transaction;
}

function financeTransactionId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = value.id;
  if (typeof id !== "string" && typeof id !== "number") {
    return undefined;
  }
  try {
    return normalizeImmocloudId(String(id), "Created finance transaction ID");
  } catch {
    return undefined;
  }
}

function stripFinanceCreateFields(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const body = { ...value };
  if (body.payments !== undefined && !Array.isArray(body.payments)) {
    throw new Error("Finance payments must be an array.");
  }
  delete body.id;
  delete body.financeTransactionIds;
  delete body.transactionState;
  delete body.bankTransactionState;
  return body;
}

function assignmentDefinitelyAbsent(value: unknown): boolean {
  const state = transactionState(value);
  return (
    paymentList(isRecord(value) ? value.payments : undefined).length === 0 &&
    state !== undefined &&
    state !== "ASSIGNED"
  );
}

async function rollbackFinanceTransactions(
  client: ImmocloudClient,
  transactionIds: readonly string[],
): Promise<{ deleted: string[]; failed: string[] }> {
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const transactionId of [...transactionIds].reverse()) {
    try {
      await client.delete<unknown>(
        `/finance/transactions/${encodeImmocloudId(transactionId, "Rollback transaction ID")}`,
      );
      deleted.push(transactionId);
    } catch {
      failed.push(transactionId);
    }
  }
  return { deleted, failed };
}

function asConnectionList(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (isRecord(value)) {
    for (const key of ["content", "connections", "bankConnections", "items"]) {
      const candidate = value[key];
      if (Array.isArray(candidate)) {
        return candidate.filter(isRecord);
      }
    }
  }
  return [];
}

function summarizeBankConnections(value: unknown): Record<string, unknown> {
  const connections = asConnectionList(value);
  const needingReconnect = connections.filter(
    (connection) => connection.reconnectRequired === true,
  );
  const syncable = connections.filter(
    (connection) =>
      connection.reconnectRequired !== true && connection.manual !== true,
  );
  const manual = connections.filter((connection) => connection.manual === true);

  return {
    totalConnections: connections.length,
    needingReconnectCount: needingReconnect.length,
    syncableCount: syncable.length,
    manualCount: manual.length,
    needingReconnect: needingReconnect.map((connection) => ({
      id: connection.id,
      name: connection.name ?? connection.bankName ?? null,
      reconnectRequired: true,
      updateStatus: connection.updateStatus ?? null,
    })),
    syncable: syncable.map((connection) => ({
      id: connection.id,
      name: connection.name ?? connection.bankName ?? null,
      reconnectRequired: false,
      updateStatus: connection.updateStatus ?? null,
      lastUpdate:
        connection.lastUpdate ??
        connection.lastSync ??
        connection.lastSuccessfulUpdate ??
        null,
    })),
    guidance: {
      reconnectBanner:
        "Immocloud “Bankkonten verbinden” = expired consent. Use immocloud_reconnect_bank_connection, then complete the FinAPI/SCA webform URL in a browser.",
      updateBanner:
        "Immocloud “Bankkonten aktualisieren” = stale sync. Use immocloud_update_bank_accounts (POST /banking/connections/synchronize) when reconnectRequired is false.",
      scaLimitation:
        "Strong Customer Authentication cannot be completed inside MCP itself; the server can start reconnect and return/poll the webform, but you must finish login/2FA in the browser.",
    },
  };
}

function extractWebFormHints(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    return {
      url: null,
      webFormId: null,
      nextStep:
        "Immocloud did not return a recognized webform URL/id. Use the Immocloud UI to complete bank authentication.",
    };
  }

  const candidates = [
    payload.url,
    payload.webFormUrl,
    payload.webformUrl,
    payload.redirectUrl,
    payload.location,
    isRecord(payload.webForm) ? payload.webForm.url : undefined,
    isRecord(payload.webform) ? payload.webform.url : undefined,
  ];
  const candidateUrl = candidates.find(
    (value) => typeof value === "string" && value.length > 0,
  );
  let url: string | undefined;
  if (typeof candidateUrl === "string" && candidateUrl.length <= 4_096) {
    try {
      const parsed = new URL(candidateUrl);
      if (
        parsed.protocol === "https:" &&
        !parsed.username &&
        !parsed.password
      ) {
        url = parsed.toString();
      }
    } catch {
      // Ignore malformed or unsafe browser URLs from the upstream payload.
    }
  }
  const rawWebFormId =
    payload.webFormId ??
    payload.webformId ??
    (isRecord(payload.webForm) ? payload.webForm.id : undefined) ??
    (isRecord(payload.webform) ? payload.webform.id : undefined);
  let webFormId: string | null = null;
  if (
    typeof rawWebFormId === "string" ||
    typeof rawWebFormId === "number"
  ) {
    try {
      webFormId = normalizeImmocloudId(
        String(rawWebFormId),
        "Webform ID",
      );
    } catch {
      // Do not return unvalidated path identifiers.
    }
  }

  return {
    url: url ?? null,
    webFormId,
    nextStep: url
      ? "Open the URL in a browser, complete bank login/SCA, then call immocloud_get_bank_webform_status and/or immocloud_list_bank_connections."
      : "If Immocloud only opens an in-app modal, use the Immocloud UI once, then sync via MCP afterward.",
  };
}

function summarizeWebFormStatus(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    return { status: null, completed: null };
  }
  return {
    status:
      payload.status ??
      payload.state ??
      payload.webFormStatus ??
      null,
    completed:
      payload.completed ??
      payload.complete ??
      payload.success ??
      null,
  };
}

export function registerBankingTools(
  server: McpServer,
  config: ImmocloudConfig,
  client: ImmocloudClient,
): void {
  server.registerTool(
    "immocloud_list_bank_connections",
    {
      description:
        "List Immocloud FinAPI/bank connections and linked accounts (read-only). Includes a summary of reconnectRequired vs stale connections matching Immocloud's “Bankkonten verbinden/aktualisieren” banners.",
      annotations: readAnnotations,
    },
    async () =>
      runTool(async () => {
        const connections = await client.get<unknown>("/banking/connections");
        return {
          connections,
          summary: summarizeBankConnections(connections),
        };
      }),
  );

  server.registerTool(
    "immocloud_get_bank_connection_status",
    {
      description:
        "Summarize whether Immocloud bank connections need reconnect (expired consent) or update/sync (stale data). Maps to the Immocloud banners “Bankkonten verbinden” vs “Bankkonten aktualisieren”.",
      annotations: readAnnotations,
    },
    async () =>
      runTool(async () => {
        const connections = await client.get<unknown>("/banking/connections");
        return summarizeBankConnections(connections);
      }),
  );

  server.registerTool(
    "immocloud_list_banks",
    {
      description:
        "List banks available for Immocloud FinAPI connection setup (GET /banking/banks).",
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional bank name/BIC search text if supported by Immocloud."),
      },
      annotations: readAnnotations,
    },
    async ({ query }) =>
      runTool(() =>
        client.get<unknown>("/banking/banks", optionalQuery({ query })),
      ),
  );

  server.registerTool(
    "immocloud_list_bank_transactions",
    {
      description:
        "List Immocloud bank transactions from /finance/transactions/bank. Use this to inspect unassigned payments and embedded assignment suggestions before accepting them. Always sends transactionState (default UNASSIGNED) because Immocloud rejects null.",
      inputSchema: {
        ...paginationSchema,
        transactionState: z
          .enum(["UNASSIGNED", "ASSIGNED", "IGNORED"])
          .default("UNASSIGNED")
          .describe(
            "Immocloud bank transaction state filter (required by API). Use UNASSIGNED for nicht zugeordnet.",
          ),
        bankAccountId: immocloudIdSchema
          .optional()
          .describe(
            "Optional Immocloud bank account ID. Sent as bankAccountIds (Immocloud UI filter).",
          ),
        query: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional free-text search (searchQuery) passed through to Immocloud."),
      },
      annotations: readAnnotations,
    },
    async ({ page, size, transactionState, bankAccountId, query }) =>
      runTool(() =>
        client.get<unknown>(
          "/finance/transactions/bank",
          optionalQuery({
            page,
            size,
            // Immocloud returns 422 if transactionState is omitted; never rely on SDK defaults alone.
            transactionState: transactionState ?? "UNASSIGNED",
            bankAccountIds: bankAccountId,
            searchQuery: query,
          }),
        ),
      ),
  );

  server.registerTool(
    "immocloud_get_bank_transaction_counters",
    {
      description:
        "Get Immocloud bank-transaction counters, including suggested-assignment counts.",
      annotations: readAnnotations,
    },
    async () =>
      runTool(async () => {
        const [counters, suggested] = await Promise.all([
          client.get<unknown>("/transactions/bank/counters"),
          client.get<unknown>("/transactions/bank/counters/suggested"),
        ]);
        return { counters, suggested };
      }),
  );

  server.registerTool(
    "immocloud_list_open_rent_positions",
    {
      description:
        "List property/unit IDs that currently have open rent/receivable positions (useful when matching bank payments).",
      annotations: readAnnotations,
    },
    async () => runTool(() => client.get<unknown>("/transactions/open")),
  );

  server.registerTool(
    "immocloud_list_finance_transactions",
    {
      description:
        "List Immocloud finance/rent transactions (open rents, deposits, operating-cost items, etc.) via GET /finance/transactions. Use this to find IDs for manual bank assignment.",
      inputSchema: {
        ...paginationSchema,
        financeTransactionTypes: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            'Comma-separated types, e.g. "RENT", "DEPOSIT", "OC_STATEMENT", "FINANCE".',
          ),
        unitIds: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Comma-separated unit IDs to filter."),
        propertyIds: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Comma-separated property IDs to filter."),
        dateConstant: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            'Optional Immocloud date filter constant (e.g. "NO_PERIOD").',
          ),
        allocable: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Optional allocable filter; Immocloud default is often "BOTH".'),
        attachment: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Optional attachment filter; Immocloud default is often "BOTH".'),
      },
      annotations: readAnnotations,
    },
    async ({
      page,
      size,
      financeTransactionTypes,
      unitIds,
      propertyIds,
      dateConstant,
      allocable,
      attachment,
    }) =>
      runTool(() =>
        client.get<unknown>(
          "/finance/transactions",
          optionalQuery({
            page,
            size,
            financeTransactionTypes,
            unitIds,
            propertyIds,
            dateConstant,
            allocable,
            attachment,
          }),
        ),
      ),
  );

  server.registerTool(
    "immocloud_get_finance_transaction",
    {
      description:
        "Get one Immocloud finance or bank transaction by ID via GET /finance/transactions/{id}.",
      inputSchema: {
        transactionId: immocloudIdSchema
          .describe("Finance or bank transaction ID."),
      },
      annotations: readAnnotations,
    },
    async ({ transactionId }) =>
      runTool(() => getFinanceTransaction(client, transactionId)),
  );

  server.registerTool(
    "immocloud_get_rent_transaction_counters",
    {
      description:
        "Get Immocloud rental-transaction counters (open/paid summaries) via GET /transactions/rental/counters.",
      annotations: readAnnotations,
    },
    async () =>
      runTool(async () => {
        const [counters, detailed] = await Promise.all([
          client.get<unknown>("/transactions/rental/counters"),
          client.get<unknown>("/transactions/rental/counters/detailed"),
        ]);
        return { counters, detailed };
      }),
  );

  server.registerTool(
    "immocloud_get_bank_webform_status",
    {
      description:
        "Poll FinAPI/Immocloud bank webform status after reconnect/connect (POST /banking/webform/{webFormId}/status).",
      inputSchema: {
        webFormId: immocloudIdSchema.describe(
          "Webform ID from reconnect/connect response.",
        ),
      },
      annotations: readAnnotations,
    },
    async ({ webFormId }) =>
      runTool(async () => {
        const response = await client.post<unknown>(
          `/banking/webform/${encodeImmocloudId(webFormId, "Webform ID")}/status`,
          {},
        );
        return {
          ok: true,
          action: "bank_webform_status",
          webFormId,
          status: response.status,
          result: summarizeWebFormStatus(response.data),
        };
      }),
  );

  if (config.readOnly || !config.enableBankingWriteTools) {
    return;
  }

  const allocationSchema = z.object({
    propertyId: immocloudIdSchema.optional(),
    unitId: immocloudIdSchema.optional(),
    costCategoryId: immocloudIdSchema.optional(),
    amount: z.number().finite().describe("Amount to book for this allocation."),
    allocable: z.boolean().optional(),
    accountingPeriod: z.string().trim().min(1).max(64).optional(),
    correspondingMonth: z
      .number()
      .int()
      .min(0)
      .max(11)
      .optional()
      .describe(
        "Required with correspondingYear when booking to a unit without costCategoryId (rent period; 0=Jan).",
      ),
    correspondingYear: z
      .number()
      .int()
      .min(1970)
      .max(2100)
      .optional()
      .describe(
        "Required with correspondingMonth when booking to a unit without costCategoryId.",
      ),
    vat: boundedJsonValueSchema.optional(),
    vatAmountInPercent: z.number().finite().min(0).max(100).optional(),
    payments: z.array(boundedJsonObjectSchema).max(100).optional(),
    objectInfo: boundedJsonValueSchema.optional(),
  });

  server.registerTool(
    "immocloud_auto_assign_bank_transactions",
    {
      description:
        "Run Immocloud's bulk “Automatisch zuordnen” for bank transactions (GET /transactions/bank/auto-assign). This writes accounting assignments. Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        bankAccountId: immocloudIdSchema
          .optional()
          .describe("Optional bank account ID to scope auto-assignment."),
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, bankAccountId }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const data = await client.get<unknown>(
          "/transactions/bank/auto-assign",
          optionalQuery({ bankAccountId }),
        );
        return {
          ok: true,
          action: "auto_assign",
          result: data,
        };
      }),
  );

  server.registerTool(
    "immocloud_accept_bank_suggestion",
    {
      description:
        "Accept one Immocloud bank-assignment suggestion via PATCH /suggestions/{transactionId}/accept. Pass the bank transaction ID and optional body from the suggestion payload. Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        transactionId: immocloudIdSchema
          .describe(
            "Bank transaction ID used as /suggestions/{transactionId}/accept.",
          ),
        body: jsonObjectSchema
          .optional()
          .describe(
            "Optional request body Immocloud expects for this suggestion (often the suggestion object or {}). Defaults to {}.",
          ),
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, transactionId, body }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const response = await client.patch<unknown>(
          `/suggestions/${encodeImmocloudId(transactionId, "Transaction ID")}/accept`,
          body ?? {},
        );
        return {
          ok: true,
          action: "accept_suggestion",
          transactionId,
          status: response.status,
          result: response.data,
        };
      }),
  );

  server.registerTool(
    "immocloud_accept_bank_suggestions",
    {
      description:
        "Accept multiple Immocloud bank-assignment suggestions via PATCH /suggestions/accept. Pass the body Immocloud expects (commonly a list/wrapper of suggestion or transaction IDs). Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        body: jsonObjectSchema.describe(
          "Request body for bulk accept. Shape depends on Immocloud; use objects returned by immocloud_list_bank_transactions when possible.",
        ),
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, body }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const response = await client.patch<unknown>(
          "/suggestions/accept",
          body,
        );
        return {
          ok: true,
          action: "accept_suggestions",
          status: response.status,
          result: response.data,
        };
      }),
  );

  server.registerTool(
    "immocloud_ignore_bank_suggestion",
    {
      description:
        "Ignore/dismiss one Immocloud suggestion via POST /suggestions/{suggestionId}/ignore. Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        suggestionId: immocloudIdSchema
          .describe("Suggestion ID to ignore."),
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, suggestionId }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const response = await client.post<unknown>(
          `/suggestions/${encodeImmocloudId(suggestionId, "Suggestion ID")}/ignore`,
          {},
        );
        return {
          ok: true,
          action: "ignore_suggestion",
          suggestionId,
          status: response.status,
          result: response.data,
        };
      }),
  );

  server.registerTool(
    "immocloud_remove_bank_transaction_payments",
    {
      description:
        "Remove payments linked to a bank transaction (undo assignment) via PATCH /transactions/{transactionId}/removepayments. Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        transactionId: immocloudIdSchema
          .describe("Bank transaction ID to unlink payments from."),
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, transactionId }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const response = await client.patch<unknown>(
          `/transactions/${encodeImmocloudId(transactionId, "Transaction ID")}/removepayments`,
          {},
        );
        return {
          ok: true,
          action: "remove_payments",
          transactionId,
          status: response.status,
          result: response.data,
        };
      }),
  );

  server.registerTool(
    "immocloud_synchronize_bank_connections",
    {
      description:
        "Trigger Immocloud bank-connection synchronization (POST /banking/connections/synchronize) to pull latest FinAPI transactions. Same family as “Bankkonten aktualisieren”. Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
      },
      annotations: writeAnnotations,
    },
    async ({ confirm }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const before = summarizeBankConnections(
          await client.get<unknown>("/banking/connections"),
        );
        if ((before.needingReconnectCount as number) > 0) {
          return {
            ok: false,
            action: "synchronize_bank_connections",
            error:
              "One or more connections have reconnectRequired=true. Immocloud will not refresh those via synchronize — use immocloud_reconnect_bank_connection first (browser SCA).",
            status: before,
          };
        }
        const response = await client.post<unknown>(
          "/banking/connections/synchronize",
          {},
        );
        return {
          ok: true,
          action: "synchronize_bank_connections",
          status: response.status,
          result: response.data,
          note: "Immocloud may continue importing via SSE /banking/connections/import. Re-check with immocloud_list_bank_connections / list_bank_transactions.",
        };
      }),
  );

  server.registerTool(
    "immocloud_update_bank_accounts",
    {
      description:
        "Alias for Immocloud “Bankkonten aktualisieren”: synchronize bank connections that do not require reconnect. Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
      },
      annotations: writeAnnotations,
    },
    async ({ confirm }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const before = summarizeBankConnections(
          await client.get<unknown>("/banking/connections"),
        );
        if ((before.needingReconnectCount as number) > 0) {
          return {
            ok: false,
            action: "update_bank_accounts",
            error:
              "Reconnect required for at least one connection. Use immocloud_reconnect_bank_connection (browser SCA), not update/sync.",
            status: before,
          };
        }
        const response = await client.post<unknown>(
          "/banking/connections/synchronize",
          {},
        );
        return {
          ok: true,
          action: "update_bank_accounts",
          status: response.status,
          result: response.data,
          before,
        };
      }),
  );

  server.registerTool(
    "immocloud_reconnect_bank_connection",
    {
      description:
        "Start Immocloud “Bankkonten verbinden” / expired-consent reconnect for one connection via POST /banking/connections/{id}/import-bank-accounts (forceChangeCredentials). Returns any FinAPI webform URL/id. You must complete SCA in a browser; MCP cannot finish bank 2FA alone. Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        connectionId: immocloudIdSchema
          .describe("Bank connection ID from immocloud_list_bank_connections."),
        importNewAccounts: z
          .boolean()
          .default(false)
          .describe("Whether Immocloud should import newly found accounts."),
        forceChangeCredentials: z
          .boolean()
          .default(true)
          .describe("Set true for reconnect / credential refresh."),
        forceChangeAuthenticationMethod: z
          .boolean()
          .default(false)
          .describe("Force changing the authentication method."),
        addXs2aInterface: z
          .boolean()
          .default(false)
          .describe("Ask Immocloud/FinAPI to add XS2A interface."),
      },
      annotations: writeAnnotations,
    },
    async ({
      confirm,
      connectionId,
      importNewAccounts,
      forceChangeCredentials,
      forceChangeAuthenticationMethod,
      addXs2aInterface,
    }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const response = await client.post<unknown>(
          `/banking/connections/${encodeImmocloudId(connectionId, "Connection ID")}/import-bank-accounts`,
          {},
          {
            query: {
              importNewAccounts,
              forceChangeCredentials,
              forceChangeAuthenticationMethod,
              addXs2aInterface,
            },
          },
        );
        return {
          ok: true,
          action: "reconnect_bank_connection",
          connectionId,
          status: response.status,
          webform: extractWebFormHints(response.data),
        };
      }),
  );

  server.registerTool(
    "immocloud_start_bank_connection",
    {
      description:
        "Start a new Immocloud bank connection via POST /banking/connections. Pass the Immocloud/FinAPI import request body. Usually returns a webform URL for browser SCA. Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        body: jsonObjectSchema.describe(
          "BankConnectionImportRequest body expected by Immocloud (bank selection fields from /banking/banks).",
        ),
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, body }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const response = await client.post<unknown>(
          "/banking/connections",
          body,
        );
        return {
          ok: true,
          action: "start_bank_connection",
          status: response.status,
          webform: extractWebFormHints(response.data),
        };
      }),
  );

  server.registerTool(
    "immocloud_assign_bank_to_finance_transactions",
    {
      description:
        "Manually link a bank transaction to existing open rent/finance transactions (Immocloud “Umsatz offener Miete zuordnen” style) via PUT /finance/transactions/{bankTransactionId} with financeTransactionIds. Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        bankTransactionId: immocloudIdSchema
          .describe("Bank transaction ID to assign from."),
        financeTransactionIds: z
          .array(immocloudIdSchema)
          .min(1)
          .max(100)
          .describe(
            "Existing open rent/finance/deposit transaction IDs to link.",
          ),
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, bankTransactionId, financeTransactionIds }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const existing = await getFinanceTransaction(
          client,
          bankTransactionId,
        );
        const putBody = buildFinancePutBody(
          existing,
          { financeTransactionIds },
          {
            clearPayments: false,
            transactionId: bankTransactionId,
            mergeIdentity: false,
          },
        );
        let status: number | null = null;
        let recoveredAfterPutError = false;
        try {
          const response = await client.put<unknown>(
            `/finance/transactions/${encodeImmocloudId(bankTransactionId, "Bank transaction ID")}`,
            putBody,
          );
          status = response.status;
        } catch (error) {
          try {
            const afterError = await getFinanceTransaction(
              client,
              bankTransactionId,
            );
            assertPaymentsPreserved(existing, afterError, {
              clearPayments: false,
            });
            assertBankTransactionAssigned(afterError);
            recoveredAfterPutError = true;
          } catch {
            throw new Error(
              `Bank assignment failed and could not be verified: ${safeErrorMessage(error)}`,
            );
          }
        }

        const assigned = await getFinanceTransaction(
          client,
          bankTransactionId,
        );
        assertPaymentsPreserved(existing, assigned, {
          clearPayments: false,
        });
        assertBankTransactionAssigned(assigned);
        return {
          ok: true,
          action: "assign_bank_to_finance_transactions",
          bankTransactionId,
          financeTransactionIds,
          status,
          recoveredAfterPutError,
          paymentsPreserved: true,
          assignmentVerified: true,
          result: assigned,
        };
      }),
  );

  server.registerTool(
    "immocloud_book_bank_transaction",
    {
      description:
        "Manually book a bank transaction into one or more property/unit/cost allocations: creates finance transactions from the bank transaction template, then links them back with financeTransactionIds (Immocloud split/manual booking flow). For open Mietsollstellungen prefer immocloud_assign_bank_to_finance_transactions — booking creates a new finance row without AUTO_RENT month keys and can cause overnight duplicates. Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        bankTransactionId: immocloudIdSchema
          .describe("Source bank transaction ID."),
        allocations: z
          .array(allocationSchema)
          .min(1)
          .max(100)
          .describe(
            "One or more booking splits (property/unit/category + amount).",
          ),
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, bankTransactionId, allocations }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const bankTransaction = await getFinanceTransaction(
          client,
          bankTransactionId,
        );

        const created: unknown[] = [];
        const financeTransactionIds: string[] = [];
        let untrackedCreation = false;
        try {
          for (const allocation of allocations) {
            assertUnitBookingHasPeriodOrCategory(allocation);
            const body = stripFinanceCreateFields({
              ...bankTransaction,
              assignedPropertyIdList: allocation.propertyId
                ? [allocation.propertyId]
                : null,
              assignedUnitIdList: allocation.unitId ? [allocation.unitId] : null,
              assignedCostCategoryId: allocation.costCategoryId ?? null,
              allocable: allocation.allocable ?? false,
              accountingPeriod:
                allocation.allocable === true
                  ? (allocation.accountingPeriod ?? null)
                  : null,
              amount: allocation.amount,
            });
            delete body.payments;
            if (allocation.correspondingMonth !== undefined) {
              body.correspondingMonth = allocation.correspondingMonth;
            }
            if (allocation.correspondingYear !== undefined) {
              body.correspondingYear = allocation.correspondingYear;
            }
            if (allocation.vat !== undefined) body.vat = allocation.vat;
            if (allocation.vatAmountInPercent !== undefined) {
              body.vatAmountInPercent = allocation.vatAmountInPercent;
            }
            if (allocation.payments !== undefined) {
              body.payments = allocation.payments;
            }
            if (allocation.objectInfo !== undefined) {
              body.objectInfo = allocation.objectInfo;
            }
            assertRentCreateHasPeriod(body);

            let response: ImmocloudResponse<unknown>;
            try {
              response = await client.post<unknown>(
                "/finance/transactions",
                body,
              );
            } catch (error) {
              untrackedCreation = true;
              throw error;
            }
            const createdId = financeTransactionId(response.data);
            if (createdId === undefined) {
              untrackedCreation = true;
              throw new Error(
                "Immocloud created a finance transaction without returning a valid ID.",
              );
            }
            // Track immediately so catch-path rollback covers period-check failures.
            financeTransactionIds.push(createdId);
            const createdRow = await getFinanceTransaction(client, createdId);
            if (
              looksLikeRentTransaction(createdRow) &&
              !hasRentPeriod(createdRow)
            ) {
              throw new Error(
                "Immocloud created a rent-like booking without correspondingMonth/Year; " +
                  "rolling back to avoid AUTO_RENT duplicates.",
              );
            }
            created.push(createdRow);
          }
        } catch (error) {
          const rollback = await rollbackFinanceTransactions(
            client,
            financeTransactionIds,
          );
          throw new Error(
            `Booking creation failed after ${financeTransactionIds.length} split(s). ` +
              `Rolled back ${rollback.deleted.length}; rollback failures: ${rollback.failed.length}. ` +
              (untrackedCreation
                ? "One created split could not be tracked and may require manual cleanup. "
                : "") +
              safeErrorMessage(error),
          );
        }

        const linkBody = buildFinancePutBody(
          bankTransaction,
          { financeTransactionIds },
          {
            clearPayments: false,
            transactionId: bankTransactionId,
            mergeIdentity: false,
          },
        );
        let linkStatus: number | null = null;
        let recoveredAfterPutError = false;
        try {
          const linkResponse = await client.put<unknown>(
            `/finance/transactions/${encodeImmocloudId(bankTransactionId, "Bank transaction ID")}`,
            linkBody,
          );
          linkStatus = linkResponse.status;
          const linked = await getFinanceTransaction(
            client,
            bankTransactionId,
          );
          assertPaymentsPreserved(bankTransaction, linked, {
            clearPayments: false,
          });
          assertBankTransactionAssigned(linked);
        } catch (error) {
          let observed: Record<string, unknown> | undefined;
          try {
            observed = await getFinanceTransaction(
              client,
              bankTransactionId,
            );
            assertPaymentsPreserved(bankTransaction, observed, {
              clearPayments: false,
            });
            assertBankTransactionAssigned(observed);
            recoveredAfterPutError = true;
          } catch {
            if (observed !== undefined && assignmentDefinitelyAbsent(observed)) {
              const rollback = await rollbackFinanceTransactions(
                client,
                financeTransactionIds,
              );
              throw new Error(
                `Booking link failed. Rolled back ${rollback.deleted.length} created split(s); ` +
                  `rollback failures: ${rollback.failed.length}. ${safeErrorMessage(error)}`,
              );
            }
            throw new Error(
              `Booking may be partially complete. Created finance transaction IDs: ` +
                `${financeTransactionIds.join(", ")}. The bank assignment could not be ` +
                `verified, so the created rows were not deleted automatically. ` +
                safeErrorMessage(error),
            );
          }
        }

        const linked = await getFinanceTransaction(
          client,
          bankTransactionId,
        );
        assertPaymentsPreserved(bankTransaction, linked, {
          clearPayments: false,
        });
        assertBankTransactionAssigned(linked);

        return {
          ok: true,
          action: "book_bank_transaction",
          bankTransactionId,
          financeTransactionIds,
          status: linkStatus,
          recoveredAfterPutError,
          assignmentVerified: true,
          created,
          linked,
        };
      }),
  );

  server.registerTool(
    "immocloud_create_finance_transaction",
    {
      description:
        "Create a finance transaction via POST /finance/transactions. Pass a full Immocloud body (advanced/manual). Prefer immocloud_assign_bank_to_finance_transactions for open rents — do not create replacement Mietsollstellungen without correspondingMonth/Year (Immocloud will auto-generate duplicates). If body.payments is set, verifies the link survived create. Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        body: jsonObjectSchema,
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, body }) =>
      runTool(async () => {
        requireConfirm(confirm);
        assertRentCreateHasPeriod(body);
        const response = await client.post<Record<string, unknown>>(
          "/finance/transactions",
          stripFinanceCreateFields(body),
        );
        const created = response.data;
        const createdId = financeTransactionId(created);
        const requestedPayments = paymentList(body.payments);

        const verifyCreatedPeriod = (row: Record<string, unknown>): void => {
          if (
            (looksLikeRentTransaction(body) || looksLikeRentTransaction(row)) &&
            !hasRentPeriod(row)
          ) {
            throw new Error(
              "Created finance transaction is missing correspondingMonth/Year " +
                "after Immocloud create.",
            );
          }
        };

        try {
          if (requestedPayments.length > 0) {
            if (createdId === undefined) {
              throw new Error(
                "Created finance transaction has payments but no valid ID for verification.",
              );
            }
            const existing = await getFinanceTransaction(client, createdId);
            verifyCreatedPeriod(existing);
            if (paymentList(existing.payments).length > 0) {
              assertPaymentsPreserved(
                { payments: requestedPayments },
                existing,
                { clearPayments: false },
              );
              return {
                ok: true,
                action: "create_finance_transaction",
                status: response.status,
                paymentsRepaired: false,
                result: existing,
              };
            }

            // Some Immocloud creates drop payments; re-attach immediately.
            const putBody = buildFinancePutBody(
              existing,
              {
                payments: requestedPayments,
                markAsPaid: existing.markAsPaid ?? true,
              },
              {
                clearPayments: false,
                transactionId: createdId,
                mergeIdentity: true,
              },
            );
            const repaired = await client.put<Record<string, unknown>>(
              `/finance/transactions/${encodeImmocloudId(createdId, "Created transaction ID")}`,
              putBody,
            );
            const verified = await getFinanceTransaction(client, createdId);
            assertPaymentsPreserved(
              { payments: requestedPayments },
              verified,
              { clearPayments: false },
            );
            assertPeriodFieldsPreserved(existing, verified, {
              clearPeriodFields: false,
            });
            verifyCreatedPeriod(verified);
            return {
              ok: true,
              action: "create_finance_transaction",
              status: repaired.status,
              paymentsRepaired: true,
              result: verified,
            };
          }

          if (createdId !== undefined) {
            const verified = await getFinanceTransaction(client, createdId);
            verifyCreatedPeriod(verified);
            return {
              ok: true,
              action: "create_finance_transaction",
              status: response.status,
              result: verified,
            };
          }

          if (isRecord(created)) {
            verifyCreatedPeriod(created);
          }
          return {
            ok: true,
            action: "create_finance_transaction",
            status: response.status,
            result: created,
          };
        } catch (error) {
          if (createdId !== undefined) {
            const rollback = await rollbackFinanceTransactions(client, [
              createdId,
            ]);
            throw new Error(
              `${safeErrorMessage(error)} ` +
                (rollback.deleted.includes(createdId)
                  ? "Rolled back the created finance transaction."
                  : "Created finance transaction could not be rolled back; manual cleanup may be required."),
            );
          }
          throw error;
        }
      }),
  );

  server.registerTool(
    "immocloud_create_manual_finance_transaction",
    {
      description:
        "Create a manual finance transaction via POST /finance/transactions/manual (no bank turnover template). Rent-like bodies (subject Miete…) require correspondingMonth and correspondingYear — prefer assigning to existing AUTO_RENT. Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        body: jsonObjectSchema,
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, body }) =>
      runTool(async () => {
        requireConfirm(confirm);
        assertRentCreateHasPeriod(body);
        const response = await client.post<unknown>(
          "/finance/transactions/manual",
          stripFinanceCreateFields(body),
        );
        const created = response.data;
        const createdId = financeTransactionId(created);
        try {
          if (createdId !== undefined) {
            const verified = await getFinanceTransaction(client, createdId);
            if (
              (looksLikeRentTransaction(body) ||
                looksLikeRentTransaction(verified)) &&
              !hasRentPeriod(verified)
            ) {
              throw new Error(
                "Created manual finance transaction is missing correspondingMonth/Year " +
                  "after Immocloud create.",
              );
            }
            return {
              ok: true,
              action: "create_manual_finance_transaction",
              status: response.status,
              result: verified,
            };
          }
          if (isRecord(created)) {
            if (
              (looksLikeRentTransaction(body) ||
                looksLikeRentTransaction(created)) &&
              !hasRentPeriod(created)
            ) {
              throw new Error(
                "Created manual finance transaction is missing correspondingMonth/Year " +
                  "and returned no ID for cleanup.",
              );
            }
          } else if (looksLikeRentTransaction(body)) {
            throw new Error(
              "Created manual rent-like transaction without a parseable ID for period verification.",
            );
          }
          return {
            ok: true,
            action: "create_manual_finance_transaction",
            status: response.status,
            result: created,
          };
        } catch (error) {
          if (createdId !== undefined) {
            const rollback = await rollbackFinanceTransactions(client, [
              createdId,
            ]);
            throw new Error(
              `${safeErrorMessage(error)} ` +
                (rollback.deleted.includes(createdId)
                  ? "Rolled back the created finance transaction."
                  : "Created finance transaction could not be rolled back; manual cleanup may be required."),
            );
          }
          throw error;
        }
      }),
  );

  server.registerTool(
    "immocloud_update_finance_transaction",
    {
      description:
        "Update a finance/bank transaction via PUT /finance/transactions/{id}. Loads the existing row first, merges identity fields (unit/contact/category/dates/correspondingMonth|Year), and preserves payments[] unless clearPayments=true. Refuses clearing rent period fields unless clearPeriodFields=true (prevents AUTO_RENT duplicates). Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        transactionId: immocloudIdSchema,
        body: jsonObjectSchema,
        clearPayments: z
          .boolean()
          .default(false)
          .describe(
            "Set true only to intentionally clear payments[]. Default false preserves existing bank links.",
          ),
        clearPeriodFields: z
          .boolean()
          .default(false)
          .describe(
            "Set true only to intentionally clear correspondingMonth/Year or transactionDate/dueDate. Default false refuses clearing those on existing rows (Immocloud otherwise regenerates AUTO_RENT).",
          ),
      },
      annotations: writeAnnotations,
    },
    async ({
      confirm,
      transactionId,
      body,
      clearPayments,
      clearPeriodFields,
    }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const existing = await getFinanceTransaction(client, transactionId);
        const merged = buildFinancePutBody(existing, body, {
          clearPayments: clearPayments === true,
          clearPeriodFields: clearPeriodFields === true,
          transactionId,
          mergeIdentity: true,
        });
        const response = await client.put<unknown>(
          `/finance/transactions/${encodeImmocloudId(transactionId, "Transaction ID")}`,
          merged,
        );
        const updated = await getFinanceTransaction(client, transactionId);
        assertPaymentsPreserved(existing, updated, {
          clearPayments: clearPayments === true,
        });
        assertPeriodFieldsPreserved(existing, updated, {
          clearPeriodFields: clearPeriodFields === true,
        });
        if (
          clearPayments === true &&
          paymentList(updated.payments).length > 0
        ) {
          throw new Error(
            "Finance update requested payment unlinking, but payments[] is still non-empty.",
          );
        }
        return {
          ok: true,
          action: "update_finance_transaction",
          transactionId,
          status: response.status,
          paymentsPreserved:
            clearPayments !== true && paymentList(existing.payments).length > 0,
          periodPreserved: clearPeriodFields !== true,
          identityMerged: true,
          result: updated,
        };
      }),
  );

  server.registerTool(
    "immocloud_delete_finance_transaction",
    {
      description:
        "Delete a finance transaction via DELETE /finance/transactions/{id}. Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        transactionId: immocloudIdSchema,
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, transactionId }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const response = await client.delete<unknown>(
          `/finance/transactions/${encodeImmocloudId(transactionId, "Transaction ID")}`,
        );
        return {
          ok: true,
          action: "delete_finance_transaction",
          transactionId,
          status: response.status,
          result: response.data,
        };
      }),
  );
}
