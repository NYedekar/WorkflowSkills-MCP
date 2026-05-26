import { z } from "zod";
import { buildDAG } from "../lib/dag-builder.js";
import { renderDagAscii } from "../lib/render.js";
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
        .describe("How the two intents relate. From a loop node: 'loop' = body (per-iteration), 'after_loop' = continuation (once after loop completes). " +
        "'sequential' from a loop node is auto-promoted to 'after_loop' for backwards compat (deprecation warning emitted)."),
    condition: z.string().optional().describe("Condition expression for conditional edges"),
    confidence: z.number().min(0).max(1).optional().describe("Confidence score 0-1 (defaults to 1.0)"),
});
export const createWorkflowSchema = z.object({
    intents: z
        .array(intentSchema)
        .min(1)
        .describe("Ordered list of intents extracted from the user request"),
    relationships: z
        .array(relationshipSchema)
        .optional()
        .default([])
        .describe("Relationships between intents. If omitted, the DAG will have no edges."),
    name: z.string().optional().describe("Human-readable workflow name"),
    description: z.string().optional().describe("What this workflow accomplishes"),
});
export async function handleCreateWorkflow(input) {
    const name = input.name ??
        `Workflow_${new Date().toISOString().slice(0, 10)}_${Math.random().toString(36).slice(2, 7)}`;
    const description = input.description ?? "";
    const dag = buildDAG(input.intents, input.relationships, name, description);
    const rendered = renderDagAscii(dag);
    return { rendered, dag };
}
