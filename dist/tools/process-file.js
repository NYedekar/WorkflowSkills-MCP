import { z } from "zod";
import { basename, extname } from "path";
import { handleUploadFile } from "./upload-file.js";
import { handleExecuteWorkflow } from "./execute-workflow.js";
import { handleGetResult } from "./get-result.js";
import { searchCapabilities, findCapabilityById } from "../lib/registry-client.js";
// ── Schema ────────────────────────────────────────────────────────────────
export const processFileSchema = z.object({
    file_path: z.string().describe("Full path to the file — local folder, ~/Downloads/, or OneDrive (e.g. ~/Library/CloudStorage/OneDrive-Autodesk/…). " +
        "Chat attachments (/mnt/user-data/uploads/) cannot be read by the MCP server — " +
        "on bridge_required, show REQUIRED_ACTION to the user and ask for the file's actual Mac path."),
    intent: z
        .string()
        .optional()
        .describe("What to do with the file — used to auto-select the best capability. " +
        "E.g. 'extract all parameters', 'translate to SVF2', 'export sheets to PDF'. " +
        "Required unless capability_id + operation_id are both specified."),
    capability_id: z
        .string()
        .optional()
        .describe("Override auto-selection. Pass the id from get_capability."),
    operation_id: z
        .string()
        .optional()
        .describe("Override auto-selection. Pass the operationId from get_capability."),
    max_result_chars: z
        .number()
        .int()
        .min(1_000)
        .max(50_000)
        .optional()
        .default(50_000)
        .describe("Max chars of the first chunk of each output file to return. Default and max: 50 000. " +
        "For large outputs (has_more=true), call get_result directly with offset_chars=next_offset to page through the rest."),
    body: z
        .record(z.unknown())
        .optional()
        .describe("Extra request body fields merged on top of any defaultBody in the capability registry. " +
        "Caller-supplied fields always win. When a capability defines a defaultBody (e.g. SVF2 " +
        "output format for start_translation_job), it is injected automatically — " +
        "pass body here to override or extend it. " +
        "Example: { \"output\": { \"formats\": [{ \"type\": \"svf2\", \"views\": [\"2d\"] }] } }. " +
        "Ignored for Engine-API capabilities."),
});
// ── Handler ───────────────────────────────────────────────────────────────
export async function handleProcessFile(input) {
    // ── Step 1: Upload ────────────────────────────────────────────────────
    const uploadResult = await handleUploadFile({
        file_path: input.file_path,
        bucket_policy: "transient",
        signed_url_expiry_minutes: 60,
    });
    if (uploadResult.status === "bridge_required") {
        return {
            status: "bridge_required",
            REQUIRED_ACTION: uploadResult.REQUIRED_ACTION,
            mac_path_hint: uploadResult.mac_path_hint,
        };
    }
    if (uploadResult.status === "error" || !uploadResult.oss_url) {
        return { status: "error", error: `Upload failed: ${uploadResult.error}`, hint: uploadResult.hint };
    }
    const ossUrl = uploadResult.oss_url;
    // ── Step 2: Resolve capability + operation ────────────────────────────
    let capabilityId = input.capability_id;
    let operationId = input.operation_id;
    if (!capabilityId || !operationId) {
        const filename = basename(input.file_path);
        const ext = extname(filename).toLowerCase().slice(1);
        if (!capabilityId) {
            // Search with progressively broader queries until a callable capability is found.
            // Vague intents (e.g. "convert DWG to PDF") may not match registry terms like "plot".
            const queries = [
                [ext, input.intent].filter(Boolean).join(" "), // "dwg convert to pdf"
                [ext, ...(input.intent ?? "").split(/\s+/).slice(-2)].join(" "), // "dwg to pdf"
                ext, // "dwg" alone
            ].filter((q, i, a) => q && a.indexOf(q) === i); // deduplicate
            let foundCap;
            let usedQuery = queries[0];
            for (const q of queries) {
                const results = searchCapabilities({ query: q, limit: 3 });
                const callable = results.find((c) => c.operations.some((o) => o.callable !== false));
                if (callable) {
                    foundCap = callable;
                    usedQuery = q;
                    break;
                }
            }
            if (!foundCap) {
                return {
                    status: "no_capability_found",
                    gap_note: `⚠️ WorkflowSkills gap — searched: ${queries.map(q => `"${q}"`).join(", ")} | ` +
                        `No capability found for .${ext} files. ` +
                        `Use get_capability with a different query, or specify capability_id + operation_id directly.`,
                };
            }
            capabilityId = foundCap.id;
            if (!operationId) {
                const op = foundCap.operations.find((o) => o.callable !== false);
                if (op)
                    operationId = op.operationId;
            }
            void usedQuery; // used in gap_note only
        }
        else {
            // capability_id supplied but operation_id missing — resolve from that specific capability
            const cap = findCapabilityById(capabilityId);
            if (!cap) {
                return {
                    status: "error",
                    error: `Capability '${capabilityId}' not found in registry. Use get_capability to verify the id.`,
                };
            }
            const op = cap.operations.find((o) => o.callable !== false);
            if (op)
                operationId = op.operationId;
        }
    }
    if (!operationId) {
        return {
            status: "error",
            error: "Could not determine operation_id. Specify it via operation_id param or provide a more specific intent.",
        };
    }
    // ── Step 3: Build effective body ───────────────────────────────────────
    // Read defaultBody from the registry (e.g. SVF2 output format for start_translation_job).
    // Caller-supplied body is deep-merged on top, so it always wins.
    const resolvedOp = findCapabilityById(capabilityId)
        ?.operations.find((o) => o.operationId === operationId);
    let effectiveBody;
    if (resolvedOp?.defaultBody) {
        effectiveBody = input.body ? deepMerge(resolvedOp.defaultBody, input.body) : { ...resolvedOp.defaultBody };
    }
    else if (input.body) {
        effectiveBody = input.body;
    }
    // ── Step 4: Execute ────────────────────────────────────────────────────
    const execResult = await handleExecuteWorkflow({
        capability_id: capabilityId,
        operation_id: operationId,
        input_file_url: ossUrl,
        path_params: {},
        query_params: {},
        body: effectiveBody,
        config: {},
        inline_args: {},
        output_bucket_policy: "transient",
    });
    if (execResult.status === "pending") {
        return {
            status: "pending",
            next_action: "CALL get_workflow_status(workflow_handle) NOW. Do not wait or ask the user. Repeat until next_action says STOP POLLING. " +
                "⚠️ Claude Code CLI / FleetView only: if get_workflow_status schema is not yet loaded (deferred tool), " +
                "first call ToolSearch with query " +
                "'select:mcp__workflow-builder__get_workflow_status,mcp__workflow-builder__get_result,mcp__workflow-builder__get_download_link' " +
                "— then immediately call get_workflow_status. Claude Desktop: skip ToolSearch, call directly.",
            capability_used: capabilityId,
            operation_used: operationId,
            input_oss_url: ossUrl,
            workItemId: execResult.workItemId,
            workflow_handle: execResult.workflow_handle,
        };
    }
    if (execResult.status !== "success") {
        return {
            status: "failed",
            capability_used: capabilityId,
            operation_used: operationId,
            error: execResult.error,
            hint: execResult.hint,
            workItemId: execResult.workItemId,
            reportUrl: execResult.reportUrl,
        };
    }
    // REST async-job: job accepted, work happens server-side.
    // Polling instructions come from execute_workflow via async_job_note (registry-driven).
    if (execResult.async_job) {
        return {
            status: "pending",
            capability_used: capabilityId,
            operation_used: operationId,
            input_oss_url: ossUrl,
            hint: [execResult.hint, execResult.async_job_note].filter(Boolean).join("\n\n"),
        };
    }
    // ── Step 5: Fetch all outputs ──────────────────────────────────────────
    const allOssUrls = execResult.outputOssUrls ??
        (execResult.outputOssUrl ? [execResult.outputOssUrl] : []);
    const outputs = await Promise.all(allOssUrls.map(async (outUrl) => {
        const r = await handleGetResult({ oss_url: outUrl, max_chars: input.max_result_chars, offset_chars: 0, force_text: false });
        // For binary outputs, skip inlining content — return oss_url only so the tool result stays small.
        // The model should call get_download_link or get_result(save_to=...) to retrieve the file.
        if (r.binary) {
            // Propagate get_result's auto-save result — the file may already be in ~/Downloads.
            // Do NOT synthesize a new content string that contradicts what get_result already did.
            return {
                oss_url: outUrl,
                content_type: r.content_type ?? "unknown",
                detected_as: r.detected_as,
                size_bytes: r.size_bytes,
                content: r.content ?? `[Binary output — ${(r.size_bytes ?? 0).toLocaleString()} bytes.]`,
                saved_to: r.saved_to,
                has_more: false,
                truncated: false,
                binary: true,
            };
        }
        return {
            oss_url: outUrl,
            content_type: r.content_type ?? "unknown",
            detected_as: r.detected_as,
            size_bytes: r.size_bytes,
            total_chars: r.total_chars,
            content: r.content ?? (r.status === "error" ? `[fetch failed: ${r.error}]` : ""),
            saved_to: r.saved_to,
            has_more: r.has_more ?? false,
            next_offset: r.next_offset,
            truncated: r.truncated ?? false,
            binary: false,
        };
    }));
    return {
        status: "success",
        capability_used: capabilityId,
        operation_used: operationId,
        input_oss_url: ossUrl,
        outputs,
        workItemId: execResult.workItemId,
        reportUrl: execResult.reportUrl,
        durationMs: execResult.durationMs,
    };
}
// ── Helpers ───────────────────────────────────────────────────────────────
function deepMerge(base, override) {
    const result = { ...base };
    for (const [k, v] of Object.entries(override)) {
        if (v !== null && typeof v === "object" && !Array.isArray(v) &&
            typeof result[k] === "object" && result[k] !== null && !Array.isArray(result[k])) {
            result[k] = deepMerge(result[k], v);
        }
        else {
            result[k] = v;
        }
    }
    return result;
}
