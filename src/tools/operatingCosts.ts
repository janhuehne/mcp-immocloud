import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { ImmocloudConfig } from "../config.js";
import type { ImmocloudClient } from "../immocloud/client.js";
import {
  encodeImmocloudId,
  immocloudIdSchema,
} from "../immocloud/ids.js";
import {
  downloadAllOperatingCostPdfs,
  downloadOperatingCostExport,
  OPERATING_COST_EXPORT_FORMATS,
} from "../operatingCosts/download.js";
import { recalculateOperatingCost } from "../operatingCosts/recalculate.js";
import {
  DISTRIBUTION_KEY_TYPES,
  summarizeOperatingCostStatement,
  type DistributionKeyType,
} from "../operatingCosts/types.js";
import { boundedJsonObjectSchema } from "../security/input.js";
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
    "Must be true to execute this write. Prevents accidental Nebenkosten changes.",
  );

const jsonObjectSchema = boundedJsonObjectSchema.describe(
  "Bounded JSON object forwarded to Immocloud as the request body.",
);

const distributionKeySchema = z.object({
  type: z.enum(DISTRIBUTION_KEY_TYPES),
  id: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().max(200).optional(),
  measuringUnit: z.string().trim().max(50).optional(),
  note: z.string().trim().max(500).optional(),
});

function requireConfirm(confirm: true): void {
  if (confirm !== true) {
    throw new Error(
      "Write refused: pass confirm=true to modify Immocloud operating-cost statements.",
    );
  }
}

function defaultDistributionKey(
  type: DistributionKeyType,
): Record<string, unknown> {
  const names: Record<DistributionKeyType, { name: string; unit: string }> = {
    LIVING_SPACE: { name: "Wohnfläche", unit: "qm" },
    USABLE_FLOOR_SPACE: { name: "Nutzfläche", unit: "qm" },
    TOTAL_AREA: { name: "Gesamtfläche", unit: "qm" },
    HEATING_AREA: { name: "Heizfläche", unit: "qm" },
    COMBINED_HEATING_AREA: { name: "Heizfläche kombiniert", unit: "qm" },
    NO_OF_PERSONS: { name: "Personenanzahl", unit: "Pers." },
    UNITS: { name: "Einheiten", unit: "Einheiten" },
    CONSUMPTION: { name: "Verbrauch", unit: "Verbr." },
    OWNERSHIP: { name: "Miteigentumsanteil", unit: "MEA" },
    DIRECT: { name: "Direkt", unit: "Direkt" },
    CUSTOM: { name: "Benutzerdefiniert", unit: "" },
    COMPOSITE: { name: "Zusammengesetzt", unit: "" },
  };
  const meta = names[type];
  return {
    id: type,
    type,
    name: meta.name,
    measuringUnit: meta.unit,
    note: "",
    total: 0,
    unitDistributionKeys: {},
    components: [],
  };
}

/**
 * Immocloud BKA / Nebenkosten tools.
 *
 * Read: `/operatingcost/all`, `/operating-cost-v2/{id}`, validate-property,
 * PDF/DOCX/XLSX/ZIP download (`/operatingcost/{id}/pdf/{tenancyId}`, `/pdf/all`, …).
 * Write (banking flag): create (needs className CreateOperatingCostStatementDto —
 * auto-injected when omitted), update statement, add/update/delete cost entries,
 * calculate (default: refresh unit master data / MEA before calculate), delete.
 * Cost-entry unitIdList.tenantIdList must use tenancy IDs.
 */
export function registerOperatingCostTools(
  server: McpServer,
  config: ImmocloudConfig,
  client: ImmocloudClient,
): void {
  server.registerTool(
    "immocloud_list_operating_costs",
    {
      description:
        "List Immocloud operating-cost (Nebenkosten/BKA) statements via GET /operatingcost/all. Returns compact summaries; use immocloud_get_operating_cost for full detail.",
      inputSchema: {
        propertyId: immocloudIdSchema.optional().describe(
          "If set, only statements for this property are returned.",
        ),
        compact: z
          .boolean()
          .optional()
          .describe("If true (default), return summaries only."),
      },
      annotations: readAnnotations,
    },
    async ({ propertyId, compact }) =>
      runTool(async () => {
        const raw = await client.get<unknown>("/operatingcost/all");
        const page =
          typeof raw === "object" && raw !== null
            ? (raw as Record<string, unknown>)
            : {};
        const content = Array.isArray(page.content)
          ? page.content
          : Array.isArray(raw)
            ? raw
            : [];
        const filtered =
          propertyId === undefined
            ? content
            : content.filter((row) => {
                if (typeof row !== "object" || row === null) return false;
                return (
                  (row as Record<string, unknown>).propertyId === propertyId
                );
              });
        const useCompact = compact !== false;
        return {
          total: filtered.length,
          content: useCompact
            ? filtered
                .map(summarizeOperatingCostStatement)
                .filter((s): s is NonNullable<typeof s> => s !== null)
            : filtered,
        };
      }),
  );

  server.registerTool(
    "immocloud_get_operating_cost",
    {
      description:
        "Get one Immocloud operating-cost statement via GET /operating-cost-v2/{statementId} (full cost entries, unit results, prepaid totals).",
      inputSchema: {
        statementId: immocloudIdSchema.describe("Operating-cost statement ID."),
      },
      annotations: readAnnotations,
    },
    async ({ statementId }) =>
      runTool(() =>
        client.get<unknown>(
          `/operating-cost-v2/${encodeImmocloudId(statementId, "Statement ID")}`,
        ),
      ),
  );

  server.registerTool(
    "immocloud_validate_operating_cost_property",
    {
      description:
        "Validate property master data for Nebenkosten via GET /operatingcost/{propertyId}/validate-property (missing living space, prepaid costs, etc.).",
      inputSchema: {
        propertyId: immocloudIdSchema,
      },
      annotations: readAnnotations,
    },
    async ({ propertyId }) =>
      runTool(() =>
        client.get<unknown>(
          `/operatingcost/${encodeImmocloudId(propertyId, "Property ID")}/validate-property`,
        ),
      ),
  );

  server.registerTool(
    "immocloud_download_operating_cost_pdf",
    {
      description:
        "Download one Nebenkostenabrechnung export via GET /operatingcost/{statementId}/{format}/{tenancyId} (pdf|docx|xlsx|zip), or all=true for GET …/pdf/all (ZIP of all unit PDFs). Writes under ./downloads/ (subdir via outputDir). Read-only; does not finish or send the statement.",
      inputSchema: {
        statementId: immocloudIdSchema.describe("Operating-cost statement ID."),
        tenancyId: immocloudIdSchema
          .optional()
          .describe("Tenancy ID for a single-unit Abrechnung. Omit when all=true."),
        all: z
          .boolean()
          .optional()
          .describe(
            "If true, download the combined ZIP (pdf/all). Mutually exclusive with tenancyId.",
          ),
        format: z
          .enum(OPERATING_COST_EXPORT_FORMATS)
          .optional()
          .describe(
            'Export format for a single tenancy (default "pdf"). all=true only supports pdf (ZIP).',
          ),
        outputDir: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe(
            'Subdirectory under ./downloads/ (default "immocloud-bka"). Cannot escape downloads/.',
          ),
        filename: z
          .string()
          .trim()
          .min(1)
          .max(180)
          .optional()
          .describe("Optional filename (sanitized)."),
        unitName: z
          .string()
          .trim()
          .max(120)
          .optional()
          .describe("Optional label used in the default filename."),
        tenantName: z
          .string()
          .trim()
          .max(120)
          .optional()
          .describe("Optional label used in the default filename."),
      },
      annotations: readAnnotations,
    },
    async ({
      statementId,
      tenancyId,
      all,
      format,
      outputDir,
      filename,
      unitName,
      tenantName,
    }) =>
      runTool(() =>
        downloadOperatingCostExport(client, {
          statementId,
          format: format ?? "pdf",
          ...(tenancyId === undefined ? {} : { tenancyId }),
          ...(all === undefined ? {} : { all }),
          ...(outputDir === undefined ? {} : { outputDir }),
          ...(filename === undefined ? {} : { filename }),
          ...(unitName === undefined ? {} : { unitName }),
          ...(tenantName === undefined ? {} : { tenantName }),
        }),
      ),
  );

  server.registerTool(
    "immocloud_download_operating_cost_pdfs",
    {
      description:
        "Download every tenancy PDF for a BKA statement (from unitResultList) into ./downloads/, plus the Sammel-ZIP (pdf/all) unless includeZipAll=false. Use for reviewing all unit Abrechnungen of one statement (e.g. five RS810 apps). Read-only.",
      inputSchema: {
        statementId: immocloudIdSchema.describe("Operating-cost statement ID."),
        outputDir: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Subdirectory under ./downloads/ (default derived from statement title).",
          ),
        includeZipAll: z
          .boolean()
          .optional()
          .describe("Also download pdf/all ZIP (default true)."),
      },
      annotations: readAnnotations,
    },
    async ({ statementId, outputDir, includeZipAll }) =>
      runTool(() =>
        downloadAllOperatingCostPdfs(client, {
          statementId,
          ...(outputDir === undefined ? {} : { outputDir }),
          ...(includeZipAll === undefined ? {} : { includeZipAll }),
        }),
      ),
  );

  if (config.readOnly || !config.enableBankingWriteTools) {
    return;
  }

  server.registerTool(
    "immocloud_create_operating_cost",
    {
      description:
        "Create a Nebenkostenabrechnung via POST /operating-cost-v2 (falls back to POST /operatingcost). Body must include Jackson className (auto-set to CreateOperatingCostStatementDto when omitted), plus propertyId, startDate, endDate, type FULL|EASY, prepaidCostStrategy (e.g. ALL), unitIds, optional title. Without className Immocloud returns 7003. Requires banking write flag + confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        body: jsonObjectSchema,
        useLegacyPath: z
          .boolean()
          .optional()
          .describe(
            "If true, POST /operatingcost instead of /operating-cost-v2.",
          ),
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, body, useLegacyPath }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const path = useLegacyPath ? "/operatingcost" : "/operating-cost-v2";
        const payload =
          body &&
          typeof body === "object" &&
          !Array.isArray(body) &&
          (body as Record<string, unknown>).className === undefined
            ? {
                ...(body as Record<string, unknown>),
                className: "CreateOperatingCostStatementDto",
              }
            : body;
        const created = await client.post<unknown>(path, payload);
        return {
          ok: true,
          action: "create_operating_cost",
          path,
          summary: summarizeOperatingCostStatement(created.data),
          statement: created.data,
        };
      }),
  );

  server.registerTool(
    "immocloud_update_operating_cost",
    {
      description:
        "Update step-one fields of an operating-cost statement via PUT /operatingcost/{id} (unitIds, prepaidCostStrategy, dates, …). Requires banking write flag + confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        statementId: immocloudIdSchema,
        body: jsonObjectSchema,
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, statementId, body }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const id = encodeImmocloudId(statementId, "Statement ID");
        const updated = await client.put<unknown>(`/operatingcost/${id}`, body);
        return {
          ok: true,
          action: "update_operating_cost",
          statementId: id,
          summary: summarizeOperatingCostStatement(updated.data),
        };
      }),
  );

  server.registerTool(
    "immocloud_add_operating_cost_entry",
    {
      description:
        "Add a cost line to a BKA via POST /operating-cost-v2/{id}/costEntries. For WEG pass-through use distributionKey.type=DIRECT and unitIdList for the target unit. Requires banking write flag + confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        statementId: immocloudIdSchema,
        assignedCostCategoryId: z.number().int().positive(),
        value: z.number().finite(),
        vatAmountInPercent: z.number().min(0).max(100).optional(),
        tag: z.string().trim().max(200).optional(),
        description: z.string().trim().max(500).optional(),
        distributionKey: distributionKeySchema,
        unitId: immocloudIdSchema.optional().describe(
          "When set (typical for DIRECT), restricts the entry to this unit.",
        ),
        tenantIdList: z.array(immocloudIdSchema).max(20).optional(),
        body: jsonObjectSchema
          .optional()
          .describe(
            "Optional full Immocloud cost-entry body; overrides typed fields when set.",
          ),
      },
      annotations: writeAnnotations,
    },
    async ({
      confirm,
      statementId,
      assignedCostCategoryId,
      value,
      vatAmountInPercent,
      tag,
      description,
      distributionKey,
      unitId,
      tenantIdList,
      body,
    }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const id = encodeImmocloudId(statementId, "Statement ID");
        const dk = {
          ...defaultDistributionKey(distributionKey.type),
          ...distributionKey,
          id: distributionKey.id ?? distributionKey.type,
        };
        const payload =
          body ??
          ({
            assignedCostCategoryId,
            value,
            vatAmountInPercent: vatAmountInPercent ?? 0,
            tag,
            description,
            distributionKey: dk,
            objectRelatedEntry: false,
            meters: [],
            transactions: [],
            unitIdList: unitId
              ? [
                  {
                    unitId: encodeImmocloudId(unitId, "Unit ID"),
                    tenantIdList: tenantIdList ?? [],
                  },
                ]
              : [],
            externalAllocationOverrides: {},
          } satisfies Record<string, unknown>);
        const created = await client.post<unknown>(
          `/operating-cost-v2/${id}/costEntries`,
          payload,
        );
        return {
          ok: true,
          action: "add_operating_cost_entry",
          statementId: id,
          entry: created.data,
        };
      }),
  );

  server.registerTool(
    "immocloud_update_operating_cost_entry",
    {
      description:
        "Update one cost entry via PUT /operating-cost-v2/{statementId}/costEntries/{costEntryId}. Requires banking write flag + confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        statementId: immocloudIdSchema,
        costEntryId: immocloudIdSchema,
        body: jsonObjectSchema,
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, statementId, costEntryId, body }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const sid = encodeImmocloudId(statementId, "Statement ID");
        const eid = encodeImmocloudId(costEntryId, "Cost entry ID");
        const updated = await client.put<unknown>(
          `/operating-cost-v2/${sid}/costEntries/${eid}`,
          body,
        );
        return {
          ok: true,
          action: "update_operating_cost_entry",
          statementId: sid,
          costEntryId: eid,
          entry: updated.data,
        };
      }),
  );

  server.registerTool(
    "immocloud_delete_operating_cost_entry",
    {
      description:
        "Delete one cost entry via DELETE /operating-cost-v2/{statementId}/costEntries/{costEntryId}. Requires banking write flag + confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        statementId: immocloudIdSchema,
        costEntryId: immocloudIdSchema,
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, statementId, costEntryId }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const sid = encodeImmocloudId(statementId, "Statement ID");
        const eid = encodeImmocloudId(costEntryId, "Cost entry ID");
        await client.delete(
          `/operating-cost-v2/${sid}/costEntries/${eid}`,
        );
        return {
          ok: true,
          action: "delete_operating_cost_entry",
          statementId: sid,
          costEntryId: eid,
        };
      }),
  );

  server.registerTool(
    "immocloud_calculate_operating_cost",
    {
      description:
        "Recalculate a Nebenkostenabrechnung via PUT /operatingcost/{id}/calculate. By default first re-PUTs the statement’s unitIds (UpdateOperatingCostStatementDto) so MEA/Wohnfläche are reloaded from property master data — bare calculate alone keeps stale unit snapshots (e.g. wrong MEA). Set refreshUnitMasterData=false to only recalculate. Returns before/after unit MEA snapshots. Requires banking write flag + confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        statementId: immocloudIdSchema,
        refreshUnitMasterData: z
          .boolean()
          .optional()
          .describe(
            "If true (default), re-bind unitIds from property master data before calculate. Set false for calculate-only.",
          ),
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, statementId, refreshUnitMasterData }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const result = await recalculateOperatingCost(client, {
          statementId,
          ...(refreshUnitMasterData === undefined
            ? {}
            : { refreshUnitMasterData }),
        });
        return {
          ok: true,
          action: "calculate_operating_cost",
          statementId: result.statementId,
          refreshedUnitMasterData: result.refreshedUnitMasterData,
          ownershipShareChanges: result.ownershipShareChanges,
          unitsBefore: result.unitsBefore,
          unitsAfter: result.unitsAfter,
          summary: summarizeOperatingCostStatement(result.statement),
        };
      }),
  );

  server.registerTool(
    "immocloud_delete_operating_cost",
    {
      description:
        "Delete an operating-cost statement via DELETE /operatingcost/{id}. Use for drafts/corrections — not for finished statements you still need. Requires banking write flag + confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        statementId: immocloudIdSchema,
        deleteAssignedTransactions: z
          .boolean()
          .optional()
          .describe("Forwarded as query flag (default false)."),
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, statementId, deleteAssignedTransactions }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const id = encodeImmocloudId(statementId, "Statement ID");
        await client.delete(`/operatingcost/${id}`, {
          query: {
            deleteAssignedTransactions: deleteAssignedTransactions === true,
          },
        });
        return {
          ok: true,
          action: "delete_operating_cost",
          statementId: id,
        };
      }),
  );

}
