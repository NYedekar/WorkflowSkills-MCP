# Adversarial Review — RFC: Loop Completion Semantics

**Artifact:** `/Users/yedekan/Library/CloudStorage/OneDrive-Autodesk/PM Workspace/MCP/mcp-workflow-builder/RFC-loop-completion-semantics.md`
**Reviewed:** 2026-05-22
**Source of truth:** The actual workflow-builder source tree at `src/types.ts`, `src/lib/dag-builder.ts`, `src/tools/create-workflow.ts`, and the existing test harness at `test/mcp-client.test.mjs`.
**Template:** N/A (no template — RFC is a free-form design doc).
**Scope:** Full — algorithmic correctness, internal consistency, schema/code grounding, backwards-compat coverage, verification matrix coverage.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0     |
| High     | 3     |
| Medium   | 6     |
| Low      | 3     |

**Verdict: usable with fixes.** The core design (explicit `after_loop` edge type + synthetic dependency injection) is sound, the code:line references are accurate, and the localized-fix claim is realistic. However, there is **one real algorithmic correctness gap** (H3 — synthetic deps can introduce cycles not caught by existing cycle detection), **one internal contradiction in the implementation order** (H1), and **one non-replayable regression test** (H2) that together prevent the RFC from being shippable as-is. The Medium findings are real spec gaps (mostly around what happens when callers use non-`sequential` edge types from loop nodes) that would surface as ambiguity during implementation. None of the findings invalidate the overall approach; all are fixable with focused edits to the existing document.

---

## Findings

### H1 — Internal contradiction in implementation order  ·  High
- **Location:** §3.2 (synthetic dep injection) vs §8 (implementation checklist).
- **Claim (§3.2):** *"Insert before line 230 of dag-builder.ts (right after buildEdges())."*
- **Claim (§8):** *"In buildDAG() (line 218), wire in: auto-promotion → cycle detection → synthetic dep injection → topo-sort → parallel groups."*
- **Attack:** Vector 4 (internal contradiction). Line 230 in `src/lib/dag-builder.ts` is `const { hasCycles, cycleEdgeIds } = detectCycles(nodeIds, edges);` — i.e., the cycle-detection call. §3.2 places synthetic dep injection *before* line 230 (before cycle detection). §8 places it *after* cycle detection. Engineer implementing this would not know which to follow, and the choice matters (see H3 below — placement determines whether synthetic-induced cycles are caught).
- **Evidence:** `src/lib/dag-builder.ts` line 225 is `let edges = buildEdges(relationships);`; line 230 is `detectCycles(...)`. "Right after buildEdges()" lands at line 226–229, which is before cycle detection — directly contradicting §8.
- **Suggested fix:** Pick one. Recommend the §8 order (auto-promote → cycle detection → synthetic injection → topo-sort) but **add a second cycle-detection pass** after synthetic injection to catch H3. Rewrite §3.2's "Insert before line 230" sentence accordingly.

### H2 — Smoking-gun regression test V9 is not reproducible  ·  High
- **Location:** §5, row V9, and §7 acceptance criterion 2.
- **Claim:** *"Regression: the original failing case. Replay workflow `0a199516-…` payload verbatim."*
- **Attack:** Vector 11 (ambiguity) + vector 14 (coverage gap). The RFC references the workflow by its UUID (`0a199516-9fbe-4a1d-bb97-0d9e22b0230a`), which is assigned by the MCP server at invocation time (`uuidv4()` at `dag-builder.ts:251`). No server has that UUID stored. The literal `intents` + `relationships` payload that produced the bug is not included in the RFC, so engineers cannot replay it.
- **Evidence:** `src/lib/dag-builder.ts:251` — `id: uuidv4()`. UUIDs are not stable across runs. The test harness at `test/mcp-client.test.mjs` constructs payloads inline (e.g., lines 60–72 for the linear case); there is no fixture-by-ID lookup mechanism.
- **Suggested fix:** Embed the literal `intents` + `relationships` JSON for the failing case into §5 V9 (or attach as `test/fixtures/regression-loop-completion.json`). The payload — 5 intents (`fetch_file_list`, `iterate_files`, `load_file`, `run_clash_detection`, `export_to_deliverables`) and 4 relationships — exists in this conversation's transcript and can be copied verbatim.

### H3 — Synthetic dep injection can introduce cycles not caught by existing cycle detection  ·  High
- **Location:** §3.2 algorithm + §8 ordering.
- **Claim:** *"After synthetic deps are injected, the existing level computation places after-loop nodes at level > any body-closure node, so the grouping pass naturally separates them. The fix is localized to ~30 lines in buildDAG()."*
- **Attack:** Vector 13 (logical impossibility / correctness). If the caller authored an edge `A → B` (where `A` is an after-loop target and `B` is a body node), the synthetic injection adds `B → A`. Combined with caller's `A → B`, this creates a cycle. The order specified in §8 runs `detectCycles()` *before* synthetic injection, so the new cycle is invisible to `breakCycles()`. The topo-sort at line 236 then enters the "safety net" path (lines 162–167) where unordered nodes are appended at the end with arbitrary levels — silently producing a wrong DAG, with `metadata.has_cycles === false`.
- **Evidence:** `src/lib/dag-builder.ts:111-170` `topologicalSort()` has fallback at lines 162–167 (`for (const id of nodeIds) { if (!order.includes(id)) ... }`). This swallows cycles silently rather than failing loudly.
- **Suggested fix:** Re-run `detectCycles()` after synthetic injection (or run it on `originalEdges + syntheticEdges` combined). On cycle detected, either (a) reject the workflow with `InvalidLoopError: caller-defined edges + loop completion semantics produce a cycle (after-loop target depends on a body node)`, or (b) remove the lowest-confidence synthetic edge — but synthetic edges have confidence 1.0 per §3.2, so option (a) is cleaner. Add this as a new test row V12 to the verification matrix.

### M1 — Auto-promotion only specifies behavior for `sequential` edges  ·  Medium
- **Location:** §4 backwards compatibility.
- **Claim:** *"Auto-promote: a `sequential` edge from a `type: 'loop'` node is treated as `after_loop` if no explicit `after_loop` edges exist on that node."*
- **Attack:** Vector 14 (coverage gap). The `RelationshipType` enum (`src/types.ts:14`) allows `sequential | parallel | conditional | loop | trigger`. The RFC addresses `loop` (means body) and `sequential` (auto-promoted to after_loop). Behavior for `parallel`, `conditional`, and `trigger` edges *originating from a loop node* is undefined. A caller can construct any of these today.
- **Evidence:** `src/tools/create-workflow.ts:21` accepts all five edge types in the input schema. The validator has no per-source-node-type restrictions.
- **Suggested fix:** Add a table to §4 explicitly stating, for each edge type emanating from a loop node, whether it is (a) treated as body, (b) treated as after-loop, (c) rejected, or (d) passed through with no special semantics. Recommend: `loop` = body; `after_loop` = after-loop; `sequential` = auto-promote to after_loop with warning; `conditional`, `parallel`, `trigger` = rejected with `InvalidEdgeError: edge type {X} not supported from a loop node — use 'loop' or 'after_loop'`.

### M2 — Ambiguous case: loop node has both explicit `after_loop` AND `sequential` edges  ·  Medium
- **Location:** §5 row V7.
- **Claim:** *"V7 — No auto-promotion when explicit `after_loop` present. Caller emits both `sequential` AND `after_loop` from same loop. `sequential` edge is NOT promoted; both edges retained as-is."*
- **Attack:** Vector 11 (ambiguity). The RFC asserts the `sequential` edge is "retained as-is," but doesn't specify what `sequential` from a loop node *means* in that context. Is the target a body node? An after-loop node that's serial with the explicit after-loop? Something else? Without a defined semantic, the planner's behavior is unpredictable.
- **Evidence:** §3 algorithm makes no provision for `sequential` edges from loop nodes when auto-promotion is suppressed.
- **Suggested fix:** Either (a) define what `sequential` from a loop node means when after-loop is explicit (e.g., "treated as a sibling of after-loop, also gated on body completion"), or (b) reject it: `InvalidEdgeError: sequential edge from loop node ambiguous when explicit after_loop edges present — use 'loop' or 'after_loop'`. Option (b) is consistent with M1's recommendation.

### M3 — Verification matrix has unflagged coverage gaps  ·  Medium
- **Location:** §5 verification matrix V1–V11.
- **Attack:** Vector 14 (coverage gap). Scenarios missing from the matrix:
  - No test for **rejection** of "loop node with zero `loop` edges" (the `InvalidLoopError: loop node has no body` rule in §3.1).
  - No test for **sibling loops** (two loop nodes at same depth, neither nested).
  - No test for **terminal body nodes** (body node with zero outgoing edges — does it correctly anchor synthetic deps?).
  - No test for **self-loop** (loop node with edge to itself — should this be a cycle, or a legal modeling pattern?).
  - V6 asserts `metadata.warnings[]` "contains a deprecation message" but doesn't check the message format/wording, so the message can drift without test failure.
- **Evidence:** §5 matrix as written.
- **Suggested fix:** Add V12 (sibling loops), V13 (loop with no body → rejection), V14 (terminal body node), V15 (self-loop behavior — decide intended semantics first), V16 (synthetic-induced cycle from H3). Tighten V6 to assert a specific regex on the warning string.

### M4 — Body closure semantic convention is implicit  ·  Medium
- **Location:** §3.3 (revised closure algorithm).
- **Claim:** The closure algorithm pseudocode traverses "all outgoing edges of n — after_loop included, because once we're inside body_closure, downstream nodes (including after-loop targets of nested loops) are also in scope."
- **Attack:** Vector 11 (ambiguity). The convention that "anything reachable downstream of a body node is also part of the body, until an outer `after_loop` boundary" is implicit in the algorithm but never stated as a callable-facing rule. A caller modeling `L --loop--> B --sequential--> X`, where X is meant as a one-shot post-loop step, would have X silently absorbed into body_closure and gated as if it ran per iteration.
- **Evidence:** §3.3 walks through one example correctly but doesn't articulate the general principle.
- **Suggested fix:** Add a sentence to §3.3: *"By design, any node reachable from a loop body via non-`after_loop` edges is considered part of the loop body and will run on every iteration. To model a one-shot post-loop step, the caller MUST connect it via an `after_loop` edge from the loop node — not via a `sequential` edge chained off a body node."* This is the contract that disambiguates M2 too.

### M5 — Algorithm over-adds synthetic deps when an indirect chain already gates the relationship  ·  Medium
- **Location:** §3.2 algorithm.
- **Claim:** *"Skip if A already directly depends on B."*
- **Attack:** Vector 13 (logical correctness). The algorithm only skips synthetic injection when there's a *direct* caller-defined edge `B → A`. If `B → X → A` exists (indirect chain), no skip — and a redundant synthetic `B → A` is added. Not incorrect (the resulting graph is still valid), but produces noisy `node.dependencies` arrays and may surprise debugging.
- **Evidence:** §3.2 pseudocode line `if (edges.some(e => e.from === B && e.to === A)) continue;` — checks direct edges only.
- **Suggested fix:** Replace direct-edge check with a transitive-reachability check: `if (isReachable(B, A, edges)) continue;`. Add a helper `isReachable(from, to, edges)` using BFS. Trivial code.

### M6 — `SHOULD` warning rule (§3.1) and auto-promotion (§4) overlap  ·  Medium
- **Location:** §3.1 vs §4.
- **Claim (§3.1):** *"A loop node SHOULD have at least one outgoing `after_loop` edge if it has any non-`loop` outgoing edges. Warn (don't reject) if not."*
- **Claim (§4):** Auto-promote `sequential` edges from loop nodes to `after_loop`.
- **Attack:** Vector 4 (internal contradiction). If auto-promotion runs first (per §8), then by the time §3.1's warning check fires, every `sequential` edge has been promoted to `after_loop`. The `SHOULD` warning condition therefore never triggers — making the §3.1 rule effectively dead code. Conversely, if §3.1 fires first, callers writing the de facto convention (loop + sequential) get a warning, then auto-promotion runs and silently fixes it — two warnings about the same thing.
- **Evidence:** §8 ordering implies validation (§3.1) and auto-promotion (§4) are sequential, but their relative order is unspecified.
- **Suggested fix:** Clarify in §8: auto-promotion runs first (it's a transformation), then validation rules from §3.1 run on the transformed graph. The `SHOULD` warning in §3.1 becomes redundant after promotion — remove it, or rephrase as: *"After auto-promotion, a loop node SHOULD have at least one `after_loop` edge if it had any non-`loop` outgoing edges; if it does not (e.g., because the loop has only `loop` edges plus a `parallel` edge), warn."*

### L1 — Effort/size estimates are inconsistent across sections  ·  Low
- **Location:** §3.4 vs §9.
- **Claim (§3.4):** *"The fix is localized to ~30 lines in buildDAG()."*
- **Claim (§9):** *"~80 LOC in dag-builder.ts."*
- **Attack:** Vector 4 (internal contradiction). §3.4 is talking about the wiring-in inside `buildDAG()`; §9 includes the new helper functions (`computeBodyClosure`, `injectLoopCompletionDeps`, `autoPromoteAfterLoopEdges`). Both numbers are individually defensible, but the document doesn't clarify which is which, leaving the reader unsure of total scope.
- **Suggested fix:** Rephrase §3.4 as *"The wiring change inside buildDAG() is ~30 LOC; the new helper functions add another ~50 LOC — see §9 for the full estimate."*

### L2 — `node.dependencies` population for synthetic deps not shown in algorithm  ·  Low
- **Location:** §3.2 + §3.5.
- **Claim (§3.5):** *"Recommend (b) — keeps the user-facing edges[] faithful to caller input; the planner's reasoning is visible via dependencies."*
- **Attack:** Vector 14 (coverage gap). The existing `dependencies` population at `dag-builder.ts:240–245` iterates over `edges`. If synthetic edges are excluded from `edges[]` (per §3.5 recommendation), then `node.dependencies` will NOT include them either — unless a separate code path is added. The RFC doesn't show this code path.
- **Evidence:** `src/lib/dag-builder.ts:238–245` — only iterates `edges` to populate `node.dependencies`.
- **Suggested fix:** Add a second loop in §3.2 pseudocode: *"For each synthetic edge `B → A`, append `B` to `A.dependencies` (deduped) — even though the edge is not surfaced in `dag.edges[]`."*

### L3 — Variable name collision in §3.3 nested-loops walkthrough  ·  Low
- **Location:** §3.3.
- **Claim:** The walkthrough uses `I` for the inner loop AND `I_after` for the inner after-loop target, with intermediate text saying *"I is reached via inner --after_loop--> I"* — but at that point in the prose, `I` had been the inner loop, not the after-loop target.
- **Attack:** Vector 1 (clarity / readability — not a hallucination, just poor variable hygiene).
- **Evidence:** Re-read §3.3 paragraph starting "Worked example: nested `outer { body: { inner { body: B, after_loop: I } }, after_loop: O }`" — `I` is the after-loop target of `inner`, but then the loop construct itself is also called `inner`, and the next paragraph uses `I` ambiguously.
- **Suggested fix:** Rename: use `Lo` (outer loop), `Li` (inner loop), `B` (body), `Ai` (inner after-loop target), `Ao` (outer after-loop target). Then the closure trace reads `body_closure(Lo) = {Li, B, Ai}` unambiguously.

---

## Cross-cutting observations

1. **Strong: code:line references are accurate.** Every cited line number and function name in the RFC (`src/types.ts:14`, `src/lib/dag-builder.ts:177-214`, `:111-170`, `:218+`, `:230`) checks out against the actual source. No hallucinated code locations.
2. **Strong: scope discipline.** The "out of scope" section (§6) correctly punts items that aren't part of this defect (semantic validation, break/continue, conditional after-loop).
3. **Weak pattern: edge-case coverage.** Four findings (M1, M2, M3, M4) all stem from the same root cause — the RFC focuses on the "happy path" pairing of `loop` + `after_loop` edges and under-specifies behavior when callers mix in other edge types from loop nodes. A single short section "Edge type behavior matrix for edges from loop nodes" would resolve M1, M2, and partially M4.
4. **Weak pattern: synthetic-edge accounting.** Three findings (H3, M5, L2) touch on the implications of injecting synthetic edges — cycles, indirect-dep redundancy, and `dependencies[]` population. The RFC introduces synthetic edges in §3.2 but doesn't reason holistically about their downstream effects.
5. **No fabricated entities, no broken links, no stale-API references.** The RFC is grounded entirely in the local source; nothing to flag under vectors 1, 2, 9, 15.

---

## What was checked but found clean

- All cited file paths exist (`src/types.ts`, `src/lib/dag-builder.ts`, `src/tools/create-workflow.ts`, `test/mcp-client.test.mjs`).
- All cited line ranges match the actual code (verified line-by-line).
- The reproduction case in §1.1 matches what was sent to the MCP in the test session (verified against this conversation's transcript).
- The returned `parallel_groups` cited in §1.1 matches the actual MCP response.
- Schema-additive claim is correct: `RelationshipType` is a TypeScript union and `z.enum` in `create-workflow.ts:21` — both are append-only changes.
- The "no change needed to `topologicalSort()` or `buildParallelGroups()`" claim (§3.4) is correct given synthetic deps go in upstream of those passes — verified by reading both functions.
- Effort estimate (§9) is realistic when both numbers (~30 + ~50) are added: the helpers shown in §3.2 + §3.3 + §4 total ~55 LOC of new code by inspection, plus ~25 LOC of wiring + the second cycle-detection pass to fix H3 ≈ 80 LOC.
- Acceptance criteria (§7) are concretely testable.
