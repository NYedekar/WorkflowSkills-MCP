// Optional keychain wrapper. Uses @napi-rs/keyring when available; silently
// falls back (returns false/null) when the package is not installed or the OS
// keychain is unavailable (headless Linux, CI, etc.).
//
// Loaded via createRequire so TypeScript does not resolve the package's types
// at compile time — keeps the build clean even without the package installed.
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const SERVICE = "mcp-workflow-builder";
function tryLoadKeyring() {
    try {
        return _require("@napi-rs/keyring");
    }
    catch {
        return null;
    }
}
function accountKey(clientId, field) {
    return `${clientId}:${field}`;
}
// ── Client Secret ─────────────────────────────────────────────────────────
export function storeSecret(clientId, clientSecret) {
    const mod = tryLoadKeyring();
    if (!mod)
        return false;
    try {
        const entry = new mod.Entry(SERVICE, accountKey(clientId, "secret"));
        entry.setPassword(clientSecret);
        return true;
    }
    catch {
        return false;
    }
}
export function loadSecret(clientId) {
    const mod = tryLoadKeyring();
    if (!mod)
        return null;
    try {
        const entry = new mod.Entry(SERVICE, accountKey(clientId, "secret"));
        return entry.getPassword();
    }
    catch {
        return null;
    }
}
export function deleteSecret(clientId) {
    const mod = tryLoadKeyring();
    if (!mod)
        return false;
    try {
        const entry = new mod.Entry(SERVICE, accountKey(clientId, "secret"));
        entry.deletePassword();
        return true;
    }
    catch {
        return false;
    }
}
// ── Refresh Token (3LO) ───────────────────────────────────────────────────
export function storeRefreshToken(clientId, refreshToken) {
    const mod = tryLoadKeyring();
    if (!mod)
        return false;
    try {
        const entry = new mod.Entry(SERVICE, accountKey(clientId, "refresh"));
        entry.setPassword(refreshToken);
        return true;
    }
    catch {
        return false;
    }
}
export function loadRefreshToken(clientId) {
    const mod = tryLoadKeyring();
    if (!mod)
        return null;
    try {
        const entry = new mod.Entry(SERVICE, accountKey(clientId, "refresh"));
        return entry.getPassword();
    }
    catch {
        return null;
    }
}
export function deleteRefreshToken(clientId) {
    const mod = tryLoadKeyring();
    if (!mod)
        return false;
    try {
        const entry = new mod.Entry(SERVICE, accountKey(clientId, "refresh"));
        entry.deletePassword();
        return true;
    }
    catch {
        return false;
    }
}
