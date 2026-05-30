import { getTwoLeggedToken, refreshAccessToken, APSAuthError } from "./aps-token-client.js";
import { getCachedToken, setCachedToken, getRemainingTtlSeconds } from "./token-cache.js";
import { loadSecret, loadRefreshToken, storeRefreshToken } from "./keychain.js";

export const DEFAULT_SCOPES = [
  "data:read",
  "data:write",
  "data:create",
  "viewables:read",
  "bucket:create",
  "bucket:read",
  "bucket:update",
];

export const DEFAULT_3LO_SCOPES = [
  "account:read",
  "account:write",
  "data:read",
  "data:write",
  "data:create",
];

// Ordered scope sets to try during credential validation.
export const VALIDATION_SCOPE_CANDIDATES = [
  ["data:read"],
  ["bucket:read"],
  ["viewables:read"],
  [],
];

export interface ResolvedCredential {
  client_id: string;
  access_token: string;
  scopes: string[];
  expires_in_seconds: number;
}

export class APSNotConfiguredError extends Error {
  constructor() {
    super(
      "APS credentials not configured. " +
        "Run the setup script first: node dist/setup.js\n" +
        "Then quit and reopen Claude Desktop so the MCP server reloads the new credentials."
    );
    this.name = "APSNotConfiguredError";
  }
}

// ── 2LO: Client Credentials ───────────────────────────────────────────────
// Resolves a valid 2LO access token using the following priority:
//   1. In-memory token cache
//   2. OS Keychain (client_secret stored by setup.js or authenticate_aps)
//   3. APS_CLIENT_SECRET environment variable
//
// Dedup: if multiple concurrent callers miss the cache simultaneously (e.g. on startup),
// the first one wins and all others await the same inflight promise.
// This prevents N × getTwoLeggedToken calls under parallel tool invocation.
const inflight2LO = new Map<string, Promise<ResolvedCredential>>();

export async function resolveCredential(
  scopes: string[] = DEFAULT_SCOPES
): Promise<ResolvedCredential> {
  const clientId = process.env.APS_CLIENT_ID?.trim();

  if (!clientId) {
    throw new APSNotConfiguredError();
  }

  const cacheKey = `2lo:${clientId}:${scopes.slice().sort().join(",")}`;

  // Fast path: cache hit (no lock needed)
  const cached = getCachedToken(cacheKey);
  if (cached) {
    const ttl = getRemainingTtlSeconds(cacheKey) ?? 300;
    return { client_id: clientId, access_token: cached, scopes, expires_in_seconds: ttl };
  }

  // Dedup: coalesce concurrent cache-miss callers onto one inflight promise
  const existing = inflight2LO.get(cacheKey);
  if (existing) return existing;

  const fetchPromise = (async (): Promise<ResolvedCredential> => {
    try {
      // Re-check cache after acquiring "the slot" — a previous waiter may have populated it
      const rechecked = getCachedToken(cacheKey);
      if (rechecked) {
        const ttl = getRemainingTtlSeconds(cacheKey) ?? 300;
        return { client_id: clientId, access_token: rechecked, scopes, expires_in_seconds: ttl };
      }

      let clientSecret = loadSecret(clientId);
      if (!clientSecret) {
        clientSecret = process.env.APS_CLIENT_SECRET?.trim() ?? null;
      }
      if (!clientSecret) throw new APSNotConfiguredError();

      const token = await getTwoLeggedToken(clientId, clientSecret, scopes);
      setCachedToken(cacheKey, token.access_token, token.expires_in);
      const freshTtl = getRemainingTtlSeconds(cacheKey) ?? token.expires_in;
      return { client_id: clientId, access_token: token.access_token, scopes, expires_in_seconds: freshTtl };
    } finally {
      inflight2LO.delete(cacheKey);
    }
  })();

  inflight2LO.set(cacheKey, fetchPromise);
  return fetchPromise;
}

// ── 3LO: User Token ───────────────────────────────────────────────────────
// Resolves a 3LO user token using the following priority:
//   1. In-memory token cache (set by authenticate_aps_3lo)
//   2. APS_ACCESS_TOKEN environment variable (manual override)
//   3. Keychain refresh token → auto-refresh
// Returns null if no 3LO token is available (caller falls back to 2LO).
export async function resolve3LOCredential(
  scopes: string[] = DEFAULT_3LO_SCOPES
): Promise<ResolvedCredential | null> {
  const clientId = process.env.APS_CLIENT_ID?.trim();
  if (!clientId) return null;

  const cacheKey = `3lo:${clientId}:${scopes.slice().sort().join(",")}`;

  // 1. In-memory cache (populated by authenticate_aps_3lo)
  const cached = getCachedToken(cacheKey);
  if (cached) {
    const ttl = getRemainingTtlSeconds(cacheKey) ?? 300;
    return { client_id: clientId, access_token: cached, scopes, expires_in_seconds: ttl };
  }

  // 1b. Secondary lookup: authenticate_aps_3lo always stores under DEFAULT_3LO_SCOPES key.
  // If the requested scopes are a subset of those, the stored token is valid for this op too.
  // Without this, every 3LO op with a different scope list causes an unnecessary keychain refresh.
  const defaultKey = `3lo:${clientId}:${DEFAULT_3LO_SCOPES.slice().sort().join(",")}`;
  if (cacheKey !== defaultKey) {
    const cachedDefault = getCachedToken(defaultKey);
    if (cachedDefault && scopes.every((s) => DEFAULT_3LO_SCOPES.includes(s))) {
      const ttl = getRemainingTtlSeconds(defaultKey) ?? 300;
      return { client_id: clientId, access_token: cachedDefault, scopes, expires_in_seconds: ttl };
    }
  }

  // 2. APS_ACCESS_TOKEN env var (manual bearer token override)
  const envToken = process.env.APS_ACCESS_TOKEN?.trim();
  if (envToken) {
    setCachedToken(cacheKey, envToken, 3600);
    return { client_id: clientId, access_token: envToken, scopes, expires_in_seconds: 3600 };
  }

  // 3. Keychain refresh token → auto-refresh
  const refreshToken = loadRefreshToken(clientId);
  if (!refreshToken) return null;

  const clientSecret = loadSecret(clientId) ?? process.env.APS_CLIENT_SECRET?.trim() ?? null;
  if (!clientSecret) return null;

  try {
    const token = await refreshAccessToken(clientId, clientSecret, refreshToken);
    setCachedToken(cacheKey, token.access_token, token.expires_in);

    // Store rotated refresh token if APS issued a new one
    if (token.refresh_token && token.refresh_token !== refreshToken) {
      storeRefreshToken(clientId, token.refresh_token);
    }

    const ttl = getRemainingTtlSeconds(cacheKey) ?? token.expires_in;
    return { client_id: clientId, access_token: token.access_token, scopes, expires_in_seconds: ttl };
  } catch {
    // Refresh failed (expired/revoked) — return null and let caller fall back to 2LO
    return null;
  }
}

// Called by authenticate_aps_3lo after a successful code exchange to warm the cache.
export function set3LOToken(
  clientId: string,
  accessToken: string,
  expiresIn: number,
  scopes: string[] = DEFAULT_3LO_SCOPES
): void {
  const cacheKey = `3lo:${clientId}:${scopes.slice().sort().join(",")}`;
  setCachedToken(cacheKey, accessToken, expiresIn);
}

export { APSAuthError };
