import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ── Types ─────────────────────────────────────────────────────────────────

export interface OperationRecord {
  operationId: string;
  globalOperationId?: string;
  displayName: string;
  description: string;
  capabilityId: string;
  product: string;
  engine: string;
  risk: string;
  configSchema: string;
  outputContract: string;
  ioShape: string;
  modifiesFile: boolean;
  readOnly: boolean;
  destructive: boolean;
  callable?: boolean;
  // REST-specific fields (Platform / Product / Data APIs)
  httpMethod?: string;
  endpoint?: string;
  baseUrl?: string;
  authScopes?: string[];
  authFlows?: string[];
  requestSchema?: unknown;
  responseSchema?: unknown;
  asyncJob?: boolean;
  // Registry-driven defaults for REST async-job operations
  defaultBody?: Record<string, unknown>;
  asyncJobPolling?: {
    capability_id: string;
    operation_id: string;
    // Maps each required path param for the polling operation to a dot-path
    // into the async job response (e.g. { "urn": "urn" } reads response.urn).
    path_param_map: Record<string, string>;
  };
  // Custom AppBundle fields — present only on callable=true engine ops
  workItemTemplate?: {
    activityId: string;
    arguments: Record<string, { verb: "get" | "put" }>;
  };
  activityId?: string;
  workItemArguments?: Record<string, { verb: "get" | "put"; localName?: string; optional?: boolean }>;
}

export interface CapabilityRecord {
  id: string;
  alias: string;
  qualifiedName: string;
  version: string;
  product: string;
  domain: string;
  bundleRef?: string;
  activityRef?: string;
  engine: string;
  risk: string;
  ioShape: string;
  description?: string;
  note?: string;
  groupId: string;
  // Engine-API execution templates
  defaultActivityTemplate?: string;
  defaultConfigTemplate?: string;
  defaultWorkItemTemplate?: string;
  // REST-specific
  baseUrl?: string;
  authFlows?: string[];
  contract?: unknown;
  operations: OperationRecord[];
}

// ── Registry loader (singleton) ───────────────────────────────────────────

let _index: CapabilityRecord[] | null = null;

function registryPath(): string {
  if (process.env.APS_REGISTRY_PATH) return process.env.APS_REGISTRY_PATH;
  const __dir = dirname(fileURLToPath(import.meta.url));
  return resolve(__dir, "../../data/capability-registry.json");
}

function buildIndex(): CapabilityRecord[] {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(registryPath(), "utf-8")) as Record<string, unknown>;
  } catch (err) {
    console.error(`[registry-client] Failed to load registry from '${registryPath()}': ${String(err)}`);
    return [];
  }
  const domains = raw.domains as unknown[];
  const records: CapabilityRecord[] = [];

  for (const domain of domains) {
    const d = domain as Record<string, unknown>;
    const domainId = d.id as string;
    const domainDisplay = d.displayName as string;

    // Engine-APIs: domain → engines[] → capabilityGroups[] → capabilities[]
    if (d.engines) {
      for (const engine of d.engines as unknown[]) {
        const eng = engine as Record<string, unknown>;
        for (const cg of (eng.capabilityGroups as unknown[]) ?? []) {
          extractCapabilities(cg, domainDisplay, records);
        }
      }
    }

    // Platform/Product/Data-APIs: domain → apis[] → capabilityGroups[] → capabilities[]
    if (d.apis) {
      for (const api of d.apis as unknown[]) {
        const a = api as Record<string, unknown>;
        for (const cg of (a.capabilityGroups as unknown[]) ?? []) {
          extractCapabilities(cg, domainDisplay, records);
        }
      }
    }
  }

  return records;
}

function extractCapabilities(
  capabilityGroup: unknown,
  domainDisplay: string,
  out: CapabilityRecord[]
): void {
  const cg = capabilityGroup as Record<string, unknown>;
  const caps = (cg.capabilities as unknown[]) ?? [];

  for (const cap of caps) {
    const c = cap as Record<string, unknown>;
    const ops: OperationRecord[] = ((c.operations as unknown[]) ?? []).map((op) => {
      const o = op as Record<string, unknown>;
      return {
        operationId: o.operationId as string,
        globalOperationId: o.globalOperationId as string | undefined,
        displayName: o.displayName as string,
        description: o.description as string ?? "",
        capabilityId: c.id as string,
        product: o.product as string ?? (c.product as string) ?? "",
        engine: o.engine as string ?? (c.engine as string) ?? "",
        risk: o.risk as string ?? (c.risk as string) ?? "SAFE",
        configSchema: o.configSchema as string ?? "",
        outputContract: o.outputContract as string ?? "",
        ioShape: o.ioShape as string ?? (c.ioShape as string) ?? "",
        modifiesFile: (o.modifiesFile as boolean) ?? false,
        readOnly: (o.readOnly as boolean) ?? true,
        destructive: (o.destructive as boolean) ?? false,
        callable: (o.callable as boolean) ?? true,
        httpMethod: o.httpMethod as string | undefined,
        endpoint: o.endpoint as string | undefined,
        baseUrl: (o.baseUrl ?? c.baseUrl) as string | undefined,
        authScopes: o.authScopes as string[] | undefined,
        authFlows: o.authFlows as string[] | undefined,
        requestSchema: o.requestSchema,
        responseSchema: o.responseSchema,
        asyncJob: o.asyncJob as boolean | undefined,
        defaultBody: o.defaultBody as Record<string, unknown> | undefined,
        asyncJobPolling: o.asyncJobPolling as OperationRecord["asyncJobPolling"] | undefined,
        activityId: o.activityId as string | undefined,
        workItemArguments: o.workItemArguments as OperationRecord["workItemArguments"] | undefined,
        workItemTemplate: o.workItemTemplate as OperationRecord["workItemTemplate"] | undefined,
      };
    });

    const rawId = c.id as string ?? "";
    const derivedAlias = (c.alias as string | undefined) ?? rawId.split(/[:.\/]/).pop() ?? rawId;

    out.push({
      id: rawId,
      alias: derivedAlias,
      qualifiedName: (c.qualifiedName as string | undefined) ?? rawId,
      version: (c.version as string) ?? "1.0.0",
      product: c.product as string ?? "",
      domain: domainDisplay,
      engine: c.engine as string ?? "",
      risk: c.risk as string ?? "SAFE",
      ioShape: c.ioShape as string ?? "",
      description: c.description as string | undefined,
      note: c.note as string | undefined,
      groupId: (c.groupId ?? c.apiId ?? cg.id) as string ?? "",
      defaultActivityTemplate: c.defaultActivityTemplate as string | undefined,
      defaultConfigTemplate: c.defaultConfigTemplate as string | undefined,
      defaultWorkItemTemplate: c.defaultWorkItemTemplate as string | undefined,
      baseUrl: c.baseUrl as string | undefined,
      authFlows: c.authFlows as string[] | undefined,
      bundleRef: c.bundleRef as string | undefined,
      activityRef: c.activityRef as string | undefined,
      contract: c.contract,
      operations: ops,
    });
  }
}

export function getCapabilityIndex(): CapabilityRecord[] {
  if (!_index) _index = buildIndex();
  return _index;
}

// ── Search ────────────────────────────────────────────────────────────────

export interface SearchOptions {
  query?: string;
  capabilityId?: string;
  operationId?: string;
  product?: string;
  risk?: string;
  limit?: number;
}

export function searchCapabilities(opts: SearchOptions): CapabilityRecord[] {
  const index = getCapabilityIndex();
  let results = index;

  // Exact capability ID match (short-circuit)
  if (opts.capabilityId) {
    const q = opts.capabilityId.toLowerCase();
    results = results.filter(
      (c) =>
        c.id.toLowerCase() === q ||
        c.alias.toLowerCase() === q ||
        c.qualifiedName.toLowerCase().includes(q)
    );
  }

  // Exact operation ID match
  if (opts.operationId) {
    const q = opts.operationId.toLowerCase();
    results = results.filter((c) =>
      c.operations.some(
        (o) =>
          o.operationId.toLowerCase() === q ||
          (o.globalOperationId ?? "").toLowerCase() === q
      )
    );
  }

  // Product filter
  if (opts.product) {
    const q = opts.product.toLowerCase();
    results = results.filter((c) => c.product.toLowerCase().includes(q));
  }

  // Risk filter
  if (opts.risk) {
    const q = opts.risk.toUpperCase();
    results = results.filter((c) => c.risk === q);
  }

  // Keyword search across multiple fields
  if (opts.query) {
    const terms = opts.query.toLowerCase().split(/\s+/).filter(Boolean);
    results = results
      .map((c) => ({ cap: c, score: scoreCapability(c, terms) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.cap);
  }

  return results.slice(0, opts.limit ?? 5);
}

function scoreCapability(c: CapabilityRecord, terms: string[]): number {
  let score = 0;
  const alias = c.alias ?? "";
  const haystack = [
    c.id,
    alias,
    c.qualifiedName ?? "",
    c.product ?? "",
    c.description ?? "",
    c.note ?? "",
    c.ioShape ?? "",
    ...c.operations.map((o) => `${o.displayName} ${o.description} ${o.operationId}`),
  ]
    .join(" ")
    .toLowerCase();

  for (const term of terms) {
    if (alias.toLowerCase().includes(term)) score += 10;
    else if (c.id.toLowerCase().includes(term)) score += 8;
    else if (haystack.includes(term)) score += 3;
  }

  // Fix C: boost aps:md.jobs when intent is viewer/translate — prevents DWG DA capabilities from outranking MD
  const viewerTerms = ["viewer", "view", "svf2", "translate", "translation", "derivative", "manifest"];
  const isViewerIntent = terms.some((t) => viewerTerms.includes(t));
  const isTranslationCap = c.id.includes("md.jobs") || c.id.includes("translation");
  if (isViewerIntent && isTranslationCap) score += 20;

  return score;
}

export function findCapabilityById(id: string): CapabilityRecord | undefined {
  const q = id.toLowerCase();
  return getCapabilityIndex().find(
    (c) =>
      c.id.toLowerCase() === q ||
      c.alias.toLowerCase() === q ||
      c.qualifiedName.toLowerCase() === q
  );
}

export function findOperationByGlobalId(globalId: string): {
  capability: CapabilityRecord;
  operation: OperationRecord;
} | undefined {
  const q = globalId.toLowerCase();
  for (const cap of getCapabilityIndex()) {
    const op = cap.operations.find(
      (o) =>
        (o.globalOperationId ?? "").toLowerCase() === q ||
        `${cap.id.toLowerCase()}.${o.operationId.toLowerCase()}` === q
    );
    if (op) return { capability: cap, operation: op };
  }
  return undefined;
}
