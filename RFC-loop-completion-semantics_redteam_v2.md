# Adversarial Review — RFC v2: Loop Completion Semantics

**Artifact:** `/Users/yedekan/Library/CloudStorage/OneDrive-Autodesk/PM Workspace/MCP/mcp-workflow-builder/RFC-loop-completion-semantics.md` (Draft v2)
**Reviewed:** 2026-05-22
**Source of truth:** Real source at `src/types.ts`, `src/lib/dag-builder.ts`, `src/tools/create-workflow.ts`, `src/index.ts`, `test/mcp-client.test.mjs`. Plus the v1 adversarial review at `RFC-loop-completion-semantics_redteam.md` (for traceability).
**Template:** N/A.
**Scope:** Full — two-pronged pass (verify v1 findings closed + attack v2 fresh). Depth: Standard.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0     |
| **High** | **1** |
| Medium   | 3     |
| Low      | 4     |

**Verdict: materially improved, near-shippable.** All 12 v1 findings are properly closed — none are "claimed-fixed-but-actually-not." The new High finding (H1) is a test-specification error in V18 rather than a fundamental design flaw, and the new Medium findings are edge-case gaps in validator coverage that an implementing engineer would likely catch during testing. v2 is shippable with the H1 fix; the Mediums should be patched before merge for completeness; the Lows are nice-to-have.

---

## Part 1 — v1 Findings Closure Audit

Verification of each v1 finding against v2. **All closed.**

| v1 ID | v1 issue | v2 resolution | Closed? |
|-------|---|---|---|
| H1 | §3.2 "before line 230" vs §8 ordering contradiction | §3.10 added as single authoritative wiring sequence with explicit precedence statement (*"no other section's ordering hints take precedence"*). The "before line 230" wording is gone. | ✅ Closed |
| H2 | V9 referenced non-replayable workflow UUID | §5.1 adds literal fixture `test/fixtures/regression-loop-completion.json` with full intents+relationships JSON. V9 now reads from fixture. | ✅ Closed |
| H3 | Synthetic deps could introduce uncaught cycles | §3.6 adds `detectSyntheticCycles()` as second cycle-detection pass; §3.10 step 5 wires it in. V12 tests it. Policy: reject (not break) because synthetic edges have `confidence: 1.0`. | ✅ Closed |
| M1 | Auto-promotion only specified for `sequential` | §3.1 adds edge-from-loop-node behavior matrix covering all 5 non-`loop` edge types; §3.3 `validateLoopEdges` rejects `parallel`/`conditional`/`trigger`. | ✅ Closed |
| M2 | Sequential + explicit after_loop ambiguous case | §3.3 explicitly rejects with `InvalidEdgeError` mentioning "ambiguous" when explicit after_loop is present. V7 tests it. | ✅ Closed |
| M3 | Verification matrix coverage gaps (5 missing scenarios) | Matrix expanded from V1–V11 to V1–V19. New: V12 (synth cycle), V14 (no body), V15 (forbidden types), V16 (siblings), V17 (terminal body), V18 (self-loop), V19 (indirect-chain skip). V6 now uses regex on warning message. | ✅ Closed (but see new H1 below) |
| M4 | Body closure semantics implicit | §3.4 states the convention in plain English (*"any node reachable from a loop body via non-after_loop edges is considered part of the loop body … to model a one-shot post-loop step, the caller MUST connect it via an after_loop edge"*). | ✅ Closed |
| M5 | Direct-edge skip check missed transitive chains | §3.5 uses `isReachable()` helper (BFS-based transitive check). V19 tests it. | ✅ Closed |
| M6 | §3.1 SHOULD-warning rule conflicted with §4 auto-promotion | §3.1 removes the SHOULD rule with explicit rationale (*"the auto-promotion path … handles the de facto convention, so a separate warning would be redundant"*). | ✅ Closed |
| L1 | Effort estimate inconsistency (~30 vs ~80 LOC) | §9 itemizes: ~25 LOC wiring + ~120 LOC helpers + ~400 LOC tests = 2 dev-days. Numbers reconcile. | ✅ Closed |
| L2 | `node.dependencies` population for synth not shown | §3.7 shows the code; §3.10 step 7 wires it in (two separate loops, caller-edges then synthetic). | ✅ Closed |
| L3 | Variable name collision (`I`) in nested-loop walkthrough | §3.4 renames to `Lo`/`Li`/`B`/`Ai`/`Ao`. Walkthrough now unambiguous. | ✅ Closed |

**No v1 finding was claimed-fixed-but-actually-not.** Excellent revision discipline.

---

## Part 2 — New v2 Findings

### H1 — V18 self-loop test assertion contradicts existing cycle-detection behavior  ·  High
- **Location:** §5.2, row V18.
- **Claim:** *"V18 — Self-loop. Loop node has an outgoing edge to itself. Rejected by first cycle detection (existing behavior — sanity check that the fix didn't break it)."*
- **Attack:** Vector 4 (internal contradiction) + vector 13 (logical impossibility). The existing cycle-detection behavior is **not** "reject" — it's "detect, set `has_cycles: true`, break the lowest-confidence back-edge." Verified at `src/lib/dag-builder.ts:84-102` (`breakCycles`) and at `test/mcp-client.test.mjs:155-168`, which explicitly asserts `cycDag.metadata.has_cycles === true` and `cycDag.edges.length === 2` (broken, not rejected).
- Tracing V18 through the v2 pipeline: a `loop`-type self-edge `L → L` reaches `validateLoopEdges` (step 2) and passes — the loop has a body (itself counts). `detectCycles` (step 3) flags `L→L` as a back-edge; `breakCycles` removes it. Now L has no body, but `validateLoopEdges` already ran. Pipeline continues; final DAG has `has_cycles: true`, no rejection, and a bodyless loop node — exactly the case M1' below flags.
- **Evidence:** `src/lib/dag-builder.ts:84-102`; `test/mcp-client.test.mjs:155-168`.
- **Suggested fix:** Choose one:
  - **(a) Update V18 to verify the actual existing behavior:** `cycDag.metadata.has_cycles === true && cycDag.edges.length === 0 && metadata.warnings[0]` describes the bodyless-loop outcome (depends on M1' fix).
  - **(b) Add self-loop rejection to `validateLoopEdges`:** treat `from === to` edges on loop nodes as a caller error; reject with `InvalidLoopError: loop node has a self-referential body edge`. Then V18 verifies rejection.
- **Recommendation:** (b) is cleaner because self-loops on loop nodes have no semantically useful interpretation (a loop whose body is itself never terminates). If (b) is adopted, also add an `validateLoopEdges` test for this specific shape.

### M1 — `breakCycles` can leave a loop bodyless; `validateLoopEdges` doesn't re-fire  ·  Medium
- **Location:** §3.10 wiring sequence, step 2 vs step 3.
- **Claim:** Step 2 (`validateLoopEdges`) ensures every loop node has at least one `loop` edge. Step 3 (`breakCycles`) can remove that very edge if it happens to be the lowest-confidence edge in a cycle.
- **Attack:** Vector 13 (logical correctness). Consider a caller workflow with `L --loop--> B (confidence 0.5)` and `B --sequential--> L (confidence 0.6)`. `validateLoopEdges` passes (L has body B). `detectCycles` flags both as back-edges. `breakCycles` removes the lower-confidence one — `L→B`. L is now bodyless, but the validator already passed.
- The downstream impact is moderate: `injectLoopCompletionDeps` would compute `body_closure(L) = {}` (no body to start from), so no synthetic edges are added. After-loop targets of L would have no dependency on any body node (because there is none). The final DAG returns successfully with a malformed loop. Not a crash, but a silent contract violation.
- **Evidence:** `src/lib/dag-builder.ts:84-102` (`breakCycles` is type-blind — sorts cycle edges by confidence ascending and removes the lowest, regardless of edge type).
- **Suggested fix:** Two options, in order of preference:
  - **(a) Make `breakCycles` loop-aware:** when cycle edges are tied by confidence (or even when not), prefer breaking non-`loop` edges. Add a secondary sort key: `type !== "loop" ? 0 : 1` (loop edges sort last → removed last).
  - **(b) Re-run a structural check after `breakCycles`:** add a `validatePostCycleBreak(nodes, edges)` that verifies all loop nodes still have at least one `loop` edge. If not, throw `InvalidLoopError: cycle breaking removed the only body edge of loop {L} — caller must restructure`. Cheaper, more defensive.
- Either way, add a test V20 covering this scenario.

### M2 — §3.4 convention is stated but not enforced  ·  Medium
- **Location:** §3.4 (body-closure convention) vs §3.3 (`validateLoopEdges`).
- **Claim (§3.4):** *"To model a one-shot post-loop step, the caller MUST connect it via an after_loop edge from the loop node — not via a sequential edge chained off a body node."*
- **Attack:** Vector 13 (logical correctness) + vector 14 (coverage gap). The MUST is unenforced. Consider:
  ```
  L --loop--> B
  L --after_loop--> A
  B --sequential--> X
  X --sequential--> A
  ```
  A is L's explicit after-loop target *and* reachable from body B via X. Tracing through the v2 algorithm:
  - `body_closure(L) = {B, X, A}` — A is pulled in because the closure traversal follows non-`after_loop` edges from body downstream.
  - `injectLoopCompletionDeps`: for after-target A, iterate body_closure {B, X, A}. `isReachable(B, A)` → true (via X) → skip. `isReachable(X, A)` → true → skip. `isReachable(A, A)` → true (same-node short-circuit) → skip. No synthetic edges added.
  - Resulting DAG silently has A as both a body-closure member and an after-loop target. Whether downstream consumers treat A as "runs per iteration" or "runs once after loop" is undefined.
- **Evidence:** §3.4 stated convention; §3.3 `validateLoopEdges` enforces edge-type rules only, not closure-membership conflicts.
- **Suggested fix:** Add a structural validation after `injectLoopCompletionDeps` runs (or replace the closure traversal with a one-pass check):
  ```ts
  function validateAfterLoopExclusivity(
    loopNodes: WorkflowNode[],
    edges: WorkflowEdge[]
  ): void {
    for (const L of loopNodes) {
      const bodyClosure = computeBodyClosure(L.id, edges);
      const afterTargets = edges
        .filter(e => e.from === L.id && e.type === "after_loop")
        .map(e => e.to);
      for (const A of afterTargets) {
        if (bodyClosure.has(A)) {
          throw new InvalidLoopError(
            `after-loop target ${A} is also reachable from loop body of ${L.id} — ` +
            `this violates the MUST in §3.4. Caller must remove either the after_loop edge ` +
            `or the body-chain path.`
          );
        }
      }
    }
  }
  ```
  Wire it into §3.10 between steps 4 and 5 (after closure is computed but before synthetic injection finalizes). Add test V21.

### M3 — `__synth_` ID prefix is a fragile marker  ·  Medium
- **Location:** §3.5 (synthetic edge ID format `__synth_${B}_${A}`) + §3.10 step 4 (`filter(e => e.id.startsWith("__synth_"))`).
- **Claim:** Synthetic edges are identified throughout the planner by their ID prefix.
- **Attack:** Vector 12 (type/cardinality error) + vector 14 (coverage gap). A caller can author an intent with `id: "__synth_X"`. After `buildEdges` at `src/lib/dag-builder.ts:26-35` constructs edge IDs as `` `${rel.from}_${rel.to}` ``, an edge from intent `__synth_X` to intent `Y` would have ID `__synth_X_Y` — matching the synthetic marker. The filter in §3.10 step 4 would then misclassify a caller edge as synthetic, with two downstream effects:
  1. The "synthetic" caller edge would be excluded from `dag.edges[]` (per §3.9).
  2. It would still be processed by `detectSyntheticCycles`, but a benign caller-defined cycle would be misattributed to "synthetic-induced".
- This is a low-probability namespace collision in practice, but it's a footgun for callers who happen to use underscore-prefix conventions.
- **Evidence:** `src/lib/dag-builder.ts:28` (`id: \`${rel.from}_${rel.to}\``); §3.10 filter line.
- **Suggested fix:** Add an explicit boolean field to `WorkflowEdge` for synthetic provenance:
  ```diff
    export interface WorkflowEdge {
      id: string;
      from: string;
      to: string;
      type: RelationshipType;
      condition?: string;
      confidence: number;
  +   isSynthetic?: boolean;  // set true by injectLoopCompletionDeps; absent on caller edges
    }
  ```
  Then `injectLoopCompletionDeps` sets `isSynthetic: true` on every edge it creates, and §3.10's filter becomes `filter(e => e.isSynthetic)`. Strip the field before returning the DAG to the caller (so the user-facing schema doesn't grow). Robust against any naming collision.

### L1 — Awkward return shape of `injectLoopCompletionDeps`  ·  Low
- **Location:** §3.5 (returns `[...edges, ...synthetic]`) vs §3.10 step 4 (filters then reconstructs).
- **Claim:** The function returns the augmented edge list (caller + synthetic combined). The caller in §3.10 then extracts just synthetic via filter, then re-concatenates with the original edges as `augmentedEdges`.
- **Attack:** Vector 6 (cosmetic schema deviation — minor design awkwardness). The double-pass (filter + concatenate) is redundant; cleaner to return just the synthetic edges and let the caller concatenate once.
- **Suggested fix:** Change signature to `injectLoopCompletionDeps(nodes, edges): WorkflowEdge[]` returning **synthetic only**. §3.10 step 4 becomes:
  ```ts
  const syntheticEdges = injectLoopCompletionDeps(nodes, edges);
  const augmentedEdges = [...edges, ...syntheticEdges];
  ```
  Trivial cleanup; resolves the M3 issue simultaneously if combined with the `isSynthetic` flag.

### L2 — Error classes referenced but not defined in any §  ·  Low
- **Location:** §3.3, §3.6 throw `InvalidEdgeError` and `InvalidLoopError`; §8 implementation checklist mentions they "should extend `Error`" but no definition is shown anywhere in the RFC.
- **Attack:** Vector 14 (coverage gap). The engineer implementing this would have to guess the class shape: constructor signature (`(message, edgeId?)`?), location (`src/types.ts` vs new `src/errors.ts`?), whether to attach `code` / `details` fields, whether to extend a base `ValidationError`.
- **Evidence:** Searched §3.3, §3.6, §8 — only `extend Error` is specified. The current `index.ts:107-118` catches all errors via `err instanceof Error` and surfaces `err.message`, so any subclass works at the wrapper level — but the error-class API surface is unspecified.
- **Suggested fix:** Add a short §3.0 (or §2.3) showing the class definitions:
  ```ts
  // src/errors.ts (new file)
  export class InvalidEdgeError extends Error {
    constructor(public readonly reason: string, public readonly edgeId: string) {
      super(`InvalidEdgeError: ${reason} (edge: ${edgeId})`);
      this.name = "InvalidEdgeError";
    }
  }
  export class InvalidLoopError extends Error {
    constructor(public readonly reason: string, public readonly loopNodeId?: string) {
      super(`InvalidLoopError: ${reason}${loopNodeId ? ` (loop: ${loopNodeId})` : ""}`);
      this.name = "InvalidLoopError";
    }
  }
  ```

### L3 — `topologicalSort` safety-net could mask post-fix bugs  ·  Low
- **Location:** Existing `src/lib/dag-builder.ts:162-167`:
  ```ts
  // Any remaining nodes (shouldn't happen after cycle breaking, but safety net)
  for (const id of nodeIds) {
    if (!order.includes(id)) {
      order.push(id);
      levels.set(id, (levels.get(id) ?? 0));
    }
  }
  ```
- **Claim:** v2 relies on `detectSyntheticCycles` to catch all cycles introduced by synthetic injection. But if that check fails (false negative due to a bug), the topo-sort silently appends remaining nodes at level 0, producing a wrong-but-not-failing DAG.
- **Attack:** Vector 14 (coverage gap, defensive-programming). Not a current bug — but the RFC doesn't say whether this safety net should remain (potentially masking future regressions) or be tightened to throw on unsorted nodes.
- **Evidence:** Existing code unchanged in v2.
- **Suggested fix:** Decision-only — note in the RFC (e.g., §3.8) whether the safety net stays or is tightened. Recommend tightening to `throw new Error("planner invariant violated: topological sort left N nodes unordered")` so any post-fix regression fails loudly. Low-risk because, by v2's design, this branch should be unreachable.

### L4 — Unsubstantiated claim in §4 about real-world callers  ·  Low
- **Location:** §4 backwards compatibility.
- **Claim:** *"We expect no real-world callers in these states (no documented use of conditional/trigger from loop nodes; the auto-promotion handles the only common shape). A pre-release search of existing workflow logs would confirm this is safe."*
- **Attack:** Vector 3 (citation gap / vampire citation). The claim is conditional on a search that has not been performed. The RFC presents the search as a future activity but uses it to justify a backwards-incompatibility today.
- **Evidence:** No data cited.
- **Suggested fix:** Either (a) defer the rejection-of-other-edge-types behavior behind a config flag for one release (warn-then-reject), or (b) actually perform the log search and embed the result. As written, this is over-claiming compatibility safety.

---

## Cross-cutting observations

1. **v1-finding closure quality is high.** Each v1 finding has a precise, code-grounded v2 resolution. No "claimed fixed but not actually fixed" cases — that's rare.
2. **New issues cluster at validation boundaries.** Three of the four substantive new findings (H1, M1, M2) are about edges of validation: order-of-validation (M1), enforcement-of-stated-convention (M2), and mis-specified test (H1). All three resolve by tightening `validateLoopEdges` or adding a post-cycle-break re-validation pass.
3. **Naming hygiene around synthetic edges is the other cluster.** M3 + L1 both touch on how synthetic edges are distinguished from caller edges. A single fix — adding `isSynthetic?: boolean` to `WorkflowEdge` — resolves both at once, and is the recommended consolidation.
4. **No fabricated entities, no broken code references, no stale citations.** All `src/...:N` references in v2 still check out against the actual source. Bonus: the v2 RFC correctly identifies `src/index.ts:107-118` as the error-catching layer without explicitly citing it, which means the design is consistent with the wrapper's behavior even though the wrapper isn't directly referenced.
5. **Scope discipline preserved.** §6 (out of scope) is unchanged from v1 — no scope creep introduced by the revisions.

---

## What was checked but found clean

- Every code:line reference in v2 verified against `src/lib/dag-builder.ts`, `src/types.ts`, `src/tools/create-workflow.ts`, `src/index.ts`.
- `src/index.ts:107-118` confirms exceptions thrown from `buildDAG` reach the user as `isError: true` with `err.message` in `content[0].text` — the RFC's error-handling claim works.
- §3.10 step-by-step wiring is internally consistent: each step's input matches the prior step's output; signatures match the §3.x helper definitions.
- §3.4 nested-loop closure trace is correct (verified independently): `body_closure(Lo) = {Li, Ai, B}` with `Ao` excluded.
- §3.5 `isReachable` BFS implementation is correct; transitive-reachability check is properly conservative for the M5 fix.
- §3.6 cycle-rejection policy (rather than break) is well-justified given synthetic edges have `confidence: 1.0`.
- §5.1 fixture JSON is well-formed and reproduces the original failing case faithfully.
- V6 regex matches the warning string format defined in §3.2.
- V12 scenario correctly tests the H3 v1 fix (caller writes `A→B` where `A` is after-loop and `B` is body; synthetic `B→A` creates cycle; reject).
- V19 scenario correctly tests the M5 v1 fix (indirect chain prevents redundant synthetic dep).
- Effort estimate in §9 is realistic — actual code in §3.2–§3.6 sums to ~125 LOC by inspection, matching the ~120 LOC claim.
- Backwards-compatibility table in §4 correctly captures all five rows of caller patterns.
