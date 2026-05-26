import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { createWorkflowSchema, handleCreateWorkflow, } from "./tools/create-workflow.js";
import { exportWorkflowSchema, handleExportWorkflow, } from "./tools/export-workflow.js";
import { authenticateApsSchema, handleAuthenticateAps, } from "./tools/authenticate-aps.js";
import { authenticateAps3LOSchema, handleAuthenticateAps3LO, } from "./tools/authenticate-aps-3lo.js";
import { getCapabilitySchema, handleGetCapability, } from "./tools/get-capability.js";
import { executeWorkflowSchema, handleExecuteWorkflow, } from "./tools/execute-workflow.js";
import { uploadFileSchema, handleUploadFile, } from "./tools/upload-file.js";
import { getResultSchema, handleGetResult, } from "./tools/get-result.js";
import { processFileSchema, handleProcessFile, } from "./tools/process-file.js";
import { getWorkflowStatusSchema, handleGetWorkflowStatus, } from "./tools/get-workflow-status.js";
import { getDownloadLinkSchema, handleGetDownloadLink, } from "./tools/get-download-link.js";
import { saveToMacSchema, handleSaveToMac, } from "./tools/save-to-mac.js";
import { renderModelSchema, handleRenderModel, } from "./tools/render-model.js";
// ─── Server setup ─────────────────────────────────────────────────────────
const server = new Server({
    name: "mcp-workflow-builder",
    version: "1.0.0",
}, {
    capabilities: {
        tools: {},
    },
    // NOTE: Keep the full instructions string from your original index.ts here.
    // Only the tools registration block below needs updating.
    instructions: "=== WorkflowSkills MCP ===\n\n" +
        "MANDATORY TRIGGER — call get_capability as your VERY FIRST action (before any response, any reasoning, any bash, any Python) when ANY of these file extensions appear anywhere in the conversation — attached, typed as a path, or mentioned by name:\n\n" +
        "RVT RFA RTE RFT DWG DXF DWT DWS DWF DWFX IPT IAM IDW IPN IDE F3D F3Z CAM360 MAX MA MB " +
        "NWD NWF NWC IFC FBX STEP STP IGES IGS SAT JT WIRE IWMODEL IMX " +
        "NAS BDF FEM OP2 RCP RCS PTS E57 LAS LAZ ADSK ADSKLIB ATF ASM SMT SMB OBJ STL\n\n" +
        "These are Autodesk proprietary formats. DO NOT attempt to read, parse, or process them using Python, bash, olefile, rvt-meta, or any local library — they require APS cloud services and will fail or produce wrong results locally.\n\n" +
        "── TOOL SELECTION ───────────────────────────────────────────────────────\n\n" +
        "Use this decision tree every time before picking a tool:\n\n" +
        "1. Single intent + local file?\n" +
        "   → process_file  (fast path: upload + run + return results in one call. No planning needed.)\n\n" +
        "2. Multiple intents + local file?\n" +
        "   → create_workflow(file_path=..., intents=[...])  — uploads the file ONCE, builds the DAG, returns oss_url.\n" +
        "   → Then execute_workflow(input_file_url=oss_url, ...) for each step in the DAG.\n" +
        "   NEVER call process_file multiple times for the same file — it re-uploads each time.\n\n" +
        "3. File already in APS OSS (you have an oss:// URL)?\n" +
        "   → execute_workflow directly — no upload needed.\n\n" +
        "4. No file, just an APS REST operation or info question?\n" +
        "   → execute_workflow for REST calls. Answer from knowledge for pure info.\n\n" +
        "── STANDARD FLOW ────────────────────────────────────────────────────────\n\n" +
        "Step 1 — get_capability(query='<ext> <intent>') — present results; confirm with user.\n" +
        "Step 2 — authenticate_aps() — ALWAYS before any upload or execution.\n" +
        "         • error → stop. Show error. Ask user to check APS credentials.\n" +
        "Step 3 — Execute using the tool selected above (process_file or create_workflow + execute_workflow).\n\n" +
        "── CALLABLE: FALSE — MANDATORY FALLBACK PROTOCOL ───────────────────────\n\n" +
        "If get_capability returns a result where callable=false or callable is not true, you MUST:\n" +
        "  1. Call get_capability AGAIN with a rephrased or broader query (e.g. swap synonyms, drop the file extension, try the intent alone).\n" +
        "  2. Call get_capability a THIRD time with limit=10 to surface less-obvious matches.\n" +
        "  3. If the intent is metadata/property/geometry extraction AND the file is one of the supported types below,\n" +
        "     use the MODEL DERIVATIVE FALLBACK (see section below) — do NOT tell the user it is unsupported.\n" +
        "  4. Only after steps 1–3 all fail, tell the user the operation is not yet supported and show what was searched.\n" +
        "NEVER fall back to bash, Python, local libraries, or any non-MCP approach after seeing callable=false.\n\n" +
        "── MODEL DERIVATIVE FALLBACK (metadata & property extraction) ───────────\n\n" +
        "When DA extraction capabilities are callable=false, use Model Derivative (APS REST) as a fallback.\n\n" +
        "SUPPORTED FORMATS — full object tree + properties:\n" +
        "  Autodesk native : DWG, DXF (AutoCAD) · RVT, RFA (Revit) · F3D, F3Z (Fusion 360)\n" +
        "                    IPT, IAM, IDW (Inventor) · MAX (3ds Max) · DWF, DWFX · NWD, NWC (Navisworks)\n" +
        "  Open/neutral    : IFC · STEP, STP · IGES, IGS · JT · SAT (ACIS) · OBJ · STL · 3DM (Rhino) · SKP (SketchUp)\n" +
        "  Third-party CAD : SLDPRT, SLDASM (SolidWorks) · CATPART, CATPRODUCT (CATIA)\n" +
        "                    PRT, ASM (NX/Unigraphics) · PRT, ASM (Creo/Pro-E) · WIRE (Alias)\n" +
        "  Point clouds    : RCP, RCS (ReCap) — scan metadata only, no BIM properties\n" +
        "  Geometry-only   : STL, OBJ — mesh + material names, no element properties\n\n" +
        "STANDARD MD EXTRACTION FLOW — execute these steps in order:\n" +
        "  Step 1 · Upload file (if not already in OSS) → get oss_url\n" +
        "  Step 2 · execute_workflow(capability_id='aps:md.jobs', operation_id='start_translation_job', input_file_url=oss_url)\n" +
        "           → returns urn. If asyncJob=true, poll fetch_manifest until status='success'.\n" +
        "  Step 3 · execute_workflow(capability_id='aps:md.manifest', operation_id='fetch_manifest', path_params={urn})\n" +
        "           → confirms translation complete. DO NOT use GUIDs from this manifest for metadata calls.\n" +
        "  Step 4 · execute_workflow(capability_id='aps:md.metadata', operation_id='list_model_views', path_params={urn})\n" +
        "           → returns correct modelGuids. ALWAYS use these GUIDs — manifest geometry GUIDs are different and will 404.\n" +
        "  Step 5a · execute_workflow(capability_id='aps:md.metadata', operation_id='fetch_object_tree', path_params={urn, modelGuid})\n" +
        "            → entity/layer/component hierarchy.\n" +
        "  Step 5b · execute_workflow(capability_id='aps:md.metadata', operation_id='query_specific_properties',\n" +
        "            path_params={urn, modelGuid}, body={query:{$prefix:['CategoryName']}})\n" +
        "            → filtered properties by category. PREFER this over fetch_all_properties to avoid 1MB limit.\n" +
        "  Step 5c · execute_workflow(capability_id='aps:md.thumbnail', operation_id='fetch_thumbnail', path_params={urn})\n" +
        "            → PNG preview. Use get_download_link on the result.\n\n" +
        "WHAT MD COVERS vs GAPS PER PRODUCT:\n" +
        "  DWG/DXF        COVERS: entity hierarchy, element properties, layer structure, 2D/3D views\n" +
        "                 GAPS:   xref list, block attributes, drawing history, symbol tables, title block data\n" +
        "  RVT/RFA        COVERS: full BIM element tree, all Revit parameters, room/space/level data\n" +
        "                 GAPS:   native warnings, family metadata, workshared structure (use RevitExtractor for those)\n" +
        "  F3D/F3Z        COVERS: component hierarchy, body/face properties, assembly structure\n" +
        "                 GAPS:   CAM setups, toolpaths, generative design outcomes, simulation results\n" +
        "  IPT/IAM/IDW    COVERS: part/assembly hierarchy, component properties, mass/material data\n" +
        "                 GAPS:   iProperties, BOM tables, frame/tube reports, FEA results\n" +
        "  MAX            COVERS: scene object hierarchy, material assignments, mesh properties\n" +
        "                 GAPS:   modifier stacks, animation data, render settings\n" +
        "  NWD/NWC        COVERS: aggregated model tree, object properties, clash data structure\n" +
        "                 GAPS:   timeliner sequences, quantification data\n" +
        "  IFC            COVERS: full BIM element tree, IFC property sets, spatial structure\n" +
        "                 GAPS:   IFC-specific relationship types beyond spatial containment\n" +
        "  SLDPRT/SLDASM  COVERS: part/assembly tree, feature names, material data\n" +
        "                 GAPS:   design tables, configurations, equations\n" +
        "  CATPART/CATPRD COVERS: part/product tree, component properties\n" +
        "                 GAPS:   knowledge patterns, DMU navigator data\n" +
        "  NX/Creo PRT    COVERS: part/assembly hierarchy, body/face properties\n" +
        "                 GAPS:   parametric expressions, manufacturing attributes\n" +
        "  STEP/IGES/JT   COVERS: geometry entity hierarchy, basic attributes\n" +
        "                 GAPS:   application-specific metadata beyond geometry\n" +
        "  SKP/3DM        COVERS: layer/component hierarchy, material names\n" +
        "                 GAPS:   plugin-specific metadata, render materials\n" +
        "  STL/OBJ        COVERS: mesh geometry only\n" +
        "                 GAPS:   no element properties extractable\n\n" +
        "── STATUS HANDLING (process_file and execute_workflow) ──────────────────\n\n" +
        "• success         → present outputs. Done.\n" +
        "• pending         → WorkItem still running. Call get_workflow_status(workflow_handle). Repeat until success or failed.\n" +
        "• bridge_required → show REQUIRED_ACTION verbatim. Ask for the file's actual Mac path (~/Downloads/, OneDrive, or local folder). Retry with that path.\n",
});
// ─── Tool list ─────────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "authenticate_aps",
                description: "Verify APS credentials and cache the token. Reads APS_CLIENT_ID and APS_CLIENT_SECRET " +
                    "from the MCP process env — never from tool params. Call once to confirm the connection " +
                    "is healthy.",
                inputSchema: zodToJsonSchema(authenticateApsSchema),
            },
            {
                name: "authenticate_aps_3lo",
                description: "Perform 3-legged OAuth (3LO) to obtain a user-identity token required for ACC account-level " +
                    "operations such as creating projects, managing users, and other admin APIs that reject 2LO " +
                    "client-credential tokens. Opens the Autodesk authorization page in your browser, waits for " +
                    "you to approve, then stores the token automatically. The refresh token is saved to the OS " +
                    "keychain so future MCP restarts auto-renew without re-authorizing. Call this once before " +
                    "any ACC Admin operation (e.g. acc.admin_create_project).",
                inputSchema: zodToJsonSchema(authenticateAps3LOSchema),
            },
            {
                name: "get_capability",
                description: "REQUIRED first call whenever any of these file extensions appear in the conversation: " +
                    "RVT RFA RTE RFT DWG DXF DWT DWS DWF DWFX IPT IAM IDW IPN IDE F3D F3Z CAM360 MAX MA MB " +
                    "NWD NWF NWC IFC FBX STEP STP IGES IGS SAT JT WIRE IWMODEL IMX NAS BDF FEM OP2 " +
                    "RCP RCS PTS E57 LAS LAZ ADSK ADSKLIB ATF ASM SMT SMB OBJ STL. " +
                    "Also call when any Autodesk cloud service is referenced (ACC, BIM 360, Autodesk Docs, " +
                    "Fusion Hub, Vault, APS OSS, ShotGrid, Tandem, Forma, ReCap Cloud). " +
                    "Searches 260+ capabilities across Design Automation (Engine-API) and APS REST (Platform-API). " +
                    "Returns capability_id and operation_id for process_file. " +
                    "CALLABLE CHECK: always inspect the callable field on each returned operation. " +
                    "callable=true → proceed. callable=false → DO NOT use that operation.",
                inputSchema: zodToJsonSchema(getCapabilitySchema),
            },
            {
                name: "execute_workflow",
                description: "Run a SINGLE APS capability operation: Engine-API (DA WorkItem → polls → outputOssUrl) " +
                    "or Platform-API (REST call → response). For REST operations requiring a user token " +
                    "(e.g. ACC Admin), call authenticate_aps_3lo first — the token is then used automatically.",
                inputSchema: zodToJsonSchema(executeWorkflowSchema),
            },
            {
                name: "create_workflow",
                description: "Use when the user's request has MULTIPLE intents for an Autodesk file or pipeline.",
                inputSchema: zodToJsonSchema(createWorkflowSchema),
            },
            {
                name: "process_file",
                description: "Fast path for a SINGLE intent + local file: auto-selects capability, uploads, runs, returns results.",
                inputSchema: zodToJsonSchema(processFileSchema),
            },
            {
                name: "upload_file",
                description: "Upload a file to APS OSS.",
                inputSchema: zodToJsonSchema(uploadFileSchema),
            },
            {
                name: "get_result",
                description: "Fetch output file content from APS OSS after execute_workflow or process_file completes.",
                inputSchema: zodToJsonSchema(getResultSchema),
            },
            {
                name: "get_workflow_status",
                description: "Poll the status of a running Autodesk workflow (DA WorkItem or future async job types).",
                inputSchema: zodToJsonSchema(getWorkflowStatusSchema),
            },
            {
                name: "get_download_link",
                description: "Generate a clickable HTTPS download link for any file in APS OSS.",
                inputSchema: zodToJsonSchema(getDownloadLinkSchema),
            },
            {
                name: "export_workflow",
                description: "Serialize a workflow DAG to JSON or YAML, optionally saving to a file.",
                inputSchema: zodToJsonSchema(exportWorkflowSchema),
            },
            {
                name: "save_to_mac",
                description: "Save text content (JSON, CSV, Markdown, plain text) directly to the Mac filesystem.",
                inputSchema: zodToJsonSchema(saveToMacSchema),
            },
            {
                name: "render_model",
                description: "Render an APS model visually — either as an interactive 3D viewer or as a thumbnail image.",
                inputSchema: zodToJsonSchema(renderModelSchema),
            },
        ],
    };
});
// ─── Tool dispatch ─────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        let result;
        switch (name) {
            case "authenticate_aps":
                result = await handleAuthenticateAps(authenticateApsSchema.parse(args));
                break;
            case "authenticate_aps_3lo":
                result = await handleAuthenticateAps3LO(authenticateAps3LOSchema.parse(args ?? {}));
                break;
            case "get_capability":
                result = await handleGetCapability(getCapabilitySchema.parse(args));
                break;
            case "execute_workflow":
                result = await handleExecuteWorkflow(executeWorkflowSchema.parse(args));
                break;
            case "create_workflow":
                result = await handleCreateWorkflow(createWorkflowSchema.parse(args));
                break;
            case "process_file":
                result = await handleProcessFile(processFileSchema.parse(args));
                break;
            case "upload_file":
                result = await handleUploadFile(uploadFileSchema.parse(args));
                break;
            case "get_result":
                result = await handleGetResult(getResultSchema.parse(args));
                break;
            case "get_workflow_status":
                result = await handleGetWorkflowStatus(getWorkflowStatusSchema.parse(args));
                break;
            case "get_download_link":
                result = await handleGetDownloadLink(getDownloadLinkSchema.parse(args));
                break;
            case "export_workflow":
                result = await handleExportWorkflow(exportWorkflowSchema.parse(args));
                break;
            case "save_to_mac":
                result = await handleSaveToMac(saveToMacSchema.parse(args));
                break;
            case "render_model":
                result = await handleRenderModel(renderModelSchema.parse(args));
                break;
            default:
                return {
                    content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
                    isError: true,
                };
        }
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    }
    catch (err) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ error: String(err) }),
                },
            ],
            isError: true,
        };
    }
});
// ─── Start ────────────────────────────────────────────────────────────────
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((err) => {
    process.stderr.write(`Fatal: ${err}\n`);
    process.exit(1);
});
