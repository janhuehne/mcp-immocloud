const REDACTED = "[REDACTED]";
const MAX_REDACTION_DEPTH = 25;

const SENSITIVE_KEYS = new Set([
  "authorization",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "token",
  "password",
  "passcode",
  "secret",
  "clientsecret",
  "deviceid",
  "trusteddeviceid",
  "email",
  "emailaddress",
  "code",
  "verificationcode",
  "onetimecode",
  "otp",
  "challengeid",
]);

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function redactUrlParameters(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEYS.has(normalizedKey(key))) {
        url.searchParams.set(key, REDACTED);
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function redactSensitiveString(value: string): string {
  const urlRedacted = redactUrlParameters(value);
  return urlRedacted
    .replace(/\bBearer\s+[^\s"',}]+/gi, `Bearer ${REDACTED}`)
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      REDACTED,
    )
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      REDACTED,
    )
    .replace(
      /("(?:authorization|auth_?token|access_?token|refresh_?token|password|device_?id|email(?:address)?|verification_?code|code|challenge_?id)"\s*:\s*")[^"]*"/gi,
      `$1${REDACTED}"`,
    )
    .replace(
      /\b(authorization|auth_?token|access_?token|refresh_?token|password|device_?id|email(?:address)?|verification_?code|challenge_?id)\s*[:=]\s*[^\s,;]+/gi,
      `$1=${REDACTED}`,
    );
}

export function redactSensitive(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") {
    return redactSensitiveString(value);
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (depth >= MAX_REDACTION_DEPTH) {
    return "[MAX DEPTH]";
  }
  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitive(entry, depth + 1, seen));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEYS.has(normalizedKey(key))
      ? REDACTED
      : redactSensitive(entry, depth + 1, seen);
  }
  return redacted;
}

export function safeErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : `Unexpected error: ${String(error)}`;
  return redactSensitiveString(message);
}
