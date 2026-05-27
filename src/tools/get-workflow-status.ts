import { z } from "zod";
import { resolveCredential } from "../auth/credential-resolver.js";
import { pollWorkItem, finalizeS3Upload } from "../lib/da-client.js";
import type { WorkflowHandle, S3FinalizeEntry } from "./execute-workflow.js";

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
});

export const getWorkflowStatusSchema = z.object({
  workflow_handle: workflowHandleSchema.describe(
    "The workflow_handle object returned by execute_workflow or a previous get_workflow_status call " +
      "when status was 'pending'. Pass it back exactly as received — do not modify it."
  ),
  timeout_ms: z
    .number()
    .int()
    .min(5_000)
    .max(55_000)
    .optional()
    .default(15_000)
    .describe(
      "Max ms to poll in this call. Default 15 000 (keeps each call well under MCP transport timeout). " +
        "If the job is still running at timeout, status='pending' is returned — call again with the same workflow_handle."
    ),
});

export type GetWorkflowStatusInput = z.infer<typeof getWorkflowStatusSchema>;

export interface GetWorkflowStatusOutput {
  status: "pending" | "running" | "success" | "failed" | "cancelled" | "error";
  next_action?: string; // explicit instruction for what to call next
  workflow_handle?: WorkflowHandle; // present ONLY when status === "pending" — absence means job is done
  workItemId?: string;
  outputOssUrls?: string[];
  reportUrl?: string;
  durationMs?: number;
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
    return pollDaWorkItem(token, handle, input.timeout_ms, t0);
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
    if (msg.toLowerCase().includes("timed out")) {
      timedOut = true;
    } else {
      pollError = msg;
    }
  }

  const durationMs = Date.now() - t0;

  // ── Still running — return pending with same handle ───────────────────
  if (timedOut) {
    return {
      status: "pending",
      next_action: "CALL get_workflow_status AGAIN with the same workflow_handle. Do NOT call get_result yet.",
      workflow_handle: handle,
      workItemId: handle.workItemId,
      durationMs,
      hint: "WorkItem is still running.",
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
  const queue: S3FinalizeEntry[] = handle.s3FinalizeQueue ?? [];
  for (const entry of queue) {
    try {
      await finalizeS3Upload(token, entry.bucketKey, entry.objectKey, entry.uploadKey);
    } catch {
      // Non-fatal: already finalized or object missing
    }
  }

  // ── Map DA status to our status ───────────────────────────────────────
  const daStatus = finalItem!.status;

  if (daStatus === "success") {
    const outputCount = handle.outputOssUrls.length;
    return {
      status: "success",
      next_action: outputCount > 0
        ? `STOP POLLING. CALL get_result NOW on each of the ${outputCount} outputOssUrls. Do not wait or ask the user. Call get_result for each oss:// URL in outputOssUrls.`
        : "STOP POLLING. Job completed with no output files.",
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
