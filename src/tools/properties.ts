import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { ImmocloudConfig } from "../config.js";
import type { ImmocloudClient } from "../immocloud/client.js";
import {
  encodeImmocloudId,
  immocloudIdSchema,
} from "../immocloud/ids.js";
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
    "immocloud_update_unit",
    {
      description:
        "Update a unit via PUT /properties/{propertyId}/units/{unitId}. Pass the Immocloud update body. Requires confirm=true.",
      inputSchema: {
        confirm: confirmSchema,
        propertyId: immocloudIdSchema.describe("Property ID."),
        unitId: immocloudIdSchema.describe("Unit ID to update."),
        body: jsonObjectSchema.describe("Update-unit DTO for Immocloud."),
      },
      annotations: writeAnnotations,
    },
    async ({ confirm, propertyId, unitId, body }) =>
      runTool(async () => {
        requireConfirm(confirm);
        const response = await client.put<unknown>(
          `/properties/${encodeImmocloudId(propertyId, "Property ID")}/units/${encodeImmocloudId(unitId, "Unit ID")}`,
          stripUnitWriteFields(body),
        );
        return {
          action: "update_unit",
          propertyId,
          unitId,
          result: response.data,
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
}
