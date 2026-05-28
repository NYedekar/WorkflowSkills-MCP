import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
// ── Registry loader (singleton) ───────────────────────────────────────────
let _index = null;
function registryPath() {
    if (process.env.APS_REGISTRY_PATH)
        return process.env.APS_REGISTRY_PATH;
    const __dir = dirname(fileURLToPath(import.meta.url));
    return resolve(__dir, "../../data/capability-registry.json");
}
function buildIndex() {
    let raw;
    try {
        raw = JSON.parse(readFileSync(registryPath(), "utf-8"));
    }
    catch (err) {
        console.error(`[registry-client] Failed to load registry from '${registryPath()}': ${String(err)}`);
        return [];
    }
    const domains = raw.domains;
    const records = [];
    for (const domain of domains) {
        const d = domain;
        const domainId = d.id;
        const domainDisplay = d.displayName;
        // Engine-APIs: domain → engines[] → capabilityGroups[] → capabilities[]
        if (d.engines) {
            for (const engine of d.engines) {
                const eng = engine;
                for (const cg of eng.capabilityGroups ?? []) {
                    extractCapabilities(cg, domainDisplay, records);
                }
            }
        }
        // Platform/Product/Data-APIs: domain → apis[] → capabilityGroups[] → capabilities[]
        if (d.apis) {
            for (const api of d.apis) {
                const a = api;
                for (const cg of a.capabilityGroups ?? []) {
                    extractCapabilities(cg, domainDisplay, records);
                }
            }
        }
    }
    return records;
}
function extractCapabilities(capabilityGroup, domainDisplay, out) {
    const cg = capabilityGroup;
    const caps = cg.capabilities ?? [];
    for (const cap of caps) {
        const c = cap;
        const ops = (c.operations ?? []).map((op) => {
            const o = op;
            return {
                operationId: o.operationId,
                globalOperationId: o.globalOperationId,
                displayName: o.displayName,
                description: o.description ?? "",
                capabilityId: c.id,
                product: o.product ?? c.product ?? "",
                engine: o.engine ?? c.engine ?? "",
                risk: o.risk ?? c.risk ?? "SAFE",
                configSchema: o.configSchema ?? "",
                outputContract: o.outputContract ?? "",
                ioShape: o.ioShape ?? c.ioShape ?? "",
                modifiesFile: o.modifiesFile ?? false,
                readOnly: o.readOnly ?? true,
                destructive: o.destructive ?? false,
                callable: o.callable ?? true,
                httpMethod: o.httpMethod,
                endpoint: o.endpoint,
                baseUrl: (o.baseUrl ?? c.baseUrl),
                authScopes: o.authScopes,
                authFlows: o.authFlows,
                authStrategy: o.authStrategy,
                requestSchema: o.requestSchema,
                responseSchema: o.responseSchema,
                asyncJob: o.asyncJob,
                defaultBody: o.defaultBody,
                asyncJobPolling: o.asyncJobPolling,
                activityId: o.activityId,
                workItemArguments: o.workItemArguments,
                workItemTemplate: o.workItemTemplate,
            };
        });
        const rawId = c.id ?? "";
        const derivedAlias = c.alias ?? rawId.split(/[:.\/]/).pop() ?? rawId;
        out.push({
            id: rawId,
            alias: derivedAlias,
            qualifiedName: c.qualifiedName ?? rawId,
            version: c.version ?? "1.0.0",
            product: c.product ?? "",
            domain: domainDisplay,
            engine: c.engine ?? "",
            risk: c.risk ?? "SAFE",
            ioShape: c.ioShape ?? "",
            description: c.description,
            note: c.note,
            groupId: (c.groupId ?? c.apiId ?? cg.id) ?? "",
            defaultActivityTemplate: c.defaultActivityTemplate,
            defaultConfigTemplate: c.defaultConfigTemplate,
            defaultWorkItemTemplate: c.defaultWorkItemTemplate,
            baseUrl: c.baseUrl,
            authFlows: c.authFlows,
            authStrategy: c.authStrategy,
            bundleRef: c.bundleRef,
            activityRef: c.activityRef,
            contract: c.contract,
            operations: ops,
        });
    }
}
export function getCapabilityIndex() {
    if (!_index)
        _index = buildIndex();
    return _index;
}
export function searchCapabilities(opts) {
    const index = getCapabilityIndex();
    let results = index;
    // Exact capability ID match (short-circuit)
    if (opts.capabilityId) {
        const q = opts.capabilityId.toLowerCase();
        results = results.filter((c) => c.id.toLowerCase() === q ||
            c.alias.toLowerCase() === q ||
            c.qualifiedName.toLowerCase().includes(q));
    }
    // Exact operation ID match
    if (opts.operationId) {
        const q = opts.operationId.toLowerCase();
        results = results.filter((c) => c.operations.some((o) => o.operationId.toLowerCase() === q ||
            (o.globalOperationId ?? "").toLowerCase() === q));
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
function scoreCapability(c, terms) {
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
        if (alias.toLowerCase().includes(term))
            score += 10;
        else if (c.id.toLowerCase().includes(term))
            score += 8;
        else if (haystack.includes(term))
            score += 3;
    }
    // Fix C: boost aps:md.jobs when intent is viewer/translate — prevents DWG DA capabilities from outranking MD
    const viewerTerms = ["viewer", "view", "svf2", "translate", "translation", "derivative", "manifest"];
    const isViewerIntent = terms.some((t) => viewerTerms.includes(t));
    const isTranslationCap = c.id.includes("md.jobs") || c.id.includes("translation");
    if (isViewerIntent && isTranslationCap)
        score += 20;
    return score;
}
export function findCapabilityById(id) {
    const q = id.toLowerCase();
    return getCapabilityIndex().find((c) => c.id.toLowerCase() === q ||
        c.alias.toLowerCase() === q ||
        c.qualifiedName.toLowerCase() === q);
}
export function findOperationByGlobalId(globalId) {
    const q = globalId.toLowerCase();
    for (const cap of getCapabilityIndex()) {
        const op = cap.operations.find((o) => (o.globalOperationId ?? "").toLowerCase() === q ||
            `${cap.id.toLowerCase()}.${o.operationId.toLowerCase()}` === q);
        if (op)
            return { capability: cap, operation: op };
    }
    return undefined;
}
