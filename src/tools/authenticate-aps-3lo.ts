import { z } from "zod";
import * as http from "node:http";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import { exchangeAuthCode } from "../auth/aps-token-client.js";
import { loadSecret, storeRefreshToken } from "../auth/keychain.js";
import { set3LOToken, DEFAULT_3LO_SCOPES } from "../auth/credential-resolver.js";

const APS_AUTH_BASE = "https://developer.api.autodesk.com/authentication/v2/authorize";
const REDIRECT_URI = "http://localhost:3000/callback";

export const authenticateAps3LOSchema = z.object({
  scopes: z
    .array(z.string())
    .optional()
    .describe(
      "OAuth scopes to request. Defaults to: account:read, account:write, " +
        "data:read, data:write, data:create."
    ),
  port: z
    .number()
    .int()
    .optional()
    .default(3000)
    .describe("Local port for the OAuth callback server. Default: 3000."),
  timeout_seconds: z
    .number()
    .int()
    .optional()
    .default(120)
    .describe(
      "Seconds to wait for the user to complete authorization in the browser. Default: 120."
    ),
});

export type AuthenticateAps3LOInput = z.infer<typeof authenticateAps3LOSchema>;

export interface AuthenticateAps3LOResult {
  status: "success" | "timeout" | "error";
  message?: string;
  scopes_granted?: string[];
  expires_in_seconds?: number;
  refresh_token_stored?: boolean;
  auth_url?: string;
  error?: string;
  hint?: string;
}

export async function handleAuthenticateAps3LO(
  input: AuthenticateAps3LOInput
): Promise<AuthenticateAps3LOResult> {
  const clientId = process.env.APS_CLIENT_ID?.trim();
  if (!clientId) {
    return {
      status: "error",
      error: "APS_CLIENT_ID not set in environment.",
      hint: "Ensure APS_CLIENT_ID is present in claude_desktop_config.json env block.",
    };
  }

  const clientSecret = loadSecret(clientId) ?? process.env.APS_CLIENT_SECRET?.trim() ?? null;
  if (!clientSecret) {
    return {
      status: "error",
      error: "APS client secret not found in keychain or environment.",
      hint: "Run authenticate_aps first to store the client secret.",
    };
  }

  const scopes = input.scopes ?? DEFAULT_3LO_SCOPES;
  const port = input.port ?? 3000;
  const timeoutMs = (input.timeout_seconds ?? 120) * 1000;
  const state = crypto.randomBytes(16).toString("hex");

  // Build the APS authorization URL
  const authUrl =
    `${APS_AUTH_BASE}` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(scopes.join(" "))}` +
    `&state=${state}`;

  // ── Start local callback server ─────────────────────────────────────────

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;

  const callbackPromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const errorParam = url.searchParams.get("error");

      if (errorParam) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(callbackPage("❌ Authorization Denied", `Error: ${errorParam}. You can close this tab.`, "#e74c3c"));
        rejectCode(new Error(`Authorization denied by user: ${errorParam}`));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(callbackPage("❌ Invalid Callback", "State mismatch or missing code. You can close this tab.", "#e74c3c"));
        rejectCode(new Error("Invalid callback: missing code or state mismatch"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(callbackPage("✅ Authorized!", "You can close this tab and return to Claude.", "#27ae60"));
      resolveCode(code);
    } catch (err) {
      res.writeHead(500);
      res.end();
      rejectCode(err instanceof Error ? err : new Error(String(err)));
    }
  });

  // Bind to loopback only — not exposed on LAN
  await new Promise<void>((res, rej) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        rej(new Error(
          `Port ${port} is already in use. ` +
          `Pass a different port: authenticate_aps_3lo({ port: 3001 })`
        ));
      } else {
        rej(err);
      }
    });
    server.listen(port, "127.0.0.1", () => res());
  }).catch((err) => {
    return { status: "error" as const, error: String(err) };
  });

  // ── Open browser ────────────────────────────────────────────────────────

  let browserOpened = false;
  try {
    execSync(`open "${authUrl}"`, { stdio: "ignore" });
    browserOpened = true;
  } catch {
    // Browser open failed on this platform — user will need to open manually
  }

  // ── Wait for callback ───────────────────────────────────────────────────

  let code: string;
  try {
    code = await Promise.race([
      callbackPromise,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("timeout")), timeoutMs)
      ),
    ]);
  } catch (err) {
    server.close();
    const isTimeout = String(err).toLowerCase().includes("timeout");
    return {
      status: isTimeout ? "timeout" : "error",
      error: isTimeout
        ? `Timed out after ${input.timeout_seconds ?? 120}s waiting for browser authorization.`
        : String(err),
      auth_url: authUrl,
      hint: isTimeout
        ? (browserOpened
          ? "The browser window should still be open — complete the authorization there, then call authenticate_aps_3lo again."
          : `Open this URL in your browser to authorize:\n${authUrl}`)
        : undefined,
    };
  } finally {
    server.close();
  }

  // ── Exchange code for tokens ────────────────────────────────────────────

  try {
    const tokens = await exchangeAuthCode(clientId, clientSecret, code, REDIRECT_URI);

    // Warm the in-memory token cache so the next execute_workflow call is instant
    set3LOToken(clientId, tokens.access_token, tokens.expires_in, scopes);

    // Persist the refresh token to keychain for auto-refresh across MCP restarts
    const refreshStored = tokens.refresh_token
      ? storeRefreshToken(clientId, tokens.refresh_token)
      : false;

    return {
      status: "success",
      message:
        "3-legged OAuth complete. Your user token is active and will be used automatically " +
        "for account-level operations (e.g. creating ACC projects). " +
        (refreshStored
          ? "Refresh token saved to keychain — future MCP restarts will auto-renew without re-authorizing."
          : "Note: keychain unavailable, so you may need to re-authorize after MCP restarts."),
      scopes_granted: scopes,
      expires_in_seconds: tokens.expires_in,
      refresh_token_stored: refreshStored,
    };
  } catch (err) {
    return {
      status: "error",
      error: `Token exchange failed: ${String(err)}`,
      hint:
        "Verify that your APS app has this exact redirect URI registered:\n" +
        `  ${REDIRECT_URI}\n` +
        "Go to: https://aps.autodesk.com/myapps → your app → Edit → Callback URL",
    };
  }
}

// ── HTML helper ───────────────────────────────────────────────────────────

function callbackPage(title: string, message: string, color: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: white; border-radius: 12px; padding: 48px;
            box-shadow: 0 4px 24px rgba(0,0,0,0.1); text-align: center; max-width: 420px; }
    h1 { font-size: 2rem; margin: 0 0 16px; color: ${color}; }
    p  { color: #555; font-size: 1rem; margin: 0; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}
