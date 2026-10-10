import { randomUUID } from "node:crypto";

import type { ImmocloudConfig } from "../config.js";
import { safeErrorMessage } from "../security/redaction.js";
import {
  ImmocloudApiError,
  type ImmocloudResponse,
  ImmocloudClient,
} from "./client.js";
import { resolveSessionPath, saveSession } from "./session.js";

export interface LoginCredentials {
  email: string;
  password: string;
  deviceId?: string;
}

export type ImmocloudLoginResult =
  | {
      status: "authenticated";
      tokenStoredInMemory: true;
      requestId: string;
    }
  | {
      status: "device_verification_required";
      challengeHandle: string;
      nextStep: "Call immocloud_verify_device with this challengeHandle and the emailed code.";
      requestId: string;
    };

export interface VerifyDeviceInput {
  email: string;
  code: string;
  challengeHandle: string;
}

export interface VerifyDeviceResult {
  success: true;
  tokenStoredInMemory: true;
  deviceIdStored: boolean;
  deviceIdExpiresAt: string | undefined;
  requestId: string;
}

interface VerificationResponse {
  success?: boolean;
  token?: unknown;
  authToken?: unknown;
  accessToken?: unknown;
  deviceId?: unknown;
  deviceIdExpiresAt?: unknown;
  challengeId?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeServerToken(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const token = value.trim();
  if (!token || /^device-verification-required:/i.test(token)) {
    return undefined;
  }
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

function tokenFromResponse(
  response: ImmocloudResponse<unknown>,
): string | undefined {
  const authorization = response.headers.get("authorization");
  const headerToken = normalizeServerToken(authorization);
  if (headerToken !== undefined) {
    return headerToken;
  }

  if (typeof response.data === "string") {
    return normalizeServerToken(response.data);
  }
  if (!isRecord(response.data)) {
    return undefined;
  }

  return (
    normalizeServerToken(response.data.token) ??
    normalizeServerToken(response.data.authToken) ??
    normalizeServerToken(response.data.accessToken)
  );
}

function challengeFromResponse(
  response: ImmocloudResponse<unknown>,
): string | undefined {
  const authorization = response.headers.get("authorization");
  const headerMatch = authorization?.match(
    /^device-verification-required:\s*(.+)$/i,
  );
  if (headerMatch?.[1]?.trim()) {
    return headerMatch[1].trim();
  }

  if (!isRecord(response.data)) {
    return undefined;
  }
  return (
    getString(response.data, "challengeId") ??
    getString(response.data, "challenge")
  );
}

export class ImmocloudAuthenticator {
  private readonly pendingChallenges = new Map<
    string,
    { challengeId: string; email: string; expiresAt: number }
  >();

  constructor(
    private readonly config: ImmocloudConfig,
    private readonly client: ImmocloudClient,
  ) {}

  async loginFromEnvironment(): Promise<ImmocloudLoginResult> {
    if (!this.config.email || !this.config.password) {
      throw new Error(
        "Login requires IMMOCLOUD_EMAIL and IMMOCLOUD_PASSWORD in the MCP process environment.",
      );
    }
    return this.login({
      email: this.config.email,
      password: this.config.password,
      ...(this.config.deviceId ? { deviceId: this.config.deviceId } : {}),
    });
  }

  async login(credentials: LoginCredentials): Promise<ImmocloudLoginResult> {
    const headers: Record<string, string> = {
      "X-Login-Type": "EMAIL",
    };
    if (credentials.deviceId?.trim()) {
      headers["X-Device-Id"] = credentials.deviceId.trim();
    }

    const response = await this.client.post<unknown>(
      "/login",
      {
        emailAddress: credentials.email,
        password: credentials.password,
      },
      {
        authenticated: false,
        headers,
        acceptNonSuccessResponse: (httpResponse) =>
          /^device-verification-required:/i.test(
            httpResponse.headers.get("authorization") ?? "",
          ),
      },
    );

    const challengeId = challengeFromResponse(response);
    if (challengeId !== undefined) {
      const challengeHandle = randomUUID();
      this.pendingChallenges.clear();
      this.pendingChallenges.set(challengeHandle, {
        challengeId,
        email: credentials.email,
        expiresAt: Date.now() + 10 * 60 * 1_000,
      });
      return {
        status: "device_verification_required",
        challengeHandle,
        nextStep:
          "Call immocloud_verify_device with this challengeHandle and the emailed code.",
        requestId: response.requestId,
      };
    }

    const authToken = tokenFromResponse(response);
    if (authToken === undefined) {
      throw new ImmocloudApiError(
        "Immocloud login succeeded but returned neither an authorization token nor a device-verification challenge.",
        {
          status: response.status,
          requestId: response.requestId,
          method: "POST",
          path: "/login",
        },
      );
    }

    this.client.setAuthToken(authToken);
    const deviceId = credentials.deviceId ?? this.config.deviceId;
    await this.persistSession({
      authToken,
      ...(deviceId ? { deviceId } : {}),
    });
    return {
      status: "authenticated",
      tokenStoredInMemory: true,
      requestId: response.requestId,
    };
  }

  async verifyDevice(input: VerifyDeviceInput): Promise<VerifyDeviceResult> {
    const pending = this.pendingChallenges.get(input.challengeHandle);
    if (
      pending === undefined ||
      pending.expiresAt < Date.now() ||
      pending.email !== input.email
    ) {
      this.pendingChallenges.delete(input.challengeHandle);
      throw new Error(
        "Device-verification challenge is missing or expired. Call immocloud_login again.",
      );
    }

    const response = await this.client.post<VerificationResponse>(
      "/security/2fa/verify",
      {
        email: input.email,
        code: input.code,
        mode: "EMAIL_DEVICE",
        challengeId: pending.challengeId,
        trustDevice: true,
      },
      { authenticated: false },
    );

    if (response.data.success === false) {
      throw new ImmocloudApiError(
        "Immocloud rejected the device-verification code.",
        {
          status: response.status,
          requestId: response.requestId,
          method: "POST",
          path: "/security/2fa/verify",
        },
      );
    }

    const authToken = tokenFromResponse(
      response as ImmocloudResponse<unknown>,
    );
    if (authToken === undefined) {
      throw new ImmocloudApiError(
        "Device verification did not return an authorization token.",
        {
          status: response.status,
          requestId: response.requestId,
          method: "POST",
          path: "/security/2fa/verify",
        },
      );
    }
    this.client.setAuthToken(authToken);

    const responseRecord = response.data as VerificationResponse;
    const deviceId =
      typeof responseRecord.deviceId === "string"
        ? responseRecord.deviceId
        : undefined;
    const deviceIdExpiresAt =
      typeof responseRecord.deviceIdExpiresAt === "string"
        ? responseRecord.deviceIdExpiresAt
        : undefined;
    if (deviceId) {
      this.client.setDeviceId(deviceId);
    }
    this.pendingChallenges.delete(input.challengeHandle);

    const trustedDeviceId = deviceId ?? this.config.deviceId;
    await this.persistSession({
      authToken,
      ...(trustedDeviceId ? { deviceId: trustedDeviceId } : {}),
      ...(deviceIdExpiresAt ? { deviceIdExpiresAt } : {}),
    });

    return {
      success: true,
      tokenStoredInMemory: true,
      deviceIdStored: trustedDeviceId !== undefined,
      deviceIdExpiresAt,
      requestId: response.requestId,
    };
  }

  getConfiguredEmail(): string | undefined {
    return this.config.email;
  }

  private async persistSession(input: {
    authToken: string;
    deviceId?: string;
    deviceIdExpiresAt?: string;
  }): Promise<void> {
    try {
      const saved = await saveSession(
        {
          authToken: input.authToken,
          ...(input.deviceId ? { deviceId: input.deviceId } : {}),
          ...(input.deviceIdExpiresAt
            ? { deviceIdExpiresAt: input.deviceIdExpiresAt }
            : {}),
          origin: new URL(this.config.baseUrl).origin,
        },
        resolveSessionPath(),
      );
      if (saved.backend === "keychain") {
        console.error(
          saved.migratedFromFile
            ? "Immocloud session migrated to OS keychain (plaintext token removed from disk)."
            : "Immocloud session saved to OS keychain.",
        );
      } else {
        console.error(
          "Immocloud session saved to local file with mode 0600 (OS keychain unavailable).",
        );
      }
    } catch (error) {
      console.error(
        `Immocloud session could not be persisted: ${safeErrorMessage(error)}`,
      );
    }
  }
}
