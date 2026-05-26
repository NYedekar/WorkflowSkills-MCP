import { z } from "zod";
import { searchCapabilities, findCapabilityById, type CapabilityRecord } from "../lib/registry-client.js";

export const getCapabilitySchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "Natural language or keyword search across capability names, descriptions, and operations. " +
        "Examples: 'extract room data', 'export IFC', 'validate model', 'translation job'."
    ),
  capability_id: z
    .string()
    .optional()
    .describe(
      "Exact capability ID or alias. Examples: 'RevitElementDataExtraction', " +
        "'revit:RevitModelHealthCheck', 'aps:dm.oss_objects'."
    ),
  operation_id: z
    .string()
    .optional()
    .describe(
      "Find by operation ID or globalOperationId. Examples: 'extract-room-data', " +
        "'revit.extract-room-data', 'get_signed_s3_upload'."
    ),
  risk: z
    .enum(["SAFE", "REVIEW", "BLOCKED"])
    .optional()
    .describe("Filter by risk level. SAFE = read-only, REVIEW = write/modify, BLOCKED = not callable."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .default(5)
    .describe("Max results to return (default 5, max 20)."),
});

export type GetCapabilityInput = z.infer<typeof getCapabilitySchema>;

export interface GetCapabilityResult {
  count: number;
  capabilities: CapabilitySummary[];
  hint?: string;
}

interface CapabilitySummary {
  id: string;
  alias: string;
  product: string;
  domain: string;
  engine: string;
  risk: string;
  ioShape: string;
  description?: string;
  // Engine-API execution info
  activityConvention?: string;
  // Operations
  operations: OperationSummary[];
  total_operations: number;
}

interface OperationSummary {
  operationId: string;
  displayName: string;
  description: string;
  callable: boolean;
  // REST-specific
  httpMethod?: string;
  endpoint?: string;
  authScopes?: string[];
}

export async function handleGetCapability(
  input: GetCapabilityInput
): Promise<GetCapabilityResult> {
  // If no filters at all, return a helpful message
  if (!input.query && !input.capability_id && !input.operation_id && !input.risk) {
    return {
      count: 0,
      capabilities: [],
      hint: "Provide at least one filter: query, capability_id, operation_id, or risk. Example: get_capability({ query: 'dwg translate' })",
    };
  }

  let caps: CapabilityRecord[];

  // Exact lookup takes priority
  if (input.capability_id && !input.query) {
    const exact = findCapabilityById(input.capability_id);
    caps = exact ? [exact] : [];
  } else {
    caps = searchCapabilities({
      query: input.query,
      capabilityId: input.capability_id,
      operationId: input.operation_id,
      risk: input.risk,
      limit: input.limit,
    });
  }

  const summaries: CapabilitySummary[] = caps.map((c) => {
    // For Engine-API capabilities, surface the DA activity naming convention
    const isEngineApi = c.domain === "Engine-APIs";
    const activityConvention = isEngineApi
      ? `{YOUR_CLIENT_ID}.${c.alias}+prod`
      : undefined;

    // For search results cap ops at 10; for exact ID lookups return all
    const isExact = !!input.capability_id && !input.query;
    const opsToShow = isExact ? c.operations : c.operations.slice(0, 10);

    const opSummaries: OperationSummary[] = opsToShow.map((o) => ({
      operationId: o.operationId,
      displayName: o.displayName,
      description: o.description ? o.description.slice(0, 120) : "",
      callable: o.callable !== false,
      httpMethod: o.httpMethod,
      endpoint: o.endpoint,
      authScopes: o.authScopes,
    }));

    return {
      id: c.id,
      alias: c.alias,
      product: c.product,
      domain: c.domain,
      engine: c.engine,
      risk: c.risk,
      ioShape: c.ioShape,
      description: c.description ? c.description.slice(0, 160) : undefined,
      activityConvention,
      operations: opSummaries,
      total_operations: c.operations.length,
    };
  });

  return { count: summaries.length, capabilities: summaries };
}
