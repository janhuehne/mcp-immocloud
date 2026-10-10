import type { ImmocloudConfig } from "../config.js";

export interface ImmocloudOAuthEndpoints {
  mcpAuthorizeEntry: string;
  authorization: string;
  consent: string;
  token: string;
}

export interface ImmocloudOAuthAuthorizationRequest {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}

export interface ImmocloudOAuthTokenRequest {
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  grantType: "authorization_code";
}

export interface ImmocloudOAuthTokenSet {
  accessToken: string;
  tokenType: string;
  expiresIn: number | undefined;
  refreshToken: string | undefined;
  scope: string | undefined;
}

export interface ImmocloudOfficialOAuthProvider {
  readonly endpoints: ImmocloudOAuthEndpoints;
  createAuthorizationUrl(
    request: ImmocloudOAuthAuthorizationRequest,
  ): Promise<URL>;
  exchangeAuthorizationCode(
    request: ImmocloudOAuthTokenRequest,
  ): Promise<ImmocloudOAuthTokenSet>;
}

export interface ImmocloudOAuthStatus {
  authMode: "token" | "oauth";
  implemented: false;
  usable: false;
  gate: "mcpNotEnabled may prevent account authorization";
  clientConfigured: boolean;
  redirectUriConfigured: boolean;
  scopesConfigured: boolean;
  endpoints: ImmocloudOAuthEndpoints;
  roadmap: readonly string[];
}

export class ImmocloudOAuthNotAvailableError extends Error {
  constructor() {
    super(
      "Official Immocloud MCP OAuth is not wired yet and the account may be blocked by the mcpNotEnabled gate. Use token mode for the private REST API.",
    );
    this.name = "ImmocloudOAuthNotAvailableError";
  }
}

export function createOAuthEndpoints(baseUrl: string): ImmocloudOAuthEndpoints {
  const origin = new URL(baseUrl).origin;
  return {
    mcpAuthorizeEntry: new URL("/oauth/authorize", origin).toString(),
    authorization: new URL("/api/oauth2/authorize", origin).toString(),
    consent: new URL("/api/oauth2/consent", origin).toString(),
    token: new URL("/api/oauth2/token", origin).toString(),
  };
}

/**
 * Compile-time integration seam for Immocloud's official MCP OAuth.
 *
 * TODO: Implement PKCE authorization, consent handling, callback validation,
 * token exchange/refresh, and secure token persistence after Immocloud enables
 * MCP for the account and publishes the final contract.
 */
export class StubImmocloudOfficialOAuthProvider
  implements ImmocloudOfficialOAuthProvider
{
  readonly endpoints: ImmocloudOAuthEndpoints;

  constructor(baseUrl: string) {
    this.endpoints = createOAuthEndpoints(baseUrl);
  }

  async createAuthorizationUrl(
    _request: ImmocloudOAuthAuthorizationRequest,
  ): Promise<URL> {
    throw new ImmocloudOAuthNotAvailableError();
  }

  async exchangeAuthorizationCode(
    _request: ImmocloudOAuthTokenRequest,
  ): Promise<ImmocloudOAuthTokenSet> {
    throw new ImmocloudOAuthNotAvailableError();
  }
}

export function getOAuthStatus(
  config: ImmocloudConfig,
): ImmocloudOAuthStatus {
  return {
    authMode: config.authMode,
    implemented: false,
    usable: false,
    gate: "mcpNotEnabled may prevent account authorization",
    clientConfigured: config.oauth.clientId !== undefined,
    redirectUriConfigured: config.oauth.redirectUri !== undefined,
    scopesConfigured: config.oauth.scopes.length > 0,
    endpoints: createOAuthEndpoints(config.baseUrl),
    roadmap: Object.freeze([
      "Confirm that Immocloud has enabled MCP for the account.",
      "Confirm scopes, redirect URI rules, and final OAuth response contracts.",
      "Implement Authorization Code + PKCE and CSRF state validation.",
      "Store and refresh tokens through a secure OS credential store.",
      "Switch API authentication behind ImmocloudOfficialOAuthProvider.",
    ]),
  };
}
