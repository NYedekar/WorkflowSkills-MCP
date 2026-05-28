import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";
import { persistFinalizeQueue } from "../lib/finalize-store.js";
import { resolveCredential, resolve3LOCredential, DEFAULT_SCOPES } from "../auth/credential-resolver.js";
import { findCapabilityById, findOperationByGlobalId } from "../lib/registry-client.js";
import type { OperationRecord, CapabilityRecord } from "../lib/registry-client.js";
import {
  getActivity,
  createActivity,
  createActivityAlias,
  getNickname,
  ensureBucket,
  uploadJsonToOss,
  submitWorkItem,
  getSignedDownloadUrl,
  getSignedS3UploadUrl,
  uploadToS3,
  finalizeS3Upload,
  DAError,
  type WorkItemArgument,
  type ActivityDefinition,
} from "../lib/da-client.js";

// ── Schema ────────────────────────────────────────────────────────────────

export const executeWorkflowSchema = z.object({
  capability_id: z
    .string()
    .describe(
      "Capability ID or alias from get_capability. " +
        "Engine-API examples: 'RevitElementDataExtraction', 'revit:RevitModelHealthCheck'. " +
        "REST/Platform examples: 'BucketManagement', 'TranslationJobLifecycle', 'BIM360AccountAdmin', 'ObjectFileTransfer'."
    ),
  operation_id: z
    .string()
    .describe(
      "The specific operation to run from the capability's operations list. " +
        "Examples: 'extract-room-data', 'create_bucket', 'start_translation_job', 'list_assets'."
    ),

  // ── REST-specific ───────────────────────────────────────────────────────
  args: z
    .record(z.unknown())
    .optional()
    .describe(
      "All REST parameters in a single flat object — path params, query params, and body fields. " +
        "The tool auto-routes each key: names that match {placeholders} in the endpoint go to path, " +
        "remaining keys go to query (GET/DELETE) or body (POST/PUT/PATCH). " +
        "Example: { \"bucketKey\": \"my-bucket\", \"policyKey\": \"transient\" } " +
        "for create_bucket — bucketKey fills {bucketKey} in the path, policyKey goes in the body. " +
        "Tip: pass nested objects for body fields — the tool serialises them as JSON automatically. " +
        "Ignored for Engine-API capabilities."
    ),
  path_params: z
    .record(z.string())
    .optional()
    .default({})
    .describe(
      "[Deprecated — prefer args] Path parameter substitutions for REST endpoints. " +
        "Still accepted; merged with args (args takes precedence on key conflicts)."
    ),
  query_params: z
    .record(z.string())
    .optional()
    .default({})
    .describe(
      "[Deprecated — prefer args] Query string parameters appended to the REST URL. " +
        "Still accepted; merged with args (args takes precedence on key conflicts)."
    ),
  body: z
    .record(z.unknown())
    .optional()
    .describe(
      "[Deprecated — prefer args] Request body for POST / PUT / PATCH REST operations. " +
        "Still accepted; merged with args (args takes precedence on key conflicts)."
    ),
  bearer_token: z
    .string()
    .optional()
    .describe(
      "Explicit OAuth bearer token. Only needed if auto-auth fails or you have a pre-minted token. " +
        "For 3LO operations, call authenticate_aps_3lo instead — it stores the token automatically."
    ),

  // ── Engine-API (Design Automation) specific ─────────────────────────────
  input_file_url: z
    .string()
    .optional()
    .describe(
      "Input file URL for Engine-API or REST workflows. " +
        "Accepted formats: OSS URL (oss://bucket/path/file.rvt), HTTPS URL, or pre-signed URL. " +
        "Engine-API: used as the WorkItem input. " +
        "REST (e.g. Model Derivative): automatically converted to a base64url URN and injected into body.input.urn — " +
        "pass oss://bucket/object here instead of computing the URN manually."
    ),
  config: z
    .record(z.unknown())
    .optional()
    .default({})
    .describe(
      "Additional config merged into the Engine-API WorkItem config payload. " +
        "The 'operation' field is set automatically from operation_id. " +
        "Ignored for REST operations (use 'body' instead)."
    ),
  output_bucket: z
    .string()
    .optional()
    .describe(
      "OSS bucket key for Engine-API output files. " +
        "Defaults to '{clientId}-wf-outputs'. " +
        "Ignored for REST operations."
    ),
  output_bucket_policy: z
    .enum(["transient", "temporary", "persistent"])
    .optional()
    .default("transient")
    .describe(
      "Retention policy for the output bucket if it needs to be created. " +
        "'transient' = 24h TTL (default), 'temporary' = 30-day TTL, 'persistent' = no automatic deletion. " +
        "Has no effect if the bucket already exists. Ignored for REST operations."
    ),
  engine_version: z
    .string()
    .optional()
    .describe(
      "Engine-API Activity alias override. Defaults to 'prod'. " +
        "Ignored for REST operations."
    ),
  inline_args: z
    .record(z.string())
    .optional()
    .default({})
    .describe(
      "Inline string values for Engine-API WorkItem arguments with verb='read'. " +
        "Keys are argument names as defined in the activity (e.g. PersonalAccessToken, TaskParameters). " +
        "Values are passed as data: URIs directly in the WorkItem body — no OSS upload needed. " +
        "Example: { \"PersonalAccessToken\": \"your-pat\", \"TaskParameters\": \"{\\\"key\\\": \\\"value\\\"}\" }."
    ),
});

export type ExecuteWorkflowInput = z.infer<typeof executeWorkflowSchema>;

// ── Shared types (exported for get-workflow-status) ───────────────────────

export interface S3FinalizeEntry {
  bucketKey: string;
  objectKey: string;
  uploadKey: string;
  ossUrl: string;
}

export interface WorkflowHandle {
  type: "da_workitem";
  workItemId: string;
  outputOssUrls: string[];
  s3FinalizeQueue: S3FinalizeEntry[];
  first_polled_at?: number; // Unix ms — set on first poll, used to detect long-running jobs
}

// ── Result types ──────────────────────────────────────────────────────────

interface CapabilitySummary {
  id: string;
  alias: string;
  product: string;
  engine: string;
  domain: string;
  risk: string;
}

interface OperationSummary {
  operationId: string;
  displayName: string;
  risk: string;
  readOnly: boolean;
}

export interface ExecuteWorkflowResult {
  status: "success" | "pending" | "failed" | "activity_not_found" | "error";
  mode?: "engine_api" | "rest";
  // Engine-API fields
  workItemId?: string;
  workflow_handle?: WorkflowHandle; // present when status === "pending"
  outputOssUrl?: string;            // primary output — pass to get_result
  outputOssUrls?: string[];         // all outputs (multi-output operations like RevitExtractor)
  // REST fields
  http_status?: number;
  response?: unknown;
  response_oss_url?: string;    // set when response was stored in APS OSS (preferred path)
  response_saved_to?: string;   // set when OSS upload failed and response fell back to local disk
  response_size_bytes?: number;
  async_job?: boolean;
  async_job_note?: string;
  // Common
  capability?: CapabilitySummary;
  operation?: OperationSummary;
  reportUrl?: string;
  durationMs?: number;
  error?: string;
  hint?: string;
  activityChecked?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────

const DA_SCOPES = [
  "code:all",
  "data:read",
  "data:write",
  "data:create",
  "bucket:create",
  "bucket:read",
  "bucket:update",
];

const APS_BASE = "https://developer.api.autodesk.com";

// ── Activity auto-provisioning ────────────────────────────────────────────
// Loads a local Activity definition from data/activities/<name>.json and substitutes
// {NICKNAME} with the caller's DA nickname. Returns null if no definition exists.

function activityDefinitionsDir(): string {
  if (process.env.APS_ACTIVITIES_PATH) return process.env.APS_ACTIVITIES_PATH;
  const __dir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dir, "../../data/activities");
}

function loadActivityDefinition(activityName: string, nickname: string): ActivityDefinition | null {
  const defPath = path.join(activityDefinitionsDir(), `${activityName}.json`);
  try {
    const raw = fs.readFileSync(defPath, "utf-8").replace(/\{NICKNAME\}/g, nickname);
    return JSON.parse(raw) as ActivityDefinition;
  } catch {
    return null;
  }
}

// ── Main handler ──────────────────────────────────────────────────────────

export async function handleExecuteWorkflow(
  input: ExecuteWorkflowInput
): Promise<ExecuteWorkflowResult> {
  const t0 = Date.now();

  // 1. Resolve capability
  const cap =
    findCapabilityById(input.capability_id) ??
    findOperationByGlobalId(input.capability_id)?.capability;

  if (!cap) {
    return {
      status: "error",
      error: `Capability '${input.capability_id}' not found in registry.`,
      hint: "Use get_capability to search available capabilities. Pass the 'id' or 'alias' from the result.",
    };
  }

  // 2. Resolve operation
  const op = cap.operations.find(
    (o) =>
      o.operationId === input.operation_id ||
      (o.globalOperationId ?? "").endsWith(input.operation_id)
  );

  if (!op) {
    const available = cap.operations.map((o) => o.operationId).join(", ");
    return {
      status: "error",
      error: `Operation '${input.operation_id}' not found on capability '${cap.id}'.`,
      hint: `Available operations: ${available}`,
    };
  }

  // 3. Route by domain
  const isEngineApi = cap.domain === "Engine-APIs";
  if (isEngineApi) {
    return executeEngineApi(cap, op, input, t0);
  } else {
    return executeRest(cap, op, input, t0);
  }
}

// ── Large REST response → OSS storage ────────────────────────────────────
// Uploads the raw JSON string to APS OSS and returns the oss:// URL.
// Returns null on any failure so the caller can fall back gracefully.

const OSS_UPLOAD_SCOPES = [
  "data:read", "data:write", "data:create",
  "bucket:create", "bucket:read", "bucket:update",
];

async function storeResponseInOss(responseJson: string, opSlug: string): Promise<string | null> {
  let cred: { client_id: string; access_token: string };
  try {
    cred = await resolveCredential(OSS_UPLOAD_SCOPES);
  } catch {
    return null;
  }

  const rawKey = `${cred.client_id}-wf-outputs`;
  const bucketKey = rawKey.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 128).padEnd(3, "0");
  const objectKey = `rest-${opSlug}-${Date.now()}.json`;

  try { await ensureBucket(cred.access_token, bucketKey, "transient"); } catch { return null; }

  let signedUpload: { uploadKey: string; urls: string[] };
  try {
    signedUpload = await getSignedS3UploadUrl(cred.access_token, bucketKey, objectKey, 60);
  } catch { return null; }

  if (!signedUpload.urls?.length) return null;

  try {
    await uploadToS3(signedUpload.urls[0], Buffer.from(responseJson, "utf-8"), "application/json");
  } catch { return null; }

  try {
    await finalizeS3Upload(cred.access_token, bucketKey, objectKey, signedUpload.uploadKey);
  } catch { return null; }

  return `oss://${bucketKey}/${objectKey}`;
}

// ── REST execution ────────────────────────────────────────────────────────

async function executeRest(
  cap: CapabilityRecord,
  op: OperationRecord,
  input: ExecuteWorkflowInput,
  t0: number
): Promise<ExecuteWorkflowResult> {
  // Not callable?
  if (op.callable === false) {
    return {
      status: "error",
      capability: capSummary(cap),
      operation: opSummary(op),
      error: `Operation '${op.operationId}' is marked non-callable (documentation or SDK-only entry).`,
    };
  }

  // SDK-only?
  const flows = op.authFlows ?? cap.authFlows ?? [];
  if (flows.includes("(SDK)")) {
    return {
      status: "error",
      capability: capSummary(cap),
      operation: opSummary(op),
      error: `Operation '${op.operationId}' is a browser-side SDK call, not an HTTP endpoint.`,
      hint: "Use the Autodesk Viewer SDK (autodesk.com/viewer) in your browser or front-end application.",
    };
  }

  // Resolve bearer token — priority: explicit bearer_token > strategy-routed token
  let token: string;
  if (input.bearer_token) {
    token = input.bearer_token;
  } else {
    const scopes = resolveScopes(op.authScopes ?? [], DEFAULT_SCOPES);
    const strategy = resolveAuthStrategy(op, cap);

    if (strategy === "3LO") {
      const cred3lo = await resolve3LOCredential(scopes);
      if (cred3lo) {
        token = cred3lo.access_token;
      } else {
        return {
          status: "error",
          capability: capSummary(cap),
          operation: opSummary(op),
          error: "3LO_REQUIRED",
          hint:
            "This operation requires a user-identity token. " +
            "Call authenticate_aps_3lo first — it opens a browser login, stores the token, and retries automatically. " +
            `Required scopes: ${(op.authScopes ?? []).join(", ") || "(see APS docs)"}.`,
        };
      }
    } else if (strategy === "either") {
      const cred3lo = await resolve3LOCredential(scopes);
      if (cred3lo) {
        token = cred3lo.access_token;
      } else {
        try {
          const cred = await resolveCredential(scopes);
          token = cred.access_token;
        } catch (err) {
          return {
            status: "error",
            error: `APS auth failed: ${String(err)}`,
            hint: "Run authenticate_aps first, or call authenticate_aps_3lo for user-identity operations.",
          };
        }
      }
    } else {
      // "2LO" — skip 3LO attempt entirely
      try {
        const cred = await resolveCredential(scopes);
        token = cred.access_token;
      } catch (err) {
        return {
          status: "error",
          error: `APS auth failed: ${String(err)}`,
          hint: "Run authenticate_aps first to configure credentials.",
        };
      }
    }
  }



  const method = (op.httpMethod ?? "GET").toUpperCase();

  // Route args → path_params / query_params / body (S2-B: flat args consolidation)
  const { resolvedPathParams, resolvedQueryParams, resolvedBody } = routeArgs(
    input.args ?? {},
    input.path_params ?? {},
    input.query_params ?? {},
    input.body,
    op.endpoint ?? "",
    method
  );

  // Build URL
  const { url, unusedParams } = buildUrl(op.endpoint ?? "", resolvedPathParams, resolvedQueryParams);

  if (unusedParams.length > 0) {
    return {
      status: "error",
      capability: capSummary(cap),
      operation: opSummary(op),
      error: `Unrecognised path params: ${unusedParams.join(", ")}.`,
      hint: `Endpoint template is '${op.endpoint}'. Use the args field — path placeholders are auto-detected.`,
    };
  }

  // Check for unfilled required path params
  const unresolved = [...url.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  if (unresolved.length > 0) {
    return {
      status: "error",
      capability: capSummary(cap),
      operation: opSummary(op),
      error: `Missing required path params: ${unresolved.map((p) => `{${p}}`).join(", ")}.`,
      hint: `Pass these as keys in the args object. Endpoint: '${op.endpoint}'.`,
    };
  }

  const fullUrl = `${APS_BASE}${url}`;

  // Build headers
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };

  // Auto-inject base64url URN into body.input.urn for REST ops (e.g. Model Derivative).
  // input_file_url is an Engine-API param; REST ops like MD need body.input.urn instead.
  let effectiveBody: Record<string, unknown> = resolvedBody ? { ...resolvedBody } : {};
  let manualUrnOverrideWarning: string | undefined;
  if (input.input_file_url?.startsWith("oss://")) {
    const ossPath = input.input_file_url.slice("oss://".length);
    const urnRaw = `urn:adsk.objects:os.object:${ossPath}`;
    const b64urn = Buffer.from(urnRaw)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const existingInput = (effectiveBody.input ?? {}) as Record<string, unknown>;
    if (!existingInput.urn) {
      effectiveBody = { ...effectiveBody, input: { ...existingInput, urn: b64urn } };
    } else {
      manualUrnOverrideWarning =
        `body.input.urn was provided manually ('${String(existingInput.urn).slice(0, 40)}...'); ` +
        `auto-computed URN from input_file_url was skipped. ` +
        `If the translation worker fails to download, verify the manual URN is correct base64url.`;
    }
  }

  let bodyStr: string | undefined;
  if (Object.keys(effectiveBody).length > 0) {
    if (["POST", "PUT", "PATCH"].includes(method)) {
      bodyStr = JSON.stringify(effectiveBody);
      headers["Content-Type"] = "application/json";
    }
  }

  // Execute HTTP call
  // Retry up to 2 times on timeout or connection-reset — APS can stall transiently.
  let res!: Response;
  const MAX_REST_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_REST_RETRIES; attempt++) {
    if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 1_000 * attempt));
    const restController = new AbortController();
    const restTimer = setTimeout(() => restController.abort(), 90_000);
    try {
      res = await fetch(fullUrl, { method, headers, body: bodyStr, signal: restController.signal });
      break;
    } catch (err) {
      clearTimeout(restTimer);
      const isRetryable =
        (err instanceof Error && err.name === "AbortError") ||
        (err instanceof TypeError);
      if (!isRetryable || attempt === MAX_REST_RETRIES) {
        return {
          status: "error",
          mode: "rest",
          capability: capSummary(cap),
          operation: opSummary(op),
          error: `Network error after ${attempt + 1} attempt(s): ${String(err)}`,
        };
      }
    } finally {
      clearTimeout(restTimer);
    }
  }

  const durationMs = Date.now() - t0;
  let responseBody: unknown;

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    responseBody = await res.json().catch(() => null);
  } else {
    responseBody = await res.text().catch(() => null);
  }

  if (!res.ok) {
    return {
      status: "failed",
      mode: "rest",
      http_status: res.status,
      capability: capSummary(cap),
      operation: opSummary(op),
      response: responseBody,
      durationMs,
      error: `HTTP ${res.status} ${res.statusText}`,
      hint: httpHint(res.status, fullUrl),
    };
  }

  // Guard against tool-result-too-large: APS property/metadata dumps can be 1–5MB raw.
  // Primary path: upload to OSS → return oss_url (consistent with Engine-API output pattern).
  // Fallback: save to ~/Downloads if OSS upload fails.
  const INLINE_LIMIT = 800_000;
  const responseJson = typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody);
  const responseSize = Buffer.byteLength(responseJson, "utf-8");
  let responseOssUrl: string | undefined;
  let savedResponseTo: string | undefined;
  let effectiveResponseBody: unknown = responseBody;

  if (responseSize > INLINE_LIMIT) {
    const opSlug = op.operationId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 40);
    const sizeKb = (responseSize / 1024).toFixed(0);

    const ossTimeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 25_000));
    responseOssUrl = await Promise.race([storeResponseInOss(responseJson, opSlug), ossTimeout]) ?? undefined;

    if (responseOssUrl) {
      effectiveResponseBody =
        `[Response too large to return inline — ${sizeKb} KB stored in APS OSS. ` +
        `Call get_download_link(oss_url="${responseOssUrl}") to get a clickable download link, ` +
        `or get_result(oss_url="${responseOssUrl}", save_to="~/Downloads") to save to disk.]`;
    } else {
      // OSS upload failed — fall back to local disk
      const filename = `aps-${opSlug}-${Date.now()}.json`;
      savedResponseTo = path.join(os.homedir(), "Downloads", filename);
      try {
        fs.writeFileSync(savedResponseTo, responseJson, "utf-8");
        effectiveResponseBody =
          `[Response too large to return inline — ${sizeKb} KB. Saved to: ${savedResponseTo}.]`;
      } catch {
        effectiveResponseBody =
          `[Response truncated — ${sizeKb} KB total, too large to return inline. ` +
          `Preview: ${responseJson.slice(0, 5_000)}...]`;
      }
    }
  }

  const result: ExecuteWorkflowResult = {
    status: "success",
    mode: "rest",
    http_status: res.status,
    capability: capSummary(cap),
    operation: opSummary(op),
    response: effectiveResponseBody,
    ...(responseOssUrl ? { response_oss_url: responseOssUrl, response_size_bytes: responseSize } : {}),
    ...(savedResponseTo ? { response_saved_to: savedResponseTo, response_size_bytes: responseSize } : {}),
    durationMs,
    ...(manualUrnOverrideWarning ? { hint: manualUrnOverrideWarning } : {}),
  };

  if (op.asyncJob) {
    result.async_job = true;
    result.async_job_note = buildPollingNote(op, responseBody as Record<string, unknown> | null);
  }

  return result;
}

// ── Engine-API (Design Automation) execution ──────────────────────────────

async function executeEngineApi(
  cap: CapabilityRecord,
  op: OperationRecord,
  input: ExecuteWorkflowInput,
  t0: number
): Promise<ExecuteWorkflowResult> {
  // Determine if the activity actually needs an input file (has any get-verb arg).
  const templateArgs = op.workItemTemplate?.arguments ?? {};
  const workItemArgs_ = op.workItemArguments ?? {};
  const hasGetArg =
    Object.values(templateArgs).some((a) => a.verb === "get") ||
    Object.values(workItemArgs_).some((a) => (a as { verb?: string }).verb === "get") ||
    (!op.workItemTemplate && !op.workItemArguments); // generic fallback always needs input

  if (!input.input_file_url && hasGetArg) {
    return {
      status: "error",
      mode: "engine_api",
      capability: capSummary(cap),
      operation: opSummary(op),
      error: "input_file_url is required for this Engine-API capability.",
      hint: "Provide an OSS URL (oss://bucket/file.rvt), HTTPS URL, or signed URL for the input file.",
    };
  }

  let cred: { client_id: string; access_token: string };
  try {
    cred = await resolveCredential(DA_SCOPES);
  } catch (err) {
    return {
      status: "error",
      error: `APS auth failed: ${String(err)}`,
      hint: "Run authenticate_aps first to configure credentials.",
    };
  }

  // Resolve the DA nickname (separate from OAuth client_id — fetched from forgeapps/me).
  const nickname = await getNickname(cred.access_token, cred.client_id);

  const engineAlias = input.engine_version ?? "prod";
  const ts = Date.now();

  // DA WorkItems cannot resolve oss:// URLs — convert to signed HTTPS first
  let resolvedInputUrl = input.input_file_url ?? "";
  if (resolvedInputUrl.startsWith("oss://")) {
    try {
      resolvedInputUrl = await getSignedDownloadUrl(cred.access_token, resolvedInputUrl);
    } catch (err) {
      return { status: "error", error: `Could not resolve signed URL for input: ${String(err)}` };
    }
  }

  const safeBucketKey = (input.output_bucket ?? `${cred.client_id}-wf-outputs`)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128)
    .padEnd(3, "0");

  try {
    await ensureBucket(cred.access_token, safeBucketKey, input.output_bucket_policy);
  } catch (err) {
    return { status: "error", error: `Could not ensure output bucket: ${String(err)}` };
  }

  // ── Determine activity ID ─────────────────────────────────────────────
  // Public Autodesk activities have a fixed ID (no nickname substitution needed).
  // User-owned activities use {NICKNAME} in the template or are built from cap.alias.
  let activityId: string;
  if (op.workItemArguments) {
    const activityName = op.activityId ?? cap.alias;
    activityId = `${nickname}.${activityName}+${engineAlias}`;
  } else if (op.workItemTemplate) {
    activityId = op.workItemTemplate.activityId.replace(/\{NICKNAME\}/g, nickname);
  } else {
    activityId = `${nickname}.${cap.alias}+${engineAlias}`;
  }

  // ── Check activity exists ─────────────────────────────────────────────
  let activityExists: unknown;
  try {
    activityExists = await getActivity(cred.access_token, activityId);
  } catch (err) {
    return {
      status: "error",
      error: `Could not check Activity: ${String(err)}`,
      activityChecked: activityId,
    };
  }

  if (!activityExists) {
    // Derive unqualified name (strip "nickname." prefix and "+alias" suffix)
    const unqualifiedName = activityId
      .replace(`${nickname}.`, "")
      .replace(/\+[^+]+$/, "");

    const definition = loadActivityDefinition(unqualifiedName, nickname);

    if (definition) {
      // Auto-provision: create Activity + prod alias from local definition
      try {
        await createActivity(cred.access_token, definition);
        await createActivityAlias(cred.access_token, `${nickname}.${definition.id}`, engineAlias, 1);
      } catch (err) {
        return {
          status: "activity_not_found",
          mode: "engine_api",
          capability: capSummary(cap),
          operation: opSummary(op),
          activityChecked: activityId,
          error: `Activity '${activityId}' not found and auto-provisioning failed: ${String(err)}`,
          hint: `Ensure the AppBundle '${nickname}.ExtractAutoCADDrawingMetadata+prod' is registered before creating this Activity.`,
        };
      }
      // Fall through to work item submission with the freshly created Activity
    } else {
      return {
        status: "activity_not_found",
        mode: "engine_api",
        capability: capSummary(cap),
        operation: opSummary(op),
        activityChecked: activityId,
        error: `APS Activity '${activityId}' not found.`,
        hint: op.workItemArguments || op.workItemTemplate
          ? `Re-run the GitHub Actions workflow to publish the AppBundle and Activity under your APS account.`
          : `The AppBundle for '${cap.alias}' has not been registered in your APS account.\n\n` +
            `Register it:\n` +
            `  1. POST /da/us-east/v3/appbundles\n` +
            `     { "id": "${cap.alias}", "engine": "${resolveEngineAlias(cap.engine)}" }\n\n` +
            `  2. POST /da/us-east/v3/activities\n` +
            `     { "id": "${cap.alias}", "engine": "${resolveEngineAlias(cap.engine)}",\n` +
            `       "appbundles": ["${cred.client_id}.${cap.alias}+prod"],\n` +
            `       "parameters": {\n` +
            `         "${deriveInputArgName(cap.ioShape)}": { "verb": "get" },\n` +
            `         "config": { "verb": "get", "localName": "config.json" },\n` +
            `         "result": { "verb": "put", "localName": "result.json" }\n` +
            `       }\n` +
            `     }\n\n` +
            `  3. POST /da/us-east/v3/activities/${cap.alias}/aliases\n` +
            `     { "id": "prod", "version": 1 }`,
      };
    }
  }

  // ── Build WorkItem args with presigned S3 upload URLs for outputs ─────
  // DA cannot PUT to oss:// URLs. Presigned S3 URLs work without auth headers.
  const workItemArgs: Record<string, WorkItemArgument> = {};
  const s3FinalizeQueue: S3FinalizeEntry[] = [];
  const outputOssUrls: string[] = [];

  if (op.workItemArguments) {
    // Preferred: registry-defined arg shape with localName support
    for (const [argName, argDef] of Object.entries(op.workItemArguments)) {
      if (argDef.verb === "get") {
        workItemArgs[argName] = { url: resolvedInputUrl, verb: "get", optional: argDef.optional };
      } else {
        const localName = argDef.localName ?? "result.json";
        const ext = "." + localName.split(".").pop()!;
        const outKey = `wf-output-${cap.alias}-${argName}-${ts}${ext}`;
        let s3Upload: { uploadKey: string; urls: string[] };
        try {
          s3Upload = await getSignedS3UploadUrl(cred.access_token, safeBucketKey, outKey);
        } catch (err) {
          return { status: "error", error: `Could not get S3 upload URL for output '${argName}': ${String(err)}` };
        }
        const ct = outputContentType(outKey);
        workItemArgs[argName] = {
          url: s3Upload.urls[0],
          verb: "put",
          ...(ct ? { headers: { "Content-Type": ct } } : {}),
        };
        outputOssUrls.push(`oss://${safeBucketKey}/${outKey}`);
        s3FinalizeQueue.push({ bucketKey: safeBucketKey, objectKey: outKey, uploadKey: s3Upload.uploadKey, ossUrl: `oss://${safeBucketKey}/${outKey}` });
      }
    }
  } else if (op.workItemTemplate) {
    for (const [argName, argDef] of Object.entries(op.workItemTemplate.arguments)) {
      if (argDef.verb === "read") {
        // Inline string arg — caller provides value via inline_args.
        // Encoded as a data: URI so DA passes it as an in-memory string to the activity.
        const inlineValue = (input.inline_args ?? {})[argName];
        if (inlineValue !== undefined) {
          workItemArgs[argName] = {
            url: `data:text/plain,${encodeURIComponent(inlineValue)}`,
            verb: "read",
          };
        }
        // No inline_args value supplied → skip (arg is optional in the activity).
      } else if (argDef.verb === "get") {
        if (argName === "params" && input.config && Object.keys(input.config).length > 0) {
          const paramsKey = `wf-params-${cap.alias}-${ts}.json`;
          await uploadJsonToOss(cred.access_token, safeBucketKey, paramsKey, input.config);
          const paramsSignedUrl = await getSignedDownloadUrl(cred.access_token, `oss://${safeBucketKey}/${paramsKey}`);
          workItemArgs[argName] = { url: paramsSignedUrl, verb: "get" };
        } else {
          workItemArgs[argName] = { url: resolvedInputUrl, verb: "get" };
        }
      } else {
        // put / post → output arg. Use the localName from the registry for the correct extension.
        const localName = argDef.localName ?? "result.json";
        const ext = localName.includes(".") ? "." + localName.split(".").pop()! : ".json";
        const outKey = `wf-output-${cap.alias}-${argName}-${ts}${ext}`;
        let s3Upload: { uploadKey: string; urls: string[] };
        try {
          s3Upload = await getSignedS3UploadUrl(cred.access_token, safeBucketKey, outKey);
        } catch (err) {
          return { status: "error", error: `Could not get S3 upload URL for output '${argName}': ${String(err)}` };
        }
        const ct = outputContentType(outKey);
        workItemArgs[argName] = {
          url: s3Upload.urls[0],
          verb: "put",
          ...(ct ? { headers: { "Content-Type": ct } } : {}),
        };
        outputOssUrls.push(`oss://${safeBucketKey}/${outKey}`);
        s3FinalizeQueue.push({ bucketKey: safeBucketKey, objectKey: outKey, uploadKey: s3Upload.uploadKey, ossUrl: `oss://${safeBucketKey}/${outKey}` });
      }
    }
  } else {
    // Generic fallback: rvtFile + config + result
    const configKey = `wf-config-${cap.alias}-${ts}.json`;
    const configPayload = { operation: input.operation_id, capabilityId: cap.id, ...input.config };
    try {
      await uploadJsonToOss(cred.access_token, safeBucketKey, configKey, configPayload);
    } catch (err) {
      return { status: "error", error: `Could not upload config to OSS: ${String(err)}` };
    }
    let configSignedUrl: string;
    try {
      configSignedUrl = await getSignedDownloadUrl(cred.access_token, `oss://${safeBucketKey}/${configKey}`);
    } catch (err) {
      return { status: "error", error: `Could not get signed URL for config: ${String(err)}` };
    }
    const inputArgName = deriveInputArgName(cap.ioShape);
    const outKey = `wf-output-${cap.alias}-${ts}.json`;
    let s3Upload: { uploadKey: string; urls: string[] };
    try {
      s3Upload = await getSignedS3UploadUrl(cred.access_token, safeBucketKey, outKey);
    } catch (err) {
      return { status: "error", error: `Could not get S3 upload URL for result: ${String(err)}` };
    }
    workItemArgs[inputArgName] = { url: resolvedInputUrl, verb: "get" };
    workItemArgs["config"] = { url: configSignedUrl, verb: "get" };
    workItemArgs["result"] = {
      url: s3Upload.urls[0],
      verb: "put",
      headers: { "Content-Type": "application/json" },
    };
    outputOssUrls.push(`oss://${safeBucketKey}/${outKey}`);
    s3FinalizeQueue.push({ bucketKey: safeBucketKey, objectKey: outKey, uploadKey: s3Upload.uploadKey, ossUrl: `oss://${safeBucketKey}/${outKey}` });
  }

  // ── Submit WorkItem ───────────────────────────────────────────────────
  let workItemId: string;
  try {
    workItemId = await submitWorkItem(cred.access_token, activityId, workItemArgs);
  } catch (err) {
    if (err instanceof DAError) {
      return {
        status: "error",
        mode: "engine_api",
        error: `Submit WorkItem failed (HTTP ${err.statusCode ?? "?"}): ${err.message}`,
        activityChecked: activityId,
        capability: capSummary(cap),
        operation: opSummary(op),
      };
    }
    return { status: "error", error: String(err) };
  }

  // ── Submit complete — return pending immediately ───────────────────────
  // Persist the finalize queue to disk so it survives connection drops and
  // LLM handle reconstruction (which may zero out s3FinalizeQueue).
  persistFinalizeQueue(workItemId, s3FinalizeQueue);

  return {
    status: "pending",
    mode: "engine_api",
    workItemId,
    // s3FinalizeQueue is stripped from the handle — disk store is authoritative.
  // Keeping large uploadKey payloads in the LLM-facing handle overflows the MCP stdio buffer.
  workflow_handle: { type: "da_workitem", workItemId, outputOssUrls, s3FinalizeQueue: [] },
    durationMs: Date.now() - t0,
    hint: "WorkItem submitted. Call get_workflow_status(workflow_handle) to poll for completion. Repeat until status is 'success' or 'failed'.",
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

// Routes flat args → {path, query, body} based on endpoint template + HTTP method.
// path_params / query_params / body (deprecated) are merged in as low-priority defaults;
// keys from args always win on conflict.
function routeArgs(
  args: Record<string, unknown>,
  legacyPath: Record<string, string>,
  legacyQuery: Record<string, string>,
  legacyBody: Record<string, unknown> | undefined,
  endpoint: string,
  method: string
): {
  resolvedPathParams: Record<string, string>;
  resolvedQueryParams: Record<string, string>;
  resolvedBody: Record<string, unknown> | undefined;
} {
  // Collect all {placeholder} names from the endpoint template
  const pathKeys = new Set(
    [...endpoint.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])
  );

  const resolvedPathParams: Record<string, string> = { ...legacyPath };
  const queryOverrides: Record<string, string> = {};
  const bodyOverrides: Record<string, unknown> = {};
  const isBodyMethod = ["POST", "PUT", "PATCH"].includes(method);

  for (const [key, value] of Object.entries(args)) {
    if (pathKeys.has(key)) {
      resolvedPathParams[key] = String(value);
    } else if (isBodyMethod) {
      bodyOverrides[key] = value;
    } else {
      queryOverrides[key] = String(value);
    }
  }

  const resolvedQueryParams: Record<string, string> = { ...legacyQuery, ...queryOverrides };
  const resolvedBody: Record<string, unknown> | undefined =
    Object.keys(bodyOverrides).length > 0 || legacyBody
      ? { ...(legacyBody ?? {}), ...bodyOverrides }
      : undefined;

  return { resolvedPathParams, resolvedQueryParams, resolvedBody };
}

// Derives the effective auth strategy for a REST operation.
// Priority: explicit authStrategy field → inferred from authFlows.
function resolveAuthStrategy(
  op: OperationRecord,
  cap: CapabilityRecord
): "2LO" | "3LO" | "either" {
  const explicit = op.authStrategy ?? cap.authStrategy;
  if (explicit) return explicit;

  const flows = op.authFlows ?? cap.authFlows ?? [];
  const has2lo = flows.includes("2LO-client-credentials");
  const has3lo = flows.some((f) => f.startsWith("3LO") || f.includes("auth-code") || f.includes("PKCE"));

  if (has2lo && has3lo) return "either";
  if (has3lo) return "3LO";
  return "2LO"; // 2LO-only, empty flows, SDK, or unknown
}

function capSummary(c: CapabilityRecord): CapabilitySummary {
  return { id: c.id, alias: c.alias, product: c.product, engine: c.engine, domain: c.domain, risk: c.risk };
}

function opSummary(o: OperationRecord): OperationSummary {
  return { operationId: o.operationId, displayName: o.displayName, risk: o.risk, readOnly: o.readOnly };
}

function buildUrl(
  template: string,
  pathParams: Record<string, string>,
  queryParams: Record<string, string>
): { url: string; unusedParams: string[] } {
  // Split endpoint at ? to separate path from inline defaults
  const [pathPart, inlineQuery] = template.split("?");

  // Substitute path params
  let path = pathPart;
  const used = new Set<string>();
  path = path.replace(/\{([^}]+)\}/g, (match, key) => {
    if (key in pathParams) {
      used.add(key);
      return safeEncodeParam(pathParams[key]);
    }
    return match; // leave unresolved — caller will see error
  });

  const unusedParams = Object.keys(pathParams).filter((k) => !used.has(k));

  // Merge query params
  const allQuery: Record<string, string> = {};
  if (inlineQuery) {
    for (const part of inlineQuery.split("&")) {
      const [k, v] = part.split("=");
      if (k) allQuery[k] = v ?? "";
    }
  }
  Object.assign(allQuery, queryParams);

  const qs = Object.entries(allQuery)
    .map(([k, v]) => `${safeEncodeParam(k)}=${safeEncodeParam(v)}`)
    .join("&");

  return { url: qs ? `${path}?${qs}` : path, unusedParams };
}

function resolveScopes(authScopes: string[], fallback: string[]): string[] {
  const clean = authScopes.filter(
    (s) => s && !s.startsWith("<") && s !== "(none)" && s.trim().length > 0
  );
  return clean.length > 0 ? clean : fallback;
}

function httpHint(status: number, url?: string): string {
  if (status === 401) return "Token invalid or expired. Run authenticate_aps or provide a valid bearer_token.";
  if (status === 403) return "Insufficient scopes. Check the authScopes on the operation via get_capability.";
  if (status === 404) {
    let hint = "Resource not found. Verify path_params (IDs, keys) are correct.";
    // APS quirk: SVF2/manifest geometry GUIDs are different from metadata API GUIDs.
    // Using a manifest GUID in fetch_all_properties or fetch_object_tree returns 404.
    if (url && (url.includes("/modelderivative/") || url.includes("/metadata/") || url.includes("/properties"))) {
      hint +=
        " GUID MISMATCH WARNING: If you used a GUID from the SVF2 manifest or translate response, " +
        "note that manifest geometry GUIDs differ from metadata API GUIDs. " +
        "Call list_model_views first to get the correct GUIDs for fetch_object_tree and fetch_all_properties.";
    }
    return hint;
  }
  if (status === 409) return "Conflict — resource may already exist.";
  if (status === 422) return "Unprocessable entity — check the body payload matches the expected schema.";
  if (status === 429) return "Rate limited. Retry after a short wait.";
  if (status >= 500) return "APS server error. Check https://health.autodesk.com or retry.";
  return "";
}

function deriveInputArgName(ioShape: string): string {
  const lower = ioShape.toLowerCase();
  if (lower.includes(".rvt")) return "rvtFile";
  if (lower.includes(".dwg")) return "dwgFile";
  if (lower.includes(".ipt") || lower.includes(".iam")) return "inventorFile";
  if (lower.includes(".f3d") || lower.includes("fusion")) return "f3dFile";
  if (lower.includes(".max") || lower.includes("3dsmax")) return "maxFile";
  return "inputFile";
}

// Maps output file extensions to the Content-Type header sent with the WorkItem PUT argument.
// DA propagates this header to S3 at write time, so get_result sees the correct type.
const OUTPUT_CONTENT_TYPES: Record<string, string> = {
  json:   "application/json",
  csv:    "text/csv",
  xml:    "application/xml",
  txt:    "text/plain",
  html:   "text/html",
  htm:    "text/html",
  svg:    "image/svg+xml",
  tsv:    "text/tab-separated-values",
  yaml:   "application/yaml",
  yml:    "application/yaml",
  log:    "text/plain",
};

function outputContentType(filename: string): string | undefined {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  return OUTPUT_CONTENT_TYPES[ext];
}

// Builds a polling instruction note for async REST jobs.
// If the operation has asyncJobPolling in the registry, resolve path params from
// the job response using path_param_map and produce specific instructions.
// Falls back to a generic note when no polling metadata is available.
function buildPollingNote(
  op: OperationRecord,
  jobResponse: Record<string, unknown> | null
): string {
  if (!op.asyncJobPolling) {
    return "Async job started. Poll the status endpoint using execute_workflow with the job ID from the response.";
  }
  const { capability_id, operation_id, path_param_map } = op.asyncJobPolling;
  const resolvedParams: Record<string, string> = {};
  for (const [paramName, responsePath] of Object.entries(path_param_map)) {
    const value = responsePath.split(".").reduce<unknown>(
      (obj, key) => (obj as Record<string, unknown>)?.[key],
      jobResponse
    );
    resolvedParams[paramName] = value != null ? String(value) : `<${responsePath}>`;
  }
  const paramsStr = Object.entries(resolvedParams)
    .map(([k, v]) => `${k}: '${v}'`)
    .join(", ");
  return (
    `Async job accepted. Poll for completion with:\n` +
    `  execute_workflow(capability_id='${capability_id}', operation_id='${operation_id}',\n` +
    `    path_params={${paramsStr}})`
  );
}

// Normalize a path param value to a single layer of percent-encoding.
// Callers may pass pre-encoded values (e.g. a derivativeUrn copied from the manifest
// that already contains %3A sequences). Blindly calling encodeURIComponent would
// double-encode those to %253A. Decode first, then re-encode exactly once.
function safeEncodeParam(value: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(value));
  } catch {
    return encodeURIComponent(value);
  }
}

function resolveEngineAlias(engineField: string): string {
  const lower = engineField.toLowerCase();
  if (lower.includes("revit")) return "Autodesk.Revit+2025";
  if (lower.includes("autocad")) return "Autodesk.AutoCAD+25";
  if (lower.includes("fusion")) return "Autodesk.Fusion+latest";
  if (lower.includes("inventor")) return "Autodesk.Inventor+2025";
  if (lower.includes("3dsmax") || lower.includes("3ds max")) return "Autodesk.3dsMax+2025";
  return engineField;
}
