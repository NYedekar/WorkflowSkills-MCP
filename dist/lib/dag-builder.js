import { v4 as uuidv4 } from "uuid";
import { InvalidEdgeError, InvalidLoopError, PlannerInvariantError, } from "../errors.js";
// ─── Builders ─────────────────────────────────────────────────────────────
function buildNodes(intents) {
    return intents.map((intent) => ({
        id: `node_${intent.id}`,
        intentId: intent.id,
        label: intent.label,
        type: intent.type,
        description: intent.description,
        action: intent.action,
        entities: intent.entities,
        parameters: intent.parameters,
        dependencies: [],
    }));
}
function buildEdges(relationships) {
    return relationships.map((rel) => ({
        id: `${rel.from}_${rel.to}`,
        from: `node_${rel.from}`,
        to: `node_${rel.to}`,
        type: rel.type,
        condition: rel.condition,
        confidence: rel.confidence ?? 1.0,
    }));
}
// ─── Loop-completion semantics (RFC v4) ───────────────────────────────────
function autoPromoteAfterLoopEdges(nodes, edges) {
    const warnings = [];
    const loopNodeIds = new Set(nodes.filter((n) => n.type === "loop").map((n) => n.id));
    const promoted = edges.map((e) => {
        if (loopNodeIds.has(e.from) && e.type === "sequential") {
            const hasExplicit = edges.some((x) => x.from === e.from && x.type === "after_loop");
            if (!hasExplicit) {
                warnings.push(`[deprecation] Edge ${e.id} auto-promoted: 'sequential' → 'after_loop'. ` +
                    `Please specify type: "after_loop" explicitly on edges from loop nodes.`);
                return { ...e, type: "after_loop" };
            }
        }
        return e;
    });
    return { edges: promoted, warnings };
}
function validateLoopEdges(nodes, edges) {
    const loopNodeIds = new Set(nodes.filter((n) => n.type === "loop").map((n) => n.id));
    const FORBIDDEN_FROM_LOOP = [
        "parallel",
        "conditional",
        "trigger",
    ];
    for (const e of edges) {
        // Self-loop rejection on loop-node edges.
        if (loopNodeIds.has(e.from) && e.from === e.to) {
            throw new InvalidLoopError(`loop node has a self-referential edge — a loop whose body is itself has no terminating semantics`, e.from);
        }
        if (loopNodeIds.has(e.from) && FORBIDDEN_FROM_LOOP.includes(e.type)) {
            throw new InvalidEdgeError(`edge type '${e.type}' not supported from a loop node — use 'loop' or 'after_loop'`, e.id);
        }
        if (e.type === "after_loop" && !loopNodeIds.has(e.from)) {
            throw new InvalidEdgeError(`after_loop edge from non-loop node`, e.id);
        }
        // After auto-promotion, the only `sequential` edges left from loop nodes
        // are the ambiguous-with-explicit-after_loop case.
        if (loopNodeIds.has(e.from) && e.type === "sequential") {
            throw new InvalidEdgeError(`sequential edge from loop node is ambiguous when explicit after_loop edges are present — use 'loop' or 'after_loop'`, e.id);
        }
    }
    for (const loopId of loopNodeIds) {
        const hasBody = edges.some((e) => e.from === loopId && e.type === "loop");
        if (!hasBody) {
            throw new InvalidLoopError(`loop node has no body`, loopId);
        }
    }
}
function computeBodyClosure(loopNodeId, edges) {
    const closure = new Set();
    const seeds = edges
        .filter((e) => e.from === loopNodeId && e.type === "loop")
        .map((e) => e.to);
    const stack = [...seeds];
    while (stack.length > 0) {
        const n = stack.pop();
        if (closure.has(n))
            continue;
        closure.add(n);
        for (const e of edges.filter((e) => e.from === n)) {
            stack.push(e.to);
        }
    }
    return closure;
}
function validateAfterLoopExclusivity(nodes, edges) {
    const loopNodes = nodes.filter((n) => n.type === "loop");
    for (const L of loopNodes) {
        const bc = computeBodyClosure(L.id, edges);
        const afterTargets = edges
            .filter((e) => e.from === L.id && e.type === "after_loop")
            .map((e) => e.to);
        for (const A of afterTargets) {
            if (bc.has(A)) {
                throw new InvalidLoopError(`after-loop target '${A}' is also reachable from the body of loop '${L.id}' via non-after_loop edges. ` +
                    `This violates the body/after-loop exclusivity convention — remove either the after_loop edge or the body-chain path.`, L.id);
            }
        }
    }
}
function isReachable(from, to, edges) {
    if (from === to)
        return true;
    const adj = new Map();
    for (const e of edges) {
        if (!adj.has(e.from))
            adj.set(e.from, []);
        adj.get(e.from).push(e.to);
    }
    const visited = new Set();
    const stack = [from];
    while (stack.length > 0) {
        const n = stack.pop();
        if (visited.has(n))
            continue;
        visited.add(n);
        for (const next of adj.get(n) ?? []) {
            if (next === to)
                return true;
            stack.push(next);
        }
    }
    return false;
}
function injectLoopCompletionDeps(nodes, edges) {
    const loopNodes = nodes.filter((n) => n.type === "loop");
    const synthetic = [];
    for (const L of loopNodes) {
        const bodyClosure = computeBodyClosure(L.id, edges);
        const afterNodes = edges
            .filter((e) => e.from === L.id && e.type === "after_loop")
            .map((e) => e.to);
        for (const A of afterNodes) {
            for (const B of bodyClosure) {
                if (isReachable(B, A, edges))
                    continue;
                synthetic.push({
                    id: `__synth_${B}_${A}`,
                    from: B,
                    to: A,
                    type: "sequential",
                    confidence: 1.0,
                    isSynthetic: true,
                });
            }
        }
    }
    return synthetic;
}
function validatePostCycleBreak(nodes, edges) {
    const loopNodes = nodes.filter((n) => n.type === "loop");
    for (const L of loopNodes) {
        const hasBody = edges.some((e) => e.from === L.id && e.type === "loop");
        if (!hasBody) {
            throw new InvalidLoopError(`cycle breaking removed the only body edge of loop '${L.id}' — caller must restructure the graph to avoid the conflict`, L.id);
        }
    }
}
function detectSyntheticCycles(nodeIds, edgesWithSynthetic) {
    const { hasCycles, cycleEdgeIds } = detectCycles(nodeIds, edgesWithSynthetic);
    if (hasCycles) {
        throw new InvalidLoopError(`after-loop target has a caller-defined path back to a body node — ` +
            `this violates loop-completion ordering. Cycle involves edges: ${cycleEdgeIds.join(", ")}`);
    }
}
// ─── Cycle detection & breaking (unchanged behavior; see RFC §3.6) ────────
function detectCycles(nodeIds, edges) {
    const adj = new Map();
    for (const id of nodeIds)
        adj.set(id, []);
    for (const e of edges) {
        adj.get(e.from)?.push(e);
    }
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    for (const id of nodeIds)
        color.set(id, WHITE);
    const cycleEdgeIds = [];
    // Iterative DFS — avoids call-stack overflow for large graphs.
    for (const start of nodeIds) {
        if (color.get(start) !== WHITE)
            continue;
        color.set(start, GRAY);
        const stack = [{ node: start, idx: 0 }];
        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            const neighbors = adj.get(frame.node) ?? [];
            if (frame.idx < neighbors.length) {
                const edge = neighbors[frame.idx++];
                const vc = color.get(edge.to) ?? WHITE;
                if (vc === GRAY) {
                    cycleEdgeIds.push(edge.id);
                }
                else if (vc === WHITE) {
                    color.set(edge.to, GRAY);
                    stack.push({ node: edge.to, idx: 0 });
                }
            }
            else {
                color.set(frame.node, BLACK);
                stack.pop();
            }
        }
    }
    return { hasCycles: cycleEdgeIds.length > 0, cycleEdgeIds };
}
function breakCycles(nodeIds, edges) {
    let current = edges;
    // Iteratively remove the lowest-confidence cycle edge until the graph is acyclic.
    for (;;) {
        const { hasCycles, cycleEdgeIds } = detectCycles(nodeIds, current);
        if (!hasCycles)
            return current;
        const minEdge = current
            .filter((e) => cycleEdgeIds.includes(e.id))
            .reduce((a, b) => (a.confidence <= b.confidence ? a : b));
        current = current.filter((e) => e.id !== minEdge.id);
    }
}
function topologicalSort(nodeIds, edges) {
    const inDegree = new Map();
    const adj = new Map();
    for (const id of nodeIds) {
        inDegree.set(id, 0);
        adj.set(id, []);
    }
    for (const edge of edges) {
        adj.get(edge.from)?.push(edge.to);
        inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    }
    const queue = [];
    const levels = new Map();
    for (const [id, deg] of inDegree) {
        if (deg === 0) {
            queue.push(id);
            levels.set(id, 0);
        }
    }
    const order = [];
    while (queue.length > 0) {
        queue.sort();
        const u = queue.shift();
        order.push(u);
        const uLevel = levels.get(u) ?? 0;
        for (const v of adj.get(u) ?? []) {
            const newDeg = (inDegree.get(v) ?? 1) - 1;
            inDegree.set(v, newDeg);
            const currentLevel = levels.get(v) ?? 0;
            levels.set(v, Math.max(currentLevel, uLevel + 1));
            if (newDeg === 0)
                queue.push(v);
        }
    }
    // Tightened safety net (RFC §3.8): throw rather than silently append.
    const unordered = nodeIds.filter((id) => !order.includes(id));
    if (unordered.length > 0) {
        throw new PlannerInvariantError(`topological sort left ${unordered.length} node(s) unordered: ${unordered.join(", ")}. ` +
            `This indicates a bug in cycle detection or synthetic-dep injection.`);
    }
    return { order, levels };
}
// ─── Parallel group detection ────────────────────────────────────────────
function buildParallelGroups(nodeIds, levels, edges) {
    const levelMap = new Map();
    for (const id of nodeIds) {
        const level = levels.get(id) ?? 0;
        if (!levelMap.has(level))
            levelMap.set(level, []);
        levelMap.get(level).push(id);
    }
    const directDeps = new Set(edges.map((e) => `${e.from}|${e.to}`));
    const groups = [];
    for (const [, group] of [...levelMap].sort((a, b) => a[0] - b[0])) {
        if (group.length < 2)
            continue;
        const parallel = group.filter((id) => {
            return group.some((other) => {
                if (other === id)
                    return false;
                return (!directDeps.has(`${id}|${other}`) &&
                    !directDeps.has(`${other}|${id}`));
            });
        });
        if (parallel.length >= 2) {
            groups.push([...new Set(parallel)].sort());
        }
    }
    return groups;
}
// ─── Main export ──────────────────────────────────────────────────────────
export function buildDAG(intents, relationships, name, description) {
    const nodes = buildNodes(intents);
    let edges = buildEdges(relationships);
    const nodeIds = nodes.map((n) => n.id);
    // 1. Auto-promote legacy `sequential` edges from loop nodes.
    const { edges: promotedEdges, warnings } = autoPromoteAfterLoopEdges(nodes, edges);
    edges = promotedEdges;
    // 2. Validate edge types & loop structure.
    validateLoopEdges(nodes, edges);
    // 3. First cycle detection + breaking.
    const { hasCycles } = detectCycles(nodeIds, edges);
    if (hasCycles)
        edges = breakCycles(nodeIds, edges);
    // 4. Post-cycle-break revalidation: ensure cycle removal didn't kill any loop body.
    validatePostCycleBreak(nodes, edges);
    // 5. Enforce after-loop exclusivity convention.
    validateAfterLoopExclusivity(nodes, edges);
    // 6. Inject synthetic loop-completion dependencies (synthetic-only return).
    const syntheticEdges = injectLoopCompletionDeps(nodes, edges);
    const augmentedEdges = [...edges, ...syntheticEdges];
    // 7. Second cycle detection (catches cycles introduced by synthetic injection).
    detectSyntheticCycles(nodeIds, augmentedEdges);
    // 8. Topological sort (uses augmented edges so synthetic gating is visible).
    const { order: execution_order, levels } = topologicalSort(nodeIds, augmentedEdges);
    // 9. Populate node.dependencies from caller edges first, then synthetic.
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    for (const edge of edges) {
        const t = nodeMap.get(edge.to);
        if (t && !t.dependencies.includes(edge.from)) {
            t.dependencies.push(edge.from);
        }
    }
    for (const synth of syntheticEdges) {
        const t = nodeMap.get(synth.to);
        if (t && !t.dependencies.includes(synth.from)) {
            t.dependencies.push(synth.from);
        }
    }
    // 10. Parallel groups (computed against augmented edges so synthetic gating applies).
    const parallel_groups = buildParallelGroups(nodeIds, levels, augmentedEdges);
    return {
        id: uuidv4(),
        name,
        description,
        created_at: new Date().toISOString(),
        nodes,
        edges, // caller-provided only; synthetic excluded
        execution_order,
        metadata: {
            intent_count: intents.length,
            edge_count: edges.length,
            has_cycles: hasCycles,
            parallel_groups,
            warnings,
        },
    };
}
