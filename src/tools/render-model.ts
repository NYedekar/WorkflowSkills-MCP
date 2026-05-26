import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { resolveCredential } from "../auth/credential-resolver.js";

const execAsync = promisify(exec);

const MD_BASE = "https://developer.api.autodesk.com/modelderivative/v2";

// M1: pinned viewer version — update deliberately after testing; never use 7.* wildcard
const VIEWER_VERSION = "7.108.0";

// ── Schema ────────────────────────────────────────────────────────────────

export const renderModelSchema = z.object({
  oss_url: z
    .string()
    .regex(/^oss:\/\/[^/]+\/.+/, "Must be an oss:// URL in the form oss://bucketKey/objectKey") // M2
    .describe(
      "The oss:// URL of the model file (e.g. oss://bucket/model.rvt). " +
        "The model must already be in APS OSS — upload it with upload_file first."
    ),
  mode: z
    .enum(["viewer", "thumbnail"])
    .optional()
    .default("viewer")
    .describe(
      "'viewer' (default): auto-translates to SVF2 if needed, returns self-contained HTML " +
        "for Claude to present as an interactive 3D viewer artifact (experimental — rendering " +
        "depends on Claude Desktop's artifact heuristics; if blank, try mode='thumbnail'). " +
        "'thumbnail': returns a 400×400 PNG image inline in chat — reliable, no sandbox dependency."
    ),
  region: z
    .enum(["US", "EMEA"])
    .optional()
    .default("US")
    .describe(
      "Region for storing SVF2 derivatives. Default: 'US'. " +
        "Use 'EMEA' for EU data-residency compliance."
    ), // H4
  force_retranslate: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Force re-translation even if SVF2 derivatives already exist. " +
        "Deletes the existing manifest and restarts from scratch. " +
        "Use only if a previous translation produced a corrupt or incomplete result."
    ), // C4
});

export type RenderModelInput = z.infer<typeof renderModelSchema>;

export type RenderModelOutput =
  | { status: "success"; urn: string; file_path: string; message: string }             // viewer: saved + opened in browser
  | { status: "success"; urn: string; thumbnail_base64: string; content_type: string } // thumbnail: MCP image block
  | { status: "pending"; urn: string; message: string }
  | { status: "error"; error: string; hint?: string };

// ── Helpers ───────────────────────────────────────────────────────────────

function ossUrlToUrn(ossUrl: string): string {
  const withoutScheme = ossUrl.replace(/^oss:\/\//, "");
  const resourceUrn = `urn:adsk.objects:os.object:${withoutScheme}`;
  return Buffer.from(resourceUrn).toString("base64url"); // L3: native Node 18+ base64url
}

// L1: default 30s (was 15s — manifest on large models can be hundreds of KB)
async function apiFetch(url: string, options: RequestInit, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getManifestStatus(
  token: string,
  urn: string
): Promise<{ status: string; progress?: string } | null> {
  // H1: URN is base64url — chars [A-Za-z0-9_-] are URL-safe; no encodeURIComponent needed
  const res = await apiFetch(`${MD_BASE}/designdata/${urn}/manifest`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Manifest check failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { status?: string; progress?: string };
  return { status: data.status ?? "unknown", progress: data.progress };
}

async function startSvf2Translation(
  token: string,
  urn: string,
  region: string,
  force: boolean
): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  // C4: only send x-ads-force when explicitly requested — prevents wiping valid existing derivatives
  if (force) headers["x-ads-force"] = "true";

  const res = await apiFetch(`${MD_BASE}/designdata/job`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      input: { urn },
      output: {
        region, // H4: required for EMEA data-residency; harmless for US
        formats: [{ type: "svf2", views: ["2d", "3d"] }],
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Translation job failed to start: HTTP ${res.status} — ${body.slice(0, 300)}`
    );
  }
}

function buildViewerHtml(urn: string, token: string, tokenTtlSeconds: number): string {
  // C3: viewer mode is experimental — rendering as artifact depends on Claude Desktop heuristics.
  // C1: JSON.stringify() for safe embedding — guards against token/URN chars breaking JS string literals.
  // H3: tokenTtlSeconds is the actual remaining TTL from the cache, not a hardcoded 3600.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>APS Model Viewer</title>
  <link rel="stylesheet" href="${MD_BASE}/viewers/${VIEWER_VERSION}/style.min.css">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #1e1e1e; overflow: hidden; }
    #viewer { width: 100vw; height: 100vh; }
    #msg {
      position: fixed; inset: 0; display: flex; align-items: center;
      justify-content: center; color: #ccc; font: 14px sans-serif;
      background: #1e1e1e; pointer-events: none;
    }
  </style>
</head>
<body>
  <div id="viewer"></div>
  <div id="msg">Loading viewer…</div>
  <script src="${MD_BASE}/viewers/${VIEWER_VERSION}/viewer3D.min.js"></script>
  <script>
    (function () {
      var URN = ${JSON.stringify(urn)};
      var TOKEN = ${JSON.stringify(token)};
      var TTL = ${JSON.stringify(tokenTtlSeconds)};

      function onError(code, msg) {
        document.getElementById('msg').innerHTML =
          '<div style="text-align:center;padding:24px">' +
          '<b style="color:#f66">Viewer error ' + code + '</b><br>' + msg +
          '<br><br><small style="color:#999">If this is a network error, the artifact sandbox may be ' +
          'blocking APS CDN. Try <code>render_model(mode=\\"thumbnail\\")</code> instead.</small></div>';
      }

      Autodesk.Viewing.Initializer(
        {
          env: 'AutodeskProduction2',
          api: 'streamingV2',
          getAccessToken: function (cb) { cb(TOKEN, TTL); },
        },
        function () {
          document.getElementById('msg').textContent = 'Loading model…';
          var viewer = new Autodesk.Viewing.GuiViewer3D(document.getElementById('viewer'));
          viewer.start();
          Autodesk.Viewing.Document.load(
            'urn:' + URN,
            function (doc) {
              document.getElementById('msg').remove();
              viewer.loadDocumentNode(doc, doc.getRoot().getDefaultGeometry());
            },
            onError
          );
        }
      );
    })();
  </script>
</body>
</html>`;
}

// ── Handler ───────────────────────────────────────────────────────────────

export async function handleRenderModel(input: RenderModelInput): Promise<RenderModelOutput> {
  const urn = ossUrlToUrn(input.oss_url);

  // C2 + H5: two separate tokens with minimal scopes:
  //   writeToken  — data:read + data:write for manifest check and job POST
  //   viewerToken — viewables:read only for embedding in HTML (cannot download raw OSS objects)
  let writeToken: string;
  let viewerToken: string;
  let viewerTtl: number;
  try {
    const writeCred  = await resolveCredential(["data:read", "data:write"]);
    const viewerCred = await resolveCredential(["viewables:read"]);
    writeToken  = writeCred.access_token;
    viewerToken = viewerCred.access_token;
    viewerTtl   = viewerCred.expires_in_seconds; // H3: actual remaining TTL, not hardcoded 3600
  } catch (err) {
    return {
      status: "error",
      error: `APS auth failed: ${String(err)}`,
      hint: "Run authenticate_aps first.",
    };
  }

  // Check manifest
  let manifest: { status: string; progress?: string } | null;
  try {
    manifest = await getManifestStatus(writeToken, urn);
  } catch (err) {
    return { status: "error", error: `Failed to check model status: ${String(err)}` };
  }

  if (!manifest) {
    // No translation exists — start one
    try {
      await startSvf2Translation(writeToken, urn, input.region!, input.force_retranslate!);
    } catch (err) {
      return { status: "error", error: `Failed to start SVF2 translation: ${String(err)}` };
    }
    return {
      status: "pending",
      urn,
      // M4: guidance on retry ceiling so users know when to stop
      message:
        "SVF2 translation started. Call render_model again in 30–60 seconds to check progress. " +
        "Large models (>50 MB) can take 10–30 minutes. " +
        "If still pending after 30 minutes, the job has likely timed out — re-upload and try again.",
    };
  }

  // H2: "timeout" is a terminal failure state — treat same as "failed", not as retryable pending
  if (manifest.status === "failed" || manifest.status === "timeout") {
    return {
      status: "error",
      error:
        `Translation ${manifest.status}. ` +
        "The model may be invalid, unsupported, or too large. " +
        "Re-upload the file and call render_model again. " +
        "If the problem persists, try a different format (e.g. IFC instead of RVT).",
    };
  }

  if (manifest.status !== "success") {
    return {
      status: "pending",
      urn,
      message:
        `Translation ${manifest.status} (${manifest.progress ?? "?"}%). ` +
        "Call render_model again to check. " +
        "If still pending after 30 minutes, the job may have timed out — re-upload and try again.", // M4
    };
  }

  // ── Translation complete ──────────────────────────────────────────────────

  if (input.mode === "thumbnail") {
    // H1: no encodeURIComponent — URN is already URL-safe base64url
    const res = await apiFetch(
      `${MD_BASE}/designdata/${urn}/thumbnail?width=400&height=400`,
      { headers: { Authorization: `Bearer ${writeToken}` } }
    );
    if (!res.ok) {
      return { status: "error", error: `Thumbnail fetch failed: HTTP ${res.status}` };
    }
    // M3: read actual content-type from response — APS may return image/jpeg for some models
    const contentType = res.headers.get("content-type") ?? "image/png";
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      status: "success",
      urn,
      thumbnail_base64: Buffer.from(bytes).toString("base64"),
      content_type: contentType, // L2: typed as string, not literal "image/png"
    };
  }

  // Default: viewer HTML — save to ~/Downloads and open in system browser.
  // The Claude artifact iframe blocks external CDN (APS Viewer SDK never loads there).
  // Opening in the native browser bypasses the sandbox entirely: full WebGL, no CSP restriction.
  const html = buildViewerHtml(urn, viewerToken, viewerTtl);
  const shortUrn = urn.slice(0, 12);
  const filename = `aps-viewer-${shortUrn}.html`;
  const filePath = path.join(os.homedir(), "Downloads", filename);

  try {
    fs.writeFileSync(filePath, html, "utf-8");
  } catch (err) {
    return {
      status: "error",
      error: `Failed to save viewer HTML: ${String(err)}`,
      hint: "Check that ~/Downloads is writable.",
    };
  }

  try {
    await execAsync(`open "${filePath}"`);
  } catch (err) {
    // File is saved even if open fails — user can double-click it manually.
    return {
      status: "success",
      urn,
      file_path: filePath,
      message:
        `Viewer saved to ${filePath}. ` +
        `Could not auto-open (${String(err)}). Double-click the file to open it in your browser.`,
    };
  }

  return {
    status: "success",
    urn,
    file_path: filePath,
    message:
      `Viewer opened in your default browser. ` +
      `File saved at: ${filePath} — you can bookmark or share it. ` +
      `The token embedded in this file expires in ~${Math.floor(viewerTtl / 60)} minutes; ` +
      `call render_model again to regenerate a fresh copy.`,
  };
}
