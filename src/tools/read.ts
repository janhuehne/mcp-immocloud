import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import {
  ImmocloudApiError,
  type ImmocloudClient,
} from "../immocloud/client.js";
import {
  encodeImmocloudId,
  immocloudIdSchema,
} from "../immocloud/ids.js";
import { runTool } from "./result.js";

const externalReadAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractCollection(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return [];
  }

  for (const key of ["content", "properties", "items", "data", "results"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
}

function propertyMatchesId(property: unknown, id: string): boolean {
  if (!isRecord(property)) {
    return false;
  }

  const candidates = [
    property.id,
    property.propertyId,
    property.propertyID,
    property.uuid,
  ];
  const nestedProperty = property.property;
  if (isRecord(nestedProperty)) {
    candidates.push(nestedProperty.id, nestedProperty.propertyId);
  }
  return candidates.some(
    (candidate) => candidate !== undefined && String(candidate) === id,
  );
}

async function getPropertyWithFallback(
  client: ImmocloudClient,
  id: string,
): Promise<unknown> {
  try {
    return await client.get<unknown>(
      `/properties/${encodeImmocloudId(id, "Property ID")}`,
    );
  } catch (error) {
    if (
      !(error instanceof ImmocloudApiError) ||
      (error.status !== 404 && error.status !== 405)
    ) {
      throw error;
    }
  }

  const fullList = await client.get<unknown>("/properties/full");
  const property = extractCollection(fullList).find((candidate) =>
    propertyMatchesId(candidate, id),
  );
  if (property === undefined) {
    throw new Error(
      `Property "${id}" was not found via /properties/{id} or /properties/full.`,
    );
  }
  return property;
}

export function registerReadTools(
  server: McpServer,
  client: ImmocloudClient,
): void {
  server.registerTool(
    "immocloud_get_profile",
    {
      description:
        "Get the authenticated Immocloud account profile. This may contain personal data.",
      annotations: externalReadAnnotations,
    },
    async () => runTool(() => client.get<unknown>("/profile")),
  );

  server.registerTool(
    "immocloud_list_properties",
    {
      description:
        "List Immocloud properties as a paginated Spring page.",
      inputSchema: paginationSchema,
      annotations: externalReadAnnotations,
    },
    async ({ page, size }) =>
      runTool(() =>
        client.get<unknown>("/properties/page", { page, size }),
      ),
  );

  server.registerTool(
    "immocloud_get_property",
    {
      description:
        "Get one Immocloud property by ID. Tries /properties/{id}, then falls back to the full property list.",
      inputSchema: {
        id: immocloudIdSchema.describe("Immocloud property ID."),
      },
      annotations: externalReadAnnotations,
    },
    async ({ id }) => runTool(() => getPropertyWithFallback(client, id)),
  );

  server.registerTool(
    "immocloud_list_tenancies",
    {
      description:
        "List paginated Immocloud tenancies and include the tenancy status counts summary.",
      inputSchema: paginationSchema,
      annotations: externalReadAnnotations,
    },
    async ({ page, size }) =>
      runTool(async () => {
        const [tenancies, counts] = await Promise.all([
          client.get<unknown>("/properties/tenancies/page", { page, size }),
          client.get<unknown>("/properties/tenancies/count"),
        ]);
        return { tenancies, counts };
      }),
  );

  server.registerTool(
    "immocloud_list_contacts",
    {
      description: "List Immocloud contacts with pagination.",
      inputSchema: paginationSchema,
      annotations: externalReadAnnotations,
    },
    async ({ page, size }) =>
      runTool(() => client.get<unknown>("/contacts", { page, size })),
  );

  server.registerTool(
    "immocloud_list_meters",
    {
      description: "List Immocloud meters.",
      annotations: externalReadAnnotations,
    },
    async () => runTool(() => client.get<unknown>("/meters")),
  );

  server.registerTool(
    "immocloud_list_documents",
    {
      description:
        "List Immocloud documents. Document metadata may contain personal or tenant data.",
      annotations: externalReadAnnotations,
    },
    async () => runTool(() => client.get<unknown>("/documents")),
  );

  server.registerTool(
    "immocloud_list_document_folders",
    {
      description:
        "Get the Immocloud root document folder structure.",
      annotations: externalReadAnnotations,
    },
    async () => runTool(() => client.get<unknown>("/documents/folder/root")),
  );

  server.registerTool(
    "immocloud_search",
    {
      description:
        "Search across Immocloud records. The query must contain at least two characters.",
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(2)
          .max(500)
          .describe("Search text (minimum two characters)."),
      },
      annotations: externalReadAnnotations,
    },
    async ({ query }) =>
      runTool(() => client.get<unknown>("/search/v2", { query })),
  );

  server.registerTool(
    "immocloud_list_activity",
    {
      description: "List the Immocloud account activity log.",
      annotations: externalReadAnnotations,
    },
    async () => runTool(() => client.get<unknown>("/activity-log")),
  );

  server.registerTool(
    "immocloud_list_notifications",
    {
      description:
        "List Immocloud notifications, optionally including notifications already marked as read.",
      inputSchema: {
        hideRead: z
          .boolean()
          .default(true)
          .describe("When true, omit notifications already marked as read."),
      },
      annotations: externalReadAnnotations,
    },
    async ({ hideRead }) =>
      runTool(() => client.get<unknown>("/notifications", { hideRead })),
  );
}
