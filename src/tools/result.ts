import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { ImmocloudApiError } from "../immocloud/client.js";
import {
  redactSensitive,
  safeErrorMessage,
} from "../security/redaction.js";

function serialize(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  return serialized === undefined ? "null" : serialized;
}

export function jsonResult(value: unknown): CallToolResult {
  const redacted = redactSensitive(value);
  return {
    content: [{ type: "text", text: serialize(redacted) }],
    structuredContent: { data: redacted },
  };
}

export function errorResult(error: unknown): CallToolResult {
  const message = safeErrorMessage(error);
  const metadata =
    error instanceof ImmocloudApiError
      ? {
          status: error.status ?? null,
          requestId: error.requestId ?? null,
        }
      : undefined;

  return {
    content: [
      {
        type: "text",
        text: serialize({
          error: message,
          ...(metadata === undefined ? {} : metadata),
        }),
      },
    ],
    isError: true,
  };
}

export async function runTool(
  operation: () => Promise<unknown> | unknown,
): Promise<CallToolResult> {
  try {
    return jsonResult(await operation());
  } catch (error) {
    return errorResult(error);
  }
}
