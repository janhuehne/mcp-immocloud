import * as z from "zod/v4";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const MAX_BODY_BYTES = 128 * 1024;
const MAX_DEPTH = 12;
const MAX_ENTRIES = 2_000;
const MAX_ARRAY_LENGTH = 500;
const MAX_KEY_LENGTH = 128;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string().max(MAX_BODY_BYTES),
    z.array(jsonValueSchema).max(MAX_ARRAY_LENGTH),
    z.record(z.string().min(1).max(MAX_KEY_LENGTH), jsonValueSchema),
  ]),
);

function validateBounds(
  value: JsonValue,
  context: z.core.$RefinementCtx<JsonValue>,
): void {
  let entries = 0;
  let tooDeep = false;

  const visit = (entry: JsonValue, depth: number): void => {
    if (depth > MAX_DEPTH) {
      tooDeep = true;
      return;
    }
    if (Array.isArray(entry)) {
      entries += entry.length;
      for (const item of entry) {
        visit(item, depth + 1);
      }
      return;
    }
    if (entry !== null && typeof entry === "object") {
      const values = Object.values(entry);
      entries += values.length;
      for (const item of values) {
        visit(item, depth + 1);
      }
    }
  };
  visit(value, 0);

  if (tooDeep) {
    context.addIssue({
      code: "custom",
      message: `JSON body exceeds maximum depth ${MAX_DEPTH}.`,
    });
  }
  if (entries > MAX_ENTRIES) {
    context.addIssue({
      code: "custom",
      message: `JSON body exceeds maximum entry count ${MAX_ENTRIES}.`,
    });
  }

  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_BODY_BYTES) {
    context.addIssue({
      code: "custom",
      message: `JSON body exceeds ${MAX_BODY_BYTES} bytes.`,
    });
  }
}

function stripDangerousKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(stripDangerousKeys);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const clean: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!DANGEROUS_KEYS.has(key)) {
      clean[key] = stripDangerousKeys(entry);
    }
  }
  return clean;
}

export const boundedJsonValueSchema = jsonValueSchema
  .superRefine(validateBounds)
  .transform(stripDangerousKeys);

export const boundedJsonObjectSchema = z
  .record(z.string().min(1).max(MAX_KEY_LENGTH), jsonValueSchema)
  .superRefine(validateBounds)
  .transform((value) => stripDangerousKeys(value) as Record<string, JsonValue>)
  .describe(
    "Bounded JSON object. Prototype-mutating keys are stripped before use.",
  );
