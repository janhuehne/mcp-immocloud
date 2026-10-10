import { randomUUID } from "node:crypto";

import type { ImmocloudConfig } from "../config.js";
import { redactSensitiveString } from "../security/redaction.js";

const CHROME_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/140.0.0.0 Safari/537.36";

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParameters = Record<string, QueryValue>;

export interface ImmocloudResponse<T> {
  data: T;
  headers: Headers;
  requestId: string;
  status: number;
}

export type ImmocloudHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ImmocloudRequestOptions {
  method?: ImmocloudHttpMethod;
  query?: QueryParameters;
  body?: unknown;
  authenticated?: boolean;
  headers?: Record<string, string>;
  acceptNonSuccessResponse?: (
    response: Response,
    data: unknown,
  ) => boolean;
}

export interface ImmocloudAuthSnapshot {
  tokenPresent: boolean;
  deviceIdPresent: boolean;
}

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const FORBIDDEN_HEADER_OVERRIDES = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
]);
const DANGEROUS_JSON_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export class ImmocloudApiError extends Error {
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  readonly method: string | undefined;
  readonly path: string | undefined;

  constructor(
    message: string,
    details: {
      status?: number;
      requestId?: string;
      method?: string;
      path?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "ImmocloudApiError";
    this.status = details.status;
    this.requestId = details.requestId;
    this.method = details.method;
    this.path = details.path;
  }
}

function responseDetail(data: unknown): string | undefined {
  if (data === null || data === undefined || data === "") {
    return undefined;
  }

  let detail: string;
  if (typeof data === "string") {
    detail = data;
  } else if (typeof data === "object") {
    const record = data as Record<string, unknown>;
    const concise =
      record.message ??
      record.error_description ??
      record.error ??
      record.reason ??
      data;
    try {
      detail =
        typeof concise === "string" ? concise : JSON.stringify(concise);
    } catch {
      detail = "The API returned a non-serializable error response.";
    }
  } else {
    detail = String(data);
  }

  const normalized = redactSensitiveString(detail).replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 1_000) : undefined;
}

function parseJson(text: string): unknown {
  return JSON.parse(text, (key: string, value: unknown) =>
    DANGEROUS_JSON_KEYS.has(key) ? undefined : value,
  ) as unknown;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    try {
      return parseJson(text);
    } catch {
      return text;
    }
  }

  try {
    return parseJson(text);
  } catch {
    return text;
  }
}

export class ImmocloudClient {
  private authToken: string | undefined;
  private deviceId: string | undefined;

  constructor(
    private readonly config: ImmocloudConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.authToken =
      config.authMode === "token" ? config.authToken : undefined;
    this.deviceId = config.deviceId;
  }

  getAuthSnapshot(): ImmocloudAuthSnapshot {
    return {
      tokenPresent: this.authToken !== undefined,
      deviceIdPresent: this.deviceId !== undefined,
    };
  }

  setAuthToken(authToken: string): void {
    if (this.config.authMode !== "token") {
      throw new Error(
        "Private API tokens cannot be installed while IMMOCLOUD_AUTH_MODE=oauth.",
      );
    }
    if (!/^Bearer\s+\S+$/i.test(authToken)) {
      throw new Error(
        'Authorization must be the full value, including the "Bearer " prefix.',
      );
    }
    this.authToken = authToken;
  }

  setDeviceId(deviceId: string): void {
    if (this.config.authMode !== "token") {
      throw new Error(
        "Private API device IDs cannot be installed while IMMOCLOUD_AUTH_MODE=oauth.",
      );
    }
    const normalized = deviceId.trim();
    if (!normalized) {
      throw new Error("Device ID cannot be empty.");
    }
    this.deviceId = normalized;
  }

  async get<T>(
    path: string,
    query: QueryParameters = {},
  ): Promise<T> {
    const response = await this.request<T>(path, { method: "GET", query });
    return response.data;
  }

  async post<T>(
    path: string,
    body: unknown,
    options: {
      authenticated?: boolean;
      headers?: Record<string, string>;
      query?: QueryParameters;
      acceptNonSuccessResponse?: (
        response: Response,
        data: unknown,
      ) => boolean;
    } = {},
  ): Promise<ImmocloudResponse<T>> {
    return this.mutate<T>("POST", path, body, options);
  }

  async put<T>(
    path: string,
    body: unknown = undefined,
    options: {
      authenticated?: boolean;
      headers?: Record<string, string>;
      query?: QueryParameters;
    } = {},
  ): Promise<ImmocloudResponse<T>> {
    return this.mutate<T>("PUT", path, body, options);
  }

  async patch<T>(
    path: string,
    body: unknown = undefined,
    options: {
      authenticated?: boolean;
      headers?: Record<string, string>;
      query?: QueryParameters;
    } = {},
  ): Promise<ImmocloudResponse<T>> {
    return this.mutate<T>("PATCH", path, body, options);
  }

  async delete<T>(
    path: string,
    options: {
      authenticated?: boolean;
      headers?: Record<string, string>;
      query?: QueryParameters;
      body?: unknown;
    } = {},
  ): Promise<ImmocloudResponse<T>> {
    return this.mutate<T>("DELETE", path, options.body, options);
  }

  private async mutate<T>(
    method: Exclude<ImmocloudHttpMethod, "GET">,
    path: string,
    body: unknown,
    options: {
      authenticated?: boolean;
      headers?: Record<string, string>;
      query?: QueryParameters;
      acceptNonSuccessResponse?: (
        response: Response,
        data: unknown,
      ) => boolean;
    } = {},
  ): Promise<ImmocloudResponse<T>> {
    const requestOptions: ImmocloudRequestOptions = {
      method,
    };
    if (body !== undefined) {
      requestOptions.body = body;
    }
    if (options.authenticated !== undefined) {
      requestOptions.authenticated = options.authenticated;
    }
    if (options.headers !== undefined) {
      requestOptions.headers = options.headers;
    }
    if (options.query !== undefined) {
      requestOptions.query = options.query;
    }
    if (options.acceptNonSuccessResponse !== undefined) {
      requestOptions.acceptNonSuccessResponse =
        options.acceptNonSuccessResponse;
    }
    return this.request<T>(path, requestOptions);
  }

  async request<T>(
    path: string,
    options: ImmocloudRequestOptions = {},
  ): Promise<ImmocloudResponse<T>> {
    const method = options.method ?? "GET";
    const authenticated = options.authenticated ?? true;
    const requestId = randomUUID();
    const url = this.buildUrl(path, options.query);

    if (authenticated && this.authToken === undefined) {
      throw new ImmocloudApiError(
        "No Immocloud token is configured. Set IMMOCLOUD_AUTH_TOKEN to the full Authorization value, including the Bearer prefix.",
        { method, path, requestId },
      );
    }

    const headers = new Headers({
      Accept: "application/json",
      "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
      "Cache-Control": "no-store",
      "User-Agent": CHROME_USER_AGENT,
      "X-IMMOCLOUD-WHITELABEL": this.config.whiteLabel,
      "X-Request-Id": requestId,
    });

    if (authenticated && this.authToken !== undefined) {
      headers.set("Authorization", this.authToken);
    }
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (FORBIDDEN_HEADER_OVERRIDES.has(name.toLowerCase())) {
        throw new ImmocloudApiError(
          `Refusing to override protected HTTP header "${name}".`,
          { method, path, requestId },
        );
      }
      headers.set(name, value);
    }

    let serializedBody: string | undefined;
    if (options.body !== undefined) {
      serializedBody = JSON.stringify(options.body);
      if (serializedBody === undefined) {
        throw new ImmocloudApiError(
          "Immocloud request body is not JSON serializable.",
          { method, path, requestId },
        );
      }
      if (Buffer.byteLength(serializedBody, "utf8") > MAX_REQUEST_BODY_BYTES) {
        throw new ImmocloudApiError(
          `Immocloud request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes.`,
          { method, path, requestId },
        );
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs,
    );

    const requestInit: RequestInit = {
      method,
      headers,
      signal: controller.signal,
      redirect: "manual",
    };
    if (serializedBody !== undefined) {
      requestInit.body = serializedBody;
    }

    try {
      const response = await this.fetchImpl(url, requestInit);
      if (response.url) {
        const responseOrigin = new URL(response.url).origin;
        if (responseOrigin !== url.origin) {
          throw new ImmocloudApiError(
            "Immocloud response origin did not match the configured origin.",
            { method, path, requestId },
          );
        }
      }
      const data = await parseResponseBody(response);

      const acceptedNonSuccess =
        !response.ok &&
        options.acceptNonSuccessResponse?.(response, data) === true;
      if (!response.ok && !acceptedNonSuccess) {
        const detail = responseDetail(data);
        const authHint =
          response.status === 401
            ? " Check token expiry and trusted-device state; repeated 401 responses can also indicate Immocloud's non-browser TLS filtering."
            : "";
        throw new ImmocloudApiError(
          `Immocloud API returned ${response.status} ${response.statusText} for ${method} ${path}.${detail ? ` ${detail}` : ""}${authHint}`,
          {
            status: response.status,
            requestId,
            method,
            path,
          },
        );
      }

      return {
        data: data as T,
        headers: response.headers,
        requestId,
        status: response.status,
      };
    } catch (error) {
      if (error instanceof ImmocloudApiError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new ImmocloudApiError(
          `Immocloud API request timed out after ${this.config.requestTimeoutMs} ms for ${method} ${path}.`,
          { method, path, requestId, cause: error },
        );
      }
      throw new ImmocloudApiError(
        `Immocloud API request failed for ${method} ${path}: ${
          redactSensitiveString(
            error instanceof Error ? error.message : String(error),
          )
        }`,
        { method, path, requestId, cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildUrl(
    path: string,
    query: QueryParameters | undefined,
  ): URL {
    if (/^[a-z][a-z\d+.-]*:/i.test(path)) {
      throw new Error("Immocloud request paths must be relative.");
    }
    if (path.includes("?") || path.includes("#") || path.includes("\\")) {
      throw new Error(
        "Immocloud request paths must not contain query, fragment, or backslash characters.",
      );
    }

    const normalizedPath = path.replace(/^\/+/, "");
    if (!normalizedPath) {
      throw new Error("Immocloud request path cannot be empty.");
    }
    for (const segment of normalizedPath.split("/")) {
      if (!segment || segment.includes("%")) {
        throw new Error(
          "Immocloud request path contains an empty or escaped segment.",
        );
      }
      let decoded = segment;
      for (let pass = 0; pass < 3; pass += 1) {
        try {
          const next = decodeURIComponent(decoded);
          if (next === decoded) {
            break;
          }
          decoded = next;
        } catch {
          throw new Error("Immocloud request path contains invalid escaping.");
        }
      }
      if (
        decoded === "." ||
        decoded === ".." ||
        decoded.includes("/") ||
        decoded.includes("\\") ||
        decoded.includes("\0")
      ) {
        throw new Error("Immocloud request path contains an unsafe segment.");
      }
    }

    const base = new URL(`${this.config.baseUrl}/`);
    const url = new URL(normalizedPath, base);
    const basePath = base.pathname.replace(/\/+$/, "");
    if (
      url.origin !== base.origin ||
      !url.pathname.startsWith(`${basePath}/`)
    ) {
      throw new Error("Immocloud request path escaped the API base path.");
    }
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(name, String(value));
      }
    }
    return url;
  }
}
