import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import {
  buildCreateCostCategoryBody,
  buildUpdateCostCategoryBody,
  COST_CATEGORY_TYPES,
  filterCostCategories,
  summarizeAccountChart,
  summarizeCostCategory,
  type CostCategoryType,
} from "../accountCharts/costCategories.js";
import type { ImmocloudConfig } from "../config.js";
import type { ImmocloudClient } from "../immocloud/client.js";
import {
  encodeImmocloudId,
  immocloudIdSchema,
} from "../immocloud/ids.js";
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

const confirmSchema = z
  .literal(true)
  .describe(
    "Must be true to execute this write. Prevents accidental Kontenrahmen changes.",
  );

const categoryTypeSchema = z.enum(COST_CATEGORY_TYPES);

const technicalIdSchema = z
  .number()
  .int()
  .positive()
  .describe(
    "Immocloud cost-category technicalId (numeric, e.g. 505). Not a Mongo ObjectId.",
  );

function requireConfirm(confirm: true): void {
  if (confirm !== true) {
    throw new Error(
      "Write refused: pass confirm=true to modify Immocloud account charts.",
    );
  }
}

async function loadAccountCharts(
  client: ImmocloudClient,
  includeRentRelatedCostCategories: boolean,
) {
  const raw = await client.get<unknown>("/account-charts", {
    includeRentRelatedCostCategories,
  });
  const list = Array.isArray(raw) ? raw : [];
  const charts = list
    .map(summarizeAccountChart)
    .filter((c): c is NonNullable<typeof c> => c !== null);
  if (charts.length === 0) {
    throw new Error("Immocloud returned no account charts.");
  }
  return charts;
}

async function resolveChartId(
  client: ImmocloudClient,
  accountChartId: string | undefined,
  includeRentRelatedCostCategories: boolean,
): Promise<string> {
  if (accountChartId) {
    return encodeImmocloudId(accountChartId, "Account chart ID");
  }
  const charts = await loadAccountCharts(
    client,
    includeRentRelatedCostCategories,
  );
  const preferred =
    charts.find((c) => c.defaultAccountChart) ?? charts[0];
  if (!preferred) {
    throw new Error("No Immocloud account chart available.");
  }
  return encodeImmocloudId(preferred.id, "Account chart ID");
}

export function registerAccountChartTools(
  server: McpServer,
  config: ImmocloudConfig,
  client: ImmocloudClient,
): void {
  server.registerTool(
    "immocloud_list_account_charts",
    {
      description:
        "List Immocloud Kontenrahmen (account charts) via GET /account-charts. Returns chart ids/names and summarized cost categories. Pass query/categoryType/customOnly to filter categories. Use includeRentRelatedCostCategories=true to include Miete/NK/Kaution categories.",
      inputSchema: {
        includeRentRelatedCostCategories: z
          .boolean()
          .default(false)
          .describe(
            "When true, includes rent-related cost categories (RENT_COST).",
          ),
        categoryType: categoryTypeSchema
          .optional()
          .describe("Optional filter by categoryType."),
        query: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .optional()
          .describe(
            "Optional case-insensitive filter on level1/level2/tag/technicalId.",
          ),
        customOnly: z
          .boolean()
          .default(false)
          .describe("When true, only non-default (custom) categories."),
        omitCategories: z
          .boolean()
          .default(false)
          .describe(
            "When true, return chart metadata + counts only (no category list).",
          ),
      },
      annotations: readAnnotations,
    },
    async ({
      includeRentRelatedCostCategories,
      categoryType,
      query,
      customOnly,
      omitCategories,
    }) =>
      runTool(async () => {
        const charts = await loadAccountCharts(
          client,
          includeRentRelatedCostCategories === true,
        );
        return {
          charts: charts.map((chart) => {
            const filtered = filterCostCategories(chart.costCategories, {
              ...(categoryType !== undefined ? { categoryType } : {}),
              ...(query !== undefined ? { query } : {}),
              customOnly: customOnly === true,
            });
            return {
              id: chart.id,
              name: chart.name,
              defaultAccountChart: chart.defaultAccountChart,
              costCategoryCount: chart.costCategoryCount,
              matchedCategoryCount: filtered.length,
              ...(omitCategories === true
                ? {}
                : { costCategories: filtered }),
            };
          }),
        };
      }),
  );

  server.registerTool(
    "immocloud_list_cost_categories",
    {
      description:
        "List cost categories for one Kontenrahmen (or the default chart). Prefer this over dumping the full chart when you only need categories. Filters: categoryType, query, customOnly.",
      inputSchema: {
        accountChartId: immocloudIdSchema
          .optional()
          .describe("Account chart ID; defaults to the default chart."),
        includeRentRelatedCostCategories: z.boolean().default(false),
        categoryType: categoryTypeSchema.optional(),
        query: z.string().trim().min(1).max(120).optional(),
        customOnly: z.boolean().default(false),
      },
      annotations: readAnnotations,
    },
    async ({
      accountChartId,
      includeRentRelatedCostCategories,
      categoryType,
      query,
      customOnly,
    }) =>
      runTool(async () => {
        const charts = await loadAccountCharts(
          client,
          includeRentRelatedCostCategories === true,
        );
        const chart = accountChartId
          ? charts.find((c) => c.id === accountChartId)
          : charts.find((c) => c.defaultAccountChart) ?? charts[0];
        if (!chart) {
          throw new Error(
            accountChartId
              ? `Account chart ${accountChartId} not found.`
              : "No Immocloud account chart available.",
          );
        }
        const costCategories = filterCostCategories(chart.costCategories, {
          ...(categoryType !== undefined ? { categoryType } : {}),
          ...(query !== undefined ? { query } : {}),
          customOnly: customOnly === true,
        });
        return {
          accountChartId: chart.id,
          accountChartName: chart.name,
          totalInChart: chart.costCategoryCount,
          matched: costCategories.length,
          costCategories,
        };
      }),
  );

  if (config.readOnly || !config.enableBankingWriteTools) {
    return;
  }

  server.registerTool(
    "immocloud_create_cost_category",
    {
      description:
        "Create a custom Immocloud cost category via POST /account-charts/{id}/cost-categories (UI: Einstellungen → Kontenrahmen). Use for labels Immocloud does not ship (e.g. Umbuchung Rücklage as OTHER_REVENUE + OTHER_EXPENSES pair). Requires banking write flag + confirm=true. Returns the new technicalId for finance booking.",
      inputSchema: {
        confirm: confirmSchema,
        accountChartId: immocloudIdSchema
          .optional()
          .describe("Account chart ID; defaults to the default chart."),
        categoryType: categoryTypeSchema.describe(
          "OTHER_REVENUE / OTHER_EXPENSES for Umbuchungen; OPERATING_COST for NK, etc.",
        ),
        level1: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .describe(
            "Parent group label, e.g. Sonstige Einnahmen / Sonstige Ausgaben.",
          ),
        level2: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .describe("Category name shown in booking UI."),
        tag: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .optional()
          .describe("Short tag; defaults to level2."),
        allocable: z
          .boolean()
          .default(false)
          .describe("Whether the category is umlagefähig."),
        vatRate: z
          .number()
          .finite()
          .min(0)
          .max(100)
          .default(0)
          .describe("VAT rate percent (0 for transfers)."),
        bookingAccountNumber: z
          .string()
          .trim()
          .min(1)
          .max(32)
          .optional()
          .describe("Optional DATEV/SKR booking account number."),
        distributionKey: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .optional()
          .describe("Optional distribution key when allocable."),
      },
      annotations: writeAnnotations,
    },
    async ({
      confirm,
      accountChartId,
      categoryType,
      level1,
      level2,
      tag,
      allocable,
      vatRate,
      bookingAccountNumber,
      distributionKey,
    }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const chartId = await resolveChartId(client, accountChartId, false);
        const body = buildCreateCostCategoryBody({
          categoryType: categoryType as CostCategoryType,
          level1,
          level2,
          ...(tag !== undefined ? { tag } : {}),
          allocable,
          vatRate,
          ...(bookingAccountNumber !== undefined
            ? { bookingAccountNumber }
            : {}),
          ...(distributionKey !== undefined ? { distributionKey } : {}),
        });
        const response = await client.post<unknown>(
          `/account-charts/${chartId}/cost-categories`,
          body,
        );
        const created = summarizeCostCategory(response.data) ?? response.data;
        return {
          ok: true,
          action: "create_cost_category",
          accountChartId: chartId,
          status: response.status,
          costCategory: created,
        };
      }),
  );

  server.registerTool(
    "immocloud_update_cost_category",
    {
      description:
        "Update a custom cost category via PUT /account-charts/{chartId}/cost-categories/{technicalId}. Path id is technicalId (number), not a Mongo id. Requires banking write flag + confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        accountChartId: immocloudIdSchema
          .optional()
          .describe("Account chart ID; defaults to the default chart."),
        technicalId: technicalIdSchema,
        body: z
          .object({
            level1: z.string().trim().min(1).max(120).optional(),
            level2: z.string().trim().min(1).max(120).optional(),
            tag: z.string().trim().min(1).max(80).optional(),
            allocable: z.boolean().optional(),
            vatRate: z.number().finite().min(0).max(100).optional(),
            bookingAccountNumber: z.string().trim().min(1).max(32).optional(),
            distributionKey: z.string().trim().min(1).max(64).optional(),
          })
          .describe("Partial category fields to update."),
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, accountChartId, technicalId, body }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const chartId = await resolveChartId(client, accountChartId, false);
        const patch = buildUpdateCostCategoryBody(body);
        const response = await client.put<unknown>(
          `/account-charts/${chartId}/cost-categories/${technicalId}`,
          patch,
        );
        return {
          ok: true,
          action: "update_cost_category",
          accountChartId: chartId,
          technicalId,
          status: response.status,
          result: summarizeCostCategory(response.data) ?? response.data,
        };
      }),
  );

  server.registerTool(
    "immocloud_delete_cost_category",
    {
      description:
        "Delete a custom cost category via DELETE /account-charts/{chartId}/cost-categories/{technicalId}. Fails if Immocloud still references the category. Requires banking write flag + confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        accountChartId: immocloudIdSchema.optional(),
        technicalId: technicalIdSchema,
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, accountChartId, technicalId }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const chartId = await resolveChartId(client, accountChartId, false);
        const response = await client.delete<unknown>(
          `/account-charts/${chartId}/cost-categories/${technicalId}`,
        );
        return {
          ok: true,
          action: "delete_cost_category",
          accountChartId: chartId,
          technicalId,
          status: response.status,
          result: response.data,
        };
      }),
  );
}
