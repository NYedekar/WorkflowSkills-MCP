# Adversarial Review — RFC v3: Loop Completion Semantics

**Artifact:** `/Users/yedekan/Library/CloudStorage/OneDrive-Autodesk/PM Workspace/MCP/mcp-workflow-builder/RFC-loop-completion-semantics.md` (Draft v3)
**Reviewed:** 2026-05-22
**Source of truth:** Real source at `src/types.ts`, `src/lib/dag-builder.ts`, `src/tools/create-workflow.ts`, `src/index.ts`, `test/mcp-client.test.mjs`. Plus the v1 + v2 adversarial reviews for traceability.
**Template:** N/A.
**Scope:** Full. Depth: Standard. Two-pronged (v2-closure audit + fresh attack on v3).

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0     |
| High     | **0** |
| Medium   | **2** |
| Low      | 3     |

**Verdict: shippable with minor polish.** Six of the eight v2 findings are cleanly closed; two (v2-M1, v2-L4) are closed *in effect* but with subtle design defects in the closure mechanism — neither breaks correctness, but both involve spec/code disconnects worth fixing. The two new Medium findings (v3-M1, v3-M2) are tractable: the M1 fix is a deletion (the loop-aware sort is dead code), and the M2 fix is a one-line scope cut in §4. No new High or Critical findings.

---

## Part 1 — v2 Findings Closure Audit

| v2 ID | v2 issue | v3 resolution | Closed? |
|-------|---|---|---|
| H1 | V18 self-loop test mis-specified | §3.3 adds self-loop rejection rule (`from === to` on a loop-node edge throws `InvalidLoopError: loop node has a self-referential edge`). V18 now asserts this rejection. | ✅ Clean |
| M1 | `breakCycles` can leave loop bodyless | §3.6 has *two* changes: (1) loop-aware secondary sort, (2) new `validatePostCycleBreak` pass. **Change (2) closes the issue correctly. Change (1) is dead code** — see new finding **v3-M1**. | ⚠️ Closed in effect; mechanism has a defect |
| M2 | §3.4 convention not enforced | §3.4 adds `validateAfterLoopExclusivity` helper, wired in at §3.10 step 5. Rejects when after-loop target is reachable from body via non-`after_loop` chain. V20 tests it. | ✅ Clean |
| M3 | `__synth_` ID prefix fragile | §2.1 adds `isSynthetic?: boolean` to `WorkflowEdge`. §3.5 sets this on every synthetic edge. §3.10 uses field, not ID prefix. | ✅ Clean |
| L1 | Awkward return shape of `injectLoopCompletionDeps` | §3.5 signature changed to return synthetic-only. §3.10 step 6 simplified. | ✅ Clean |
| L2 | Error classes referenced but not defined | §2.3 (new) provides full class definitions for `InvalidEdgeError`, `InvalidLoopError`, plus bonus `PlannerInvariantError` for §3.8. | ✅ Clean |
| L3 | `topologicalSort` safety net could mask bugs | §3.8 replaces silent append with `throw new PlannerInvariantError(...)`. Verified safe — Kahn's algorithm guarantees all nodes process unless cycles remain, and v3 has cycles eliminated by the time topo runs. | ✅ Clean |
| L4 | Unsubstantiated "no real-world callers" claim | §4 replaced with a concrete release-gate (log-search script + warning-first fallback). **Fallback path is described but not implementable in the current scope** — see new finding **v3-M2**. | ⚠️ Closed in narrative; fallback isn't wired up |

Net: **6 clean, 2 closed-in-effect with new findings**.

---

## Part 2 — New v3 Findings

### M1 — Loop-aware `breakCycles` secondary sort is dead code  ·  Medium
- **Location:** §3.6 "Change 1 — Loop-aware breakCycles".
- **Claim:** *"When sorting cycle edges for removal, prefer breaking non-`loop` edges first. Loop body edges are structural; removing one silently turns a valid loop into a bodyless one."*
- **Attack:** Vector 13 (logical impossibility — the documented mechanism doesn't actually do what it says). The proposed code:
  ```ts
  const cycleEdges = edges
    .filter(e => cycleSet.has(e.id))
    .sort((a, b) => { ... loop-aware sort ... });
  const toRemove = new Set<string>(cycleEdges.map(e => e.id));
  ```
  Every cycle edge gets added to `toRemove` via the `.map`. The sort order has zero effect on which edges are removed — they all are.
- **Evidence:** Verified against existing `src/lib/dag-builder.ts:84-102`. The existing `breakCycles` already removes all back-edges (the inline comment at line 98 says *"Re-check — for simplicity remove all back-edges (they're the minimal cut)"*). The v3 sort change preserves this behavior — the sort doesn't gate the removal.
- The actual bodyless-loop protection in v3 comes entirely from §3.6 Change 2 (`validatePostCycleBreak`), which is correct. Change 1 contributes nothing.
- **Suggested fix:** Two options:
  - **(a) Delete Change 1.** Remove the sort change from §3.6. Document that `breakCycles` removes all back-edges as before, and rely on `validatePostCycleBreak` to catch loop-body removal. The RFC narrative needs trimming: drop the "two changes" framing and just present `validatePostCycleBreak` as the single fix.
  - **(b) Rework `breakCycles` to actually be loop-aware.** Remove one back-edge per cycle (preferring non-loop), then re-run `detectCycles`, repeat until no cycles. This is significantly more complex and changes the existing algorithm.
- **Recommendation:** (a). The `validatePostCycleBreak` safety net is already sufficient; (b) adds complexity for marginal benefit. After deletion, V22's "first case (preferred)" wording also needs to change — see v3-L2 below.

### M2 — Release-gate "warning-first" fallback is not implementable in the v3 scope  ·  Medium
- **Location:** §4 backwards compatibility, last paragraph.
- **Claim:** *"If invocation logs are not retained (e.g., for an internal tool with no centralized logging), default to the warning-first rollout regardless."*
- **Attack:** Vector 13 (logical impossibility) + vector 14 (coverage gap). The v3 algorithm rejects unconditionally — every new validation (self-loop, after-loop exclusivity, forbidden edge types from loop nodes, ambiguous sequential, post-cycle-break bodyless) throws an error. There is no config flag, no env var, no feature gate that switches between "throw" and "warn." If a release engineer follows the §4 instruction to "default to the warning-first rollout," they have no mechanism to do so — the only way to achieve warning-first is to modify the rejection helpers to push to `metadata.warnings[]` instead of throwing, which is not in the §8 implementation checklist.
- **Evidence:** §3.3, §3.4, §3.6 all use `throw new InvalidEdgeError(...)` / `throw new InvalidLoopError(...)` with no conditional branch. §8 implementation checklist has no row for a strictness flag.
- **Suggested fix:** Two options:
  - **(a) Cut the warning-first fallback.** Remove the last paragraph of §4. Commit to one of: ship rejection unconditionally, OR run the log-search script as a release prerequisite. This is the simplest fix and aligns with what the v3 code actually does.
  - **(b) Add a strictness mode.** Introduce `WORKFLOW_BUILDER_STRICT` env var (default `true`). When `false`, the rejection helpers in §3.3/§3.4/§3.6 push to `warnings[]` instead of throwing. Add a §3.11 documenting the flag; add a row to §8 implementation checklist; add a test V23 verifying warning-first mode produces a valid DAG with warnings populated.
- **Recommendation:** (a) is cleaner for a v3 ship. (b) is the right answer if the team genuinely needs a soft-rollout safety valve — but it's a meaningful scope expansion (~30 LOC + 1 test) and should be a separate RFC.

### L1 — V11 description says "lowest-confidence edge" but `breakCycles` removes all back-edges  ·  Low
- **Location:** §5.2 row V11.
- **Claim:** *"V11 — First cycle detection breaks lowest-confidence edge; pipeline proceeds (assuming the broken edge isn't the loop's only body edge — that case is V22)"*
- **Attack:** Vector 1 (source-vs-text mismatch within the artifact). The actual existing `breakCycles` at `src/lib/dag-builder.ts:84-102` removes *all* back-edges (the minimal-cut comment at line 98 confirms this). The v3 proposed `breakCycles` in §3.6 Change 1 preserves the same behavior. So "breaks lowest-confidence edge" (singular) is inaccurate — it breaks back-edges (plural, all of them).
- **Evidence:** `src/lib/dag-builder.ts:84-102`; v3 §3.6 Change 1 code block (`toRemove = new Set<string>(cycleEdges.map(e => e.id))` adds every cycle edge).
- **Suggested fix:** Change V11 description from *"breaks lowest-confidence edge"* to *"identifies and removes back-edge(s)"*. The "lowest-confidence" framing comes from the existing test at `test/mcp-client.test.mjs:155-168` which uses a 3-node cycle with a single back-edge — that test happens to remove one edge, but the principle is "all back-edges" not "lowest one."

### L2 — V22 case-distinction wording implies planner choice when it's input-order  ·  Low
- **Location:** §5.2 row V22.
- **Claim:** *"First case (preferred): `breakCycles` removes `B→L` (non-loop preferred); pipeline succeeds. Second case (force-fail): construct a graph where the ONLY removable edge is `L→loop→B`."*
- **Attack:** Vector 11 (ambiguity). The "preferred" / "force-fail" framing implies the planner makes a choice between two edges. It doesn't — under v3's `breakCycles` (per v3-M1 above, sort is dead code), all back-edges are removed. Whether `B→L` or `L→loop→B` is identified as a back-edge depends entirely on DFS traversal order, which is driven by the caller's intent ID ordering in `nodes`. The "preferred" outcome is therefore caller-input-dependent, not planner-decision-dependent.
- For a cycle `L --loop--> B --sequential--> L`:
  - If caller orders intents `[L, B]`, DFS starts at L, descends L→B, then sees B→L (with L still GRAY) — `B→L` is the back-edge. Removing it preserves the loop body. (Pipeline succeeds.)
  - If caller orders intents `[B, L]`, DFS starts at B, descends B→L, then sees L→B (with B still GRAY) — `L→B` is the back-edge. Removing it kills the loop body. (`validatePostCycleBreak` rejects.)
- **Evidence:** `src/lib/dag-builder.ts:42-79` (`detectCycles`) — `for (const id of nodeIds)` iterates in node-list order, which is caller-provided.
- **Suggested fix:** Rewrite V22 description to make input-order explicit:
  > "V22 — Cycle whose only resolution removes a loop's only body edge. Setup: `L→loop→B`, `B→sequential→L` (cycle), both confidence 1.0. **Case 1** (caller intents ordered `[L, B]`): DFS identifies `B→L` as the back-edge; `breakCycles` removes it; loop body preserved; pipeline succeeds. **Case 2** (caller intents ordered `[B, L]`): DFS identifies `L→B` as the back-edge; `breakCycles` removes the only body edge; `validatePostCycleBreak` throws `InvalidLoopError`."

### L3 — V21 "introspect planner internals" wording is misleading  ·  Low
- **Location:** §5.2 row V21.
- **Claim:** *"V21 — Run V1 scenario; introspect planner internals."*
- **Attack:** Vector 11 (ambiguity). Tests in `test/mcp-client.test.mjs` interact with the MCP only via the public `client.callTool({...})` interface — they see the response JSON, not internal planner state. The assertion *"the response `edges[]` does NOT contain any edge with `isSynthetic: true`"* is correctly response-level and testable; the "introspect internals" framing oversells what the test does.
- **Evidence:** `test/mcp-client.test.mjs:30-49` shows the standard test setup — client calls `callTool`, parses the result string. No internal access pattern exists.
- **Suggested fix:** Rewrite V21 description: *"V21 — `isSynthetic` edge tagging (v2-M3 / v2-L1 fix). Setup: run V1's scenario. Assertion: `afterA.dependencies` contains `bodyA` (proves the synthetic edge was honored in dependency computation); the response `edges[]` does NOT contain any edge with `isSynthetic: true` (proves synthetic edges are planner-internal only)."*

---

## Cross-cutting observations

1. **v2 closure quality is mixed.** Six of eight v2 findings are cleanly closed. Two (v2-M1, v2-L4) are closed *in effect* but the documented mechanism has a defect (M1's sort is dead code) or the documented fallback isn't implementable (L4's warning-first mode). This pattern — "narrative fix outpaces implementation" — is the one cluster worth attention.
2. **Dead-code design risk.** v3-M1 is a case where the RFC adds a code change with no behavioral effect. This typically happens when revising a doc reactively to a redteam finding without re-checking the surrounding context. A self-check at draft time would have caught it: "if I delete this change, does anything observable break?" — for v3-M1, the answer is "no," which means the change has no purpose.
3. **Code:line references remain accurate.** Every `src/...:N` reference in v3 still checks out against the actual source. The new §3.8 line range (162-167) and the new `breakCycles` line range (84-102) both verified.
4. **No regression from v2.** None of v2's closed findings have been *re-opened* in v3. The fixes are additive, not substitutive.
5. **Scope discipline preserved.** §6 (out of scope) is unchanged from v2. No scope creep introduced.

---

## What was checked but found clean

- §3.4 `validateAfterLoopExclusivity` produces no false positives on nested loops (verified by tracing the §3.4 worked example: `body_closure(Lo) = {Li, B, Ai}`, after-targets = `[Ao]`; `Ao ∉` closure ⇒ pass).
- §3.4 produces no false positives on diamond patterns (verified: `L→B`, `B→C`, `B→D`, `L→after_loop→A` → body_closure = `{B, C, D}`, A not in closure, pass).
- §3.8 tightened safety net cannot reject legitimate inputs — Kahn's algorithm at `src/lib/dag-builder.ts:111-170` processes every node unless cycles remain in the input graph, and v3's pipeline eliminates all cycles before topo runs.
- §3.5 `injectLoopCompletionDeps` returns synthetic-only as claimed; v3-L1 (v2 → v3 change) is correctly implemented.
- §2.1 `isSynthetic` field cannot leak into response: caller edges are constructed by `buildEdges` at `src/lib/dag-builder.ts:26-35`, which never sets `isSynthetic`; synthetic edges live only in `augmentedEdges`, never in `dag.edges[]`.
- §2.3 error classes correctly extend `Error`, so the existing wrapper at `src/index.ts:107-118` catches them and surfaces `isError: true` with `err.message`.
- §3.10 step ordering is internally consistent: each helper's input matches the prior step's output; the §3.10 normative statement *"no other section's ordering hints take precedence"* is respected throughout the doc.
- V20 (after-loop exclusivity rejection), V12 (synthetic-cycle rejection), V18 (self-loop rejection), V22 case 2 (post-cycle-break rejection) — all four new regression tests are well-constructed and would catch their respective bugs.
- Effort estimate in §9 (~220 LOC production + ~480 LOC tests = 2.5 dev-days) is realistic by inspection.
- `src/index.ts:107-118` confirms thrown errors reach the user as `isError: true` — no wrapper change needed.
- v1 + v2 finding history is correctly traced; no v2-closed finding has silently regressed in v3.
