interface CachedToken {
  access_token: string;
  expires_at: number; // unix epoch ms
}

// Module-level cache — persists for the lifetime of the MCP process.
const cache = new Map<string, CachedToken>();

// Refresh the token 5 min before it actually expires to avoid mid-request failures.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export function getCachedToken(key: string): string | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() + REFRESH_BUFFER_MS >= entry.expires_at) {
    cache.delete(key);
    return null;
  }
  return entry.access_token;
}

export function setCachedToken(key: string, token: string, expiresInSeconds: number): void {
  cache.set(key, {
    access_token: token,
    expires_at: Date.now() + expiresInSeconds * 1000,
  });
}

export function clearCachedToken(key: string): void {
  cache.delete(key);
}

// Returns seconds remaining before the token hits the refresh buffer (i.e. how long callers can trust it).
export function getRemainingTtlSeconds(key: string): number | null {
  const entry = cache.get(key);
  if (!entry) return null;
  const remainingMs = entry.expires_at - Date.now() - REFRESH_BUFFER_MS;
  return remainingMs > 0 ? Math.floor(remainingMs / 1000) : null;
}
