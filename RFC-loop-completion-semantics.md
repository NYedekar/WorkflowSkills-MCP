# RFC: Loop Completion Semantics

**Status:** Draft v4 (post-redteam polish)
**Author:** Neeraj Yedekar (via Claude research session)
**Date:** 2026-05-22
**Target component:** `mcp-workflow-builder`
**Files affected:** `src/types.ts`, `src/lib/dag-builder.ts`, `src/tools/create-workflow.ts`, `test/mcp-client.test.mjs`, new `src/errors.ts`, new `test/fixtures/regression-loop-completion.json`
**Revision history:**
- v1 → v2: addressed 3 High / 6 Medium / 3 Low findings from v1 redteam.
- v2 → v3: addressed 1 High / 3 Medium / 4 Low findings from v2 redteam — V18 test correction, after-loop exclusivity enforcement, `isSynthetic` edge field, error-class definitions, topo-sort safety-net tightening, post-cycle-break revalidation, unsubstantiated-claim softening.
- v3 → v4: addressed 2 Medium / 3 Low findings from v3 redteam — removed dead-code "loop-aware sort" from `breakCycles` (relying on `validatePostCycleBreak` alone), removed unimplementable warning-first fallback from §4, corrected V11/V21/V22 row descriptions.

---

## 1. Problem (verified against source)

When a `type: "loop"` node has more than one outgoing edge, the validator places loop-body successors and after-loop successors in the same `parallel_groups` entry, because `buildParallelGroups()` only considers topological level + direct-edge adjacency. It has no concept of "loop body must complete before continuation."

### 1.1 Reproduction

Test invocation: workflow titled *"Forma Files → Clash Detection → Deliverables Export"*. The literal payload (intents + relationships) is preserved as a fixture — see `test/fixtures/regression-loop-completion.json` in §5.1. The MCP-assigned `id` (a `uuidv4()`) is non-stable; the fixture is keyed by payload, not by id.

DAG shape submitted:

```
fetch_file_list
   └── (sequential) ──> iterate_files (loop)
                            ├── (loop)       ──> load_file
                            └── (sequential) ──> run_clash_detection
                                                     └── (sequential) ──> export_to_deliverables
```

Returned `metadata.parallel_groups`:

```json
[["node_load_file", "node_run_clash_detection"]]
```

**Wrong.** `run_clash_detection` must run *after* every iteration of `load_file` has completed, not in parallel with each iteration.

### 1.2 Root cause (code-grounded)

`src/lib/dag-builder.ts:177-214` — `buildParallelGroups()` groups by topological level + direct-edge adjacency, with no awareness of `edge.type`. `topologicalSort()` at `:111-170` exhibits the same blind spot. The existing `RelationshipType` enum at `src/types.ts:14` includes `"loop"` as a label, but no consumer of that label exists in the planner code.

---

## 2. Schema changes

### 2.1 `src/types.ts`

```diff
- export type RelationshipType = "sequential" | "parallel" | "conditional" | "loop" | "trigger";
+ export type RelationshipType = "sequential" | "parallel" | "conditional" | "loop" | "after_loop" | "trigger";

  export interface WorkflowEdge {
    id: string;
    from: string;
    to: string;
    type: RelationshipType;
    condition?: string;
    confidence: number;
+   isSynthetic?: boolean;  // internal marker; stripped before returning to caller
  }

  export interface WorkflowDAG {
    ...
    metadata: {
      intent_count: number;
      edge_count: number;
      has_cycles: boolean;
      parallel_groups: string[][];
+     warnings: string[];
    };
  }
```

The `isSynthetic` field is internal — set by `injectLoopCompletionDeps`, used by the planner, and stripped before the response is serialized (see §3.9). Using a structured boolean instead of an ID-prefix marker (the v2 design) removes the namespace-collision risk identified in the v2 redteam (M3).

### 2.2 `src/tools/create-workflow.ts`

```diff
  type: z
-   .enum(["sequential", "parallel", "conditional", "loop", "trigger"])
+   .enum(["sequential", "parallel", "conditional", "loop", "after_loop", "trigger"])
    .describe("How the two intents relate"),
```

### 2.3 New file `src/errors.ts`

```ts
export class InvalidEdgeError extends Error {
  constructor(
    public readonly reason: string,
    public readonly edgeId: string
  ) {
    super(`InvalidEdgeError: ${reason} (edge: ${edgeId})`);
    this.name = "InvalidEdgeError";
  }
}

export class InvalidLoopError extends Error {
  constructor(
    public readonly reason: string,
    public readonly loopNodeId?: string
  ) {
    super(`InvalidLoopError: ${reason}${loopNodeId ? ` (loop: ${loopNodeId})` : ""}`);
    this.name = "InvalidLoopError";
  }
}

export class PlannerInvariantError extends Error {
  constructor(reason: string) {
    super(`PlannerInvariantError: ${reason}`);
    this.name = "PlannerInvariantError";
  }
}
```

All three extend `Error`, so the existing wrapper at `src/index.ts:107-118` catches them and returns `isError: true` with the message in `content[0].text`. No wrapper changes needed.

`PlannerInvariantError` is for unreachable code paths (see §3.8) — it indicates a bug in the planner itself, not a caller error.

---

## 3. Algorithm

### 3.1 Edge-from-loop-node behavior matrix (single source of truth)

| Edge type from a loop node | Meaning | Validator action |
|---|---|---|
| `loop` | Body of the iteration (runs per iteration) | Accept (unless self-loop — see below) |
| `after_loop` | Continuation after loop completes (runs once) | Accept |
| `sequential` | (legacy convention — caller meant after-loop) | Auto-promote to `after_loop` with deprecation warning |
| `parallel` / `conditional` / `trigger` | Undefined | Reject with `InvalidEdgeError` |

Structural rules (all enforced by `validateLoopEdges` in §3.3):
- A `after_loop` edge's `from` node MUST be a `type: "loop"` node.
- A loop node MUST have at least one outgoing `loop` edge.
- A loop node MUST NOT have a self-referential edge (any edge where `from === to`). Reject with `InvalidLoopError: loop node has a self-referential edge — a loop whose body is itself has no terminating semantics`. This addresses v2-H1.
- (New, addressing v2-M2) For each loop `L` and each after-loop target `A` of `L`, `A` MUST NOT be reachable from `L`'s body via non-`after_loop` edges. Enforced by `validateAfterLoopExclusivity` in §3.4.

### 3.2 Auto-promotion (backwards compatibility)

```ts
function autoPromoteAfterLoopEdges(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): { edges: WorkflowEdge[]; warnings: string[] } {
  const warnings: string[] = [];
  const loopNodeIds = new Set(nodes.filter(n => n.type === "loop").map(n => n.id));

  const promoted = edges.map(e => {
    if (loopNodeIds.has(e.from) && e.type === "sequential") {
      const hasExplicit = edges.some(
        x => x.from === e.from && x.type === "after_loop"
      );
      if (!hasExplicit) {
        warnings.push(
          `[deprecation] Edge ${e.id} auto-promoted: 'sequential' → 'after_loop'. ` +
          `Please specify type: "after_loop" explicitly on edges from loop nodes.`
        );
        return { ...e, type: "after_loop" as const };
      }
    }
    return e;
  });

  return { edges: promoted, warnings };
}
```

**Warning string format (asserted in V6):** `/^\[deprecation\] Edge .+ auto-promoted: 'sequential' → 'after_loop'/`.

### 3.3 Validate edge types & loop structure

```ts
import { InvalidEdgeError, InvalidLoopError } from "../errors.js";

function validateLoopEdges(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): void {
  const loopNodeIds = new Set(nodes.filter(n => n.type === "loop").map(n => n.id));
  const FORBIDDEN_FROM_LOOP: RelationshipType[] = ["parallel", "conditional", "trigger"];

  for (const e of edges) {
    // (v2-H1) Self-loop rejection on any loop-node edge.
    if (loopNodeIds.has(e.from) && e.from === e.to) {
      throw new InvalidLoopError(
        `loop node has a self-referential edge — a loop whose body is itself has no terminating semantics`,
        e.from
      );
    }

    if (loopNodeIds.has(e.from) && FORBIDDEN_FROM_LOOP.includes(e.type)) {
      throw new InvalidEdgeError(
        `edge type '${e.type}' not supported from a loop node — use 'loop' or 'after_loop'`,
        e.id
      );
    }
    if (e.type === "after_loop" && !loopNodeIds.has(e.from)) {
      throw new InvalidEdgeError(
        `after_loop edge from non-loop node`,
        e.id
      );
    }
    // sequential edges from loop nodes only survive auto-promotion when explicit
    // after_loop is also present — that's the ambiguous case.
    if (loopNodeIds.has(e.from) && e.type === "sequential") {
      throw new InvalidEdgeError(
        `sequential edge from loop node is ambiguous when explicit after_loop edges are present — use 'loop' or 'after_loop'`,
        e.id
      );
    }
  }

  for (const loopId of loopNodeIds) {
    const hasBody = edges.some(e => e.from === loopId && e.type === "loop");
    if (!hasBody) {
      throw new InvalidLoopError(`loop node has no body`, loopId);
    }
  }
}
```

### 3.4 Body-closure + after-loop exclusivity

**Convention (stated):** *Any node reachable from a loop body via non-`after_loop` edges is considered part of the loop body and will run on every iteration. To model a one-shot post-loop step, the caller MUST connect it via an `after_loop` edge from the loop node — not via a `sequential` edge chained off a body node.*

The MUST is now **enforced** (addressing v2-M2):

```ts
function computeBodyClosure(
  loopNodeId: string,
  edges: WorkflowEdge[]
): Set<string> {
  const closure = new Set<string>();
  const seeds = edges
    .filter(e => e.from === loopNodeId && e.type === "loop")
    .map(e => e.to);

  const stack = [...seeds];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (closure.has(n)) continue;
    closure.add(n);
    for (const e of edges.filter(e => e.from === n)) {
      stack.push(e.to);
    }
  }
  return closure;
}

function validateAfterLoopExclusivity(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): void {
  const loopNodes = nodes.filter(n => n.type === "loop");
  for (const L of loopNodes) {
    const bc = computeBodyClosure(L.id, edges);
    const afterTargets = edges
      .filter(e => e.from === L.id && e.type === "after_loop")
      .map(e => e.to);
    for (const A of afterTargets) {
      if (bc.has(A)) {
        throw new InvalidLoopError(
          `after-loop target '${A}' is also reachable from the body of loop '${L.id}' via non-after_loop edges. ` +
          `This violates the body/after-loop exclusivity convention — remove either the after_loop edge or the body-chain path.`,
          L.id
        );
      }
    }
  }
}
```

Worked example of correct nested-loop closure (variables: `Lo` outer loop, `Li` inner loop, `B` inner body, `Ai` inner after-loop, `Ao` outer after-loop). With edges `Lo →loop→ Li`, `Lo →after_loop→ Ao`, `Li →loop→ B`, `Li →after_loop→ Ai`:

- `computeBodyClosure(Lo)`: seeds = `{Li}`. Traverse Li → push `B` (via loop) and `Ai` (via after_loop). Both have no further outgoing edges. Result: `{Li, B, Ai}`.
- `Ao` is NOT in `body_closure(Lo)` (it's reached only via `Lo →after_loop→ Ao`, and seeds exclude after-loop targets).
- `validateAfterLoopExclusivity`: Ao ∉ {Li, B, Ai}. Pass.

### 3.5 Synthetic dependency injection (returns synthetic-only)

(Addressing v2-L1 and v2-M3 together: function returns just synthetic edges, and each is tagged with `isSynthetic: true`.)

```ts
function injectLoopCompletionDeps(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): WorkflowEdge[] {
  const loopNodes = nodes.filter(n => n.type === "loop");
  const synthetic: WorkflowEdge[] = [];

  for (const L of loopNodes) {
    const bodyClosure = computeBodyClosure(L.id, edges);
    const afterNodes = edges
      .filter(e => e.from === L.id && e.type === "after_loop")
      .map(e => e.to);

    for (const A of afterNodes) {
      for (const B of bodyClosure) {
        if (isReachable(B, A, edges)) continue;  // (v1-M5) transitive skip
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

  return synthetic;  // synthetic-only, not the union
}

function isReachable(from: string, to: string, edges: WorkflowEdge[]): boolean {
  if (from === to) return true;
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  const visited = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (visited.has(n)) continue;
    visited.add(n);
    for (const next of adj.get(n) ?? []) {
      if (next === to) return true;
      stack.push(next);
    }
  }
  return false;
}
```

### 3.6 Post-cycle-break revalidation

(Addressing v2-M1.) The existing `breakCycles` at `src/lib/dag-builder.ts:84-102` removes every back-edge identified by `detectCycles` (a minimal cut). It is **not modified by this RFC** — making it "loop-aware" via sort order has no effect, because every cycle edge gets removed regardless of sort order. Instead, the fix for "cycle breaking can leave a loop bodyless" is a single new validation pass that runs immediately after cycle breaking.

```ts
function validatePostCycleBreak(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): void {
  const loopNodes = nodes.filter(n => n.type === "loop");
  for (const L of loopNodes) {
    const hasBody = edges.some(e => e.from === L.id && e.type === "loop");
    if (!hasBody) {
      throw new InvalidLoopError(
        `cycle breaking removed the only body edge of loop '${L.id}' — caller must restructure the graph to avoid the conflict`,
        L.id
      );
    }
  }
}
```

This is sufficient: whenever a cycle resolution would silently kill a loop body, the caller gets a clear `InvalidLoopError` instead of a malformed DAG.

### 3.7 Re-run cycle detection after synthetic injection (unchanged from v2)

```ts
function detectSyntheticCycles(
  nodeIds: string[],
  edgesWithSynthetic: WorkflowEdge[]
): void {
  const { hasCycles, cycleEdgeIds } = detectCycles(nodeIds, edgesWithSynthetic);
  if (hasCycles) {
    throw new InvalidLoopError(
      `after-loop target has a caller-defined path back to a body node — ` +
      `this violates loop-completion ordering. Cycle involves edges: ${cycleEdgeIds.join(", ")}`
    );
  }
}
```

### 3.8 `topologicalSort()` safety-net policy

The existing safety net at `src/lib/dag-builder.ts:162-167` silently appends unordered nodes:

```ts
for (const id of nodeIds) {
    if (!order.includes(id)) {
      order.push(id);
      levels.set(id, (levels.get(id) ?? 0));
    }
}
```

(Addressing v2-L3.) Under the v3 invariants — `detectSyntheticCycles` rejects on cycle, `validatePostCycleBreak` rejects on bodyless loop — this branch should be unreachable. Tighten it so any violation fails loudly:

```diff
- for (const id of nodeIds) {
-     if (!order.includes(id)) {
-       order.push(id);
-       levels.set(id, (levels.get(id) ?? 0));
-     }
- }
+ const unordered = nodeIds.filter(id => !order.includes(id));
+ if (unordered.length > 0) {
+   throw new PlannerInvariantError(
+     `topological sort left ${unordered.length} node(s) unordered: ${unordered.join(", ")}. ` +
+     `This indicates a bug in cycle detection or synthetic-dep injection.`
+   );
+ }
```

Any future regression that bypasses the upstream checks now produces an `isError: true` response instead of a silently-wrong DAG.

### 3.9 Final shape of `edges[]` and `isSynthetic` stripping

Synthetic edges are **not** included in `dag.edges[]`. Their effect is visible only via `node.dependencies[]`, `metadata.parallel_groups[]`, and `execution_order[]`.

For caller edges in `dag.edges[]`: the `isSynthetic` field is absent (never set on caller edges). No stripping pass is needed for the response, because caller edges never carry this field in the first place. Synthetic edges with `isSynthetic: true` exist only in the planner's internal `augmentedEdges` array — they never reach the response object.

### 3.10 Wiring in `buildDAG()` — authoritative order

```ts
import {
  InvalidEdgeError,
  InvalidLoopError,
  PlannerInvariantError,
} from "../errors.js";

export function buildDAG(
  intents: Intent[],
  relationships: IntentRelationship[],
  name: string,
  description: string
): WorkflowDAG {
  const nodes = buildNodes(intents);
  let edges = buildEdges(relationships);
  const nodeIds = nodes.map(n => n.id);

  // 1. Auto-promote legacy `sequential` edges from loop nodes.
  const { edges: promotedEdges, warnings } = autoPromoteAfterLoopEdges(nodes, edges);
  edges = promotedEdges;

  // 2. Validate edge types & loop structure (including self-loop rejection, no-body rejection).
  validateLoopEdges(nodes, edges);

  // 3. First cycle detection (on caller-provided + auto-promoted edges).
  const { hasCycles, cycleEdgeIds } = detectCycles(nodeIds, edges);
  if (hasCycles) edges = breakCycles(edges, cycleEdgeIds);

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
  //    NOTE: §3.8 tightens the topo-sort safety net to throw PlannerInvariantError.
  const { order: execution_order, levels } = topologicalSort(nodeIds, augmentedEdges);

  // 9. Populate node.dependencies from caller edges first, then synthetic.
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  for (const edge of edges) {
    const t = nodeMap.get(edge.to);
    if (t && !t.dependencies.includes(edge.from)) t.dependencies.push(edge.from);
  }
  for (const synth of syntheticEdges) {
    const t = nodeMap.get(synth.to);
    if (t && !t.dependencies.includes(synth.from)) t.dependencies.push(synth.from);
  }

  // 10. Parallel groups (computed against augmented edges so synthetic gating applies).
  const parallel_groups = buildParallelGroups(nodeIds, levels, augmentedEdges);

  return {
    id: uuidv4(), name, description,
    created_at: new Date().toISOString(),
    nodes,
    edges,  // ← caller-provided only; synthetic excluded
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
```

**This call sequence is normative.** No other section's ordering hints take precedence.

---

## 4. Backwards compatibility

| Existing caller pattern | New validator behavior | Migration |
|---|---|---|
| `loop` edge for body + `sequential` edge for continuation (de facto convention) | Auto-promoted to `after_loop` with deprecation warning. Semantics: correct. | Optional — emit `after_loop` explicitly to silence the warning. |
| `loop` edge only (no continuation) | Unchanged. | None |
| Workflow with no `loop` nodes | Unchanged | None |
| `parallel` / `conditional` / `trigger` edge from a loop node | Newly rejected. | Caller must use `loop` or `after_loop`. |
| Explicit `after_loop` + `sequential` edge from same loop | Newly rejected (ambiguous). | Caller must replace `sequential` with `loop` or `after_loop`. |
| Self-loop on a loop node (any edge type) | Newly rejected. | Caller must restructure — self-referential loops have no terminating semantics. |
| After-loop target reachable from body via chain (violates §3.4 convention) | Newly rejected. | Caller must remove one of the two paths. |
| Cycle whose only resolution removes a loop's only body edge | Newly rejected (was: silently produced bodyless loop). | Caller must restructure. |

(Addressing v2-L4 — the unsubstantiated "no real-world callers" claim is replaced with a concrete release-gate.)

**Release gate:** the newly-rejected rows above are behaviorally narrower than v2's "we expect no callers to be affected" claim. Before shipping, the release engineer runs a one-off script against the MCP's invocation logs (if retained) to count workflows that would now be rejected. If the count is zero, ship as-is. If the count is non-zero, the release is blocked until the affected callers migrate — there is no warning-first fallback in this RFC because the v4 implementation rejects unconditionally; adding a strictness flag would be a separate scope change.

If invocation logs are not retained (e.g., for an internal tool with no centralized logging), document the new rejection behavior in the changelog and accept that early adopters may hit `InvalidEdgeError` / `InvalidLoopError` until they migrate. The error messages are explicit and actionable.

---

## 5. Verification matrix

The fix is verified iff all of the following pass in `test/mcp-client.test.mjs`.

### 5.1 Fixtures

`test/fixtures/regression-loop-completion.json`:

```json
{
  "name": "Forma Files → Clash Detection → Deliverables Export",
  "description": "Regression fixture for loop-completion semantics fix.",
  "intents": [
    { "id": "fetch_file_list", "label": "List files", "type": "fetch", "description": "List files in Forma project A", "action": "fetch", "entities": [], "parameters": {} },
    { "id": "iterate_files", "label": "Iterate", "type": "loop", "description": "Loop over 10 files", "action": "loop", "entities": [], "parameters": {} },
    { "id": "load_file", "label": "Load file", "type": "fetch", "description": "Load one file per iteration", "action": "load", "entities": [], "parameters": {} },
    { "id": "run_clash_detection", "label": "Clash detection", "type": "transform", "description": "Run clash detection", "action": "transform", "entities": [], "parameters": {} },
    { "id": "export_to_deliverables", "label": "Export", "type": "store", "description": "Export to Deliverables folder", "action": "store", "entities": [], "parameters": {} }
  ],
  "relationships": [
    { "from": "fetch_file_list",      "to": "iterate_files",          "type": "sequential", "confidence": 1 },
    { "from": "iterate_files",        "to": "load_file",              "type": "loop",       "confidence": 1 },
    { "from": "iterate_files",        "to": "run_clash_detection",    "type": "sequential", "confidence": 1 },
    { "from": "run_clash_detection",  "to": "export_to_deliverables", "type": "sequential", "confidence": 1 }
  ]
}
```

### 5.2 Test matrix (V1–V22)

| #   | Scenario | Setup | Assertion |
|-----|---|---|---|
| **V1**  | Baseline: 1 body, 1 after-loop | `loop` to bodyA; `after_loop` to afterA | `parallel_groups` does NOT contain `[bodyA, afterA]`; `afterA.dependencies` includes `bodyA` |
| **V2**  | 2 body nodes per iteration | Two `loop` edges to bodyA, bodyB | `[bodyA, bodyB] ∈ parallel_groups`; both gate every after-loop target |
| **V3**  | 1 body, 2 after-loop nodes | One `loop` edge; two `after_loop` edges | `[afterA, afterB] ∈ parallel_groups`; neither parallel with body |
| **V4**  | Nested loops | Outer body contains inner loop with body + after-loop | Outer's after-loop has synthetic deps on inner's after-loop AND inner's body (per §3.4 worked example) |
| **V5**  | Conditional inside loop body | Body node has `conditional` outgoing edge to branchA | `branchA ∈ body_closure`; after-loop gated on branchA |
| **V6**  | Auto-promotion deprecation warning | `loop` + `sequential` continuation, no explicit `after_loop` | V1 assertions hold; `metadata.warnings[0]` matches `/^\[deprecation\] Edge .+ auto-promoted: 'sequential' → 'after_loop'/` |
| **V7**  | Rejection: explicit `after_loop` + `sequential` from same loop | Caller emits both | Rejected with `InvalidEdgeError` mentioning "ambiguous" |
| **V8**  | Loop with body only, no continuation | Only `loop` edges from loop node | No synthetic deps; no warnings; pre-fix behavior preserved |
| **V9**  | **Smoking-gun regression** | Replay fixture from §5.1 verbatim | `parallel_groups` does NOT contain `[node_load_file, node_run_clash_detection]`; `metadata.warnings[]` non-empty (auto-promotion fired) |
| **V10** | Determinism | Run V1–V9 100× each | Output identical every run |
| **V11** | Caller-defined cycle involving `after_loop` | After-loop edge participates in caller-authored cycle | First cycle detection identifies and removes back-edge(s); pipeline proceeds (assuming the removal didn't kill the loop's only body edge — that case is V22) |
| **V12** | Synthetic-induced cycle (v1-H3 fix) | Caller writes `after_loop_target → body_node` (sequential) | Rejected with `InvalidLoopError` mentioning "after-loop target has a caller-defined path back to a body node" |
| **V13** | Rejection: `after_loop` from non-loop node | `after_loop` edge from a `transform` node | Rejected with `InvalidEdgeError: after_loop edge from non-loop node` |
| **V14** | Rejection: loop node with no body | Loop has only `after_loop` edges, no `loop` edges | Rejected with `InvalidLoopError: loop node has no body` |
| **V15** | Rejection: forbidden edge types from loop node | Loop node has a `parallel` / `conditional` / `trigger` outgoing edge | Rejected with `InvalidEdgeError: edge type 'X' not supported from a loop node` |
| **V16** | Sibling loops (not nested) | Two loops at same depth, sharing no nodes | Each loop's body closure independent; each after-loop gated only on its own body |
| **V17** | Terminal body node | Body node with zero outgoing edges | Body still in `body_closure`; after-loop correctly gated on it |
| **V18** | **Rejection: self-loop** (v2-H1 fix) | Loop node has outgoing edge `L → L` (any type) | Rejected with `InvalidLoopError: loop node has a self-referential edge` |
| **V19** | Redundant-skip via indirect chain (v1-M5 fix) | Caller writes `body → X → after_loop_target` (sequential chain) | No synthetic edge `body → after_loop_target` added; `after_loop_target.dependencies` does NOT contain `body` directly |
| **V20** | **Rejection: after-loop exclusivity violation** (v2-M2 fix) | `L→loop→B`, `B→sequential→X`, `X→sequential→A`, `L→after_loop→A` | Rejected with `InvalidLoopError: after-loop target 'A' is also reachable from the body of loop 'L'` |
| **V21** | **isSynthetic edge tagging** (v2-M3 / v2-L1 fix) | Run V1's scenario; verify the response object | `afterA.dependencies` contains `bodyA` (proves the synthetic edge was honored in dependency computation); the response `edges[]` contains NO edge with `isSynthetic: true` (proves synthetic edges are planner-internal only) |
| **V22** | **Rejection: cycle-break leaves loop bodyless** (v2-M1 fix) | `L→loop→B`, `B→sequential→L` (cycle), both confidence 1.0. Outcome depends on caller intent ordering, which drives DFS traversal. | **Case 1** (caller intents ordered `[L, B]`): DFS visits L first, identifies `B→L` as back-edge; `breakCycles` removes it; loop body preserved; pipeline succeeds. **Case 2** (caller intents ordered `[B, L]`): DFS visits B first, identifies `L→B` (the body edge) as back-edge; `breakCycles` removes it; `validatePostCycleBreak` throws `InvalidLoopError: cycle breaking removed the only body edge of loop 'L'`. Both cases must be tested. |

**V9 + V12 + V18 + V20 + V22 are the regression tests that prove the v3 fix is verified.**

---

## 6. Out of scope (acknowledged, separate work items)

| Issue | Why deferred |
|---|---|
| Semantic validation of architectural mismatches (e.g. PDF into Forma) | Requires an APS-capability knowledge layer; orthogonal to DAG correctness. |
| `break` / `continue` semantics for early loop termination | No precedent in current schema; out of scope for v1 of this fix. |
| Conditional after-loop (skip after-loop if iteration count was 0) | Edge case; current behavior (always run after-loop) is acceptable. |
| Validating that loop bodies eventually reach back to the loop node | Nice-to-have lint; not a correctness issue under current semantics. |

---

## 7. Acceptance criteria

Shippable when:

1. ✅ All V1–V22 assertions pass in CI (`npm test`).
2. ✅ Replay of `test/fixtures/regression-loop-completion.json` produces correct `parallel_groups` (V9).
3. ✅ Synthetic-cycle case (V12), self-loop case (V18), after-loop exclusivity case (V20), and cycle-break-bodyless case (V22) all reject with clear error messages.
4. ✅ Existing test using `loop` + `sequential` passes with auto-promotion warning (V6).
5. ✅ Tool description in `src/tools/create-workflow.ts` mentions `after_loop`, auto-promotion, and §3.4 convention.
6. ✅ `metadata.warnings: string[]` field documented in `WorkflowDAG` type.
7. ✅ `src/errors.ts` exports `InvalidEdgeError`, `InvalidLoopError`, `PlannerInvariantError`.
8. ✅ Release-gate script (§4) has been run, OR warning-first rollout has been adopted.

---

## 8. Implementation checklist

- [ ] **`src/types.ts`**: add `"after_loop"` to `RelationshipType` (line 14); add `isSynthetic?: boolean` to `WorkflowEdge`; add `warnings: string[]` to `WorkflowDAG.metadata`.
- [ ] **`src/errors.ts`** (new): define `InvalidEdgeError`, `InvalidLoopError`, `PlannerInvariantError` per §2.3.
- [ ] **`src/tools/create-workflow.ts`**: add `"after_loop"` to the Zod enum (line 21); update tool description.
- [ ] **`src/lib/dag-builder.ts`**: add helpers (§3.2 `autoPromoteAfterLoopEdges`, §3.3 `validateLoopEdges`, §3.4 `computeBodyClosure` + `validateAfterLoopExclusivity`, §3.5 `injectLoopCompletionDeps` + `isReachable`, §3.6 `validatePostCycleBreak`, §3.7 `detectSyntheticCycles`).
- [ ] **`src/lib/dag-builder.ts`**: tighten `topologicalSort` safety net (lines 162–167) per §3.8. Note: `breakCycles` itself (lines 84–102) is unchanged in v4 — `validatePostCycleBreak` provides the safety.
- [ ] **`src/lib/dag-builder.ts`**: rewire `buildDAG()` per the §3.10 authoritative sequence.
- [ ] **`test/mcp-client.test.mjs`**: add V1–V22.
- [ ] **`test/fixtures/regression-loop-completion.json`** (new): per §5.1.
- [ ] **Release-gate**: run log-search script OR adopt warning-first rollout (§4).

---

## 9. Estimated effort

- **Production code:**
  - `src/types.ts`: +3 LOC.
  - `src/errors.ts`: +25 LOC (new file).
  - `src/tools/create-workflow.ts`: +1 LOC (enum) + ~10 LOC (description / wiring).
  - `src/lib/dag-builder.ts`: ~25 LOC wiring + ~140 LOC helpers (autoPromote 25, validateLoopEdges 35, computeBodyClosure 15, validateAfterLoopExclusivity 20, injectLoopCompletionDeps + isReachable 40, validatePostCycleBreak 10, detectSyntheticCycles 10) + ~5 LOC for safety-net tightening.
  - **Production total: ~210 LOC.**
- **Tests:** ~480 LOC (22 scenarios at ~22 LOC each, plus fixture + harness).
- **Docs:** 1–2 hours.

**Grand total: ~210 LOC production + ~480 LOC tests = 2.5 dev-days.**
