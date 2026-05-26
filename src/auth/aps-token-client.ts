const APS_TOKEN_URL = "https://developer.api.autodesk.com/authentication/v2/token";

export interface APSTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

export interface APSTokenResponse3LO extends APSTokenResponse {
  refresh_token: string;
}

export interface APSErrorResponse {
  errorCode?: string;
  errorMessage?: string;
  error?: string;
  error_description?: string;
}

export class APSAuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly apsCode?: string
  ) {
    super(message);
    this.name = "APSAuthError";
  }
}

// ── 2LO: Client Credentials ───────────────────────────────────────────────

export async function getTwoLeggedToken(
  clientId: string,
  clientSecret: string,
  scopes: string[]
): Promise<APSTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: scopes.join(" "),
  });

  const response = await fetch(APS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const json = (await response.json()) as APSTokenResponse & APSErrorResponse;

  if (!response.ok) {
    const msg =
      json.errorMessage ?? json.error_description ?? json.error ?? response.statusText;
    throw new APSAuthError(
      `APS authentication failed: ${msg}`,
      response.status,
      json.errorCode ?? json.error
    );
  }

  return json;
}

// ── 3LO: Authorization Code Exchange ─────────────────────────────────────

export async function exchangeAuthCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string
): Promise<APSTokenResponse3LO> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  const response = await fetch(APS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const json = (await response.json()) as APSTokenResponse3LO & APSErrorResponse;

  if (!response.ok) {
    const msg =
      json.errorMessage ?? json.error_description ?? json.error ?? response.statusText;
    throw new APSAuthError(
      `APS 3LO token exchange failed: ${msg}`,
      response.status,
      json.errorCode ?? json.error
    );
  }

  return json;
}

// ── 3LO: Refresh Token ───────────────────────────────────────────────────

export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<APSTokenResponse3LO> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const response = await fetch(APS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const json = (await response.json()) as APSTokenResponse3LO & APSErrorResponse;

  if (!response.ok) {
    const msg =
      json.errorMessage ?? json.error_description ?? json.error ?? response.statusText;
    throw new APSAuthError(
      `APS token refresh failed: ${msg}`,
      response.status,
      json.errorCode ?? json.error
    );
  }

  return json;
}
