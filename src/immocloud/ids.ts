import * as z from "zod/v4";

const NUMERIC_ID = /^\d{1,20}$/;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const UUID_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isImmocloudId(value: string): boolean {
  const normalized = value.trim();
  return (
    normalized !== "." &&
    normalized !== ".." &&
    (NUMERIC_ID.test(normalized) ||
      OBJECT_ID.test(normalized) ||
      UUID_ID.test(normalized))
  );
}

export function normalizeImmocloudId(
  value: string,
  label = "Immocloud ID",
): string {
  const normalized = value.trim();
  if (!isImmocloudId(normalized)) {
    throw new Error(
      `${label} must be a numeric ID, 24-char hex ObjectId, or UUID.`,
    );
  }
  return normalized;
}

export function encodeImmocloudId(
  value: string,
  label?: string,
): string {
  return encodeURIComponent(normalizeImmocloudId(value, label));
}

export const immocloudIdSchema = z
  .string()
  .trim()
  .max(64)
  .refine(
    isImmocloudId,
    "Must be a numeric Immocloud ID, 24-char hex ObjectId, or UUID.",
  );
