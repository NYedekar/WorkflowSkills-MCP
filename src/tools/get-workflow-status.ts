import { z } from "zod";
import { resolveCredential } from "../auth/credential-resolver.js";
import { pollWorkItem, finalizeS3Upload } from "../lib/da-client.js";
import type { WorkflowHandle, S3FinalizeEntry } from "./execute-workflow.js";
import { loadFinalizeQueue, cleanFinalizeQueue } from "../lib/finalize-store.js";
import { removeActiveJob } from "../lib/session-store.js";

// ── Schemas ───────────────────────────────────────────────────────────────

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

// Batch handle — created server-side when an array of single handles is passed.
// The LLM passes it back unchanged on every subsequent poll until all jobs complete.
const batchHandleSchema = z.object({
  type: z.literal("da_workitem_batch"),
  pending_handles: z.array(workflowHandleSchema),
  completed_oss_urls: z.array(z.string()).default([]),
  first_polled_at: z.number().int().optional(),
});

type BatchHandle = z.infer<typeof batchHandleSchema>;

export const getWorkflowStatusSchema = z.object({
  workflow_handle: z
    .union([
      workflowHandleSchema,
      batchHandleSchema,
      z.array(workflowHandleSchema),
    ])
    .describe(
      "The workflow_handle returned by execute_workflow or a previous get_workflow_status call. " +
        "Pass a single handle OR an array of handles to poll multiple DA jobs simultaneously in one call — " +
        "all jobs are polled in parallel (wall time = slowest job, not sum of all). " +
        "Pass it back exactly as received — do not modify it."
    ),
});

export type GetWorkflowStatusInput = z.infer<typeof getWorkflowStatusSchema>;

// Fixed — never expose to the LLM. 25s deadline saves ~39% round-trips vs 15s on 7-min Revit jobs.
// Worst-case: ~36s (poll) + 12s (finalize) = ~48s — within MCP 60s transport limit.
const POLL_TIMEOUT_MS = 25_000;

export interface JobResult {
  workItemId: string;
  status: "pending" | "success" | "failed" | "cancelled" | "error";
  outputOssUrls?: string[];
  reportUrl?: string;
  durationMs?: number;
  error?: string;
}

export interface GetWorkflowStatusOutput {
  // Multi-handle fields
  overall_status?: "pending" | "success" | "failed" | "mixed" | "error";
  jobs?: JobResult[];         // one entry per handle — present for multi-handle calls

  // Legacy single-handle fields (always populated for backward compat)
  status: "pending" | "running" | "success" | "failed" | "cancelled" | "error";
  next_action?: string;
  workflow_handle?: WorkflowHandle | BatchHandle; // present ONLY when status === "pending"
  workItemId?: string;
  outputOssUrls?: string[];
  reportUrl?: string;
  poll_duration_ms?: number;
  durationMs?: number;
  error?: string;
  hint?: string;
}

// ── Auth scopes ───────────────────────────────────────────────────────────

const DA_SCOPES = [
  "code:all",
  "data:read",
  "data:write",
  "data:create",
  "bucket:create",
  "bucket:read",
  "bucket:update",
];

// ── Shared next_action builders ───────────────────────────────────────────

const TOKEN_SUFFIX =
  `CALL record_token_usage with model=<your model ID>, ` +
  `input_tokens=<estimated total session input>, output_tokens=<estimated total session output>. ` +
  `Then output the summary_line field verbatim as the LAST line of your response.`;

function buildLastGetResult(url: string): string {
  return (
    `CALL get_result with oss_url="${url}". ` +
    `If other DA jobs in this session are still pending or their outputs not yet retrieved: ` +
    `pass is_last_output=false (even if this is the last file for THIS job). ` +
    `If this is truly the last get_result across ALL jobs in the session: pass ` +
    `model="<your model ID>", estimated_input_tokens=<total session input estimate>, ` +
    `estimated_output_tokens=<total session output estimate> — get_result will auto-record. ` +
    `In multi-job sessions always call record_token_usage explicitly after the final output. ` +
    `Output summary_line verbatim as the LAST line of your response.`
  );
}

function buildGetResultChain(urls: string[]): string {
  if (urls.length === 0) return `STOP POLLING. Job completed with no output files. ${TOKEN_SUFFIX}`;
  if (urls.length === 1) return `STOP POLLING. ${buildLastGetResult(urls[0])}`;
  const intermediate = urls
    .slice(0, -1)
    .map((u) => `CALL get_result for ${u} with is_last_output=false`)
    .join(". Then ");
  return `STOP POLLING. ${intermediate}. Then ${buildLastGetResult(urls[urls.length - 1])}`;
}

// ── Main handler ──────────────────────────────────────────────────────────

export async function handleGetWorkflowStatus(
  input: GetWorkflowStatusInput
): Promise<GetWorkflowStatusOutput> {
  const t0 = Date.now();
  const handle = input.workflow_handle;

  let token: string;
  try {
    const cred = await resolveCredential(DA_SCOPES);
    token = cred.access_token;
  } catch (err) {
    return {
      status: "error",
      overall_status: "error",
      error: `APS auth failed: ${String(err)}`,
      hint: "Run authenticate_aps first.",
    };
  }

  // ── Route by handle type ─────────────────────────────────────────────────
  if (Array.isArray(handle)) {
    // First multi-handle call — convert to batch handle
    return pollBatchHandles(
      token,
      {
        type: "da_workitem_batch",
        pending_handles: handle,
        completed_oss_urls: [],
        first_polled_at: t0,
      },
      POLL_TIMEOUT_MS,
      t0
    );
  }

  if (handle.type === "da_workitem") {
    return pollSingleHandle(token, handle, POLL_TIMEOUT_MS, t0);
  }

  if (handle.type === "da_workitem_batch") {
    return pollBatchHandles(token, handle, POLL_TIMEOUT_MS, t0);
  }

  return {
    status: "error",
    overall_status: "error",
    error: `Unknown workflow_handle type. Only 'da_workitem' and 'da_workitem_batch' are supported.`,
  };
}

// ── Single-handle poller (unchanged behaviour from Sprint 3) ──────────────

async function pollSingleHandle(
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

  if (timedOut) {
    const now = Date.now();
    const firstPolledAt = handle.first_polled_at ?? now;
    const elapsedMs = now - firstPolledAt;
    const updatedHandle: WorkflowHandle = {
      ...handle,
      s3FinalizeQueue: [],
      first_polled_at: firstPolledAt,
    };

    const CHECK_IN_MS = 120_000;
    if (elapsedMs >= CHECK_IN_MS) {
      const elapsedMin = Math.round(elapsedMs / 60_000);
      return {
        status: "pending",
        overall_status: "pending",
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
      overall_status: "pending",
      next_action:
        "IMMEDIATELY call get_workflow_status(workflow_handle). No text output. No user prompt. Keep polling until success or failed.",
      workflow_handle: updatedHandle,
      workItemId: handle.workItemId,
      poll_duration_ms: durationMs,
      hint: "WorkItem is still running. Revit jobs can take 3–8 minutes — keep polling.",
    };
  }

  if (pollError) {
    return { status: "error", overall_status: "error", workItemId: handle.workItemId, error: pollError };
  }

  // ── Finalize S3 uploads ─────────────────────────────────────────────────
  await finalizeJobOutputs(token, handle);

  const daStatus = finalItem!.status;
  try { removeActiveJob(handle.workItemId); } catch { /* non-fatal */ }

  if (daStatus === "success") {
    const urls = handle.outputOssUrls;
    return {
      status: "success",
      overall_status: "success",
      next_action: buildGetResultChain(urls),
      workItemId: handle.workItemId,
      outputOssUrls: urls,
      reportUrl: finalItem!.reportUrl,
      durationMs,
    };
  }

  if (daStatus === "cancelled") {
    return {
      status: "cancelled",
      overall_status: "error",
      next_action: "STOP POLLING. Job was cancelled. Do not call get_result.",
      workItemId: handle.workItemId,
      reportUrl: finalItem!.reportUrl,
      durationMs,
      error: "WorkItem was cancelled.",
    };
  }

  return {
    status: "failed",
    overall_status: "failed",
    next_action: "STOP POLLING. Job failed. Check the reportUrl for the execution log.",
    workItemId: handle.workItemId,
    reportUrl: finalItem!.reportUrl,
    durationMs,
    error: `WorkItem finished with status '${daStatus}'.`,
  };
}

// ── Batch poller: fan-out across N handles via Promise.allSettled ─────────
// Wall time = slowest individual job, not the sum of all jobs.
// Mixed state (some done, some pending): wait for all, then get_result in one round.
// Completed output URLs are accumulated in the batch handle across polling rounds.

async function pollBatchHandles(
  token: string,
  batch: BatchHandle,
  timeoutMs: number,
  t0: number
): Promise<GetWorkflowStatusOutput> {
  const firstPolledAt = batch.first_polled_at ?? t0;
  const elapsedMs = Date.now() - firstPolledAt;
  const { pending_handles, completed_oss_urls } = batch;

  // Fan out: poll all pending handles simultaneously
  const results = await Promise.allSettled(
    pending_handles.map((h) => pollSingleHandle(token, h, timeoutMs, t0))
  );

  // Partition results
  const newPendingHandles: WorkflowHandle[] = [];
  const newCompletedUrls: string[] = [...completed_oss_urls];
  const jobs: JobResult[] = [];
  const failedCount = { value: 0 };

  for (let i = 0; i < results.length; i++) {
    const originalHandle = pending_handles[i];
    const result = results[i];

    if (result.status === "rejected") {
      // Network-level error — treat as still pending with original handle
      newPendingHandles.push(originalHandle);
      jobs.push({ workItemId: originalHandle.workItemId, status: "pending" });
    } else {
      const out = result.value;
      if (out.status === "pending") {
        // Extract updated handle from single-handle pending response
        const updatedHandle = (out.workflow_handle as WorkflowHandle) ?? originalHandle;
        newPendingHandles.push(updatedHandle);
        jobs.push({ workItemId: originalHandle.workItemId, status: "pending" });
      } else if (out.status === "success") {
        const urls = out.outputOssUrls ?? [];
        newCompletedUrls.push(...urls);
        jobs.push({ workItemId: originalHandle.workItemId, status: "success", outputOssUrls: urls, durationMs: out.durationMs });
      } else {
        // failed / cancelled / error
        failedCount.value++;
        jobs.push({
          workItemId: originalHandle.workItemId,
          status: out.status === "cancelled" ? "failed" : out.status as "failed" | "error",
          error: out.error,
          reportUrl: out.reportUrl,
          durationMs: out.durationMs,
        });
      }
    }
  }

  // ── 2-min check-in (use earliest first_polled_at across all handles) ─────
  const CHECK_IN_MS = 120_000;
  if (elapsedMs >= CHECK_IN_MS && newPendingHandles.length > 0) {
    const elapsedMin = Math.round(elapsedMs / 60_000);
    const doneCount = pending_handles.length - newPendingHandles.length;
    const updatedBatch: BatchHandle = {
      type: "da_workitem_batch",
      pending_handles: newPendingHandles,
      completed_oss_urls: newCompletedUrls,
      first_polled_at: firstPolledAt,
    };
    return {
      status: "pending",
      overall_status: "pending",
      workflow_handle: updatedBatch as unknown as WorkflowHandle,
      jobs,
      next_action:
        `CHECK IN WITH USER NOW — do NOT call get_workflow_status again yet. ` +
        `Output this message verbatim: "Still running (${elapsedMin} min, ` +
        `${doneCount}/${pending_handles.length} jobs done). ` +
        `Say **continue** and I'll resume polling." Then stop and wait.`,
      hint: "Checked in at 2-min mark to prevent session timeout.",
    };
  }

  // ── Still pending — return batch handle for next poll ────────────────────
  if (newPendingHandles.length > 0) {
    const doneCount = pending_handles.length - newPendingHandles.length;
    const updatedBatch: BatchHandle = {
      type: "da_workitem_batch",
      pending_handles: newPendingHandles,
      completed_oss_urls: newCompletedUrls,
      first_polled_at: firstPolledAt,
    };
    return {
      status: "pending",
      overall_status: "pending",
      workflow_handle: updatedBatch as unknown as WorkflowHandle,
      jobs,
      next_action:
        `IMMEDIATELY call get_workflow_status(workflow_handle). No text output. No user prompt. ` +
        `Keep polling until all jobs complete. (${doneCount}/${pending_handles.length} done so far.)`,
      hint: `${newPendingHandles.length} job(s) still running. Completed URLs accumulated in batch handle.`,
    };
  }

  // ── All done — build unified get_result chain across all completed URLs ───
  const overallStatus = failedCount.value === 0
    ? "success"
    : newCompletedUrls.length > 0
      ? "mixed"
      : "failed";

  const failedNote = failedCount.value > 0
    ? ` (${failedCount.value} job(s) failed — check reportUrl in jobs array)`
    : "";

  const nextAction = buildGetResultChain(newCompletedUrls) + failedNote;

  return {
    status: overallStatus === "failed" ? "failed" : "success",
    overall_status: overallStatus,
    next_action: nextAction,
    outputOssUrls: newCompletedUrls,
    jobs,
    durationMs: Date.now() - t0,
  };
}

// ── S3 finalize helper ────────────────────────────────────────────────────

async function finalizeJobOutputs(token: string, handle: WorkflowHandle): Promise<void> {
  const persisted = loadFinalizeQueue(handle.workItemId);
  const seen = new Set<string>();
  const queue: S3FinalizeEntry[] = [...(handle.s3FinalizeQueue ?? []), ...persisted].filter((e) => {
    if (seen.has(e.uploadKey)) return false;
    seen.add(e.uploadKey);
    return true;
  });

  let finalizeCompleted = false;
  const finalizeController = new AbortController();
  const finalizeTimeout = new Promise<void>((resolve) =>
    setTimeout(() => {
      finalizeController.abort();
      resolve();
    }, 12_000)
  );

  await Promise.race([
    Promise.allSettled(
      queue.map((e) =>
        finalizeS3Upload(token, e.bucketKey, e.objectKey, e.uploadKey, finalizeController.signal)
      )
    ).then(() => {
      finalizeCompleted = true;
    }),
    finalizeTimeout,
  ]);

  if (finalizeCompleted) cleanFinalizeQueue(handle.workItemId);
}
