// End-to-end MCP test harness.
// Spawns dist/index.js over stdio, drives it via the official SDK client,
// runs six scenarios, prints PASS/FAIL per check.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import yaml from "js-yaml";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_CMD = "node";
const SERVER_ARGS = [fileURLToPath(new URL("../dist/index.js", import.meta.url))];

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail });
  const tag = cond ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}${detail ? "  — " + detail : ""}`);
}

function parseToolResult(res) {
  if (!res || !res.content || !res.content.length) {
    throw new Error("Tool result missing content");
  }
  // create_workflow now returns [renderedAscii, jsonDag]; export_workflow returns [text].
  // The JSON / serialized payload is always the LAST content block.
  return res.content[res.content.length - 1].text;
}

function renderedBlock(res) {
  if (!res || !res.content || res.content.length < 2) return null;
  return res.content[0].text;
}

async function main() {
  const transport = new StdioClientTransport({
    command: SERVER_CMD,
    args: SERVER_ARGS,
  });
  const client = new Client(
    { name: "mcp-workflow-builder-test", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);

  // ─── 1. List tools ─────────────────────────────────────────────────────
  const listed = await client.listTools();
  const names = listed.tools.map((t) => t.name).sort();
  check(
    "listTools advertises create_workflow + export_workflow",
    JSON.stringify(names) === JSON.stringify(["create_workflow", "export_workflow"]),
    `got ${JSON.stringify(names)}`
  );
  for (const t of listed.tools) {
    check(
      `${t.name} has inputSchema`,
      t.inputSchema && t.inputSchema.type === "object",
      `type=${t.inputSchema?.type}`
    );
  }

  // ─── 2. Linear happy path ─────────────────────────────────────────────
  const linear = await client.callTool({
    name: "create_workflow",
    arguments: {
      name: "fetch-transform-send",
      description: "fetch a user, transform it, then email",
      intents: [
        { id: "i1", label: "Fetch user", type: "fetch", description: "Pull user", action: "fetch", entities: ["user"], parameters: {} },
        { id: "i2", label: "Format email", type: "transform", description: "Build payload", action: "format", entities: ["email"], parameters: {} },
        { id: "i3", label: "Send email", type: "send", description: "Send via SMTP", action: "send", entities: ["email"], parameters: {} },
      ],
      relationships: [
        { from: "i1", to: "i2", type: "sequential", confidence: 1 },
        { from: "i2", to: "i3", type: "sequential", confidence: 1 },
      ],
    },
  });
  const linearDag = JSON.parse(parseToolResult(linear));
  const linearRendered = renderedBlock(linear);
  check(
    "linear: response has two content blocks (rendered + json)",
    linear.content.length === 2,
    `got ${linear.content.length}`
  );
  check(
    "linear: rendered diagram present and labelled",
    !!linearRendered && linearRendered.includes("Workflow:") && linearRendered.includes("FETCH"),
    linearRendered ? linearRendered.split("\n")[0] : "(missing)"
  );
  check(
    "linear: rendered diagram includes node labels",
    !!linearRendered && linearRendered.includes("Fetch user") && linearRendered.includes("Send email"),
  );
  check("linear: nodes=3", linearDag.nodes.length === 3);
  check("linear: edges=2", linearDag.edges.length === 2);
  check("linear: no cycles", linearDag.metadata.has_cycles === false);
  check(
    "linear: execution_order is i1 → i2 → i3",
    JSON.stringify(linearDag.execution_order) ===
      JSON.stringify(["node_i1", "node_i2", "node_i3"])
  );
  const i2deps = linearDag.nodes.find((n) => n.id === "node_i2").dependencies;
  const i3deps = linearDag.nodes.find((n) => n.id === "node_i3").dependencies;
  check("linear: node_i2 depends on [node_i1]", JSON.stringify(i2deps) === JSON.stringify(["node_i1"]));
  check("linear: node_i3 depends on [node_i2]", JSON.stringify(i3deps) === JSON.stringify(["node_i2"]));
  check("linear: no parallel groups", linearDag.metadata.parallel_groups.length === 0);

  // ─── 3. Diamond DAG / parallel detection ──────────────────────────────
  const diamond = await client.callTool({
    name: "create_workflow",
    arguments: {
      name: "diamond",
      description: "A → {B,C} → D",
      intents: ["A", "B", "C", "D"].map((id) => ({
        id,
        label: id,
        type: "custom",
        description: id,
        action: id,
        entities: [],
        parameters: {},
      })),
      relationships: [
        { from: "A", to: "B", type: "sequential" },
        { from: "A", to: "C", type: "sequential" },
        { from: "B", to: "D", type: "sequential" },
        { from: "C", to: "D", type: "sequential" },
      ],
    },
  });
  const diamondDag = JSON.parse(parseToolResult(diamond));
  check("diamond: 4 nodes", diamondDag.nodes.length === 4);
  check("diamond: 4 edges", diamondDag.edges.length === 4);
  check("diamond: no cycles", diamondDag.metadata.has_cycles === false);
  // A must precede B,C; B,C must precede D
  const order = diamondDag.execution_order;
  const idx = (id) => order.indexOf(`node_${id}`);
  check("diamond: A before B", idx("A") < idx("B"));
  check("diamond: A before C", idx("A") < idx("C"));
  check("diamond: B before D", idx("B") < idx("D"));
  check("diamond: C before D", idx("C") < idx("D"));
  const groups = diamondDag.metadata.parallel_groups;
  const hasBCGroup = groups.some(
    (g) => g.includes("node_B") && g.includes("node_C") && g.length === 2
  );
  check(
    "diamond: parallel_groups contains [node_B, node_C]",
    hasBCGroup,
    `got ${JSON.stringify(groups)}`
  );

  // ─── 4. Cycle breaking ────────────────────────────────────────────────
  const cyclic = await client.callTool({
    name: "create_workflow",
    arguments: {
      name: "cycle",
      description: "A→B→C→A — weakest link is C→A",
      intents: ["A", "B", "C"].map((id) => ({
        id,
        label: id,
        type: "custom",
        description: id,
        action: id,
        entities: [],
        parameters: {},
      })),
      relationships: [
        { from: "A", to: "B", type: "sequential", confidence: 0.9 },
        { from: "B", to: "C", type: "sequential", confidence: 0.8 },
        { from: "C", to: "A", type: "loop", confidence: 0.3 },
      ],
    },
  });
  const cycDag = JSON.parse(parseToolResult(cyclic));
  check("cycle: has_cycles flag set", cycDag.metadata.has_cycles === true);
  check("cycle: weakest back-edge removed (2 edges remain)", cycDag.edges.length === 2);
  const cycEdgeIds = cycDag.edges.map((e) => e.id).sort();
  check(
    "cycle: kept A_B and B_C, dropped C_A",
    JSON.stringify(cycEdgeIds) === JSON.stringify(["A_B", "B_C"]),
    `got ${JSON.stringify(cycEdgeIds)}`
  );
  check(
    "cycle: execution_order completes for all 3 nodes",
    cycDag.execution_order.length === 3 &&
      JSON.stringify(cycDag.execution_order) === JSON.stringify(["node_A", "node_B", "node_C"])
  );

  // ─── 5. Export JSON / YAML / file ─────────────────────────────────────
  const exportJson = await client.callTool({
    name: "export_workflow",
    arguments: { workflow: linearDag, format: "json" },
  });
  const jsonStr = parseToolResult(exportJson);
  const roundTripped = JSON.parse(jsonStr);
  check(
    "export json: round-trips equal id+name",
    roundTripped.id === linearDag.id && roundTripped.name === linearDag.name
  );

  const exportYaml = await client.callTool({
    name: "export_workflow",
    arguments: { workflow: linearDag, format: "yaml" },
  });
  const yamlStr = parseToolResult(exportYaml);
  const yamlRT = yaml.load(yamlStr);
  check(
    "export yaml: round-trips equal id+name",
    yamlRT.id === linearDag.id && yamlRT.name === linearDag.name
  );
  check("export yaml: contains 'execution_order:'", yamlStr.includes("execution_order:"));

  // file write
  const tmp = mkdtempSync(join(tmpdir(), "mcpwf-"));
  const outPath = join(tmp, "out.yaml");
  const exportFile = await client.callTool({
    name: "export_workflow",
    arguments: { workflow: linearDag, format: "yaml", output_path: outPath },
  });
  parseToolResult(exportFile);
  check("export file: file exists at output_path", existsSync(outPath));
  if (existsSync(outPath)) {
    const onDisk = readFileSync(outPath, "utf8");
    const onDiskRT = yaml.load(onDisk);
    check("export file: on-disk YAML parses & id matches", onDiskRT.id === linearDag.id);
  }
  rmSync(tmp, { recursive: true, force: true });

  // accept workflow passed as a JSON *string* too
  const exportStrIn = await client.callTool({
    name: "export_workflow",
    arguments: { workflow: jsonStr, format: "json" },
  });
  const reJson = JSON.parse(parseToolResult(exportStrIn));
  check("export: accepts workflow as JSON string", reJson.id === linearDag.id);

  // ─── 6. Schema validation errors ──────────────────────────────────────
  const emptyIntents = await client.callTool({
    name: "create_workflow",
    arguments: { intents: [] },
  });
  check(
    "validation: empty intents → isError",
    emptyIntents.isError === true,
    parseToolResult(emptyIntents).slice(0, 120)
  );

  const badType = await client.callTool({
    name: "create_workflow",
    arguments: {
      intents: [
        {
          id: "x",
          label: "x",
          type: "not-a-real-type",
          description: "x",
          action: "x",
          entities: [],
          parameters: {},
        },
      ],
    },
  });
  check(
    "validation: bad intent type → isError",
    badType.isError === true,
    parseToolResult(badType).slice(0, 120)
  );

  const unknownTool = await client.callTool({
    name: "no_such_tool",
    arguments: {},
  });
  check(
    "validation: unknown tool name → isError",
    unknownTool.isError === true,
    parseToolResult(unknownTool).slice(0, 120)
  );

  // ─── 7. Loop-completion semantics (RFC v4) ────────────────────────────

  // V1 — baseline: 1 body, 1 after-loop
  const v1 = await client.callTool({
    name: "create_workflow",
    arguments: {
      name: "v1-baseline",
      description: "1 body + 1 after-loop",
      intents: [
        { id: "L", label: "L", type: "loop", description: "loop", action: "loop", entities: [], parameters: {} },
        { id: "B", label: "B", type: "custom", description: "body", action: "b", entities: [], parameters: {} },
        { id: "A", label: "A", type: "custom", description: "after", action: "a", entities: [], parameters: {} },
      ],
      relationships: [
        { from: "L", to: "B", type: "loop", confidence: 1 },
        { from: "L", to: "A", type: "after_loop", confidence: 1 },
      ],
    },
  });
  const v1Dag = JSON.parse(parseToolResult(v1));
  check(
    "V1: parallel_groups does NOT contain [B, A]",
    !v1Dag.metadata.parallel_groups.some(
      (g) => g.includes("node_B") && g.includes("node_A")
    ),
    `got ${JSON.stringify(v1Dag.metadata.parallel_groups)}`
  );
  const v1ADeps = v1Dag.nodes.find((n) => n.id === "node_A").dependencies;
  check(
    "V1: A.dependencies includes node_B (synthetic completion dep)",
    v1ADeps.includes("node_B"),
    `got ${JSON.stringify(v1ADeps)}`
  );

  // V21 — isSynthetic edges never leak to response
  check(
    "V21: response edges contain no isSynthetic edges",
    v1Dag.edges.every((e) => !e.isSynthetic)
  );
  check(
    "V21: response edges count matches caller-provided count (2)",
    v1Dag.edges.length === 2
  );

  // V9 — smoking-gun regression: replay fixture verbatim
  const FIXTURE = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("./fixtures/regression-loop-completion.json", import.meta.url)),
      "utf8"
    )
  );
  const v9 = await client.callTool({
    name: "create_workflow",
    arguments: FIXTURE,
  });
  const v9Dag = JSON.parse(parseToolResult(v9));
  check(
    "V9: parallel_groups does NOT contain [load_file, run_clash_detection]",
    !v9Dag.metadata.parallel_groups.some(
      (g) =>
        g.includes("node_load_file") &&
        g.includes("node_run_clash_detection")
    ),
    `got ${JSON.stringify(v9Dag.metadata.parallel_groups)}`
  );
  check(
    "V9: warnings non-empty (auto-promotion fired)",
    Array.isArray(v9Dag.metadata.warnings) && v9Dag.metadata.warnings.length > 0,
    `got ${JSON.stringify(v9Dag.metadata.warnings)}`
  );

  // V6 — auto-promotion warning string format
  check(
    "V6: deprecation warning matches regex",
    v9Dag.metadata.warnings.some((w) =>
      /^\[deprecation\] Edge .+ auto-promoted: 'sequential' → 'after_loop'/.test(w)
    ),
    `got ${JSON.stringify(v9Dag.metadata.warnings)}`
  );

  // V18 — self-loop on loop node is rejected
  const v18 = await client.callTool({
    name: "create_workflow",
    arguments: {
      intents: [
        { id: "L", label: "L", type: "loop", description: "", action: "loop", entities: [], parameters: {} },
      ],
      relationships: [
        { from: "L", to: "L", type: "loop", confidence: 1 },
      ],
    },
  });
  check(
    "V18: self-loop rejected with InvalidLoopError",
    v18.isError === true &&
      parseToolResult(v18).includes("self-referential"),
    parseToolResult(v18).slice(0, 200)
  );

  // V14 — loop with no body is rejected
  const v14 = await client.callTool({
    name: "create_workflow",
    arguments: {
      intents: [
        { id: "L", label: "L", type: "loop", description: "", action: "loop", entities: [], parameters: {} },
        { id: "A", label: "A", type: "custom", description: "", action: "a", entities: [], parameters: {} },
      ],
      relationships: [
        { from: "L", to: "A", type: "after_loop", confidence: 1 },
      ],
    },
  });
  check(
    "V14: loop with no body rejected",
    v14.isError === true &&
      parseToolResult(v14).includes("loop node has no body"),
    parseToolResult(v14).slice(0, 200)
  );

  // V13 — after_loop from a non-loop node is rejected
  const v13 = await client.callTool({
    name: "create_workflow",
    arguments: {
      intents: [
        { id: "T", label: "T", type: "transform", description: "", action: "t", entities: [], parameters: {} },
        { id: "X", label: "X", type: "custom", description: "", action: "x", entities: [], parameters: {} },
      ],
      relationships: [
        { from: "T", to: "X", type: "after_loop", confidence: 1 },
      ],
    },
  });
  check(
    "V13: after_loop from non-loop node rejected",
    v13.isError === true &&
      parseToolResult(v13).includes("after_loop edge from non-loop node"),
    parseToolResult(v13).slice(0, 200)
  );

  // V15 — forbidden edge types from loop node are rejected
  const v15 = await client.callTool({
    name: "create_workflow",
    arguments: {
      intents: [
        { id: "L", label: "L", type: "loop", description: "", action: "loop", entities: [], parameters: {} },
        { id: "B", label: "B", type: "custom", description: "", action: "b", entities: [], parameters: {} },
        { id: "X", label: "X", type: "custom", description: "", action: "x", entities: [], parameters: {} },
      ],
      relationships: [
        { from: "L", to: "B", type: "loop", confidence: 1 },
        { from: "L", to: "X", type: "parallel", confidence: 1 },
      ],
    },
  });
  check(
    "V15: 'parallel' edge from loop node rejected",
    v15.isError === true &&
      parseToolResult(v15).includes("not supported from a loop node"),
    parseToolResult(v15).slice(0, 200)
  );

  // V20 — after-loop target also reachable from body via chain → rejected
  const v20 = await client.callTool({
    name: "create_workflow",
    arguments: {
      intents: [
        { id: "L", label: "L", type: "loop", description: "", action: "loop", entities: [], parameters: {} },
        { id: "B", label: "B", type: "custom", description: "", action: "b", entities: [], parameters: {} },
        { id: "X", label: "X", type: "custom", description: "", action: "x", entities: [], parameters: {} },
        { id: "A", label: "A", type: "custom", description: "", action: "a", entities: [], parameters: {} },
      ],
      relationships: [
        { from: "L", to: "B", type: "loop", confidence: 1 },
        { from: "B", to: "X", type: "sequential", confidence: 1 },
        { from: "X", to: "A", type: "sequential", confidence: 1 },
        { from: "L", to: "A", type: "after_loop", confidence: 1 },
      ],
    },
  });
  check(
    "V20: after-loop exclusivity violation rejected",
    v20.isError === true &&
      parseToolResult(v20).includes("also reachable from the body"),
    parseToolResult(v20).slice(0, 200)
  );

  // V12 — synthetic-induced cycle: caller writes A→B (after-loop target → body)
  const v12 = await client.callTool({
    name: "create_workflow",
    arguments: {
      intents: [
        { id: "L", label: "L", type: "loop", description: "", action: "loop", entities: [], parameters: {} },
        { id: "B", label: "B", type: "custom", description: "", action: "b", entities: [], parameters: {} },
        { id: "A", label: "A", type: "custom", description: "", action: "a", entities: [], parameters: {} },
      ],
      relationships: [
        { from: "L", to: "B", type: "loop", confidence: 1 },
        { from: "L", to: "A", type: "after_loop", confidence: 1 },
        { from: "A", to: "B", type: "sequential", confidence: 1 },
      ],
    },
  });
  check(
    "V12: synthetic-induced cycle rejected",
    v12.isError === true &&
      parseToolResult(v12).includes(
        "after-loop target has a caller-defined path"
      ),
    parseToolResult(v12).slice(0, 200)
  );

  // V22 case 1 — caller intents [L, B]: cycle break removes non-body edge → succeeds
  const v22a = await client.callTool({
    name: "create_workflow",
    arguments: {
      intents: [
        { id: "L", label: "L", type: "loop", description: "", action: "loop", entities: [], parameters: {} },
        { id: "B", label: "B", type: "custom", description: "", action: "b", entities: [], parameters: {} },
      ],
      relationships: [
        { from: "L", to: "B", type: "loop", confidence: 1 },
        { from: "B", to: "L", type: "sequential", confidence: 1 },
      ],
    },
  });
  check(
    "V22 case 1: cycle breaks non-body edge → pipeline succeeds",
    v22a.isError !== true,
    parseToolResult(v22a).slice(0, 200)
  );

  // V22 case 2 — caller intents [B, L]: cycle break removes body edge → rejected
  const v22b = await client.callTool({
    name: "create_workflow",
    arguments: {
      intents: [
        { id: "B", label: "B", type: "custom", description: "", action: "b", entities: [], parameters: {} },
        { id: "L", label: "L", type: "loop", description: "", action: "loop", entities: [], parameters: {} },
      ],
      relationships: [
        { from: "L", to: "B", type: "loop", confidence: 1 },
        { from: "B", to: "L", type: "sequential", confidence: 1 },
      ],
    },
  });
  check(
    "V22 case 2: cycle breaks only body edge → rejected",
    v22b.isError === true &&
      parseToolResult(v22b).includes("cycle breaking removed the only body edge"),
    parseToolResult(v22b).slice(0, 200)
  );

  // ─── Done ─────────────────────────────────────────────────────────────
  await client.close();

  const failed = results.filter((r) => !r.ok);
  console.log("\n──────────────────────────────────────────");
  console.log(`Summary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log("Failures:");
    for (const f of failed) console.log(` - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Harness error:", err);
  process.exit(2);
});
