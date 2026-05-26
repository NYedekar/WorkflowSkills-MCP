import { z } from "zod";
import { buildDAG } from "../lib/dag-builder.js";
import { renderDagAscii } from "../lib/render.js";
import { handleUploadFile } from "./upload-file.js";
import type { WorkflowDAG } from "../types.js";

const intentSchema = z.object({
  id: z.string().describe("Unique identifier for this intent"),
  label: z.string().describe("Short human-readable name"),
  type: z
    .enum(["fetch", "transform", "send", "store", "condition", "loop", "trigger", "custom"])
    .describe("Intent category"),
  description: z.string().describe("What this intent does"),
  action: z.string().describe("Verb phrase describing the action"),
  entities: z.array(z.string()).default([]).describe("Data objects or services involved"),
  parameters: z.record(z.unknown()).default({}).describe("Key-value parameters for this intent"),
  raw: z.string().optional().describe("Original text fragment this intent was derived from"),
});

const relationshipSchema = z.object({
  from: z.string().describe("ID of the source intent"),
  to: z.string().describe("ID of the target intent"),
  type: z
    .enum(["sequential", "parallel", "conditional", "loop", "after_loop", "trigger"])
    .describe(
      "How the two intents relate. From a loop node: 'loop' = body (per-iteration), 'after_loop' = continuation (once after loop completes). " +
      "'sequential' from a loop node is auto-promoted to 'after_loop' for backwards compat (deprecation warning emitted)."
    ),
  condition: z.string().optional().describe("Condition expression for conditional edges"),
  confidence: z.number().min(0).max(1).optional().describe("Confidence score 0-1 (defaults to 1.0)"),
});

export const createWorkflowSchema = z.object({
  intents: z
    .array(intentSchema)
    .min(1)
    .max(200)
    .describe("Ordered list of intents extracted from the user request"),
  relationships: z
    .array(relationshipSchema)
    .optional()
    .default([])
    .describe("Relationships between intents. If omitted, the DAG will have no edges."),
  name: z.string().optional().describe("Human-readable workflow name"),
  description: z.string().optional().describe("What this workflow accomplishes"),
  file_path: z
    .string()
    .optional()
    .describe(
      "Optional local file to upload before planning. " +
      "When provided, the file is uploaded to APS OSS and the oss_url is returned alongside the DAG — " +
      "pass it to each execute_workflow call so all steps share the same uploaded copy. " +
      "Accepts local paths, ~/Downloads/, or OneDrive (e.g. ~/Library/CloudStorage/OneDrive-Autodesk/…). " +
      "Chat attachments (/mnt/user-data/uploads/) cannot be read by the MCP server — " +
      "on bridge_required, show REQUIRED_ACTION to the user and ask for the file's actual Mac path."
    ),
});

export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;

export type CreateWorkflowResult =
  | { status: "success"; rendered: string; dag: WorkflowDAG; oss_url?: string }
  | { status: "bridge_required"; REQUIRED_ACTION: string; mac_path_hint?: string }
  | { status: "error"; error: string; hint?: string };

export async function handleCreateWorkflow(
  input: CreateWorkflowInput
): Promise<CreateWorkflowResult> {
  // ── Step 1: Upload file if provided ───────────────────────────────────────
  let oss_url: string | undefined;

  if (input.file_path) {
    const uploadResult = await handleUploadFile({
      file_path: input.file_path,
      bucket_policy: "transient",
      signed_url_expiry_minutes: 60,
    });

    if (uploadResult.status === "bridge_required") {
      return {
        status: "bridge_required",
        REQUIRED_ACTION: uploadResult.REQUIRED_ACTION!,
        mac_path_hint: uploadResult.mac_path_hint,
      };
    }

    if (uploadResult.status === "error" || !uploadResult.oss_url) {
      return {
        status: "error",
        error: `Upload failed: ${uploadResult.error}`,
        hint: uploadResult.hint,
      };
    }

    oss_url = uploadResult.oss_url;
  }

  // ── Step 2: Build and render the DAG ─────────────────────────────────────
  const name =
    input.name ??
    `Workflow_${new Date().toISOString().slice(0, 10)}_${Math.random().toString(36).slice(2, 7)}`;

  const description = input.description ?? "";

  let dag: WorkflowDAG;
  let rendered: string;
  try {
    dag = buildDAG(input.intents, input.relationships, name, description);
    rendered = renderDagAscii(dag);
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      hint: "Check that loop nodes have at least one 'loop' edge, 'after_loop' edges only come from loop nodes, and there are no cycles.",
    };
  }

  return { status: "success", rendered, dag, oss_url };
}
