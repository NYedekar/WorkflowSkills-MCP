import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { createWorkflowSchema, handleCreateWorkflow, } from "./tools/create-workflow.js";
import { exportWorkflowSchema, handleExportWorkflow, } from "./tools/export-workflow.js";
import { authenticateApsSchema, handleAuthenticateAps, } from "./tools/authenticate-aps.js";
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
        "• bridge_required → show REQUIRED_ACTION verbatim. Ask for the file's actual Mac path (~/Downloads/, OneDrive, or local folder). Retry with that path.\n" +
        "• no_capability_found → show gap_note. Answer from knowledge.\n" +
        "• error           → show error + hint.\n\n" +
        "── RULES ────────────────────────────────────────────────────────────────\n\n" +
        "NETWORK: bash cannot reach Autodesk, S3, or localhost (blocked by Claude Desktop proxy). The MCP server (Mac process) handles all network calls. ALWAYS use get_result to read output files — never curl/wget.\n" +
        "PIPELINES: always render the ASCII diagram from create_workflow verbatim in a fenced code block.\n" +
        "PURE INFO (no file, no operation): answer directly — do not call any tool.\n\n" +
        "── AUTO RENDER MODEL ────────────────────────────────────────────────────\n\n" +
        "After ANY successful SVF2 translation — whether from:\n" +
        "  • execute_workflow(operation_id='start_translation_job') confirming status=success\n" +
        "  • render_model returning status=pending then being polled to success\n" +
        "  • the MD FALLBACK flow completing a translation\n" +
        "ALWAYS automatically call render_model(oss_url=<original_input_oss_url>, mode='viewer') immediately after. " +
        "Do NOT wait for the user to ask. This opens the model in the browser so the user can view it interactively. " +
        "If render_model returns status='pending', poll it again in ~30s until success.\n\n" +
        "── FILE DOWNLOAD ────────────────────────────────────────────────────────\n\n" +
        "After any successful operation that produces an output file, call get_download_link(oss_url=...) " +
        "and render the returned markdown_link directly in your response so the user can click to download. " +
        "Always pass a clean filename via the filename param (e.g. 'drawing.pdf', not the full OSS key). " +
        "Links expire in ~1 hour — note this to the user.\n" +
        "When execute_workflow returns response_oss_url (large REST response stored in OSS), " +
        "immediately call get_download_link(oss_url=response_oss_url, filename='<op>-response.json') " +
        "and render the link — do NOT attempt to read, parse, or summarise the stored JSON.\n\n" +
        "── SAVING DATA TO MAC ───────────────────────────────────────────────────\n\n" +
        "RULE #1 FOR FILE WRITES: bash CANNOT write to the Mac filesystem. " +
        "Any cp, mv, tee, echo >, or open() in bash targeting /Users/... or ~/... will fail with FileNotFoundError or permission denied. " +
        "This is a hard sandbox boundary — bash runs in an isolated container with no access to Mac disk.\n\n" +
        "RULE #2 — WORKFLOW OUTPUTS (oss:// URLs) MUST NEVER BE READ THEN RE-SAVED:\n" +
        "  If the user wants a workflow output file saved locally, call get_result(oss_url=..., save_to='<folder>') in ONE call.\n" +
        "  DO NOT call get_result to read the content, then pass it to save_to_mac. That double-handles data, can exceed 1MB, and is slow.\n" +
        "  DO NOT parse, reassemble, or summarise the JSON before saving it. The file is already complete in OSS.\n" +
        "  Correct pattern: get_result(oss_url='oss://...', save_to='~/Downloads/Test output/', save_filename='result.json')\n\n" +
        "RULE #3 — save_to_mac is ONLY for content Claude generated itself:\n" +
        "  • A summary or report Claude wrote → save_to_mac\n" +
        "  • Aggregated text built from multiple tool call responses → save_to_mac\n" +
        "  • Any file you would otherwise write with bash → save_to_mac\n" +
        "  • Workflow/OSS outputs → NEVER save_to_mac. Use get_result(save_to=...) instead.\n" +
        "  • Binary/OSS outputs (PDF, DWG, RVT, JSON from workflow) → get_result(save_to=...) or get_download_link\n" +
        "Do NOT use bash for any file write. Do NOT use present_files as a workaround.\n\n" +
        "── RENDER MODEL ─────────────────────────────────────────────────────────\n\n" +
        "render_model — view a 3D model as an interactive viewer (experimental) or thumbnail image.\n" +
        "Requires model to be in APS OSS first (upload_file or process_file).\n\n" +
        "mode='viewer' (default): saves viewer HTML to ~/Downloads/aps-viewer-{urn}.html and opens it\n" +
        "  in the system browser via 'open'. Full interactive WebGL — no sandbox restrictions.\n" +
        "  Returns: { status, file_path, message } — tell the user the browser opened with the file path.\n" +
        "mode='thumbnail' (RELIABLE): fetches 400×400 PNG, returns as MCP image block inline in chat.\n\n" +
        "Optional params: region ('US'|'EMEA'), force_retranslate (bool, default false).\n\n" +
        "STATUS FLOW:\n" +
        "• pending → translation in progress. Call again in 30–60 s. If >30 min, job timed out — re-upload.\n" +
        "• success (viewer) → browser opened; surface file_path and token expiry to user.\n" +
        "• success (thumbnail) → image renders inline.\n" +
        "• error → show message. Re-upload file if translation failed/timed out.",
});
// ─── Tool list ────────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "create_workflow",
                description: "Use when the user's request has MULTIPLE intents for an Autodesk file or pipeline. " +
                    "Decomposes the request into a DAG of steps (sequential, parallel, conditional, loop), plans execution order, and renders an ASCII pipeline diagram. " +
                    "Accepts an optional file_path — when provided, uploads the file to APS OSS ONCE and returns oss_url alongside the DAG. " +
                    "Pass that oss_url to every subsequent execute_workflow call so all steps share the same upload. " +
                    "Does NOT execute any steps — use execute_workflow to run each node in the DAG after reviewing the plan. " +
                    "Returns: (1) ASCII diagram — render it verbatim in a fenced code block; (2) JSON DAG; (3) oss_url if a file was provided. " +
                    "STATUS FLOW for the file upload: bridge_required → show REQUIRED_ACTION verbatim and ask for the file's actual Mac path; error → show error + hint.",
                inputSchema: zodToJsonSchema(createWorkflowSchema),
            },
            {
                name: "export_workflow",
                description: "Serialize a workflow DAG to JSON or YAML, optionally saving to a file.",
                inputSchema: zodToJsonSchema(exportWorkflowSchema),
            },
            {
                name: "authenticate_aps",
                description: "Verify APS credentials and cache the token. Reads APS_CLIENT_ID and APS_CLIENT_SECRET from the MCP process env — never from tool params. Call once to confirm the connection is healthy. " +
                    "Note: each distinct set of OAuth scopes produces a separately cached token; if you request a scope set that differs from a previous call, a new token is fetched and cached independently.",
                inputSchema: zodToJsonSchema(authenticateApsSchema),
            },
            {
                name: "get_capability",
                description: "REQUIRED first call whenever any of these file extensions appear in the conversation: " +
                    "RVT RFA RTE RFT DWG DXF DWT DWS DWF DWFX IPT IAM IDW IPN IDE F3D F3Z CAM360 MAX MA MB " +
                    "NWD NWF NWC IFC FBX STEP STP IGES IGS SAT JT WIRE IWMODEL IMX " +
                    "NAS BDF FEM OP2 RCP RCS PTS E57 LAS LAZ ADSK ADSKLIB ATF ASM SMT SMB OBJ STL. " +
                    "Also call when any Autodesk cloud service is referenced (ACC, BIM 360, Autodesk Docs, Fusion Hub, Vault, APS OSS, ShotGrid, Tandem, Forma, ReCap Cloud). " +
                    "Searches 260+ capabilities across Design Automation (Engine-API) and APS REST (Platform-API). " +
                    "Returns capability_id and operation_id for process_file. " +
                    "CALLABLE CHECK: always inspect the callable field on each returned operation. " +
                    "callable=true → proceed. callable=false → DO NOT use that operation. " +
                    "Call get_capability again with a rephrased query, then again with limit=10. " +
                    "Only report a gap after three distinct searches all return no callable=true result. " +
                    "No results or all callable=false = Coverage Gap — do not attempt local fallback, bash, or Python. " +
                    "Filter by query, capability_id, operation_id, or risk. Use query for natural language search.",
                inputSchema: zodToJsonSchema(getCapabilitySchema),
            },
            {
                name: "upload_file",
                description: "Upload a file to APS OSS. Pass the file's actual Mac path — local folder, ~/Downloads/, or OneDrive (~/Library/CloudStorage/OneDrive-Autodesk/…). " +
                    "Returns status='success' with oss_url when the MCP server can read the file. " +
                    "Returns status='bridge_required' when the file is a chat attachment — show REQUIRED_ACTION to user and ask for the file's actual Mac path. " +
                    "Returns an oss:// URL for execute_workflow.",
                inputSchema: zodToJsonSchema(uploadFileSchema),
            },
            {
                name: "execute_workflow",
                description: "Run a SINGLE APS capability operation: Engine-API (DA WorkItem → polls → outputOssUrl) or Platform-API (REST call → response). " +
                    "Use this to run each step of a multi-intent pipeline after create_workflow has planned the DAG. " +
                    "Also use directly when the file is already in APS OSS (you have an oss:// URL) and you know the capability + operation. " +
                    "Call get_capability first for capability_id+operation_id. " +
                    "For local files with a single step, prefer process_file instead — it handles upload automatically. " +
                    "For local files with multiple steps, use create_workflow(file_path=...) to upload once and get oss_url, then call execute_workflow per step. " +
                    "After execution, call get_result with outputOssUrl to read the primary output. " +
                    "Multi-output operations return outputOssUrls[] — call get_result on each entry.",
                inputSchema: zodToJsonSchema(executeWorkflowSchema),
            },
            {
                name: "get_result",
                description: "Fetch output file content from APS OSS after execute_workflow or process_file completes. " +
                    "NETWORK ARCHITECTURE: the MCP server (Mac process with unrestricted network) calls the APS API and S3 directly — " +
                    "Claude's bash is NOT used and CANNOT be used (Autodesk and S3 domains are not in bash's network allowlist). " +
                    "ALWAYS call this tool to read output files — never attempt curl or wget from bash. " +
                    "Content-type detection uses byte-level content sniffing so JSON/CSV outputs stored as application/octet-stream are returned as text, not flagged as binary. " +
                    "The detected_as field tells you the actual format: json | csv | xml | text | binary. " +
                    "LARGE FILES: max_chars is capped at 50 000 per call. When has_more=true, call again with offset_chars=next_offset to fetch the next chunk. " +
                    "Repeat until has_more=false. total_chars tells you the full file size upfront. " +
                    "SAVING FILES: pass save_to with a local folder path to download and save the full file to disk. " +
                    "If the user says 'download', 'save', or 'export the file' without specifying a folder, default to ~/Downloads. " +
                    "The saved_to field in the response contains the resolved path. " +
                    "For binary outputs (PDF, DWG, RVT, ZIP, images), save_to is the recommended way to retrieve them — binary content cannot be displayed as text. " +
                    "APS DA often stores PDF outputs with a .json object key — use save_filename to give the saved file the correct name and extension (e.g. save_filename='drawing.pdf').",
                inputSchema: zodToJsonSchema(getResultSchema),
            },
            {
                name: "process_file",
                description: "Fast path for a SINGLE intent + local file: auto-selects capability, uploads, runs, and returns all output in one call. " +
                    "Use ONLY when the user has exactly one thing to do with a local file. " +
                    "For multiple intents on the same file, use create_workflow(file_path=...) instead — it uploads once and shares the oss_url across all steps. " +
                    "Do NOT call process_file in a loop for the same file — it re-uploads on every call. " +
                    "STATUS FLOW: " +
                    "• success → present outputs. Done. " +
                    "• pending → WorkItem still running. Call get_workflow_status(workflow_handle). Repeat until success or failed. " +
                    "• bridge_required → file is a chat attachment; MCP server cannot read it. Show REQUIRED_ACTION verbatim. Ask user for the file's actual Mac path (~/Downloads/, OneDrive, or local folder). Retry with that path. " +
                    "• no_capability_found → show gap_note. Answer from knowledge. " +
                    "• error → show error + hint.",
                inputSchema: zodToJsonSchema(processFileSchema),
            },
            {
                name: "get_workflow_status",
                description: "Poll the status of a running Autodesk workflow (DA WorkItem or future async job types). " +
                    "Call this after execute_workflow or process_file returns status='pending'. " +
                    "Pass the workflow_handle exactly as received — do not modify it. " +
                    "Polls for up to 50s per call (safe under MCP transport timeout). " +
                    "STATUS FLOW: " +
                    "• pending → still running. Call again with the same workflow_handle. " +
                    "• success → job done. Call get_result on each outputOssUrls entry. " +
                    "• failed / cancelled → show error + reportUrl to user. " +
                    "Generic — handles DA WorkItems today, extensible to Model Derivative, ACC jobs, and other async APS operations.",
                inputSchema: zodToJsonSchema(getWorkflowStatusSchema),
            },
            {
                name: "save_to_mac",
                description: "Save text content (JSON, CSV, Markdown, plain text) directly to the Mac filesystem via the MCP server. " +
                    "CRITICAL: Claude's bash is sandboxed and CANNOT write to Mac disk (/Users/...). " +
                    "Use this tool whenever you need to save synthesized, aggregated, or assembled data to the Mac — " +
                    "e.g. metadata JSON built from multiple API calls, property summaries, extracted reports. " +
                    "Also use when execute_workflow auto-saves a large response and you want to save a processed/filtered version. " +
                    "Returns saved_to with the resolved file path on success.",
                inputSchema: zodToJsonSchema(saveToMacSchema),
            },
            {
                name: "get_download_link",
                description: "Generate a clickable HTTPS download link for any file in APS OSS. " +
                    "Call this after process_file, execute_workflow, or get_result completes to give the user a one-click download button. " +
                    "Returns markdown_link — render it directly in your response (e.g. '[⬇ Download drawing.pdf](https://...)') so the user can click it. " +
                    "Pass filename to give the link a clean display name instead of the raw OSS object key. " +
                    "The signed URL is valid for ~1 hour. " +
                    "WHEN TO CALL: automatically after every successful operation that produces a file output — do not wait for the user to ask.",
                inputSchema: zodToJsonSchema(getDownloadLinkSchema),
            },
            {
                name: "render_model",
                description: "Render an APS model visually — either as an interactive 3D viewer or as a thumbnail image. " +
                    "Requires the model to already be in APS OSS — upload it with upload_file or process_file first. " +
                    "Automatically checks for an existing SVF2 translation and starts one if needed. " +
                    "mode='viewer' (default): generates self-contained HTML with APS Viewer SDK, saves it to " +
                    "  ~/Downloads/aps-viewer-{urn}.html, and opens it in the user's default browser via 'open'. " +
                    "  The browser has no sandbox restrictions — full interactive WebGL viewer. " +
                    "mode='thumbnail' (RELIABLE): returns a 400×400 PNG inline in chat — works regardless of sandbox. " +
                    "region param: use 'EMEA' for EU data-residency; defaults to 'US'. " +
                    "force_retranslate param: set true only to redo a corrupt/failed previous translation. " +
                    "STATUS FLOW: " +
                    "• pending → translation started or still running; call render_model again in 30–60 s. " +
                    "  If pending >30 minutes, the job timed out — re-upload and retry. " +
                    "• success (viewer) → browser opened; tell user file_path and token expiry from message field. " +
                    "• success (thumbnail) → image renders inline in chat. " +
                    "• error → show error message; re-upload the file if translation failed or timed out.",
                inputSchema: zodToJsonSchema(renderModelSchema),
            },
        ],
    };
});
// ─── Tool call handler ────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        switch (name) {
            case "create_workflow": {
                const parsed = createWorkflowSchema.parse(args);
                const result = await handleCreateWorkflow(parsed);
                if (result.status === "bridge_required") {
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                        isError: true,
                    };
                }
                if (result.status === "error") {
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                        isError: true,
                    };
                }
                const parts = [
                    { type: "text", text: result.rendered },
                    { type: "text", text: JSON.stringify(result.dag, null, 2) },
                ];
                if (result.oss_url) {
                    parts.push({
                        type: "text",
                        text: `File uploaded. oss_url: ${result.oss_url} — pass this to each execute_workflow call as input_file_url.`,
                    });
                }
                return { content: parts };
            }
            case "export_workflow": {
                const parsed = exportWorkflowSchema.parse(args);
                const result = await handleExportWorkflow(parsed);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                    isError: result.status === "error",
                };
            }
            case "authenticate_aps": {
                const parsed = authenticateApsSchema.parse(args);
                const result = await handleAuthenticateAps(parsed);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                    isError: result.status === "error",
                };
            }
            case "upload_file": {
                const parsed = uploadFileSchema.parse(args);
                const result = await handleUploadFile(parsed);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                    isError: result.status === "error",
                };
            }
            case "get_capability": {
                const parsed = getCapabilitySchema.parse(args);
                const result = await handleGetCapability(parsed);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                };
            }
            case "execute_workflow": {
                const parsed = executeWorkflowSchema.parse(args);
                const result = await handleExecuteWorkflow(parsed);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                    isError: result.status === "error" || result.status === "failed" || result.status === "activity_not_found",
                };
            }
            case "get_result": {
                const parsed = getResultSchema.parse(args);
                const result = await handleGetResult(parsed);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                    isError: result.status === "error",
                };
            }
            case "process_file": {
                const parsed = processFileSchema.parse(args);
                const result = await handleProcessFile(parsed);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                    isError: result.status === "error" || result.status === "failed",
                };
            }
            case "get_workflow_status": {
                const parsed = getWorkflowStatusSchema.parse(args);
                const result = await handleGetWorkflowStatus(parsed);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                    isError: result.status === "failed" || result.status === "cancelled",
                };
            }
            case "get_download_link": {
                const parsed = getDownloadLinkSchema.parse(args);
                const result = await handleGetDownloadLink(parsed);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                    isError: result.status === "error",
                };
            }
            case "save_to_mac": {
                const parsed = saveToMacSchema.parse(args);
                const result = await handleSaveToMac(parsed);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                    isError: result.status === "error",
                };
            }
            case "render_model": {
                const parsed = renderModelSchema.parse(args);
                const result = await handleRenderModel(parsed);
                if (result.status === "error") {
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                        isError: true,
                    };
                }
                if (result.status === "pending") {
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                    };
                }
                // success — thumbnail returns MCP image block; viewer returns text confirmation
                if ("thumbnail_base64" in result) {
                    return {
                        content: [
                            {
                                type: "image",
                                data: result.thumbnail_base64,
                                mimeType: result.content_type,
                            },
                        ],
                    };
                }
                // viewer: HTML saved to disk and opened in browser — return confirmation message
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                };
            }
            default:
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ error: `Unknown tool: ${name}` }),
                        },
                    ],
                    isError: true,
                };
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ error: message }),
                },
            ],
            isError: true,
        };
    }
});
// ─── Start server ─────────────────────────────────────────────────────────
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("mcp-workflow-builder server running on stdio");
}
main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
