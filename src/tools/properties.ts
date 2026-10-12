import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { ImmocloudConfig } from "../config.js";
import type { ImmocloudClient } from "../immocloud/client.js";
import {
  encodeImmocloudId,
  immocloudIdSchema,
} from "../immocloud/ids.js";
import {
  accountingFieldPresent,
  assertUnitAccountingApplied,
  buildPropertyAccountingPutBody,
  type UnitAccountingPatch,
  unitAccountingSnapshot,
} from "../properties/accounting.js";
import {
  assertTenancyPersonsApplied,
  buildTenancyPersonsPutBody,
} from "../properties/tenancyAccounting.js";
import { boundedJsonObjectSchema } from "../security/input.js";
import { runTool } from "./result.js";

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const confirmSchema = z
  .literal(true)
  .describe(
    "Must be true to execute this write. Prevents accidental property/unit changes.",
  );

const jsonObjectSchema = boundedJsonObjectSchema.describe(
  "Bounded JSON object forwarded to Immocloud as the request body.",
);

function requireConfirm(confirm: true): void {
  if (confirm !== true) {
    throw new Error(
      "Write refused: pass confirm=true to modify Immocloud property/unit data.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Immocloud's UI always sends `tenantIdList` alongside `tenantList`.
 * PUT/POST with only `tenantList` often yields empty tenants (create) or HTTP 500 (update).
 */
function withTenantIdList(body: Record<string, unknown>): Record<string, unknown> {
  const existing = body.tenantIdList;
  if (Array.isArray(existing) && existing.length > 0) {
    return body;
  }

  const tenantList = body.tenantList;
  if (!Array.isArray(tenantList) || tenantList.length === 0) {
    return body;
  }

  const tenantIdList = tenantList
    .map((tenant) => {
      if (typeof tenant === "string" && tenant.trim()) {
        return tenant.trim();
      }
      if (isRecord(tenant) && typeof tenant.id === "string" && tenant.id.trim()) {
        return tenant.id.trim();
      }
      return undefined;
    })
    .filter((id): id is string => id !== undefined);

  if (tenantIdList.length === 0) {
    return body;
  }

  return { ...body, tenantIdList };
}

/** Fields that must not be copied when cloning a unit as a create template. */
const UNIT_CLONE_STRIP_KEYS = new Set([
  "id",
  "unitId",
  "propertyId",
  "addressId",
  "currentTenanciesInfo",
  "tenancyInfoList",
  "unitRentsOpenAmount",
  "rentOpenAmount",
  "operatingCostOpenAmount",
  "otherReceivablesOpenAmount",
  "totalSpace",
  "archived",
  "notes",
  "customMeters",
  "purchaseCostList",
]);

const UNIT_WRITE_STRIP_KEYS = new Set([
  "id",
  "unitId",
  "propertyId",
  "addressId",
  "currentTenanciesInfo",
  "tenancyInfoList",
  "unitRentsOpenAmount",
  "rentOpenAmount",
  "operatingCostOpenAmount",
  "otherReceivablesOpenAmount",
]);

function stripUnitWriteFields(
  unit: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(unit)) {
    if (!UNIT_WRITE_STRIP_KEYS.has(key)) {
      body[key] = value;
    }
  }
  if (isRecord(body.address)) {
    const { id: _addressId, ...addressRest } = body.address;
    body.address = addressRest;
  }
  return body;
}

function stripUnitForCreate(
  unit: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(unit)) {
    if (UNIT_CLONE_STRIP_KEYS.has(key)) {
      continue;
    }
    body[key] = value;
  }

  // Nested address: keep structure but drop id so Immocloud can re-attach.
  if (isRecord(body.address)) {
    const { id: _addressId, ...addressRest } = body.address;
    body.address = addressRest;
  }

  if (Array.isArray(body.spaceHistory)) {
    body.spaceHistory = body.spaceHistory.map((entry) => {
      if (!isRecord(entry)) {
        return entry;
      }
      const { id: _id, ...rest } = entry;
      return rest;
    });
  }

  if (Array.isArray(body.owners)) {
    body.owners = body.owners.map((owner) => {
      if (!isRecord(owner)) {
        return owner;
      }
      return {
        id: owner.id,
        name: owner.name,
      };
    });
  }

  return body;
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      continue;
    }
    if (
      isRecord(value) &&
      isRecord(out[key]) &&
      !Array.isArray(value) &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function findCreatedUnit(
  property: unknown,
  previousUnitIds: Set<string>,
): unknown {
  if (!isRecord(property) || !Array.isArray(property.units)) {
    return undefined;
  }
  const units = property.units.filter(isRecord);
  const created = units.find(
    (unit) => typeof unit.id === "string" && !previousUnitIds.has(unit.id),
  );
  return created ?? units[units.length - 1];
}

async function loadTenancyForUpdate(
  client: ImmocloudClient,
  tenancyId: string,
  propertyId: string | undefined,
): Promise<Record<string, unknown>> {
  const encodedId = encodeImmocloudId(tenancyId, "Tenancy ID");
  try {
    const direct = await client.get<unknown>(`/tenancies/${encodedId}`);
    if (isRecord(direct) && direct.id === tenancyId) {
      return direct;
    }
  } catch {
    // Fall through to property list when direct GET is unsupported.
  }

  if (propertyId === undefined) {
    throw new Error(
      `Tenancy ${tenancyId} could not be loaded via GET /tenancies/{id}. Pass propertyId to resolve it from GET /tenancies/list/{propertyId}.`,
    );
  }

  const list = await client.get<unknown>(
    `/tenancies/list/${encodeImmocloudId(propertyId, "Property ID")}`,
  );
  const rows = Array.isArray(list)
    ? list
    : isRecord(list) && Array.isArray(list.content)
      ? list.content
      : [];
  const found = rows.find(
    (row) => isRecord(row) && row.id === tenancyId,
  );
  if (!isRecord(found)) {
    throw new Error(
      `Tenancy ${tenancyId} not found on property ${propertyId}.`,
    );
  }
  return found;
}

export function registerPropertyTools(
  server: McpServer,
  config: ImmocloudConfig,
  client: ImmocloudClient,
): void {
  server.registerTool(
    "immocloud_list_owner_names",
    {
      description:
        "List Immocloud Eigentümer contacts via GET /contacts/owner-names (ids usable as unit/property owners).",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => runTool(() => client.get<unknown>("/contacts/owner-names")),
  );

  server.registerTool(
    "immocloud_get_contact",
    {
      title: "Get Immocloud contact",
      description: "Get one contact via GET /contacts/{id}.",
      inputSchema: {
        id: immocloudIdSchema.describe("Contact ID."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id }) =>
      runTool(() =>
        client.get<unknown>(
          `/contacts/${encodeImmocloudId(id, "Contact ID")}`,
        ),
      ),
  );

  server.registerTool(
    "immocloud_list_property_tenancies",
    {
      title: "List property tenancies (detail)",
      description:
        "List detailed tenancies for a property via GET /tenancies/list/{propertyId} (full contracts, rents, deposits).",
      inputSchema: {
        propertyId: immocloudIdSchema.describe("Property ID."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ propertyId }) =>
      runTool(() =>
        client.get<unknown>(
          `/tenancies/list/${encodeImmocloudId(propertyId, "Property ID")}`,
        ),
      ),
  );

  if (config.readOnly || !config.enablePropertyWriteTools) {
    return;
  }

  server.registerTool(
    "immocloud_create_unit",
    {
      description:
        "Create a unit on a property via POST /properties/{propertyId}/units. Optionally cloneFromUnitId (loads /properties/units/{id}, strips identity fields, then merges body overrides). Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        propertyId: immocloudIdSchema
          .describe("Immocloud property ID that will own the new unit."),
        body: jsonObjectSchema.describe(
          "Create-unit DTO fields (full body, or overrides when cloneFromUnitId is set).",
        ),
        cloneFromUnitId: immocloudIdSchema
          .optional()
          .describe(
            "Optional existing unit ID to clone as template before applying body overrides.",
          ),
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, propertyId, body, cloneFromUnitId }) =>
      runTool(async () => {
        requireConfirm(confirm);

        const propertyBefore = await client.get<unknown>(
          `/properties/${encodeImmocloudId(propertyId, "Property ID")}`,
        );
        const previousUnitIds = new Set<string>();
        if (isRecord(propertyBefore) && Array.isArray(propertyBefore.units)) {
          for (const unit of propertyBefore.units) {
            if (isRecord(unit) && typeof unit.id === "string") {
              previousUnitIds.add(unit.id);
            }
          }
        }

        let createBody: Record<string, unknown> =
          stripUnitWriteFields(body);
        if (cloneFromUnitId !== undefined) {
          const template = await client.get<unknown>(
            `/properties/units/${encodeImmocloudId(cloneFromUnitId, "Clone unit ID")}`,
          );
          if (!isRecord(template)) {
            throw new Error(
              `cloneFromUnitId "${cloneFromUnitId}" did not return a unit object.`,
            );
          }
          createBody = stripUnitWriteFields(
            deepMerge(stripUnitForCreate(template), body),
          );
        }

        const response = await client.post<unknown>(
          `/properties/${encodeImmocloudId(propertyId, "Property ID")}/units`,
          createBody,
        );

        const createdUnit = findCreatedUnit(response.data, previousUnitIds);
        return {
          action: "create_unit",
          propertyId,
          cloneFromUnitId: cloneFromUnitId ?? null,
          createdUnit,
          property: response.data,
        };
      }),
  );

  server.registerTool(
    "immocloud_update_rent_bank_account",
    {
      title: "Update Mieteingangskonto (Abrechnungsdaten Bankkonto)",
      description:
        "Set the rent-receipt bank account shown under Abrechnungsdaten → Bankkonto (Kontoinhaber / IBAN / BIC). Scope: property (PUT /properties/{id}), one unit (PUT unit), or all units on a property. Loads existing first, merges bankAccount, verifies. Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        propertyId: immocloudIdSchema.describe("Property ID."),
        unitId: immocloudIdSchema
          .optional()
          .describe(
            "Optional unit ID. Omit with applyToAllUnits=false to set property-level bank only.",
          ),
        applyToAllUnits: z
          .boolean()
          .default(false)
          .describe(
            "If true, set the same bankAccount on every unit of the property (and property-level).",
          ),
        ownerName: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe("Kontoinhaber."),
        iban: z
          .string()
          .trim()
          .min(15)
          .max(34)
          .describe("IBAN (spaces optional)."),
        bic: z
          .string()
          .trim()
          .min(8)
          .max(11)
          .describe("BIC."),
      },
      annotations: writeAnnotations,
    },
    async ({
      confirm,
      propertyId,
      unitId,
      applyToAllUnits,
      ownerName,
      iban,
      bic,
    }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const bankAccount = {
          ownerName,
          iban: iban.replace(/\s+/g, "").toUpperCase(),
          bic: bic.replace(/\s+/g, "").toUpperCase(),
        };
        const encodedPropertyId = encodeImmocloudId(
          propertyId,
          "Property ID",
        );

        const results: Array<{
          scope: string;
          id: string;
          name: string | null;
          bankAccount: Record<string, unknown> | null;
        }> = [];

        const setPropertyBank = async (): Promise<void> => {
          const existing = await client.get<unknown>(
            `/properties/${encodedPropertyId}`,
          );
          if (!isRecord(existing)) {
            throw new Error(`Property ${propertyId} not found.`);
          }
          const body: Record<string, unknown> = {
            ...existing,
            bankAccount,
          };
          for (const key of [
            "averageColdRent",
            "totalColdRent",
            "squareMeterPriceForLivingSpace",
            "numberOfUnitsPerType",
            "unitAmount",
            "totalLivingSpace",
            "hasRentUpdateDraft",
          ]) {
            delete body[key];
          }
          await client.put(`/properties/${encodedPropertyId}`, body);
          const updated = await client.get<unknown>(
            `/properties/${encodedPropertyId}`,
          );
          if (!isRecord(updated)) {
            throw new Error("Property missing after bank account update.");
          }
          const got = isRecord(updated.bankAccount)
            ? updated.bankAccount
            : null;
          if (
            !got ||
            got.iban !== bankAccount.iban ||
            got.ownerName !== bankAccount.ownerName
          ) {
            throw new Error(
              "Property bankAccount not persisted after PUT /properties/{id}.",
            );
          }
          results.push({
            scope: "property",
            id: propertyId,
            name: typeof updated.name === "string" ? updated.name : null,
            bankAccount: got,
          });
        };

        const setUnitBank = async (targetUnitId: string): Promise<void> => {
          const encodedUnitId = encodeImmocloudId(targetUnitId, "Unit ID");
          const existing = await client.get<unknown>(
            `/properties/units/${encodedUnitId}`,
          );
          if (!isRecord(existing)) {
            throw new Error(`Unit ${targetUnitId} not found.`);
          }
          const merged = stripUnitWriteFields({
            ...stripUnitWriteFields(existing),
            bankAccount,
          });
          await client.put(
            `/properties/${encodedPropertyId}/units/${encodedUnitId}`,
            merged,
          );
          const updated = await client.get<unknown>(
            `/properties/units/${encodedUnitId}`,
          );
          if (!isRecord(updated)) {
            throw new Error(`Unit ${targetUnitId} missing after bank update.`);
          }
          const got = isRecord(updated.bankAccount)
            ? updated.bankAccount
            : null;
          if (
            !got ||
            got.iban !== bankAccount.iban ||
            got.ownerName !== bankAccount.ownerName
          ) {
            throw new Error(
              `Unit ${targetUnitId} bankAccount not persisted after unit PUT.`,
            );
          }
          results.push({
            scope: "unit",
            id: targetUnitId,
            name: typeof updated.name === "string" ? updated.name : null,
            bankAccount: got,
          });
        };

        if (applyToAllUnits === true) {
          await setPropertyBank();
          const property = await client.get<unknown>(
            `/properties/${encodedPropertyId}`,
          );
          if (!isRecord(property) || !Array.isArray(property.units)) {
            throw new Error("Property units missing.");
          }
          for (const unit of property.units) {
            if (isRecord(unit) && typeof unit.id === "string") {
              await setUnitBank(unit.id);
            }
          }
        } else if (unitId !== undefined) {
          await setUnitBank(unitId);
        } else {
          await setPropertyBank();
        }

        return {
          ok: true,
          action: "update_rent_bank_account",
          propertyId,
          results,
        };
      }),
  );

  server.registerTool(
    "immocloud_update_unit_accounting",
    {
      title: "Update unit Abrechnungsdaten (MEA / Wohnfläche)",
      description:
        "Set Immocloud Abrechnungsdaten (Miteigentumsanteil / Wohnfläche) the way the UI does: GET property → patch units[] → PUT /properties/{id} → verify. Unit PUT alone does NOT persist ownershipShareValue. Prefer this over immocloud_update_unit for MEA. Returns a compact before/after summary. Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        propertyId: immocloudIdSchema.describe("Property ID."),
        units: z
          .array(
            z.object({
              unitId: immocloudIdSchema.describe("Unit to patch."),
              ownershipShareValue: z
                .number()
                .min(0)
                .max(100_000)
                .optional()
                .describe(
                  "Miteigentumsanteil (e.g. 41.985 for 41,985/10.000 from Hausgeld).",
                ),
              livingSpace: z
                .number()
                .min(0)
                .max(100_000)
                .optional()
                .describe("Wohnfläche m²."),
              usableFloorSpace: z
                .number()
                .min(0)
                .max(100_000)
                .optional()
                .describe("Nutzfläche m² (defaults with livingSpace when set)."),
              additionalHeatingArea: z
                .number()
                .min(0)
                .max(100_000)
                .optional()
                .describe("Optional additional heating area m²."),
            }),
          )
          .min(1)
          .max(200)
          .describe("One or more unit Abrechnungsdaten patches."),
        ownershipShareOther: z
          .number()
          .min(0)
          .max(100_000)
          .optional()
          .describe("Optional MEA portion not on owned units (UI: Sonstige)."),
        ownershipShareDistributionKeyNote: z
          .string()
          .max(2000)
          .optional()
          .describe("Optional note on the MEA distribution key."),
      },
      annotations: writeAnnotations,
    },
    async ({
      confirm,
      propertyId,
      units,
      ownershipShareOther,
      ownershipShareDistributionKeyNote,
    }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const patches: UnitAccountingPatch[] = units.map((unit) => {
          const patch: UnitAccountingPatch = { unitId: unit.unitId };
          if (unit.ownershipShareValue !== undefined) {
            patch.ownershipShareValue = unit.ownershipShareValue;
          }
          if (unit.livingSpace !== undefined) {
            patch.livingSpace = unit.livingSpace;
          }
          if (unit.usableFloorSpace !== undefined) {
            patch.usableFloorSpace = unit.usableFloorSpace;
          }
          if (unit.additionalHeatingArea !== undefined) {
            patch.additionalHeatingArea = unit.additionalHeatingArea;
          }
          return patch;
        });
        for (const patch of patches) {
          if (!accountingFieldPresent(patch)) {
            throw new Error(
              `Unit ${patch.unitId}: set at least one of ownershipShareValue, livingSpace, usableFloorSpace, additionalHeatingArea.`,
            );
          }
        }

        const encodedPropertyId = encodeImmocloudId(
          propertyId,
          "Property ID",
        );
        const existing = await client.get<unknown>(
          `/properties/${encodedPropertyId}`,
        );
        if (!isRecord(existing)) {
          throw new Error(`Property ${propertyId} not found.`);
        }

        const options: {
          ownershipShareOther?: number;
          ownershipShareDistributionKeyNote?: string;
        } = {};
        if (ownershipShareOther !== undefined) {
          options.ownershipShareOther = ownershipShareOther;
        }
        if (ownershipShareDistributionKeyNote !== undefined) {
          options.ownershipShareDistributionKeyNote =
            ownershipShareDistributionKeyNote;
        }

        const { body, before, expected } = buildPropertyAccountingPutBody(
          existing,
          patches,
          options,
        );

        await client.put<unknown>(`/properties/${encodedPropertyId}`, body);

        const updated = await client.get<unknown>(
          `/properties/${encodedPropertyId}`,
        );
        if (!isRecord(updated)) {
          throw new Error(
            `Property ${propertyId} missing after Abrechnungsdaten update.`,
          );
        }
        const after = assertUnitAccountingApplied(updated, expected);

        return {
          ok: true,
          action: "update_unit_accounting",
          propertyId,
          before,
          after,
          ownershipShareOther:
            typeof updated.ownershipShareOther === "number"
              ? updated.ownershipShareOther
              : null,
        };
      }),
  );

  server.registerTool(
    "immocloud_update_tenancy_persons",
    {
      title: "Update tenancy Personenanzahl",
      description:
        "Set Abrechnungsdaten Personenanzahl on a tenancy (numberOfTenants history). Loads the tenancy (GET /tenancies/{id}, or from property list when propertyId is set) → merge → PUT with tenantIdList preserved → verify. Use 0 for Garagen/TG. Returns a compact summary. Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        tenancyId: immocloudIdSchema.describe("Tenancy ID."),
        propertyId: immocloudIdSchema
          .optional()
          .describe(
            "Optional property ID — used to load the tenancy from GET /tenancies/list/{propertyId} when direct GET /tenancies/{id} is unavailable.",
          ),
        numberOfTenants: z
          .array(
            z.object({
              startDate: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .describe("YYYY-MM-DD (usually contractStart)."),
              numberOfTenants: z
                .number()
                .int()
                .min(0)
                .max(100)
                .describe("Personenanzahl; 0 for parking/TG units."),
            }),
          )
          .min(1)
          .max(50)
          .describe("Personenanzahl history entries."),
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, tenancyId, propertyId, numberOfTenants }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const encodedId = encodeImmocloudId(tenancyId, "Tenancy ID");
        const existing = await loadTenancyForUpdate(
          client,
          tenancyId,
          propertyId,
        );

        const before = Array.isArray(existing.numberOfTenants)
          ? existing.numberOfTenants
          : [];
        const body = withTenantIdList(
          buildTenancyPersonsPutBody(existing, numberOfTenants),
        );
        await client.put<unknown>(`/tenancies/${encodedId}`, body);

        const updated = await loadTenancyForUpdate(
          client,
          tenancyId,
          propertyId,
        );
        const after = assertTenancyPersonsApplied(updated, numberOfTenants);

        return {
          ok: true,
          action: "update_tenancy_persons",
          tenancyId,
          unitId: typeof updated.unitId === "string" ? updated.unitId : null,
          before,
          after,
        };
      }),
  );

  server.registerTool(
    "immocloud_update_unit",
    {
      description:
        "Update unit master data via PUT /properties/{propertyId}/units/{unitId}. Loads the unit first and merges body (safe partial patch). For Miteigentumsanteil / Wohnfläche Abrechnungsdaten use immocloud_update_unit_accounting instead — unit PUT does not persist ownershipShareValue. Returns a compact unit summary, not the full property. Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        propertyId: immocloudIdSchema.describe("Property ID."),
        unitId: immocloudIdSchema.describe("Unit ID to update."),
        body: jsonObjectSchema.describe(
          "Partial or full unit fields to merge (name, floor, rooms, equipmentList, …). Do not use for ownershipShareValue — use immocloud_update_unit_accounting.",
        ),
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, propertyId, unitId, body }) =>
      runTool(async () => {
        requireConfirm(confirm);
        if (
          Object.prototype.hasOwnProperty.call(body, "ownershipShareValue") ||
          Object.prototype.hasOwnProperty.call(body, "livingSpace") ||
          Object.prototype.hasOwnProperty.call(body, "usableFloorSpace")
        ) {
          throw new Error(
            "For Abrechnungsdaten (ownershipShareValue / livingSpace / usableFloorSpace) use immocloud_update_unit_accounting — Immocloud only persists MEA via PUT /properties/{id}.",
          );
        }

        const encodedPropertyId = encodeImmocloudId(
          propertyId,
          "Property ID",
        );
        const encodedUnitId = encodeImmocloudId(unitId, "Unit ID");
        const existing = await client.get<unknown>(
          `/properties/units/${encodedUnitId}`,
        );
        if (!isRecord(existing)) {
          throw new Error(`Unit ${unitId} not found.`);
        }

        const merged = stripUnitWriteFields(
          deepMerge(stripUnitWriteFields(existing), body),
        );
        await client.put<unknown>(
          `/properties/${encodedPropertyId}/units/${encodedUnitId}`,
          merged,
        );

        const updated = await client.get<unknown>(
          `/properties/units/${encodedUnitId}`,
        );
        if (!isRecord(updated)) {
          throw new Error(`Unit ${unitId} missing after update.`);
        }

        return {
          ok: true,
          action: "update_unit",
          propertyId,
          unitId,
          unit: unitAccountingSnapshot(updated),
          name: typeof updated.name === "string" ? updated.name : null,
          unitType:
            typeof updated.unitType === "string" ? updated.unitType : null,
          floor: typeof updated.floor === "number" ? updated.floor : null,
          unitState:
            typeof updated.unitState === "string" ? updated.unitState : null,
        };
      }),
  );

  server.registerTool(
    "immocloud_update_property_management",
    {
      description:
        "Set property/unit management contacts (Eigentümer etc.) via PUT /properties/management?propertyId=&unitId=. Body is Immocloud’s contact list: [{ contactId, role, primary }]. role is typically OWNER. Omitting unitId updates property-level owners. Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        propertyId: immocloudIdSchema.describe("Property ID."),
        unitId: immocloudIdSchema
          .optional()
          .describe("Optional unit ID; omit for property-level management."),
        contacts: z
          .array(
            z.object({
              contactId: immocloudIdSchema,
              role: z
                .string()
                .trim()
                .min(1)
                .max(64)
                .describe('Management role, e.g. "OWNER".'),
              primary: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(100)
          .describe("Replacement management-contact list for the scope."),
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, propertyId, unitId, contacts }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const query: Record<string, string> = { propertyId };
        if (unitId !== undefined) {
          query.unitId = unitId;
        }
        const body = contacts.map((contact) => ({
          contactId: contact.contactId,
          role: contact.role,
          primary: contact.primary ?? false,
        }));
        const response = await client.put<unknown>(
          "/properties/management",
          body,
          { query },
        );
        return {
          action: "update_property_management",
          propertyId,
          unitId: unitId ?? null,
          result: response.data,
        };
      }),
  );

  server.registerTool(
    "immocloud_create_contact",
    {
      title: "Create Immocloud contact",
      description:
        "Create a contact via POST /contacts (e.g. tenant PERSON with companyType TENANT). Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        body: jsonObjectSchema.describe(
          "Immocloud contact create body (contactType, firstname/lastname or companyName, address, contactBankAccount, companyType, …).",
        ),
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, body }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const response = await client.post<unknown>("/contacts", body);
        return {
          action: "create_contact",
          contact: response.data,
        };
      }),
  );

  server.registerTool(
    "immocloud_create_tenancy",
    {
      title: "Create Immocloud tenancy",
      description:
        "Create a tenancy on a unit via POST /tenancies/{unitId}. Pass Immocloud body (contractStart, contractType, tenantList and/or tenantIdList, rents[], deposit, …). If tenantList has contacts with id, tenantIdList is derived automatically (required by Immocloud; UI always sends it). Optional markedPaidDate marks rents paid through that date when supported. Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        unitId: immocloudIdSchema.describe("Unit ID that owns the new tenancy."),
        body: jsonObjectSchema.describe(
          "Immocloud tenancy create DTO (see GET /tenancies/list/{propertyId} for shape). Prefer tenantIdList: [contactId] or tenantList: [{ id }].",
        ),
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, unitId, body }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const response = await client.post<unknown>(
          `/tenancies/${encodeImmocloudId(unitId, "Unit ID")}`,
          withTenantIdList(body),
        );
        return {
          action: "create_tenancy",
          unitId,
          tenancy: response.data,
        };
      }),
  );

  server.registerTool(
    "immocloud_update_tenancy",
    {
      title: "Update Immocloud tenancy",
      description:
        "Update a tenancy via PUT /tenancies/{tenancyId}. Pass a full Immocloud tenancy body. If tenantList has contacts with id, tenantIdList is derived automatically (Immocloud ignores tenantList alone and may 500). Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        tenancyId: immocloudIdSchema.describe("Tenancy ID."),
        body: jsonObjectSchema.describe(
          "Immocloud tenancy update DTO. Include tenantIdList: [contactId] when assigning tenants (or tenantList with id; MCP fills tenantIdList).",
        ),
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, tenancyId, body }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const response = await client.put<unknown>(
          `/tenancies/${encodeImmocloudId(tenancyId, "Tenancy ID")}`,
          withTenantIdList(body),
        );
        return {
          action: "update_tenancy",
          tenancyId,
          tenancy: response.data,
        };
      }),
  );

  server.registerTool(
    "immocloud_mark_unit_rents_paid",
    {
      title: "Mark all unit rents paid",
      description:
        "Mark all open rents for a unit as paid via POST /properties/units/{unitId}/markAllAsPaid (no bank assignment). Does not clear rent period fields; prefer immocloud_assign_bank_to_finance_transactions when a bank turnover exists. Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        unitId: immocloudIdSchema.describe("Unit ID."),
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, unitId }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const response = await client.post<unknown>(
          `/properties/units/${encodeImmocloudId(unitId, "Unit ID")}/markAllAsPaid`,
          null,
        );
        return {
          action: "mark_unit_rents_paid",
          unitId,
          result: response.data ?? null,
        };
      }),
  );
}
