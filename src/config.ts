export type ImmocloudAuthMode = "token" | "oauth";

export interface ImmocloudOAuthConfig {
  clientId: string | undefined;
  redirectUri: string | undefined;
  scopes: readonly string[];
}

export interface ImmocloudConfig {
  authMode: ImmocloudAuthMode;
  baseUrl: string;
  whiteLabel: string;
  authToken: string | undefined;
  deviceId: string | undefined;
  email: string | undefined;
  password: string | undefined;
  enableLoginTools: boolean;
  readOnly: boolean;
  enableBankingWriteTools: boolean;
  enablePropertyWriteTools: boolean;
  requestTimeoutMs: number;
  oauth: ImmocloudOAuthConfig;
}

export const DEFAULT_BASE_URL = "https://app.immocloud.de/api";
export const DEFAULT_WHITELABEL = "IMMOCLOUD";
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseAuthMode(value: string | undefined): ImmocloudAuthMode {
  const mode = optionalTrimmed(value)?.toLowerCase() ?? "token";
  if (mode !== "token" && mode !== "oauth") {
    throw new Error('IMMOCLOUD_AUTH_MODE must be "token" or "oauth".');
  }
  return mode;
}

function parseBoolean(
  name: string,
  value: string | undefined,
  fallback: boolean,
): boolean {
  const normalized = optionalTrimmed(value)?.toLowerCase();
  if (normalized === undefined) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`${name} must be true or false.`);
}

function parsePositiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (optionalTrimmed(value) === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseBaseUrl(value: string | undefined): string {
  const raw = optionalTrimmed(value) ?? DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("IMMOCLOUD_BASE_URL is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("IMMOCLOUD_BASE_URL must use https.");
  }
  if (url.username || url.password) {
    throw new Error("IMMOCLOUD_BASE_URL must not contain user information.");
  }
  if (url.search || url.hash) {
    throw new Error("IMMOCLOUD_BASE_URL must not contain a query or fragment.");
  }
  if (
    url.hostname.toLowerCase() !== "app.immocloud.de" ||
    url.port !== "" ||
    url.pathname.replace(/\/+$/, "") !== "/api"
  ) {
    throw new Error(
      `IMMOCLOUD_BASE_URL is pinned to ${DEFAULT_BASE_URL}.`,
    );
  }
  return DEFAULT_BASE_URL;
}

function parseAuthToken(value: string | undefined): string | undefined {
  const token = optionalTrimmed(value);
  if (token === undefined) {
    return undefined;
  }
  if (!/^Bearer\s+\S+$/i.test(token)) {
    throw new Error(
      'IMMOCLOUD_AUTH_TOKEN must be the complete Authorization value, including the "Bearer " prefix.',
    );
  }
  return token;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): ImmocloudConfig {
  const authMode = parseAuthMode(env.IMMOCLOUD_AUTH_MODE);
  const readOnly = parseBoolean(
    "IMMOCLOUD_READ_ONLY",
    env.IMMOCLOUD_READ_ONLY,
    false,
  );
  const privateApiEnabled = authMode === "token";
  const whiteLabel =
    optionalTrimmed(env.IMMOCLOUD_WHITELABEL) ?? DEFAULT_WHITELABEL;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(whiteLabel)) {
    throw new Error(
      "IMMOCLOUD_WHITELABEL must contain 1-64 letters, digits, underscores, or hyphens.",
    );
  }

  return {
    authMode,
    baseUrl: parseBaseUrl(env.IMMOCLOUD_BASE_URL),
    whiteLabel,
    authToken:
      privateApiEnabled
        ? parseAuthToken(env.IMMOCLOUD_AUTH_TOKEN)
        : undefined,
    deviceId:
      privateApiEnabled ? optionalTrimmed(env.IMMOCLOUD_DEVICE_ID) : undefined,
    email:
      privateApiEnabled ? optionalTrimmed(env.IMMOCLOUD_EMAIL) : undefined,
    password:
      privateApiEnabled ? env.IMMOCLOUD_PASSWORD || undefined : undefined,
    enableLoginTools:
      privateApiEnabled &&
      parseBoolean(
        "IMMOCLOUD_ENABLE_LOGIN_TOOLS",
        env.IMMOCLOUD_ENABLE_LOGIN_TOOLS,
        false,
      ),
    readOnly,
    enableBankingWriteTools:
      privateApiEnabled &&
      !readOnly &&
      parseBoolean(
        "IMMOCLOUD_ENABLE_BANKING_WRITE_TOOLS",
        env.IMMOCLOUD_ENABLE_BANKING_WRITE_TOOLS,
        false,
      ),
    enablePropertyWriteTools:
      privateApiEnabled &&
      !readOnly &&
      parseBoolean(
        "IMMOCLOUD_ENABLE_PROPERTY_WRITE_TOOLS",
        env.IMMOCLOUD_ENABLE_PROPERTY_WRITE_TOOLS,
        false,
      ),
    requestTimeoutMs: parsePositiveInteger(
      "IMMOCLOUD_REQUEST_TIMEOUT_MS",
      env.IMMOCLOUD_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    oauth: {
      clientId: optionalTrimmed(env.IMMOCLOUD_OAUTH_CLIENT_ID),
      redirectUri: optionalTrimmed(env.IMMOCLOUD_OAUTH_REDIRECT_URI),
      scopes: Object.freeze(
        (optionalTrimmed(env.IMMOCLOUD_OAUTH_SCOPES) ?? "")
          .split(/[\s,]+/)
          .filter(Boolean),
      ),
    },
  };
}
