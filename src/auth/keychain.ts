// Optional keychain wrapper. Uses @napi-rs/keyring when available; silently
// falls back (returns false/null) when the package is not installed or the OS
// keychain is unavailable (headless Linux, CI, etc.).
//
// Loaded via createRequire so TypeScript does not resolve the package's types
// at compile time — keeps the build clean even without the package installed.

import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

const SERVICE = "mcp-workflow-builder";

interface KeyringEntry {
  getPassword(): string;
  setPassword(password: string): void;
  deletePassword(): void;
}
interface KeyringModule {
  Entry: new (service: string, account: string) => KeyringEntry;
}

function tryLoadKeyring(): KeyringModule | null {
  try {
    return _require("@napi-rs/keyring") as KeyringModule;
  } catch {
    return null;
  }
}

function accountKey(clientId: string, field: "secret" | "refresh"): string {
  return `${clientId}:${field}`;
}

// ── Client Secret ─────────────────────────────────────────────────────────

export function storeSecret(clientId: string, clientSecret: string): boolean {
  const mod = tryLoadKeyring();
  if (!mod) return false;
  try {
    const entry = new mod.Entry(SERVICE, accountKey(clientId, "secret"));
    entry.setPassword(clientSecret);
    return true;
  } catch {
    return false;
  }
}

export function loadSecret(clientId: string): string | null {
  const mod = tryLoadKeyring();
  if (!mod) return null;
  try {
    const entry = new mod.Entry(SERVICE, accountKey(clientId, "secret"));
    return entry.getPassword();
  } catch {
    return null;
  }
}

export function deleteSecret(clientId: string): boolean {
  const mod = tryLoadKeyring();
  if (!mod) return false;
  try {
    const entry = new mod.Entry(SERVICE, accountKey(clientId, "secret"));
    entry.deletePassword();
    return true;
  } catch {
    return false;
  }
}

// ── Refresh Token (3LO) ───────────────────────────────────────────────────

export function storeRefreshToken(clientId: string, refreshToken: string): boolean {
  const mod = tryLoadKeyring();
  if (!mod) return false;
  try {
    const entry = new mod.Entry(SERVICE, accountKey(clientId, "refresh"));
    entry.setPassword(refreshToken);
    return true;
  } catch {
    return false;
  }
}

export function loadRefreshToken(clientId: string): string | null {
  const mod = tryLoadKeyring();
  if (!mod) return null;
  try {
    const entry = new mod.Entry(SERVICE, accountKey(clientId, "refresh"));
    return entry.getPassword();
  } catch {
    return null;
  }
}

export function deleteRefreshToken(clientId: string): boolean {
  const mod = tryLoadKeyring();
  if (!mod) return false;
  try {
    const entry = new mod.Entry(SERVICE, accountKey(clientId, "refresh"));
    entry.deletePassword();
    return true;
  } catch {
    return false;
  }
}
