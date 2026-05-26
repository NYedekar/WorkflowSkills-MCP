import { getTwoLeggedToken, APSAuthError } from "./aps-token-client.js";
import { getCachedToken, setCachedToken, getRemainingTtlSeconds } from "./token-cache.js";
import { loadSecret } from "./keychain.js"; // synchronous; returns null when keychain unavailable
export const DEFAULT_SCOPES = [
    "data:read",
    "data:write",
    "data:create",
    "bucket:create",
    "bucket:read",
    "bucket:update",
];
// Ordered scope sets to try during credential validation.
// MCP app types may only expose the MCP_API product, which uses its own scope.
export const VALIDATION_SCOPE_CANDIDATES = [
    ["data:read"],
    ["bucket:read"],
    ["viewables:read"],
    [], // empty scope — some APS app types return a default grant
];
export class APSNotConfiguredError extends Error {
    constructor() {
        super("APS credentials not configured. " +
            "Run the setup script first: node dist/setup.js\n" +
            "Then quit and reopen Claude Desktop so the MCP server reloads the new credentials.");
        this.name = "APSNotConfiguredError";
    }
}
// Resolves a valid 2LO access token using the following priority:
//   1. In-memory token cache (avoids hitting APS on every tool call)
//   2. OS Keychain (client_secret stored by setup.js or authenticate_aps)
//   3. APS_CLIENT_SECRET environment variable
//   Falls through to APSNotConfiguredError if none are available.
export async function resolveCredential(scopes = DEFAULT_SCOPES) {
    const clientId = process.env.APS_CLIENT_ID?.trim();
    if (!clientId) {
        throw new APSNotConfiguredError();
    }
    const cacheKey = `2lo:${clientId}:${scopes.slice().sort().join(",")}`;
    // 1. Check in-memory cache first.
    const cached = getCachedToken(cacheKey);
    if (cached) {
        const ttl = getRemainingTtlSeconds(cacheKey) ?? 300; // fallback: 5 min if cache entry in transition
        return { client_id: clientId, access_token: cached, scopes, expires_in_seconds: ttl };
    }
    // 2. Resolve the client secret — keychain takes priority over env var.
    let clientSecret = loadSecret(clientId);
    if (!clientSecret) {
        clientSecret = process.env.APS_CLIENT_SECRET?.trim() ?? null;
    }
    if (!clientSecret) {
        throw new APSNotConfiguredError();
    }
    // 3. Fetch a fresh token from APS.
    const token = await getTwoLeggedToken(clientId, clientSecret, scopes);
    setCachedToken(cacheKey, token.access_token, token.expires_in);
    const freshTtl = getRemainingTtlSeconds(cacheKey) ?? token.expires_in;
    return { client_id: clientId, access_token: token.access_token, scopes, expires_in_seconds: freshTtl };
}
export { APSAuthError };
