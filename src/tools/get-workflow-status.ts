import { z } from "zod";
import { resolveCredential } from "../auth/credential-resolver.js";
import { pollWorkItem, finalizeS3Upload } from "../lib/da-client.js";
import type { WorkflowHandle, S3FinalizeEntry } from "./execute-workflow.js";
import { loadFinalizeQueue, cleanFinalizeQueue } from "../lib/finalize-store.js";
import { removeActiveJob } from "../lib/session-store.js";

// ── Schema ────────────────────────────────────────────────────────────────

const s3FinalizeEntrySchema = z.object({
  bucketKey: z.string(),
  objectKey: z.string(),
  uploadKey: z.string(),
  ossUrl: z.string(),
});

const workflowHandleSchema = z.object({
  type: z.enum(["da_workitem"]),
  workItemId: z.string(),
  outputOssUrls: z.array(z.string()),
  s3FinalizeQueue: z.array(s3FinalizeEntrySchema).optional().default([]),
  first_polled_at: z.number().int().optional(),
});

export const getWorkflowStatusSchema = z.object({
  workflow_handle: workflowHandleSchema.describe(
    "The workflow_handle object returned by execute_workflow or a previous get_workflow_status call " +
      "when status was 'pending'. Pass it back exactly as received — do not modify it."
  ),
  // timeout_ms is intentionally not exposed to the LLM — 15s is always correct.
  // Exposing it caused the LLM to pass 30–55s on "long-looking" jobs, making polls feel like stalls.
});

export type GetWorkflowStatusInput = z.infer<typeof getWorkflowStatusSchema>;

// Fixed — never expose to the LLM. 25s deadline saves ~39% round-trips on 7-min Revit jobs vs 15s (normal network).
// Note: fetchWithTimeout uses maxRetries=2 by default, so a single iteration can overrun to ~36s in worst case.
// Worst-case get_workflow_status duration: ~36s (poll) + 12s (finalize) = ~48s — within MCP 60s transport limit.
const POLL_TIMEOUT_MS = 25_000;

export interface GetWorkflowStatusOutput {
  status: "pending" | "running" | "success" | "failed" | "cancelled" | "error";
  next_action?: string; // explicit instruction for what to call next
  workflow_handle?: WorkflowHandle; // present ONLY when status === "pending" — absence means job is done
  workItemId?: string;
  outputOssUrls?: string[];
  reportUrl?: string;
  poll_duration_ms?: number; // time spent in this polling call — NOT the job runtime
  durationMs?: number;       // job wall-clock duration (success/failed only)
  error?: string;
  hint?: string;
}

// ── Handler ───────────────────────────────────────────────────────────────

const DA_SCOPES = [
  "code:all",
  "data:read",
  "data:write",
  "data:create",
  "bucket:create",
  "bucket:read",
  "bucket:update",
];

export async function handleGetWorkflowStatus(
  input: GetWorkflowStatusInput
): Promise<GetWorkflowStatusOutput> {
  const t0 = Date.now();
  const handle = input.workflow_handle;

  // ── Auth ──────────────────────────────────────────────────────────────────
  let token: string;
  try {
    const cred = await resolveCredential(DA_SCOPES);
    token = cred.access_token;
  } catch (err) {
    return {
      status: "error",
      workItemId: handle.workItemId,
      error: `APS auth failed: ${String(err)}`,
      hint: "Run authenticate_aps first.",
    };
  }

  // ── Dispatch by handle type ───────────────────────────────────────────────
  if (handle.type === "da_workitem") {
    return pollDaWorkItem(token, handle, POLL_TIMEOUT_MS, t0);
  }

  return {
    status: "error",
    error: `Unknown workflow_handle type: '${(handle as WorkflowHandle).type}'. Only 'da_workitem' is supported currently.`,
  };
}

// ── DA WorkItem poller ────────────────────────────────────────────────────

async function pollDaWorkItem(
  token: string,
  handle: WorkflowHandle,
  timeoutMs: number,
  t0: number
): Promise<GetWorkflowStatusOutput> {
  let finalItem;
  let timedOut = false;
  let pollError: string | undefined;

  try {
    finalItem = await pollWorkItem(token, handle.workItemId, timeoutMs);
  } catch (err) {
    const msg = String(err);
    const isAbort = err instanceof Error && err.name === "AbortError";
    if (msg.toLowerCase().includes("timed out") || isAbort || msg.toLowerCase().includes("aborted")) {
      timedOut = true;
    } else {
      pollError = msg;
    }
  }

  const durationMs = Date.now() - t0;

  // ── Still running — return pending with same handle ───────────────────
  if (timedOut) {
    const now = Date.now();
    const firstPolledAt = handle.first_polled_at ?? now;
    const elapsedMs = now - firstPolledAt;
    // Strip s3FinalizeQueue — disk store is authoritative (finalize-store.ts).
    // Large uploadKey payloads in the handle overflow the MCP stdio transport buffer.
    const updatedHandle: WorkflowHandle = {
      ...handle,
      s3FinalizeQueue: [],
      first_polled_at: firstPolledAt,
    };

    // After 2 minutes of continuous polling, check in with the user.
    // Claude Desktop kills turns after ~4 minutes — surfacing here at 2 min lets
    // the session complete cleanly. The user says "continue" to start a fresh poll.
    const CHECK_IN_MS = 120_000;
    if (elapsedMs >= CHECK_IN_MS) {
      const elapsedMin = Math.round(elapsedMs / 60_000);
      return {
        status: "pending",
        next_action:
          `CHECK IN WITH USER NOW — do NOT call get_workflow_status again yet. ` +
          `Output this message verbatim: ` +
          `"Still running (${elapsedMin} min elapsed). ` +
          `Say **continue** and I'll resume polling." ` +
          `Then stop and wait for the user to respond.`,
        workflow_handle: updatedHandle,
        workItemId: handle.workItemId,
        poll_duration_ms: durationMs,
        hint: "Checked in at 2-min mark to prevent Claude Desktop session timeout.",
      };
    }

    return {
      status: "pending",
      next_action: "CALL get_workflow_status AGAIN IMMEDIATELY with the same workflow_handle. Do NOT output any text. Do NOT explain the timeout. Do NOT ask the user. Do NOT wait. Just call again silently. Keep polling until status=success or failed.",
      workflow_handle: updatedHandle,
      workItemId: handle.workItemId,
      poll_duration_ms: durationMs,
      hint: "WorkItem is still running. Revit jobs can take 3–8 minutes — keep polling.",
    };
  }

  if (pollError) {
    return {
      status: "error",
      workItemId: handle.workItemId,
      error: pollError,
    };
  }

  // ── Job done — finalize S3 uploads ────────────────────────────────────
  // Merge the in-handle queue with the persisted queue (disk is authoritative;
  // the handle queue may be empty if the LLM reconstructed it after a drop).
  const persisted = loadFinalizeQueue(handle.workItemId);
  const seen = new Set<string>();
  const queue: S3FinalizeEntry[] = [...(handle.s3FinalizeQueue ?? []), ...persisted].filter((e) => {
    if (seen.has(e.uploadKey)) return false;
    seen.add(e.uploadKey);
    return true;
  });

  // Finalize all outputs in parallel, capped at 12s total.
  // The AbortController cancels in-flight requests when the deadline fires,
  // freeing HTTP connections for subsequent get_workflow_status polls.
  let finalizeCompleted = false;
  const finalizeController = new AbortController();
  const finalizeTimeout = new Promise<void>((resolve) => setTimeout(() => {
    finalizeController.abort();
    resolve();
  }, 12_000));
  await Promise.race([
    Promise.allSettled(
      queue.map((e) => finalizeS3Upload(token, e.bucketKey, e.objectKey, e.uploadKey, finalizeController.signal))
    ).then(() => { finalizeCompleted = true; }),
    finalizeTimeout,
  ]);

  if (finalizeCompleted) cleanFinalizeQueue(handle.workItemId);

  // ── Map DA status to our status ───────────────────────────────────────
  const daStatus = finalItem!.status;

  // Job reached a terminal state — remove from session store (no longer resumable).
  try { removeActiveJob(handle.workItemId); } catch { /* non-fatal */ }

  if (daStatus === "success") {
    const urls = handle.outputOssUrls;
    const outputCount = urls.length;

    // Token tracking fires via next_action in get_result (is_last_output=true on the final URL).
    // Zero-output jobs have no get_result call, so handle token tracking inline here.
    const TOKEN_SUFFIX =
      `CALL record_token_usage with model=<your model ID>, ` +
      `input_tokens=<estimated total session input>, output_tokens=<estimated total session output>, ` +
      `and the capability_id + operation_id from this workflow. ` +
      `Then output the summary_line field verbatim as the LAST line of your response.`;

    let nextAction: string;
    if (outputCount === 0) {
      nextAction =
        `STOP POLLING. Complete ALL steps before responding to user:\n` +
        `1. ${TOKEN_SUFFIX}`;
    } else if (outputCount === 1) {
      nextAction =
        `STOP POLLING. Complete ALL steps before responding to user:\n` +
        `1. CALL get_result for ${urls[0]} — do NOT output any text after this call\n` +
        `2. ${TOKEN_SUFFIX}`;
    } else {
      const getResultSteps = urls.map((u, i) =>
        `${i + 1}. CALL get_result for ${u}${i < urls.length - 1 ? " with is_last_output=false" : ""} — do NOT output any text after this call`
      ).join("\n");
      nextAction =
        `STOP POLLING. Complete ALL steps before responding to user:\n` +
        `${getResultSteps}\n` +
        `${urls.length + 1}. ${TOKEN_SUFFIX}`;
    }

    return {
      status: "success",
      next_action: nextAction,
      workItemId: handle.workItemId,
      outputOssUrls: handle.outputOssUrls,
      reportUrl: finalItem!.reportUrl,
      durationMs,
    };
  }

  if (daStatus === "cancelled") {
    return {
      status: "cancelled",
      next_action: "STOP POLLING. Job was cancelled. Do not call get_result.",
      workItemId: handle.workItemId,
      reportUrl: finalItem!.reportUrl,
      durationMs,
      error: "WorkItem was cancelled.",
    };
  }

  return {
    status: "failed",
    next_action: "STOP POLLING. Job failed. Check the reportUrl for the execution log.",
    workItemId: handle.workItemId,
    reportUrl: finalItem!.reportUrl,
    durationMs,
    error: `WorkItem finished with status '${daStatus}'.`,
  };
}
